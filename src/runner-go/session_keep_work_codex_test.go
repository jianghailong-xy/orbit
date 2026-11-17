//go:build linux || darwin

package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// A Codex SubAgent left running by a coordinator that handed over (production, 11-17: a kept Codex run FAILED
// about 13 s after its parent's engine ended, mid-sleep). The parent is the fake Claude CLI under the real
// supervisor; the child is the installed `codex` app-server through production's runCodexChild, against a scripted
// Responses API. The `codex` on PATH is a wrapper that tees the engine's stderr to a file the test reads and is
// otherwise the installed engine given production's argv, except that the `orbit mcp` server is left out (under
// test the runner's executable is this test binary). It skips without a `codex` on PATH.
func installRealCodexChild(t *testing.T, s *supervisedSession, model http.Handler) (stderrLog string) {
	t.Helper()
	real, err := exec.LookPath("codex")
	if err != nil {
		t.Skip("no codex on PATH; this test needs a real app-server")
	}
	bin := t.TempDir()
	stderrLog = filepath.Join(t.TempDir(), "codex-stderr.log")
	wrapper := `#!/bin/bash
args=("$@"); out=()
for ((i = 0; i < ${#args[@]}; i++)); do
  if [[ ${args[i]} == -c && ${args[i+1]} == mcp_servers.orbit.command=* && -n $ORBIT_TEST_ORBIT_BIN ]]; then
    out+=(-c "mcp_servers.orbit.command=\"$ORBIT_TEST_ORBIT_BIN\""); i=$((i + 1)); continue
  fi
  if [[ ${args[i]} == -c && ${args[i+1]} == mcp_servers.orbit.* && -z $ORBIT_TEST_ORBIT_BIN ]]; then i=$((i + 1)); continue; fi
  out+=("${args[i]}")
done
exec ` + real + ` "${out[@]}" 2> >(tee -a ` + stderrLog + ` >&2)
`
	if err := os.WriteFile(filepath.Join(bin, "codex"), []byte(wrapper), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	api := httptest.NewServer(model)
	t.Cleanup(api.Close)
	s.mu.Lock()
	s.subagentExec = map[string]interface{}{"provider": providerCodex, "model": "gpt-5.1-codex", "permissionMode": "auto",
		"env": map[string]string{"OPENAI_BASE_URL": api.URL + "/v1", "OPENAI_API_KEY": "sk-orbit-probe", "CODEX_HOME": t.TempDir()}}
	s.mu.Unlock()
	return stderrLog
}

func TestRealCodexSubagentOutlivesItsCoordinatorsHandover(t *testing.T) {
	pool := newSessionPoolWithClock(1, newFakePoolClock())
	s := superviseClaudeSessionInWorktree(t, pool, oneTurn()...)
	s.awaitParked("turn-1")
	model := &codexScriptedModel{t: t, outputs: map[string]string{}, commands: []map[string]interface{}{
		{"cmd": "touch .started; date -u; sleep 20; echo FINISHED", "yield_time_ms": 30000},
	}}
	stderrLog := installRealCodexChild(t, s, model)
	r := &subagentRig{supervisedSession: s}
	run := r.call("subagent_start", map[string]interface{}{
		"toolUseId": "toolu_delegate", "description": "sleep then finish", "prompt": "Run the command.", "background": true,
	})
	if run.Status != subagentStatusRunning {
		t.Fatalf("the SubAgent started as %+v", run)
	}
	waitUntil(t, func() bool { _, err := os.Stat(filepath.Join(s.execDir, ".started")); return err == nil },
		"the Codex SubAgent never started its command")

	// The coordinator hands over mid-command.
	s.queue(RunInboxResponse{TurnID: "end-1", Kind: "end", Content: keepWorkEnd})
	waitUntil(t, func() bool { return r.pathIndex("/finalize") >= 0 }, "the session was never finalized")
	awaitSupervisorDone(t, s)

	var report map[string]interface{}
	deadline := time.Now().Add(2 * time.Minute)
	for report == nil && time.Now().Before(deadline) {
		if reports := r.reports(); len(reports) > 0 {
			report = reports[0]
		}
		time.Sleep(50 * time.Millisecond)
	}
	stderr, _ := os.ReadFile(stderrLog)
	t.Logf("codex stderr:\n%s", stderr)
	model.mu.Lock()
	output := model.outputs["call_0"]
	model.mu.Unlock()
	t.Logf("command output: %q", output)
	if report == nil {
		t.Fatal("the Codex SubAgent never reported its end")
	}
	t.Logf("report: %v", report)
	if report["runId"] != run.RunID || report["status"] != subagentStatusDone || report["wake"] != true ||
		!strings.Contains(asString(report["resultSummary"]), "FINISHED") {
		t.Fatalf("the kept Codex SubAgent ended as %v, want DONE with its command's output and the wake owed", report)
	}
}

// codexPollingModel is a Responses API whose model runs one command with a short yield, then polls its session with
// write_stdin until the command prints FINISHED, and answers with what it read: the shape of production's run, where
// the model said "The first 300-second sleep is still running" between polls.
type codexPollingModel struct {
	mu      sync.Mutex
	outputs []string
	reqs    int
	// refuse makes it the pool gateway as it was before kept-subagent-gateway.ts: once the parent session has ended,
	// every request on its token is answered 401 orbit_gateway_token_invalid, in the gateway's own body (refuse in
	// apiserver providers/pool-gateway.service.ts).
	refuse  atomic.Bool
	refused atomic.Int32
}

var codexExecSessionID = regexp.MustCompile(`session ID (\d+)`)

func (m *codexPollingModel) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	if r.Method != http.MethodPost || !strings.HasSuffix(r.URL.Path, "/responses") {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	var req struct {
		Input []map[string]interface{} `json:"input"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if m.refuse.Load() {
		m.refused.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"message":"This Orbit session token is not valid any more — the session ended or moved, or the pool is gone","type":"orbit_gateway","param":null,"code":"orbit_gateway_token_invalid"}}`))
		return
	}
	var outputs []string
	for _, item := range req.Input {
		if item["type"] == "function_call_output" {
			out, ok := item["output"].(string)
			if !ok {
				b, _ := json.Marshal(item["output"])
				out = string(b)
			}
			outputs = append(outputs, out)
		}
	}
	m.mu.Lock()
	m.outputs = outputs
	m.reqs++
	m.mu.Unlock()
	all := strings.Join(outputs, "\n")
	n := len(outputs)
	var item map[string]interface{}
	// Alongside each poll the model says where things stand, as production's did ("The first 300-second sleep is
	// still running."): what the turn's text is when its next request is refused.
	var commentary map[string]interface{}
	switch {
	case n == 0:
		args, _ := json.Marshal(map[string]interface{}{"cmd": "touch .started; date -u; sleep 12; echo FINISHED", "yield_time_ms": 1000})
		item = map[string]interface{}{"type": "function_call", "id": "fc_0", "status": "completed", "call_id": "call_0",
			"name": "exec_command", "arguments": string(args)}
	case !strings.Contains(all, "FINISHED") && n < 40:
		id := ""
		if found := codexExecSessionID.FindAllStringSubmatch(all, -1); len(found) > 0 {
			id = found[len(found)-1][1]
		}
		sid, _ := strconv.Atoi(id)
		args, _ := json.Marshal(map[string]interface{}{"session_id": sid, "chars": "", "yield_time_ms": 3000})
		item = map[string]interface{}{"type": "function_call", "id": fmt.Sprintf("fc_%d", n), "status": "completed",
			"call_id": fmt.Sprintf("call_%d", n), "name": "write_stdin", "arguments": string(args)}
		commentary = map[string]interface{}{"type": "message", "id": fmt.Sprintf("msg_%d", n), "status": "completed", "role": "assistant",
			"phase": "commentary", "content": []interface{}{map[string]interface{}{"type": "output_text", "text": "The first sleep is still running.", "annotations": []interface{}{}}}}
	default:
		item = map[string]interface{}{"type": "message", "id": "msg_final", "status": "completed", "role": "assistant",
			"content": []interface{}{map[string]interface{}{"type": "output_text", "text": "Read:\n" + all, "annotations": []interface{}{}}}}
	}
	id := fmt.Sprintf("resp_%d", n)
	created := map[string]interface{}{"id": id, "object": "response", "status": "in_progress", "model": "gpt-5.1-codex", "output": []interface{}{}}
	items := []interface{}{item}
	events := []map[string]interface{}{{"type": "response.created", "response": created}}
	if commentary != nil {
		items = []interface{}{commentary, item}
	}
	for i, it := range items {
		events = append(events,
			map[string]interface{}{"type": "response.output_item.added", "output_index": i, "item": it},
			map[string]interface{}{"type": "response.output_item.done", "output_index": i, "item": it})
	}
	completed := map[string]interface{}{"id": id, "object": "response", "status": "completed", "model": "gpt-5.1-codex",
		"output": items,
		"usage":  map[string]interface{}{"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}}
	events = append(events, map[string]interface{}{"type": "response.completed", "response": completed})
	w.Header().Set("Content-Type", "text/event-stream")
	for i, event := range events {
		event["sequence_number"] = i
		data, _ := json.Marshal(event)
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event["type"], data)
	}
}

// The same handover with production's shape: the end comes by the heartbeat (the parent's interactive run ends
// CANCELLED), the model polls a running command between short yields, and — when ORBIT_TEST_ORBIT_BIN names a
// built runner — the child's `orbit mcp` is the real one, with a runner config of its own. The model's endpoint is the
// pool gateway a pool SubAgent's Codex is pointed at, under either rule: before the fix it refuses the parent's ended
// session (production's failure, reproduced: FAILED at the next poll, the gateway's words in the result), after it
// serves the run its handover left running (DONE with the command's output).
// (Short names: the session's job socket lives under the test's temp dir, and a unix socket path has 100 bytes.)
func TestRealCodexKeptPollServed(t *testing.T) { realCodexHeartbeatHandover(t, false) }

// Before the server fix: the gateway refuses the ended parent's token.
func TestRealCodexKeptPollRefused(t *testing.T) { realCodexHeartbeatHandover(t, true) }

func realCodexHeartbeatHandover(t *testing.T, refuseAfterEnd bool) {
	pool := newSessionPoolWithClock(1, newFakePoolClock())
	s := superviseClaudeSessionInWorktree(t, pool, oneTurn()...)
	s.awaitParked("turn-1")
	if os.Getenv("ORBIT_TEST_ORBIT_BIN") != "" {
		// `orbit mcp` reads the runner's config; its calls go to a control plane that answers {}.
		ctl := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(`{}`)) }))
		t.Cleanup(ctl.Close)
		cfg, _ := json.Marshal(RunnerConfig{ServerURL: ctl.URL, RunnerID: "r1", RunnerToken: "runner-token", Name: "test"})
		if err := os.WriteFile(configPath(), cfg, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	model := &codexPollingModel{}
	stderrLog := installRealCodexChild(t, s, model)
	r := &subagentRig{supervisedSession: s}
	run := r.call("subagent_start", map[string]interface{}{
		"toolUseId": "toolu_delegate", "description": "sleep then finish", "prompt": "Run the command.", "background": true,
	})
	waitUntil(t, func() bool { _, err := os.Stat(filepath.Join(s.execDir, ".started")); return err == nil },
		"the Codex SubAgent never started its command")
	time.Sleep(2 * time.Second)

	markSessionKeepsWork(s.job.SessionID)
	s.live.cancel()
	waitUntil(t, func() bool { return r.pathIndex("/finalize") >= 0 }, "the session was never finalized")
	awaitSupervisorDone(t, s)
	// The control plane has completed the parent: the gateway's rule decides whether its token still serves.
	model.refuse.Store(refuseAfterEnd)
	if !heldFor(pool, s.job.SessionID, "subagent:"+run.RunID) || !pool.ids()[s.job.SessionID] {
		t.Fatal("the kept run's checkout and records are not held from gc while it runs")
	}

	var report map[string]interface{}
	deadline := time.Now().Add(2 * time.Minute)
	for report == nil && time.Now().Before(deadline) {
		if reports := r.reports(); len(reports) > 0 {
			report = reports[0]
		}
		time.Sleep(50 * time.Millisecond)
	}
	stderr, _ := os.ReadFile(stderrLog)
	t.Logf("codex stderr:\n%s", stderr)
	model.mu.Lock()
	t.Logf("model requests %d, tool outputs %q", model.reqs, model.outputs)
	model.mu.Unlock()
	if report == nil {
		t.Fatal("the Codex SubAgent never reported its end")
	}
	t.Logf("report: %v", report)
	summary := asString(report["resultSummary"])
	if refuseAfterEnd {
		// Production's failure: the next model call after the end is refused, and the turn fails mid-command. The
		// result now says why, in the gateway's own words.
		if model.refused.Load() == 0 || report["runId"] != run.RunID || report["status"] != subagentStatusFailed ||
			!strings.Contains(summary, "session token is not valid any more") {
			t.Fatalf("with the gateway refusing the ended parent (%d refused), the run ended as %v; want FAILED naming the refusal",
				model.refused.Load(), report)
		}
		if strings.Contains(summary, "FINISHED") {
			t.Fatalf("the refused run reports the command's end it never saw: %q", summary)
		}
		return
	}
	if report["runId"] != run.RunID || report["status"] != subagentStatusDone || report["wake"] != true ||
		!strings.Contains(summary, "FINISHED") {
		t.Fatalf("the kept Codex SubAgent ended as %v, want DONE with its command's output and the wake owed", report)
	}
	if model.refused.Load() != 0 {
		t.Fatalf("the gateway refused %d requests of the kept run", model.refused.Load())
	}
}
