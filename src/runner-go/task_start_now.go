package main

import (
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// One approval for "create it and run it now", in two forms: the agent asks with startNow
// (task_create, each task_create_batch item, `orbit task create --start-now`), or the owner chooses
// "Create and start" on the single-task card (ApprovalDecisionResponse.StartAfterCreate). Without it a
// task in no project with no prerequisites starts by nothing at all — autoRunWhenReady is about
// prerequisites and never fires for one (independent-task-release.pg.spec.ts (11)) — so the owner who
// had just approved the create was asked a second time to start it.
//
// Both forms are a due schedule plus an immediate start, and nothing new on the server:
//
//   - runAt = now is written into the body BEFORE the card is raised, so the card's forecast (the
//     server's previewCreateMany, which counts a due runAt as startingNow) reads "1 starts running
//     within the minute" — the truth about what the yes will do;
//   - after the create, the task is started the way task_start starts one, so it does not wait for
//     the once-a-minute schedule scan;
//   - a refused start never undoes the create: the due runAt stays, and the scan (SCHEDULED_DUE_SQL,
//     which takes tasks in no project) starts the task once whatever refused it clears. The run that
//     starts clears runAt itself, so the schedule fires once either way.
//
// It lives in the tool handler rather than around it because a create whose card outlives the
// engine's call deadline is re-run, whole, by a runner-hosted job (handOffOwnerWait): the job takes
// the same path the call would have.

// errStartNowWithRunAt refuses the two answers to "when" given at once. Said before any card is raised.
var errStartNowWithRunAt = errors.New("startNow cannot be combined with runAt: startNow starts the task " +
	"as soon as it is created, runAt schedules its start for a set time. Pass one of them")

// hasExplicitRunAt says whether a create body already names a schedule. A null or blank runAt names
// none — on a create both mean "unscheduled" — so neither stands in startNow's way.
func hasExplicitRunAt(body map[string]interface{}) bool {
	value, present := body["runAt"]
	if !present || value == nil {
		return false
	}
	if text, ok := value.(string); ok && strings.TrimSpace(text) == "" {
		return false
	}
	return true
}

// applyStartNow makes a create body's start due now (dueNow). Refused beside an explicit runAt.
func applyStartNow(body map[string]interface{}, now time.Time) error {
	if hasExplicitRunAt(body) {
		return errStartNowWithRunAt
	}
	body["runAt"] = dueNow(now)
	return nil
}

// dueNow is the runAt of a start asked for now: the current UTC time to the second (RFC 3339), which
// the server already counts as due.
func dueNow(now time.Time) string {
	return now.UTC().Format(time.RFC3339)
}

// taskStarter is the start half of both task transports (the runner's and the person's).
type taskStarter interface {
	startTask(id, triggerID string) (json.RawMessage, error)
}

// startCreatedTask starts the task a create just answered with, and returns that answer followed by
// what became of the start. One run request, named once here exactly as task_start names its own, so
// a resend of the POST is the same request rather than a second run.
func startCreatedTask(t taskStarter, created json.RawMessage) (started json.RawMessage, deferred string) {
	var task struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(created, &task); err != nil || strings.TrimSpace(task.ID) == "" {
		return nil, startDeferredNote("the create's answer names no task id to start")
	}
	token, err := newRunRequestToken()
	if err != nil {
		return nil, startDeferredNote(err.Error())
	}
	started, err = t.startTask(task.ID, token)
	if err != nil {
		return nil, startDeferredNote(err.Error())
	}
	return started, ""
}

// startDeferredNote is the one line a create hands back when its immediate start was refused. The
// refusal is quoted on that one line: it says what stands in the way, and the scan waits for exactly
// that.
func startDeferredNote(reason string) string {
	return "Created, but its start was deferred: " + strings.Join(strings.Fields(reason), " ") +
		". Its runAt is already due, so the server's once-a-minute scan starts it as soon as that no longer " +
		"stands in the way; do not ask the person to start it again."
}

// startedTaskResult is what task_create returns when it also started the task: the created task as it
// always was, then the run that started it or the line saying the start was deferred.
func startedTaskResult(created, started json.RawMessage, deferred string) string {
	text := prettyJSON(created)
	if deferred != "" {
		return text + "\n\n" + deferred
	}
	return text + "\n\nStarted at once, as task_start would have started it, so do not call task_start for it:\n" +
		prettyJSON(started)
}
