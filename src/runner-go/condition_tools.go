package main

// Conditions' agent side (docs/condition-triggers-design.md §8): work that starts when something outside Orbit
// becomes true. A condition exists only on a task (task_create's startWhen) or a schedule (schedule_create's WHEN
// rule), so there is no condition_create: the two create tools carry it, each with the baseline the agent read when
// it ran the command, and condition_get reads one back.

import (
	"encoding/json"
	"errors"
	"net/url"
	"strings"
)

const conditionGetTool = "condition_get"

// conditionTimerCase is the fifth row of the schedule design's "which timer" table, in the words schedule_create,
// schedule_wakeup, task_create and watch_create carry.
const conditionTimerCase = "\"When something outside Orbit becomes true\" (\"when a third OSD is in, set the pool to 3 " +
	"copies\", \"when Ceph is above 90%, look at what can be cleared\"): a condition, not a bg_run poll and not a daily " +
	"check. Deferred work that runs once is task_create with startWhen; a guard that runs at every crossing is " +
	"schedule_create with rule {kind: \"WHEN\", condition}. When a person answers a question with \"wait until X\", " +
	"propose that card instead of writing a note to yourself."

// conditionProbeRules is what an agent must know about the command it writes, said once for both create tools.
const conditionProbeRules = "The condition's command is a probe: the workspace's runner runs it unattended, with no " +
	"model and the workspace's own rights, every intervalSeconds, and the card shows it to the owner verbatim; their " +
	"Create approves that exact text. It must be read-only, and it answers with a number on the last line of stdout " +
	"(or, under EXIT_ZERO, with its exit code). Never write a secret into it: a probe that needs one reads it from the " +
	"workspace's environment. Run it once yourself first and pass what it read as the baseline: the card shows it as " +
	"Today, a condition that already holds fires at once, and a call without a baseline is refused. On an Orbit Cloud " +
	"workspace a condition keeps the workspace awake while it waits, which costs the owner compute."

// conditionProps are a condition's fields as both create tools take them. A WHEN rule also takes rearm and
// repeatSeconds; a task's startWhen fires once and takes neither.
func conditionProps(when bool) map[string]interface{} {
	ops := []string{"GT", "GTE", "LT", "LTE", "EQ", "EXIT_ZERO"}
	compare := func(description string) map[string]interface{} {
		return map[string]interface{}{
			"type":        "object",
			"description": description,
			"properties": map[string]interface{}{
				"op":    map[string]interface{}{"type": "string", "enum": ops},
				"value": map[string]interface{}{"type": []string{"number", "null"}, "description": "The number the reading is compared with; required unless op is EXIT_ZERO."},
			},
			"required": []string{"op"},
		}
	}
	maxInterval := 86400
	if when {
		maxInterval = 7 * 86400
	}
	props := map[string]interface{}{
		"text":    map[string]interface{}{"type": "string", "minLength": 1, "maxLength": 200, "description": "The condition in words, as the card and the Scheduled page show it: \"3 or more OSDs are in\"."},
		"command": map[string]interface{}{"type": "string", "minLength": 1, "maxLength": 4000, "description": "The probe: one read-only shell command, run in the workspace's directory, that prints a number on its last line (or exits 0 under EXIT_ZERO). Shown to the owner verbatim; no secret in it."},
		"compare": compare("What the reading must be for the condition to hold: {op: \"GTE\", value: 3}, or {op: \"EXIT_ZERO\"}."),
		"holdSeconds": map[string]interface{}{
			"type": "integer", "minimum": 0, "maximum": 30 * 86400,
			"description": "How long the comparison must keep holding before it fires; 0 (the default) fires on the first reading that holds.",
		},
		"intervalSeconds": map[string]interface{}{
			"type": "integer", "minimum": 60, "maximum": maxInterval,
			"description": "How often the runner checks: 300 when omitted, 60 at least.",
		},
		"timeoutSeconds": map[string]interface{}{"type": "integer", "minimum": 1, "maximum": 60, "description": "How long one check may run: 20 when omitted, 60 at most."},
		"unit":           map[string]interface{}{"type": []string{"string", "null"}, "maxLength": 16, "description": "How a reading is shown: \"%\", \"in\", \"GiB\"."},
	}
	if when {
		props["unit"] = map[string]interface{}{"type": []string{"string", "null"}, "maxLength": 20, "description": "How a reading is shown: \"%\", \"in\", \"GiB\"."}
		props["rearm"] = compare("When the condition is ready to fire again after it fired, for a reading that can hover at the line: \"above 90%, ready again below 85%\" is compare {op: \"GT\", value: 90} with rearm {op: \"LT\", value: 85}. Without one it is ready again as soon as the comparison is false.")
		props["repeatSeconds"] = map[string]interface{}{
			"type": "integer", "minimum": 900, "maximum": 7 * 86400,
			"description": "Fire again every this many seconds while it still holds and has not re-armed: for a guard whose run may fail to fix what it found, such as a service health check. At least 900 and at least intervalSeconds; each repeat is a run counted in runsPerWeek. Omit it to fire on the crossing only.",
		}
	}
	return props
}

// startWhenProp is task_create's (and each batch item's) startWhen: the condition and, inside it, the baseline.
func startWhenProp(obj func(map[string]interface{}, ...string) map[string]interface{}) map[string]interface{} {
	props := conditionProps(false)
	props["baseline"] = map[string]interface{}{
		"type":        "object",
		"description": "Required: what the command read when you ran it before this call. value for a comparison, exitCode under EXIT_ZERO.",
		"properties": map[string]interface{}{
			"value":    map[string]interface{}{"type": []string{"number", "null"}, "description": "The number on the last line of stdout."},
			"exitCode": map[string]interface{}{"type": []string{"integer", "null"}, "description": "The exit code."},
		},
	}
	schema := obj(props, "text", "command", "compare", "baseline")
	schema["description"] = "Start this task once, when something outside Orbit becomes true, in place of runAt: the " +
		"workspace named by assigneeId checks the command, and the task starts the way a due runAt starts it once the " +
		"condition holds. The card reads Starts when, Today and If never, and the task reads \"Waiting for: <text>\" " +
		"while it waits. Its run checks the condition again first, since the reading may have gone back. Needs an " +
		"assigneeId; cannot be combined with runAt or startNow. Read it back with condition_get, by the conditionId " +
		"task_get answers under startWhen. " + conditionProbeRules
	return schema
}

// whenRuleProps are what a schedule's rule adds for kind WHEN: its condition and its runs a week.
func whenRuleProps(obj func(map[string]interface{}, ...string) map[string]interface{}) map[string]interface{} {
	condition := obj(conditionProps(true), "text", "command", "compare")
	condition["description"] = "WHEN only: the condition whose firing starts each run. " + conditionProbeRules
	return map[string]interface{}{
		"condition": condition,
		"runsPerWeek": map[string]interface{}{
			"type": "integer", "minimum": 1, "maximum": 7,
			"description": "WHEN only: how many runs its firings may start in 7 days, 3 when omitted; a firing over it is recorded as missed.",
		},
	}
}

// requireWhenBaseline refuses a schedule_create of a WHEN rule that carries no baseline, before any card: the agent
// runs the probe once and passes what it read.
func requireWhenBaseline(args map[string]interface{}) error {
	rule, _ := args["rule"].(map[string]interface{})
	if kind, _ := rule["kind"].(string); kind != "WHEN" {
		return nil
	}
	baseline, _ := args["baseline"].(map[string]interface{})
	if strings.TrimSpace(getString(baseline, "key")) == "" {
		return errors.New("a WHEN rule needs a baseline: run the condition's command once and pass what it read as " +
			"baseline {key, summary}, such as {key: \"raw-used@87%\", summary: \"Raw used is 87% now\"}; nothing was proposed")
	}
	return nil
}

func conditionToolDescriptor(obj func(map[string]interface{}, ...string) map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{
		"name": conditionGetTool,
		"description": "Read one condition: its state (WAITING, HOLDING, FIRED, UNKNOWN or ENDED), the comparison and " +
			"command it checks, the newest samples (each reading, timeout or error) and its events (fired, fired again, " +
			"ready again, can't read, read again), newest first. Use it to answer \"what is it waiting for, and what did it " +
			"read last?\". A condition exists only on a task or a schedule: task_get answers a task's conditionId under " +
			"startWhen, schedule_get a WHEN schedule's under its rule. There is no condition_create: propose one with " +
			"task_create's startWhen or schedule_create's WHEN rule.",
		"inputSchema": obj(map[string]interface{}{
			"conditionId": map[string]interface{}{"type": "string", "description": "The condition's id."},
		}, "conditionId"),
	}
}

// callConditionTool runs condition_get, and reports whether it handled the name.
func (s *mcpServer) callConditionTool(name string, args map[string]interface{}) (map[string]interface{}, bool) {
	if name != conditionGetTool {
		return nil, false
	}
	raw, err := getCondition(s.t, getString(args, "conditionId"))
	if err != nil {
		return toolResult(name+" failed: "+err.Error(), true), true
	}
	return toolResult(prettyJSON(raw), false), true
}

func getCondition(t *Transport, id string) (json.RawMessage, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil, errors.New("conditionId is required")
	}
	if err := validatePathSegmentID(id); err != nil {
		return nil, err
	}
	var out json.RawMessage
	err := t.do(nil, "GET", "/runner/conditions/"+url.PathEscape(id), nil, &out, taskOpTimeout)
	return out, err
}

// parseStartWhenFlag reads `orbit task create --start-when JSON`, refusing a condition with no baseline before any
// card, as the MCP schema does.
func parseStartWhenFlag(raw string) (map[string]interface{}, error) {
	var condition map[string]interface{}
	if err := json.Unmarshal([]byte(raw), &condition); err != nil || condition == nil {
		return nil, errors.New("--start-when is a JSON object: {text, command, compare, baseline, ...}")
	}
	if _, ok := condition["baseline"].(map[string]interface{}); !ok {
		return nil, errors.New("--start-when needs a baseline: run the condition's command once and pass what it read " +
			"as \"baseline\": {\"value\": N} (or {\"exitCode\": N} under EXIT_ZERO); nothing was created")
	}
	return condition, nil
}
