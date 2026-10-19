//go:build cursor_real && linux

package main

// P5c's measurements on the real pinned Cursor CLI (docs/cursor-runtime-contract.md §5, §6, §7). Each
// scenario runs one Orbit session through runCursorSession — the runner's own launch, driver and
// permission bridge — on `<pinned build>/cursor-agent acp`, against a stub control plane that answers
// each approval card as the scenario says, and then checks what happened on disk and in the process
// table. A proxy between the runner and the CLI keeps the protocol, which is saved redacted as a replay
// recording for the deterministic tests (testdata/cursor/p5c/), with the scenario's checks beside it.
//
// Real prompts spend the owner's Cursor quota (Auto model only): each is charged to a ledger before it is
// delivered, and the ledger refuses past 30 for this task. Run one scenario at a time:
//
//	ORBIT_CURSOR_REAL_CLI=/mnt/data/cursor-p0/cli/2026.10.14-941492e/cursor-agent \
//	ORBIT_CURSOR_REAL_KEY_FILE=/root/.config/orbit-secrets/cursor-api-key \
//	ORBIT_CURSOR_REAL_LEDGER=/mnt/data/cursor-p0/ledger/p5c-prompts.jsonl \
//	ORBIT_CURSOR_REAL_OUT=<dir> \
//	go test -tags cursor_real -count=1 -run 'TestCursorRealP5c/<scenario>' -v .
//
// ORBIT_CURSOR_REAL_OUT receives <scenario>/<process>/{stdin,stdout}.jsonl, stderr.txt and meta.json,
// redacted, plus <scenario>/summary.json.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

const (
	realCursorRecordEnv = "ORBIT_TEST_CURSOR_RECORD" // the proxy's raw log directory
	realCursorExecEnv   = "ORBIT_TEST_CURSOR_EXEC"   // the real CLI the proxy starts
	realCursorCap       = 30
)

func init() {
	if dir := os.Getenv(realCursorRecordEnv); dir != "" {
		os.Exit(runRealCursorRecorder(dir, os.Getenv(realCursorExecEnv)))
	}
}

// runRealCursorRecorder is the proxy: it starts the real CLI with the environment it was given (less its
// own two variables), copies stdin to it and its stdout back line by line, keeping both, and ends the way
// the CLI ended. SIGTERM, SIGINT and SIGHUP go on to the CLI.
func runRealCursorRecorder(dir, exe string) int {
	var env []string
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, realCursorRecordEnv+"=") && !strings.HasPrefix(entry, realCursorExecEnv+"=") {
			env = append(env, entry)
		}
	}
	cmd := exec.Command(exe, os.Args[1:]...)
	cmd.Env = env
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return 2
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return 2
	}
	stderr, err := os.Create(filepath.Join(dir, "stderr.txt"))
	if err != nil {
		return 2
	}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "recorder:", err)
		return 2
	}
	wd, _ := os.Getwd()
	pids, _ := json.Marshal(map[string]interface{}{"recorder": os.Getpid(), "cli": cmd.Process.Pid, "args": os.Args[1:], "dir": wd})
	_ = os.WriteFile(filepath.Join(dir, "pids.json"), pids, 0o600)
	signals := make(chan os.Signal, 4)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	go func() {
		for sig := range signals {
			_ = cmd.Process.Signal(sig)
		}
	}()
	t0 := time.Now()
	var mu sync.Mutex
	timeline, _ := os.Create(filepath.Join(dir, "timeline.jsonl"))
	note := func(direction string, line []byte) {
		mu.Lock()
		defer mu.Unlock()
		entry, _ := json.Marshal(map[string]interface{}{"t": time.Since(t0).Milliseconds(), "dir": direction, "line": json.RawMessage(line)})
		_, _ = timeline.Write(append(entry, '\n'))
	}
	in, _ := os.Create(filepath.Join(dir, "stdin.jsonl"))
	out, _ := os.Create(filepath.Join(dir, "stdout.jsonl"))
	go func() {
		sc := bufio.NewScanner(os.Stdin)
		sc.Buffer(make([]byte, 1<<20), 64<<20)
		for sc.Scan() {
			line := append([]byte{}, sc.Bytes()...)
			_, _ = in.Write(append(line, '\n'))
			if json.Valid(line) {
				note("client->agent", line)
			}
			_, _ = stdin.Write(append(line, '\n'))
		}
		_ = stdin.Close()
	}()
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 1<<20), 64<<20)
	for sc.Scan() {
		line := append([]byte{}, sc.Bytes()...)
		_, _ = out.Write(append(line, '\n'))
		if json.Valid(line) {
			note("agent->client", line)
		}
		_, _ = os.Stdout.Write(append(line, '\n'))
	}
	err = cmd.Wait()
	status := map[string]interface{}{"ms": time.Since(t0).Milliseconds()}
	code := 0
	if exit, ok := err.(*exec.ExitError); ok {
		code = exit.ExitCode()
		if ws, ok := exit.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			status["signal"] = ws.Signal().String()
		}
	}
	status["code"] = code
	exitWire, _ := json.Marshal(status)
	_ = os.WriteFile(filepath.Join(dir, "exit.json"), exitWire, 0o600)
	if sig, ok := status["signal"]; ok && sig == syscall.SIGKILL.String() {
		signal.Reset()
		_ = syscall.Kill(os.Getpid(), syscall.SIGKILL)
		time.Sleep(time.Second)
	}
	return code
}

// realCursor is the pinned CLI, its key, and where a scenario's prompts are charged and its results kept.
type realCursor struct {
	cli, key, ledger, out string
}

func realCursorEnv(t *testing.T) realCursor {
	t.Helper()
	r := realCursor{cli: os.Getenv("ORBIT_CURSOR_REAL_CLI"), ledger: os.Getenv("ORBIT_CURSOR_REAL_LEDGER"), out: os.Getenv("ORBIT_CURSOR_REAL_OUT")}
	keyFile := os.Getenv("ORBIT_CURSOR_REAL_KEY_FILE")
	if !filepath.IsAbs(r.cli) || !filepath.IsAbs(keyFile) || !filepath.IsAbs(r.ledger) || !filepath.IsAbs(r.out) {
		t.Fatal("ORBIT_CURSOR_REAL_CLI, ORBIT_CURSOR_REAL_KEY_FILE, ORBIT_CURSOR_REAL_LEDGER and ORBIT_CURSOR_REAL_OUT must be absolute")
	}
	// Even --version writes $HOME/.cursor/cli-config.json, or CURSOR_CONFIG_DIR's: never the runner user's.
	probe := exec.Command(r.cli, "--version")
	probe.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + t.TempDir(), "CURSOR_CONFIG_DIR=" + t.TempDir(), "TMPDIR=" + t.TempDir()}
	version, err := probe.Output()
	if err != nil || strings.TrimSpace(string(version)) != cursorSupportedVersion {
		t.Fatalf("%s --version = %q (%v), want %s", r.cli, version, err, cursorSupportedVersion)
	}
	key, err := os.ReadFile(keyFile)
	if err != nil || strings.TrimSpace(string(key)) == "" {
		t.Fatalf("no key in %s: %v", keyFile, err)
	}
	r.key = strings.TrimSpace(string(key))
	return r
}

// charge records one real prompt before it is sent, and refuses past the task's cap.
func (r realCursor) charge(t *testing.T, scenario, note string) int {
	t.Helper()
	data, err := os.ReadFile(r.ledger)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	spent := 0
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) != "" {
			spent++
		}
	}
	if spent >= realCursorCap {
		t.Fatalf("the P5c prompt ledger %s holds %d prompts, its cap; refusing %s", r.ledger, spent, scenario)
	}
	entry, _ := json.Marshal(map[string]interface{}{"n": spent + 1, "at": time.Now().UTC().Format(time.RFC3339Nano), "task": "P5c 34h05fsaJBXkS3SDQ2smK",
		"scenario": scenario, "note": note, "version": cursorSupportedVersion, "model": "Auto (default)"})
	f, err := os.OpenFile(r.ledger, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.Write(append(entry, '\n')); err != nil {
		t.Fatal(err)
	}
	return spent + 1
}

// realScenario is one session on the real CLI.
type realScenario struct {
	name    string
	mode    string
	prompts []string
	agent   func(*AgentExecConfig)
	approve func(card cursorTestCard) cursorTestDecision
	onCard  func(raw string, card cursorTestCard) []RunInboxResponse
	// fixture lays out the session's checkout before it starts.
	fixture func(t *testing.T, work string)
}

type realRun struct {
	cursorRun
	work, raw string
	processes []string // every process seen under the CLI while the session ran
	prompts   []int    // the ledger entries charged
}

// run starts the scenario's session on the real CLI behind the proxy and returns what happened.
func (r realCursor) run(t *testing.T, sc realScenario) realRun {
	t.Helper()
	useCursorRealHome(t)
	raw := t.TempDir()
	work := filepath.Join(t.TempDir(), "work")
	if err := os.MkdirAll(work, 0o755); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("git", "init", "-q", work).CombinedOutput(); err != nil {
		t.Fatalf("git init: %v %s", err, out)
	}
	if err := os.WriteFile(filepath.Join(work, "README.md"), []byte("# P5c probe repository\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if sc.fixture != nil {
		sc.fixture(t, work)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	shim := filepath.Join(t.TempDir(), cursorEntryPoint)
	body := "#!/bin/sh\nexport " + realCursorRecordEnv + "=" + shellQuote(raw) + "\nexport " + realCursorExecEnv + "=" + shellQuote(r.cli) +
		"\nexec " + shellQuote(self) + " \"$@\"\n"
	if err := os.WriteFile(shim, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	// `orbit mcp` is this binary as the MCP server, against the stub control plane named in ORBIT_HOME.
	mcpShim := filepath.Join(t.TempDir(), "orbit-mcp")
	if err := os.WriteFile(mcpShim, []byte("#!/bin/sh\nexport "+testOrbitMCPEnv+"=1\nexec "+shellQuote(self)+" \"$@\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	previous := cursorOrbitMCPCommand
	cursorOrbitMCPCommand = func() (string, []string) { return mcpShim, []string{"mcp"} }
	t.Cleanup(func() { cursorOrbitMCPCommand = previous })

	var mu sync.Mutex
	var run realRun
	run.work, run.raw = work, raw
	seen := map[string]bool{}
	stopSampling := make(chan struct{})
	sampled := make(chan struct{})
	go func() {
		defer close(sampled)
		for {
			for _, line := range realCursorDescendants(raw) {
				mu.Lock()
				if !seen[line] {
					seen[line] = true
					run.processes = append(run.processes, line)
				}
				mu.Unlock()
			}
			select {
			case <-stopSampling:
				return
			case <-time.After(150 * time.Millisecond):
			}
		}
	}()
	turns := make([]RunInboxResponse, 0, len(sc.prompts))
	for i, prompt := range sc.prompts {
		turns = append(turns, cursorMessage(fmt.Sprintf("turn-%d", i+1), prompt))
	}
	charge := func(items []RunInboxResponse) []RunInboxResponse {
		for _, item := range items {
			if item.Kind == "message" {
				n := r.charge(t, sc.name, item.TurnID)
				mu.Lock()
				run.prompts = append(run.prompts, n)
				mu.Unlock()
			}
		}
		return items
	}
	first, then := cursorTurns(turns...)
	tasks := 0
	opts := cursorRunOptions{
		executable: shim, timeout: 6 * time.Minute, sameHome: true, execDir: work, taskID: "71111111-2222-4333-8444-777777777777",
		env:     map[string]string{"CURSOR_API_KEY": r.key, "ORBIT_P5C_MARK": sc.name},
		first:   charge(first),
		then:    func(n int, last TurnCompleteRequest) []RunInboxResponse { return charge(then(n, last)) },
		approve: sc.approve,
		agent: func(agent *AgentExecConfig) {
			agent.PermissionMode = sc.mode
			agent.AllowedTools = []string{"mcp__orbit__*"}
			if sc.agent != nil {
				sc.agent(agent)
			}
		},
		serve: func(w http.ResponseWriter, req *http.Request) bool {
			if req.Method == http.MethodGet && strings.HasPrefix(req.URL.Path, "/api/runner/tasks/") {
				mu.Lock()
				tasks++
				mu.Unlock()
				_ = json.NewEncoder(w).Encode(map[string]interface{}{"id": strings.TrimPrefix(req.URL.Path, "/api/runner/tasks/"),
					"title": "P5c probe task", "status": "IN_PROGRESS",
					"session": req.Header.Get("X-Orbit-Session-Id")})
				return true
			}
			return false
		},
	}
	if sc.onCard != nil {
		opts.onCard = func(card cursorTestCard) []RunInboxResponse { return sc.onCard(raw, card) }
	}
	// `orbit mcp` signs in to the stub from the runner config in ORBIT_HOME.
	opts.onServer = func(url string) {
		cfg, _ := json.Marshal(RunnerConfig{ServerURL: url, RunnerID: "p5c-runner", RunnerToken: "p5c-runner-token", Name: "p5c"})
		if err := os.WriteFile(configPath(), cfg, 0o600); err != nil {
			t.Errorf("runner config: %v", err)
		}
	}
	run.cursorRun = runCursorSession(t, opts)
	close(stopSampling)
	<-sampled
	mu.Lock()
	defer mu.Unlock()
	if tasks > 0 {
		run.processes = append(run.processes, fmt.Sprintf("(stub served task_get %d time(s))", tasks))
	}
	return run
}

// realCursorDescendants lists the processes under the recorder (the CLI and what it started), as
// "<command line>" with the run's own paths elided.
func realCursorDescendants(raw string) []string {
	data, err := os.ReadFile(filepath.Join(raw, "pids.json"))
	if err != nil {
		return nil
	}
	var pids struct {
		Recorder int `json:"recorder"`
	}
	if json.Unmarshal(data, &pids) != nil || pids.Recorder == 0 {
		return nil
	}
	children := map[int][]int{}
	entries, _ := os.ReadDir("/proc")
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		stat, err := os.ReadFile(filepath.Join("/proc", entry.Name(), "stat"))
		if err != nil {
			continue
		}
		text := string(stat)
		fields := strings.Fields(text[strings.LastIndexByte(text, ')')+2:])
		if len(fields) < 2 {
			continue
		}
		ppid, _ := strconv.Atoi(fields[1])
		children[ppid] = append(children[ppid], pid)
	}
	var out []string
	var walk func(pid int)
	walk = func(pid int) {
		for _, child := range children[pid] {
			cmdline, _ := os.ReadFile(filepath.Join("/proc", strconv.Itoa(child), "cmdline"))
			line := strings.TrimSpace(strings.ReplaceAll(string(cmdline), "\x00", " "))
			if line != "" {
				out = append(out, line)
			}
			walk(child)
		}
	}
	walk(pids.Recorder)
	return out
}

// realCursorPID is the real CLI's process, once the proxy has started it.
func realCursorPID(raw string) int {
	data, err := os.ReadFile(filepath.Join(raw, "pids.json"))
	if err != nil {
		return 0
	}
	var pids struct {
		CLI int `json:"cli"`
	}
	_ = json.Unmarshal(data, &pids)
	return pids.CLI
}

// realCursorLines reads one of the proxy's logs.
func realCursorLines(t *testing.T, raw, name string) []map[string]interface{} {
	t.Helper()
	messages, err := readFakeCursorJSONL(filepath.Join(raw, name))
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	return messages
}

// answersTo is what the runner answered each request the CLI sent, by the request's id.
func answersTo(t *testing.T, raw string) (map[string][]map[string]interface{}, map[string]map[string]interface{}) {
	t.Helper()
	requests := map[string]map[string]interface{}{}
	for _, msg := range realCursorLines(t, raw, "stdout.jsonl") {
		if asString(msg["method"]) != "" && msg["id"] != nil {
			requests[rpcIDKey(msg["id"])] = msg
		}
	}
	answers := map[string][]map[string]interface{}{}
	for _, msg := range realCursorLines(t, raw, "stdin.jsonl") {
		if msg["method"] == nil && msg["id"] != nil {
			id := rpcIDKey(msg["id"])
			if requests[id] != nil {
				answers[id] = append(answers[id], mapValue(msg["result"]))
			}
		}
	}
	return answers, requests
}

// realCheck is one finding of a scenario, kept in its summary.
type realCheck struct {
	Name   string `json:"name"`
	Pass   bool   `json:"pass"`
	Detail string `json:"detail,omitempty"`
}

type realReport struct {
	t      *testing.T
	checks []realCheck
	facts  map[string]interface{}
}

func newRealReport(t *testing.T) *realReport {
	return &realReport{t: t, facts: map[string]interface{}{}}
}

func (r *realReport) check(name string, pass bool, detail string, args ...interface{}) {
	r.t.Helper()
	text := fmt.Sprintf(detail, args...)
	r.checks = append(r.checks, realCheck{Name: name, Pass: pass, Detail: text})
	if !pass {
		r.t.Errorf("%s: %s", name, text)
	} else {
		r.t.Logf("PASS %s: %s", name, text)
	}
}

// save keeps the scenario's protocol, redacted, as a replay recording, and its findings beside it.
func (r realCursor) save(t *testing.T, scenario, process string, run realRun, report *realReport) {
	t.Helper()
	red := newRealRedactor(r.key, run)
	dir := filepath.Join(r.out, scenario, process)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"stdin.jsonl", "stdout.jsonl", "stderr.txt", "timeline.jsonl", "exit.json"} {
		data, err := os.ReadFile(filepath.Join(run.raw, name))
		if err != nil {
			continue
		}
		if err := os.WriteFile(filepath.Join(dir, name), []byte(red.text(string(data))), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var cards []map[string]interface{}
	for _, card := range run.cards {
		cards = append(cards, map[string]interface{}{"toolName": card.ToolName, "toolUseId": card.ToolUseID, "input": card.Input, "withdrawn": card.Withdrawn})
	}
	var completions []map[string]interface{}
	for _, req := range run.completions {
		completions = append(completions, map[string]interface{}{"turn": req.TurnID, "status": req.Status, "subtype": req.Subtype, "error": req.Error, "result": clip(req.Result, 600)})
	}
	var events []map[string]interface{}
	for _, event := range run.events {
		if event.typ == evToolUse || event.typ == evToolResult || event.typ == evSystem || event.typ == evError {
			events = append(events, map[string]interface{}{"turn": event.turn, "type": event.typ, "payload": event.payload})
		}
	}
	summary := map[string]interface{}{
		"scenario": scenario, "process": process, "version": cursorSupportedVersion, "mode": run.job.Agent.PermissionMode,
		"args": run.spec.Args, "prompts": run.prompts, "checks": report.checks, "facts": report.facts,
		"cards": cards, "completions": completions, "events": events, "processes": run.processes, "status": run.status,
	}
	wire, _ := json.MarshalIndent(summary, "", "  ")
	if err := os.WriteFile(filepath.Join(r.out, scenario, "summary.json"), []byte(red.text(string(wire))+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// realRedactor replaces the key, tokens and identities, and the run's own paths and ids with stable
// placeholders, as the P0 recordings were (scripts/cursor-p0/lib/redact.mjs).
type realRedactor struct {
	secrets [][2]string
	paths   [][2]string
	ids     map[string]string
}

var (
	realJWT   = regexp.MustCompile(`eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`)
	realKey   = regexp.MustCompile(`(?:crsr|key)_[0-9A-Za-z_-]{16,}`)
	realEmail = regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`)
	realUUID  = regexp.MustCompile(`(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)
	realToken = regexp.MustCompile(`("(?:accessToken|refreshToken|authToken|apiKey|token)"\s*:\s*")[^"]{8,}(")`)
)

func newRealRedactor(key string, run realRun) *realRedactor {
	red := &realRedactor{ids: map[string]string{}}
	red.secrets = append(red.secrets, [2]string{key, "<CURSOR_API_KEY>"})
	self, _ := os.Executable()
	cli := os.Getenv("ORBIT_CURSOR_REAL_CLI")
	for _, pair := range [][2]string{
		{run.work, "<RUN>/work"}, {filepath.Dir(run.spec.ConfigDir), "<RUN>/session"}, {os.Getenv("HOME"), "<RUN>/home"},
		{run.raw, "<RUN>/proxy"}, {filepath.Dir(cli), "<CLI>"}, {self, "<ORBIT>"}, {os.TempDir(), "<TMP>"},
	} {
		if pair[0] != "" && pair[0] != "/" {
			red.paths = append(red.paths, pair)
		}
	}
	sort.Slice(red.paths, func(i, j int) bool { return len(red.paths[i][0]) > len(red.paths[j][0]) })
	return red
}

func (red *realRedactor) text(s string) string {
	for _, secret := range red.secrets {
		if len(secret[0]) >= 8 {
			s = strings.ReplaceAll(s, secret[0], secret[1])
		}
	}
	s = realJWT.ReplaceAllString(s, "<JWT>")
	s = realKey.ReplaceAllString(s, "<CURSOR_API_KEY>")
	s = realToken.ReplaceAllString(s, "${1}<REDACTED>${2}")
	s = realEmail.ReplaceAllStringFunc(s, func(m string) string {
		if strings.HasSuffix(m, "@cursor.com") || strings.HasSuffix(m, "@anysphere.co") {
			return m
		}
		return "<EMAIL>"
	})
	for _, path := range red.paths {
		s = strings.ReplaceAll(s, path[0], path[1])
	}
	return realUUID.ReplaceAllStringFunc(s, func(id string) string {
		key := strings.ToLower(id)
		if red.ids[key] == "" {
			red.ids[key] = fmt.Sprintf("<UUID_%d>", len(red.ids)+1)
		}
		return red.ids[key]
	})
}

// realKill ends the real CLI as a crash would: SIGKILL, while it waits on the runner.
func realKill(raw string) {
	if pid := realCursorPID(raw); pid > 0 {
		_ = syscall.Kill(pid, syscall.SIGKILL)
	}
}

func cardInput(card cursorTestCard) string {
	wire, _ := json.Marshal(card.Input)
	return string(wire)
}

// realOutcome is the option a runner answer selected, or its outcome when it selected none.
func realOutcome(result map[string]interface{}) string {
	outcome := mapValue(result["outcome"])
	if id := firstString(outcome, "optionId"); id != "" {
		return id
	}
	return firstString(outcome, "outcome")
}

// realRequestsMatching is the permission requests the CLI sent whose title holds text, with the runner's answers.
func realRequestsMatching(t *testing.T, raw, text string) [][]string {
	t.Helper()
	answers, requests := answersTo(t, raw)
	var out [][]string
	ids := make([]string, 0, len(requests))
	for id := range requests {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		msg := requests[id]
		if msg["method"] != "session/request_permission" {
			continue
		}
		title := firstString(mapValue(mapValue(msg["params"])["toolCall"]), "title")
		if !strings.Contains(title, text) {
			continue
		}
		var given []string
		for _, answer := range answers[id] {
			given = append(given, realOutcome(answer))
		}
		out = append(out, append([]string{title}, given...))
	}
	return out
}

// realRequestsTitled is realRequestsMatching for one exact title.
func realRequestsTitled(t *testing.T, raw, title string) [][]string {
	t.Helper()
	var out [][]string
	for _, request := range realRequestsMatching(t, raw, title) {
		if request[0] == title {
			out = append(out, request)
		}
	}
	return out
}

// realOutside is a directory outside the workspace that is not a temporary one: Cursor CLI writes under
// /tmp and /var/tmp without asking (index.js@4599905).
func realOutside(t *testing.T) string {
	t.Helper()
	root := "/mnt/data/cursor-p0/p5c/runs"
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp(root, "outside-")
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

// realNoRealCursorHome checks the runner user's real Cursor directories were not created.
func realNoRealCursorHome(report *realReport) {
	for _, dir := range []string{"/root/.cursor", "/root/.config/cursor", "/root/.local/share/cursor-agent"} {
		_, err := os.Lstat(dir)
		report.check("real-cursor-home-untouched "+dir, os.IsNotExist(err), "absent before and after (lstat: %v)", err)
	}
}

func realPermissionCount(t *testing.T, raw string) int {
	t.Helper()
	_, requests := answersTo(t, raw)
	n := 0
	for _, msg := range requests {
		if msg["method"] == "session/request_permission" {
			n++
		}
	}
	return n
}

func TestCursorRealP5c(t *testing.T) {
	r := realCursorEnv(t)
	denyNamed := func(word string) func(cursorTestCard) cursorTestDecision {
		return func(card cursorTestCard) cursorTestDecision {
			if strings.Contains(cardInput(card), word) {
				return cursorTestDecision{Status: "DENIED"}
			}
			return cursorTestDecision{Status: "ALLOWED"}
		}
	}
	deny := func(cursorTestCard) cursorTestDecision { return cursorTestDecision{Status: "DENIED"} }
	hold := func(cursorTestCard) cursorTestDecision { return cursorTestDecision{} }

	t.Run("mcp-orbit", func(t *testing.T) {
		report := newRealReport(t)
		run := r.run(t, realScenario{name: "mcp-orbit", mode: "acceptEdits", approve: deny, prompts: []string{
			"Call the task_get tool of the orbit MCP server once, with no arguments. Then reply with only the task's title.",
		}})
		var news []map[string]interface{}
		for _, msg := range realCursorLines(t, run.raw, "stdin.jsonl") {
			if msg["method"] == "session/new" {
				news = append(news, mapValue(msg["params"]))
			}
		}
		servers, _ := news[0]["mcpServers"].([]interface{})
		orbit := mapValue(servers[0])
		env := map[string]string{}
		rows, _ := orbit["env"].([]interface{})
		for _, row := range rows {
			env[firstString(mapValue(row), "name")] = firstString(mapValue(row), "value")
		}
		report.check("orbit-mcp-injected", firstString(orbit, "name") == "orbit" && env["ORBIT_SESSION_ID"] == publicID(run.job.SessionID) &&
			env["ORBIT_TASK_ID"] == publicID(run.job.TaskID) && env["ORBIT_HOME"] != "" && env[envMCPCallTimeout] == "60",
			"session/new mcpServers[0] = %s %v, env keys %d", firstString(orbit, "name"), orbit["args"], len(env))
		asked := realRequestsMatching(t, run.raw, "task_get")
		report.check("orbit-tool-allowed-unasked", len(asked) >= 1 && len(asked[0]) == 2 && asked[0][1] == cursorAllowOnce && len(run.cards) == 0,
			"requests %q, cards %d", asked, len(run.cards))
		served := false
		for _, line := range run.processes {
			served = served || strings.HasPrefix(line, "(stub served task_get")
		}
		report.check("orbit-tool-reached-orbit", served, "the stub control plane served task_get")
		var uses []string
		for _, use := range run.of("turn-1", evToolUse) {
			uses = append(uses, asString(use["name"]))
		}
		var results []string
		for _, result := range run.of("turn-1", evToolResult) {
			results = append(results, asString(result["content"]))
		}
		report.check("orbit-tool-card", strings.Contains(strings.Join(uses, ","), "mcp__orbit__task_get") &&
			strings.Contains(strings.Join(results, "|"), "Cursor CLI does not pass an MCP tool's result on"), "uses %q results %q", uses, results)
		if len(run.completions) > 0 {
			report.facts["reply"] = clip(run.completions[0].Result, 300)
			report.facts["replyNamesTheTask"] = strings.Contains(run.completions[0].Result, "P5c probe task")
		}
		realNoRealCursorHome(report)
		r.save(t, "mcp-orbit", "session", run, report)
	})

	t.Run("accept-edits-allow-deny", func(t *testing.T) {
		report := newRealReport(t)
		outside := realOutside(t)
		run := r.run(t, realScenario{name: "accept-edits-allow-deny", mode: "acceptEdits", approve: denyNamed("denied"), prompts: []string{
			"Do these four steps in order, one tool call per step, and do not retry a step that is refused or try another way:\n" +
				"1. Run the shell command: touch cmd-allowed.txt\n" +
				"2. Run the shell command: touch cmd-denied.txt\n" +
				"3. Use your file editing tool to create the file " + filepath.Join(outside, "edit-allowed.txt") + " containing the word allowed.\n" +
				"4. Use your file editing tool to create the file " + filepath.Join(outside, "edit-denied.txt") + " containing the word denied.\n" +
				"Then report which steps succeeded, and do nothing else.",
		}})
		report.check("command-allowed-ran", exists(filepath.Join(run.work, "cmd-allowed.txt")), "cmd-allowed.txt exists")
		report.check("command-denied-did-not-run", !exists(filepath.Join(run.work, "cmd-denied.txt")), "cmd-denied.txt absent")
		report.check("outside-edit-allowed-written", exists(filepath.Join(outside, "edit-allowed.txt")), "edit-allowed.txt exists")
		report.check("outside-edit-denied-not-written", !exists(filepath.Join(outside, "edit-denied.txt")), "edit-denied.txt absent")
		var edits []string
		for _, card := range run.cards {
			if card.ToolName == "Write" || card.ToolName == "Edit" {
				edits = append(edits, card.ToolName+" "+firstString(mapValue(card.Input), "file_path"))
			}
		}
		report.check("outside-edits-asked", len(edits) == 2, "edit cards %q", edits)
		// Each card's call settles as what happened to it (D-P8-1): Cursor CLI completes a refused command or edit
		// with no output at all, so a refused one says it did not run, and an allowed one is no error.
		for _, want := range []struct {
			check, file string
			refused     bool
		}{
			{"command-allowed-card-ran", "cmd-allowed.txt", false},
			{"command-denied-card-not-run", "cmd-denied.txt", true},
			{"outside-edit-allowed-card-written", "edit-allowed.txt", false},
			{"outside-edit-denied-card-not-run", "edit-denied.txt", true},
		} {
			var result map[string]interface{}
			for _, card := range run.cards {
				if strings.Contains(cardInput(card), want.file) {
					result = cursorCardResult(run.cursorRun, "turn-1", card)
				}
			}
			settled := result != nil && result["isError"] == want.refused
			if want.refused {
				settled = settled && result["content"] == "Not run: the tool call was rejected."
			}
			report.check(want.check, settled, "the card's call settled %v", result)
		}
		var names []string
		for _, card := range run.cards {
			names = append(names, card.ToolName+" "+cardInput(card))
		}
		report.facts["cards"] = names
		answers, _ := answersTo(t, run.raw)
		alwaysChosen, unanswered := false, 0
		for _, given := range answers {
			for _, answer := range given {
				alwaysChosen = alwaysChosen || realOutcome(answer) == cursorAllowAlways
			}
		}
		_, requests := answersTo(t, run.raw)
		for id := range requests {
			if len(answers[id]) != 1 {
				unanswered++
			}
		}
		report.check("each-request-answered-once", unanswered == 0, "%d request(s) not answered exactly once", unanswered)
		report.check("allow-always-never-chosen", !alwaysChosen, "no answer selected allow-always")
		report.facts["requests"] = realRequestsMatching(t, run.raw, "")
		realNoRealCursorHome(report)
		r.save(t, "accept-edits-allow-deny", "session", run, report)
	})

	t.Run("accept-edits-stop", func(t *testing.T) {
		report := newRealReport(t)
		run := r.run(t, realScenario{name: "accept-edits-stop", mode: "acceptEdits", approve: hold,
			onCard: func(string, cursorTestCard) []RunInboxResponse {
				return []RunInboxResponse{{TurnID: "stop-1", Kind: "interrupt"}}
			},
			prompts: []string{"Run the shell command: touch stopped.txt\nDo nothing else."}})
		asked := realRequestsMatching(t, run.raw, "touch stopped.txt")
		report.check("request-answered-cancelled-once", len(asked) == 1 && len(asked[0]) == 2 && asked[0][1] == "cancelled", "requests %q", asked)
		report.check("card-withdrawn", len(run.cards) == 1 && run.cards[0].released(), "cards %+v", run.cards)
		report.check("command-did-not-run", !exists(filepath.Join(run.work, "stopped.txt")), "stopped.txt absent")
		report.check("turn-interrupted", len(run.completions) >= 1 && run.completions[0].Status == stInterrupted, "completions %+v", run.completions)
		var result map[string]interface{}
		if len(run.cards) == 1 {
			result = cursorCardResult(run.cursorRun, "turn-1", run.cards[0])
		}
		report.check("withdrawn-card-not-run", result["content"] == cursorStoppedBeforeApproval && result["isError"] == true,
			"the card's call settled %v", result)
		cancels := 0
		for _, msg := range realCursorLines(t, run.raw, "stdin.jsonl") {
			if msg["method"] == "session/cancel" {
				cancels++
			}
		}
		report.check("session-cancel-sent", cancels == 1, "%d session/cancel", cancels)
		realNoRealCursorHome(report)
		r.save(t, "accept-edits-stop", "session", run, report)
	})

	t.Run("accept-edits-disconnect", func(t *testing.T) {
		report := newRealReport(t)
		run := r.run(t, realScenario{name: "accept-edits-disconnect", mode: "acceptEdits", approve: hold,
			onCard: func(raw string, _ cursorTestCard) []RunInboxResponse {
				go func() { time.Sleep(300 * time.Millisecond); realKill(raw) }()
				return nil
			},
			prompts: []string{"Run the shell command: touch disconnected.txt\nDo nothing else."}})
		report.check("card-withdrawn", len(run.cards) == 1 && run.cards[0].released(), "cards %+v", run.cards)
		report.check("command-did-not-run", !exists(filepath.Join(run.work, "disconnected.txt")), "disconnected.txt absent")
		report.check("turn-failed-on-exit", len(run.completions) >= 1 && run.completions[0].Status == stFailed &&
			strings.Contains(run.completions[0].Error, "exited during this turn"), "completions %+v", run.completions)
		asked := realRequestsMatching(t, run.raw, "touch disconnected.txt")
		report.check("no-allow-reached-the-cli", len(asked) == 1 && (len(asked[0]) == 1 || asked[0][1] == "cancelled"), "requests %q", asked)
		var result map[string]interface{}
		if len(run.cards) == 1 {
			result = cursorCardResult(run.cursorRun, "turn-1", run.cards[0])
		}
		report.check("withdrawn-card-not-run", result["content"] == cursorEndedBeforeApproval && result["isError"] == true,
			"the card's call settled %v", result)
		realNoRealCursorHome(report)
		r.save(t, "accept-edits-disconnect", "session", run, report)
	})

	t.Run("auto", func(t *testing.T) {
		report := newRealReport(t)
		run := r.run(t, realScenario{name: "auto", mode: "auto", approve: deny, prompts: []string{
			"Run these two shell commands, one at a time, in this order, and do not retry a refused one or try another way:\n" +
				"1. touch auto-routine.txt\n" +
				"2. git push origin HEAD:refs/heads/p5c-probe\n" +
				"Then report what happened.",
		}})
		report.check("routine-command-ran-unasked", exists(filepath.Join(run.work, "auto-routine.txt")), "auto-routine.txt exists")
		routine := realRequestsMatching(t, run.raw, "touch auto-routine.txt")
		push := realRequestsMatching(t, run.raw, "git push")
		var cards []string
		for _, card := range run.cards {
			cards = append(cards, card.ToolName+" "+cardInput(card))
		}
		report.check("routine-allowed-by-orbit", len(routine) == 0 || (len(routine[0]) == 2 && routine[0][1] == cursorAllowOnce),
			"touch requests %q", routine)
		report.check("push-asked-and-refused", len(push) == 1 && len(push[0]) == 2 && push[0][1] == cursorRejectOnce &&
			len(cards) == 1 && strings.Contains(cards[0], "git push"), "push requests %q, cards %q", push, cards)
		realNoRealCursorHome(report)
		r.save(t, "auto", "session", run, report)
	})

	t.Run("dont-ask", func(t *testing.T) {
		report := newRealReport(t)
		run := r.run(t, realScenario{name: "dont-ask", mode: "dontAsk", approve: func(card cursorTestCard) cursorTestDecision {
			t.Errorf("Don't Ask filed a card: %+v", card)
			return cursorTestDecision{Status: "DENIED"}
		}, prompts: []string{
			"Do these three steps in order, one tool call each, and do not retry a refused one or try another way:\n" +
				"1. Run the shell command: touch dontask-cmd.txt\n" +
				"2. Use your file editing tool to create dontask-edit.txt in the current directory containing the word edit.\n" +
				"3. Call the task_get tool of the orbit MCP server with no arguments.\n" +
				"Then report which steps succeeded.",
		}})
		report.check("no-card", len(run.cards) == 0, "%d cards", len(run.cards))
		report.check("command-refused-unasked", !exists(filepath.Join(run.work, "dontask-cmd.txt")), "dontask-cmd.txt absent")
		cmd := realRequestsMatching(t, run.raw, "touch dontask-cmd.txt")
		report.check("command-answered-reject-once", len(cmd) == 1 && len(cmd[0]) == 2 && cmd[0][1] == cursorRejectOnce, "requests %q", cmd)
		report.facts["workspaceEditWritten"] = exists(filepath.Join(run.work, "dontask-edit.txt"))
		orbit := realRequestsMatching(t, run.raw, "task_get")
		report.check("orbit-tool-allowed", len(orbit) >= 1 && len(orbit[0]) == 2 && orbit[0][1] == cursorAllowOnce, "requests %q", orbit)
		realNoRealCursorHome(report)
		r.save(t, "dont-ask", "session", run, report)
	})

	t.Run("plan", func(t *testing.T) {
		report := newRealReport(t)
		run := r.run(t, realScenario{name: "plan", mode: "plan", approve: func(card cursorTestCard) cursorTestDecision {
			if card.ToolName == "ExitPlanMode" {
				return cursorTestDecision{Status: "ALLOWED"}
			}
			t.Errorf("Plan filed a card that is not its plan: %+v", card)
			return cursorTestDecision{Status: "DENIED"}
		}, prompts: []string{
			"Try these two steps now, one tool call each, and do not retry a refused one or try another way:\n" +
				"1. Run the shell command: touch plan-cmd.txt\n" +
				"2. Use your file editing tool to create plan-edit.txt containing the word edit.\n" +
				"Then write a short plan for adding a CONTRIBUTING.md file to this repository and submit it with your plan tool.",
		}})
		modes := []string{}
		for _, msg := range realCursorLines(t, run.raw, "stdin.jsonl") {
			if msg["method"] == "session/set_mode" {
				modes = append(modes, firstString(mapValue(msg["params"]), "modeId"))
			}
		}
		report.check("plan-mode-entered", len(modes) >= 1 && modes[0] == "plan", "set_mode %q", modes)
		report.check("command-refused-unasked", !exists(filepath.Join(run.work, "plan-cmd.txt")), "plan-cmd.txt absent")
		report.check("edit-not-written", !exists(filepath.Join(run.work, "plan-edit.txt")), "plan-edit.txt absent")
		cmd := realRequestsMatching(t, run.raw, "touch plan-cmd.txt")
		report.check("command-answered-reject-once", len(cmd) <= 1 && (len(cmd) == 0 || (len(cmd[0]) == 2 && cmd[0][1] == cursorRejectOnce)), "requests %q", cmd)
		answers, requests := answersTo(t, run.raw)
		var plans []string
		for id, msg := range requests {
			if msg["method"] == "cursor/create_plan" {
				for _, answer := range answers[id] {
					plans = append(plans, realOutcome(answer))
				}
			}
		}
		report.facts["createPlanAnswers"] = plans
		report.facts["planCards"] = len(run.cards)
		realNoRealCursorHome(report)
		r.save(t, "plan", "session", run, report)
	})

	t.Run("plan-switch-mode", func(t *testing.T) {
		report := newRealReport(t)
		run := r.run(t, realScenario{name: "plan-switch-mode", mode: "plan", approve: deny, prompts: []string{
			"Switch yourself to Agent mode now with your SwitchMode tool. Then use your file editing tool to create switched.txt containing the word switched.",
			"Run the shell command: touch plan-cmd-2.txt\nThen use your file editing tool to create switched-again.txt containing the word again. Do not retry a refused step or try another way.",
		}})
		report.check("plan-command-refused", !exists(filepath.Join(run.work, "plan-cmd-2.txt")), "plan-cmd-2.txt absent; requests %q",
			realRequestsTitled(t, run.raw, "`touch plan-cmd-2.txt`"))
		var notices []string
		for _, payload := range run.of("turn-1", evSystem) {
			if kind := asString(payload["noticeKind"]); kind != "" {
				notices = append(notices, kind)
			}
		}
		switchCards := 0
		for _, use := range run.of("turn-1", evToolUse) {
			if strings.HasPrefix(asString(use["name"]), "Switch Mode") {
				switchCards++
			}
		}
		report.facts["switchModeCards"] = switchCards
		report.facts["notices"] = notices
		report.check("nothing-written-outside-plan", !exists(filepath.Join(run.work, "switched.txt")) && !exists(filepath.Join(run.work, "switched-again.txt")),
			"switched.txt %v, switched-again.txt %v", exists(filepath.Join(run.work, "switched.txt")), exists(filepath.Join(run.work, "switched-again.txt")))
		modes := []string{}
		for _, msg := range realCursorLines(t, run.raw, "stdin.jsonl") {
			if msg["method"] == "session/set_mode" {
				modes = append(modes, firstString(mapValue(msg["params"]), "modeId"))
			}
		}
		report.facts["setModes"] = modes
		if switchCards > 0 {
			report.check("turn-stopped-on-switch", len(run.completions) >= 1 && run.completions[0].Status == stFailed &&
				strings.Contains(run.completions[0].Error, "switched itself out of Plan"), "completions %+v", run.completions)
			report.check("plan-mode-set-again", len(modes) >= 2 && modes[len(modes)-1] == "plan", "set_mode %q", modes)
		}
		realNoRealCursorHome(report)
		r.save(t, "plan-switch-mode", "session", run, report)
	})

	t.Run("plan-switch-mode-raw", func(t *testing.T) {
		// Cursor CLI's own behaviour when the model switches out of plan mode, with Orbit's stop out of the
		// way: the client declines every request (no bridge) and only watches (contract §4.2, §17.1 item 7).
		report := newRealReport(t)
		useCursorRealHome(t)
		raw := t.TempDir()
		work := filepath.Join(t.TempDir(), "work")
		_ = os.MkdirAll(work, 0o755)
		if out, err := exec.Command("git", "init", "-q", work).CombinedOutput(); err != nil {
			t.Fatalf("git init: %v %s", err, out)
		}
		self, _ := os.Executable()
		shim := filepath.Join(t.TempDir(), cursorEntryPoint)
		_ = os.WriteFile(shim, []byte("#!/bin/sh\nexport "+realCursorRecordEnv+"="+shellQuote(raw)+"\nexport "+realCursorExecEnv+"="+shellQuote(r.cli)+
			"\nexec "+shellQuote(self)+" \"$@\"\n"), 0o755)
		job := &ClaimedSession{SessionID: cursorTestSessionID, Agent: AgentExecConfig{PermissionMode: "plan", Env: map[string]string{"CURSOR_API_KEY": r.key}}}
		spec, err := prepareCursorLaunch(job, work, shim, filepath.Join(runDir(job.SessionID), "cursor"))
		if err != nil {
			t.Fatal(err)
		}
		var events cursorEvents
		mapper := newCursorEventMapper(events.emitFor)
		var mu sync.Mutex
		var switches []string
		mapper.onSwitchMode = func(_, title string) { mu.Lock(); switches = append(switches, title); mu.Unlock() }
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		app, err := startCursorACP(ctx, spec, mapper, nil, func(string, map[string]interface{}) {})
		if err != nil {
			t.Fatal(err)
		}
		defer app.dispose()
		if err := app.initialize(ctx); err != nil {
			t.Fatal(err)
		}
		id, err := app.open(ctx, work, []interface{}{})
		if err != nil {
			t.Fatal(err)
		}
		if err := app.enterMode(ctx, id, "plan"); err != nil {
			t.Fatal(err)
		}
		if err := mapper.begin("turn-1"); err != nil {
			t.Fatal(err)
		}
		r.charge(t, "plan-switch-mode-raw", "turn-1")
		result, err := app.prompt(ctx, id, []map[string]interface{}{{"type": "text", "text": "Switch yourself to Agent mode now with your " +
			"SwitchMode tool. Then use your file editing tool to create switched.txt containing the word switched. Do nothing else."}})
		request, _ := mapper.settle("turn-1", result, err)
		mu.Lock()
		report.facts["switchModeCards"] = switches
		mu.Unlock()
		report.facts["fileWritten"] = exists(filepath.Join(work, "switched.txt"))
		report.facts["turn"] = map[string]interface{}{"status": request.Status, "error": request.Error, "result": clip(request.Result, 500)}
		var tools []string
		for _, event := range events.snapshot() {
			if event.typ == evToolUse {
				tools = append(tools, asString(event.payload["name"]))
			}
		}
		report.facts["tools"] = tools
		report.facts["modeAfter"] = app.currentMode()
		app.dispose()
		run := realRun{cursorRun: cursorRun{job: job, spec: spec}, work: work, raw: raw}
		realNoRealCursorHome(report)
		r.save(t, "plan-switch-mode-raw", "acp", run, report)
	})

	t.Run("bypass", func(t *testing.T) {
		report := newRealReport(t)
		outside := filepath.Join(t.TempDir(), "outside")
		_ = os.MkdirAll(outside, 0o755)
		run := r.run(t, realScenario{name: "bypass", mode: "bypassPermissions", approve: deny, prompts: []string{
			"Do these two steps, one tool call each:\n1. Run the shell command: touch bypass-cmd.txt\n" +
				"2. Use your file editing tool to create the file " + filepath.Join(outside, "bypass-outside.txt") + " containing the word outside.",
		}})
		report.check("started-with-force", strings.Contains(strings.Join(run.spec.Args, " "), "--force --disable-project-configs"), "args %q", run.spec.Args)
		report.check("nothing-asked", realPermissionCount(t, run.raw) == 0 && len(run.cards) == 0, "%d requests, %d cards", realPermissionCount(t, run.raw), len(run.cards))
		report.check("command-ran", exists(filepath.Join(run.work, "bypass-cmd.txt")), "bypass-cmd.txt exists")
		report.facts["outsideWritten"] = exists(filepath.Join(outside, "bypass-outside.txt"))
		realNoRealCursorHome(report)
		r.save(t, "bypass", "session", run, report)
	})

	t.Run("malicious-repo", func(t *testing.T) {
		report := newRealReport(t)
		markers := filepath.Join(t.TempDir(), "markers")
		run := r.run(t, realScenario{name: "malicious-repo", mode: "acceptEdits", approve: deny,
			fixture: func(t *testing.T, work string) { copyCursorFixture(t, work, markers) },
			prompts: []string{
				"Do these steps in order, one tool call each, and do not retry a refused step or try another way:\n" +
					"1. Run the shell command: touch repo-allowed.txt (this repository's .cursor/cli.json allows it)\n" +
					"2. Read README.md, sub/note.txt and src/index.ts.\n" +
					"3. Use your file editing tool to change notes.txt so that it says edited.\n" +
					"Then report what happened.",
			}})
		report.check("project-configs-off", strings.Contains(strings.Join(run.spec.Args, " "), "--disable-project-configs"), "args %q", run.spec.Args)
		report.check("allowlisted-command-still-asked", len(realRequestsMatching(t, run.raw, "touch repo-allowed.txt")) == 1, "requests %q",
			realRequestsMatching(t, run.raw, "touch repo-allowed.txt"))
		report.check("refused-command-did-not-run", !exists(filepath.Join(run.work, "repo-allowed.txt")), "repo-allowed.txt absent")
		report.check("rule-command-did-not-run", !exists(filepath.Join(run.work, "rule-obeyed.txt")), "rule-obeyed.txt absent")
		report.check("nothing-of-the-repository-ran", len(cursorMarkers(t, markers)) == 0, "markers %q", cursorMarkers(t, markers))
		// Cursor CLI's own processes (its worker, its ripgrep) are the CLI; what must not run is anything
		// the repository supplies or a download it would run unasked.
		var strays []string
		for _, line := range run.processes {
			if strings.Contains(line, "mark.sh") || strings.Contains(line, "tsserver") || strings.Contains(line, "typescript-language-server") ||
				strings.Contains(line, "npx") || strings.Contains(line, "npm") || strings.Contains(line, "direnv") || strings.Contains(line, run.work) {
				strays = append(strays, line)
			}
		}
		report.check("no-unapproved-process", len(strays) == 0, "processes %q", strays)
		report.facts["processes"] = run.processes
		report.facts["notesEdited"] = func() bool {
			data, _ := os.ReadFile(filepath.Join(run.work, "notes.txt"))
			return strings.Contains(string(data), "edited")
		}()
		realNoRealCursorHome(report)
		r.save(t, "malicious-repo", "session", run, report)
	})

	t.Run("allow-always", func(t *testing.T) {
		report := newRealReport(t)
		n := 0
		run := r.run(t, realScenario{name: "allow-always", mode: "acceptEdits", approve: func(card cursorTestCard) cursorTestDecision {
			n++
			if n == 1 {
				return cursorTestDecision{Status: "ALLOWED", RememberRules: []PermissionRule{{ToolName: "Bash", RuleContent: "echo:*"}}}
			}
			return cursorTestDecision{Status: "ALLOWED"}
		}, prompts: []string{
			"Run these two shell commands, one at a time, in this order:\n1. echo first > always-1.txt\n2. echo second > always-2.txt\nThen reply done, and do nothing else.",
		}})
		first := realRequestsTitled(t, run.raw, "`echo first > always-1.txt`")
		second := realRequestsTitled(t, run.raw, "`echo second > always-2.txt`")
		report.check("always-answered-allow-once", len(first) == 1 && len(first[0]) == 2 && first[0][1] == cursorAllowOnce, "first %q", first)
		report.check("cursor-did-not-remember", len(second) == 1, "the second echo asked again: %q", second)
		data, _ := os.ReadFile(filepath.Join(run.spec.ConfigDir, "cli-config.json"))
		var config map[string]interface{}
		_ = json.Unmarshal(data, &config)
		allow := mapValue(config["permissions"])["allow"]
		report.check("session-allowlist-unchanged", cursorJSONEqual(t, allow, []interface{}{"Shell(ls)"}), "the session's cli-config allow = %v", allow)
		_, repoErr := os.Lstat(filepath.Join(run.work, ".cursor"))
		report.check("repository-untouched", os.IsNotExist(repoErr), "no .cursor in the checkout (%v)", repoErr)
		_, homeErr := os.Lstat(filepath.Join(os.Getenv("HOME"), ".cursor"))
		report.check("runner-home-untouched", os.IsNotExist(homeErr), "no .cursor in the runner user's HOME (%v)", homeErr)
		report.facts["configDir"] = run.spec.ConfigDir
		realNoRealCursorHome(report)
		r.save(t, "allow-always", "session", run, report)
	})
}
