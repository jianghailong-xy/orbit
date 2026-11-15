package main

// A read-only SubAgent on Codex. Its mode is plan, as on every engine, but Codex's plan refuses every command
// and Codex reads a repository only through its shell, so the child is configured from codexReadonlySubagentMode:
// Codex's own read-only sandbox, no network, and nothing asked. These tests hold that to what it has to mean —
// the child reads, and it cannot write — first on the params and the approval decisions, then against a real
// `codex` driven by a scripted model.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
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

func readonlyCodexChild(t *testing.T, parentMode string) *ClaimedSession {
	t.Helper()
	parent := &ClaimedSession{SessionID: "s", Provider: providerCodex,
		Agent: AgentExecConfig{Provider: providerCodex, PermissionMode: parentMode}}
	return subagentChildJob(parent, AgentExecConfig{Provider: providerCodex, PermissionMode: parentMode},
		subagentDefinition{Name: "explore", Readonly: true}, "run1", providerCodex, "")
}

// The child runs every command in Codex's read-only sandbox without asking; a session in plan mode, and a
// SubAgent that is not read-only, keep what their modes mean.
func TestReadonlyCodexChildRunsInCodexsReadOnlySandbox(t *testing.T) {
	child := readonlyCodexChild(t, "acceptEdits")
	if child.Agent.PermissionMode != "plan" || codexPermissionMode(child) != codexReadonlySubagentMode {
		t.Fatalf("child mode %q, Codex mode %q", child.Agent.PermissionMode, codexPermissionMode(child))
	}
	thread := codexThreadParams(child, "/wt", "/up")
	if thread["approvalPolicy"] != "never" || thread["sandbox"] != "read-only" || thread["approvalsReviewer"] != nil {
		t.Fatalf("thread params = %v", thread)
	}
	turn := codexTurnParams("th", child, "/wt", "/up", "turn", "look", nil, codexTurnContextOptions{})
	policy := turn["sandboxPolicy"].(map[string]interface{})
	if turn["approvalPolicy"] != "never" || policy["type"] != "readOnly" || policy["networkAccess"] != false {
		t.Fatalf("turn params = %v", turn)
	}

	session := &ClaimedSession{Agent: AgentExecConfig{PermissionMode: "plan"}}
	if got := codexThreadParams(session, "/wt", "/up"); got["approvalPolicy"] != "untrusted" || got["sandbox"] != "danger-full-access" {
		t.Fatalf("a plan-mode session's thread params changed: %v", got)
	}
	if allowed, decided := codexAutomaticApproval(codexPermissionMode(session), codexApprovalRequest{}); !decided || allowed {
		t.Fatal("a plan-mode session's command is no longer refused")
	}
	general := subagentChildJob(session, AgentExecConfig{Provider: providerCodex, PermissionMode: "auto"},
		subagentDefinition{Name: "general"}, "run2", providerCodex, "")
	if codexPermissionMode(general) != "auto" || codexThreadParams(general, "/wt", "/up")["sandbox"] != "workspace-write" {
		t.Fatalf("a general SubAgent reads as %q", codexPermissionMode(general))
	}
}

// What the child's approvals decide. Under `never` Codex asks nothing about a command and runs it in the read-only
// sandbox, which is how a read is let through (TestRealCodexReadonlySubagentReadsButCannotWrite runs one). What still
// reaches Orbit asks to go beyond the sandbox, so it is refused without a card; Orbit's own tools stay answered, as
// in every mode, since Orbit's Plan gate refuses their writes itself.
func TestReadonlyCodexChildApprovalDecisions(t *testing.T) {
	mode := codexPermissionMode(readonlyCodexChild(t, "auto"))
	for name, tc := range map[string]struct {
		request codexApprovalRequest
		allowed bool
	}{
		"command (an escalation out of the sandbox)": {codexApprovalRequest{}, false},
		"file change":               {codexApprovalRequest{fileChange: true}, false},
		"legacy command":            {codexApprovalRequest{legacy: true}, false},
		"legacy patch":              {codexApprovalRequest{legacy: true, fileChange: true}, false},
		"third-party MCP tool":      {codexApprovalRequest{mcpTool: true, server: "acme", tool: "write_file"}, false},
		"unnamed Orbit MCP consent": {codexApprovalRequest{mcpTool: true, server: codexOrbitMCPServer}, false},
		"Orbit's own tool":          {codexApprovalRequest{mcpTool: true, server: codexOrbitMCPServer, tool: "task_get"}, true},
	} {
		allowed, decided := codexAutomaticApproval(mode, tc.request)
		if !decided || allowed != tc.allowed {
			t.Errorf("%s = (%v, %v), want (%v, decided)", name, allowed, decided, tc.allowed)
		}
	}
	if codexApprovalPolicy(mode) != "never" || codexSandboxMode(mode) != "read-only" {
		t.Fatalf("policy %q sandbox %q", codexApprovalPolicy(mode), codexSandboxMode(mode))
	}
}

// codexScriptedModel is a Responses API whose model calls exec_command once per scripted command, in order, and then
// answers with the first command's output, the way an explore SubAgent reports what it found. It records what each
// call returned.
type codexScriptedModel struct {
	t        *testing.T
	commands []map[string]interface{}
	mu       sync.Mutex
	outputs  map[string]string
}

func (m *codexScriptedModel) ServeHTTP(w http.ResponseWriter, r *http.Request) {
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
	m.mu.Lock()
	done := 0
	for _, item := range req.Input {
		if item["type"] == "function_call_output" {
			out := item["output"]
			if s, ok := out.(string); ok {
				m.outputs[asString(item["call_id"])] = s
			} else {
				b, _ := json.Marshal(out)
				m.outputs[asString(item["call_id"])] = string(b)
			}
			done++
		}
	}
	first := m.outputs["call_0"]
	m.mu.Unlock()

	var item map[string]interface{}
	if done < len(m.commands) {
		args, _ := json.Marshal(m.commands[done])
		item = map[string]interface{}{"type": "function_call", "id": fmt.Sprintf("fc_%d", done), "status": "completed",
			"call_id": fmt.Sprintf("call_%d", done), "name": "exec_command", "arguments": string(args)}
	} else {
		item = map[string]interface{}{"type": "message", "id": "msg_final", "status": "completed", "role": "assistant",
			"content": []interface{}{map[string]interface{}{"type": "output_text", "text": "Found:\n" + first, "annotations": []interface{}{}}}}
	}
	id := fmt.Sprintf("resp_%d", done)
	created := map[string]interface{}{"id": id, "object": "response", "status": "in_progress", "model": "gpt-5.1-codex", "output": []interface{}{}}
	completed := map[string]interface{}{"id": id, "object": "response", "status": "completed", "model": "gpt-5.1-codex",
		"output": []interface{}{item},
		"usage":  map[string]interface{}{"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}}
	w.Header().Set("Content-Type", "text/event-stream")
	for i, event := range []map[string]interface{}{
		{"type": "response.created", "response": created},
		{"type": "response.output_item.added", "output_index": 0, "item": item},
		{"type": "response.output_item.done", "output_index": 0, "item": item},
		{"type": "response.completed", "response": completed},
	} {
		event["sequence_number"] = i
		data, _ := json.Marshal(event)
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event["type"], data)
	}
}

func snapshotTree(t *testing.T, root string) map[string]string {
	t.Helper()
	files := map[string]string{}
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		info, err := d.Info()
		if err != nil {
			return err
		}
		content := ""
		if d.Type().IsRegular() {
			b, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			content = string(b)
		}
		files[rel] = fmt.Sprintf("%v %s", info.Mode(), content)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return files
}

// A real `codex` as a read-only SubAgent, through production's runCodexChild, with a scripted model: it lists and
// greps the parent's worktree and reports what it found, while `touch`, a redirect into a tracked file and an
// escalated `touch` are all refused, and the worktree is byte for byte what it was. The `codex` on PATH is a wrapper
// that leaves out the `orbit mcp` server (under test the runner's executable is this test binary) and is otherwise the
// installed engine, given production's argv. It skips without a `codex` on PATH, like every real-engine test here.
func TestRealCodexReadonlySubagentReadsButCannotWrite(t *testing.T) {
	real, err := exec.LookPath("codex")
	if err != nil {
		t.Skip("no codex on PATH; this test needs a real app-server")
	}
	bin := t.TempDir()
	wrapper := `#!/bin/bash
args=("$@"); out=()
for ((i = 0; i < ${#args[@]}; i++)); do
  if [[ ${args[i]} == -c && ${args[i+1]} == mcp_servers.orbit.* ]]; then i=$((i + 1)); continue; fi
  out+=("${args[i]}")
done
exec ` + real + ` "${out[@]}"
`
	if err := os.WriteFile(filepath.Join(bin, "codex"), []byte(wrapper), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	t.Setenv("ORBIT_HOME", t.TempDir())

	cwd, scratch, codexHome := t.TempDir(), t.TempDir(), t.TempDir()
	if err := os.MkdirAll(filepath.Join(cwd, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{"a.txt": "a needle here\n", "sub/b.txt": "nothing\n"} {
		if err := os.WriteFile(filepath.Join(cwd, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	before := snapshotTree(t, cwd)

	model := &codexScriptedModel{t: t, outputs: map[string]string{}, commands: []map[string]interface{}{
		{"cmd": "ls -1A . sub"},
		{"cmd": "grep -rn needle ."},
		{"cmd": "touch x"},
		{"cmd": "printf changed > a.txt"},
		{"cmd": "touch y", "sandbox_permissions": "require_escalated", "justification": "write a file"},
	}}
	api := httptest.NewServer(model)
	t.Cleanup(api.Close)

	parent := &ClaimedSession{SessionID: "orbit-parent", Provider: providerCodex,
		Agent: AgentExecConfig{Provider: providerCodex, PermissionMode: "auto"}}
	execCfg := AgentExecConfig{Provider: providerCodex, PermissionMode: "auto", Model: "gpt-5.1-codex", Env: map[string]string{
		"OPENAI_BASE_URL": api.URL + "/v1", "OPENAI_API_KEY": "sk-orbit-probe", "CODEX_HOME": codexHome,
	}}
	var mu sync.Mutex
	var events []string
	emit := func(typ string, payload map[string]interface{}) {
		b, _ := json.Marshal(payload)
		mu.Lock()
		events = append(events, typ+" "+string(b))
		mu.Unlock()
	}
	c := subagentChild{parent: parent, exec: execCfg, def: subagentDefinition{Name: "explore", Readonly: true},
		runID: "run1", cwd: cwd, scratch: scratch, prompt: "List the files and find needle.", emit: emit}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	res, _, err := runCodexChild(ctx, c)
	mu.Lock()
	transcript := strings.Join(events, "\n")
	mu.Unlock()
	if err != nil || res.Status != stSucceeded {
		t.Fatalf("child ended %#v, err %v\n%s", res, err, transcript)
	}
	model.mu.Lock()
	outputs := model.outputs
	model.mu.Unlock()
	t.Logf("child result: %s", res.Result)
	for i := range model.commands {
		t.Logf("call_%d %v -> %s", i, model.commands[i]["cmd"], outputs[fmt.Sprintf("call_%d", i)])
	}

	// The reads ran and their findings came back as the child's result.
	if ls := outputs["call_0"]; !strings.Contains(ls, "a.txt") || !strings.Contains(ls, "b.txt") {
		t.Fatalf("ls did not list the worktree: %q\n%s", ls, transcript)
	}
	if grep := outputs["call_1"]; !strings.Contains(grep, "a.txt:1:a needle here") {
		t.Fatalf("grep found nothing: %q", grep)
	}
	if !strings.Contains(res.Result, "a.txt") || !strings.Contains(res.Result, "b.txt") {
		t.Fatalf("the child's result does not carry its listing: %q", res.Result)
	}
	// Every write was refused, and the worktree is unchanged.
	for _, call := range []string{"call_2", "call_3", "call_4"} {
		out, ok := outputs[call]
		if !ok || strings.Contains(out, "Process exited with code 0") {
			t.Errorf("%s was not refused: %q", call, out)
		}
	}
	if after := snapshotTree(t, cwd); fmt.Sprint(after) != fmt.Sprint(before) {
		t.Fatalf("the worktree changed:\nbefore %v\nafter  %v", before, after)
	}
}
