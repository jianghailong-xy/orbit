package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"regexp"
	"strings"
	"sync"
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
	// matcher matches, so the spawn's settings have to reach ScheduleWakeup, and CronCreate beside it
	// (TestBgGuardRefusesCronCreate).
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
	for _, tool := range []string{"ScheduleWakeup", "CronCreate"} {
		covered := false
		for _, entry := range settings.Hooks.PreToolUse {
			matcher, err := regexp.Compile("^(?:" + entry.Matcher + ")$")
			if err != nil {
				t.Fatalf("matcher %q: %v", entry.Matcher, err)
			}
			if !matcher.MatchString(tool) {
				continue
			}
			if len(entry.Hooks) != 1 || entry.Hooks[0].Command != "/usr/local/bin/orbit hook bg-guard" {
				t.Fatalf("the matcher reaching %s runs %#v, want the bg-guard hook", tool, entry.Hooks)
			}
			covered = true
		}
		if !covered {
			t.Fatalf("no PreToolUse matcher reaches %s: %s", tool, data)
		}
	}
}

// CronCreate is the engine's timer for a loop, kept in the same process: its jobs live only in this Claude
// session and fire only while the engine is idle, so a loop kept by it ends with the first recycle. Every
// call is refused — a recurring job and a one-shot one alike — and the refusal names the loop the control
// plane holds instead, with the arguments that make one.
func TestBgGuardRefusesCronCreate(t *testing.T) {
	for _, watches := range []string{"on", "off"} {
		t.Setenv(envWatches, watches)
		for name, input := range map[string]map[string]interface{}{
			"a recurring job": {"cron": "*/5 * * * *", "prompt": "/loop check the deploy"},
			"a one-shot job":  {"cron": "30 14 1 11 *", "prompt": "check the deploy", "recurring": false},
		} {
			out := bgGuardDecision(hookInput{HookEventName: "PreToolUse", ToolName: "CronCreate", ToolInput: input})
			specific, _ := out["hookSpecificOutput"].(map[string]interface{})
			decision, _ := specific["permissionDecision"].(string)
			reason, _ := specific["permissionDecisionReason"].(string)
			if decision != "deny" || specific["hookEventName"] != "PreToolUse" {
				t.Fatalf("CronCreate (%s, Watch %s) = %#v, want a PreToolUse deny", name, watches, out)
			}
			for _, want := range []string{"mcp__orbit__schedule_wakeup", "recurring: true", "everySeconds", "prompt", "until", "stop: true"} {
				if !strings.Contains(reason, want) {
					t.Errorf("CronCreate (%s, Watch %s) deny reason does not say %q: %q", name, watches, want, reason)
				}
			}
			// The await advice only where there is an await tool to point at (watch_rollout.go).
			if advised := strings.Contains(reason, "mcp__orbit__task_await"); advised != (watches == "on") {
				t.Errorf("CronCreate (%s, Watch %s) deny reason names task_await: %v, want %v: %q", name, watches, advised, watches == "on", reason)
			}
		}
	}
	// With CronCreate refused, the engine's own listing and deletion hold nothing to route: left alone.
	for _, tool := range []string{"CronList", "CronDelete"} {
		if decision, reason := guardDecision(tool, map[string]interface{}{"id": "a1b2c3"}); decision != "allow" {
			t.Errorf("%s = %s (%q), want allow", tool, decision, reason)
		}
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

// scheduledWakeupDoor is a control plane's scheduled-wakeup door that answers each call as told, and keeps
// the bodies it was sent.
type scheduledWakeupDoor struct {
	mcp *mcpServer

	mu     sync.Mutex
	status int
	answer string
	sent   []map[string]interface{}
}

func newScheduledWakeupDoor(t *testing.T) *scheduledWakeupDoor {
	t.Helper()
	d := &scheduledWakeupDoor{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]interface{}
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Errorf("schedule_wakeup sent %q, not a JSON object: %v", raw, err)
		}
		d.mu.Lock()
		d.sent = append(d.sent, body)
		status, answer := d.status, d.answer
		d.mu.Unlock()
		if r.Method != http.MethodPost || r.URL.Path != "/api/runner/sessions/4wN2mpWk2rCPZKmq6gcGAc/scheduled-wakeup" {
			t.Errorf("schedule_wakeup sent %s %s, want a POST to this session's scheduled-wakeup", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(answer))
	}))
	t.Cleanup(srv.Close)
	d.mcp = &mcpServer{sessionID: "4wN2mpWk2rCPZKmq6gcGAc", t: NewTransport(srv.URL, "tok")}
	return d
}

// call makes one schedule_wakeup call, the door answering it with status and answer, and returns the
// result's text, whether it is an error, and the body the call sent (nil when it sent none).
func (d *scheduledWakeupDoor) call(args map[string]interface{}, status int, answer string) (string, bool, map[string]interface{}) {
	d.mu.Lock()
	d.status, d.answer = status, answer
	before := len(d.sent)
	d.mu.Unlock()
	res := d.mcp.callTool("schedule_wakeup", args)
	d.mu.Lock()
	defer d.mu.Unlock()
	var sent map[string]interface{}
	if len(d.sent) > before {
		sent = d.sent[len(d.sent)-1]
	}
	return resultText(res), res["isError"] == true, sent
}

// A loop is what replaces CronCreate (and the relay of one-shot wakeups an agent renewed every turn): the
// tool says the server schedules its ticks, sends the loop's fields as the contract names them, and says
// back when the first tick is due, until when the loop runs, what was clamped and whether a loop was
// replaced — and that nothing has to renew it.
func TestMCPScheduleWakeupHoldsALoopOnTheControlPlane(t *testing.T) {
	var descriptor map[string]interface{}
	for _, tool := range toolDescriptors(false, false) {
		if tool["name"] == "schedule_wakeup" {
			descriptor = tool
		}
	}
	description, _ := descriptor["description"].(string)
	for _, want := range []string{"CronCreate", "recurring: true", "The server schedules every tick itself", "do not call schedule_wakeup again each turn"} {
		if !strings.Contains(description, want) {
			t.Errorf("schedule_wakeup's description does not say %q: %q", want, description)
		}
	}
	properties := descriptor["inputSchema"].(map[string]interface{})["properties"].(map[string]interface{})
	for field, typ := range map[string]string{"recurring": "boolean", "everySeconds": "number", "until": "string", "prompt": "string", "delaySeconds": "number", "reason": "string", "stop": "boolean"} {
		property, _ := properties[field].(map[string]interface{})
		if property["type"] != typ {
			t.Errorf("schedule_wakeup's %s is %#v, want a %s", field, property, typ)
		}
	}

	door := newScheduledWakeupDoor(t)
	text, isError, sent := door.call(map[string]interface{}{
		"recurring": true, "everySeconds": float64(300), "prompt": "advance the migration by one batch",
		"reason": "the archive migration", "until": "2026-11-07T10:00:00Z", "delaySeconds": float64(120),
	}, http.StatusOK, `{"outcome":"SCHEDULED","recurring":true,"loopId":"5mQ8rTz2Lw0","id":"7h2KQpL1xWm",`+
		`"dueAt":"2026-11-01T10:02:00.000Z","delaySeconds":120,"everySeconds":300,"until":"2026-11-07T10:00:00.000Z",`+
		`"clamped":false,"clampedFrom":{},"replaced":true}`)
	if isError {
		t.Fatalf("a loop the control plane holds came back as an error: %s", text)
	}
	if want := map[string]interface{}{
		"recurring": true, "everySeconds": float64(300), "prompt": "advance the migration by one batch",
		"reason": "the archive migration", "until": "2026-11-07T10:00:00Z", "delaySeconds": float64(120),
	}; !reflect.DeepEqual(sent, want) {
		t.Fatalf("the loop sent %#v, want %#v", sent, want)
	}
	for _, want := range []string{
		"a tick every 300s until 2026-11-07T10:00:00.000Z",     // the interval and until
		"first tick is due 2026-11-01T10:02:00.000Z (in 120s)", // the next due time
		"replaces the loop that was running",                   // replaced
		"schedules every tick itself",
		"Do not call schedule_wakeup again to keep it going; stop: true ends it.",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("the loop's receipt does not say %q: %q", want, text)
		}
	}
	if strings.Contains(text, "Clamped") || strings.Contains(text, "30 days out") {
		t.Errorf("the loop's receipt reports a clamp nobody made: %q", text)
	}

	// What is left out is left to the control plane: the first tick one interval out, no reason, until seven
	// days out. Clamped values are said back with what was asked for, numbers past an int's range included.
	text, isError, sent = door.call(map[string]interface{}{"recurring": true, "everySeconds": 1e20, "prompt": "check the queue"},
		http.StatusOK, `{"outcome":"SCHEDULED","recurring":true,"loopId":"5mQ8rTz2Lw1","id":"7h2KQpL1xWn",`+
			`"dueAt":"2026-11-02T10:00:00.000Z","delaySeconds":86400,"everySeconds":86400,"until":"2026-11-08T10:00:00.000Z",`+
			`"clamped":true,"clampedFrom":{"everySeconds":100000000000000000000},"replaced":false}`)
	if want := map[string]interface{}{"recurring": true, "everySeconds": 1e20, "prompt": "check the queue"}; isError || !reflect.DeepEqual(sent, want) {
		t.Fatalf("a loop with only its required fields sent %#v (error %v: %s), want %#v", sent, isError, text, want)
	}
	if want := "Clamped to [60, 86400] seconds: everySeconds 100000000000000000000 became 86400."; !strings.Contains(text, want) {
		t.Errorf("the clamped loop's receipt does not say %q: %q", want, text)
	}
	if strings.Contains(text, "replaces") || strings.Contains(text, "delaySeconds") {
		t.Errorf("the receipt reports what did not happen: %q", text)
	}
	text, isError, _ = door.call(map[string]interface{}{
		"recurring": true, "everySeconds": float64(30), "delaySeconds": float64(5), "prompt": "x", "until": "2027-06-01T00:00:00Z",
	}, http.StatusOK, `{"outcome":"SCHEDULED","recurring":true,"loopId":"5mQ8rTz2Lw2","id":"7h2KQpL1xWo",`+
		`"dueAt":"2026-11-01T10:01:00.000Z","delaySeconds":60,"everySeconds":60,"until":"2026-12-01T10:00:00.000Z","clamped":true,`+
		`"clampedFrom":{"everySeconds":30,"delaySeconds":5,"until":"2027-06-01T00:00:00.000Z"},"replaced":false}`)
	for _, want := range []string{
		"Clamped to [60, 86400] seconds: everySeconds 30 became 60, delaySeconds 5 became 60.",
		"The until asked for, 2027-06-01T00:00:00.000Z, is more than 30 days out: the loop ends at 2026-12-01T10:00:00.000Z instead.",
	} {
		if isError || !strings.Contains(text, want) {
			t.Errorf("the clamped loop's receipt (error %v) does not say %q: %q", isError, want, text)
		}
	}
}

// A stop takes the one-shot wakeup and the loop together, and says what it found of each; finding neither
// is an answer, not an error. A stop sends nothing else, whatever else the call carries.
func TestMCPScheduleWakeupStopSaysWhatItCancelled(t *testing.T) {
	door := newScheduledWakeupDoor(t)
	for _, c := range []struct {
		answer string
		want   []string
	}{
		{`{"outcome":"CANCELLED","cancelled":1,"loopsStopped":1}`, []string{"the pending one-shot wakeup is cancelled", "the loop has ended"}},
		{`{"outcome":"CANCELLED","cancelled":0,"loopsStopped":1}`, []string{"no one-shot wakeup was pending", "the loop has ended"}},
		{`{"outcome":"CANCELLED","cancelled":1,"loopsStopped":0}`, []string{"the pending one-shot wakeup is cancelled", "no loop was running"}},
		{`{"outcome":"CANCELLED","cancelled":0,"loopsStopped":0}`, []string{"Nothing to stop: no wakeup was pending and no loop was running."}},
		// A control plane that predates loops answers a stop without loopsStopped: it has none to end.
		{`{"outcome":"CANCELLED","cancelled":1}`, []string{"the pending one-shot wakeup is cancelled", "no loop was running"}},
	} {
		text, isError, sent := door.call(map[string]interface{}{"stop": true, "recurring": true, "everySeconds": float64(300), "prompt": "x"},
			http.StatusOK, c.answer)
		if isError || !reflect.DeepEqual(sent, map[string]interface{}{"stop": true}) {
			t.Fatalf("stop answered %s sent %#v (error %v: %s), want only stop: true", c.answer, sent, isError, text)
		}
		for _, want := range c.want {
			if !strings.Contains(text, want) {
				t.Errorf("stop answered %s says %q, want it to say %q", c.answer, text, want)
			}
		}
	}
}

// Version skew (contract §1.1): a control plane that predates loops strips the fields it does not know, so
// it answers a loop request as one wakeup — held, or refused for want of its delaySeconds and reason. Either
// is an error that says no loop is running, never a loop; a refusal from a control plane that holds loops
// is passed on as it is.
func TestMCPScheduleWakeupLoopOnAServerThatPredatesLoopsIsAnError(t *testing.T) {
	door := newScheduledWakeupDoor(t)
	loop := map[string]interface{}{
		"recurring": true, "everySeconds": float64(300), "prompt": "advance one batch", "reason": "the migration", "delaySeconds": float64(120),
	}
	text, isError, sent := door.call(loop, http.StatusOK,
		`{"outcome":"SCHEDULED","id":"7h2KQpL1xWm","dueAt":"2026-11-01T10:02:00.000Z","delaySeconds":120,"clamped":false,"replaced":true}`)
	if sent["recurring"] != true || !isError {
		t.Fatalf("a loop held as one wakeup (sent %#v) came back as %q, error %v: want an error", sent, text, isError)
	}
	for _, want := range []string{"predates recurring wakeups, so no loop is running", "one wakeup instead, due 2026-11-01T10:02:00.000Z (in 120s), replacing the one that was pending", "call schedule_wakeup again from each woken turn"} {
		if !strings.Contains(text, want) {
			t.Errorf("the error does not say %q: %q", want, text)
		}
	}
	if strings.Contains(text, "Loop scheduled") {
		t.Errorf("a loop nobody holds is reported as scheduled: %q", text)
	}

	// The same server's refusal of a loop with no delaySeconds or reason, in the words of its one-shot DTO
	// (class-validator's, measured on the pre-loop DTO with the apiserver's ValidationPipe options).
	text, isError, _ = door.call(map[string]interface{}{"recurring": true, "everySeconds": float64(300), "prompt": "advance one batch"},
		http.StatusBadRequest, `{"message":["delaySeconds must be a number conforming to the specified constraints","reason must be a string",`+
			`"reason must be longer than or equal to 1 characters","reason must be shorter than or equal to 1000 characters"],"error":"Bad Request","statusCode":400}`)
	if !isError || !strings.Contains(text, "predates recurring wakeups, so no loop is running") || !strings.Contains(text, "nothing was scheduled") {
		t.Errorf("a loop refused as a one-shot wakeup came back as %q (error %v)", text, isError)
	}
	text, isError, _ = door.call(map[string]interface{}{"recurring": true, "everySeconds": float64(300), "prompt": "x", "delaySeconds": float64(120)},
		http.StatusBadRequest, `{"message":["reason must be a string","reason must be longer than or equal to 1 characters",`+
			`"reason must be shorter than or equal to 1000 characters"],"error":"Bad Request","statusCode":400}`)
	if !isError || !strings.Contains(text, "predates recurring wakeups") {
		t.Errorf("a loop refused for want of a reason came back as %q (error %v)", text, isError)
	}

	// A control plane that holds loops refusing one: its own words, and nothing about predating anything.
	text, isError, _ = door.call(loop, http.StatusBadRequest, `{"message":"until (2026-11-01T10:00:00.000Z) is before the first tick `+
		`(2026-11-01T10:02:00.000Z): name a later until or a shorter delaySeconds","error":"Bad Request","statusCode":400}`)
	if !isError || !strings.Contains(text, "is before the first tick") || strings.Contains(text, "predates") {
		t.Errorf("a refused loop came back as %q (error %v), want the control plane's refusal as it is", text, isError)
	}
}

// Refused before anything is sent: a loop without what it needs, and a loop's fields without recurring:
// true, which a control plane that predates loops would drop without a word while it held one wakeup.
func TestMCPScheduleWakeupRefusesAnIncompleteLoopLocally(t *testing.T) {
	door := newScheduledWakeupDoor(t)
	for _, c := range []struct {
		args map[string]interface{}
		says string
	}{
		{map[string]interface{}{"recurring": true, "prompt": "x"}, "everySeconds"},
		{map[string]interface{}{"recurring": true, "everySeconds": "300", "prompt": "x"}, "everySeconds"},
		{map[string]interface{}{"recurring": true, "everySeconds": float64(300)}, "prompt is required"},
		{map[string]interface{}{"recurring": true, "everySeconds": float64(300), "prompt": "  \n"}, "prompt is required"},
		{map[string]interface{}{"recurring": true, "everySeconds": float64(300), "prompt": "x", "until": float64(1793527200)}, "until is an ISO 8601"},
		{map[string]interface{}{"recurring": true, "everySeconds": float64(300), "prompt": "x", "delaySeconds": "soon"}, "delaySeconds"},
		{map[string]interface{}{"delaySeconds": float64(120), "reason": "x", "everySeconds": float64(300)}, "belong to a loop"},
		{map[string]interface{}{"delaySeconds": float64(120), "reason": "x", "until": "2026-11-07T10:00:00Z"}, "belong to a loop"},
		{map[string]interface{}{"recurring": false, "everySeconds": float64(300), "prompt": "x"}, "belong to a loop"},
	} {
		text, isError, sent := door.call(c.args, http.StatusOK, `{"outcome":"SCHEDULED"}`)
		if !isError || !strings.Contains(text, c.says) {
			t.Errorf("schedule_wakeup %v = %q (error %v), want a refusal that says %q", c.args, text, isError, c.says)
		}
		if sent != nil {
			t.Errorf("schedule_wakeup %v reached the control plane with %#v", c.args, sent)
		}
	}
}
