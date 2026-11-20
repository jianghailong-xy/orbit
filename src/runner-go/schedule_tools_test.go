package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Scheduled tasks' MCP tools (schedule_tools.go, docs/scheduled-tasks-design.md §9.1).

type scheduleCall struct {
	method, path, session string
	body                  map[string]interface{}
}

func scheduleServer(t *testing.T, calls *[]scheduleCall, answer string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]interface{}
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &body); err != nil {
				t.Errorf("decode body: %v", err)
			}
		}
		*calls = append(*calls, scheduleCall{r.Method, r.URL.RequestURI(), r.Header.Get("X-Orbit-Session-Id"), body})
		_, _ = w.Write([]byte(answer))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestScheduleRunReportIsListedOnlyInAScheduledRunsSession(t *testing.T) {
	ordinary := mcpToolNames(t, &mcpServer{sessionID: "s1"})
	run := mcpToolNames(t, &mcpServer{sessionID: "s1", scheduleRun: true})
	for name := range scheduleToolNames {
		if !run[name] {
			t.Errorf("%s is missing from a scheduled run's session", name)
		}
		if name == scheduleRunReportTool {
			if ordinary[name] {
				t.Errorf("%s is listed in a session that serves no run", name)
			}
		} else if !ordinary[name] {
			t.Errorf("%s is missing from an ordinary session", name)
		}
	}
	t.Setenv(envScheduleRun, "1")
	if !scheduleRunFromEnv() {
		t.Fatal("ORBIT_SCHEDULE_RUN=1 reads as no run")
	}
	t.Setenv(envScheduleRun, "0")
	if scheduleRunFromEnv() {
		t.Fatal("ORBIT_SCHEDULE_RUN=0 reads as a run")
	}
}

func TestScheduleRunReportOutsideARunSendsNothing(t *testing.T) {
	var calls []scheduleCall
	srv := scheduleServer(t, &calls, `{}`)
	s := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "s1"}
	res := s.callTool(scheduleRunReportTool, map[string]interface{}{"outcome": "NO_CHANGE", "summary": "x"})
	if res["isError"] != true || !strings.Contains(resultText(res), "serves none") {
		t.Fatalf("result = %v", res)
	}
	if len(calls) != 0 {
		t.Fatalf("calls = %+v", calls)
	}
}

func TestScheduleCreateSaysNothingIsScheduledYet(t *testing.T) {
	var calls []scheduleCall
	srv := scheduleServer(t, &calls, `{"outcome":"PENDING","scheduled":false,"note":"Nothing is scheduled yet. The create card is in front of the person.","card":{"id":"r1"}}`)
	s := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "s1"}
	res := s.callTool("schedule_create", map[string]interface{}{
		"intent": "every day at 10", "title": "Check", "prompt": "check it", "accessLevel": "CHECK_ONLY",
		"rule": map[string]interface{}{"kind": "DAILY", "time": "10:00"}, "readBack": "Every day I check it.",
		"findings": "versions", "baseline": map[string]interface{}{"key": "v1"}, "workspaceId": "ignored",
	})
	if res["isError"] == true {
		t.Fatalf("result = %v", res)
	}
	if !strings.HasPrefix(resultText(res), "Nothing is scheduled yet.") {
		t.Fatalf("a PENDING answer must lead with what it means: %q", resultText(res))
	}
	if len(calls) != 1 || calls[0].method != "POST" || calls[0].path != "/api/runner/schedules" || calls[0].session != "s1" {
		t.Fatalf("calls = %+v", calls)
	}
	if _, sent := calls[0].body["workspaceId"]; sent {
		t.Fatal("the workspace is the calling session's: the tool sends none")
	}
	for _, key := range []string{"intent", "title", "prompt", "rule", "accessLevel", "readBack", "findings", "baseline"} {
		if _, sent := calls[0].body[key]; !sent {
			t.Errorf("%s was not sent", key)
		}
	}
}

func TestScheduleToolsReachTheirDoors(t *testing.T) {
	var calls []scheduleCall
	srv := scheduleServer(t, &calls, `{"outcome":"APPLIED"}`)
	s := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "s1", scheduleRun: true}
	for _, tc := range []struct {
		tool         string
		args         map[string]interface{}
		method, path string
	}{
		{"schedule_list", map[string]interface{}{"state": "all"}, "GET", "/api/runner/schedules?state=all"},
		{"schedule_get", map[string]interface{}{"scheduleId": "sch1"}, "GET", "/api/runner/schedules/sch1"},
		{"schedule_update", map[string]interface{}{"scheduleId": "sch1", "title": "t"}, "PATCH", "/api/runner/schedules/sch1"},
		{"schedule_pause", map[string]interface{}{"scheduleId": "sch1"}, "POST", "/api/runner/schedules/sch1/pause"},
		{"schedule_resume", map[string]interface{}{"scheduleId": "sch1"}, "POST", "/api/runner/schedules/sch1/resume"},
		{"schedule_run_now", map[string]interface{}{"scheduleId": "sch1"}, "POST", "/api/runner/schedules/sch1/run"},
		{"schedule_end", map[string]interface{}{"scheduleId": "sch1"}, "POST", "/api/runner/schedules/sch1/end"},
		{"schedule_delete", map[string]interface{}{"scheduleId": "sch1"}, "DELETE", "/api/runner/schedules/sch1"},
		{"schedule_run_stop", map[string]interface{}{"runId": "run1"}, "POST", "/api/runner/schedule-runs/run1/stop"},
		{scheduleRunReportTool, map[string]interface{}{"outcome": "NO_CHANGE", "summary": "nothing"}, "POST", "/api/runner/schedule-runs/report"},
	} {
		calls = nil
		res := s.callTool(tc.tool, tc.args)
		if res["isError"] == true {
			t.Errorf("%s: %v", tc.tool, res)
			continue
		}
		if len(calls) != 1 || calls[0].method != tc.method || calls[0].path != tc.path || calls[0].session != "s1" {
			t.Errorf("%s: calls = %+v", tc.tool, calls)
		}
	}
	if res := s.callTool("schedule_pause", map[string]interface{}{}); res["isError"] != true {
		t.Fatalf("a schedule tool without its id must refuse: %v", res)
	}
}

// A CHECK_ONLY run on Codex, Kimi or Cursor is in Plan: it must still be able to report, change and end the schedule
// it serves (§8.3), and to propose one from a planning conversation; the controls stay closed in Plan.
func TestScheduleToolsInPlan(t *testing.T) {
	plan := func() (string, bool, error) { return "plan", true, nil }
	s := &mcpServer{sessionID: "s1", scheduleRun: true, permissionMode: plan}
	for _, name := range []string{"schedule_create", "schedule_update", "schedule_end", scheduleRunReportTool, "schedule_list", "schedule_get"} {
		if refusal := s.planRefusal(name, map[string]interface{}{}); refusal != "" {
			t.Errorf("%s is refused in Plan: %s", name, refusal)
		}
	}
	for _, name := range []string{"schedule_pause", "schedule_resume", "schedule_run_now", "schedule_run_stop", "schedule_delete"} {
		if refusal := s.planRefusal(name, map[string]interface{}{}); refusal == "" {
			t.Errorf("%s runs in Plan", name)
		}
	}
}

func TestScheduleRunReachesTheEngineEnvironment(t *testing.T) {
	run := &ClaimedSession{SessionID: "s1", ScheduleRun: true}
	plain := &ClaimedSession{SessionID: "s2"}
	if !strings.Contains(strings.Join(codexOrbitSessionEnv(run), "\n"), envScheduleRun+"=1") {
		t.Fatal("the Codex spawn does not mark a scheduled run")
	}
	if !strings.Contains(strings.Join(codexOrbitSessionEnv(plain), "\n"), envScheduleRun+"=0") {
		t.Fatal("the Codex spawn marks an ordinary session as a run")
	}
	if !strings.Contains(codexOrbitMCPEnvVarsConfig, `"`+envScheduleRun+`"`) {
		t.Fatal("Codex does not pass ORBIT_SCHEDULE_RUN to orbit mcp")
	}
	// A workspace's own variables cannot claim to be a run: the spawn site states it.
	if !sessionContextEnvKey(envScheduleRun) {
		t.Fatal("ORBIT_SCHEDULE_RUN is not stripped from a caller's environment")
	}
	var reclaimed ReclaimSession
	if err := json.Unmarshal([]byte(`{"scheduleRun":true}`), &reclaimed); err != nil || !reclaimed.ScheduleRun {
		t.Fatalf("a reclaim does not carry scheduleRun: %+v %v", reclaimed, err)
	}
}

func TestScheduleToolDescriptionsCarryTheTimerChoice(t *testing.T) {
	for _, tool := range toolDescriptors(false, false) {
		name, _ := tool["name"].(string)
		if name != "schedule_create" && name != "schedule_wakeup" {
			continue
		}
		if !strings.Contains(tool["description"].(string), scheduleTimerChoice) {
			t.Errorf("%s does not say which of the four timers to use", name)
		}
	}
}

// §8.4: a Run now counts toward the weekly budget; over it a session is refused and only the person can start one.
func TestScheduleRunNowDescriptionCountsTowardTheBudget(t *testing.T) {
	for _, tool := range toolDescriptors(false, false) {
		if name, _ := tool["name"].(string); name != "schedule_run_now" {
			continue
		}
		description := tool["description"].(string)
		for _, want := range []string{"counts toward its runs a week", "from an agent session is refused with SCHEDULE_OVER_BUDGET", "only the person can still start one, from the app"} {
			if !strings.Contains(description, want) {
				t.Errorf("schedule_run_now does not say %q", want)
			}
		}
		if strings.Contains(description, "not count") {
			t.Error("schedule_run_now still says a run now does not count")
		}
		return
	}
	t.Fatal("schedule_run_now is not listed")
}

// §8.1, §8.2: a change goes to schedule_update, and a change of the time is no new intent.
func TestScheduleToolDescriptionsSteerChangesToUpdate(t *testing.T) {
	descriptions := map[string]string{}
	for _, tool := range toolDescriptors(false, false) {
		name, _ := tool["name"].(string)
		if name == "schedule_create" || name == "schedule_update" {
			descriptions[name] = tool["description"].(string)
			if name == "schedule_update" {
				props := tool["inputSchema"].(map[string]interface{})["properties"].(map[string]interface{})
				if _, ok := props["readBack"]; !ok {
					t.Error("schedule_update takes no readBack")
				}
			}
		}
	}
	create := descriptions["schedule_create"]
	for _, want := range []string{"call schedule_update on it instead, never schedule_create", "schedule_list", "schedule_get", "outcome EXISTS"} {
		if !strings.Contains(create, want) {
			t.Errorf("schedule_create does not say %q", want)
		}
	}
	update := descriptions["schedule_update"]
	for _, want := range []string{"Leave intent out unless the person restates the goal", "a change of time, frequency, limits or prompt leaves intent alone", "Whenever you change when or how often the schedule runs (rule or timezone)", "pass a fresh readBack: one sentence saying when it runs and what it checks after the change"} {
		if !strings.Contains(update, want) {
			t.Errorf("schedule_update does not say %q", want)
		}
	}
}

func TestScheduleCreateExistsLeadsWithTheScheduleToChange(t *testing.T) {
	var calls []scheduleCall
	srv := scheduleServer(t, &calls, `{"outcome":"EXISTS","scheduled":false,"note":"Not created: this session already created this schedule.","scheduleId":"sch1"}`)
	s := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "s1"}
	res := s.callTool("schedule_create", map[string]interface{}{
		"intent": "weekly instead", "title": "Check", "prompt": "check it", "accessLevel": "CHECK_ONLY",
		"rule": map[string]interface{}{"kind": "WEEKLY", "time": "09:00", "weekdays": []string{"MON"}},
	})
	if res["isError"] == true || !strings.HasPrefix(resultText(res), "Not created:") {
		t.Fatalf("an EXISTS answer must lead with what it means: %v", res)
	}
}

func TestScheduleUpdateSendsItsReadBack(t *testing.T) {
	var calls []scheduleCall
	srv := scheduleServer(t, &calls, `{"outcome":"APPLIED"}`)
	s := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "s1"}
	s.callTool("schedule_update", map[string]interface{}{
		"scheduleId": "sch1", "rule": map[string]interface{}{"kind": "DAILY", "time": "23:46"},
		"readBack": "Every day at 23:46 I check it.",
	})
	if len(calls) != 1 || calls[0].body["readBack"] != "Every day at 23:46 I check it." {
		t.Fatalf("calls = %+v", calls)
	}
}

func TestScheduleAccessSchemaOffersLandWithItsLandingContract(t *testing.T) {
	for _, tool := range toolDescriptors(false, false) {
		name, _ := tool["name"].(string)
		if name != "schedule_create" && name != "schedule_update" {
			continue
		}
		props := tool["inputSchema"].(map[string]interface{})["properties"].(map[string]interface{})
		access := props["accessLevel"].(map[string]interface{})
		if got := access["enum"].([]string); strings.Join(got, ",") != "CHECK_ONLY,OPEN_PR,LAND" {
			t.Errorf("%s access levels: %v", name, got)
		}
		for _, phrase := range []string{"LAND never opens a PR", "normal merge check", "cannot release or deploy", "owner to allow it"} {
			if !strings.Contains(access["description"].(string), phrase) {
				t.Errorf("%s access description missing %q", name, phrase)
			}
		}
	}
}

func TestScheduleToolsCarryEveryAndMaxRuns(t *testing.T) {
	for _, tool := range toolDescriptors(false, false) {
		name, _ := tool["name"].(string)
		if name != "schedule_create" && name != "schedule_update" {
			continue
		}
		props := tool["inputSchema"].(map[string]interface{})["properties"].(map[string]interface{})
		if _, ok := props["maxRuns"]; !ok {
			t.Errorf("%s has no maxRuns", name)
		}
		rule := props["rule"].(map[string]interface{})["properties"].(map[string]interface{})
		kinds := strings.Join(rule["kind"].(map[string]interface{})["enum"].([]string), ",")
		if !strings.Contains(kinds, "EVERY") {
			t.Errorf("%s rule kinds: %s", name, kinds)
		}
		for _, f := range []string{"minutes", "until"} {
			if _, ok := rule[f]; !ok {
				t.Errorf("%s rule has no %s", name, f)
			}
		}
	}
	var create string
	for _, tool := range toolDescriptors(false, false) {
		if tool["name"] == "schedule_create" {
			create, _ = tool["description"].(string)
		}
	}
	for _, want := range []string{"{kind: \"EVERY\", minutes: 60}", "endAt", "maxRuns: 3", "active hours", "CHANGED only when something changed"} {
		if !strings.Contains(create, want) {
			t.Errorf("schedule_create does not say %q", want)
		}
	}
}

func TestScheduleWritesSendEveryAndMaxRuns(t *testing.T) {
	var calls []scheduleCall
	srv := scheduleServer(t, &calls, `{"outcome":"PENDING","note":"Nothing is scheduled yet."}`)
	s := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "s1"}
	rule := map[string]interface{}{"kind": "EVERY", "minutes": 60}
	s.callTool("schedule_create", map[string]interface{}{"intent": "i", "title": "t", "prompt": "p", "accessLevel": "CHECK_ONLY", "rule": rule, "endAt": "2026-11-20T18:00:00+08:00", "maxRuns": 6})
	s.callTool("schedule_update", map[string]interface{}{"scheduleId": "sch1", "maxRuns": 8})
	if len(calls) != 2 || calls[0].body["maxRuns"] != float64(6) || calls[1].body["maxRuns"] != float64(8) || calls[0].body["rule"] == nil {
		t.Fatalf("calls = %+v", calls)
	}
}
