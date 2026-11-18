//go:build linux || darwin

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
	"strings"
	"sync"
	"testing"
	"time"
)

// What Claude Code itself does with Orbit's calls in Plan and in Default, measured against the installed CLI: the
// part of the permission matrix (permission_matrix_test.go) that is not Orbit's code. Claude is spawned with the
// arguments a session gets (claudeCommandArgs: the mcp__orbit__* allow rule, the CLI allowlist, the permission
// prompt tool, the hooks), against a scripted Anthropic API, with this test binary as the real `orbit mcp` and the
// real `orbit` CLI (dsh_mcp_test.go's init, TestMain), a control-plane double that records every request, and the
// session's mode served by its real job socket (startSessionBgJobService). Skipped where no claude is installed.

// realClaudeOrbitCall is one tool call the scripted model makes, and what came back for it.
type realClaudeOrbitCall struct {
	Name  string
	Input map[string]interface{}
}

type realClaudeToolResult struct {
	IsError bool
	Content string
}

// realClaudeScript is the Anthropic API Claude talks to: each completion answers the next scripted tool call, then
// the turn ends. Every tool_result Claude sends back is kept, by the call's position in the script.
type realClaudeScript struct {
	calls []realClaudeOrbitCall

	mu      sync.Mutex
	results []realClaudeToolResult
	done    chan struct{}
	once    sync.Once
}

func (s *realClaudeScript) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	if r.Method != http.MethodPost || !strings.HasSuffix(r.URL.Path, "/v1/messages") {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
		return
	}
	var req struct {
		OutputConfig map[string]interface{} `json:"output_config"`
		Messages     []struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	_ = json.Unmarshal(body, &req)
	if _, title := req.OutputConfig["format"]; title {
		writeCannedStream(w, textReply(`{"title":"orbit plan probe","isNewTopic":false}`))
		return
	}
	var results []realClaudeToolResult
	for _, message := range req.Messages {
		var blocks []map[string]interface{}
		if message.Role != "user" || json.Unmarshal(message.Content, &blocks) != nil {
			continue
		}
		for _, block := range blocks {
			if block["type"] != "tool_result" {
				continue
			}
			result := realClaudeToolResult{IsError: block["is_error"] == true}
			switch content := block["content"].(type) {
			case string:
				result.Content = content
			case []interface{}:
				for _, part := range content {
					if text, _ := mapValue(part)["text"].(string); text != "" {
						result.Content += text
					}
				}
			}
			results = append(results, result)
		}
	}
	s.mu.Lock()
	s.results = results
	s.mu.Unlock()
	if next := len(results); next < len(s.calls) {
		writeCannedStream(w, toolUseReply(fmt.Sprintf("toolu_orbit_%d", next+1), s.calls[next].Name, s.calls[next].Input))
		return
	}
	s.once.Do(func() { close(s.done) })
	writeCannedStream(w, textReply("DONE"))
}

func (s *realClaudeScript) snapshot() []realClaudeToolResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]realClaudeToolResult(nil), s.results...)
}

// toolUseReply is a completion that calls one tool.
func toolUseReply(id, name string, input map[string]interface{}) []map[string]interface{} {
	raw, err := json.Marshal(input)
	if err != nil {
		return textReply("DONE")
	}
	out := []map[string]interface{}{messageStart()}
	out = append(out,
		map[string]interface{}{"type": "content_block_start", "index": 0,
			"content_block": map[string]interface{}{"type": "tool_use", "id": id, "name": name, "input": map[string]interface{}{}}},
		map[string]interface{}{"type": "content_block_delta", "index": 0,
			"delta": map[string]interface{}{"type": "input_json_delta", "partial_json": string(raw)}},
		map[string]interface{}{"type": "content_block_stop", "index": 0},
	)
	return append(out, messageEnd("tool_use")...)
}

// driveRealClaudeOrbitCalls runs one turn of the installed Claude Code in a session spawned in mode, making the
// scripted calls, and returns what each came back with and what reached the control plane.
func driveRealClaudeOrbitCalls(t *testing.T, mode string, calls func(exe string) []realClaudeOrbitCall) ([]realClaudeToolResult, []string) {
	t.Helper()
	requireRealClaude(t)
	exe := orbitCLIPermissionExecutable(orbitCLIExecutable())
	if exe == "" || !shellWordSafe(exe) {
		t.Skipf("this test binary's path %q cannot be named by a Bash rule", orbitCLIExecutable())
	}
	// ORBIT_HOME is a temporary control-plane double's, which is what makes this binary serve as the real `orbit
	// mcp` (dsh_mcp_test.go) and the real CLI talk to the double; HOME is a temporary one too, so nothing here can
	// fall back to this machine's own ~/.orbit or ~/.claude.
	home, err := os.MkdirTemp("", "p102rc")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(home) })
	if err := os.Chmod(home, 0o700); err != nil {
		t.Fatal(err)
	}
	plane := newPlanGateControlPlane(t)
	config, _ := json.Marshal(RunnerConfig{ServerURL: plane.srv.URL, RunnerID: "r", RunnerToken: "tok"})
	if err := os.WriteFile(filepath.Join(home, "config.json"), config, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ORBIT_HOME", home)
	userHomeDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(userHomeDir, ".claude.json"), []byte(`{"hasCompletedOnboarding":true}`), 0o600); err != nil {
		t.Fatal(err)
	}

	script := &realClaudeScript{calls: calls(exe), done: make(chan struct{})}
	api := httptest.NewServer(script)
	t.Cleanup(api.Close)

	work, scratch := t.TempDir(), t.TempDir()
	job := &ClaimedSession{
		SessionID:   "7c1f3a52-5d1e-4c2a-9b8e-2f0a6d4e1b37",
		SessionUUID: newContractSessionUUID(t),
		Provider:    providerClaude,
		Agent: AgentExecConfig{
			Provider:       providerClaude,
			Model:          effortProbeModel,
			PermissionMode: mode,
			AllowedTools:   append([]string(nil), "mcp__orbit__*"),
			Env: map[string]string{
				"HOME":                 userHomeDir,
				"CLAUDE_CONFIG_DIR":    t.TempDir(),
				"ANTHROPIC_BASE_URL":   api.URL,
				"ANTHROPIC_AUTH_TOKEN": "orbit-plan-probe",
			},
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	bg := newBgTailer(ctx, func(string, map[string]interface{}) {}, nil)
	defer bg.stopAll()
	stopJobs, err := startSessionBgJobService(ctx, NewTransport(plane.srv.URL, "tok"), bg, job, work, scratch)
	if err != nil {
		t.Fatal(err)
	}
	defer stopJobs()

	proc, err := spawnClaude(ctx, job, work, claudeCommandArgs(job, scratch, true))
	if err != nil {
		t.Fatalf("spawning claude: %v", err)
	}
	rt := newClaudeRuntime(proc)
	var stderr strings.Builder
	var stderrMu sync.Mutex
	go func() {
		b, _ := io.ReadAll(proc.stderr)
		stderrMu.Lock()
		stderr.Write(b)
		stderrMu.Unlock()
	}()
	read := make(chan struct{})
	go func() {
		defer close(read)
		readEffortProbeStdout(proc.stdout, rt)
	}()
	defer func() {
		cancel()
		<-read
		_ = rt.wait()
	}()
	if err := rt.send(userFrame(job.SessionUUID, []map[string]interface{}{{"type": "text", "text": "Make the scripted Orbit calls."}})); err != nil {
		t.Fatalf("feeding the turn: %v", err)
	}
	select {
	case <-script.done:
	case <-read:
		t.Fatalf("claude exited before the turn ended; results %#v", script.snapshot())
	case <-time.After(3 * time.Minute):
		stderrMu.Lock()
		defer stderrMu.Unlock()
		t.Fatalf("the turn did not end; results %#v\nclaude stderr:\n%s", script.snapshot(), stderr.String())
	}
	results, seen := script.snapshot(), plane.seen()
	for i, result := range results {
		content := result.Content
		if len(content) > 160 {
			content = content[:160] + "…"
		}
		t.Logf("%s, call %d (%s): is_error=%v %q", mode, i+1, script.calls[i].Name, result.IsError, content)
	}
	t.Logf("%s: the control plane saw %v", mode, seen)
	return results, seen
}

func realClaudeOrbitCallsInOrder(exe string) []realClaudeOrbitCall {
	return []realClaudeOrbitCall{
		{Name: claudeToolName("task_get"), Input: map[string]interface{}{"taskId": "T1"}},
		{Name: claudeToolName("task_update"), Input: map[string]interface{}{"taskId": "T1", "title": "renamed"}},
		{Name: "Bash", Input: map[string]interface{}{"command": exe + " task get T1", "description": "read the task"}},
		{Name: "Bash", Input: map[string]interface{}{"command": exe + " task update T1 --title renamed", "description": "rename the task"}},
	}
}

func requestsOf(seen []string, prefix string) []string {
	var out []string
	for _, request := range seen {
		if strings.HasPrefix(request, prefix) {
			out = append(out, request)
		}
	}
	return out
}

// In Plan, Claude Code runs Orbit's read-only tool unasked and holds back the write, asking the permission prompt,
// which Orbit answers with its Plan refusal and no card; it runs the allowlisted CLI commands, and the CLI's own gate
// refuses the write. Nothing is written and nobody is asked.
func TestRealClaudePlanModeHoldsOnlyTheOrbitToolsThatWrite(t *testing.T) {
	results, seen := driveRealClaudeOrbitCalls(t, "plan", realClaudeOrbitCallsInOrder)
	if len(results) != 4 {
		t.Fatalf("results = %#v", results)
	}
	if results[0].IsError || strings.Contains(results[0].Content, "Plan mode") {
		t.Errorf("task_get in Plan = %#v, want it run", results[0])
	}
	if !results[1].IsError || !strings.Contains(results[1].Content, "this session is in Plan mode") || !strings.Contains(results[1].Content, "task_update writes to Orbit") {
		t.Errorf("task_update in Plan = %#v, want Orbit's Plan refusal", results[1])
	}
	if strings.Contains(results[2].Content, "Plan mode") || strings.Contains(strings.ToLower(results[2].Content), "permission") {
		t.Errorf("orbit task get in Plan = %#v, want it run", results[2])
	}
	if !strings.Contains(results[3].Content, "this session is in Plan mode") || !strings.Contains(results[3].Content, "orbit task update writes to Orbit") {
		t.Errorf("orbit task update in Plan = %#v, want the CLI's Plan refusal", results[3])
	}
	if reads := requestsOf(seen, "GET "); len(reads) < 2 {
		t.Errorf("the two reads did not both reach the control plane: %v", seen)
	}
	if writes := requestsOf(seen, "PATCH "); len(writes) != 0 {
		t.Errorf("a write in Plan reached the control plane: %v", seen)
	}
	for _, request := range seen {
		if strings.Contains(request, "/approvals") {
			t.Errorf("an Orbit call in Plan put a card in front of the owner: %v", seen)
		}
	}
}

// In Default, the same calls all run, the writes included, and nobody is asked: the allow rules cover them and no
// mode holds them back.
func TestRealClaudeDefaultModeRunsOrbitWritesWithoutACard(t *testing.T) {
	results, seen := driveRealClaudeOrbitCalls(t, "default", realClaudeOrbitCallsInOrder)
	if len(results) != 4 {
		t.Fatalf("results = %#v", results)
	}
	for i, result := range results {
		if strings.Contains(result.Content, "Plan mode") || strings.Contains(strings.ToLower(result.Content), "permission") {
			t.Errorf("call %d in Default = %#v, want it run", i+1, result)
		}
	}
	if writes := requestsOf(seen, "PATCH "); len(writes) != 2 {
		t.Errorf("the two writes did not both reach the control plane: %v", seen)
	}
	for _, request := range seen {
		if strings.Contains(request, "/approvals") {
			t.Errorf("an Orbit call in Default put a card in front of the owner: %v", seen)
		}
	}
}
