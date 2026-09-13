package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"
)

// Claude's ScheduleWakeup keeps its timer inside the engine process, so recycling the engine or
// restarting the runner loses the wakeup, and a resumed engine never re-arms it. The hook refuses it
// whatever it asks for — a wakeup, or ending the loop — and names the server-held door instead: the
// refusal text is the whole mechanism, because the model reads it and retries with what it names.
func TestBgGuardRefusesScheduleWakeup(t *testing.T) {
	decide := func(tool string, input map[string]interface{}) (string, string) {
		t.Helper()
		body, err := json.Marshal(hookInput{HookEventName: "PreToolUse", ToolName: tool, ToolInput: input})
		if err != nil {
			t.Fatal(err)
		}
		var out bytes.Buffer
		cmdHookBgGuard(bytes.NewReader(body), &out)
		var decoded struct {
			HookSpecificOutput struct {
				Decision string `json:"permissionDecision"`
				Reason   string `json:"permissionDecisionReason"`
			} `json:"hookSpecificOutput"`
		}
		if err := json.Unmarshal(out.Bytes(), &decoded); err != nil {
			t.Fatalf("hook output %q is not a PreToolUse decision: %v", out.String(), err)
		}
		return decoded.HookSpecificOutput.Decision, decoded.HookSpecificOutput.Reason
	}

	for name, input := range map[string]map[string]interface{}{
		"a wakeup":        {"delaySeconds": 1500, "reason": "waiting for CI", "prompt": "/loop check CI", "noop": false},
		"ending the loop": {"stop": true},
	} {
		decision, reason := decide("ScheduleWakeup", input)
		if decision != "deny" {
			t.Fatalf("ScheduleWakeup (%s) decision = %q, want deny", name, decision)
		}
		if !strings.Contains(reason, "mcp__orbit__schedule_wakeup") {
			t.Fatalf("ScheduleWakeup (%s) deny reason = %q, want it to name the tool to use instead", name, reason)
		}
	}
	// The paired positive: the guard is not refusing whatever it is shown. The engine's cron listing
	// sits right beside ScheduleWakeup and nothing routes it elsewhere.
	if decision, _ := decide("CronList", map[string]interface{}{}); decision != "allow" {
		t.Fatalf("CronList decision = %q, want allow", decision)
	}

	// A decision nobody asks for refuses nothing: Claude runs a PreToolUse hook only for the tools its
	// matcher matches, so the spawn's settings have to reach ScheduleWakeup.
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
	covered := false
	for _, entry := range settings.Hooks.PreToolUse {
		matcher, err := regexp.Compile("^(?:" + entry.Matcher + ")$")
		if err != nil {
			t.Fatalf("matcher %q: %v", entry.Matcher, err)
		}
		if !matcher.MatchString("ScheduleWakeup") {
			continue
		}
		if len(entry.Hooks) != 1 || entry.Hooks[0].Command != "/usr/local/bin/orbit hook bg-guard" {
			t.Fatalf("the matcher reaching ScheduleWakeup runs %#v, want the bg-guard hook", entry.Hooks)
		}
		covered = true
	}
	if !covered {
		t.Fatalf("no PreToolUse matcher reaches ScheduleWakeup: %s", data)
	}
}

// schedule_wakeup is the door that refusal names. It keeps nothing locally — a timer that outlives
// the engine and the runner is the point — so it is a plain call to the control plane, always for the
// session it is called from.
func TestMCPScheduleWakeupAsksTheControlPlaneForThisSession(t *testing.T) {
	if !hasMCPTool(toolDescriptors(false, false), "schedule_wakeup") {
		t.Fatalf("schedule_wakeup missing from the base tools")
	}

	type sent struct {
		method, path, auth string
		body               map[string]interface{}
	}
	var got []sent
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]interface{}
		_ = json.Unmarshal(raw, &body)
		got = append(got, sent{r.Method, r.URL.Path, r.Header.Get("Authorization"), body})
		if body["stop"] == true {
			w.Write([]byte(`{"outcome":"CANCELLED","cancelled":1}`))
			return
		}
		w.Write([]byte(`{"outcome":"SCHEDULED","id":"7h2KQpL1xWm","dueAt":"2026-09-13T17:02:00.000Z","delaySeconds":120,"clamped":false,"replaced":true}`))
	}))
	defer srv.Close()
	resultText := func(res map[string]interface{}) string {
		content, _ := res["content"].([]map[string]interface{})
		if len(content) == 0 {
			return ""
		}
		text, _ := content[0]["text"].(string)
		return text
	}

	mcp := &mcpServer{sessionID: "4wN2mpWk2rCPZKmq6gcGAc", t: NewTransport(srv.URL, "tok")}
	res := mcp.callTool("schedule_wakeup", map[string]interface{}{
		"delaySeconds": float64(120), "reason": "waiting for CI run 4242", "prompt": "read the result and fix what failed",
	})
	if res["isError"] == true {
		t.Fatalf("schedule_wakeup returned an error: %s", resultText(res))
	}
	if len(got) != 1 || got[0].method != http.MethodPost || got[0].path != "/api/runner/sessions/4wN2mpWk2rCPZKmq6gcGAc/scheduled-wakeup" {
		t.Fatalf("schedule_wakeup sent %#v, want one POST to this session's scheduled-wakeup", got)
	}
	if got[0].auth != "Bearer tok" {
		t.Fatalf("schedule_wakeup authorization = %q, want the runner token", got[0].auth)
	}
	if got[0].body["delaySeconds"] != float64(120) || got[0].body["reason"] != "waiting for CI run 4242" ||
		got[0].body["prompt"] != "read the result and fix what failed" || got[0].body["stop"] != nil {
		t.Fatalf("schedule_wakeup body = %#v", got[0].body)
	}
	if text := resultText(res); !strings.Contains(text, "2026-09-13T17:02:00.000Z") || !strings.Contains(text, "replac") {
		t.Fatalf("schedule_wakeup result %q does not say when it is due and that it replaced the pending one", text)
	}

	res = mcp.callTool("schedule_wakeup", map[string]interface{}{"stop": true})
	if res["isError"] == true || len(got) != 2 || got[1].body["stop"] != true || got[1].body["delaySeconds"] != nil {
		t.Fatalf("schedule_wakeup stop = %s, sent %#v", resultText(res), got)
	}
	if text := resultText(res); !strings.Contains(strings.ToLower(text), "cancel") {
		t.Fatalf("schedule_wakeup stop result %q does not say it cancelled", text)
	}

	// Refused before anything is sent: outside a session there is nothing to wake, and a wakeup
	// needs its delay and its reason.
	outside := &mcpServer{t: NewTransport(srv.URL, "tok")}
	if res := outside.callTool("schedule_wakeup", map[string]interface{}{"delaySeconds": float64(120), "reason": "x"}); res["isError"] != true {
		t.Fatalf("schedule_wakeup outside a session = %s, want an error", resultText(res))
	}
	for _, args := range []map[string]interface{}{{"delaySeconds": float64(120)}, {"reason": "no delay"}} {
		if res := mcp.callTool("schedule_wakeup", args); res["isError"] != true {
			t.Fatalf("schedule_wakeup %v = %s, want an error", args, resultText(res))
		}
	}
	if len(got) != 2 {
		t.Fatalf("refused calls still reached the control plane: %#v", got[2:])
	}
}
