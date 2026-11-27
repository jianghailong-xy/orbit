package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The drive is read-only in Plan mode (docs/drive-technical-design.md §7.2, test row 59*): where the
// runner answers an engine's permission request, a Plan-mode write under the drive is refused with no card filed,
// reads are not refused, and the other modes ask as before. Walk 350KSODTF8PzMHyZ3bSxP round 3 had a Claude Plan
// session's Write and Bash calls into ~/Drive filed as cards, and an Allow on one wrote the drive.

// planDriveHome makes this process's home /home/orbit, the runner user's, so ~/Drive is the drive's own spelling.
func planDriveHome(t *testing.T) {
	t.Helper()
	t.Setenv("HOME", "/home/orbit")
}

// planDriveWrites are a Claude session's calls that write under the drive, by each spelling of it.
func planDriveWrites() map[string]map[string]interface{} {
	return map[string]map[string]interface{}{
		"Write ~/Drive": {"tool_name": "Write", "input": map[string]interface{}{
			"file_path": "/home/orbit/Drive/notes/x.md", "content": "x"}},
		"Write the drive root": {"tool_name": "Write", "input": map[string]interface{}{
			"file_path": "/home/orbit/Drive", "content": "x"}},
		"Edit the mount": {"tool_name": "Edit", "input": map[string]interface{}{
			"file_path": "/run/orbit-drive/drive/a.txt", "old_string": "a", "new_string": "b"}},
		"Edit the parent": {"tool_name": "Edit", "input": map[string]interface{}{
			"file_path": "/run/orbit-drive/status.json", "old_string": "a", "new_string": "b"}},
		"MultiEdit": {"tool_name": "MultiEdit", "input": map[string]interface{}{
			"file_path": "/home/orbit/Drive/a.go", "edits": []interface{}{}}},
		"NotebookEdit": {"tool_name": "NotebookEdit", "input": map[string]interface{}{
			"notebook_path": "/home/orbit/Drive/n.ipynb", "new_source": "x"}},
		"Bash redirect into ~/Drive": {"tool_name": "Bash", "input": map[string]interface{}{
			"command": "echo hello > ~/Drive/x.txt"}},
		"Bash append into $HOME/Drive": {"tool_name": "Bash", "input": map[string]interface{}{
			"command": `printf 'a\n' >> "$HOME/Drive/log.txt"`}},
		"Bash touch on the mount": {"tool_name": "Bash", "input": map[string]interface{}{
			"command": "touch /run/orbit-drive/drive/new"}},
		"Bash cd then rm": {"tool_name": "Bash", "input": map[string]interface{}{
			"command": "cd /home/orbit/Drive && rm -f old.txt"}},
		"Bash cp into the drive": {"tool_name": "Bash", "input": map[string]interface{}{
			"command": "cp README.md /home/orbit/Drive/"}},
		"Bash tee": {"tool_name": "Bash", "input": map[string]interface{}{
			"command": "git log | tee ~/Drive/log.txt"}},
		"Bash sed -i": {"tool_name": "Bash", "input": map[string]interface{}{
			"command": "sed -i s/a/b/ /home/orbit/Drive/a.txt"}},
		"Bash find -delete": {"tool_name": "Bash", "input": map[string]interface{}{
			"command": "find /home/orbit/Drive -name '*.tmp' -delete"}},
		"Bash inline python": {"tool_name": "Bash", "input": map[string]interface{}{
			"command": `python3 -c "open('/home/orbit/Drive/x','w').write('x')"`}},
	}
}

// planDriveReads are calls that only read the drive, or write somewhere else after reading it.
func planDriveReads() map[string]map[string]interface{} {
	return map[string]map[string]interface{}{
		"Read":   {"tool_name": "Read", "input": map[string]interface{}{"file_path": "/home/orbit/Drive/a.md"}},
		"Grep":   {"tool_name": "Grep", "input": map[string]interface{}{"pattern": "x", "path": "/home/orbit/Drive"}},
		"Glob":   {"tool_name": "Glob", "input": map[string]interface{}{"pattern": "**/*.md", "path": "/run/orbit-drive/drive"}},
		"ls":     {"tool_name": "Bash", "input": map[string]interface{}{"command": "ls -la ~/Drive"}},
		"cat":    {"tool_name": "Bash", "input": map[string]interface{}{"command": "cat /home/orbit/Drive/a.md | grep -n x 2>/dev/null"}},
		"find":   {"tool_name": "Bash", "input": map[string]interface{}{"command": "find /run/orbit-drive/drive -name '*.md' | wc -l"}},
		"stat":   {"tool_name": "Bash", "input": map[string]interface{}{"command": "stat /home/orbit/Drive/a.md 2>&1"}},
		"to tmp": {"tool_name": "Bash", "input": map[string]interface{}{"command": "cat ~/Drive/a.md > /tmp/a.md"}},
	}
}

func promptAnswer(t *testing.T, srv *mcpServer, call map[string]interface{}) map[string]interface{} {
	t.Helper()
	args := map[string]interface{}{"tool_use_id": "toolu_1"}
	for k, v := range call {
		args[k] = v
	}
	text := permissionPromptText(t, srv.callTool("permission_prompt", args))
	var answer map[string]interface{}
	if err := json.Unmarshal([]byte(text), &answer); err != nil {
		t.Fatalf("answer %q: %v", text, err)
	}
	return answer
}

func TestClaudePlanModeRefusesDriveWritesWithoutACard(t *testing.T) {
	planDriveHome(t)
	fastApprovalRetry(t)
	for name, call := range planDriveWrites() {
		t.Run(name, func(t *testing.T) {
			url, filed, _ := approvalDoor(t, 0, `{"status":"ALLOWED"}`)
			srv := &mcpServer{allowPermissionPrompt: true, sessionID: "sess-plan", t: NewTransport(url, "tok"),
				permissionMode: planModeIs("plan")}
			answer := promptAnswer(t, srv, call)
			if answer["behavior"] != "deny" || answer["message"] != planDriveRefusal {
				t.Fatalf("a Plan-mode drive write was answered %v, want the drive refusal", answer)
			}
			if filed.Load() != 0 {
				t.Fatalf("a Plan-mode drive write filed %d approval cards, want none", filed.Load())
			}
		})
	}
}

func TestClaudePlanModeDoesNotRefuseDriveReads(t *testing.T) {
	planDriveHome(t)
	fastApprovalRetry(t)
	for name, call := range planDriveReads() {
		t.Run(name, func(t *testing.T) {
			url, _, _ := approvalDoor(t, 0, `{"status":"ALLOWED"}`)
			srv := &mcpServer{allowPermissionPrompt: true, sessionID: "sess-plan", t: NewTransport(url, "tok"),
				permissionMode: planModeIs("plan")}
			if answer := promptAnswer(t, srv, call); answer["behavior"] != "allow" {
				t.Fatalf("a Plan-mode read of the drive was answered %v, want it allowed", answer)
			}
		})
	}
}

// Outside the drive Plan is as it was: a write to the checkout goes to the card the engine asked for.
func TestClaudePlanModeLeavesOtherPathsToTheCard(t *testing.T) {
	planDriveHome(t)
	fastApprovalRetry(t)
	for name, call := range map[string]map[string]interface{}{
		"Write the checkout":   {"tool_name": "Write", "input": map[string]interface{}{"file_path": "/work/repo/a.go", "content": "x"}},
		"Bash in the checkout": {"tool_name": "Bash", "input": map[string]interface{}{"command": "touch a.go"}},
		"a Files folder elsewhere": {"tool_name": "Write", "input": map[string]interface{}{
			"file_path": "/home/other/Files/a.go", "content": "x"}},
	} {
		t.Run(name, func(t *testing.T) {
			url, filed, _ := approvalDoor(t, 0, `{"status":"ALLOWED"}`)
			srv := &mcpServer{allowPermissionPrompt: true, sessionID: "sess-plan", t: NewTransport(url, "tok"),
				permissionMode: planModeIs("plan")}
			if answer := promptAnswer(t, srv, call); answer["behavior"] != "allow" || filed.Load() != 1 {
				t.Fatalf("answered %v with %d cards, want the one card as before", answer, filed.Load())
			}
		})
	}
}

func TestClaudeDefaultModeDriveWritesStillAsk(t *testing.T) {
	planDriveHome(t)
	fastApprovalRetry(t)
	for _, mode := range []string{"default", "acceptEdits"} {
		for name, call := range planDriveWrites() {
			t.Run(mode+"/"+name, func(t *testing.T) {
				url, filed, _ := approvalDoor(t, 0, `{"status":"ALLOWED"}`)
				srv := &mcpServer{allowPermissionPrompt: true, sessionID: "sess-default", t: NewTransport(url, "tok"),
					permissionMode: planModeIs(mode)}
				answer := promptAnswer(t, srv, call)
				if answer["behavior"] != "allow" || filed.Load() != 1 {
					t.Fatalf("a %s drive write was answered %v with %d cards, want one card and the owner's allow",
						mode, answer, filed.Load())
				}
			})
		}
	}
	// The owner's deny is still the answer too.
	url, filed, _ := approvalDoor(t, 0, `{"status":"DENIED","message":"not now"}`)
	srv := &mcpServer{allowPermissionPrompt: true, sessionID: "sess-default", t: NewTransport(url, "tok"),
		permissionMode: planModeIs("default")}
	if answer := promptAnswer(t, srv, planDriveWrites()["Write ~/Drive"]); answer["behavior"] != "deny" ||
		answer["message"] != "not now" || filed.Load() != 1 {
		t.Fatalf("a denied Default-mode drive write was answered %v with %d cards", answer, filed.Load())
	}
}

// A mode nobody could read leaves the call to the card, as before: the card still asks a person.
func TestClaudeDriveWriteOnAnUnreadableModeGoesToTheCard(t *testing.T) {
	fastApprovalRetry(t)
	url, filed, _ := approvalDoor(t, 0, `{"status":"DENIED"}`)
	srv := &mcpServer{allowPermissionPrompt: true, sessionID: "sess", t: NewTransport(url, "tok"),
		permissionMode: func() (string, bool, error) { return "", true, errNoSessionSocket }}
	if answer := promptAnswer(t, srv, planDriveWrites()["Edit the mount"]); answer["behavior"] != "deny" || filed.Load() != 1 {
		t.Fatalf("answered %v with %d cards", answer, filed.Load())
	}
}

// Claude Code runs a Bash call an allow rule covers without asking its permission prompt, so the PreToolUse hook
// refuses a Plan-mode drive write too, and has no verdict on one in another mode or on a read.
func TestClaudeHookRefusesPlanModeDriveShellWrites(t *testing.T) {
	planDriveHome(t)
	for name, call := range planDriveWrites() {
		if call["tool_name"] != "Bash" {
			continue
		}
		input := call["input"].(map[string]interface{})
		out := bgGuardDecision(hookInput{ToolName: "Bash", ToolInput: input, PermissionMode: "plan"})
		spec, _ := out["hookSpecificOutput"].(map[string]interface{})
		if spec["permissionDecision"] != "deny" || spec["permissionDecisionReason"] != planDriveRefusal {
			t.Errorf("%s: hook in Plan = %v, want the drive refusal", name, out)
		}
		if out := bgGuardDecision(hookInput{ToolName: "Bash", ToolInput: input, PermissionMode: "default"}); len(out) != 0 {
			t.Errorf("%s: hook in Default gave a verdict %v, want none", name, out)
		}
	}
	for name, call := range planDriveReads() {
		input, _ := call["input"].(map[string]interface{})
		if out := bgGuardDecision(hookInput{ToolName: "Bash", ToolInput: input, PermissionMode: "plan"}); len(out) != 0 {
			t.Errorf("%s: hook in Plan gave a read a verdict %v", name, out)
		}
	}
}

// A link to the drive, or to a folder inside it, is the drive by another spelling.
func TestPlanDriveWriteFollowsLinks(t *testing.T) {
	dir := t.TempDir()
	oldParent, oldMount, oldHome := driveParentPath, driveMountPath, driveHomePath
	t.Cleanup(func() { driveParentPath, driveMountPath, driveHomePath = oldParent, oldMount, oldHome })
	driveParentPath = filepath.Join(dir, "run", "orbit-drive")
	driveMountPath = filepath.Join(driveParentPath, "drive")
	driveHomePath = filepath.Join(dir, "home", "orbit", "Drive")
	if err := os.MkdirAll(filepath.Join(driveMountPath, "Proj"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(driveHomePath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(driveMountPath, driveHomePath); err != nil {
		t.Fatal(err)
	}
	elsewhere := filepath.Join(dir, "work", "link")
	if err := os.MkdirAll(filepath.Dir(elsewhere), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(driveHomePath, "Proj"), elsewhere); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", filepath.Dir(driveHomePath))

	for _, path := range []string{
		filepath.Join(elsewhere, "new.md"),
		filepath.Join(elsewhere, "deeper", "new.md"),
		"~/Drive/Proj/a.md",
		filepath.Join(dir, "work", "..", "home", "orbit", "Drive", "a.md"),
	} {
		if !planDriveWrite("Write", map[string]interface{}{"file_path": path}) {
			t.Errorf("Write %s is not a drive write", path)
		}
	}
	if !planDriveWrite("Bash", map[string]interface{}{"command": "echo x > " + filepath.Join(elsewhere, "y")}) {
		t.Error("a redirect through a link into the drive is not a drive write")
	}
	if planDriveWrite("Write", map[string]interface{}{"file_path": filepath.Join(dir, "work", "plain.md")}) {
		t.Error("a file beside the link counts as the drive")
	}
}

// Kimi's plan mode asks about every shell call: one that writes the drive is refused unasked, even under an allow
// rule; a read and a write elsewhere still reach the user, and so does a drive write in Default.
func TestKimiPlanModeRefusesDriveWritesUnasked(t *testing.T) {
	planDriveHome(t)
	options := []interface{}{
		map[string]interface{}{"optionId": "approve_once", "kind": "allow_once"},
		map[string]interface{}{"optionId": "reject", "kind": "reject_once"},
	}
	plan := &ClaimedSession{Agent: AgentExecConfig{PermissionMode: "plan", AllowedTools: []string{"Edit", "Write"}}}
	for name, input := range map[string]map[string]interface{}{
		"Bash":  {"command": "echo x > ~/Drive/a.txt"},
		"Edit":  {"file_path": "/run/orbit-drive/drive/a.txt"},
		"Write": {"path": "/home/orbit/Drive/b.txt"},
	} {
		if got, decided := kimiAutomaticPermissionOption(plan, name, input, options, ""); got != "reject" || !decided {
			t.Errorf("Plan %s into the drive = %q, %t; want reject, true", name, got, decided)
		}
	}
	if got, decided := kimiAutomaticPermissionOption(plan, "Bash", map[string]interface{}{"command": "cat ~/Drive/a.txt"}, options, ""); decided {
		t.Errorf("Plan read of the drive was decided %q, want it left to the user as before", got)
	}
	if got, decided := kimiAutomaticPermissionOption(plan, "Bash", map[string]interface{}{"command": "touch a.go"}, options, ""); decided {
		t.Errorf("Plan write to the checkout was decided %q, want it left to the user as before", got)
	}
	def := &ClaimedSession{Agent: AgentExecConfig{PermissionMode: "default"}}
	if got, decided := kimiAutomaticPermissionOption(def, "Bash", map[string]interface{}{"command": "echo x > ~/Drive/a.txt"}, options, ""); decided {
		t.Errorf("Default drive write was decided %q, want the card as before", got)
	}
}

// Cursor CLI's Plan refuses every request unasked, and a standing allow rule does not open the drive in Plan.
func TestCursorPlanModeRefusesDriveWritesEvenUnderAnAllowRule(t *testing.T) {
	planDriveHome(t)
	shell := func(id, command string) map[string]interface{} {
		return map[string]interface{}{"toolCallId": id, "title": "`" + command + "`", "kind": "execute", "status": "pending",
			"content": []interface{}{map[string]interface{}{"type": "content", "content": map[string]interface{}{"type": "text", "text": "Not in allowlist"}}}}
	}
	run := func(mode, command string, allowAll bool) ([]string, int) {
		rig := newCursorBridgeRig(mode, nil)
		if allowAll {
			rig.bridge.preApproved = func(cursorPermissionAsk) bool { return true }
		}
		_ = rig.mapper.begin("turn")
		rig.bridge.begin("turn")
		rig.bridge.permission(1, cursorPermissionParams(shell("c1", command)))
		got := rig.answered("1")
		return got, len(rig.cards)
	}
	for _, allowAll := range []bool{false, true} {
		if got, cards := run("plan", "touch /home/orbit/Drive/x", allowAll); !cursorJSONEqual(t, got, []string{cursorRejectOnce}) || cards != 0 {
			t.Errorf("Plan drive write (allow rule %t) answered %q with %d cards, want reject and none", allowAll, got, cards)
		}
	}
	// Outside the drive a standing rule still answers as before.
	if got, _ := run("plan", "touch /work/x", true); !cursorJSONEqual(t, got, []string{cursorAllowOnce}) {
		t.Errorf("Plan write elsewhere under an allow rule answered %q, want it allowed as before", got)
	}
	// Accept Edits still asks a person about a drive command.
	if got, cards := run("acceptEdits", "touch /home/orbit/Drive/x", false); !cursorJSONEqual(t, got, []string{cursorAllowOnce}) || cards != 1 {
		t.Errorf("Accept Edits drive write answered %q with %d cards, want the card and its allow", got, cards)
	}
}

// Codex: Plan answers every approval request itself, refusing it, so a drive write never reaches a card.
func TestCodexPlanModeRefusesDriveWritesUnasked(t *testing.T) {
	for _, request := range []codexApprovalRequest{{fileChange: true}, {}, {legacy: true}} {
		if allowed, decided := codexAutomaticApproval("plan", request); allowed || !decided {
			t.Errorf("Plan %+v = allowed %t, decided %t; want refused unasked", request, allowed, decided)
		}
		if _, decided := codexAutomaticApproval("default", request); decided {
			t.Errorf("Default %+v was decided without the card", request)
		}
	}
}

// Antigravity: Plan runs agy in its own plan mode with no Orbit approval hook, so the runner mediates nothing and
// agy refuses the write itself (docs/antigravity-runtime-contract.md §5.1); no allow rule but Orbit's tools is given.
func TestAntigravityPlanModeIsAgyPlanWithNoApprovalCard(t *testing.T) {
	if antigravityAsksForApproval("plan") {
		t.Fatal("Plan installs Orbit's approval hook, which would put agy's writes on a card")
	}
	if got := antigravityPermissionArgs("plan", true); len(got) != 2 || got[0] != "--mode" || got[1] != "plan" {
		t.Fatalf("Plan args = %v, want --mode plan", got)
	}
	allow, _ := antigravityPermissionRules(&ClaimedSession{Agent: AgentExecConfig{
		PermissionMode: "plan", AllowedTools: []string{"Bash", "Write"}}}, "/opt/orbit")
	if len(allow) != 1 || allow[0] != "mcp(orbit/*)" {
		t.Fatalf("Plan allow rules = %v, want Orbit's tools alone", allow)
	}
}

// DeepSeek Harness has no Plan mode: a session in it does not start, so nothing reaches the drive.
func TestDshRefusesPlanMode(t *testing.T) {
	if _, err := dshPermissionPolicyFor("plan"); err == nil {
		t.Fatal("DeepSeek Harness accepted Plan mode")
	}
}
