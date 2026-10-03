package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// agyPolicyWorld is a session's directories for the approval policy: a workspace, uploads, and a
// Gemini directory with a conversation's artifact directory in it.
type agyPolicyWorld struct {
	work, uploads, gemini, artifacts, outside string
}

func newAgyPolicyWorld(t *testing.T) agyPolicyWorld {
	t.Helper()
	root := t.TempDir()
	w := agyPolicyWorld{
		work:    filepath.Join(root, "work"),
		uploads: filepath.Join(root, "uploads"),
		gemini:  filepath.Join(root, "scratch", "antigravity"),
		outside: filepath.Join(root, "elsewhere"),
	}
	w.artifacts = filepath.Join(w.gemini, "antigravity-cli", "brain", "conv-1")
	for _, d := range []string{w.work, w.uploads, w.artifacts, filepath.Join(w.gemini, "config"), w.outside} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return w
}

func (w agyPolicyWorld) policy(mode string) *agyApprovalPolicy {
	return &agyApprovalPolicy{
		SessionID: "s1", Mode: mode, Workspace: w.work, Uploads: w.uploads, GeminiDir: w.gemini,
		AllowedTools:    []string{"mcp__orbit__*", "mcp__docs__search", "Read(" + filepath.Join(w.outside, "notes.md") + ")"},
		DisallowedTools: []string{"Bash(rm:*)", "WebFetch"},
	}
}

func (w agyPolicyWorld) call(name string, args map[string]interface{}) *agyHookInput {
	in := &agyHookInput{ConversationID: "conv-1", ArtifactDirectoryPath: w.artifacts}
	in.ToolCall.Name = name
	in.ToolCall.Args = args
	return in
}

func TestAntigravityApprovalPolicyDecides(t *testing.T) {
	w := newAgyPolicyWorld(t)
	if runtime.GOOS != "windows" {
		// A link inside the workspace to a directory outside it reads and writes outside it.
		if err := os.Symlink(w.outside, filepath.Join(w.work, "escape")); err != nil {
			t.Fatal(err)
		}
		// And one that leads nowhere would create its target when written through.
		if err := os.Symlink(filepath.Join(w.outside, "made-by-a-write"), filepath.Join(w.work, "dangling")); err != nil {
			t.Fatal(err)
		}
	}
	cmd := func(line string) map[string]interface{} {
		return map[string]interface{}{"CommandLine": line, "Cwd": w.work}
	}
	write := func(path string) map[string]interface{} {
		return map[string]interface{}{"TargetFile": path, "CodeContent": "x"}
	}
	cases := []struct {
		name   string
		mode   string
		tool   string
		args   map[string]interface{}
		want   string
		reason string
	}{
		// Orbit's own MCP server runs without asking; another server is asked about.
		{"orbit mcp", "default", "call_mcp_tool", map[string]interface{}{"ServerName": "orbit", "ToolName": "task_get", "Arguments": map[string]interface{}{}}, "allow", ""},
		{"orbit resources", "default", "list_resources", map[string]interface{}{"ServerName": "orbit"}, "allow", ""},
		{"other mcp", "default", "call_mcp_tool", map[string]interface{}{"ServerName": "github", "ToolName": "create_issue"}, "ask", ""},
		{"other mcp allowed by rule", "default", "call_mcp_tool", map[string]interface{}{"ServerName": "docs", "ToolName": "search"}, "allow", ""},
		// Commands always reach a person, whatever they start with; a deny rule refuses them anywhere in the line.
		{"command", "default", "run_command", cmd("git status"), "ask", ""},
		{"command in accept edits", "acceptEdits", "run_command", cmd("go test ./..."), "ask", ""},
		{"denied command", "default", "run_command", cmd("rm -rf build"), "deny", "Bash(rm:*)"},
		{"denied command chained", "default", "run_command", cmd("true&&rm -f x"), "deny", "Bash(rm:*)"},
		{"denied tool", "acceptEdits", "read_url_content", map[string]interface{}{"Url": "https://go.dev"}, "deny", "WebFetch"},
		// Reads: the workspace, uploads and artifacts freely, elsewhere by rule or by a person.
		{"read workspace", "default", "view_file", map[string]interface{}{"AbsolutePath": filepath.Join(w.work, "a.go")}, "allow", ""},
		{"read uploads", "default", "view_file", map[string]interface{}{"AbsolutePath": filepath.Join(w.uploads, "p.png")}, "allow", ""},
		{"read artifact", "default", "view_file", map[string]interface{}{"AbsolutePath": filepath.Join(w.artifacts, "task.md")}, "allow", ""},
		{"read outside", "default", "view_file", map[string]interface{}{"AbsolutePath": "/etc/passwd"}, "ask", ""},
		{"read outside by rule", "default", "view_file", map[string]interface{}{"AbsolutePath": filepath.Join(w.outside, "notes.md")}, "allow", ""},
		{"read dotdot", "default", "view_file", map[string]interface{}{"AbsolutePath": filepath.Join(w.work, "..", "elsewhere", "x")}, "ask", ""},
		{"read relative", "default", "view_file", map[string]interface{}{"AbsolutePath": "a.go"}, "ask", ""},
		// Writes: artifacts in every mode, the workspace in Accept Edits, never Orbit's own files.
		{"write artifact", "default", "write_to_file", write(filepath.Join(w.artifacts, "plan.md")), "allow", ""},
		{"write workspace in default", "default", "write_to_file", write(filepath.Join(w.work, "new.go")), "ask", ""},
		{"write workspace in accept edits", "acceptEdits", "write_to_file", write(filepath.Join(w.work, "pkg", "new.go")), "allow", ""},
		{"edit workspace in accept edits", "acceptEdits", "replace_file_content", map[string]interface{}{"TargetFile": filepath.Join(w.work, "a.go")}, "allow", ""},
		{"write outside in accept edits", "acceptEdits", "write_to_file", write(filepath.Join(w.outside, "x")), "ask", ""},
		{"write hooks.json", "acceptEdits", "write_to_file", write(filepath.Join(w.gemini, "config", "hooks.json")), "deny", "Orbit's own configuration"},
		// agy loads a checkout's .agents/ as it goes: a hook written there would run before every call.
		{"write checkout hooks in accept edits", "acceptEdits", "write_to_file", write(filepath.Join(w.work, ".agents", "hooks.json")), "ask", ""},
		{"write nested checkout config in accept edits", "acceptEdits", "write_to_file", write(filepath.Join(w.work, "pkg", ".agents", "mcp_config.json")), "ask", ""},
		{"write policy", "default", "replace_file_content", map[string]interface{}{"TargetFile": filepath.Join(w.gemini, "orbit", "approval-policy.json")}, "deny", "Orbit's own configuration"},
		// Subagents run their tools with no hook at all.
		{"subagent", "acceptEdits", "invoke_subagent", map[string]interface{}{"Subagents": []interface{}{}}, "deny", "Subagents are not available"},
		{"subagent definition", "default", "define_subagent", map[string]interface{}{"name": "x"}, "deny", "Subagents are not available"},
		// agy's own bookkeeping.
		{"timer", "default", "schedule", map[string]interface{}{"Prompt": "later"}, "allow", ""},
		{"task list", "default", "manage_task", map[string]interface{}{"Action": "list"}, "allow", ""},
		{"task input", "default", "manage_task", map[string]interface{}{"Action": "send_input", "Input": "rm -rf /\n"}, "ask", ""},
		{"message", "default", "send_message", map[string]interface{}{"Recipient": "x", "Message": "y"}, "ask", ""},
		{"unknown tool", "default", "brand_new_tool", map[string]interface{}{}, "ask", ""},
		// A policy whose mode does not ask refuses what it would have asked about.
		{"no asking", "dontAsk", "run_command", cmd("git status"), "deny", "does not ask"},
	}
	if runtime.GOOS != "windows" {
		cases = append(cases,
			struct {
				name, mode, tool string
				args             map[string]interface{}
				want, reason     string
			}{"read through link", "default", "view_file", map[string]interface{}{"AbsolutePath": filepath.Join(w.work, "escape", "secret")}, "ask", ""},
			struct {
				name, mode, tool string
				args             map[string]interface{}
				want, reason     string
			}{"write through link", "acceptEdits", "write_to_file", write(filepath.Join(w.work, "escape", "x")), "ask", ""},
			struct {
				name, mode, tool string
				args             map[string]interface{}
				want, reason     string
			}{"write through dangling link", "acceptEdits", "write_to_file", write(filepath.Join(w.work, "dangling")), "ask", ""},
		)
	}
	for _, tc := range cases {
		got := decideAntigravityToolCall(w.policy(tc.mode), w.call(tc.tool, tc.args))
		if got.decision != tc.want || !strings.Contains(got.reason, tc.reason) {
			t.Errorf("%s: %s %v -> %s %q, want %s (%q)", tc.name, tc.tool, tc.args, got.decision, got.reason, tc.want, tc.reason)
		}
	}
	// A trusted artifact directory is only ever one below <gemini>/antigravity-cli/brain.
	in := w.call("write_to_file", write(filepath.Join(w.work, "x")))
	in.ArtifactDirectoryPath = w.work
	if got := decideAntigravityToolCall(w.policy("default"), in); got.decision != "ask" {
		t.Fatalf("a payload naming the workspace as its artifact directory got %s", got.decision)
	}
}

// The card asks about the call as claude would name it, with what agy's stream leaves out put back.
func TestAntigravityApprovalSubjectIsWhatTheCardShows(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		args map[string]interface{}
		name string
		want map[string]interface{}
	}{
		{"run_command", map[string]interface{}{"CommandLine": "make", "Cwd": "/w", "WaitMsBeforeAsync": 5}, "Bash", map[string]interface{}{"command": "make", "cwd": "/w"}},
		{"write_to_file", map[string]interface{}{"TargetFile": "/w/a", "CodeContent": "hi"}, "Write", map[string]interface{}{"file_path": "/w/a", "content": "hi"}},
		{"replace_file_content", map[string]interface{}{"TargetFile": "/w/a", "TargetContent": "x", "ReplacementContent": "y"}, "Edit", map[string]interface{}{"file_path": "/w/a", "old_string": "x", "new_string": "y"}},
		{"view_file", map[string]interface{}{"AbsolutePath": "/w/a"}, "Read", map[string]interface{}{"file_path": "/w/a"}},
		{"read_url_content", map[string]interface{}{"Url": "https://go.dev"}, "WebFetch", map[string]interface{}{"url": "https://go.dev"}},
		{"call_mcp_tool", map[string]interface{}{"ServerName": "docs", "ToolName": "search", "Arguments": map[string]interface{}{"q": "x"}}, "mcp__docs__search", map[string]interface{}{"q": "x"}},
		{"manage_task", map[string]interface{}{"Action": "send_input"}, "manage_task", map[string]interface{}{"Action": "send_input"}},
	} {
		name, input := agyApprovalSubject(tc.raw, tc.args)
		gotJSON, _ := json.Marshal(input)
		wantJSON, _ := json.Marshal(tc.want)
		if name != tc.name || string(gotJSON) != string(wantJSON) {
			t.Errorf("%s -> %s %s, want %s %s", tc.raw, name, gotJSON, tc.name, wantJSON)
		}
	}
}

func writeAgyTestPolicy(t *testing.T, policy agyApprovalPolicy) (string, string) {
	t.Helper()
	body, err := json.Marshal(policy)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "approval-policy.json")
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(body)
	return path, hex.EncodeToString(sum[:])
}

// Whatever goes wrong, the hook prints one denial: agy runs a call whose hook printed nothing.
func TestAntigravityApprovalHookAlwaysAnswers(t *testing.T) {
	w := newAgyPolicyWorld(t)
	path, sum := writeAgyTestPolicy(t, *w.policy("default"))
	orbitCall := `{"toolCall":{"name":"call_mcp_tool","args":{"ServerName":"orbit","ToolName":"task_get"}},"stepIdx":3,"conversationId":"c"}`
	for _, tc := range []struct {
		name   string
		args   []string
		stdin  string
		want   string
		reason string
	}{
		{"allowed", []string{path, sum}, orbitCall, "allow", ""},
		{"denied by policy", []string{path, sum}, `{"toolCall":{"name":"invoke_subagent","args":{}}}`, "deny", "Subagents"},
		{"no policy", nil, orbitCall, "deny", "without its policy"},
		{"policy changed", []string{path, strings.Repeat("0", 64)}, orbitCall, "deny", "not the policy the runner wrote"},
		{"policy missing", []string{path + ".gone", sum}, orbitCall, "deny", "could not be read"},
		{"unreadable call", []string{path, sum}, `not json`, "deny", "could not read this tool call"},
		{"no tool", []string{path, sum}, `{}`, "deny", "which tool"},
	} {
		var out bytes.Buffer
		if code := cmdHookAntigravityApproval(tc.args, strings.NewReader(tc.stdin), &out); code != 0 {
			t.Errorf("%s: exit %d", tc.name, code)
		}
		lines := strings.Split(strings.TrimSpace(out.String()), "\n")
		var got agyHookDecision
		if len(lines) != 1 || json.Unmarshal([]byte(lines[0]), &got) != nil {
			t.Errorf("%s: printed %q, want one decision", tc.name, out.String())
			continue
		}
		if got.Decision != tc.want || !strings.Contains(got.Reason, tc.reason) {
			t.Errorf("%s: %+v, want %s (%q)", tc.name, got, tc.want, tc.reason)
		}
		if got.Decision == "deny" && got.Reason == "" {
			t.Errorf("%s: a denial with no reason for the model", tc.name)
		}
	}
	// A decision that cannot be written is a failed hook, which agy also refuses on.
	if code := cmdHookAntigravityApproval([]string{path, sum}, strings.NewReader(orbitCall), failingWriter{}); code == 0 {
		t.Fatal("an unwritable decision exited 0")
	}
}

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) { return 0, os.ErrClosed }

func TestAntigravityHeartbeatHookCountsCalls(t *testing.T) {
	path := filepath.Join(t.TempDir(), "heartbeat")
	g := &agyApprovalGate{beatPath: path, token: "tok", responses: map[int]bool{}}
	for i := 0; i < 2; i++ {
		var out bytes.Buffer
		if code := cmdHookAntigravityHeartbeat([]string{path, "tok"}, strings.NewReader(`{"invocationNum":0}`), &out); code != 0 || strings.TrimSpace(out.String()) != "{}" {
			t.Fatalf("heartbeat = %d %q", code, out.String())
		}
	}
	if code := cmdHookAntigravityHeartbeat([]string{path, "other"}, strings.NewReader(""), &bytes.Buffer{}); code != 0 {
		t.Fatal("a second token's beat failed")
	}
	if got := g.beats(); got != 2 {
		t.Fatalf("beats = %d, want 2 (another process's beats do not count)", got)
	}
	if code := cmdHookAntigravityHeartbeat([]string{filepath.Join(path, "not-a-dir", "x"), "tok"}, strings.NewReader(""), &bytes.Buffer{}); code == 0 {
		t.Fatal("a beat that could not be written exited 0")
	}
}

// The runtime check: every model call answered needs a beat before it, and hooks.json must stay put.
func TestAntigravityApprovalGateCheck(t *testing.T) {
	dir := t.TempDir()
	hooksPath := filepath.Join(dir, "hooks.json")
	hooks := []byte(`{"orbit-approval":{}}` + "\n")
	if err := os.WriteFile(hooksPath, hooks, 0o600); err != nil {
		t.Fatal(err)
	}
	g := &agyApprovalGate{hooksPath: hooksPath, hooks: hooks, beatPath: filepath.Join(dir, "heartbeat"), token: "tok", responses: map[int]bool{}}
	step := func(kind string, index int) map[string]interface{} {
		return map[string]interface{}{"step_type": kind, "step_index": float64(index), "state": "DONE"}
	}
	beat := func() {
		if code := cmdHookAntigravityHeartbeat([]string{g.beatPath, "tok"}, strings.NewReader(""), &bytes.Buffer{}); code != 0 {
			t.Fatal("beat failed")
		}
	}
	if problem := g.check(step("user_input", 0)); problem != "" {
		t.Fatalf("user_input before any call: %s", problem)
	}
	beat()
	for _, s := range []map[string]interface{}{step("agent_response", 1), step("agent_response", 1), step("tool", 2)} {
		if problem := g.check(s); problem != "" {
			t.Fatalf("one call, one beat: %s", problem)
		}
	}
	if problem := g.check(step("agent_response", 3)); !strings.Contains(problem, "agy answered 2 model call(s) and Orbit's hook saw 1") {
		t.Fatalf("a call without its beat: %q", problem)
	}
	if err := os.WriteFile(hooksPath, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if problem := g.check(step("system_message", 4)); !strings.Contains(problem, "hooks.json was changed") {
		t.Fatalf("a rewritten hooks.json: %q", problem)
	}
	if err := os.Remove(hooksPath); err != nil {
		t.Fatal(err)
	}
	if problem := g.check(step("tool", 5)); !strings.Contains(problem, "hooks.json was changed") {
		t.Fatalf("a removed hooks.json: %q", problem)
	}

	// The checkout growing agy configuration of its own is the same change from the other side.
	if err := os.WriteFile(hooksPath, hooks, 0o600); err != nil {
		t.Fatal(err)
	}
	g.execDir = filepath.Join(dir, "work")
	if err := os.MkdirAll(filepath.Join(g.execDir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if problem := g.check(step("tool", 6)); problem != "" {
		t.Fatalf("a clean checkout: %q", problem)
	}
	if err := os.MkdirAll(filepath.Join(g.execDir, ".agents"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(g.execDir, ".agents", "hooks.json"), []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if problem := g.check(step("tool", 7)); !strings.Contains(problem, "the checkout now brings its own agy configuration") {
		t.Fatalf("a checkout with its own hooks: %q", problem)
	}
}

func TestAntigravityHooksListingMustBeExactlyOrbits(t *testing.T) {
	hooksPath := "/g/config/hooks.json"
	want := []agyHookAction{
		{Event: "PreToolUse", Type: "command", Command: "'/bin/orbit' hook antigravity-approval '/g/orbit/p.json' abc", TimeoutSeconds: 86400},
		{Event: "PreInvocation", Type: "command", Command: "'/bin/orbit' hook antigravity-heartbeat '/g/orbit/heartbeat' tok", TimeoutSeconds: 30},
	}
	listing := func(hooks ...map[string]interface{}) []byte {
		raw, _ := json.Marshal(map[string]interface{}{"status": "SUCCESS", "command": map[string]interface{}{"name": "hooks", "data": map[string]interface{}{"hooks": hooks}}})
		return raw
	}
	orbit := func(mutate func(actions []map[string]interface{}) []map[string]interface{}) map[string]interface{} {
		actions := []map[string]interface{}{
			{"event": "PreInvocation", "type": "command", "command": want[1].Command, "timeout_seconds": 30},
			{"event": "PreToolUse", "type": "command", "command": want[0].Command, "timeout_seconds": 86400},
		}
		if mutate != nil {
			actions = mutate(actions)
		}
		return map[string]interface{}{"name": agyApprovalHookName, "enabled": true, "source": hooksPath, "actions": actions}
	}
	if problem := agyHooksListingProblem(listing(orbit(nil)), hooksPath, want); problem != "" {
		t.Fatalf("Orbit's own listing: %s", problem)
	}
	disabled := orbit(nil)
	disabled["enabled"] = false
	elsewhere := orbit(nil)
	elsewhere["source"] = "/work/.agents/hooks.json"
	for name, out := range map[string][]byte{
		"not json":        []byte("Error: something"),
		"failed":          []byte(`{"status":"ERROR","command":{"name":"hooks"}}`),
		"none":            listing(),
		"disabled":        listing(disabled),
		"another file":    listing(elsewhere),
		"another hook":    listing(orbit(nil), map[string]interface{}{"name": "ws", "enabled": true, "source": "/work/.agents/hooks.json", "actions": []interface{}{}}),
		"twice":           listing(orbit(nil), orbit(nil)),
		"no PreToolUse":   listing(orbit(func(a []map[string]interface{}) []map[string]interface{} { return a[:1] })),
		"other timeout":   listing(orbit(func(a []map[string]interface{}) []map[string]interface{} { a[1]["timeout_seconds"] = 600; return a })),
		"narrow matcher":  listing(orbit(func(a []map[string]interface{}) []map[string]interface{} { a[1]["matcher"] = "run_command"; return a })),
		"no beat command": listing(orbit(func(a []map[string]interface{}) []map[string]interface{} { delete(a[0], "command"); return a })),
		"extra action": listing(orbit(func(a []map[string]interface{}) []map[string]interface{} {
			return append(a, map[string]interface{}{"event": "PreToolUse", "type": "command", "command": "/bin/true"})
		})),
	} {
		if problem := agyHooksListingProblem(out, hooksPath, want); problem == "" {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestAntigravityApprovalGateIsRemovedOnlyWhenOrbits(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config", "hooks.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := removeAntigravityApprovalGate(dir); err != nil {
		t.Fatalf("no hooks.json: %v", err)
	}
	for body, removed := range map[string]bool{
		`{"` + agyApprovalHookName + `":{}}`: true,
		`{"someone-else":{}}`:                false,
		`not json`:                           false,
	} {
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := removeAntigravityApprovalGate(dir); err != nil {
			t.Fatal(err)
		}
		_, err := os.Stat(path)
		if gone := os.IsNotExist(err); gone != removed {
			t.Errorf("%s: removed %v, want %v", body, gone, removed)
		}
	}
}
