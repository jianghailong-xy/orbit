package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// Under test the runner's own executable is this test binary, so the Orbit MCP entry a real dsh
// starts is `<test binary> mcp`. Serve it as the real `orbit mcp` when its ORBIT_HOME is a
// temporary control-plane double; anything else gets the tool list offline and can reach no
// control plane at all. TestMain's own stand-in (testOrbitMCPEnv) keeps precedence.
func init() {
	if len(os.Args) < 2 || os.Args[1] != "mcp" || os.Getenv(testOrbitMCPEnv) != "" {
		return
	}
	if home := os.Getenv("ORBIT_HOME"); home != "" && strings.HasPrefix(home, os.TempDir()) && loadConfig() != nil {
		cmdMcp()
	} else {
		(&mcpServer{t: NewTransport("http://127.0.0.1:1", ""), sessionID: os.Getenv("ORBIT_SESSION_ID")}).serve(os.Stdin, os.Stdout)
	}
	os.Exit(0)
}

func dshTestJob(mode string) *ClaimedSession {
	return &ClaimedSession{SessionID: "p4-orbit-session", AgentID: "p4-agent", TaskID: "p4-task", Provider: providerDsh,
		Agent: AgentExecConfig{Provider: providerDsh, PermissionMode: mode, Env: map[string]string{"ORBIT_DSH_API_KEY": "sk-p4-synthetic-key"}}}
}

func dshEnvValue(entry map[string]interface{}, key string) (string, bool) {
	for _, raw := range entry["env"].([]map[string]string) {
		if raw["name"] == key {
			return raw["value"], true
		}
	}
	return "", false
}

func TestDshMCPServers(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	auto, _ := dshPermissionPolicyFor("auto")
	ask, _ := dshPermissionPolicyFor("default")
	t.Run("orbit-server-and-session-identity", func(t *testing.T) {
		job := dshTestJob("default")
		job.AllowOrchestration, job.WikiDisabled, job.SpawnDepth = true, true, 2
		// The agent cannot replace Orbit's own server.
		job.Agent.McpConfig = map[string]interface{}{"orbit": map[string]interface{}{"command": "/bin/false"}}
		servers, err := dshMCPServers(job, ask)
		if err != nil || len(servers) != 1 {
			t.Fatalf("servers = %+v, %v", servers, err)
		}
		entry := servers[0].(map[string]interface{})
		command, args := dshOrbitMCPCommand()
		if entry["name"] != "orbit" || entry["command"] != command || strings.Join(entry["args"].([]string), " ") != strings.Join(args, " ") {
			t.Fatalf("orbit entry = %+v", entry)
		}
		if _, typed := entry["type"]; typed {
			t.Fatal("a stdio entry carries no type field (P0 mcp-stdio-injection)")
		}
		for key, want := range map[string]string{"ORBIT_SESSION_ID": publicID(job.SessionID), "ORBIT_AGENT_ID": "p4-agent",
			"ORBIT_TASK_ID": "p4-task", envMCPOrchestration: "1", envWiki: "off", envMCPPermissionPrompt: "0",
			envSpawnDepth: "2", "ORBIT_HOME": machineHome()} {
			if got, ok := dshEnvValue(entry, key); !ok || got != want {
				t.Fatalf("%s = %q (%v), want %q", key, got, ok, want)
			}
		}
		if _, ok := dshEnvValue(entry, "ORBIT_DSH_API_KEY"); ok {
			t.Fatal("the Harness key must not reach the MCP server")
		}
	})
	t.Run("sse-entry-refused-before-launch", func(t *testing.T) {
		job := dshTestJob("auto")
		job.Agent.McpConfig = map[string]interface{}{"remote": map[string]interface{}{"type": "sse", "url": "http://127.0.0.1:9/sse"}}
		if _, err := dshMCPServers(job, auto); err == nil || !strings.Contains(err.Error(), "DSH_MCP_UNSUPPORTED") || !strings.Contains(err.Error(), "dropped silently") {
			t.Fatalf("an SSE server dsh would drop must be refused: %v", err)
		}
	})
	t.Run("unverified-remote-refused", func(t *testing.T) {
		job := dshTestJob("auto")
		job.Agent.McpConfig = map[string]interface{}{"remote": map[string]interface{}{"type": "http", "url": "http://127.0.0.1:9/mcp"}}
		if _, err := dshMCPServers(job, auto); err == nil || !strings.Contains(err.Error(), "only stdio servers") {
			t.Fatalf("HTTP MCP is unverified and must be refused: %v", err)
		}
	})
	t.Run("relative-command-refused", func(t *testing.T) {
		job := dshTestJob("auto")
		job.Agent.McpConfig = map[string]interface{}{"local": map[string]interface{}{"command": "node"}}
		if _, err := dshMCPServers(job, auto); err == nil || !strings.Contains(err.Error(), "absolute command") {
			t.Fatalf("a relative command must be refused: %v", err)
		}
	})
	t.Run("third-party-server-only-where-unapproved-actions-run", func(t *testing.T) {
		for _, mode := range []string{"default", "dontAsk", "auto"} {
			policy, _ := dshPermissionPolicyFor(mode)
			job := dshTestJob(mode)
			job.Agent.McpConfig = map[string]interface{}{"local": map[string]interface{}{"command": "/usr/bin/env",
				"args": []interface{}{"node", "server.mjs"}, "env": map[string]interface{}{"TOKEN": "x"}}}
			servers, err := dshMCPServers(job, policy)
			if mode != "auto" {
				if err == nil || !strings.Contains(err.Error(), "DSH_MCP_UNENFORCEABLE") {
					t.Fatalf("%s: a server whose tools act unasked must be refused: %v", mode, err)
				}
				continue
			}
			if err != nil || len(servers) != 2 {
				t.Fatalf("auto: %+v, %v", servers, err)
			}
			local := servers[1].(map[string]interface{})
			if local["command"] != "/usr/bin/env" || strings.Join(local["args"].([]string), " ") != "node server.mjs" {
				t.Fatalf("local entry = %+v", local)
			}
			if value, _ := dshEnvValue(local, "TOKEN"); value != "x" {
				t.Fatalf("local env = %+v", local["env"])
			}
		}
	})
	t.Run("session-identity-is-not-the-agents-to-set", func(t *testing.T) {
		job := dshTestJob("auto")
		job.Agent.McpConfig = map[string]interface{}{"local": map[string]interface{}{"command": "/bin/true",
			"env": map[string]interface{}{"ORBIT_SESSION_ID": "someone-else"}}}
		if _, err := dshMCPServers(job, auto); err == nil || !strings.Contains(err.Error(), "ORBIT_SESSION_ID") {
			t.Fatalf("a server claiming another session must be refused: %v", err)
		}
	})
}

func TestDshToolPolicy(t *testing.T) {
	if err := dshToolPolicyError(AgentExecConfig{AllowedTools: []string{"mcp__orbit__*", "Bash(git status)"}}); err != nil {
		t.Fatalf("allowedTools only pre-approve and are accepted: %v", err)
	}
	err := dshToolPolicyError(AgentExecConfig{DisallowedTools: []string{"Bash"}})
	if err == nil || !strings.Contains(err.Error(), "DSH_TOOL_POLICY_UNSUPPORTED") {
		t.Fatalf("a denylist dsh cannot enforce must be refused: %v", err)
	}
	// Refused at session start, before any process or model request.
	h := newDshRealHarness(t, "default", false)
	h.job.Agent.DisallowedTools = []string{"Bash"}
	status, ended := h.runToEnd()
	if status != stFailed || !ended || h.launched() || h.model.count() != 0 || !h.hasError("DSH_TOOL_POLICY_UNSUPPORTED") {
		t.Fatalf("denylist session = %s ended=%v launched=%v model=%d events=%v", status, ended, h.launched(), h.model.count(), h.events.snapshot())
	}
}

func TestDshAgentOverlay(t *testing.T) {
	exe := testDshExecutable(t)
	work := t.TempDir()
	input := DshLaunchInput{OrbitSessionID: "overlay-session", ExecutionDir: work, APIKey: "sk-overlay", BaseURL: "http://127.0.0.1:9", FileMode: "read-only"}
	probe, err := prepareDshConfigAt(input, exe, filepath.Join(t.TempDir(), "probe"))
	if err != nil || len(probe.Args) != 4 {
		t.Fatalf("a catalogue probe keeps the single provider overlay: %+v, %v", probe.Args, err)
	}
	home := filepath.Join(t.TempDir(), "home")
	text := "P4 literal {{not_a_template}}"
	spec, err := prepareDshAgentConfigAt(input, &DshAgentOverlay{AppendSystemPrompt: text}, exe, home)
	if err != nil || len(spec.Args) != 6 || spec.Args[4] != "--patch" {
		t.Fatalf("session launch args = %+v, %v", spec.Args, err)
	}
	var rows []map[string]interface{}
	data, _ := os.ReadFile(spec.Args[5])
	if err := json.Unmarshal(data, &rows); err != nil {
		t.Fatal(err)
	}
	disabled := map[string]bool{}
	var insert map[string]interface{}
	for _, row := range rows {
		if row["disabled"] == true {
			disabled[row["id"].(string)] = true
		}
		if list, ok := row["insert"].([]interface{}); ok {
			insert = list[0].(map[string]interface{})
		}
	}
	for _, id := range dshDisabledAgentTools {
		if !disabled[id] {
			t.Fatalf("%s must be disabled: %s", id, data)
		}
	}
	if insert == nil || mapValue(insert["config"])["text"] != text || !strings.HasPrefix(insert["name"].(string), "file:///") {
		t.Fatalf("prompt section row = %+v", insert)
	}
	plugin := strings.TrimPrefix(insert["name"].(string), "file://")
	var manifest map[string]interface{}
	raw, _ := os.ReadFile(filepath.Join(filepath.Dir(plugin), "package.json"))
	if json.Unmarshal(raw, &manifest) != nil || manifest["name"] == "" || manifest["version"] != "1.0.0" {
		t.Fatalf("a named plugin package needs a version: %s", raw)
	}
	if source, _ := os.ReadFile(plugin); string(source) != dshAppendPromptPlugin || !strings.Contains(string(source), "interpolate: false") {
		t.Fatalf("plugin source = %s", source)
	}
	if !strings.Contains(strings.Join(spec.Env, "\n"), "DSH_AGENTS_HOME="+filepath.Join(spec.DshHome, "agents")) {
		t.Fatal("user-level ~/.agents skills must not leak into the session")
	}
	changed, err := prepareDshAgentConfigAt(input, &DshAgentOverlay{AppendSystemPrompt: text + " changed"}, exe, home)
	if err != nil || changed.ConfigHash == spec.ConfigHash {
		t.Fatalf("the hash must cover the agent overlay: %v", err)
	}
	job := dshTestJob("default")
	job.Agent.SystemPrompt, job.Agent.AppendSystemPrompt = "AGENT_SYSTEM", "AGENT_APPEND"
	overlay := dshSessionAgentOverlay(job)
	if !strings.HasPrefix(overlay.AppendSystemPrompt, "AGENT_SYSTEM\n\nAGENT_APPEND") {
		t.Fatalf("session overlay = %q", overlay.AppendSystemPrompt)
	}
}

// ---------------------------------------------------------------------------------------------
// Real dsh harness. The pinned official CLI (P4_DSH_BIN) runs through the production session
// loop against a scripted Messages endpoint and an isolated control-plane double; the Orbit MCP
// server it starts is this binary's real `orbit mcp`, pointed at that double.

type dshPlan struct {
	tool string
	args map[string]interface{}
	text string
	hold bool
}

type dshP4Model struct {
	mu       sync.Mutex
	key      string
	plans    []dshPlan
	requests []map[string]interface{}
	srv      *httptest.Server
}

func (m *dshP4Model) count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.requests)
}

func (m *dshP4Model) request(i int) map[string]interface{} {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.requests[i]
}

func (m *dshP4Model) serve(w http.ResponseWriter, r *http.Request) {
	var body map[string]interface{}
	if r.Method != "POST" || r.URL.Path != "/v1/messages" || r.Header.Get("x-api-key") != m.key || json.NewDecoder(r.Body).Decode(&body) != nil {
		http.Error(w, `{"error":{"message":"unexpected synthetic request"}}`, http.StatusBadRequest)
		return
	}
	m.mu.Lock()
	m.requests = append(m.requests, body)
	call := len(m.requests)
	plan := dshPlan{text: "P4 default answer"}
	if len(m.plans) > 0 {
		plan, m.plans = m.plans[0], m.plans[1:]
	}
	m.mu.Unlock()
	w.Header().Set("Content-Type", "text/event-stream")
	send := func(events ...map[string]interface{}) {
		for _, event := range events {
			data, _ := json.Marshal(event)
			fmt.Fprintf(w, "data: %s\n\n", data)
		}
		w.(http.Flusher).Flush()
	}
	send(map[string]interface{}{"type": "message_start", "message": map[string]interface{}{"id": fmt.Sprintf("msg_p4_%d", call), "type": "message",
		"role": "assistant", "model": body["model"], "content": []interface{}{}, "usage": map[string]interface{}{"input_tokens": 16, "output_tokens": 0}}})
	stop := "end_turn"
	if plan.tool != "" {
		input, _ := json.Marshal(plan.args)
		send(map[string]interface{}{"type": "content_block_start", "index": 0, "content_block": map[string]interface{}{"type": "tool_use", "id": fmt.Sprintf("call_p4_%d", call), "name": plan.tool, "input": map[string]interface{}{}}},
			map[string]interface{}{"type": "content_block_delta", "index": 0, "delta": map[string]interface{}{"type": "input_json_delta", "partial_json": string(input)}},
			map[string]interface{}{"type": "content_block_stop", "index": 0})
		stop = "tool_use"
	} else {
		send(map[string]interface{}{"type": "content_block_start", "index": 0, "content_block": map[string]interface{}{"type": "text", "text": ""}},
			map[string]interface{}{"type": "content_block_delta", "index": 0, "delta": map[string]interface{}{"type": "text_delta", "text": plan.text}})
		if plan.hold {
			<-r.Context().Done()
			return
		}
		send(map[string]interface{}{"type": "content_block_stop", "index": 0})
	}
	send(map[string]interface{}{"type": "message_delta", "delta": map[string]interface{}{"stop_reason": stop}, "usage": map[string]interface{}{"output_tokens": 4}},
		map[string]interface{}{"type": "message_stop"})
}

// dshApproval is one approval card the double holds, decided by the scenario.
type dshApproval struct {
	ID       string
	Body     map[string]interface{}
	Status   string
	Polls    int
	LatePoll bool // polled after the scenario settled the turn
}

type dshCPRequest struct {
	Method, Path string
	Header       http.Header
	Body         map[string]interface{}
}

type dshControlPlane struct {
	mu        sync.Mutex
	inbox     chan RunInboxResponse
	approvals []*dshApproval
	requests  []dshCPRequest
	autoAllow map[string]bool // card tool names the double answers itself (Orbit MCP's own create card)
	settled   bool
	srv       *httptest.Server
}

func (cp *dshControlPlane) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	var body map[string]interface{}
	if r.Body != nil {
		data, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(data, &body)
	}
	path := r.URL.Path
	cp.mu.Lock()
	if !strings.HasSuffix(path, "/inbox") {
		cp.requests = append(cp.requests, dshCPRequest{r.Method, path, r.Header.Clone(), body})
	}
	cp.mu.Unlock()
	switch {
	case strings.HasSuffix(path, "/inbox"):
		select {
		case turn := <-cp.inbox:
			_ = json.NewEncoder(w).Encode(turn)
		case <-time.After(200 * time.Millisecond):
			_ = json.NewEncoder(w).Encode(RunInboxResponse{})
		case <-r.Context().Done():
		}
	case r.Method == "POST" && strings.HasSuffix(path, "/approvals"):
		cp.mu.Lock()
		card := &dshApproval{ID: fmt.Sprintf("approval-%d", len(cp.approvals)+1), Body: body, Status: "PENDING"}
		if cp.autoAllow[firstString(body, "toolName")] {
			card.Status = "ALLOWED"
		}
		cp.approvals = append(cp.approvals, card)
		cp.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"id": card.ID, "status": "PENDING"})
	case r.Method == "GET" && strings.Contains(path, "/approvals/"):
		id := path[strings.LastIndex(path, "/")+1:]
		deadline := time.Now().Add(time.Second)
		for {
			cp.mu.Lock()
			var card *dshApproval
			for _, c := range cp.approvals {
				if c.ID == id {
					card = c
				}
			}
			if card == nil {
				cp.mu.Unlock()
				http.NotFound(w, r)
				return
			}
			card.Polls++
			card.LatePoll = card.LatePoll || cp.settled
			status := card.Status
			cp.mu.Unlock()
			if status != "PENDING" || time.Now().After(deadline) {
				_ = json.NewEncoder(w).Encode(map[string]interface{}{"id": id, "status": status})
				return
			}
			select {
			case <-time.After(20 * time.Millisecond):
			case <-r.Context().Done():
				return
			}
		}
	case r.Method == "POST" && path == "/api/runner/tasks":
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"id": "p4-double-task", "title": body["title"]})
	case r.Method == "POST" && strings.HasSuffix(path, "/comments"):
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"id": "p4-double-comment"})
	case strings.HasSuffix(path, "/diff"):
		_, _ = w.Write([]byte(`{}`))
	default:
		http.Error(w, `{"message":"not served by the P4 double"}`, http.StatusNotFound)
	}
}

func (cp *dshControlPlane) cards() []dshApproval {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	out := make([]dshApproval, len(cp.approvals))
	for i, c := range cp.approvals {
		out[i] = *c
	}
	return out
}

func (cp *dshControlPlane) decide(id, status string) {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	for _, c := range cp.approvals {
		if c.ID == id {
			c.Status = status
		}
	}
}

func (cp *dshControlPlane) seen(method, path string) []dshCPRequest {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	var out []dshCPRequest
	for _, r := range cp.requests {
		if r.Method == method && r.Path == path {
			out = append(out, r)
		}
	}
	return out
}

type dshRealHarness struct {
	t           *testing.T
	job         *ClaimedSession
	work, home  string
	model       *dshP4Model
	cp          *dshControlPlane
	events      *dshProcessEvents
	completions chan TurnCompleteRequest
	spec        *DshLaunchSpec
	ctx         context.Context
	cancel      context.CancelFunc
	done        chan struct{}
	status      string
	ended       bool
	mu          sync.Mutex
	turn        string
	prepares    int
}

// newDshRealHarness prepares a session through the production preparer and agent overlay. With
// real=false nothing may launch; the binary path then only satisfies the preparer.
func newDshRealHarness(t *testing.T, mode string, real bool) *dshRealHarness {
	t.Helper()
	executable := os.Getenv("P4_DSH_BIN")
	if real && !filepath.IsAbs(executable) {
		t.Skip("P4_DSH_BIN must name the pinned official dsh; run scripts/test-dsh-mcp-approval.sh")
	}
	if !real {
		executable = testDshExecutable(t)
	}
	for _, key := range []string{"ORBIT_SERVICE_TOKEN", "ORBIT_SESSION_ID", "ORBIT_AGENT_ID", "ORBIT_TASK_ID"} {
		t.Setenv(key, "")
	}
	dir := t.TempDir()
	orbitHome := filepath.Join(dir, "orbit-home")
	h := &dshRealHarness{t: t, job: dshTestJob(mode), work: filepath.Join(dir, "work"), home: filepath.Join(dir, "dsh-home"),
		events: &dshProcessEvents{}, completions: make(chan TurnCompleteRequest, 8), done: make(chan struct{})}
	h.job.Agent.Model, h.job.Agent.Effort = "deepseek-v4-pro", "low"
	for _, path := range []string{h.work, orbitHome} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	h.model = &dshP4Model{key: h.job.Agent.Env["ORBIT_DSH_API_KEY"]}
	h.model.srv = httptest.NewServer(http.HandlerFunc(h.model.serve))
	t.Cleanup(h.model.srv.Close)
	h.cp = &dshControlPlane{inbox: make(chan RunInboxResponse, 8), autoAllow: map[string]bool{}}
	h.cp.srv = httptest.NewServer(http.HandlerFunc(h.cp.serve))
	t.Cleanup(h.cp.srv.Close)
	// The isolated config `orbit mcp` authenticates with: every call it makes reaches the double.
	config, _ := json.Marshal(RunnerConfig{ServerURL: h.cp.srv.URL, RunnerID: "p4-runner", RunnerToken: "p4-synthetic-runner-token"})
	if err := os.WriteFile(filepath.Join(orbitHome, "config.json"), config, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ORBIT_HOME", orbitHome)
	h.job.Agent.Env["ORBIT_DSH_BASE_URL"] = h.model.srv.URL
	previous := prepareDshSessionLaunch
	prepareDshSessionLaunch = func(ctx context.Context, job *ClaimedSession, execDir string) (DshLaunchSpec, error) {
		h.mu.Lock()
		h.prepares++
		h.mu.Unlock()
		return prepareDshAgentConfigAt(DshLaunchInput{OrbitSessionID: job.SessionID, ExecutionDir: execDir,
			APIKey: job.Agent.Env["ORBIT_DSH_API_KEY"], BaseURL: job.Agent.Env["ORBIT_DSH_BASE_URL"],
			FileMode: dshFileModeForPermission(job.Agent.PermissionMode)}, dshSessionAgentOverlay(job), executable, h.home)
	}
	t.Cleanup(func() { prepareDshSessionLaunch = previous })
	h.ctx, h.cancel = context.WithTimeout(context.Background(), 3*time.Minute)
	t.Cleanup(h.cancel)
	return h
}

func (h *dshRealHarness) launched() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.prepares > 0
}

func (h *dshRealHarness) start() {
	p := sessionProcessArgs{
		ctx: h.ctx, shutdownCtx: h.ctx, t: NewTransport(h.cp.srv.URL, "p4-synthetic-runner-token"), job: h.job,
		execDir: h.work, scratchDir: h.t.TempDir(),
		emit: func(kind string, payload map[string]interface{}) {
			h.mu.Lock()
			turn := h.turn
			h.mu.Unlock()
			h.events.emit(turn, kind, payload)
		},
		emitFor: h.events.emit,
		setTurn: func(id string) { h.mu.Lock(); h.turn = id; h.mu.Unlock() },
		completeTurn: func(req TurnCompleteRequest, _ ...context.Context) error {
			h.completions <- req
			return nil
		},
		waitTurnPermit: func(context.Context) bool { return true },
		onLeaseLost:    func(err error) { h.t.Errorf("unexpected lease loss: %v", err) },
	}
	go func() {
		defer close(h.done)
		h.status, h.ended, _ = providerRuntimeFor(runtimeProvider(h.job)).run(p)
	}()
	h.t.Cleanup(func() {
		h.cancel()
		select {
		case <-h.done:
		case <-time.After(20 * time.Second):
			h.t.Error("dsh session loop did not stop")
		}
	})
}

func (h *dshRealHarness) runToEnd() (string, bool) {
	h.start()
	select {
	case <-h.done:
	case <-time.After(30 * time.Second):
		h.t.Fatal("session loop did not return")
	}
	return h.status, h.ended
}

func (h *dshRealHarness) send(turnID, kind, content string) {
	h.cp.inbox <- RunInboxResponse{TurnID: turnID, Kind: kind, Content: content}
}

func (h *dshRealHarness) settled(turnID string) TurnCompleteRequest {
	h.t.Helper()
	select {
	case req := <-h.completions:
		if req.TurnID != turnID {
			h.t.Fatalf("settled %s while waiting for %s", req.TurnID, turnID)
		}
		h.cp.mu.Lock()
		h.cp.settled = true
		h.cp.mu.Unlock()
		h.t.Logf("turn %s settled %s/%s result=%q error=%q", req.TurnID, req.Status, req.Subtype, req.Result, req.Error)
		return req
	case <-h.done:
		h.t.Fatalf("session loop ended (%s) before %s settled: %+v", h.status, turnID, h.events.snapshot())
	case <-h.ctx.Done():
		h.t.Fatalf("turn %s never settled", turnID)
	}
	return TurnCompleteRequest{}
}

func (h *dshRealHarness) waitCard(n int) dshApproval {
	h.t.Helper()
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		if cards := h.cp.cards(); len(cards) >= n {
			return cards[n-1]
		}
		time.Sleep(20 * time.Millisecond)
	}
	h.t.Fatalf("approval card %d never arrived: events=%+v", n, h.events.snapshot())
	return dshApproval{}
}

func (h *dshRealHarness) end() {
	h.send("end", "end", "")
	select {
	case <-h.done:
	case <-h.ctx.Done():
		h.t.Fatal("session did not end")
	}
}

func (h *dshRealHarness) hasError(fragment string) bool {
	for _, event := range h.events.snapshot() {
		if event.typ == evError && strings.Contains(firstString(event.payload, "message"), fragment) {
			return true
		}
	}
	return false
}

func (h *dshRealHarness) tools(turnID string) (uses, results map[string]map[string]interface{}) {
	uses, results = map[string]map[string]interface{}{}, map[string]map[string]interface{}{}
	for _, event := range h.events.snapshot() {
		if event.turn != turnID {
			continue
		}
		switch event.typ {
		case evToolUse:
			uses[firstString(event.payload, "toolCallId")] = event.payload
		case evToolResult:
			results[firstString(event.payload, "toolCallId")] = event.payload
		}
	}
	return uses, results
}

// toolResult finds the one call of a named tool and its terminal result.
func (h *dshRealHarness) toolResult(turnID, name string) (map[string]interface{}, map[string]interface{}) {
	h.t.Helper()
	uses, results := h.tools(turnID)
	for id, use := range uses {
		if use["name"] == name {
			return use, results[id]
		}
	}
	h.t.Fatalf("turn %s has no %s tool call: %+v", turnID, name, uses)
	return nil, nil
}

func (h *dshRealHarness) notes(subtype string) []map[string]interface{} {
	var out []map[string]interface{}
	for _, event := range h.events.snapshot() {
		if event.typ == evSystem && event.payload["subtype"] == subtype {
			out = append(out, event.payload)
		}
	}
	return out
}

// kill ends the dsh process abruptly, the way a crashed engine or a lost pipe ends a connection.
func (h *dshRealHarness) kill() {
	h.t.Helper()
	patch := filepath.Join(h.home, "orbit.patch.json")
	entries, _ := os.ReadDir("/proc")
	killed := 0
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		cmdline, _ := os.ReadFile(filepath.Join("/proc", entry.Name(), "cmdline"))
		if strings.Contains(string(cmdline), patch) && pid != os.Getpid() {
			if syscall.Kill(pid, syscall.SIGKILL) == nil {
				killed++
			}
		}
	}
	if killed == 0 {
		h.t.Fatal("no dsh process found to disconnect")
	}
}

func (h *dshRealHarness) writeWorkspace(rel, content string) {
	path := filepath.Join(h.work, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		h.t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		h.t.Fatal(err)
	}
}

func (h *dshRealHarness) evidence(name string, facts map[string]interface{}) {
	dir := os.Getenv("DSH_P4_EVIDENCE_DIR")
	if dir == "" {
		return
	}
	_ = os.MkdirAll(dir, 0o755)
	cards := h.cp.cards()
	var cp []map[string]interface{}
	h.cp.mu.Lock()
	for _, r := range h.cp.requests {
		if strings.HasSuffix(r.Path, "/diff") {
			continue
		}
		cp = append(cp, map[string]interface{}{"method": r.Method, "path": r.Path, "agent": r.Header.Get("X-Orbit-Agent-Id"),
			"session": r.Header.Get("X-Orbit-Session-Id"), "body": r.Body})
	}
	h.cp.mu.Unlock()
	var events []map[string]interface{}
	for _, e := range h.events.snapshot() {
		events = append(events, map[string]interface{}{"turn": e.turn, "type": e.typ, "payload": e.payload})
	}
	data, _ := json.MarshalIndent(map[string]interface{}{"scenario": name, "permissionMode": h.job.Agent.PermissionMode,
		"modelRequests": h.model.count(), "approvalCards": cards, "controlPlane": cp, "orbitEvents": events, "facts": facts}, "", "  ")
	_ = os.WriteFile(filepath.Join(dir, strings.ReplaceAll(name, "/", "_")+".json"), data, 0o644)
}

func dshRequestText(body map[string]interface{}, field string) string {
	data, _ := json.Marshal(body[field])
	return string(data)
}

func dshToolNames(body map[string]interface{}) map[string]bool {
	names := map[string]bool{}
	tools, _ := body["tools"].([]interface{})
	for _, raw := range tools {
		names[firstString(mapValue(raw), "name")] = true
	}
	return names
}

// TestDshRealOrbitMCPAndAgentInstructions: the real dsh mounts Orbit's MCP server with the
// session's identity, its side-effecting calls reach only the control-plane double, the agent
// prompt is an additive literal section beside Harness's own, and the workspace AGENTS.md and a
// project skill are discovered while subagent tools are gone.
func TestDshRealOrbitMCPAndAgentInstructions(t *testing.T) {
	h := newDshRealHarness(t, "default", true)
	h.job.Agent.AppendSystemPrompt = "P4_ORBIT_APPEND {{p4_literal_braces}}"
	h.writeWorkspace("AGENTS.md", "P4_WORKSPACE_AGENTS_MARKER: keep every effect synthetic.\n")
	h.writeWorkspace(".agents/skills/p4-skill/SKILL.md", "---\nname: p4-skill\ndescription: P4_PROJECT_SKILL_MARKER synthetic skill\n---\nP4 skill body\n")
	h.writeWorkspace(".dsh/skills/p4-dsh-skill/SKILL.md", "---\nname: p4-dsh-skill\ndescription: P4_DSH_SKILL_MARKER synthetic skill\n---\nP4 dsh skill body\n")
	if err := os.MkdirAll(filepath.Join(h.work, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	// Orbit MCP's own create card is the double's to answer, as the owner would in the app.
	h.cp.autoAllow["orbit_task_create"] = true
	h.model.plans = []dshPlan{
		{tool: "mcp__orbit__task_create", args: map[string]interface{}{"title": "P4 isolated task", "description": "synthetic",
			"completionCriterion": "EVIDENCE_JUDGMENT", "acceptanceCriteria": "synthetic"}},
		{tool: "mcp__orbit__task_comment", args: map[string]interface{}{"body": "P4 synthetic comment"}},
		{tool: "subagent", args: map[string]interface{}{"description": "delegate", "prompt": "write a file", "run_in_background": false}},
		{text: "P4 Orbit MCP answer"},
	}
	h.start()
	h.send("t1", "message", "Use Orbit MCP to file and comment.")
	done := h.settled("t1")
	if done.Status != stSucceeded || done.Result != "P4 Orbit MCP answer" {
		t.Fatalf("turn = %+v", done)
	}
	first := h.model.request(0)
	system, messages := dshRequestText(first, "system"), dshRequestText(first, "messages")
	for _, want := range []string{"You are an AI agent powered by DeepSeek Harness.", "Check the [exit code: N] marker", "P4_ORBIT_APPEND {{p4_literal_braces}}"} {
		if !strings.Contains(system, want) {
			t.Fatalf("system prompt lacks %q", want)
		}
	}
	for _, want := range []string{"P4_WORKSPACE_AGENTS_MARKER", "P4_PROJECT_SKILL_MARKER", "P4_DSH_SKILL_MARKER"} {
		if !strings.Contains(messages, want) {
			t.Fatalf("workspace instructions/skills lack %q", want)
		}
	}
	names := dshToolNames(first)
	for _, want := range []string{"mcp__orbit__task_create", "mcp__orbit__task_comment", "skill", "bash", "write"} {
		if !names[want] {
			t.Fatalf("model tools lack %s: %v", want, names)
		}
	}
	for _, gone := range []string{"subagent", "subagent_fork", "workflow", "send_message", "list_agents", "mcp__orbit__permission_prompt"} {
		if names[gone] {
			t.Fatalf("model tools still offer %s", gone)
		}
	}
	created := h.cp.seen("POST", "/api/runner/tasks")
	if len(created) != 1 || created[0].Header.Get("X-Orbit-Agent-Id") != "p4-agent" || created[0].Body["title"] != "P4 isolated task" {
		t.Fatalf("task_create reached the double as %+v", created)
	}
	comments := h.cp.seen("POST", "/api/runner/tasks/p4-task/comments")
	if len(comments) != 1 || comments[0].Header.Get("X-Orbit-Agent-Id") != "p4-agent" {
		t.Fatalf("task_comment reached the double as %+v", comments)
	}
	cards := h.cp.cards()
	if len(cards) != 1 || cards[0].Body["toolName"] != "orbit_task_create" {
		t.Fatalf("only Orbit MCP's own create card may be filed; dsh asks nothing about MCP: %+v", cards)
	}
	use, result := h.toolResult("t1", "mcp__orbit__task_create")
	if use["mcpServer"] != "orbit" || use["mcpTool"] != "task_create" || mapValue(use["input"])["title"] != "P4 isolated task" ||
		result["status"] != "completed" || !strings.Contains(firstString(result, "content"), "p4-double-task") {
		t.Fatalf("Orbit tool events = %+v / %+v", use, result)
	}
	_, comment := h.toolResult("t1", "mcp__orbit__task_comment")
	if comment["status"] != "completed" {
		t.Fatalf("comment result = %+v", comment)
	}
	_, delegated := h.toolResult("t1", "subagent")
	if delegated["status"] != "failed" || len(h.notes("permission_denied")) != 0 {
		t.Fatalf("a disabled subagent tool must fail without spawning: %+v", delegated)
	}
	h.end()
	h.evidence(t.Name(), map[string]interface{}{"systemHasHarnessIdentity": true, "literalAppend": "P4_ORBIT_APPEND {{p4_literal_braces}}",
		"agentsAndSkillsInContext": true, "tools": names, "tasksCreatedOnDouble": len(created), "commentsOnDouble": len(comments)})
}

// TestDshRealThirdPartyMCPRunsUnasked: a stdio server the agent configures is mounted only in
// Auto, where it acts without any approval request even though it declares itself destructive.
func TestDshRealThirdPartyMCPRunsUnasked(t *testing.T) {
	node := os.Getenv("P4_NODE_BIN")
	if !filepath.IsAbs(node) {
		t.Skip("P4_NODE_BIN must name node; run scripts/test-dsh-mcp-approval.sh")
	}
	server, err := filepath.Abs("../../scripts/deepseek-harness-p0/mock-mcp.mjs")
	if err != nil {
		t.Fatal(err)
	}
	h := newDshRealHarness(t, "auto", true)
	log := filepath.Join(t.TempDir(), "third-party-mcp.ndjson")
	h.job.Agent.McpConfig = map[string]interface{}{"thirdparty": map[string]interface{}{"command": node, "args": []interface{}{server},
		"env": map[string]interface{}{"P0_MCP_LOG": log}}}
	h.model.plans = []dshPlan{{tool: "mcp__thirdparty__record", args: map[string]interface{}{"value": "p4-third-party-effect"}}, {text: "P4 third-party answer"}}
	h.start()
	h.send("t1", "message", "Call the third-party MCP tool.")
	if done := h.settled("t1"); done.Status != stSucceeded {
		t.Fatalf("turn = %+v", done)
	}
	data, _ := os.ReadFile(log)
	if !strings.Contains(string(data), `"effect":"p4-third-party-effect"`) {
		t.Fatalf("third-party MCP side effect = %s", data)
	}
	if cards := h.cp.cards(); len(cards) != 0 {
		t.Fatalf("dsh never asks before MCP tools, annotations notwithstanding: %+v", cards)
	}
	_, result := h.toolResult("t1", "mcp__thirdparty__record")
	if result["status"] != "completed" {
		t.Fatalf("result = %+v", result)
	}
	h.end()
	h.evidence(t.Name(), map[string]interface{}{"sideEffect": true, "approvalRequests": 0})
}
