//go:build linux || darwin

package main

// Contract tests for the Antigravity engine: the real agy installed on this machine, driven through
// runAntigravitySessionProcess exactly as a session runs it, against testdata/mockgemini standing in
// for the Gemini API (no key, no network — the mock's HTTPS proxy refuses every outbound host) and a
// fake control plane serving the session's inbox and Orbit's own MCP calls.
//
// docs/antigravity-runtime-contract.md is what these hold agy to. Run them before taking a new agy
// release (`go test -run TestAntigravityContract -v .`): agy is closed source, ships almost daily, and
// rests on a hidden flag (--gemini_dir). Skipped when agy is not installed.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// agyContractWait bounds every wait on agy. A cold first start of the 200MB binary took ~12s.
const agyContractWait = 2 * time.Minute

type agyContractEvent struct {
	turnID  string
	kind    string
	payload map[string]interface{}
}

type agyContractRun struct {
	status string
	ended  bool
	reload bool
}

// agyContract is one scenario's world: the mock Gemini, the fake control plane, a HOME that must
// stay empty, and the session's directories.
type agyContract struct {
	t         *testing.T
	dir       string
	mockURL   string
	mockLog   string
	home      string
	orbitHome string
	execDir   string
	scratch   string
	server    *httptest.Server
	inbox     chan RunInboxResponse

	mu          sync.Mutex
	events      []agyContractEvent
	taskGets    []string
	completions chan TurnCompleteRequest
	// The approval cards the session filed, and the answers the test gave them (approvalsFor).
	approvals []agyContractApproval
	decisions map[string]ApprovalDecisionResponse
	asked     chan agyContractApproval
}

// agyContractApproval is one card a session filed: its id and the body it was filed with.
type agyContractApproval struct {
	id   string
	body map[string]interface{}
}

func newAgyContract(t *testing.T) *agyContract {
	t.Helper()
	if _, err := exec.LookPath(agyExecutable); err != nil {
		t.Skip("agy is not installed on this machine — install it with `curl -fsSL https://antigravity.google/cli/install.sh | bash` (docs/antigravity-runtime-contract.md §6.4)")
	}
	c := &agyContract{
		t:           t,
		dir:         t.TempDir(),
		inbox:       make(chan RunInboxResponse, 16),
		completions: make(chan TurnCompleteRequest, 16),
		decisions:   map[string]ApprovalDecisionResponse{},
		asked:       make(chan agyContractApproval, 16),
	}
	c.home = filepath.Join(c.dir, "home")
	c.orbitHome = filepath.Join(c.dir, "orbit-home")
	c.execDir = filepath.Join(c.dir, "work")
	c.scratch = filepath.Join(c.dir, "scratch")
	for _, d := range []string{c.home, c.orbitHome, c.execDir, c.scratch} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	c.startMockGemini()
	c.startControlPlane()
	// The user's own HOME stays out of reach: anything agy wrote outside its Gemini directory would
	// land here, and the test fails on it (contract §3.3).
	t.Setenv("HOME", c.home)
	// The runner's own home: `orbit mcp` reads the control plane's address from it, and the shared
	// agy bin/ directory lives under it.
	t.Setenv("ORBIT_HOME", c.orbitHome)
	config, _ := json.Marshal(RunnerConfig{ServerURL: c.server.URL, RunnerID: "runner-contract", RunnerToken: "runner-token"})
	if err := os.WriteFile(filepath.Join(c.orbitHome, "config.json"), config, 0o600); err != nil {
		t.Fatal(err)
	}
	return c
}

func (c *agyContract) startMockGemini() {
	t := c.t
	bin := filepath.Join(c.dir, "mockgemini")
	build := exec.Command("go", "build", "-o", bin, "./testdata/mockgemini")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build mockgemini: %v\n%s", err, out)
	}
	c.mockLog = filepath.Join(c.dir, "mock.jsonl")
	urlFile := filepath.Join(c.dir, "mock.url")
	mock := exec.Command(bin, "-log", c.mockLog, "-url-file", urlFile, "-chunk-delay", "5ms")
	if err := mock.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = mock.Process.Kill()
		_ = mock.Wait()
	})
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if b, err := os.ReadFile(urlFile); err == nil && strings.TrimSpace(string(b)) != "" {
			c.mockURL = strings.TrimSpace(string(b))
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("mockgemini never reported its address")
}

// startControlPlane serves what a session asks the control plane while it runs: its inbox
// (long-polled; a turn handed out through c.inbox), through `orbit mcp` task_get, and through Orbit's
// approval hook the approval cards — filed, then long-polled until the test answers (c.decide).
func (c *agyContract) startControlPlane() {
	c.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/approvals"):
			var body map[string]interface{}
			_ = json.NewDecoder(r.Body).Decode(&body)
			c.mu.Lock()
			card := agyContractApproval{id: fmt.Sprintf("approval-%d", len(c.approvals)+1), body: body}
			c.approvals = append(c.approvals, card)
			c.mu.Unlock()
			c.asked <- card
			_ = json.NewEncoder(w).Encode(map[string]string{"id": card.id, "status": "PENDING"})
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/approvals/"):
			id := filepath.Base(r.URL.Path)
			window := time.After(2 * time.Second)
			for {
				c.mu.Lock()
				decision, decided := c.decisions[id]
				c.mu.Unlock()
				if decided {
					_ = json.NewEncoder(w).Encode(decision)
					return
				}
				select {
				case <-window:
					_ = json.NewEncoder(w).Encode(map[string]string{"id": id, "status": "PENDING"})
					return
				case <-r.Context().Done():
					return
				case <-time.After(20 * time.Millisecond):
				}
			}
		case strings.HasSuffix(r.URL.Path, "/inbox"):
			select {
			case resp := <-c.inbox:
				_ = json.NewEncoder(w).Encode(resp)
			case <-time.After(15 * time.Second):
				_, _ = w.Write([]byte(`{}`))
			case <-r.Context().Done():
			}
		case strings.HasPrefix(r.URL.Path, "/api/runner/tasks/"):
			id := strings.TrimPrefix(r.URL.Path, "/api/runner/tasks/")
			c.mu.Lock()
			c.taskGets = append(c.taskGets, id)
			c.mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"id": id, "title": "MCP-REACHED " + id, "status": "OPEN"})
		case strings.HasSuffix(r.URL.Path, "/diff"):
			_, _ = w.Write([]byte(`{}`))
		default:
			http.NotFound(w, r)
		}
	}))
	c.t.Cleanup(c.server.Close)
}

// job is a session on this world: the mock's address and a fake key in its environment, the way a
// provider will inject them.
func (c *agyContract) job(sessionID, mode string) *ClaimedSession {
	return &ClaimedSession{
		SessionID: sessionID,
		Provider:  providerAntigravity,
		Agent: AgentExecConfig{
			Provider:       providerAntigravity,
			PermissionMode: mode,
			Env: map[string]string{
				"GEMINI_API_KEY":         "mock-key-0123456789",
				"GOOGLE_GEMINI_BASE_URL": c.mockURL,
				// Every outbound host agy tries — feature flags, telemetry — is refused and logged by
				// the mock. The model endpoint is loopback, which proxies never see.
				"HTTPS_PROXY": c.mockURL, "HTTP_PROXY": c.mockURL, "https_proxy": c.mockURL, "http_proxy": c.mockURL,
				// Every session's mcp_config.json names Orbit's own server, which under test is this
				// binary: started without this it would run the whole suite again, recursively.
				testOrbitMCPEnv: "1",
			},
		},
	}
}

// agyContractSession is one engine generation running in the background.
type agyContractSession struct {
	done   chan struct{}
	result agyContractRun
	stop   func()
}

// wait returns how the generation ended, however many times it is asked.
func (s *agyContractSession) wait(t *testing.T) agyContractRun {
	t.Helper()
	select {
	case <-s.done:
		return s.result
	case <-time.After(agyContractWait):
		t.Fatal("the session loop did not return")
	}
	return agyContractRun{}
}

// start runs one engine generation of the session in the background.
func (c *agyContract) start(job *ClaimedSession) *agyContractSession {
	ctx, cancel := context.WithCancel(context.Background())
	shutdownCtx, stopShutdown := context.WithCancel(context.Background())
	var turnMu sync.Mutex
	turn := ""
	record := func(turnID, kind string, payload map[string]interface{}) {
		c.mu.Lock()
		c.events = append(c.events, agyContractEvent{turnID: turnID, kind: kind, payload: payload})
		c.mu.Unlock()
	}
	emit := func(kind string, payload map[string]interface{}) {
		turnMu.Lock()
		id := turn
		turnMu.Unlock()
		record(id, kind, payload)
	}
	s := &agyContractSession{done: make(chan struct{})}
	go func() {
		defer close(s.done)
		status, ended, reload := runAntigravitySessionProcess(ctx, shutdownCtx, NewTransport(c.server.URL, "runner-token"), job, "",
			c.execDir, c.scratch, emit, record,
			func(id string) { turnMu.Lock(); turn = id; turnMu.Unlock() },
			false, nil,
			func(req TurnCompleteRequest, _ ...context.Context) error { c.completions <- req; return nil },
			func(context.Context) bool { return true },
			func(err error) { c.t.Errorf("lease lost: %v", err) },
		)
		s.result = agyContractRun{status: status, ended: ended, reload: reload}
	}()
	s.stop = func() {
		cancel()
		stopShutdown()
		select {
		case <-s.done:
		case <-time.After(agyContractWait):
			c.t.Error("the session loop did not return after cancel")
		}
	}
	c.t.Cleanup(s.stop)
	return s
}

func (c *agyContract) send(resp RunInboxResponse) { c.inbox <- resp }

func (c *agyContract) completion(turnID string) TurnCompleteRequest {
	c.t.Helper()
	timer := time.NewTimer(agyContractWait)
	defer timer.Stop()
	for {
		select {
		case req := <-c.completions:
			if req.TurnID == turnID {
				return req
			}
			c.t.Fatalf("turn %s completed while waiting for %s: %+v", req.TurnID, turnID, req)
		case <-timer.C:
			c.t.Fatalf("turn %s never completed; events so far:\n%s", turnID, c.describeEvents())
		}
	}
}

func (c *agyContract) lastModelRequest() string {
	c.t.Helper()
	requests := c.modelRequests()
	if len(requests) == 0 {
		c.t.Fatal("the mock received no model request")
	}
	return requests[len(requests)-1]
}

func (c *agyContract) eventsOf(turnID, kind string) []map[string]interface{} {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []map[string]interface{}
	for _, e := range c.events {
		if (turnID == "*" || e.turnID == turnID) && e.kind == kind {
			out = append(out, e.payload)
		}
	}
	return out
}

func (c *agyContract) describeEvents() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	var b strings.Builder
	for _, e := range c.events {
		raw, _ := json.Marshal(e.payload)
		fmt.Fprintf(&b, "  [%s] %s %s\n", e.turnID, e.kind, clip(string(raw), 300))
	}
	return b.String()
}

// modelRequests is every scripted-turn request agy sent the mock (side calls, like titles, declare
// no tools), as raw bodies.
func (c *agyContract) modelRequests() []string {
	c.t.Helper()
	f, err := os.Open(c.mockLog)
	if err != nil {
		c.t.Fatal(err)
	}
	defer f.Close()
	var out []string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1024*1024), 64*1024*1024)
	for sc.Scan() {
		var entry struct {
			Path      string          `json:"path"`
			KeySource string          `json:"keySource"`
			Body      json.RawMessage `json:"body"`
		}
		if json.Unmarshal(sc.Bytes(), &entry) != nil || !strings.Contains(entry.Path, ":streamGenerateContent") {
			continue
		}
		if !strings.Contains(string(entry.Body), `"functionDeclarations"`) {
			continue
		}
		if entry.KeySource == "" {
			c.t.Errorf("a model request reached the mock without an API key: %s", entry.Path)
		}
		out = append(out, string(entry.Body))
	}
	return out
}

// homeIsUntouched fails the test for anything written under HOME.
func (c *agyContract) homeIsUntouched() {
	c.t.Helper()
	var written []string
	_ = filepath.WalkDir(c.home, func(path string, d fs.DirEntry, err error) error {
		if err == nil && path != c.home {
			written = append(written, path)
		}
		return nil
	})
	if len(written) > 0 {
		c.t.Fatalf("agy wrote under HOME — --gemini_dir no longer keeps it out of ~/.gemini (contract §3.3): %v", written)
	}
}

func (c *agyContract) geminiDir() string {
	dir, err := antigravityGeminiDir(c.scratch)
	if err != nil {
		c.t.Fatal(err)
	}
	return dir
}

// agyProcesses lists the agy processes running a session on this session's Gemini directory: pid ->
// argv. The short `--print=/hooks` that checks the approval gate before each start is not one.
func (c *agyContract) agyProcesses() map[int]string {
	c.t.Helper()
	out, err := exec.Command("ps", "-A", "-o", "pid=,args=").Output()
	if err != nil {
		c.t.Fatal(err)
	}
	marker := "--gemini_dir=" + c.geminiDir()
	procs := map[int]string{}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 || !strings.Contains(line, marker) || filepath.Base(fields[1]) != agyExecutable ||
			strings.Contains(line, "--print=/hooks") {
			continue
		}
		if pid, err := strconv.Atoi(fields[0]); err == nil {
			procs[pid] = strings.Join(fields[1:], " ")
		}
	}
	return procs
}

func (c *agyContract) onlyAgy() (int, string) {
	c.t.Helper()
	deadline := time.Now().Add(agyContractWait)
	for {
		procs := c.agyProcesses()
		if len(procs) == 1 {
			for pid, args := range procs {
				return pid, args
			}
		}
		if time.Now().After(deadline) {
			c.t.Fatalf("want exactly one agy on %s, found %v", c.geminiDir(), procs)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// groupMembers lists the processes in process group pgid.
func groupMembers(t *testing.T, pgid int) []string {
	t.Helper()
	out, err := exec.Command("ps", "-A", "-o", "pid=,pgid=,args=").Output()
	if err != nil {
		t.Fatal(err)
	}
	var members []string
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[1] == strconv.Itoa(pgid) {
			members = append(members, strings.TrimSpace(line))
		}
	}
	return members
}

func pidAlive(pid int) bool {
	return pid > 0 && syscall.Kill(pid, 0) == nil
}

func waitFile(t *testing.T, path string) string {
	t.Helper()
	deadline := time.Now().Add(agyContractWait)
	for time.Now().Before(deadline) {
		if b, err := os.ReadFile(path); err == nil && strings.TrimSpace(string(b)) != "" {
			return strings.TrimSpace(string(b))
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("%s never appeared", path)
	return ""
}

func waitGone(t *testing.T, what string, gone func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for !gone() {
		if time.Now().After(deadline) {
			t.Fatalf("%s is still there", what)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func agyToolCall(name string, args map[string]interface{}) string {
	args["toolSummary"] = name
	args["toolAction"] = "Using " + name
	raw, _ := json.Marshal(args)
	return "mock:tool " + name + " " + string(raw)
}

// Two turns in one agy process: streamed text, the turn boundary at each `result`, usage and the
// context reading, the conversation id — and nothing written outside the session's Gemini directory.
func TestAntigravityContractMultiTurn(t *testing.T) {
	c := newAgyContract(t)
	job := c.job("contract-multi", "default")
	session := c.start(job)

	c.send(RunInboxResponse{TurnID: "t1", Kind: "message", Content: "hello\nmock:text The first answer arrives in several streamed chunks.\nmock:usage 1200 40 7 300"})
	// The mock answers prompt 1200 (300 of it cached), output 40, thoughts 7.
	first := c.completion("t1")
	if first.Status != stSucceeded || first.Subtype != "success" {
		t.Fatalf("turn 1 = %s/%s (%s), want SUCCEEDED; events:\n%s", first.Status, first.Subtype, first.Error, c.describeEvents())
	}
	if !strings.Contains(first.Result, "The first answer arrives in several streamed chunks.") {
		t.Fatalf("turn 1 result = %q", first.Result)
	}
	conversation := first.RuntimeSessionID
	if conversation == "" || job.RuntimeSessionID != conversation {
		t.Fatalf("conversation id = %q (job has %q)", conversation, job.RuntimeSessionID)
	}
	// agy reports the prompt without its cache reads, and the output with its thinking.
	if first.Usage == nil || first.Usage.InputTokens != 900 || first.Usage.CacheReadInputTokens != 300 || first.Usage.OutputTokens != 47 {
		t.Fatalf("turn 1 usage = %+v, want input 900 / cache read 300 / output 47", first.Usage)
	}
	pid, args := c.onlyAgy()
	for _, flag := range []string{"--print= ", "--input-format stream-json", "--output-format stream-json", "--disable-slash-commands", "--print-timeout=0s"} {
		if !strings.Contains(args+" ", flag) {
			t.Errorf("agy argv %q lacks %q", args, flag)
		}
	}
	if strings.Contains(args, "--conversation") {
		t.Errorf("a new session's agy was started on a conversation: %q", args)
	}

	c.send(RunInboxResponse{TurnID: "t2", Kind: "message", Content: "and again\nmock:text Second turn."})
	second := c.completion("t2")
	if second.Status != stSucceeded || strings.TrimSpace(second.Result) != "Second turn." {
		t.Fatalf("turn 2 = %s %q (%s)", second.Status, second.Result, second.Error)
	}
	if second.RuntimeSessionID != conversation {
		t.Fatalf("turn 2 ran on conversation %q, turn 1 on %q", second.RuntimeSessionID, conversation)
	}
	if again, _ := c.onlyAgy(); again != pid {
		t.Fatalf("turn 2 ran in agy %d, turn 1 in %d: the process must stay resident across turns", again, pid)
	}

	// The transcript: what the user sent, acknowledged; text as it streamed and then whole; a turn end
	// with the context reading over agy's window for its default model.
	for _, id := range []string{"t1", "t2"} {
		if len(c.eventsOf(id, evUser)) != 1 || len(c.eventsOf(id, evUserDelivery)) != 1 {
			t.Errorf("turn %s: user %d, user_delivery %d events", id, len(c.eventsOf(id, evUser)), len(c.eventsOf(id, evUserDelivery)))
		}
		ends := c.eventsOf(id, evTurnEnd)
		if len(ends) != 1 || payloadInt(ends[0]["contextTokens"]) <= 0 || payloadInt(ends[0]["contextWindow"]) != antigravityContextWindow("") {
			t.Errorf("turn %s turn_end = %v", id, ends)
		}
	}
	// Everything the first call filled: the prompt, cached or not, and the output.
	if ends := c.eventsOf("t1", evTurnEnd); len(ends) == 1 && payloadInt(ends[0]["contextTokens"]) != 1247 {
		t.Errorf("turn 1 context = %v, want 1247", ends[0]["contextTokens"])
	}
	var streamed strings.Builder
	for _, delta := range c.eventsOf("t1", evTextDelta) {
		streamed.WriteString(asString(delta["text"]))
	}
	assistant := c.eventsOf("t1", evAssistant)
	if len(assistant) != 1 || asString(assistant[0]["text"]) != streamed.String() || !strings.Contains(streamed.String(), "several streamed chunks") {
		t.Fatalf("turn 1 streamed %q, assistant %v", streamed.String(), assistant)
	}
	if inits := c.eventsOf("*", evSystem); len(filterSubtype(inits, "init")) != 1 {
		t.Fatalf("init events = %v, want one: a single process served both turns", filterSubtype(inits, "init"))
	}
	// The second turn's request carries the first turn: one conversation.
	requests := c.modelRequests()
	if len(requests) < 2 || !strings.Contains(requests[len(requests)-1], "The first answer arrives") {
		t.Fatalf("the second turn's model request does not carry the first turn (%d requests)", len(requests))
	}

	c.send(RunInboxResponse{TurnID: "end", Kind: "end"})
	if run := session.wait(t); run.status != stSucceeded || !run.ended {
		t.Fatalf("end = %+v", run)
	}
	if procs := c.agyProcesses(); len(procs) != 0 {
		t.Fatalf("agy still running after the session ended: %v", procs)
	}
	settings, err := os.ReadFile(filepath.Join(c.geminiDir(), "antigravity-cli", "settings.json"))
	if err != nil || !strings.Contains(string(settings), `"modelProvider": "gemini"`) {
		t.Fatalf("settings.json = %s (%v)", settings, err)
	}
	c.homeIsUntouched()
}

// A new process resumes the conversation with --conversation, in the same Gemini directory: the
// earlier turns are in the model's context (§4.2). An id agy cannot find is not silently dropped:
// the session is told its context is gone and keeps the new id (§4.3).
func TestAntigravityContractResumesConversation(t *testing.T) {
	c := newAgyContract(t)
	job := c.job("contract-resume", "default")
	word := "PELICAN-" + strconv.FormatInt(time.Now().UnixNano(), 36)

	session := c.start(job)
	c.send(RunInboxResponse{TurnID: "t1", Kind: "message", Content: "remember the word " + word + "\nmock:text Noted."})
	first := c.completion("t1")
	if first.Status != stSucceeded || first.RuntimeSessionID == "" {
		t.Fatalf("turn 1 = %+v", first)
	}
	conversation := first.RuntimeSessionID
	c.send(RunInboxResponse{TurnID: "end1", Kind: "end"})
	session.wait(t)
	waitGone(t, "the first agy", func() bool { return len(c.agyProcesses()) == 0 })

	// The next engine generation: the job carries the conversation id, as a claim does.
	resumed := c.job("contract-resume", "default")
	resumed.RuntimeSessionID = conversation
	session = c.start(resumed)
	_, args := c.onlyAgy()
	if !strings.Contains(args, "--conversation "+conversation) {
		t.Fatalf("the resumed agy argv %q does not continue %s", args, conversation)
	}
	c.send(RunInboxResponse{TurnID: "t2", Kind: "message", Content: "which word?\nmock:text The word is in my context."})
	second := c.completion("t2")
	if second.Status != stSucceeded || second.RuntimeSessionID != conversation {
		t.Fatalf("turn 2 = %s on %q, want SUCCEEDED on %q (%s)", second.Status, second.RuntimeSessionID, conversation, second.Error)
	}
	if last := c.lastModelRequest(); !strings.Contains(last, word) || !strings.Contains(last, "which word?") {
		t.Fatal("the resumed conversation's model request does not carry the earlier turn")
	}
	for _, e := range c.eventsOf("*", evSystem) {
		if e["noticeKind"] == "antigravity-conversation-lost" {
			t.Fatalf("a resumed conversation was reported lost: %v", e)
		}
	}
	c.send(RunInboxResponse{TurnID: "end2", Kind: "end"})
	session.wait(t)
	waitGone(t, "the second agy", func() bool { return len(c.agyProcesses()) == 0 })

	// An id the Gemini directory does not hold: agy starts a new conversation and says so only on
	// stderr; the loop says it in the transcript and keeps the new id.
	lost := c.job("contract-resume", "default")
	lost.RuntimeSessionID = "00000000-1111-2222-3333-444444444444"
	session = c.start(lost)
	c.send(RunInboxResponse{TurnID: "t3", Kind: "message", Content: "anyone there?\nmock:text A fresh conversation."})
	third := c.completion("t3")
	if third.Status != stSucceeded || third.RuntimeSessionID == "" || third.RuntimeSessionID == "00000000-1111-2222-3333-444444444444" ||
		lost.RuntimeSessionID != third.RuntimeSessionID {
		t.Fatalf("turn 3 = %s on %q", third.Status, third.RuntimeSessionID)
	}
	noticed := false
	for _, e := range c.eventsOf("*", evSystem) {
		noticed = noticed || e["noticeKind"] == "antigravity-conversation-lost"
	}
	if !noticed {
		t.Fatal("a conversation agy could not find was replaced without a notice")
	}
	c.send(RunInboxResponse{TurnID: "end3", Kind: "end"})
	session.wait(t)
	c.homeIsUntouched()
}

// Stop on a running turn: SIGINT to agy's process group ends the turn INTERRUPTED, and nothing agy
// started outlives it — a PreToolUse hook's child sits in agy's group and survives a SIGINT to agy
// alone (§13, measured on 1.2.16); a command agy runs sits in a session of its own and is agy's to
// kill. The next turn starts a new agy on the same conversation.
func TestAntigravityContractInterruptCleansProcessGroup(t *testing.T) {
	t.Run("hook", func(t *testing.T) {
		c := newAgyContract(t)
		job := c.job("contract-interrupt-hook", "bypassPermissions")
		hookPID := filepath.Join(c.dir, "hook.pid")
		// A hook that never answers: the tool call waits on it, and its child is in agy's group.
		hooks := map[string]interface{}{"orbit-contract": map[string]interface{}{"PreToolUse": []interface{}{
			map[string]interface{}{"matcher": "", "hooks": []interface{}{map[string]interface{}{
				"type": "command", "command": "sh -c 'echo $$ > " + hookPID + "; exec sleep 300'", "timeout": 600,
			}}},
		}}}
		raw, _ := json.Marshal(hooks)
		if err := os.MkdirAll(filepath.Join(c.geminiDir(), "config"), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(c.geminiDir(), "config", "hooks.json"), raw, 0o600); err != nil {
			t.Fatal(err)
		}
		session := c.start(job)
		marker := filepath.Join(c.execDir, "ran.txt")
		c.send(RunInboxResponse{TurnID: "t1", Kind: "message", Content: "run it\n" +
			agyToolCall("run_command", map[string]interface{}{"CommandLine": "touch " + marker, "Cwd": c.execDir, "WaitMsBeforeAsync": 10000}) +
			"\nmock:text unreachable"})
		sleeper, err := strconv.Atoi(waitFile(t, hookPID))
		if err != nil {
			t.Fatal(err)
		}
		agyPID, _ := c.onlyAgy()
		if members := groupMembers(t, agyPID); len(members) < 2 {
			t.Fatalf("agy's process group holds %v, want agy and its hook", members)
		}
		if !pidAlive(sleeper) {
			t.Fatal("the hook's child is not running")
		}

		c.send(RunInboxResponse{TurnID: "stop", Kind: "interrupt"})
		stopped := c.completion("t1")
		if stopped.Status != stInterrupted || stopped.Subtype != "interrupted" {
			t.Fatalf("interrupted turn = %s/%s (%s)", stopped.Status, stopped.Subtype, stopped.Error)
		}
		waitGone(t, "the hook's child", func() bool { return !pidAlive(sleeper) })
		waitGone(t, "agy's process group", func() bool { return len(groupMembers(t, agyPID)) == 0 })
		if _, err := os.Stat(marker); err == nil {
			t.Fatal("the command the hook was holding ran anyway")
		}

		// The next turn: a new agy, on the same conversation, which has the interrupted turn in it.
		c.send(RunInboxResponse{TurnID: "t2", Kind: "message", Content: "after the stop\nmock:text Back again."})
		next := c.completion("t2")
		if next.Status != stSucceeded || next.RuntimeSessionID != stopped.RuntimeSessionID || stopped.RuntimeSessionID == "" {
			t.Fatalf("turn after the interrupt = %s on %q, interrupted turn on %q (%s)", next.Status, next.RuntimeSessionID, stopped.RuntimeSessionID, next.Error)
		}
		newPID, args := c.onlyAgy()
		if newPID == agyPID || !strings.Contains(args, "--conversation "+stopped.RuntimeSessionID) {
			t.Fatalf("after the interrupt agy is %d %q, before it was %d", newPID, args, agyPID)
		}
		if last := c.lastModelRequest(); !strings.Contains(last, "run it") || !strings.Contains(last, "after the stop") {
			t.Fatal("the turn after the interrupt does not carry the interrupted one")
		}
		c.send(RunInboxResponse{TurnID: "end", Kind: "end"})
		session.wait(t)
		c.homeIsUntouched()
	})

	t.Run("command", func(t *testing.T) {
		c := newAgyContract(t)
		job := c.job("contract-interrupt-command", "bypassPermissions")
		commandPID := filepath.Join(c.dir, "command.pid")
		session := c.start(job)
		c.send(RunInboxResponse{TurnID: "t1", Kind: "message", Content: "wait for it\n" +
			agyToolCall("run_command", map[string]interface{}{"CommandLine": "echo $$ > " + commandPID + "; exec sleep 300", "Cwd": c.execDir, "WaitMsBeforeAsync": 60000}) +
			"\nmock:text unreachable"})
		sleeper, err := strconv.Atoi(waitFile(t, commandPID))
		if err != nil {
			t.Fatal(err)
		}
		agyPID, _ := c.onlyAgy()
		if !pidAlive(sleeper) {
			t.Fatal("the command is not running")
		}
		c.send(RunInboxResponse{TurnID: "stop", Kind: "interrupt"})
		if stopped := c.completion("t1"); stopped.Status != stInterrupted {
			t.Fatalf("interrupted turn = %s (%s)", stopped.Status, stopped.Error)
		}
		waitGone(t, "the command agy was running", func() bool { return !pidAlive(sleeper) })
		waitGone(t, "agy's process group", func() bool { return len(groupMembers(t, agyPID)) == 0 })
		c.send(RunInboxResponse{TurnID: "end", Kind: "end"})
		session.wait(t)
	})
}

// Orbit's own MCP server reaches agy through the session's mcp_config.json, starts with the session's
// identity inherited through agy's environment, and is callable in the default permission mode
// (§10.3): here task_get, answered by the fake control plane for the task in ORBIT_TASK_ID.
func TestAntigravityContractInjectsOrbitMCP(t *testing.T) {
	c := newAgyContract(t)
	job := c.job("contract-mcp", "default")
	job.TaskID = "task-mcp-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	session := c.start(job)
	c.send(RunInboxResponse{TurnID: "t1", Kind: "message", Content: "look the task up\n" +
		agyToolCall("call_mcp_tool", map[string]interface{}{"ServerName": "orbit", "ToolName": "task_get", "Arguments": map[string]interface{}{}})})
	turn := c.completion("t1")
	if turn.Status != stSucceeded {
		t.Fatalf("MCP turn = %s/%s (%s); events:\n%s", turn.Status, turn.Subtype, turn.Error, c.describeEvents())
	}
	c.mu.Lock()
	gets := append([]string(nil), c.taskGets...)
	c.mu.Unlock()
	if len(gets) != 1 || gets[0] != job.TaskID {
		t.Fatalf("control plane saw task_get for %v, want [%s] — ORBIT_TASK_ID did not reach `orbit mcp` through agy", gets, job.TaskID)
	}
	uses := c.eventsOf("t1", evToolUse)
	if len(uses) != 1 || uses[0]["name"] != "mcp__orbit__task_get" {
		t.Fatalf("tool_use = %v, want mcp__orbit__task_get", uses)
	}
	results := c.eventsOf("t1", evToolResult)
	if len(results) != 1 || results[0]["toolUseId"] != uses[0]["id"] || results[0]["isError"] != false ||
		!strings.Contains(asString(results[0]["content"]), "MCP-REACHED "+job.TaskID) {
		t.Fatalf("tool_result = %v", results)
	}
	// The model got the result back.
	if last := c.lastModelRequest(); !strings.Contains(last, "MCP-REACHED "+job.TaskID) {
		t.Fatal("the MCP result never reached the model")
	}
	raw, err := os.ReadFile(filepath.Join(c.geminiDir(), "config", "mcp_config.json"))
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		MCPServers map[string]struct {
			Command string   `json:"command"`
			Args    []string `json:"args"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal(raw, &config); err != nil || config.MCPServers["orbit"].Command != orbitCLIExecutable() ||
		strings.Join(config.MCPServers["orbit"].Args, " ") != "mcp" {
		t.Fatalf("mcp_config.json = %s (%v)", raw, err)
	}
	c.send(RunInboxResponse{TurnID: "end", Kind: "end"})
	session.wait(t)
	c.homeIsUntouched()
}

// In its own default mode (no permission flag) agy refuses what nobody approved — it has nobody to
// ask — and the turn stops there (§5.2): the command does not run, the transcript says why, and the
// turn reports permission_denied. An approval Orbit already holds becomes a permissions.allow rule
// agy honours. That mode is what Orbit's Don't Ask runs; Orbit's Default asks a person through the
// approval hook instead (TestAntigravityContractApproval*).
func TestAntigravityContractDefaultModeRefusesUnapproved(t *testing.T) {
	t.Run("refused", func(t *testing.T) {
		c := newAgyContract(t)
		job := c.job("contract-deny", "dontAsk")
		marker := filepath.Join(c.execDir, "denied.txt")
		session := c.start(job)
		c.send(RunInboxResponse{TurnID: "t1", Kind: "message", Content: "make the file\n" +
			agyToolCall("run_command", map[string]interface{}{"CommandLine": "touch " + marker, "Cwd": c.execDir, "WaitMsBeforeAsync": 10000}) +
			"\nmock:text unreachable"})
		turn := c.completion("t1")
		if turn.Status != stFailed || turn.Subtype != "permission_denied" || !strings.Contains(turn.Error, `"command"`) {
			t.Fatalf("refused turn = %s/%s %q; events:\n%s", turn.Status, turn.Subtype, turn.Error, c.describeEvents())
		}
		if _, err := os.Stat(marker); err == nil {
			t.Fatal("the refused command ran")
		}
		uses := c.eventsOf("t1", evToolUse)
		if len(uses) != 1 || uses[0]["name"] != "Bash" || asString(mapValue(uses[0]["input"])["command"]) != "touch "+marker {
			t.Fatalf("tool_use = %v", uses)
		}
		// agy refuses in one of two shapes (§5.2): a tool step that ends DONE with nothing in it, which
		// the loop reports as not run, or one that ends ERROR with agy's own "denied permission".
		results := c.eventsOf("t1", evToolResult)
		if len(results) != 1 || results[0]["isError"] != true ||
			!(strings.HasPrefix(asString(results[0]["content"]), "Not run") || strings.Contains(asString(results[0]["content"]), "denied permission")) {
			t.Fatalf("tool_result = %v", results)
		}
		if errs := c.eventsOf("t1", evError); len(errs) != 1 || !strings.Contains(asString(errs[0]["message"]), "Bypass") {
			t.Fatalf("error events = %v", errs)
		}
		// The turn ended at the refusal: the call was the model's last word in it, and nothing went
		// back to the model until the next message.
		if requests := c.modelRequests(); len(requests) != 1 {
			t.Fatalf("the refused turn made %d model requests, want only the one that asked for the command", len(requests))
		}
		// The process stays and takes the next turn.
		c.send(RunInboxResponse{TurnID: "t2", Kind: "message", Content: "just talk\nmock:text Talking still works."})
		if next := c.completion("t2"); next.Status != stSucceeded || strings.TrimSpace(next.Result) != "Talking still works." {
			t.Fatalf("turn after the refusal = %s %q (%s)", next.Status, next.Result, next.Error)
		}
		c.send(RunInboxResponse{TurnID: "end", Kind: "end"})
		session.wait(t)
	})

	t.Run("allowed by rule", func(t *testing.T) {
		c := newAgyContract(t)
		job := c.job("contract-allow", "dontAsk")
		job.Agent.AllowedTools = []string{"mcp__orbit__*", "Bash(touch:*)"}
		marker := filepath.Join(c.execDir, "allowed.txt")
		session := c.start(job)
		c.send(RunInboxResponse{TurnID: "t1", Kind: "message", Content: "make the file\n" +
			agyToolCall("run_command", map[string]interface{}{"CommandLine": "touch " + marker, "Cwd": c.execDir, "WaitMsBeforeAsync": 10000}) +
			"\nmock:text made it"})
		if turn := c.completion("t1"); turn.Status != stSucceeded {
			t.Fatalf("allowed turn = %s/%s %q; events:\n%s", turn.Status, turn.Subtype, turn.Error, c.describeEvents())
		}
		if _, err := os.Stat(marker); err != nil {
			t.Fatalf("the allowed command did not run: %v", err)
		}
		c.send(RunInboxResponse{TurnID: "end", Kind: "end"})
		session.wait(t)
	})
}

func filterSubtype(events []map[string]interface{}, subtype string) []map[string]interface{} {
	var out []map[string]interface{}
	for _, e := range events {
		if e["subtype"] == subtype {
			out = append(out, e)
		}
	}
	return out
}

// payloadInt reads a number out of an event payload as the session loop built it, before any JSON.
func payloadInt(v interface{}) int {
	switch n := v.(type) {
	case int:
		return n
	case int64:
		return int(n)
	case float64:
		return int(n)
	}
	return 0
}
