package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

// The Watch tools (docs/watch-contract.md §13). An agent that has to wait on Orbit's own work asks the
// control plane to watch it and ends its turn, instead of holding the turn open in a sleep loop or in a
// background process that dies with its engine. Every watch made here observes the calling session, so a
// wake has somewhere to go, and the server holds it, so recycling this engine or restarting the runner
// loses nothing. `orbit watch`, `orbit task await` and `orbit session await` (watch_cli.go) send the same
// requests from flags.

// watchPredicateVersion is the grammar of every predicate this binary writes by itself: the await presets
// and session_create(wait) are all version-1 terms, which every Watch server accepts.
const watchPredicateVersion = 1

// watchPredicateVersions are the grammars watch_create and watch_update describe and send
// (contracts/watch.contract.json servedPredicateVersions). A predicate an agent writes goes out under the
// version it names or, when it names none, the lowest of these that has every term it uses
// (minimalWatchPredicateVersion). So a version-1 predicate stays version 1, which a server older than the
// later grammars still takes, and one that needs a later grammar is sent under it, which such a server
// refuses by name (PREDICATE_VERSION_UNSUPPORTED) instead of reading it under a grammar it was not written in.
var watchPredicateVersions = []int{1, 2, 3}

// watchLeafSinceVersion is the grammar each leaf first appears in (contract leaves[].sinceVersion).
var watchLeafSinceVersion = map[string]int{
	"SESSION_TURN_SETTLED":       1,
	"SESSION_RUN_TERMINAL":       1,
	"SESSION_LIFECYCLE_TERMINAL": 1,
	"SESSION_NEEDS_ATTENTION":    1,
	"TASK_TERMINAL":              1,
	"TASK_FAILED":                1,
	"TASK_DONE":                  1,
	"TASK_PROGRESS_AT_LEAST":     2,
	"TASK_NO_PROGRESS_FOR":       2,
	"SESSION_JOB_NO_OUTPUT_FOR":  3,
}

// The contract's limits, repeated so a schema states the bounds a request would be refused against.
const (
	watchMaxTargets           = 200
	watchMinTTLSeconds        = 60
	watchMaxTTLSeconds        = 2592000
	watchListLimit            = 100
	watchMinNoProgressSeconds = 60
	watchMinNoOutputSeconds   = 300
)

// minimalWatchPredicateVersion is the lowest grammar with every term of a predicate: AT_LEAST and a leaf's
// params arrive in version 2, and each leaf in its own (watchLeafSinceVersion). A kind or a leaf this
// binary does not know is sent under the newest grammar, so the server's refusal names everything it serves.
func minimalWatchPredicateVersion(term interface{}) int {
	newest := watchPredicateVersions[len(watchPredicateVersions)-1]
	node, _ := term.(map[string]interface{})
	if node == nil {
		return newest
	}
	version := 1
	raise := func(to int) {
		if to > version {
			version = to
		}
	}
	switch node["kind"] {
	case "ALL", "ANY":
	case "AT_LEAST":
		raise(2)
	case "ALL_OF", "ANY_OF":
		operands, _ := node["operands"].([]interface{})
		for _, operand := range operands {
			raise(minimalWatchPredicateVersion(operand))
		}
		return version
	default:
		return newest
	}
	if _, ok := node["params"]; ok {
		raise(2)
	}
	leaf, _ := node["leaf"].(string)
	since, known := watchLeafSinceVersion[leaf]
	if !known {
		return newest
	}
	raise(since)
	return version
}

// watchPredicateVersionArg is the version a watch_create or watch_update request carries: the one the agent
// named, passed on as given for the server to judge, or the predicate's own (minimalWatchPredicateVersion).
func watchPredicateVersionArg(args map[string]interface{}, predicate map[string]interface{}) interface{} {
	if version, ok := args["predicateVersion"]; ok && version != nil {
		return version
	}
	return minimalWatchPredicateVersion(predicate)
}

// watchStates is contracts/watch.contract.json states.watch.values.
var watchStates = []string{"ACTIVE", "PAUSED", "MATCHED", "EXPIRED", "CANCELLED", "REVOKED", "UNRESOLVABLE"}

// watchTargetRef is one target as the runner door takes it.
type watchTargetRef struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

func watchAggregate(kind, leaf string) map[string]interface{} {
	return map[string]interface{}{"kind": kind, "over": "ALL_TARGETS", "leaf": leaf}
}

func watchComposite(kind string, operands ...map[string]interface{}) map[string]interface{} {
	items := make([]interface{}, 0, len(operands))
	for _, operand := range operands {
		items = append(items, operand)
	}
	return map[string]interface{}{"kind": kind, "operands": items}
}

// watchAwaitPreset is one `until` an await tool offers: a name for a condition agents ask for all the time,
// and the v1 predicate it stands for. contracts/watch.contract.json agentSurface.awaitPresets holds the same
// table, and watch_tools_test.go keeps the two equal.
type watchAwaitPreset struct {
	until       string
	predicate   map[string]interface{}
	description string
}

// The first preset of each list is its default.
var taskAwaitPresets = []watchAwaitPreset{
	{
		until:       "ALL_TERMINAL_OR_ANY_FAILED",
		predicate:   watchComposite("ANY_OF", watchAggregate("ALL", "TASK_TERMINAL"), watchAggregate("ANY", "TASK_FAILED")),
		description: "every task is DONE, CANCELLED or FAILED, or any one of them FAILED, whichever comes first",
	},
	{
		until:       "ALL_TERMINAL",
		predicate:   watchAggregate("ALL", "TASK_TERMINAL"),
		description: "every task is DONE, CANCELLED or FAILED",
	},
	{
		until:       "ALL_DONE",
		predicate:   watchAggregate("ALL", "TASK_DONE"),
		description: "every task is DONE; a failure does not end this wait, so the watch expires instead",
	},
	{
		until:       "ANY_TERMINAL",
		predicate:   watchAggregate("ANY", "TASK_TERMINAL"),
		description: "the first task to be DONE, CANCELLED or FAILED",
	},
	{
		until:       "ANY_FAILED",
		predicate:   watchAggregate("ANY", "TASK_FAILED"),
		description: "the first task to fail",
	},
}

var sessionAwaitPresets = []watchAwaitPreset{
	{
		until: "ALL_SETTLED_OR_ANY_NEEDS_ATTENTION",
		predicate: watchComposite("ANY_OF",
			watchAggregate("ALL", "SESSION_TURN_SETTLED"), watchAggregate("ANY", "SESSION_NEEDS_ATTENTION")),
		description: "every session's turn has settled, or any one of them is waiting on a person to answer an approval, whichever comes first",
	},
	{
		until:       "ALL_SETTLED",
		predicate:   watchAggregate("ALL", "SESSION_TURN_SETTLED"),
		description: "every session's turn has settled: it is waiting for input, or its run is over",
	},
	{
		until:       "ANY_SETTLED",
		predicate:   watchAggregate("ANY", "SESSION_TURN_SETTLED"),
		description: "the first session whose turn settles",
	},
	{
		until:       "ALL_RUN_TERMINAL",
		predicate:   watchAggregate("ALL", "SESSION_RUN_TERMINAL"),
		description: "every session's run is over (succeeded, failed or ended); waiting for input is settled, not over",
	},
	{
		until:       "ANY_NEEDS_ATTENTION",
		predicate:   watchAggregate("ANY", "SESSION_NEEDS_ATTENTION"),
		description: "the first session with an approval waiting on a person",
	},
}

// awaitPreset resolves an await's `until`: the default when it is empty, and a refusal naming every preset
// when it names none of them.
func awaitPreset(presets []watchAwaitPreset, until string) (watchAwaitPreset, error) {
	until = strings.ToUpper(strings.TrimSpace(until))
	if until == "" {
		return presets[0], nil
	}
	for _, preset := range presets {
		if preset.until == until {
			return preset, nil
		}
	}
	return watchAwaitPreset{}, fmt.Errorf("until must be one of %s", strings.Join(awaitPresetNames(presets), ", "))
}

func awaitPresetNames(presets []watchAwaitPreset) []string {
	names := make([]string, 0, len(presets))
	for _, preset := range presets {
		names = append(names, preset.until)
	}
	return names
}

// awaitPresetProse is every preset with what it waits for, the default first and marked.
func awaitPresetProse(presets []watchAwaitPreset) string {
	parts := make([]string, 0, len(presets))
	for i, preset := range presets {
		part := preset.until + ": " + preset.description
		if i == 0 {
			part += " (the default)"
		}
		parts = append(parts, part)
	}
	return strings.Join(parts, "; ")
}

// awaitWatchBody is the watch an await makes: the preset's condition over exactly these ids, waking the
// calling session.
func awaitWatchBody(kind string, ids []string, preset watchAwaitPreset, ttlSeconds int, idempotencyKey string) map[string]interface{} {
	targets := make([]watchTargetRef, 0, len(ids))
	for _, id := range ids {
		targets = append(targets, watchTargetRef{Kind: kind, ID: id})
	}
	body := map[string]interface{}{
		"predicateVersion": watchPredicateVersion,
		"predicate":        preset.predicate,
		"targets":          targets,
		"action":           "RESUME_SESSION",
	}
	if ttlSeconds > 0 {
		body["ttlSeconds"] = ttlSeconds
	}
	if idempotencyKey != "" {
		body["idempotencyKey"] = idempotencyKey
	}
	return body
}

var watchPredicateGrammar = "The condition, in Orbit's closed grammar: no shell, SQL or free text, and the server runs no " +
	"command. A term is either {\"kind\":\"ALL\"|\"ANY\",\"over\":\"ALL_TARGETS\",\"leaf\":LEAF}, where ALL holds when " +
	"LEAF holds for every target and ANY when it holds for at least one, or {\"kind\":\"ALL_OF\"|\"ANY_OF\",\"operands\":" +
	"[terms]}, with at most 4 operands and 2 levels. Every leaf must be about the kind of every target. " +
	"Version 1 task leaves: TASK_TERMINAL (DONE, CANCELLED or FAILED), TASK_FAILED, TASK_DONE. Version 1 session leaves: " +
	"SESSION_TURN_SETTLED (no longer PENDING or RUNNING: waiting for input, or over; for a LANDING session, only " +
	"once its landing has ended), SESSION_RUN_TERMINAL (its run " +
	"SUCCEEDED, FAILED or ended), SESSION_LIFECYCLE_TERMINAL (moved to Completed or Trash), SESSION_NEEDS_ATTENTION (an " +
	"approval waits on a person). " +
	"Version 2 adds the quorum {\"kind\":\"AT_LEAST\",\"count\":N,\"over\":\"ALL_TARGETS\",\"leaf\":LEAF}, which holds " +
	"when LEAF holds for at least N of the targets, and \"params\" on the leaves that take them: TASK_PROGRESS_AT_LEAST " +
	"with {\"current\":N} or {\"percent\":P} (the progress the task reports with task_progress_report reaches a count, or " +
	"that share of its total), and TASK_NO_PROGRESS_FOR with {\"seconds\":S} (the task is still open and its reported " +
	"progress has not moved for S seconds, " + strconv.Itoa(watchMinNoProgressSeconds) + " at least). " +
	"Version 3 adds SESSION_JOB_NO_OUTPUT_FOR with {\"seconds\":S} or {\"seconds\":S,\"jobId\":\"bgj_...\"}: a job the " +
	"session started with bg_run and still has running (the one jobId names, or any of them) has written no output for S " +
	"seconds, " + strconv.Itoa(watchMinNoOutputSeconds) + " at least. Orbit's server decides it from the runner's " +
	"once-a-minute reports, so it holds even when that runner has died: the silence keeps growing. A job that has " +
	"ended no longer counts, so a watch on it alone waits until it expires; to hear about the session's run ending too, " +
	"put {\"kind\":\"ANY\",\"over\":\"ALL_TARGETS\",\"leaf\":\"SESSION_RUN_TERMINAL\"} beside it under ANY_OF. A watch " +
	"that resumes this session cannot name this session as a target: for this session's own job, start it with bg_run's " +
	"wakeOnStall instead. To catch an external system (CI, a deploy, a queue) stalling, there is no shell leaf: run a " +
	"polling script with bg_run that prints a line only when the state it polls changes, with wakeOnStall, so its " +
	"silence is the stall. \"All terminal or any failed\" is " +
	"{\"kind\":\"ANY_OF\",\"operands\":[{\"kind\":\"ALL\",\"over\":\"ALL_TARGETS\",\"leaf\":\"TASK_TERMINAL\"}," +
	"{\"kind\":\"ANY\",\"over\":\"ALL_TARGETS\",\"leaf\":\"TASK_FAILED\"}]}."

const watchIdempotencyKeyDescription = "Reuse it when retrying a call whose answer you never saw: the same key and request " +
	"return the watch already made instead of a second one."

// watchToolNames is the set callWatchTool answers for.
var watchToolNames = map[string]bool{
	"watch_create":  true,
	"watch_get":     true,
	"watch_list":    true,
	"watch_update":  true,
	"watch_cancel":  true,
	"task_await":    true,
	"session_await": true,
}

// callWatchTool runs one watch tool for the session this server runs in, and reports whether it handled
// the name.
func (s *mcpServer) callWatchTool(name string, args map[string]interface{}) (map[string]interface{}, bool) {
	if !watchToolNames[name] {
		return nil, false
	}
	if s.watchesOff {
		return toolResult(watchesOffMessage(name), true), true
	}
	if name == "session_await" && !s.orchestrationEnabled() {
		return toolResult(orchestrationOffMsg, true), true
	}
	if strings.TrimSpace(s.sessionID) == "" {
		return toolResult(name+" acts for the session it is called from, and this MCP server is not running inside one", true), true
	}
	text, err := runWatchTool(s.t, cliOrchestrationContext{sessionID: s.sessionID, token: s.orchestrationToken}, name, args)
	if err != nil {
		return toolResult(err.Error(), true), true
	}
	return toolResult(text, false), true
}

func runWatchTool(t *Transport, caller cliOrchestrationContext, name string, args map[string]interface{}) (string, error) {
	switch name {
	case "watch_create":
		targets, err := watchTargetsArg(args["targets"])
		if err != nil {
			return "", err
		}
		predicate, present, err := watchPredicateArg(args)
		if err != nil {
			return "", err
		}
		if !present {
			return "", fmt.Errorf("predicate is required: %s", headlineWatchPredicateHint())
		}
		body := map[string]interface{}{
			"predicateVersion": watchPredicateVersionArg(args, predicate),
			"predicate":        predicate,
			"targets":          targets,
		}
		if action := strings.ToUpper(strings.TrimSpace(getString(args, "action"))); action != "" {
			body["action"] = action
		}
		ttl, err := watchTTLArg(args)
		if err != nil {
			return "", err
		}
		if ttl > 0 {
			body["ttlSeconds"] = ttl
		}
		if key := strings.TrimSpace(getString(args, "idempotencyKey")); key != "" {
			body["idempotencyKey"] = key
		}
		raw, err := t.createWatch(caller.sessionID, caller.token, body)
		if err != nil {
			return "", watchCallError("create watch", err)
		}
		return describeWatch(raw, "create"), nil

	case "task_await", "session_await":
		kind, idsKey, presets := "TASK", "taskIds", taskAwaitPresets
		if name == "session_await" {
			kind, idsKey, presets = "SESSION", "sessionIds", sessionAwaitPresets
		}
		ids := uniqueStrings(getStringSlice(args, idsKey))
		if len(ids) == 0 {
			return "", fmt.Errorf("%s is required: the ids to wait for", idsKey)
		}
		preset, err := awaitPreset(presets, getString(args, "until"))
		if err != nil {
			return "", err
		}
		ttl, err := watchTTLArg(args)
		if err != nil {
			return "", err
		}
		body := awaitWatchBody(kind, ids, preset, ttl, strings.TrimSpace(getString(args, "idempotencyKey")))
		raw, err := t.createWatch(caller.sessionID, caller.token, body)
		if err != nil {
			return "", watchCallError(name, err)
		}
		return describeWatch(raw, "create"), nil

	case "watch_get":
		id, err := watchIDArg(args)
		if err != nil {
			return "", err
		}
		raw, err := t.getWatch(caller.sessionID, caller.token, id)
		if err != nil {
			return "", watchCallError("get watch", err)
		}
		return prettyJSON(raw), nil

	case "watch_list":
		raw, err := t.listWatches(caller.sessionID, caller.token, strings.ToUpper(strings.TrimSpace(getString(args, "state"))))
		if err != nil {
			return "", watchCallError("list watches", err)
		}
		return describeWatchList(raw), nil

	case "watch_update":
		id, err := watchIDArg(args)
		if err != nil {
			return "", err
		}
		body := map[string]interface{}{}
		predicate, present, err := watchPredicateArg(args)
		if err != nil {
			return "", err
		}
		if present {
			body["predicate"] = predicate
			body["predicateVersion"] = watchPredicateVersionArg(args, predicate)
		}
		ttl, err := watchTTLArg(args)
		if err != nil {
			return "", err
		}
		if ttl > 0 {
			body["ttlSeconds"] = ttl
		}
		if len(body) == 0 {
			return "", fmt.Errorf("nothing to update: pass predicate, ttlSeconds, or both")
		}
		raw, err := t.updateWatch(caller.sessionID, caller.token, id, body)
		if err != nil {
			return "", watchCallError("update watch", err)
		}
		return describeWatch(raw, "update"), nil

	case "watch_cancel":
		id, err := watchIDArg(args)
		if err != nil {
			return "", err
		}
		raw, err := t.cancelWatch(caller.sessionID, caller.token, id)
		if err != nil {
			return "", watchCallError("cancel watch", err)
		}
		return describeWatch(raw, "cancel"), nil
	}
	return "", fmt.Errorf("unknown watch tool %q", name)
}

// watchTargetsArg reads watch_create's targets. Kinds are passed on as given: the server answers a kind it
// does not watch with the contract's own refusal.
func watchTargetsArg(raw interface{}) ([]watchTargetRef, error) {
	items, _ := raw.([]interface{})
	if len(items) == 0 {
		return nil, fmt.Errorf(`targets is required: [{"kind":"TASK","id":"..."}, ...], each kind TASK or SESSION`)
	}
	targets := make([]watchTargetRef, 0, len(items))
	for i, item := range items {
		entry, _ := item.(map[string]interface{})
		kind := strings.ToUpper(strings.TrimSpace(getString(entry, "kind")))
		id := strings.TrimSpace(getString(entry, "id"))
		if kind == "" || id == "" {
			return nil, fmt.Errorf("targets[%d] needs a kind (TASK or SESSION) and an id", i)
		}
		targets = append(targets, watchTargetRef{Kind: kind, ID: id})
	}
	return targets, nil
}

// watchPredicateArg reads a predicate argument: a JSON object, or that object sent as a string, which models
// do. Absent and null are absent.
func watchPredicateArg(args map[string]interface{}) (map[string]interface{}, bool, error) {
	switch value := args["predicate"].(type) {
	case nil:
		return nil, false, nil
	case map[string]interface{}:
		return value, true, nil
	case string:
		predicate, err := parseWatchPredicateJSON(value)
		if err != nil {
			return nil, false, err
		}
		return predicate, true, nil
	}
	return nil, false, fmt.Errorf("predicate must be a JSON object: %s", headlineWatchPredicateHint())
}

func parseWatchPredicateJSON(text string) (map[string]interface{}, error) {
	var predicate map[string]interface{}
	if err := json.Unmarshal([]byte(strings.TrimSpace(text)), &predicate); err != nil || predicate == nil {
		return nil, fmt.Errorf("predicate must be a JSON object: %s", headlineWatchPredicateHint())
	}
	return predicate, nil
}

// headlineWatchPredicateHint shows the grammar by the request agents make most.
func headlineWatchPredicateHint() string {
	encoded, _ := json.Marshal(taskAwaitPresets[0].predicate)
	return "for example " + string(encoded) + " waits until every target task is terminal or any one of them failed"
}

// watchTTLArg reads ttlSeconds: 0 when absent or null, which leaves the server's 24-hour default.
func watchTTLArg(args map[string]interface{}) (int, error) {
	raw, present := args["ttlSeconds"]
	if !present || raw == nil {
		return 0, nil
	}
	ttl := -1
	switch value := raw.(type) {
	case float64:
		if value == float64(int(value)) {
			ttl = int(value)
		}
	case string:
		if parsed, err := strconv.Atoi(strings.TrimSpace(value)); err == nil {
			ttl = parsed
		}
	}
	if err := checkWatchTTL(ttl); err != nil {
		return 0, err
	}
	return ttl, nil
}

func checkWatchTTL(ttl int) error {
	if ttl < watchMinTTLSeconds || ttl > watchMaxTTLSeconds {
		return fmt.Errorf("ttlSeconds must be a whole number of seconds from %d to %d", watchMinTTLSeconds, watchMaxTTLSeconds)
	}
	return nil
}

func watchIDArg(args map[string]interface{}) (string, error) {
	id := strings.TrimSpace(getString(args, "watchId"))
	if id == "" {
		return "", fmt.Errorf("watchId is required")
	}
	if err := validatePathSegmentID(id); err != nil {
		return "", fmt.Errorf("watchId %w", err)
	}
	return id, nil
}

// watchSummary is what the tool results say about a watch; watch_get prints the whole of it.
type watchSummary struct {
	ID        string          `json:"id"`
	State     string          `json:"state"`
	Action    string          `json:"action"`
	Predicate json.RawMessage `json:"predicate"`
	ExpiresAt string          `json:"expiresAt"`
	CreatedAt string          `json:"createdAt"`
	// When the server evaluates the condition next (null once the watch has ended) and last did.
	NextEvaluateAt  *string `json:"nextEvaluateAt"`
	LastEvaluatedAt *string `json:"lastEvaluatedAt"`
	// How many of its wakes or notifications became dead letters. Nil from a server that does not count them,
	// which is left out of the summary rather than shown as none.
	DeadLetterCount *int `json:"deadLetterCount"`
	Targets         []struct {
		TargetKind string `json:"targetKind"`
		State      string `json:"state"`
	} `json:"targets"`
	Matches []struct {
		Generation int    `json:"generation"`
		MatchedAt  string `json:"matchedAt"`
		Reason     string `json:"reason"`
	} `json:"matches"`
}

func (w watchSummary) compact() map[string]interface{} {
	kinds, states := map[string]int{}, map[string]int{}
	for _, target := range w.Targets {
		kinds[target.TargetKind]++
		states[target.State]++
	}
	out := map[string]interface{}{
		"watchId":         w.ID,
		"state":           w.State,
		"action":          w.Action,
		"predicate":       w.Predicate,
		"expiresAt":       w.ExpiresAt,
		"createdAt":       w.CreatedAt,
		"nextEvaluateAt":  w.NextEvaluateAt,
		"lastEvaluatedAt": w.LastEvaluatedAt,
		"targets":         kinds,
		"targetStates":    states,
	}
	if w.DeadLetterCount != nil {
		out["deadLetterCount"] = *w.DeadLetterCount
	}
	if n := len(w.Matches); n > 0 {
		out["lastMatch"] = w.Matches[n-1]
	}
	return out
}

// describeWatch is a one-line account of where the watch stands and what happens next, then its summary.
func describeWatch(raw json.RawMessage, verb string) string {
	var w watchSummary
	if json.Unmarshal(raw, &w) != nil || w.ID == "" {
		return prettyJSON(raw)
	}
	body, err := json.MarshalIndent(w.compact(), "", "  ")
	if err != nil {
		return prettyJSON(raw)
	}
	return watchLead(w, verb) + "\n" + string(body)
}

func watchLead(w watchSummary, verb string) string {
	reason := ""
	if n := len(w.Matches); n > 0 {
		reason = w.Matches[n-1].Reason
	}
	wakes := w.Action != "NOTIFY_USER"
	switch {
	case verb == "cancel" && w.State == "CANCELLED":
		return fmt.Sprintf("Watch %s is CANCELLED: nothing will wake this session for it.", w.ID)
	case w.State == "ACTIVE" && wakes:
		return fmt.Sprintf("Watch %s is waiting, until %s at the latest. End your turn now: Orbit starts a turn in this "+
			"session when the condition holds, or once if the watch expires first. Do not poll or sleep to wait for it.",
			w.ID, w.ExpiresAt)
	case w.State == "ACTIVE":
		return fmt.Sprintf("Watch %s is waiting, until %s at the latest. When the condition holds, Orbit notifies the "+
			"person; it does not wake this session.", w.ID, w.ExpiresAt)
	case w.State == "MATCHED" && wakes:
		return fmt.Sprintf("Watch %s already holds (%s). Orbit starts a turn in this session with the full result once "+
			"this turn ends, so end your turn now.", w.ID, reason)
	case w.State == "MATCHED":
		return fmt.Sprintf("Watch %s already holds (%s), and Orbit is notifying the person.", w.ID, reason)
	default:
		return fmt.Sprintf("Watch %s is %s.", w.ID, w.State)
	}
}

func describeWatchList(raw json.RawMessage) string {
	var watches []watchSummary
	if json.Unmarshal(raw, &watches) != nil {
		return prettyJSON(raw)
	}
	rows := make([]map[string]interface{}, 0, len(watches))
	for _, w := range watches {
		rows = append(rows, w.compact())
	}
	body, err := json.MarshalIndent(rows, "", "  ")
	if err != nil {
		return prettyJSON(raw)
	}
	if len(watches) >= watchListLimit {
		return fmt.Sprintf("Showing this session's newest %d watches; narrow with state.\n%s", watchListLimit, body)
	}
	return string(body)
}

// watchDoorMissing reports a control plane that predates the runner watch door. A route Nest does not have
// answers 404 too, but never with "watch not found", the only 404 the door itself gives.
func watchDoorMissing(err error) bool {
	var httpErr *transportHTTPError
	return errors.As(err, &httpErr) && httpErr.statusCode == http.StatusNotFound &&
		strings.HasPrefix(httpErr.path, "/runner/watches") && !strings.Contains(httpErr.body, "watch not found")
}

// watchCallError says what failed. For a server without the door it says so in words: this binary can be
// newer than the control plane it talks to, and a bare 404 reads like a wrong watch id.
func watchCallError(action string, err error) error {
	// Before the missing door: the refusal of a server that has Watch off is a 404 too, on purpose.
	if watchesDisabledByServer(err) {
		return fmt.Errorf("%s: Watch is not on for this account on this Orbit server (%s), so it cannot hold this wait. "+
			"Do not fall back to polling with sleep, Bash loops or Monitor: look again in a later turn, or tell the user "+
			"what you are waiting for", action, watchesDisabledCode)
	}
	if watchDoorMissing(err) {
		return fmt.Errorf("%s: this Orbit server has no watch door for agents yet (it answered 404 for /api/runner/watches), "+
			"so it cannot hold a wait. Upgrade the Orbit server; until then do not fall back to polling with sleep or Bash "+
			"loops: tell the user what you are waiting for", action)
	}
	return fmt.Errorf("%s: %w", action, err)
}
