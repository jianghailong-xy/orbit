//go:build dsh_integration && !windows

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// This mandatory acceptance scenario enters through runtime dispatch and uses the
// fixed official CLI against synthetic local model replies; it never uses real keys.
func TestDshACPRealRunnerMultiTurn(t *testing.T) {
	executable, node := os.Getenv("P3A_DSH_BIN"), os.Getenv("P3A_NODE_BIN")
	if !filepath.IsAbs(executable) || !filepath.IsAbs(node) {
		t.Fatal("P3A_DSH_BIN and P3A_NODE_BIN must name absolute executables; run scripts/test-dsh-acp-driver.sh")
	}
	t.Setenv("ORBIT_SERVICE_TOKEN", "")
	t.Setenv("ORBIT_SESSION_ID", "")
	t.Setenv("ORBIT_AGENT_ID", "")
	t.Setenv("ORBIT_TASK_ID", "")
	t.Setenv("ORBIT_ALLOW_ORCHESTRATION", "0")
	dir := t.TempDir()
	work, scratch, home := filepath.Join(dir, "work"), filepath.Join(dir, "scratch"), filepath.Join(dir, "dsh-home")
	for _, path := range []string{work, scratch, home} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	env := []string{"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME"), "DSH_HOME=" + home, "DSH_TELEMETRY_DISABLED=1", "DSH_PERMISSION_MODE=workspace-write", "ORBIT_DSH_API_KEY=sk-p3a-synthetic", "NO_PROXY=127.0.0.1,localhost"}
	versionCmd := exec.CommandContext(ctx, executable, "--version")
	versionCmd.Env = env
	version, err := versionCmd.CombinedOutput()
	if err != nil || strings.TrimSpace(string(version)) != dshSupportedVersion {
		t.Fatalf("real dsh --version = %q (%v), want %s", version, err, dshSupportedVersion)
	}
	t.Logf("CLI identity: executable=%s version=%s", executable, strings.TrimSpace(string(version)))
	requestLog, writtenFile := filepath.Join(dir, "model-requests.ndjson"), filepath.Join(work, "written.txt")
	mockScript, err := filepath.Abs("../../scripts/deepseek-harness-p3a/mock-model.mjs")
	if err != nil {
		t.Fatal(err)
	}
	mock := exec.CommandContext(ctx, node, mockScript, requestLog, writtenFile)
	mock.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME")}
	stdout, err := mock.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	mock.Stderr = os.Stderr
	if err := mock.Start(); err != nil {
		t.Fatalf("start synthetic Messages endpoint: %v", err)
	}
	t.Cleanup(func() { _ = mock.Process.Kill(); _ = mock.Wait() })
	address := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		if scanner.Scan() {
			address <- scanner.Text()
		}
	}()
	var baseURL string
	select {
	case baseURL = <-address:
	case <-time.After(10 * time.Second):
		t.Fatal("synthetic Messages endpoint did not start")
	}
	patch := filepath.Join(home, "orbit.patch.json")
	patchData, _ := json.Marshal([]map[string]interface{}{{"id": "llm-deepseek", "config": map[string]interface{}{
		"baseURL": baseURL, "apiKeyEnv": "ORBIT_DSH_API_KEY", "retryPolicy": map[string]interface{}{"mode": "normal", "maxRetries": 0}, "streamIdleTimeoutMs": 5000,
	}}})
	if err := os.WriteFile(patch, patchData, 0o600); err != nil {
		t.Fatal(err)
	}
	spec := DshLaunchSpec{Executable: executable, Args: []string{"--profile", "acp", "--patch", patch}, Env: env, Cwd: work, DshHome: home, Version: dshSupportedVersion}
	inbox := make(chan RunInboxResponse, 8)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/inbox") {
			select {
			case turn := <-inbox:
				_ = json.NewEncoder(w).Encode(turn)
			case <-r.Context().Done():
			}
			return
		}
		if strings.HasSuffix(r.URL.Path, "/diff") {
			_, _ = w.Write([]byte(`{}`))
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(server.Close)
	job := &ClaimedSession{SessionID: "dsh-real-runner", Provider: providerDsh, Agent: AgentExecConfig{Provider: providerDsh, Model: "deepseek-v4-pro", Effort: "low"}}
	type event struct {
		turnID, kind string
		payload      map[string]interface{}
	}
	var mu sync.Mutex
	var events []event
	current := ""
	record := func(turnID, kind string, payload map[string]interface{}) {
		mu.Lock()
		defer mu.Unlock()
		events = append(events, event{turnID, kind, payload})
	}
	completions := make(chan TurnCompleteRequest, 8)
	runDone := make(chan struct{})
	var runStatus string
	var ended, reload bool
	p := sessionProcessArgs{
		ctx: ctx, shutdownCtx: ctx, t: NewTransport(server.URL, "synthetic-runner-token"), job: job,
		execDir: work, scratchDir: scratch, dshLaunchSpec: &spec,
		emit: func(kind string, payload map[string]interface{}) {
			mu.Lock()
			id := current
			mu.Unlock()
			record(id, kind, payload)
		},
		emitFor: record,
		setTurn: func(id string) { mu.Lock(); current = id; mu.Unlock() },
		completeTurn: func(req TurnCompleteRequest, _ ...context.Context) error {
			record(req.TurnID, "completion", map[string]interface{}{"status": req.Status, "runtimeSessionId": req.RuntimeSessionID})
			completions <- req
			return nil
		},
		waitTurnPermit: func(context.Context) bool { return true },
		onLeaseLost:    func(err error) { t.Errorf("unexpected lease loss: %v", err) },
	}
	runtime := providerRuntimeFor(runtimeProvider(job))
	if runtime.transport != transportJSONRPC || runtime.run == nil {
		t.Fatal("new dsh runtime entry is not an ACP driver")
	}
	go func() { defer close(runDone); runStatus, ended, reload = runtime.run(p) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-runDone:
		case <-time.After(15 * time.Second):
			t.Error("dsh runner did not stop after cancellation")
		}
	})
	waitCompletion := func(turnID string) TurnCompleteRequest {
		t.Helper()
		select {
		case req := <-completions:
			if req.TurnID != turnID {
				t.Fatalf("received completion for %s while waiting for %s", req.TurnID, turnID)
			}
			t.Logf("runner result: turn=%s status=%s ACP session=%s result=%q error=%q", req.TurnID, req.Status, req.RuntimeSessionID, req.Result, req.Error)
			return req
		case <-runDone:
			mu.Lock()
			defer mu.Unlock()
			t.Fatalf("runner stopped before %s: status=%s ended=%v reload=%v events=%v", turnID, runStatus, ended, reload, events)
		case <-ctx.Done():
			t.Fatalf("turn %s did not complete", turnID)
		}
		return TurnCompleteRequest{}
	}
	inbox <- RunInboxResponse{TurnID: "t1", Kind: "message", Content: "Remember P3A-WORD; give the first answer."}
	first := waitCompletion("t1")
	if first.Status != stSucceeded || first.Result != "P3A first committed answer" || first.RuntimeSessionID == "" {
		t.Fatalf("first real dsh turn = %+v", first)
	}
	meta := readSessionMeta(filepath.Join(scratch, "meta.json"))
	if meta == nil || meta.Provider != providerDsh || meta.RuntimeSessionID != first.RuntimeSessionID {
		t.Fatalf("persisted runtimeSessionId does not match the real ACP id: %+v", meta)
	}
	inbox <- RunInboxResponse{TurnID: "t2", Kind: "message", Content: "Write the synthetic file and remember P3A-WORD."}
	second := waitCompletion("t2")
	if second.Status != stSucceeded || second.Result != "P3A second answer after native write" || second.RuntimeSessionID != first.RuntimeSessionID {
		t.Fatalf("second real dsh turn = %+v; first = %+v", second, first)
	}
	if content, err := os.ReadFile(writtenFile); err != nil || string(content) != "P3A real dsh tool effect" {
		t.Fatalf("native dsh write effect = %q (%v)", content, err)
	}
	inbox <- RunInboxResponse{TurnID: "end", Kind: "end"}
	select {
	case <-runDone:
	case <-ctx.Done():
		t.Fatal("real dsh runner did not close")
	}
	if runStatus != stSucceeded || !ended || reload {
		t.Fatalf("real dsh close = %s ended=%v reload=%v", runStatus, ended, reload)
	}
	if len(completions) != 0 {
		t.Fatalf("duplicate turn settlement: %d extra completions", len(completions))
	}
	requests, err := os.ReadFile(requestLog)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(requests)), "\n")
	if len(lines) != 3 {
		t.Fatalf("real dsh made %d model requests, want first turn + native tool + tool follow-up", len(lines))
	}
	for i, line := range lines {
		var request struct {
			URL  string `json:"url"`
			Body struct {
				Model        string          `json:"model"`
				Messages     json.RawMessage `json:"messages"`
				OutputConfig struct {
					Effort string `json:"effort"`
				} `json:"output_config"`
			} `json:"body"`
		}
		if err := json.Unmarshal([]byte(line), &request); err != nil {
			t.Fatal(err)
		}
		if request.URL != "/v1/messages" || request.Body.Model != "deepseek-v4-pro" || request.Body.OutputConfig.Effort != "low" {
			t.Fatalf("model request %d did not use the configured model/effort: %s", i+1, line)
		}
		if i > 0 && (!strings.Contains(string(request.Body.Messages), "P3A-WORD") || !strings.Contains(string(request.Body.Messages), first.Result)) {
			t.Fatalf("multi-turn history missing from model request %d: %s", i+1, request.Body.Messages)
		}
		t.Logf("official Messages request: #%d model=%s effort=%s historyBytes=%d", i+1, request.Body.Model, request.Body.OutputConfig.Effort, len(request.Body.Messages))
	}
	mu.Lock()
	defer mu.Unlock()
	launches, inits := 0, 0
	for _, e := range events {
		if e.kind == evSystem && e.payload["subtype"] == "launch" {
			launches++
			if e.payload["provider"] != providerDsh || e.payload["executable"] != executable || e.payload["cliVersion"] != dshSupportedVersion {
				t.Fatalf("runner launch did not name the supported dsh: %v", e.payload)
			}
			t.Logf("runner launch: %v", e.payload)
		}
		if e.kind == evSystem && e.payload["subtype"] == "init" {
			inits++
			if e.payload["runtimeSessionId"] != first.RuntimeSessionID {
				t.Fatalf("runner initialized a different ACP session: %v", e.payload)
			}
		}
		if e.kind == evTextDelta || e.kind == evThinkingDelta {
			t.Fatalf("committed ACP messages presented as native token deltas: %v", e)
		}
	}
	if launches != 1 || inits != 1 {
		t.Fatalf("multi-turn must use one resident dsh: launches=%d inits=%d", launches, inits)
	}
	for _, id := range []string{"t1", "t2"} {
		counts := map[string]int{}
		settled := false
		toolID := ""
		for _, e := range events {
			if e.turnID != id {
				continue
			}
			counts[e.kind]++
			if e.kind == "completion" {
				settled = true
			}
			if e.kind == evAssistant || e.kind == evThinking || e.kind == evToolUse || e.kind == evToolResult || e.kind == evTurnEnd {
				if settled || e.payload["localTurnId"] != id || e.payload["runtimeSessionId"] != first.RuntimeSessionID {
					t.Fatalf("real ACP update misattributed or emitted after settlement: %+v", e)
				}
			}
			if e.kind == evToolUse {
				toolID = fmt.Sprint(e.payload["id"])
			}
			if e.kind == evToolResult && (toolID == "" || e.payload["toolUseId"] != toolID || e.payload["isError"] != false) {
				t.Fatalf("real native write result did not close its tool: %v", e.payload)
			}
			if e.kind == evTurnEnd {
				used, knownUsed := dshUsageCount(e.payload["contextTokens"])
				size, knownSize := dshUsageCount(e.payload["contextWindow"])
				if !knownUsed || !knownSize || used <= 0 || size != 1_000_000 {
					t.Fatalf("real ACP usage used/size missing at settlement: %v", e.payload)
				}
			}
		}
		if counts[evAssistant] != 1 || counts[evTurnEnd] != 1 || counts["completion"] != 1 {
			t.Fatalf("real turn %s did not settle once after its committed output: %v", id, counts)
		}
		if id == "t1" && counts[evThinking] != 1 {
			t.Fatalf("real committed thought missing: %v", counts)
		}
		if id == "t2" && (counts[evToolUse] != 1 || counts[evToolResult] != 1) {
			t.Fatalf("real native tool events missing: %v", counts)
		}
	}
}

// P3b with the official CLI: P2's real preparer and Seal, a runner restart that resumes the
// durable session, a cancel mid-stream, and a lease loss after a native tool ran. The local
// model records every request, so a replayed prompt or tool would show up as an extra call.
func TestDshLifecycleRealRestartCancelAndLeaseRecovery(t *testing.T) {
	executable, node := os.Getenv("P3A_DSH_BIN"), os.Getenv("P3A_NODE_BIN")
	if !filepath.IsAbs(executable) || !filepath.IsAbs(node) {
		t.Fatal("P3A_DSH_BIN and P3A_NODE_BIN must name absolute executables; run scripts/test-dsh-session-lifecycle.sh")
	}
	for _, name := range []string{"ORBIT_SERVICE_TOKEN", "ORBIT_SESSION_ID", "ORBIT_AGENT_ID", "ORBIT_TASK_ID"} {
		t.Setenv(name, "")
	}
	t.Setenv("NO_PROXY", "127.0.0.1,localhost")
	t.Setenv("no_proxy", "127.0.0.1,localhost")
	h := newLCHarness(t)
	priorPath := dshServicePath
	dshServicePath = func() string { return filepath.Dir(node) + ":/usr/bin:/bin" }
	t.Cleanup(func() { dshServicePath = priorPath })
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	requestLog, writtenFile := filepath.Join(h.dir, "model-requests.ndjson"), filepath.Join(h.work, "written.txt")
	mockScript, err := filepath.Abs("../../scripts/deepseek-harness-p3b/mock-model.mjs")
	if err != nil {
		t.Fatal(err)
	}
	mock := exec.CommandContext(ctx, node, mockScript, requestLog, writtenFile)
	mock.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME")}
	stdout, err := mock.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	mock.Stderr = os.Stderr
	if err := mock.Start(); err != nil {
		t.Fatalf("start synthetic Messages endpoint: %v", err)
	}
	t.Cleanup(func() { _ = mock.Process.Kill(); _ = mock.Wait() })
	address := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		if scanner.Scan() {
			address <- scanner.Text()
		}
	}()
	var baseURL string
	select {
	case baseURL = <-address:
	case <-time.After(10 * time.Second):
		t.Fatal("synthetic Messages endpoint did not start")
	}
	prepareDshSessionLaunch = func(ctx context.Context, job *ClaimedSession, execDir string) (DshLaunchSpec, error) {
		return prepareDshConfigAt(DshLaunchInput{OrbitSessionID: job.SessionID, ExecutionDir: execDir,
			APIKey: job.Agent.Env["ORBIT_DSH_API_KEY"], BaseURL: job.Agent.Env["ORBIT_DSH_BASE_URL"],
			FileMode: dshFileModeForPermission(job.Agent.PermissionMode)}, executable, h.home)
	}
	newJob := func(runtimeID string) *ClaimedSession {
		return &ClaimedSession{SessionID: "dsh-real-lifecycle", Provider: providerDsh, RuntimeSessionID: runtimeID,
			Agent: AgentExecConfig{Provider: providerDsh, Env: map[string]string{"ORBIT_DSH_API_KEY": "sk-p3b-synthetic", "ORBIT_DSH_BASE_URL": baseURL}}}
	}
	modelCalls := func() []map[string]interface{} {
		data, _ := os.ReadFile(requestLog)
		var calls []map[string]interface{}
		for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
			var call map[string]interface{}
			if json.Unmarshal([]byte(line), &call) == nil {
				calls = append(calls, call)
			}
		}
		return calls
	}
	history := func(call map[string]interface{}) string {
		data, _ := json.Marshal(mapValue(call["body"])["messages"])
		return string(data)
	}

	run := h.start(newJob(""))
	h.cp.add("t1", "message", "Remember P3B-WORD and answer.")
	first := h.settledOnce("t1", stSucceeded, "P3B first answer")
	runtimeID := first.RuntimeSessionID
	run.shutdown()
	run.wait(t)
	var owner dshConfigOwner
	if data, err := os.ReadFile(filepath.Join(h.home, "orbit-owner.json")); err != nil || json.Unmarshal(data, &owner) != nil || owner.ProfileHash == "" {
		t.Fatalf("the real profile was not sealed after initialize: %+v (%v)", owner, err)
	}
	t.Logf("runner restart: runtimeSessionId=%s sealed profile=%s", runtimeID, owner.ProfileHash)

	run = h.start(newJob(runtimeID))
	h.cp.add("t2", "message", "Hold this turn.")
	lcWaitFor(t, "held model stream", func() bool { return len(modelCalls()) == 2 })
	h.cp.add("i1", "interrupt", "")
	h.settledOnce("t2", stInterrupted, "")
	h.cp.add("t3", "message", "What was the word?")
	h.settledOnce("t3", stSucceeded, "P3B third answer")
	h.cp.add("t4", "message", "Write the file.")
	lcWaitFor(t, "native write then held follow-up", func() bool {
		_, err := os.Stat(writtenFile)
		return err == nil && len(modelCalls()) == 5
	})
	h.cp.setLeaseLost(true)
	run.wait(t)
	if run.leaseLost.Load() != 1 || len(h.cp.turn("t4").Completions) != 0 {
		t.Fatalf("lease loss: losses=%d t4=%+v", run.leaseLost.Load(), h.cp.turn("t4"))
	}
	time.Sleep(300 * time.Millisecond)
	if len(modelCalls()) != 5 {
		t.Fatal("the engine kept working after its lease was lost")
	}
	h.cp.setLeaseLost(false)
	run = h.start(newJob(runtimeID))
	h.cp.redeliver("t4")
	if c := h.settledOnce("t4", stInterrupted, ""); !strings.Contains(c.Error, "not replayed") {
		t.Fatalf("recovered real turn: %+v", c)
	}
	h.cp.add("t5", "message", "Finish.")
	h.settledOnce("t5", stSucceeded, "P3B final answer")
	h.end(run, "end")

	calls := modelCalls()
	if len(calls) != 6 {
		t.Fatalf("real dsh made %d model requests, want 6 (a replay would add more)", len(calls))
	}
	for _, i := range []int{2, 5} {
		if text := history(calls[i]); !strings.Contains(text, "P3B-WORD") || !strings.Contains(text, "P3B first answer") {
			t.Fatalf("model request %d lost the resumed context: %s", i+1, text)
		}
	}
	if final := history(calls[5]); strings.Count(final, "Write the file.") != 1 || strings.Count(final, "call_p3b_write") > 2 {
		t.Fatalf("the interrupted turn was replayed into the final context: %s", final)
	}
	if content, err := os.ReadFile(writtenFile); err != nil || string(content) != "P3B real dsh tool effect" {
		t.Fatalf("native write effect = %q (%v)", content, err)
	}
	launches, resumed := 0, 0
	for _, event := range h.events.snapshot() {
		if event.typ == evSystem && event.payload["subtype"] == "launch" {
			launches++
		}
		if event.typ == evSystem && event.payload["subtype"] == "init" && event.payload["resumed"] == true {
			resumed++
			if event.payload["runtimeSessionId"] != runtimeID {
				t.Fatalf("resume opened another runtime session: %v", event.payload)
			}
		}
	}
	if launches != 3 || resumed != 2 {
		t.Fatalf("three launches, two of them resuming: launches=%d resumed=%d", launches, resumed)
	}
	var persisted []string
	_ = filepath.Walk(h.home, func(path string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() && strings.Contains(path, runtimeID) {
			rel, _ := filepath.Rel(h.home, path)
			persisted = append(persisted, rel)
		}
		return nil
	})
	if len(persisted) == 0 {
		t.Fatal("DSH_HOME holds no engine session state for the runtime id")
	}
	t.Logf("engine session state retained in DSH_HOME: %v", persisted)
	for i, call := range calls {
		t.Logf("official Messages request #%d: historyBytes=%d", i+1, len(history(call)))
	}
	h.cp.checkClean(t)
	h.recordEvidence(t.Name())
	if dir := os.Getenv("DSH_P3B_EVIDENCE_DIR"); dir != "" {
		var summary []map[string]interface{}
		for _, call := range calls {
			summary = append(summary, map[string]interface{}{"call": call["call"], "messages": mapValue(call["body"])["messages"]})
		}
		data, _ := json.MarshalIndent(summary, "", "  ")
		_ = os.WriteFile(filepath.Join(dir, t.Name()+".model-requests.json"), append(data, '\n'), 0o644)
	}
}
