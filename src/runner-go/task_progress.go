package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
)

// task_progress_report and `orbit task progress` (docs/watch-contract.md §12.1): a task's structured
// progress, as an agent states it through the runner's progress door. The Watch leaves
// TASK_PROGRESS_AT_LEAST and TASK_NO_PROGRESS_FOR decide from this report and from nothing else, so the
// text an agent reads says so: a position printed by a shell or written into a reply has not been
// reported, and a report that repeats itself or changes only its message has not progressed.

// The contract's progress limits (contracts/watch.contract.json progress.limits), repeated so the schema
// states the bounds a report would be refused against.
const (
	taskProgressMaxPhaseChars   = 80
	taskProgressMaxMessageChars = 500
	taskProgressMaxCount        = 2147483647
)

// taskProgressFields are what a report can name, besides the revision it is based on.
var taskProgressFields = []string{"phase", "current", "total", "message"}

func taskProgressDescriptor(obj func(map[string]interface{}, ...string) map[string]interface{}, taskIDProp map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{
		"name": "task_progress_report",
		"description": "Report where an Orbit task stands, or read it. A report states a position: a phase (a named " +
			"stage such as \"tests\"), a current count and the total it counts toward, with an optional message for " +
			"whoever reads it. Progress is only what is reported here: Orbit never infers it from your Bash output, a " +
			"transcript, a comment or a message. Only a change of phase, current or total is progress and moves " +
			"lastProgressAt, which a watch waiting for a stall reads; a message alone, or the same report repeated, is " +
			"not progress. Each field you pass replaces that field and null clears it; a field you omit is kept. Given " +
			"none of phase, current, total or message, it reads the progress and its revision instead. With " +
			"expectedRevision the report applies only if the progress is still at the revision you read: on 409 " +
			"PROGRESS_REVISION_CONFLICT, read it again, then report against the revision it shows. A DONE, CANCELLED or " +
			"FAILED task is refused with 409 TASK_NOT_OPEN; reopening it starts a new epoch with nothing reported. " +
			"taskId defaults to the current task.",
		"inputSchema": obj(map[string]interface{}{
			"taskId": taskIDProp,
			"phase": map[string]interface{}{
				"type":        []string{"string", "null"},
				"minLength":   1,
				"maxLength":   taskProgressMaxPhaseChars,
				"description": "The named stage the task is in, such as \"tests\". null clears it.",
			},
			"current": map[string]interface{}{
				"type":        []string{"integer", "null"},
				"minimum":     0,
				"maximum":     taskProgressMaxCount,
				"description": "How many units of the work are done. null clears it; a total needs a current beside it.",
			},
			"total": map[string]interface{}{
				"type":        []string{"integer", "null"},
				"minimum":     1,
				"maximum":     taskProgressMaxCount,
				"description": "How many units there are in all. It needs a current beside it, and current may not pass it. null clears it.",
			},
			"message": map[string]interface{}{
				"type":        []string{"string", "null"},
				"minLength":   1,
				"maxLength":   taskProgressMaxMessageChars,
				"description": "A note for whoever reads the progress. Never progress on its own, and no watch reads it. null clears it.",
			},
			"expectedRevision": map[string]interface{}{
				"type":        "integer",
				"minimum":     0,
				"description": "The revision you last read. The report applies only if the progress is still at it, and is refused with 409 PROGRESS_REVISION_CONFLICT otherwise. Omit it to report regardless.",
			},
		}),
	}
}

// runTaskProgressTool reports when args name any field of a report, and reads the progress otherwise.
func runTaskProgressTool(t *Transport, taskID string, args map[string]interface{}) (string, error) {
	body, err := taskProgressReportArgs(args)
	if err != nil {
		return "", err
	}
	const readAgain = "task_progress_report with only taskId"
	if body == nil {
		raw, err := t.getTaskProgress(taskID)
		if err != nil {
			return "", taskProgressCallError("read task progress", err, readAgain)
		}
		return describeTaskProgress(raw), nil
	}
	raw, err := t.reportTaskProgress(taskID, body)
	if err != nil {
		return "", taskProgressCallError("report task progress", err, readAgain)
	}
	return describeTaskProgress(raw), nil
}

// taskProgressReportArgs is the report args ask for, or nil when they name none of its fields and so ask
// for a read. A field present as null clears it, so presence is read from the map, not from the value.
func taskProgressReportArgs(args map[string]interface{}) (map[string]interface{}, error) {
	body := map[string]interface{}{}
	for _, field := range taskProgressFields {
		value, present := args[field]
		if !present {
			continue
		}
		if value == nil {
			body[field] = nil
			continue
		}
		if field == "phase" || field == "message" {
			text, ok := value.(string)
			if !ok {
				return nil, fmt.Errorf("%s must be a string, or null to clear it", field)
			}
			body[field] = text
			continue
		}
		count, ok := wholeNumberArg(value)
		if !ok {
			return nil, fmt.Errorf("%s must be a whole number, or null to clear it", field)
		}
		body[field] = count
	}
	if expected, present := args["expectedRevision"]; present && expected != nil {
		revision, ok := wholeNumberArg(expected)
		if !ok {
			return nil, fmt.Errorf("expectedRevision must be the whole-number revision you last read")
		}
		if len(body) == 0 {
			return nil, fmt.Errorf("expectedRevision guards a report: pass phase, current, total or message with it, or leave it out to read the progress")
		}
		body["expectedRevision"] = revision
	}
	if len(body) == 0 {
		return nil, nil
	}
	return body, nil
}

// wholeNumberArg reads an integer argument: a JSON number with nothing after the point, or the numeric
// string models send as often. The server holds the range.
func wholeNumberArg(value interface{}) (int64, bool) {
	switch v := value.(type) {
	case float64:
		if v == float64(int64(v)) {
			return int64(v), true
		}
	case string:
		if n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64); err == nil {
			return n, true
		}
	}
	return 0, false
}

// taskProgressAnswer is what the lead line reads from an answer; the whole answer is printed under it.
type taskProgressAnswer struct {
	TaskID         string `json:"taskId"`
	LifecycleEpoch int    `json:"lifecycleEpoch"`
	Revision       int    `json:"revision"`
	LastProgressAt string `json:"lastProgressAt"`
	// Changed is absent from a read, which is how a read is told from a report.
	Changed    *bool `json:"changed"`
	Progressed bool  `json:"progressed"`
}

// describeTaskProgress leads with what the answer means for the next report, then prints the answer.
func describeTaskProgress(raw json.RawMessage) string {
	var answer taskProgressAnswer
	if json.Unmarshal(raw, &answer) != nil || answer.TaskID == "" {
		return prettyJSON(raw)
	}
	return taskProgressLead(answer) + "\n" + prettyJSON(raw)
}

func taskProgressLead(a taskProgressAnswer) string {
	switch {
	case a.Changed == nil:
		return fmt.Sprintf("Task %s's progress is at revision %d, epoch %d. To report against exactly this, pass expectedRevision %d.",
			a.TaskID, a.Revision, a.LifecycleEpoch, a.Revision)
	case a.Progressed:
		return fmt.Sprintf("Recorded as progress at revision %d: the position changed, so lastProgressAt is now %s.", a.Revision, a.LastProgressAt)
	case *a.Changed:
		return fmt.Sprintf("Recorded at revision %d, but not as progress: only a change of phase, current or total is progress, "+
			"so lastProgressAt stays %s.", a.Revision, a.LastProgressAt)
	default:
		return fmt.Sprintf("Nothing changed: this report repeats what revision %d already records, so nothing was written and "+
			"it is not progress.", a.Revision)
	}
}

// taskProgressCallError says what failed. The two answers an agent must act on differently say what to do
// next: a moved revision is read again rather than resent, and a server without the door says so instead of
// reading like a task that does not exist. readAgain is how the caller reads the progress.
func taskProgressCallError(action string, err error, readAgain string) error {
	var httpErr *transportHTTPError
	if errors.As(err, &httpErr) {
		switch {
		case httpErr.statusCode == http.StatusConflict && strings.Contains(httpErr.body, "PROGRESS_REVISION_CONFLICT"):
			return fmt.Errorf("%s: %w\nThe progress changed after the revision you sent: read it again (%s), then report "+
				"against the revision it shows. Sending the same expectedRevision again is refused the same way", action, err, readAgain)
		case httpErr.statusCode == http.StatusNotFound && strings.Contains(httpErr.body, "Cannot "+httpErr.method+" "):
			return fmt.Errorf("%s: this Orbit server has no progress door for agents yet (it answered 404 for /api%s), so "+
				"this says nothing about whether the task exists. Upgrade the Orbit server to report progress", action, httpErr.path)
		}
	}
	return fmt.Errorf("%s: %w", action, err)
}

const taskProgressHelp = `orbit task progress — report or read a task's structured progress

Usage:
  orbit task progress [task-id] [--phase TEXT | --clear-phase] [--current N | --clear-current]
                      [--total N | --clear-total] [--message TEXT | --clear-message]
                      [--expected-revision N] [--json]

With none of --phase, --current, --total, --message or their --clear-* forms, this reads the
progress and its revision. Otherwise each flag given replaces that field, --clear-<field>
clears it, and a field not named is kept. --total needs a current beside it, and current may
not pass it.

Progress is only what is reported here: Orbit never infers it from shell output or a
transcript. Only a change of phase, current or total is progress and moves lastProgressAt; a
message alone, or the same report repeated, is not.

--expected-revision applies the report only if the progress is still at that revision. A 409
PROGRESS_REVISION_CONFLICT means it moved: read the progress again, then report against the
revision it shows. A DONE, CANCELLED or FAILED task is refused with 409 TASK_NOT_OPEN.

task-id defaults to ORBIT_TASK_ID inside an Orbit task session.
`

// cliTaskProgress is `orbit task progress`, the CLI half of task_progress_report.
func cliTaskProgress(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit task progress")
	phase := fs.String("phase", "", "the named stage the task is in")
	current := fs.Int("current", 0, "how many units of the work are done")
	total := fs.Int("total", 0, "how many units there are in all")
	message := fs.String("message", "", "a note for whoever reads the progress")
	clears := map[string]*bool{}
	for _, field := range taskProgressFields {
		clears[field] = fs.Bool("clear-"+field, false, "clear "+field)
	}
	expectedRevision := fs.Int("expected-revision", 0, "the revision the report is based on")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	id, err := resolveTaskCLIId(id, fs.Args())
	if err != nil {
		return err
	}
	given := map[string]interface{}{"phase": *phase, "current": *current, "total": *total, "message": *message}
	body := map[string]interface{}{}
	for _, field := range taskProgressFields {
		switch set := flagWasSet(fs, field); {
		case set && *clears[field]:
			return fmt.Errorf("--%s and --clear-%s contradict each other", field, field)
		case *clears[field]:
			body[field] = nil
		case set:
			body[field] = given[field]
		}
	}
	if flagWasSet(fs, "expected-revision") {
		if len(body) == 0 {
			return fmt.Errorf("--expected-revision guards a report: pass --phase, --current, --total or --message with it, or leave it out to read the progress")
		}
		body["expectedRevision"] = *expectedRevision
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	readAgain := "orbit task progress " + id
	var raw json.RawMessage
	if len(body) == 0 {
		if raw, err = t.getTaskProgress(id); err != nil {
			return taskProgressCallError("read task progress", err, readAgain)
		}
	} else if raw, err = t.reportTaskProgress(id, body); err != nil {
		return taskProgressCallError("report task progress", err, readAgain)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}
