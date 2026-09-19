package main

import (
	"fmt"
	"io"
)

// "Do this one again" had no door of its own.
//
// A stopped task can be taken back in place — the status write, with any retirement cleared in the
// same request — but no verb said so, and the write on its own does not: on the rows where this
// matters most the record has to be cleared TOO. A SUPERSEDED or ABANDONED attempt is one §13.6 SU6
// refuses to RUN ("the work is being done by the successor"), and the same guard refuses the status
// write that would take the record away unless the request mentions both fields. So the move people
// made instead was to file another task — a different claim, and a worse one: it says a LATER
// ATTEMPT replaced this one, when what they meant was that this attempt is being picked up again.
//
// What this composes is that ONE write, in one place, because two doors reach it (MCP's
// `task_reopen` and `orbit task reopen`) and a body spelled twice is a body that drifts. The rules
// stay the server's, and every refusal arrives with its code and its required action and passes
// through unread: nothing here pre-judges a status, revokes a verdict, or softens a sentence. A
// verification task holding a verdict is told to revoke it first, because that is a different act
// with consequences of its own (a revoked PASS reopens the subject it settled).
func reopenTaskBody() map[string]interface{} {
	return map[string]interface{}{
		"status": "OPEN",
		// Spelled, not omitted — the whole point of the door. `TasksService.update`'s SU4 guard
		// fires exactly when a status write on a retired row names neither of these, so leaving
		// them out is what would make reopening a replaced attempt impossible rather than safe.
		"supersededByTaskId": nil,
		"terminalReason":     nil,
	}
}

const taskReopenHelp = `orbit task reopen — take a stopped task back to OPEN, in place

Usage:
  orbit task reopen [task-id] [--json]

For a task that stopped — DONE, CANCELLED or FAILED — and is being picked up again as
THIS task rather than as a new one. History is kept: evidence, comments, dependencies,
the project it is filed under and its criterion declaration all stay. The run's progress
does not — reopening starts a new lifecycle epoch, so a report aimed at the old revision
loses its compare-and-set.

A SUPERSEDED or ABANDONED record is cleared in the same write, which is what makes the
attempt runnable again: Run refuses a replaced task until the record is gone. Nothing is
pre-judged here — a refusal (a verification task carrying a verdict, say) comes back
with its code and the action that clears it.

task-id defaults to ORBIT_TASK_ID inside a task session.

Flags:
  --json   emit compact JSON instead of the pretty-printed task
`

func cliTaskReopen(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit task reopen")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	id, err := resolveTaskCLIId(id, fs.Args())
	if err != nil {
		return err
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	// The acting session, for the same reason every other task write passes it: the server's
	// scope rules are about which session is writing.
	_, sessionID := cliTaskAttribution()
	raw, err := t.updateTask(sessionID, id, reopenTaskBody())
	if err != nil {
		// Verbatim. The refusal block already carries the code and the executable next step, and a
		// client that rewrote either would be a second, weaker copy of the server's own boundary.
		return fmt.Errorf("reopen task: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}
