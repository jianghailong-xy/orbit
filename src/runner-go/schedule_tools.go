package main

// Scheduled tasks' MCP tools (docs/scheduled-tasks-design.md §9.1): a session proposes, changes and controls the
// owner's schedules, and a scheduled run's session reports its run.
//
// Every call is the calling session's (X-Orbit-Session-Id): the schedule's workspace and engine are that session's,
// and the server judges each write by the envelope rule (§4). Two things no tool here does:
//   - create a schedule: schedule_create puts up a create card and returns at once; only the person's Create writes
//     the schedule;
//   - answer a card: Create, Allow and Decline are the owner's own press on the owner channel, and no door under
//     /runner takes it.
//
// schedule_run_report is listed only in a session the server claimed as a scheduled run (claim field scheduleRun,
// injected as ORBIT_SCHEDULE_RUN=1); the server refuses it from any other session all the same.

import (
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"strings"
)

// envScheduleRun marks the engine of a scheduled run's session (ClaimedSession.ScheduleRun).
const envScheduleRun = "ORBIT_SCHEDULE_RUN"

// scheduleRunEnv renders the ORBIT_SCHEDULE_RUN value the runner injects at spawn.
func scheduleRunEnv(run bool) string {
	if run {
		return "1"
	}
	return "0"
}

// scheduleRunFromEnv reads ORBIT_SCHEDULE_RUN: only an explicit 1 is a run.
func scheduleRunFromEnv() bool {
	return strings.TrimSpace(os.Getenv(envScheduleRun)) == "1"
}

const scheduleRunReportTool = "schedule_run_report"

var scheduleToolNames = map[string]bool{
	"schedule_create": true, "schedule_update": true, "schedule_list": true, "schedule_get": true,
	"schedule_pause": true, "schedule_resume": true, "schedule_run_now": true, "schedule_run_stop": true,
	"schedule_end": true, "schedule_delete": true, scheduleRunReportTool: true,
}

// scheduleTimerChoice is design §1's table, in the words schedule_create and schedule_wakeup both carry.
const scheduleTimerChoice = "Pick the timer by what the person wants. \"Keep checking while we work on this\": " +
	"schedule_wakeup with recurring: true, which belongs to this conversation and ends with it. \"Tell me when that " +
	"task or session gets there\": task_await, session_await or watch_create, which wait for a state, not a time. " +
	"\"Start this task on Friday\": the task's runAt, because the work is a deliverable with evidence and a landing. " +
	"\"Do this every morning\", \"check at 18:00 and tell me\": a scheduled task (schedule_create), which runs in a new " +
	"session at each slot and outlives this conversation. " + conditionTimerCase

// withoutScheduleRunReport is tools without schedule_run_report: what a session that serves no run lists.
func withoutScheduleRunReport(tools []map[string]interface{}) []map[string]interface{} {
	kept := make([]map[string]interface{}, 0, len(tools))
	for _, tool := range tools {
		if name, _ := tool["name"].(string); name == scheduleRunReportTool {
			continue
		}
		kept = append(kept, tool)
	}
	return kept
}

// scheduleDurationGuidance is how an agent turns a stated span or count into a schedule's end, and keeps a frequent
// schedule quiet.
const scheduleDurationGuidance = "\"Check every hour\" is {kind: \"EVERY\", minutes: 60}. \"For 6 hours\" or \"for 2 weeks\" is an endAt " +
	"that long from now, written in the schedule's time zone; \"3 times\" is maxRuns: 3. Without either, the card suggests a 7-day end. " +
	"Prefer active hours (time and until, weekdays) over around-the-clock runs unless the person wants every hour. A frequent " +
	"schedule's prompt must say to report CHANGED only when something changed, and NO_CHANGE otherwise. When the person has stated how often and for how long, call schedule_create at once: the card is a proposal they can change, so do not ask where or how to check first; write the prompt so a run finds the target itself and reports FAILED if it cannot."

// scheduleToolDescriptors are the tools/list entries, in the catalogue's descriptor form.
func scheduleToolDescriptors(obj func(map[string]interface{}, ...string) map[string]interface{}) []map[string]interface{} {
	str := func(description string) map[string]interface{} {
		return map[string]interface{}{"type": "string", "description": description}
	}
	id := str("The schedule's id, as schedule_list or schedule_get returns it.")
	// The rule's schema, for a create (a WHEN condition names its text, command and comparison) or a change (a WHEN
	// condition names only what it changes; schedule-time.ts mergeRule keeps the rest).
	ruleSchema := func(create bool) map[string]interface{} {
		props := map[string]interface{}{
			"kind":     map[string]interface{}{"type": "string", "enum": []string{"ONCE", "DAILY", "WEEKLY", "EVERY", "WHEN"}},
			"time":     str("DAILY and WEEKLY: local HH:mm. EVERY: the first slot of each day's window, local HH:mm (00:00 when omitted)."),
			"minutes":  map[string]interface{}{"type": "integer", "enum": []int{30, 60, 120, 180, 240, 360, 480, 720}, "description": "EVERY: minutes between runs."},
			"until":    str("EVERY: the last slot of each day's window, local HH:mm, later than time (end of day when omitted). Use it for active hours."),
			"at":       str("ONCE: local YYYY-MM-DDTHH:mm."),
			"weekdays": map[string]interface{}{"type": "array", "description": "WEEKLY: the days. EVERY: the days it runs (all seven when omitted).", "items": map[string]interface{}{"type": "string", "enum": []string{"MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"}}},
		}
		for key, value := range whenRuleProps(obj) {
			props[key] = value
		}
		if !create {
			condition := props["condition"].(map[string]interface{})
			delete(condition, "required")
			condition["description"] = "WHEN only: the fields of the condition to change; the rest are kept. A changed " +
				"command waits for the owner's Allow, since they approved the old one."
		}
		return map[string]interface{}{
			"type": "object",
			"description": "When it runs, in the schedule's time zone: {kind: \"DAILY\", time: \"10:00\"}, " +
				"{kind: \"WEEKLY\", time: \"09:00\", weekdays: [\"MON\", \"THU\"]} (MON to SUN), {kind: \"ONCE\", at: " +
				"\"2026-11-16T18:00\"} for one run, {kind: \"EVERY\", minutes: 60, time: \"09:00\", until: \"18:00\", weekdays: [\"MON\", ...]} " +
				"for several runs a day (minutes is 30, 60, 120, 180, 240, 360, 480 or 720), or {kind: \"WHEN\", condition: {text, command, compare, ...}} for a run " +
				"each time something outside Orbit becomes true. A WHEN rule has no time; a schedule cannot change between " +
				"WHEN and a time.",
			"properties": props,
			"required":   []string{"kind"},
		}
	}
	access := map[string]interface{}{
		"type": "string", "enum": []string{"CHECK_ONLY", "OPEN_PR", "LAND"},
		"description": "What each run may do. CHECK_ONLY reads and reports and edits nothing: a check, a report, a " +
			"summary. OPEN_PR edits in its own worktree and opens a PR, and can't merge or deploy: only when the person " +
			"asked for changes. LAND edits in its own worktree and commits on its branch; after the turn and report Orbit " +
			"lands it on main through the normal merge check. LAND never opens a PR and cannot release or deploy. " +
			"Creating or widening to LAND needs the owner to allow it.",
	}
	runLimit := map[string]interface{}{"type": "integer", "minimum": 1, "maximum": 120, "description": "Minutes one run may work, 30 when omitted, at most 120."}
	timezone := str("IANA time zone the person named (\"Beijing time\" is Asia/Shanghai). Leave it out when they named none.")
	endAt := str("When the schedule ends by itself, as an ISO 8601 date-time. For \"for 6 hours\" or \"for 2 weeks\", compute it from the current time in the schedule's time zone (6 hours or 2 weeks from now), with that zone's offset.")
	maxRuns := map[string]interface{}{"type": "integer", "minimum": 1, "description": "The schedule ends after this many runs. For \"3 times\" or \"run it 10 times\", pass the count here instead of an endAt."}
	return []map[string]interface{}{
		{
			"name": "schedule_create",
			"description": "Propose a scheduled task, a new one: work Orbit runs by itself at each slot, in a new session of this " +
				"session's workspace, on its engine, until it is paused, ended or deleted. To change a schedule that " +
				"already exists (\"make it weekly instead\", \"move it to 09:00\", \"change the one we have\"), call " +
				"schedule_update on it instead, never schedule_create: find its scheduleId with schedule_list or " +
				"schedule_get. A schedule_create for one this session already created (same workspace, same title or " +
				"intent) raises no card and answers outcome EXISTS with that schedule's id. " + scheduleTimerChoice + " " +
				"This call does NOT create it. It puts a create card in front of the person (title, your read-back, When, " +
				"Runs in, May, Costs, Today) and returns at once with outcome PENDING. The schedule exists only when they " +
				"press Create, so tell them the card is waiting, never that it is scheduled. First, when you can, do the " +
				"check once yourself and pass what you found as baseline: the card shows it as Today, and the first run " +
				"won't report it as news. Ask the person only for what is theirs to decide (how often, what it may do), and " +
				"fill in the rest yourself. A WHEN rule needs that baseline and is refused without one: run the condition's " +
				"command once and pass what it read, such as {key: \"raw-used@87%\", summary: \"Raw used is 87% now\"}. " +
				conditionProbeRules + " " + scheduleDurationGuidance,
			"inputSchema": obj(map[string]interface{}{
				"intent":   str("The person's own words, verbatim. Kept as what was asked."),
				"title":    str("A short name for the list, such as \"Codex stable check\"."),
				"readBack": str("One sentence, in the first person, reading the schedule back to the person: \"Every day at 10:00 Beijing time I check ..., and tell you only when there is a new one.\""),
				"findings": str("What a new finding of this task is, as a plural noun, such as \"versions\" or \"issues\": the card ends \"You'll hear about new versions and failures only.\""),
				"prompt": str("What every run does, written for an agent that starts with no context: what to check, how to tell new " +
					"from already seen, the key to report a finding under (such as codex@0.48.1), and when to report CHANGED."),
				"rule":            ruleSchema(true),
				"timezone":        timezone,
				"accessLevel":     access,
				"runLimitMinutes": runLimit,
				"endAt":           endAt,
				"maxRuns":         maxRuns,
				"baseline": map[string]interface{}{
					"type":        "object",
					"description": "What your own check found today: recorded as already told, so the first run doesn't announce it. Required with a WHEN rule: what the condition's command read when you ran it.",
					"properties": map[string]interface{}{
						"key":     str("The finding's key, as a run would report it."),
						"summary": str("One line: what you found."),
						"links":   map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}},
					},
					"required": []string{"key"},
				},
			}, "intent", "title", "prompt", "rule", "accessLevel"),
		},
		{
			"name": "schedule_update",
			"description": "Change a schedule from what the person says (\"make it 9:00\", \"only on weekdays\", \"stop opening " +
				"PRs\"). A change inside what the person allowed (the envelope: workspace, access level, runs per week, run " +
				"limit) applies at once: the answer is outcome APPLIED with the record of the change, which the person can " +
				"undo. A change that grows the envelope (another workspace, a wider access level (OPEN_PR or LAND), more runs a week, a longer run limit) " +
				"applies nothing. It puts a card showing Now and Asked in front of the person and returns outcome PENDING, " +
				"and the schedule runs as before until they allow it. Leave intent out unless the person restates the goal " +
				"(what to watch, what counts as news): a change of time, frequency, limits or prompt leaves intent alone, " +
				"and a correction such as \"weekly is too rare, make it daily again\" is never the new intent. An intent " +
				"sent with only a change of when or how much it runs is not written. Whenever you change when or how often the schedule runs (rule or timezone), " +
				"pass a fresh readBack: one sentence saying when it runs and what it checks after the change. Pass one too when the prompt or access level changes. " +
				"A scheduled run may change only the schedule it serves: rewrite its prompt, run less often, or go back up to " +
				"what was allowed. A run's request to widen goes to the person's Waiting on you, and the run goes on with the " +
				"access it has.",
			"inputSchema": obj(map[string]interface{}{
				"scheduleId":      id,
				"intent":          str("Only when the person restates the goal: their new goal, verbatim. Never a correction of the time, frequency or limits."),
				"readBack":        str("The schedule read back as it is after this change, one first-person sentence of at most 500 characters, like schedule_create's: \"Every Monday at 09:00 Beijing time I check ...\". Pass it whenever the prompt, access, time or frequency changes; say both when it runs and what it checks. A readBack-only change applies at once and is undoable."),
				"title":           str("A new title."),
				"prompt":          str("New instructions for every run."),
				"rule":            ruleSchema(false),
				"timezone":        str("A new IANA time zone."),
				"accessLevel":     access,
				"runLimitMinutes": runLimit,
				"endAt":           map[string]interface{}{"type": []string{"string", "null"}, "description": "When it ends by itself (ISO 8601); null for never. For \"for 6 hours\", compute it from now in the schedule's time zone."},
				"maxRuns":         map[string]interface{}{"type": []string{"integer", "null"}, "minimum": 1, "description": "It ends after this many runs; null for no limit. Must be more than the runs already started."},
				"workspaceId":     str("Run it in another of the person's workspaces. Always needs their Allow."),
			}, "scheduleId"),
		},
		{
			"name":        "schedule_list",
			"description": "List the person's scheduled tasks, across every workspace: the rule, the state, the next run and the last result. Ended ones only when asked for.",
			"inputSchema": obj(map[string]interface{}{
				"state": str("ACTIVE, PAUSED, HELD or ENDED (comma-separated), or all. Every schedule that has not ended when omitted."),
			}),
		},
		{
			"name": "schedule_get",
			"description": "Read one scheduled task in full: the last result, the findings already reported, the note the last " +
				"run left, this month's use, the history (each change with who made it), and any card waiting on it. Use it " +
				"to answer \"what did the nightly check find this week?\".",
			"inputSchema": obj(map[string]interface{}{"scheduleId": id}, "scheduleId"),
		},
		{
			"name":        "schedule_pause",
			"description": "Pause a scheduled task: nothing runs until it is resumed, a waiting run is cancelled, and a run in progress continues. The person can undo it.",
			"inputSchema": obj(map[string]interface{}{"scheduleId": id}, "scheduleId"),
		},
		{
			"name":        "schedule_resume",
			"description": "Resume a paused or held scheduled task at its next slot after now. Slots missed while paused are not caught up. A held one is checked again first and stays held while a check still fails.",
			"inputSchema": obj(map[string]interface{}{"scheduleId": id}, "scheduleId"),
		},
		{
			"name": "schedule_run_now",
			"description": "Start one run of a scheduled task now, even while it is paused. Refused once it has ended. Every run started now " +
				"counts toward its runs a week: once the runs started in the past 7 days reach that number, a run now from an agent " +
				"session is refused with SCHEDULE_OVER_BUDGET, and only the person can still start one, from the app.",
			"inputSchema": obj(map[string]interface{}{"scheduleId": id}, "scheduleId"),
		},
		{
			"name":        "schedule_run_stop",
			"description": "Stop one run of a scheduled task: its session is interrupted and the run is cancelled. The schedule is unchanged.",
			"inputSchema": obj(map[string]interface{}{"runId": str("The run's id, as schedule_get lists it.")}, "runId"),
		},
		{
			"name": "schedule_end",
			"description": "End a scheduled task because its goal is reached (\"the migration shipped; nothing left to watch\"). " +
				"Nothing more runs, the person is told once, and they can undo it. A scheduled run may end the schedule it serves.",
			"inputSchema": obj(map[string]interface{}{"scheduleId": id}, "scheduleId"),
		},
		{
			"name":        "schedule_delete",
			"description": "Delete a scheduled task the person no longer wants. Nothing more runs; its runs and findings are kept.",
			"inputSchema": obj(map[string]interface{}{"scheduleId": id}, "scheduleId"),
		},
		{
			"name": scheduleRunReportTool,
			"description": "Report this scheduled run, exactly once, when you are done. This ends the run, and nothing you do " +
				"afterwards changes it. NO_CHANGE: nothing new, and nobody is told. CHANGED: something new, under a key " +
				"(such as codex@0.48.1). The person hears once per key, so a key already reported tells nobody. FAILED: the " +
				"check could not be done, and the person is told. Leave a note for the next run when it should know something " +
				"the prompt does not say, such as a moved URL or where you left off.",
			"inputSchema": obj(map[string]interface{}{
				"outcome": map[string]interface{}{"type": "string", "enum": []string{"NO_CHANGE", "CHANGED", "FAILED"}},
				"key":     str("Required with CHANGED: what tells this finding from others."),
				"summary": str("What this run found, in a sentence or two."),
				"links":   map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}, "description": "URLs that back the summary."},
				"note":    map[string]interface{}{"type": []string{"string", "null"}, "description": "Replaces the note the next run reads (at most 2000 characters); null clears it."},
			}, "outcome", "summary"),
		},
	}
}

// callScheduleTool runs one schedule tool for the session this server runs in, and reports whether it handled the
// name.
func (s *mcpServer) callScheduleTool(name string, args map[string]interface{}) (map[string]interface{}, bool) {
	if !scheduleToolNames[name] {
		return nil, false
	}
	session := strings.TrimSpace(s.sessionID)
	if session == "" && name != "schedule_list" && name != "schedule_get" {
		return toolResult(name+" acts as the session it is called from, and this MCP server is not running inside one", true), true
	}
	if name == scheduleRunReportTool && !s.scheduleRun {
		return toolResult("schedule_run_report reports a scheduled run, and this session serves none: nothing was reported", true), true
	}
	if name == "schedule_create" {
		if err := requireWhenBaseline(args); err != nil {
			return toolResult(name+" refused: "+err.Error(), true), true
		}
	}
	raw, err := runScheduleTool(s.t, session, name, args)
	if err != nil {
		return toolResult(name+" failed: "+err.Error(), true), true
	}
	return toolResult(scheduleToolText(name, raw), false), true
}

// scheduleToolText leads a PENDING answer with what it means, so a card is never reported as done, and an EXISTS
// answer with the schedule to change instead.
func scheduleToolText(name string, raw json.RawMessage) string {
	var head struct {
		Outcome string `json:"outcome"`
		Note    string `json:"note"`
	}
	_ = json.Unmarshal(raw, &head)
	if (head.Outcome == "PENDING" || head.Outcome == "EXISTS") && head.Note != "" {
		return head.Note + "\n" + prettyJSON(raw)
	}
	return prettyJSON(raw)
}

// scheduleBodyFields are the fields each write sends, as given.
var scheduleBodyFields = map[string][]string{
	"schedule_create":     {"intent", "title", "readBack", "findings", "prompt", "rule", "timezone", "accessLevel", "runLimitMinutes", "endAt", "maxRuns", "baseline"},
	"schedule_update":     {"intent", "title", "readBack", "prompt", "rule", "timezone", "accessLevel", "runLimitMinutes", "endAt", "maxRuns", "workspaceId"},
	scheduleRunReportTool: {"outcome", "key", "summary", "links", "note"},
}

func runScheduleTool(t *Transport, sessionID, name string, args map[string]interface{}) (json.RawMessage, error) {
	body := map[string]interface{}{}
	copyIfPresent(body, args, scheduleBodyFields[name]...)
	scheduleID := strings.TrimSpace(getString(args, "scheduleId"))
	path := ""
	method := "POST"
	needsID := true
	switch name {
	case "schedule_create":
		path, needsID = "/runner/schedules", false
	case "schedule_list":
		method, needsID = "GET", false
		path = "/runner/schedules"
		if state := strings.TrimSpace(getString(args, "state")); state != "" {
			path += "?state=" + url.QueryEscape(state)
		}
	case "schedule_get":
		method = "GET"
	case "schedule_update":
		method = "PATCH"
	case "schedule_delete":
		method = "DELETE"
	case "schedule_pause", "schedule_resume", "schedule_end":
		path = strings.TrimPrefix(name, "schedule_")
	case "schedule_run_now":
		path = "run"
	case "schedule_run_stop":
		runID := strings.TrimSpace(getString(args, "runId"))
		if runID == "" {
			return nil, errors.New("runId is required")
		}
		if err := validatePathSegmentID(runID); err != nil {
			return nil, err
		}
		path, needsID = "/runner/schedule-runs/"+url.PathEscape(runID)+"/stop", false
	case scheduleRunReportTool:
		path, needsID = "/runner/schedule-runs/report", false
	}
	if needsID {
		if scheduleID == "" {
			return nil, errors.New("scheduleId is required")
		}
		if err := validatePathSegmentID(scheduleID); err != nil {
			return nil, err
		}
		base := "/runner/schedules/" + url.PathEscape(scheduleID)
		if path != "" {
			base += "/" + path
		}
		path = base
	}
	var send interface{} = body
	if method == "GET" || method == "DELETE" {
		send = nil
	}
	var headers map[string]string
	if sessionID != "" {
		headers = sessionHeader(sessionID)
	}
	var out json.RawMessage
	err := t.doHeaders(nil, method, path, send, &out, taskOpTimeout, headers)
	return out, err
}
