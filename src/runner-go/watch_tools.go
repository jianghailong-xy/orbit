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

// watchPredicateVersion is the one grammar these tools describe (contracts/watch.contract.json).
const watchPredicateVersion = 1

// The contract's limits, repeated so a schema states the bounds a request would be refused against.
const (
	watchMaxTargets    = 200
	watchMinTTLSeconds = 60
	watchMaxTTLSeconds = 2592000
	watchListLimit     = 100
)

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

const watchPredicateGrammar = "The condition, in the closed v1 grammar: no shell, SQL or free text. A term is either " +
	"{\"kind\":\"ALL\"|\"ANY\",\"over\":\"ALL_TARGETS\",\"leaf\":LEAF}, where ALL holds when LEAF holds for every target and " +
	"ANY when it holds for at least one, or {\"kind\":\"ALL_OF\"|\"ANY_OF\",\"operands\":[terms]}, with at most 4 operands " +
	"and 2 levels. Task leaves: TASK_TERMINAL (DONE, CANCELLED or FAILED), TASK_FAILED, TASK_DONE. Session leaves: " +
	"SESSION_TURN_SETTLED (no longer PENDING or RUNNING: waiting for input, or over), SESSION_RUN_TERMINAL (its run " +
	"SUCCEEDED, FAILED or ended), SESSION_LIFECYCLE_TERMINAL (moved to Completed or Trash), SESSION_NEEDS_ATTENTION (an " +
	"approval waits on a person). Every leaf must be about the kind of every target. \"All terminal or any failed\" is " +
	"{\"kind\":\"ANY_OF\",\"operands\":[{\"kind\":\"ALL\",\"over\":\"ALL_TARGETS\",\"leaf\":\"TASK_TERMINAL\"}," +
	"{\"kind\":\"ANY\",\"over\":\"ALL_TARGETS\",\"leaf\":\"TASK_FAILED\"}]}."

const watchIdempotencyKeyDescription = "Reuse it when retrying a call whose answer you never saw: the same key and request " +
	"return the watch already made instead of a second one."

// watchToolDescriptors is the agent-facing contract of the watch tools every in-session agent has.
// session_await is sessionAwaitDescriptor: it watches sessions, so it rides the orchestration gate.
func watchToolDescriptors(obj func(map[string]interface{}, ...string) map[string]interface{}) []map[string]interface{} {
	watchIDProp := map[string]interface{}{
		"type":        "string",
		"description": "The watch id, as watch_create, task_await, session_await or watch_list returned it.",
	}
	predicateVersionProp := map[string]interface{}{
		"type":        "integer",
		"enum":        []int{watchPredicateVersion},
		"description": "The grammar version. Omit it for 1, the grammar described under predicate.",
	}
	keyProp := map[string]interface{}{"type": "string", "minLength": 1, "maxLength": 200, "description": watchIdempotencyKeyDescription}
	return []map[string]interface{}{
		{
			"name": "watch_create",
			"description": "Ask Orbit to watch Orbit tasks or sessions and wake this session when a condition holds. This is " +
				"how to wait on Orbit's own work: do not poll it with sleep, Bash loops, Monitor, bg_run or schedule_wakeup. " +
				"Orbit's server holds the watch, so it outlives this call, this engine being recycled and the runner " +
				"restarting. Name an explicit set of targets, fixed when the watch is made, and a predicate. The first time " +
				"the predicate holds, Orbit records one Match and starts a turn in THIS session carrying a structured payload " +
				"(watchId, generation, reason, changedTargets, latestSnapshot). A watch that ends without matching (it " +
				"expired, its permission was revoked, or every target is gone) also starts one turn saying so; a cancelled " +
				"one wakes nobody. After creating it, end your turn: nothing more is needed to be woken. For the common " +
				"waits, task_await and session_await build the predicate for you. Watching sessions needs orchestration, as " +
				"reading them does.",
			"inputSchema": obj(map[string]interface{}{
				"targets": map[string]interface{}{
					"type":     "array",
					"minItems": 1,
					"maxItems": watchMaxTargets,
					"items": obj(map[string]interface{}{
						"kind": map[string]interface{}{"type": "string", "enum": []string{"TASK", "SESSION"}},
						"id":   map[string]interface{}{"type": "string"},
					}, "kind", "id"),
					"description": "The tasks and sessions to watch, by id. The set is fixed when the watch is made: to wait " +
						"on a task list or a project, list its tasks first and name them.",
				},
				"predicate":        map[string]interface{}{"type": "object", "description": watchPredicateGrammar},
				"predicateVersion": predicateVersionProp,
				"action": map[string]interface{}{
					"type": "string",
					"enum": []string{"RESUME_SESSION", "NOTIFY_USER"},
					"description": "RESUME_SESSION, the default, starts a turn in this session. NOTIFY_USER sends the person " +
						"a notification instead and wakes nobody.",
				},
				"ttlSeconds": map[string]interface{}{
					"type":    "integer",
					"minimum": watchMinTTLSeconds,
					"maximum": watchMaxTTLSeconds,
					"description": "How long the watch may wait, from now: 60 seconds to 30 days, 24 hours when omitted. If " +
						"it runs out before the condition holds, this session is woken once with EXPIRED and the latest snapshot.",
				},
				"idempotencyKey": keyProp,
			}, "targets", "predicate"),
		},
		{
			"name": "watch_get",
			"description": "Read one of this session's watches in full: its state, each target as last evaluated, every " +
				"Match with its snapshot, and whether each wake or notification was delivered (a dead letter shows why). Read " +
				"it after being woken, or to see why a watch has not fired yet; do not call it in a loop to wait, since the " +
				"watch wakes you.",
			"inputSchema": obj(map[string]interface{}{"watchId": watchIDProp}, "watchId"),
		},
		{
			"name": "watch_list",
			"description": "List this session's watches, newest first and at most 100: each one's id, state, action, " +
				"condition, targets and deadline. This is how to find a watch made before an engine restart or a compaction.",
			"inputSchema": obj(map[string]interface{}{
				"state": map[string]interface{}{"type": "string", "enum": watchStates, "description": "Only watches in this state."},
			}),
		},
		{
			"name": "watch_update",
			"description": "Change the condition or the deadline of one of this session's live (ACTIVE or PAUSED) watches. " +
				"Its targets and its action stay as created: to watch something else, cancel it and create another. An " +
				"edited watch is evaluated again under what it now says.",
			"inputSchema": obj(map[string]interface{}{
				"watchId":          watchIDProp,
				"predicate":        map[string]interface{}{"type": "object", "description": watchPredicateGrammar},
				"predicateVersion": predicateVersionProp,
				"ttlSeconds": map[string]interface{}{
					"type":        "integer",
					"minimum":     watchMinTTLSeconds,
					"maximum":     watchMaxTTLSeconds,
					"description": "The new deadline, counted from now: 60 seconds to 30 days.",
				},
			}, "watchId"),
		},
		{
			"name": "watch_cancel",
			"description": "Cancel one of this session's watches. A cancelled watch wakes nobody, so cancel only a wait " +
				"you no longer need. A watch that already matched or ended cannot be cancelled.",
			"inputSchema": obj(map[string]interface{}{"watchId": watchIDProp}, "watchId"),
		},
		{
			"name": "task_await",
			"description": "Be woken when Orbit tasks finish. This is the one call for \"wake me when these tasks are all " +
				"DONE, CANCELLED or FAILED, or as soon as any of them fails\": it asks Orbit's server to watch exactly these " +
				"tasks for this session and returns at once, so end your turn then. When the condition holds, Orbit starts a " +
				"turn here saying which tasks changed, with a snapshot of all of them; if the watch expires first, one turn " +
				"says so. Use it instead of polling task_get or task_list, sleeping, or looping in Bash. The result names the " +
				"watch: watch_get reads it and watch_cancel stops it.",
			"inputSchema": obj(map[string]interface{}{
				"taskIds": map[string]interface{}{
					"type":     "array",
					"minItems": 1,
					"maxItems": watchMaxTargets,
					"items":    map[string]interface{}{"type": "string"},
					"description": "The tasks to wait for, by id. The set is fixed when the watch is made: to wait on a " +
						"task list or a project, list its tasks first and name them.",
				},
				"until": map[string]interface{}{
					"type":        "string",
					"enum":        awaitPresetNames(taskAwaitPresets),
					"description": "What to wait for. " + awaitPresetProse(taskAwaitPresets) + ".",
				},
				"ttlSeconds": map[string]interface{}{
					"type":        "integer",
					"minimum":     watchMinTTLSeconds,
					"maximum":     watchMaxTTLSeconds,
					"description": "How long to wait at most, from now: 60 seconds to 30 days, 24 hours when omitted.",
				},
				"idempotencyKey": keyProp,
			}, "taskIds"),
		},
	}
}

func sessionAwaitDescriptor(obj func(map[string]interface{}, ...string) map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{
		"name": "session_await",
		"description": "Be woken when other Orbit sessions finish their turn, need a person, or end: the sub-sessions you " +
			"started with session_create, for instance. It asks Orbit's server to watch exactly these sessions for this " +
			"session and returns at once, so end your turn then. When the condition holds, Orbit starts a turn here with " +
			"each session's state; if the watch expires first, one turn says so. Use it instead of polling session_get, " +
			"sleeping, or looping in Bash. A session cannot await itself.",
		"inputSchema": obj(map[string]interface{}{
			"sessionIds": map[string]interface{}{
				"type":        "array",
				"minItems":    1,
				"maxItems":    watchMaxTargets,
				"items":       map[string]interface{}{"type": "string"},
				"description": "The sessions to wait for, by id.",
			},
			"until": map[string]interface{}{
				"type":        "string",
				"enum":        awaitPresetNames(sessionAwaitPresets),
				"description": "What to wait for. " + awaitPresetProse(sessionAwaitPresets) + ".",
			},
			"ttlSeconds": map[string]interface{}{
				"type":        "integer",
				"minimum":     watchMinTTLSeconds,
				"maximum":     watchMaxTTLSeconds,
				"description": "How long to wait at most, from now: 60 seconds to 30 days, 24 hours when omitted.",
			},
			"idempotencyKey": map[string]interface{}{"type": "string", "minLength": 1, "maxLength": 200, "description": watchIdempotencyKeyDescription},
		}, "sessionIds"),
	}
}

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
		body := map[string]interface{}{"predicateVersion": watchPredicateVersion, "predicate": predicate, "targets": targets}
		if version, ok := args["predicateVersion"]; ok && version != nil {
			body["predicateVersion"] = version
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
			body["predicateVersion"] = watchPredicateVersion
			if version, ok := args["predicateVersion"]; ok && version != nil {
				body["predicateVersion"] = version
			}
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
	Targets   []struct {
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
		"watchId":      w.ID,
		"state":        w.State,
		"action":       w.Action,
		"predicate":    w.Predicate,
		"expiresAt":    w.ExpiresAt,
		"createdAt":    w.CreatedAt,
		"targets":      kinds,
		"targetStates": states,
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
