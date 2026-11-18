package main

import (
	"net/http"
	"strings"
	"testing"
)

// Conditions' agent side (condition_tools.go, docs/condition-triggers-design.md §8): schedule_create takes a WHEN rule
// and task_create a startWhen, each refusing a condition without the baseline the agent read, and condition_get reads
// one back.

func whenCondition() map[string]interface{} {
	return map[string]interface{}{
		"text": "Raw used above 90%", "command": "ceph df -f json | jq '.stats.total_used_raw_ratio * 100'",
		"compare": map[string]interface{}{"op": "GT", "value": 90}, "holdSeconds": 600,
		"rearm":   map[string]interface{}{"op": "LT", "value": 85}, "unit": "%", "repeatSeconds": 7200,
	}
}

func whenScheduleArgs() map[string]interface{} {
	return map[string]interface{}{
		"intent": "when Ceph is above 90%, look at what can be cleared", "title": "Ceph raw use",
		"prompt": "Look at what can be cleared and propose it.", "accessLevel": "CHECK_ONLY",
		"rule":     map[string]interface{}{"kind": "WHEN", "condition": whenCondition(), "runsPerWeek": 3},
		"readBack": "When raw use stays above 90% for 10 minutes I look at what can be cleared.",
	}
}

func TestScheduleCreateAcceptsAWhenRuleWithItsBaseline(t *testing.T) {
	var calls []scheduleCall
	srv := scheduleServer(t, &calls, `{"outcome":"PENDING","note":"Nothing is scheduled yet."}`)
	s := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "s1"}
	args := whenScheduleArgs()
	args["baseline"] = map[string]interface{}{"key": "raw-used@87%", "summary": "Raw used is 87% now"}

	res := s.callTool("schedule_create", args)

	if res["isError"] == true {
		t.Fatalf("result = %s", resultText(res))
	}
	if len(calls) != 1 || calls[0].method != "POST" || calls[0].path != "/api/runner/schedules" {
		t.Fatalf("calls = %+v", calls)
	}
	rule, _ := calls[0].body["rule"].(map[string]interface{})
	condition, _ := rule["condition"].(map[string]interface{})
	if rule["kind"] != "WHEN" || condition["command"] != whenCondition()["command"] || condition["repeatSeconds"] != float64(7200) {
		t.Fatalf("the WHEN rule did not reach the server as given: %#v", rule)
	}
	if baseline, _ := calls[0].body["baseline"].(map[string]interface{}); baseline["key"] != "raw-used@87%" {
		t.Fatalf("baseline = %#v", calls[0].body["baseline"])
	}
}

func TestScheduleCreateRefusesAWhenRuleWithoutABaseline(t *testing.T) {
	for name, baseline := range map[string]interface{}{"absent": nil, "no key": map[string]interface{}{"summary": "87%"}} {
		t.Run(name, func(t *testing.T) {
			var calls []scheduleCall
			srv := scheduleServer(t, &calls, `{"outcome":"PENDING"}`)
			s := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "s1"}
			args := whenScheduleArgs()
			if baseline != nil {
				args["baseline"] = baseline
			}
			res := s.callTool("schedule_create", args)
			if res["isError"] != true || !strings.Contains(resultText(res), "a WHEN rule needs a baseline") {
				t.Fatalf("result = %s", resultText(res))
			}
			if len(calls) != 0 {
				t.Fatalf("a refusal raised a card: %+v", calls)
			}
		})
	}
	// A timed rule still needs none.
	var calls []scheduleCall
	srv := scheduleServer(t, &calls, `{"outcome":"PENDING"}`)
	s := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "s1"}
	args := whenScheduleArgs()
	args["rule"] = map[string]interface{}{"kind": "DAILY", "time": "10:00"}
	if res := s.callTool("schedule_create", args); res["isError"] == true || len(calls) != 1 {
		t.Fatalf("a DAILY rule without a baseline: %s, calls %+v", resultText(res), calls)
	}
}

func TestScheduleUpdateTakesAPartialWhenCondition(t *testing.T) {
	var calls []scheduleCall
	srv := scheduleServer(t, &calls, `{"outcome":"PENDING"}`)
	s := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "s1"}
	res := s.callTool("schedule_update", map[string]interface{}{
		"scheduleId": "sch1", "rule": map[string]interface{}{"kind": "WHEN", "condition": map[string]interface{}{"repeatSeconds": 3600}},
	})
	if res["isError"] == true || len(calls) != 1 || calls[0].method != "PATCH" {
		t.Fatalf("result = %s, calls %+v", resultText(res), calls)
	}
}

func startWhen(baseline interface{}) map[string]interface{} {
	sw := map[string]interface{}{
		"text": "3 or more OSDs are in", "command": "ceph osd stat -f json | jq .num_in_osds",
		"compare": map[string]interface{}{"op": "GTE", "value": 3}, "unit": "in",
	}
	if baseline != nil {
		sw["baseline"] = baseline
	}
	return sw
}

func TestTaskCreateAcceptsStartWhenWithItsBaseline(t *testing.T) {
	srv, hits := startNowServer(t, `{"status":"ALLOWED","startAfterCreate":true}`, http.StatusCreated, `{"id":"s1"}`)
	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

	res := mcp.callTool("task_create", map[string]interface{}{
		"title": "Set the kubernetes pool to 3 copies", "completionCriterion": "OWNER_CONFIRMED",
		"startWhen": startWhen(map[string]interface{}{"value": 2}),
	})

	if res["isError"] == true {
		t.Fatalf("task_create returned an error: %v", resultText(res))
	}
	got := hits()
	want := []string{
		"POST /api/runner/sessions/sess-1/approvals",
		"GET /api/runner/sessions/sess-1/approvals/ap1",
		"POST /api/runner/tasks",
	}
	if strings.Join(startNowPaths(got), "\n") != strings.Join(want, "\n") {
		t.Fatalf("requests =\n%s\nwant\n%s", strings.Join(startNowPaths(got), "\n"), strings.Join(want, "\n"))
	}
	// The card offers no "Create and start": a start now would be a runAt beside the approved startWhen.
	if _, offered := got[0].body["acceptsStartAfterCreate"]; offered {
		t.Fatalf("a startWhen card offers Create and start: %#v", got[0].body)
	}
	card, _ := got[0].body["input"].(map[string]interface{})
	create := got[2].body
	for what, body := range map[string]map[string]interface{}{"card": card, "create": create} {
		sw, _ := body["startWhen"].(map[string]interface{})
		baseline, _ := sw["baseline"].(map[string]interface{})
		if sw["command"] != startWhen(nil)["command"] || baseline["value"] != float64(2) {
			t.Fatalf("the %s's startWhen = %#v", what, body["startWhen"])
		}
		if _, scheduled := body["runAt"]; scheduled {
			t.Fatalf("the %s carries a runAt beside startWhen: %#v", what, body)
		}
	}
}

func TestTaskCreateRefusesStartWhenWithoutABaseline(t *testing.T) {
	srv, hits := startNowServer(t, `{"status":"ALLOWED"}`, http.StatusCreated, `{"id":"s1"}`)
	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

	res := mcp.invokeTool("task_create", map[string]interface{}{
		"title": "Set the kubernetes pool to 3 copies", "completionCriterion": "OWNER_CONFIRMED", "startWhen": startWhen(nil),
	})

	if res["isError"] != true || !strings.Contains(resultText(res), "startWhen.baseline") {
		t.Fatalf("a startWhen without a baseline was not refused for it: %s", resultText(res))
	}
	if got := hits(); len(got) != 0 {
		t.Fatalf("the refusal reached the server: %v", startNowPaths(got))
	}
}

func TestTaskCreateStartWhenIsExclusiveWithRunAtAndStartNow(t *testing.T) {
	for name, extra := range map[string]map[string]interface{}{
		"runAt":    {"runAt": "2026-12-01T09:00:00Z"},
		"startNow": {"startNow": true},
	} {
		t.Run(name, func(t *testing.T) {
			srv, hits := startNowServer(t, `{"status":"ALLOWED"}`, http.StatusCreated, `{"id":"s1"}`)
			mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}
			args := map[string]interface{}{
				"title": "x", "completionCriterion": "OWNER_CONFIRMED", "startWhen": startWhen(map[string]interface{}{"value": 2}),
			}
			for k, v := range extra {
				args[k] = v
			}
			if res := mcp.invokeTool("task_create", args); res["isError"] != true {
				t.Fatalf("startWhen beside %s was accepted: %s", name, resultText(res))
			}
			if got := hits(); len(got) != 0 {
				t.Fatalf("the refusal reached the server: %v", startNowPaths(got))
			}
		})
	}
}

func TestTaskCreateBatchItemTakesStartWhenAndRefusesItWithoutABaseline(t *testing.T) {
	srv, hits := startNowServer(t, `{"status":"ALLOWED"}`, http.StatusCreated, `{"id":"s1"}`)
	mcp := &mcpServer{agentID: "agent-1", sessionID: "sess-1", t: NewTransport(srv.URL, "tok")}

	res := mcp.invokeTool("task_create_batch", map[string]interface{}{"tasks": []interface{}{
		map[string]interface{}{"title": "a", "completionCriterion": "EVIDENCE_JUDGMENT"},
		map[string]interface{}{"title": "b", "completionCriterion": "OWNER_CONFIRMED", "startWhen": startWhen(nil)},
	}})
	if res["isError"] != true || !strings.Contains(resultText(res), "tasks[1].startWhen.baseline") {
		t.Fatalf("a batch item's startWhen without a baseline was not refused for it: %s", resultText(res))
	}
	if got := hits(); len(got) != 0 {
		t.Fatalf("the refusal reached the server: %v", startNowPaths(got))
	}

	res = mcp.callTool("task_create_batch", map[string]interface{}{"tasks": []interface{}{
		map[string]interface{}{"title": "b", "completionCriterion": "OWNER_CONFIRMED", "startWhen": startWhen(map[string]interface{}{"value": 2})},
	}})
	if res["isError"] == true {
		t.Fatalf("task_create_batch returned an error: %s", resultText(res))
	}
	creates := hitsTo(hits(), "POST", "/batch-create")
	if len(creates) != 1 {
		t.Fatalf("requests = %v", startNowPaths(hits()))
	}
	items, _ := creates[0].body["tasks"].([]interface{})
	first, _ := items[0].(map[string]interface{})
	if _, sent := first["startWhen"]; !sent {
		t.Fatalf("the item's startWhen did not reach the server: %#v", first)
	}
}

func TestConditionGetReadsTheCondition(t *testing.T) {
	var calls []scheduleCall
	srv := scheduleServer(t, &calls, `{"id":"c1","state":"WAITING","lastValue":2,"samples":[{"outcome":"VALUE","value":2}],"events":[]}`)
	s := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "s1"}

	res := s.callTool(conditionGetTool, map[string]interface{}{"conditionId": "c1"})

	if res["isError"] == true {
		t.Fatalf("result = %s", resultText(res))
	}
	if len(calls) != 1 || calls[0].method != "GET" || calls[0].path != "/api/runner/conditions/c1" {
		t.Fatalf("calls = %+v", calls)
	}
	for _, want := range []string{`"state": "WAITING"`, `"samples"`, `"events"`} {
		if !strings.Contains(resultText(res), want) {
			t.Errorf("the answer does not carry %s: %s", want, resultText(res))
		}
	}
	if res := s.callTool(conditionGetTool, map[string]interface{}{}); res["isError"] != true {
		t.Fatalf("condition_get without an id must refuse: %v", res)
	}
}

// There is no condition_create: a condition exists only on a task or a schedule.
func TestThereIsNoConditionCreate(t *testing.T) {
	names := mcpToolNames(t, &mcpServer{sessionID: "s1"})
	if !names[conditionGetTool] {
		t.Fatal("condition_get is not listed")
	}
	for name := range names {
		if strings.HasPrefix(name, "condition_") && name != conditionGetTool {
			t.Errorf("%s is listed; a condition is created only on a task or a schedule", name)
		}
	}
	if op := catalogOperation(conditionGetTool); op == nil || op.Mutates {
		t.Fatalf("condition_get is not a catalogued read: %+v", op)
	}
}

// The fifth timer (§8): the descriptions send "when something outside Orbit becomes true" to a condition.
func TestToolDescriptionsNameTheConditionTimer(t *testing.T) {
	descriptions := map[string]string{}
	for _, descriptor := range toolDescriptors(true, true) {
		name, _ := descriptor["name"].(string)
		descriptions[name], _ = descriptor["description"].(string)
	}
	for _, name := range []string{"schedule_create", "schedule_wakeup"} {
		for _, want := range []string{"When something outside Orbit becomes true", "not a bg_run poll and not a daily check", "wait until X"} {
			if !strings.Contains(descriptions[name], want) {
				t.Errorf("%s does not say %q", name, want)
			}
		}
	}
	for _, want := range []string{"shows it to the owner verbatim", "unattended", "must be read-only", "Never write a secret into it", "keeps the workspace awake"} {
		if !strings.Contains(descriptions["schedule_create"], want) {
			t.Errorf("schedule_create does not say %q", want)
		}
	}
	if !strings.Contains(descriptions["task_create"], "startWhen") || !strings.Contains(descriptions["task_create"], "wait until X") {
		t.Errorf("task_create does not name startWhen: %s", descriptions["task_create"])
	}
	if !strings.Contains(descriptions["watch_create"], "propose a condition instead") {
		t.Errorf("watch_create still sends an outside system only to bg_run: %s", descriptions["watch_create"])
	}
}

func TestCLIStartWhenNeedsItsBaseline(t *testing.T) {
	if _, err := parseStartWhenFlag(`{"text":"x","command":"true","compare":{"op":"EXIT_ZERO"}}`); err == nil ||
		!strings.Contains(err.Error(), "needs a baseline") {
		t.Fatalf("err = %v", err)
	}
	if _, err := parseStartWhenFlag(`not json`); err == nil {
		t.Fatal("a flag that is not JSON was accepted")
	}
	got, err := parseStartWhenFlag(`{"text":"x","command":"true","compare":{"op":"EXIT_ZERO"},"baseline":{"exitCode":1}}`)
	if err != nil || got["baseline"] == nil {
		t.Fatalf("got %v, err %v", got, err)
	}
}
