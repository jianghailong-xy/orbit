package main

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"
)

// On 2026-11-17 a session told "tell me when the upgrade is complete" waited on a bg_run job, woke when it
// ended, answered in the conversation and stopped: the person heard nothing until they opened it. notify was
// the tool for it, but nothing the agent read named it -- the instructions did not, and Claude Code kept its
// description behind ToolSearch. Both now do, for every shape of session.
func TestNotifyIsNamedInTheInstructionsNotLoadedUpFront(t *testing.T) {
	srv := &mcpServer{}
	resp, _ := srv.handle(&rpcRequest{JSONRPC: "2.0", ID: []byte("1"), Method: "tools/list"})
	found := false
	for _, tool := range resp.Result.(map[string]interface{})["tools"].([]map[string]interface{}) {
		if tool["name"] != "notify" {
			continue
		}
		found = true
		meta, _ := tool["_meta"].(map[string]interface{})
		// Not alwaysLoad since design D2: I2 passed 10/10 without it, on the instructions' one line.
		if meta["anthropic/alwaysLoad"] == true {
			t.Errorf("notify is loaded up front again: _meta = %#v", tool["_meta"])
		}
	}
	if !found {
		t.Fatal("tools/list offers no notify")
	}
	for _, form := range []struct{ inside, watches, delegates bool }{
		{false, true, true}, {true, true, true}, {false, false, true}, {true, false, false},
	} {
		// A SubAgent has no person to tell: its parent hears from it, and notify is not in its instructions.
		text := orbitCLIInstructions("/usr/local/bin/orbit", form.inside, form.watches, form.delegates, true)
		if got := strings.Contains(text, orbitNotifyInstructions); got != form.delegates {
			t.Errorf("instructions %+v: say when to notify = %v, want %v", form, got, form.delegates)
		}
	}
}

// Claude Code's own PushNotification does not go through Orbit, so an agent that reaches for it to say "it's
// done" is refused in every mode and pointed at notify -- and the spawn's settings have to reach it, since
// Claude runs a PreToolUse hook only for the tools its matcher matches.
func TestBgGuardRoutesPushNotificationToNotify(t *testing.T) {
	for _, mode := range []string{"default", "acceptEdits", "plan", "auto", "bypassPermissions"} {
		out := bgGuardDecision(hookInput{HookEventName: "PreToolUse", ToolName: "PushNotification",
			ToolInput: map[string]interface{}{"message": "Upgrade complete"}, PermissionMode: mode})
		specific, _ := out["hookSpecificOutput"].(map[string]interface{})
		reason, _ := specific["permissionDecisionReason"].(string)
		if specific["permissionDecision"] != "deny" || !strings.Contains(reason, "mcp__orbit__notify") {
			t.Fatalf("%s: PushNotification = %#v, want a deny naming mcp__orbit__notify", mode, out)
		}
	}

	path, err := writeClaudeSettings(t.TempDir(), "/usr/local/bin/orbit", false)
	if err != nil {
		t.Fatalf("settings not written: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var settings struct {
		Hooks struct {
			PreToolUse []struct {
				Matcher string `json:"matcher"`
				Hooks   []struct {
					Command string `json:"command"`
				} `json:"hooks"`
			} `json:"PreToolUse"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal(data, &settings); err != nil {
		t.Fatalf("settings %q: %v", data, err)
	}
	for _, entry := range settings.Hooks.PreToolUse {
		if regexp.MustCompile("^(?:"+entry.Matcher+")$").MatchString("PushNotification") &&
			len(entry.Hooks) == 1 && entry.Hooks[0].Command == "/usr/local/bin/orbit hook bg-guard" {
			return
		}
	}
	t.Fatalf("no PreToolUse matcher sends PushNotification to the bg-guard hook: %s", data)
}
