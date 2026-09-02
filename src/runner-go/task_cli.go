package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

// Task list paging, mirroring the apiserver's own page defaults. The endpoint used to return an
// owner's entire task history in one body; both callers now ask for a bounded page.
const (
	defaultTaskListLimit = 100
	maxTaskListLimit     = 200
)

const taskHelp = `orbit task — manage Orbit tasks

Usage:
  orbit task list [--status STATUS] [--list-id ID] [--project-id ID] [--label L] [--limit N | --all [--cursor C]] [--json]
  orbit task labels [--list-id ID] [--json]
  orbit task get [task-id] [--json]
  orbit task evidence-list [task-id] [--json]
  orbit task evidence-submit [task-id] (--evidence JSON | --evidence-file -) [--source-session-id ID] [--idempotency-key KEY] [--json]
  orbit task attribution [task-id] [--json]
  orbit task create --title TITLE [options]
  orbit task create-batch (--tasks JSON | --tasks-file -) [--dry-run] [--json]
  orbit task update [task-id] [options]
  orbit task judge [task-id] --request-id ID --evidence-digest SHA256 (--evidence TEXT | --evidence-file -) [--json]
  orbit task delete [task-id] [--json]
  orbit task start [task-id] [--json]
  orbit task comment [task-id] (--body TEXT | --body-file -) [--json]
  orbit task dependency-graph [task-id] [--max-depth N] [--max-nodes N] [--json]
  orbit task dependency-add [task-id] --depends-on ID [--json]
  orbit task dependency-remove [task-id] --depends-on ID [--json]

When task-id is omitted, ORBIT_TASK_ID is used if this command is running inside
an Orbit task session. Run 'orbit task <command> --help' for command options.
`

const taskListHelp = `orbit task-list — manage Orbit task lists

Usage:
  orbit task-list list [--json]
  orbit task-list create --title TITLE [--json]
  orbit task-list get LIST_ID [--json]
  orbit task-list update LIST_ID [options]
  orbit task-list delete LIST_ID [--json]
`

var taskActionHelp = map[string]string{
	"list": `orbit task list — list tasks

Usage:
  orbit task list [--status OPEN|IN_PROGRESS|DONE|CANCELLED|FAILED] [--list-id ID] [--project-id ID] [--label L] [--limit N | --all [--cursor C]] [--json]

Returns the newest tasks first, without their descriptions (use ` + "`orbit task get`" + ` for one
task in full). --limit defaults to 100 and may not exceed 200.

--project-id narrows to the tasks filed under one project — the read a project coordinator
wants, since every other filter here answers across all of them. The id is the one in the web UI
URL (/projects/<id>); a raw UUID works too. A project that does not exist, or belongs to somebody
else, lists as empty like any other filter that matches nothing. Read ` + "`orbit project get`" + ` for what
the project is for; this is the work filed under it.

--label filters to tasks carrying ALL of the labels given (repeat the flag or comma-separate).
Labels are matched exactly, case included; ` + "`orbit task labels`" + ` lists the ones in use.

Filters combine: --project-id with --status OPEN answers "what is still open in this project".

--all returns every matching task instead of the newest page, walking the list one page at a
time — what you need to enumerate a list of thousands (to diff it against something else, say),
which no --limit can do. It can be a lot of output: scope it with --status/--list-id/--project-id,
and send it to a file or a pipe rather than into a conversation.

With --all the output is line-delimited JSON — one compact task per line, written as each page
arrives (--json is implied). A walk of tens of thousands is hundreds of requests over minutes, so
it is built to be interrupted: pages that already printed stay printed, a failing page is retried
for ~30s first, and if it still fails the cursor to resume from is printed to stderr. Continue
with --cursor CURSOR and the same filters. Use ` + "`jq -s`" + ` if you want one array back.
`,
	"labels": `orbit task labels — per-label progress across every task

Usage:
  orbit task labels [--list-id ID] [--json]

Reports each label in use with its own status breakdown (total/open/inProgress/done/failed/
cancelled), counted over every task carrying it — not over a page. This is the read that
labels exist for: asking it once answers for all of them, where ` + "`orbit task list --label`" + `
answers for one. Also how to find out how a label is actually spelled before filtering on it.

Labels are ranked by size and capped server-side; the response says how many exist in total
and whether it was truncated.
`,
	"get": `orbit task get — get a task, its comments, and linked sessions

Usage:
  orbit task get [task-id] [--json]

task-id defaults to ORBIT_TASK_ID inside an Orbit task session.
`,
	"evidence-list": `orbit task evidence-list — list explicit completion-evidence revisions

Usage:
  orbit task evidence-list [task-id] [--json]

Returns every immutable revision in task-local order. This does not inspect task comments or
Session status. task-id defaults to ORBIT_TASK_ID inside an Orbit task session.
`,
	"evidence-submit": `orbit task evidence-submit — submit structured completion evidence

Usage:
  orbit task evidence-submit [task-id] (--evidence JSON | --evidence-file -) [--source-session-id ID] [--idempotency-key KEY] [--json]

Evidence must be one JSON object. --evidence-file accepts only '-' (stdin). The source Session
defaults to ORBIT_SESSION_ID and must execute this task; its lifecycle state is irrelevant.
--idempotency-key makes transport retries return the same revision. Equivalent object-key order,
Unicode composition and line endings share one stable digest; changed evidence makes a new revision.
This command does not change task status and does not add a comment.
`,
	"create": `orbit task create — create a task

Usage:
  orbit task create --title TITLE [options]

Options:
  --description TEXT
  --description-file -        Read the description from stdin; filesystem paths are rejected
  --assignee-id ID            Defaults to ORBIT_AGENT_ID inside an agent session
  --unassigned                Explicitly leave the task unassigned
  --list-id ID
  --project-id ID             File the task under this project, orthogonal to --list-id
  --parent-task-id TASK_ID    Create it as a subtask of this existing task
  --verifies-task-id TASK_ID  File it as a VERIFICATION of that existing task
  --supersedes-task-id TASK_ID
                              Record, in this same write, that the new task REPLACES that
                              stopped attempt (CANCELLED or FAILED, same project, not
                              already replaced)
  --acceptance-criteria TEXT  What would settle that this task is done (max 4,000 characters)
  --acceptance-criteria-file -
                              Read the acceptance criteria from stdin; paths are rejected
  --criterion-key KEY         Which of the PROJECT's acceptance criteria this work serves — a
                              key from project_get. Required of a project's judgment session,
                              optional for everybody else
  --completion-criterion EXECUTABLE|VERIFICATION|EVIDENCE_JUDGMENT
				              Required for every runner-created task; EVIDENCE_JUDGMENT must be explicit
  --completion-criterion-override-reason TEXT
                              Why this task keeps a criterion after the server questions its shape
  --acceptance-command SHELL  EXECUTABLE's one command; requires the expected exit code
  --acceptance-expected-exit-code N
                              Expected EXITED code; non-exit terminations remain actionable
  --acceptance-timeout-seconds N
                              Requested v2 wall-clock budget (admitted exactly; never clamped)
  --acceptance-owner-timeout-ceiling-seconds N
                              Owner ceiling; a lower ceiling is rejected before spawn
  --due-date ISO_DATE
  --provider SLUG             Pin the run to a provider; defaults to the assignee's project
  --model MODEL               Pin the run to a model within that provider
  --depends-on ID[,ID...]     Repeatable prerequisite task ids; name the SUBJECT of the work,
                              not its verification task — a dependency on a verified task is
                              already held until that task's check PASSES
  --label L[,L...]            Repeatable grouping label, orthogonal to --list-id
  --auto-run-when-ready[=BOOL]
  --completion-policy MANUAL|ALL_CHILDREN_DONE|VERIFICATION_PASSED
                              How this task's own completion is decided once it has subtasks
  --json

--supersedes-task-id names the attempt this new task replaces, and records it in the SAME transaction
that creates the task: the predecessor keeps the CANCELLED or FAILED it ended with, and gains a
pointer to this task plus terminalReason SUPERSEDED. Prefer it over creating the replacement and
linking afterwards. Two calls leave a window, and the window is not theoretical — a fresh review
created in this project said "replacement for the earlier attempt" in its description, the second
call was never made, and months later the control loop dispatched the abandoned attempt again
because nothing structured said it had been replaced. Refused if the predecessor is still open,
belongs to another project or another owner, or has already been replaced (only one attempt can
take over from another, so two racing replacements produce one winner and one error).

--project-id files the new task under a project you own — what a coordinator wants when the
work it is creating belongs to the goal it was given. It is orthogonal to --list-id: the
project says what the work is FOR, the list decides how it is dispatched, and a task can have
one of each, either, or neither. The id is the one in the web UI URL (/projects/<id>); a raw
UUID works too. Unlike ` + "`orbit task list --project-id`" + `, which narrows a read and answers empty
for an id nobody owns, this writes — an unknown project, or one belonging to somebody else, is
rejected by the server rather than silently filed nowhere.

--parent-task-id creates the task as a subtask of a task that ALREADY exists, which is how a
piece of work is broken into steps that stay attached to it. The parent must be yours and must
be in the SAME project as the new task, and the project is never inherited from it: a subtask
under a project's task normally passes both --project-id and --parent-task-id naming that same
project, while a parent filed under no project needs --project-id omitted here too. A parent
that is missing, somebody else's, or in another project is rejected by the server.

--acceptance-criteria records what would settle that this task is done: the observable,
verifiable result — a command that passes, a file that exists, a number that moved — stated so
somebody who did not do the work can check it. It answers a different question from
--description, which says what work to PERFORM, and from a project's own acceptance criteria
(` + "`orbit project get`" + `), which settles the whole goal rather than this one task. The server
accepts up to 4,000 characters. --acceptance-criteria-file reads it from stdin, accepting only
'-'; since --description-file reads the same stdin, the two file flags cannot be used together,
but passing one field inline and the other on stdin is fine.

--completion-criterion declares one of three peer outcomes, never an escalation order:
EXECUTABLE compares one command's exit code, VERIFICATION reads the verdict of an independent
verification task (with --completion-policy VERIFICATION_PASSED), and EVIDENCE_JUDGMENT waits for one
an evidence judgment. Runner task creation never infers EVIDENCE_JUDGMENT: every task must pass the flag.
Related verifier, executable, and completion-policy flags do not replace that declaration.

Orbit conservatively compares acceptance-criteria wording with that choice. A mismatch returns
TASK_CRITERION_SHAPE_ADVICE with a suggestedCriterion and reason; it creates nothing. Either retry
with the suggested criterion, or deliberately keep the original one and pass a non-blank
--completion-criterion-override-reason. That explanation is stored on the task and returned by
task get; it is audit material, not completion evidence.

For EXECUTABLE, --acceptance-command and --acceptance-expected-exit-code must be passed together.
After the execution turn, that same task session runs the command once and records its untrimmed
combined output and typed termination. Only EXITED supplies a comparable exit code; TIMED_OUT,
CANCELLED, SIGNALED, START_FAILED and INFRASTRUCTURE_LOST keep the goal actionable. Passing
--acceptance-timeout-seconds opts into pre-spawn v2 admission, whose effective timeout must equal
the requested value. If one command is not enough, split the task instead of encoding a workflow
in the command fields. The exact cwd, environment, and PostgreSQL boundary are documented in
docs/task-completion-criteria.md.
`,
	"create-batch": `orbit task create-batch — create several tasks in one atomic call

Usage:
  orbit task create-batch (--tasks JSON | --tasks-file -) [--dry-run] [--json]

JSON is an array of task objects (or {"tasks": [...]}), each taking the same fields
as 'orbit task create': title (required), description, assigneeId, listId, projectId,
parentTaskId, verifiesTaskId, acceptanceCriteria, completionCriterion,
completionCriterionOverrideReason, acceptanceCommand,
acceptanceExpectedExitCode, dueDate, provider, model, dependsOnTaskIds, autoRunWhenReady,
completionPolicy. Nothing is written unless every item is valid.

Every item must set "completionCriterion" explicitly. EVIDENCE_JUDGMENT remains available when it is
intended, but omission never selects it on a runner write. Related verifier, executable, and
completion-policy fields do not replace that declaration.

"acceptanceCriteria" states per item what would settle that THAT task is done — the
observable result somebody else can check — where "description" says what work to
perform; the server accepts up to 4,000 characters each.

"acceptanceCommand" and "acceptanceExpectedExitCode" are the optional EXECUTABLE pair: one shell
command and the one exit code that derives DONE. Set both or neither. A different exit code
derives FAILED; needing several commands means the task should be split.

To make one item depend on another item of the same batch — whose id does not exist
yet — give the earlier item a "ref" and list it in the later item's "dependsOnRefs":

  [{"title":"Build","ref":"build"},
   {"title":"Deploy","dependsOnRefs":["build"]}]

A ref must name an EARLIER item; "dependsOnTaskIds" still takes ids of tasks that
already exist.

To make one item a PART OF another item of the same batch, name the earlier item's
ref in the later item's "parentRef" — how a plan lands as a tree in one call:

  [{"title":"Ship the importer","ref":"epic"},
   {"title":"Parse the feed","ref":"parse","parentRef":"epic"},
   {"title":"Backfill","parentRef":"epic","dependsOnRefs":["parse"]}]

The two ref fields answer different questions: "dependsOnRefs" is when an item may
run, "parentRef" is what it is a part of. "parentTaskId" is the same link to a task
that already exists, in the same project as the item carrying it; one item cannot
carry both, and a parentRef item must carry the same "projectId" as the item it
points at (the project is never inherited).

"verifiesRef" is the third ref, and the one that makes a phase and its check land in
ONE call — the later item VERIFIES the earlier one, which is what a
VERIFICATION_PASSED parent counts:

  [{"title":"Phase 1","ref":"p1","completionPolicy":"VERIFICATION_PASSED"},
   {"title":"Implement","parentRef":"p1"},
   {"title":"[VERIFY] Phase 1","verifiesRef":"p1"}]

"verifiesTaskId" is the same link to a subject that already exists; naming both is
rejected. Filed as two calls instead, the window between them is a parent that can
never complete. assigneeId defaults to ORBIT_AGENT_ID per item (pass null to leave
an item unassigned). --tasks-file accepts only '-' (stdin).

--dry-run judges the plan and writes none of it — not one task, and not even the
question a declared crossing would otherwise file. It answers with "plan": where every
item WOULD land (project id, title, status, acceptance epoch), "findings": every check
that refuses or warns, in a fixed order, and "wouldWrite": how many rows the real call
would add. Read it before a plan you cannot easily undo: a batch is the most
consequential thing an agent does here and the least visible — the request is fifty
titles, and the result is a graph of work filed against somebody's goals.

Options:
  --tasks JSON | --tasks-file -
  --dry-run                   Judge the plan and write nothing
  --json
`,
	"attribution": `orbit task attribution — where this work counts, and everything that follows

Usage:
  orbit task attribution [task-id] [--json]

One read, five answers:

  owning       the project this work COUNTS TOWARDS — its title, its Base62 id, its status
               and the acceptance epoch it is in. The only authoritative attribution there is
  discovery    where the work was NOTICED: the project it was found in, the trigger event, the
               source task and the source session. Evidence, and labelled as evidence —
               finding work somewhere grants nothing about where it may be filed
  acceptance   the project's stated criteria that cite this task, with the verdict each
               reached, the epoch it was reached in, and whether that is still the CURRENT
               epoch — an old PASS stays readable and stops counting
  crossing     the declared cross-project crossing that touches this task, its state, and the
               stable code and required action a writer meeting it is given
  blocker      the attribution blocker holding this work up, with its code, its owner and the
               one sentence that would clear it

Every absent fact is null beside a reason — NOT_CITED_BY_ACCEPTANCE and "this build cannot tell
you" are different answers, and a missing field says neither.

Read this BEFORE writing where you are not certain the work belongs. The alternative is learning
it from the refusal, which is after the decision has been made.

task-id defaults to ORBIT_TASK_ID.
`,
	"update": `orbit task update — update a task

Usage:
  orbit task update [task-id] [options]

Options:
  --title TITLE
  --description TEXT
  --description-file -        Read the description from stdin; filesystem paths are rejected
  --status OPEN|IN_PROGRESS|DONE|CANCELLED|FAILED
                              DONE is never a direct write; use the declared criterion instead
  --assignee-id ID | --clear-assignee
  --list-id ID | --clear-list
  --parent-task-id TASK_ID | --clear-parent
                              Move this task under that task, or detach it
  --verifies-task-id TASK_ID | --clear-verifies
                              Point this task at the task it verifies, or detach it
  --due-date ISO_DATE | --clear-due-date
  --provider SLUG | --clear-provider
  --model MODEL | --clear-model
  --acceptance-criteria TEXT  Replace what would settle that this task is done (max 4,000
                              characters)
  --acceptance-criteria-file -
                              Read the replacement criteria from stdin; paths are rejected
  --clear-acceptance-criteria Leave the task with no acceptance criteria
  --completion-criterion EXECUTABLE|VERIFICATION|EVIDENCE_JUDGMENT
                              Replace the task's one normal completion criterion
  --acceptance-command SHELL  Replace the one EXECUTABLE command
  --acceptance-expected-exit-code N
                              Replace the exit code that mechanically derives DONE
  --acceptance-timeout-seconds N | --clear-acceptance-timeout
                              Replace the v2 budget, or return to N-1 legacy acceptance
  --acceptance-owner-timeout-ceiling-seconds N
                              Replace the owner admission ceiling (never a clamp)
  --clear-executable-acceptance
                              Clear the command and expected exit code together
  --depends-on ID[,ID...]     Replace all prerequisites; repeatable. Name the SUBJECT of the
                              work, not its verification task — a dependency on a verified
                              task is already held until that task's check PASSES
  --clear-dependencies        Remove all prerequisites
  --label L[,L...]            Replace all labels; repeatable
  --clear-labels              Remove all labels
  --auto-run-when-ready[=BOOL]
  --completion-policy MANUAL|ALL_CHILDREN_DONE|VERIFICATION_PASSED
                              How this task's completion is decided once it has subtasks
  --verdict PASS|FAIL|INCONCLUSIVE | --clear-verdict
                              This VERIFICATION task's conclusion about the task it verifies
  --superseded-by-task-id TASK_ID | --clear-superseded
                              Record that a later attempt replaced this one, or unlink it. Only a
                              CANCELLED or FAILED task may name a successor, and the successor must
                              be in the same project. It writes nothing to --status: what the
                              attempt did is the fact being kept, not the one being tidied away
  --terminal-reason SUPERSEDED|ABANDONED | --clear-terminal-reason
                              Why this task stopped, when its status alone does not say. A
                              successor IS SUPERSEDED and needs no second spelling; ABANDONED is
                              for the other case, a task dropped with nothing replacing it
  --json

task-id defaults to ORBIT_TASK_ID inside an Orbit task session.

--acceptance-criteria records what would settle that this task is done: the observable,
verifiable result — a command that passes, a file that exists, a number that moved — stated so
somebody who did not do the work can check it. It answers a different question from
--description, which says what work to PERFORM, and from a project's own acceptance criteria
(` + "`orbit project get`" + `), which settle the whole goal rather than this one task; updating a task's
criteria never touches its project's. Expect to use it after the task was created — what proves
a task done is often only clear once the work is understood.

It replaces the whole field rather than appending to it. Omitting the flag leaves the criteria
the task already has untouched, passing text replaces them (` + "`--acceptance-criteria \"\"`" + ` records
that there are none worth stating), and --clear-acceptance-criteria removes them, so it cannot
be combined with either form. The server accepts up to 4,000 characters.
--acceptance-criteria-file reads the replacement from stdin, accepting only '-'; since
--description-file reads the same stdin, the two file flags cannot be used together, but passing
one field inline and the other on stdin is fine.

The completion criterion is one of EXECUTABLE, VERIFICATION, or EVIDENCE_JUDGMENT. They are peer
choices: EVIDENCE_JUDGMENT is not what happens when either other criterion fails. Omitting
--completion-criterion preserves the stored choice; it cannot be cleared.

No caller may write --status DONE. The refusal names the task's declared path: run the
EXECUTABLE command, obtain an independent VERIFICATION PASS, or use ` + "`orbit task judge`" + `
with non-empty evidence for EVIDENCE_JUDGMENT. FAILED remains writable by a run as its conservative
self-report.

The executable acceptance is exactly two fields: --acceptance-command and
--acceptance-expected-exit-code. Either flag may replace its stored half, while
--clear-executable-acceptance clears both; a task may never be left with only one. The task's own
session runs the command and the server derives DONE/FAILED from the actual exit code, without an
LLM verdict or coordinator approval.

--parent-task-id moves this task under another task you own, and --clear-parent detaches it and
leaves it standing on its own; omitting both leaves the parent it already has alone. A
decomposition is usually understood after the tasks exist — a step turns out to belong under a
different piece of work — so this is how it is corrected, rather than deleting the task and
recreating it. The parent must be in the SAME project as this task (re-file one of them first if
they differ), and a task can be neither its own parent nor a subtask of one of its own subtasks:
both close a loop and are rejected. It says what this task is PART OF and nothing about when it
runs — that is --depends-on.
`,
	"judge": `orbit task judge — decide an EVIDENCE_JUDGMENT task

Usage:
  orbit task judge [task-id] --request-id ID --evidence-digest SHA256
    (--evidence TEXT | --evidence-file -) [--json]

This decides the current evidence-bound EVIDENCE_JUDGMENT judgment request and writes an attributable
event: request id, evidence digest, the principal that decided, server time, and the non-empty
finding. In the same transaction the server derives task status DONE and closes the request and
its derived signal/blocker. A superseded request or mismatched digest is refused.

Inside a session the acting session is carried and recorded as the decider; headless, the decision
is attributed to the runner owner. Neither is refused — migration 0224 removed the human step from
this criterion and kept the evidence binding.

--evidence-file accepts only '-' (stdin), so the CLI itself never opens an arbitrary path.
task-id defaults to ORBIT_TASK_ID.
`,
	"delete": `orbit task delete — permanently delete a task

Usage:
  orbit task delete [task-id] [--json]

This cannot be undone. Comments and dependency edges are deleted; finished sessions
are retained and detached from the task, but a run still in flight is stopped — with
the task gone it has no way left to finish.

task-id defaults to ORBIT_TASK_ID inside an Orbit task session.
`,
	"start": `orbit task start — run a task on its assigned agent

Usage:
  orbit task start [task-id] [--json]

task-id defaults to ORBIT_TASK_ID inside an Orbit task session.
`,
	"comment": `orbit task comment — add a comment to a task

Usage:
  orbit task comment [task-id] (--body TEXT | --body-file -) [--json]

--body-file accepts only '-' (stdin), so the CLI itself never opens an arbitrary
path. task-id defaults to ORBIT_TASK_ID inside an Orbit task session.
`,
}

var taskListActionHelp = map[string]string{
	"list": `orbit task-list list — list task lists

Usage:
  orbit task-list list [--json]
`,
	"get": `orbit task-list get — one task list's dispatch policy and progress

Usage:
  orbit task-list get LIST_ID [--json]
`,
	"update": `orbit task-list update — change a task list's dispatch policy

Usage:
  orbit task-list update LIST_ID [options]

Options:
  --title TEXT                    rename the list (not recorded as a policy revision)
  --instructions TEXT             standing instructions spliced into every task run in this list
  --instructions-file -           read those instructions from stdin
  --paused true|false             hold or resume dispatch; runs already in flight are untouched
  --verify-on-done true|false     file a verification run when a task here reports DONE
  --max-concurrent N              cap this list's concurrently running tasks
  --clear-max-concurrent          remove that cap
  --foreman-workspace-id ID       workspace that runs this list's coordination when it stalls
  --foreman-stall-minutes N       minutes of no activity before a foreman is filed
  --clear-foreman                 stop filing a foreman for this list
  --note TEXT                     why — recorded on the revision this change creates
  --json                          emit compact JSON

Every policy change is recorded as a restorable revision. Only the flags you pass are
sent, so a partial edit never blanks the rest of the policy.
`,
	"create": `orbit task-list create — create a task list

Usage:
  orbit task-list create --title TITLE [--json]
`,
	"delete": `orbit task-list delete — delete a task list

Usage:
  orbit task-list delete LIST_ID [--json]

The list's tasks are not deleted: they are detached and become listless, keeping their
assignees, dependencies and sessions. What goes is the grouping, its standing
instructions, and its policy revisions — and that cannot be undone. To stop dispatch
without discarding any of it, use ` + "`orbit task-list update LIST_ID --paused true`" + `.
`,
}

// cmdTaskCLI is the native, agent-safe adapter for the Task subset of Orbit's
// built-in MCP tools. It calls Transport directly instead of piping JSON-RPC to
// `orbit mcp`, keeping CLI errors and output independent from the MCP envelope.
func cmdTaskCLI(args []string, in io.Reader, out io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		_, err := fmt.Fprint(out, taskHelp)
		return err
	}
	if args[0] == "help" {
		if len(args) == 1 {
			_, err := fmt.Fprint(out, taskHelp)
			return err
		}
		h, ok := taskActionHelp[args[1]]
		if !ok {
			return fmt.Errorf("unknown command %q", args[1])
		}
		_, err := fmt.Fprint(out, h)
		return err
	}
	action := args[0]
	if wantsHelp(args[1:]) {
		h, ok := taskActionHelp[action]
		if !ok {
			return fmt.Errorf("unknown command %q", action)
		}
		_, err := fmt.Fprint(out, h)
		return err
	}

	switch action {
	case "list":
		return cliTaskList(args[1:], out)
	case "labels":
		return cliTaskLabels(args[1:], out)
	case "get":
		return cliTaskGet(args[1:], out)
	case "evidence-list":
		return cliTaskEvidenceList(args[1:], out)
	case "evidence-submit":
		return cliTaskEvidenceSubmit(args[1:], in, out)
	case "attribution":
		return cliTaskAttributionRead(args[1:], out)
	case "create":
		return cliTaskCreate(args[1:], in, out)
	case "create-batch":
		return cliTaskCreateBatch(args[1:], in, out)
	case "update":
		return cliTaskUpdate(args[1:], in, out)
	case "judge":
		return cliTaskJudge(args[1:], in, out)
	case "delete":
		return cliTaskDelete(args[1:], out)
	case "start":
		return cliTaskStart(args[1:], out)
	case "comment":
		return cliTaskComment(args[1:], in, out)
	case "dependency-graph":
		return cliTaskDependencyGraph(args[1:], out)
	case "dependency-add":
		return cliTaskDependencyAdd(args[1:], out)
	case "dependency-remove":
		return cliTaskDependencyRemove(args[1:], out)
	default:
		return fmt.Errorf("unknown command %q\n\n%s", action, taskHelp)
	}
}

// cliTaskDependencyGraph mirrors the task_dependency_graph MCP tool: read the DAG a
// task sits in. --max-depth/--max-nodes default to 0, which the transport omits so the
// server applies its own caps — the same "unset means default" the MCP tool relies on.
func cliTaskDependencyGraph(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit task dependency-graph")
	maxDepth := fs.Int("max-depth", 0, "max dependency depth to walk (server default when unset)")
	maxNodes := fs.Int("max-nodes", 0, "max nodes to return (server default when unset)")
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
	raw, err := t.taskDependencyGraph(id, *maxDepth, *maxNodes)
	if err != nil {
		return fmt.Errorf("get task dependency graph: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

// cliTaskDependencyAdd mirrors task_dependency_add: add one edge, taskId waits for the
// --depends-on prerequisite. The granular edit that preserves every other edge, unlike
// `task update --depends-on` which replaces the whole set.
func cliTaskDependencyAdd(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit task dependency-add")
	dependsOn := fs.String("depends-on", "", "prerequisite task id this task waits for (required); name the SUBJECT, not its verification task — the server holds the edge until the subject's check PASSES")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	id, err := resolveTaskCLIId(id, fs.Args())
	if err != nil {
		return err
	}
	if strings.TrimSpace(*dependsOn) == "" {
		return fmt.Errorf("--depends-on is required")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.addTaskDependency(id, *dependsOn)
	if err != nil {
		return fmt.Errorf("add task dependency: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

// cliTaskDependencyRemove mirrors task_dependency_remove: drop one edge, leaving the
// rest of the DAG intact. Removing an absent edge is a no-op, matching the MCP tool.
func cliTaskDependencyRemove(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit task dependency-remove")
	dependsOn := fs.String("depends-on", "", "prerequisite task id to detach (required)")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	id, err := resolveTaskCLIId(id, fs.Args())
	if err != nil {
		return err
	}
	if strings.TrimSpace(*dependsOn) == "" {
		return fmt.Errorf("--depends-on is required")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.removeTaskDependency(id, *dependsOn)
	if err != nil {
		return fmt.Errorf("remove task dependency: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cmdTaskListCLI(args []string, in io.Reader, out io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		_, err := fmt.Fprint(out, taskListHelp)
		return err
	}
	if args[0] == "help" {
		if len(args) == 1 {
			_, err := fmt.Fprint(out, taskListHelp)
			return err
		}
		h, ok := taskListActionHelp[args[1]]
		if !ok {
			return fmt.Errorf("unknown command %q", args[1])
		}
		_, err := fmt.Fprint(out, h)
		return err
	}
	action := args[0]
	if wantsHelp(args[1:]) {
		h, ok := taskListActionHelp[action]
		if !ok {
			return fmt.Errorf("unknown command %q", action)
		}
		_, err := fmt.Fprint(out, h)
		return err
	}
	switch action {
	case "list":
		return cliTaskListList(args[1:], out)
	case "create":
		return cliTaskListCreate(args[1:], out)
	case "get":
		return cliTaskListGet(args[1:], out)
	case "update":
		return cliTaskListUpdate(args[1:], in, out)
	case "delete":
		return cliTaskListDelete(args[1:], out)
	case "propose-dag":
		return cliTaskListProposeDag(args[1:], out)
	default:
		return fmt.Errorf("unknown command %q\n\n%s", action, taskListHelp)
	}
}

func cliTransport() (*Transport, error) {
	if err := configStoragePrivate(); err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("no runner config — run `orbit register` first")
		}
		return nil, fmt.Errorf("runner credential storage is not private (%v); restart the Orbit runner once to migrate it", err)
	}
	cfg := loadConfig()
	if cfg == nil {
		return nil, fmt.Errorf("no runner config — run `orbit register` first")
	}
	return NewTransport(cfg.ServerURL, cfg.RunnerToken), nil
}

func newCLIFlagSet(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	return fs
}

func flagWasSet(fs *flag.FlagSet, name string) bool {
	set := false
	fs.Visit(func(f *flag.Flag) {
		if f.Name == name {
			set = true
		}
	})
	return set
}

func peelLeadingID(args []string) (string, []string) {
	if len(args) > 0 && args[0] != "-" && !strings.HasPrefix(args[0], "-") {
		return args[0], args[1:]
	}
	return "", args
}

func resolveTaskCLIId(leading string, trailing []string) (string, error) {
	if leading != "" && len(trailing) > 0 {
		return "", fmt.Errorf("unexpected arguments: %s", strings.Join(trailing, " "))
	}
	if leading == "" {
		if len(trailing) > 1 {
			return "", fmt.Errorf("expected at most one task id, got: %s", strings.Join(trailing, " "))
		}
		if len(trailing) == 1 {
			leading = trailing[0]
		}
	}
	if leading == "" {
		leading = strings.TrimSpace(os.Getenv("ORBIT_TASK_ID"))
	}
	if leading == "" {
		return "", fmt.Errorf("task id is required (or set ORBIT_TASK_ID inside a task session)")
	}
	if err := validatePathSegmentID(leading); err != nil {
		return "", fmt.Errorf("task %w", err)
	}
	return leading, nil
}

func rejectTrailing(fs *flag.FlagSet) error {
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected arguments: %s", strings.Join(fs.Args(), " "))
	}
	return nil
}

func validateTaskCLIStatus(status string) error {
	if status == "" {
		return nil
	}
	switch status {
	// FAILED is one of the five values `TaskStatus` has always had and the server has always
	// accepted; only this validator refused it, which made "put the task back the way the run left
	// it, and name what replaced it" a repair with no supported command behind it. A CLI that can
	// write four of five statuses forces the fifth through raw SQL, which is where an audit stops.
	case "OPEN", "IN_PROGRESS", "DONE", "CANCELLED", "FAILED":
		return nil
	default:
		return fmt.Errorf("status must be one of OPEN, IN_PROGRESS, DONE, CANCELLED, FAILED")
	}
}

func validateTaskCLICompletionPolicy(policy string) error {
	switch policy {
	case "MANUAL", "ALL_CHILDREN_DONE", "VERIFICATION_PASSED":
		return nil
	default:
		return fmt.Errorf("completion-policy must be one of MANUAL, ALL_CHILDREN_DONE, VERIFICATION_PASSED")
	}
}

func validateTaskCLICompletionCriterion(criterion string) error {
	switch criterion {
	case "EXECUTABLE", "VERIFICATION", "EVIDENCE_JUDGMENT":
		return nil
	default:
		return fmt.Errorf("completion-criterion must be one of EXECUTABLE, VERIFICATION, EVIDENCE_JUDGMENT")
	}
}

func validateTaskCLIVerdict(verdict string) error {
	switch verdict {
	case "PASS", "FAIL", "INCONCLUSIVE":
		return nil
	default:
		return fmt.Errorf("verdict must be one of PASS, FAIL, INCONCLUSIVE")
	}
}

func writeCLIRawJSON(out io.Writer, raw json.RawMessage, compact bool) error {
	if len(raw) == 0 {
		_, err := fmt.Fprintln(out, "null")
		return err
	}
	var buf bytes.Buffer
	var err error
	if compact {
		err = json.Compact(&buf, raw)
	} else {
		err = json.Indent(&buf, raw, "", "  ")
	}
	if err != nil {
		return fmt.Errorf("server returned invalid JSON: %w", err)
	}
	buf.WriteByte('\n')
	_, err = out.Write(buf.Bytes())
	return err
}

func readCLIText(in io.Reader, direct string, directSet bool, file string, fileSet bool, field string) (string, bool, error) {
	if directSet && fileSet {
		return "", false, fmt.Errorf("--%s and --%s-file cannot be used together", field, field)
	}
	if !fileSet {
		return direct, directSet, nil
	}
	if file != "-" {
		return "", false, fmt.Errorf("--%s-file accepts only '-' (stdin)", field)
	}
	b, err := io.ReadAll(in)
	if err != nil {
		return "", false, fmt.Errorf("read %s from stdin: %w", field, err)
	}
	return string(b), true, nil
}

type csvFlag []string

func (v *csvFlag) String() string { return strings.Join(*v, ",") }
func (v *csvFlag) Set(s string) error {
	for _, item := range strings.Split(s, ",") {
		if item = strings.TrimSpace(item); item != "" {
			*v = append(*v, item)
		}
	}
	return nil
}

func uniqueStrings(in []string) []string {
	seen := make(map[string]bool, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// A walk of tens of thousands of tasks is hundreds of sequential requests over minutes, so it
// will sooner or later span a control-plane restart — a container recreate is ~10-30s of 502s.
// Retrying the page absorbs that; the budget below waits 2+4+8+16s across four retries. It is
// deliberately bounded rather than the transport's own retry-forever: a terminal command that
// hangs is worse than one that stops and says where to resume from.
const (
	taskListPageAttempts     = 5
	taskListRetryInitialWait = 2 * time.Second
)

func listTaskPageWithRetry(t *Transport, status, listID, projectID string, labels []string, cursor string) (json.RawMessage, string, error) {
	wait := taskListRetryInitialWait
	var err error
	for attempt := 1; ; attempt++ {
		var page json.RawMessage
		var next string
		page, next, err = t.listTaskPage(status, listID, projectID, labels, maxTaskListLimit, cursor)
		if err == nil {
			return page, next, nil
		}
		// A 4xx will say the same thing however many times it is asked; only failures that can
		// clear on their own (timeout, 429, 5xx, a dropped connection) are worth another go.
		if attempt == taskListPageAttempts || !isRetryableTransportError(err) {
			return nil, "", err
		}
		time.Sleep(wait)
		wait *= 2
	}
}

// streamAllTasks walks every page of the filtered list, writing each task as its own line of
// JSON as it arrives. Line-delimited and streamed rather than one accumulated array, because
// both properties are what make a long walk survivable: a run killed at page 137 keeps the 136
// pages it already printed, and 27k rows never have to sit in memory waiting to be marshalled.
// `jq -s` puts them back into an array for anyone who wants one.
//
// Returns the cursor the walk died on, so the caller can tell the user where to resume.
func streamAllTasks(t *Transport, status, listID, projectID string, labels []string, cursor string, out io.Writer) (written int, failedAt string, err error) {
	encoder := json.NewEncoder(out)
	for {
		page, next, pageErr := listTaskPageWithRetry(t, status, listID, projectID, labels, cursor)
		if pageErr != nil {
			return written, cursor, pageErr
		}
		var items []json.RawMessage
		if err := json.Unmarshal(page, &items); err != nil {
			return written, cursor, fmt.Errorf("server returned invalid JSON: %w", err)
		}
		for _, item := range items {
			// Encode compacts and appends the newline, which is exactly one NDJSON record.
			if err := encoder.Encode(item); err != nil {
				return written, cursor, err
			}
			written++
		}
		if next == "" {
			return written, "", nil
		}
		cursor = next
	}
}

func cliTaskList(args []string, out io.Writer) error {
	fs := newCLIFlagSet("orbit task list")
	status := fs.String("status", "", "task status")
	listID := fs.String("list-id", "", "task list id")
	projectID := fs.String("project-id", "", "only tasks filed under this project")
	var labels csvFlag
	fs.Var(&labels, "label", "only tasks carrying ALL of these labels (comma-separated, repeatable)")
	limit := fs.Int("limit", defaultTaskListLimit, "maximum tasks to return")
	all := fs.Bool("all", false, "fetch every matching task, paging until the list is exhausted")
	cursor := fs.String("cursor", "", "resume an interrupted --all walk from this cursor")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	if err := validateTaskCLIStatus(*status); err != nil {
		return err
	}
	if flagWasSet(fs, "status") && *status == "" {
		return fmt.Errorf("--status cannot be empty")
	}
	// A cap on an answer that is by definition uncapped would only be ambiguous about which of
	// the two the caller meant.
	if *all && flagWasSet(fs, "limit") {
		return fmt.Errorf("--all and --limit are mutually exclusive: --all returns every matching task")
	}
	if !*all && (*limit < 1 || *limit > maxTaskListLimit) {
		return fmt.Errorf("--limit must be between 1 and %d", maxTaskListLimit)
	}
	// A cursor names a position in a walk; without one there is nothing to resume.
	if *cursor != "" && !*all {
		return fmt.Errorf("--cursor is only meaningful with --all")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	if *all {
		written, failedAt, err := streamAllTasks(t, *status, *listID, *projectID, labels, *cursor, out)
		if err != nil {
			// Whatever was already printed is on stdout and stays valid; stderr carries the one
			// thing needed to continue rather than start over.
			if failedAt != "" {
				fmt.Fprintf(os.Stderr,
					"orbit task list: stopped after %d task(s); resume with --cursor %s\n",
					written, failedAt)
			}
			return fmt.Errorf("list tasks: %w", err)
		}
		return nil
	}
	raw, err := t.listTasks(*status, *listID, *projectID, labels, *limit)
	if err != nil {
		return fmt.Errorf("list tasks: %w", err)
	}
	// A full page is the one case where the answer is silently partial, and stdout has to stay
	// parseable — so say so on stderr instead.
	if countJSONArray(raw) >= *limit {
		fmt.Fprintf(os.Stderr, "orbit task list: showing the newest %d tasks; narrow with --status/--list-id/--project-id/--label, raise --limit, or pass --all for every match\n", *limit)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

// cliTaskLabels mirrors the task_labels MCP tool: every label in scope with its own status
// breakdown, in one request. The counts come from the server because they are over every task
// carrying the label, not over whatever page a client could afford to download.
func cliTaskLabels(args []string, out io.Writer) error {
	fs := newCLIFlagSet("orbit task labels")
	listID := fs.String("list-id", "", "only labels used by tasks in this list")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.labelSummary(*listID)
	if err != nil {
		return fmt.Errorf("task labels: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliTaskGet(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit task get")
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
	raw, err := t.getTask(id)
	if err != nil {
		return fmt.Errorf("get task: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliTaskEvidenceList(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit task evidence-list")
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
	raw, err := t.listTaskEvidence(id)
	if err != nil {
		return fmt.Errorf("list task evidence: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliTaskEvidenceSubmit(args []string, in io.Reader, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit task evidence-submit")
	evidenceText := fs.String("evidence", "", "completion evidence as one JSON object")
	evidenceFile := fs.String("evidence-file", "", "read evidence JSON from stdin (-)")
	sourceSessionID := fs.String("source-session-id", "", "source task Session (defaults to ORBIT_SESSION_ID)")
	idempotencyKey := fs.String("idempotency-key", "", "caller retry identity (max 200 characters)")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	id, err := resolveTaskCLIId(id, fs.Args())
	if err != nil {
		return err
	}
	rawEvidence, evidenceSet, err := readCLIText(in, *evidenceText, flagWasSet(fs, "evidence"), *evidenceFile, flagWasSet(fs, "evidence-file"), "evidence")
	if err != nil {
		return err
	}
	if !evidenceSet || strings.TrimSpace(rawEvidence) == "" {
		return fmt.Errorf("--evidence or --evidence-file - is required")
	}
	var evidence map[string]interface{}
	if err := json.Unmarshal([]byte(rawEvidence), &evidence); err != nil || evidence == nil {
		if err == nil {
			err = fmt.Errorf("root is not an object")
		}
		return fmt.Errorf("evidence must be one JSON object: %w", err)
	}
	if strings.TrimSpace(*sourceSessionID) == "" {
		*sourceSessionID = strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID"))
	}
	if *sourceSessionID == "" {
		return fmt.Errorf("--source-session-id or ORBIT_SESSION_ID is required")
	}
	body := map[string]interface{}{"evidence": evidence}
	if strings.TrimSpace(*idempotencyKey) != "" {
		body["idempotencyKey"] = *idempotencyKey
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	agentID, _ := cliTaskAttribution()
	raw, err := t.submitTaskEvidence(id, agentID, *sourceSessionID, body)
	if err != nil {
		return fmt.Errorf("submit task evidence: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

// cliTaskAttributionRead is unit L7's read at a terminal: where this work counts, where it was
// noticed, which acceptance criteria cite it, what is being asked about it and what is stopping it.
//
// Named `...Read` because `cliTaskAttribution` is already taken by the in-session identity helper
// that decides which agent and session a write is attributed TO. Two different senses of the word,
// and the older one is on the write path — renaming it here would be renaming it there.
func cliTaskAttributionRead(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit task attribution")
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
	raw, err := t.getTaskAttribution(id)
	if err != nil {
		return fmt.Errorf("get task attribution: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliTaskCreate(args []string, in io.Reader, out io.Writer) error {
	fs := newCLIFlagSet("orbit task create")
	title := fs.String("title", "", "task title")
	description := fs.String("description", "", "task description")
	descriptionFile := fs.String("description-file", "", "read description from stdin (-)")
	assigneeID := fs.String("assignee-id", "", "assignee agent id")
	unassigned := fs.Bool("unassigned", false, "leave task unassigned")
	listID := fs.String("list-id", "", "task list id")
	projectID := fs.String("project-id", "", "file the task under this project, orthogonal to --list-id")
	parentTaskID := fs.String("parent-task-id", "", "make the new task a subtask of this existing task")
	verifiesTaskID := fs.String("verifies-task-id", "", "file the new task as a verification of this existing task")
	supersedesTaskID := fs.String("supersedes-task-id", "", "record that this new task REPLACES that stopped attempt, in the same write")
	acceptanceCriteria := fs.String("acceptance-criteria", "", "what would settle that this task is done")
	acceptanceCriteriaFile := fs.String("acceptance-criteria-file", "", "read the acceptance criteria from stdin (-)")
	criterionKey := fs.String("criterion-key", "", "which of the project's acceptance criteria this work serves")
	completionCriterion := fs.String("completion-criterion", "", "completion criterion (EXECUTABLE|VERIFICATION|EVIDENCE_JUDGMENT)")
	completionCriterionOverrideReason := fs.String("completion-criterion-override-reason", "", "why this task keeps a criterion after TASK_CRITERION_SHAPE_ADVICE")
	acceptanceCommand := fs.String("acceptance-command", "", "the one EXECUTABLE shell acceptance command")
	acceptanceExpectedExitCode := fs.Int("acceptance-expected-exit-code", 0, "exit code that mechanically derives DONE")
	acceptanceTimeoutSeconds := fs.Int("acceptance-timeout-seconds", 0, "requested v2 EXECUTABLE timeout (seconds, exact; never clamped)")
	acceptanceOwnerTimeoutCeilingSeconds := fs.Int("acceptance-owner-timeout-ceiling-seconds", 0, "owner ceiling checked before spawn")
	dueDate := fs.String("due-date", "", "ISO due date")
	provider := fs.String("provider", "", "run on this provider instead of the assignee's")
	model := fs.String("model", "", "run on this model instead of the assignee's")
	var dependsOn csvFlag
	fs.Var(&dependsOn, "depends-on", "comma-separated prerequisite task ids (repeatable)")
	var labels csvFlag
	fs.Var(&labels, "label", "grouping label, orthogonal to --list-id (comma-separated, repeatable)")
	autoRun := fs.Bool("auto-run-when-ready", false, "auto-run after dependencies complete")
	completionPolicy := fs.String("completion-policy", "", "how this task's completion is decided (MANUAL|ALL_CHILDREN_DONE|VERIFICATION_PASSED)")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	if strings.TrimSpace(*title) == "" {
		return fmt.Errorf("--title is required")
	}
	if *unassigned && flagWasSet(fs, "assignee-id") {
		return fmt.Errorf("--unassigned and --assignee-id cannot be used together")
	}
	commandSet := flagWasSet(fs, "acceptance-command")
	exitSet := flagWasSet(fs, "acceptance-expected-exit-code")
	if commandSet != exitSet {
		return fmt.Errorf("--acceptance-command and --acceptance-expected-exit-code must be used together")
	}
	if commandSet && strings.TrimSpace(*acceptanceCommand) == "" {
		return fmt.Errorf("--acceptance-command cannot be blank")
	}
	timeoutSet := flagWasSet(fs, "acceptance-timeout-seconds")
	ownerCeilingSet := flagWasSet(fs, "acceptance-owner-timeout-ceiling-seconds")
	if timeoutSet && !commandSet {
		return fmt.Errorf("--acceptance-timeout-seconds requires the executable command/expected-exit pair")
	}
	if ownerCeilingSet && !timeoutSet {
		return fmt.Errorf("--acceptance-owner-timeout-ceiling-seconds requires --acceptance-timeout-seconds")
	}
	if timeoutSet && (*acceptanceTimeoutSeconds < 1 || *acceptanceTimeoutSeconds > 86400) {
		return fmt.Errorf("--acceptance-timeout-seconds must be between 1 and 86400")
	}
	if ownerCeilingSet && (*acceptanceOwnerTimeoutCeilingSeconds < 1 || *acceptanceOwnerTimeoutCeilingSeconds > 86400) {
		return fmt.Errorf("--acceptance-owner-timeout-ceiling-seconds must be between 1 and 86400")
	}
	if flagWasSet(fs, "completion-criterion") {
		if err := validateTaskCLICompletionCriterion(*completionCriterion); err != nil {
			return err
		}
	}
	// Two fields, one stdin. readCLIText sees a single field at a time, so nothing downstream can
	// notice that the first read drains the stream and the second gets an empty string — a create
	// that silently files blank criteria. Caught here, before either read and before any request:
	// one of the pair has to be passed inline. A direct value for one and stdin for the other is
	// unambiguous and stays legal.
	if flagWasSet(fs, "description-file") && flagWasSet(fs, "acceptance-criteria-file") {
		return fmt.Errorf("--description-file and --acceptance-criteria-file both read stdin and cannot be used together; pass one of them inline")
	}
	desc, descSet, err := readCLIText(in, *description, flagWasSet(fs, "description"), *descriptionFile, flagWasSet(fs, "description-file"), "description")
	if err != nil {
		return err
	}
	criteria, criteriaSet, err := readCLIText(in, *acceptanceCriteria, flagWasSet(fs, "acceptance-criteria"), *acceptanceCriteriaFile, flagWasSet(fs, "acceptance-criteria-file"), "acceptance-criteria")
	if err != nil {
		return err
	}
	body := map[string]interface{}{"title": *title}
	if descSet {
		body["description"] = desc
	}
	if *unassigned {
		body["assigneeId"] = nil
	} else if flagWasSet(fs, "assignee-id") {
		if strings.TrimSpace(*assigneeID) == "" {
			return fmt.Errorf("--assignee-id cannot be empty; use --unassigned")
		}
		body["assigneeId"] = *assigneeID
	} else if agentID := strings.TrimSpace(os.Getenv("ORBIT_AGENT_ID")); agentID != "" {
		body["assigneeId"] = agentID
	}
	if flagWasSet(fs, "list-id") {
		if strings.TrimSpace(*listID) == "" {
			return fmt.Errorf("--list-id cannot be empty")
		}
		body["listId"] = *listID
	}
	// Orthogonal to listId: the project states what the work is for, the list decides how it is
	// dispatched. Only sent when asked for, so a create that names no project is byte-for-byte the
	// request it was before this flag existed.
	if flagWasSet(fs, "project-id") {
		if strings.TrimSpace(*projectID) == "" {
			return fmt.Errorf("--project-id cannot be empty")
		}
		body["projectId"] = *projectID
	}
	// Which of the project's stated acceptance criteria this work serves. Only sent when asked
	// for: the server requires it of a project's judgment session and of nobody else, so a create
	// that omits it is byte-for-byte the request it was before this flag existed.
	if flagWasSet(fs, "criterion-key") {
		if strings.TrimSpace(*criterionKey) == "" {
			return fmt.Errorf("--criterion-key cannot be empty")
		}
		body["criterionKey"] = *criterionKey
	}
	// The server checks the parent against the projectId sent on THIS request and never infers one
	// from the parent, so a subtask of a project's task has to name both. Same present-only rule as
	// the flags above: absent leaves the body untouched, blank is caught before the round trip.
	if flagWasSet(fs, "parent-task-id") {
		if strings.TrimSpace(*parentTaskID) == "" {
			return fmt.Errorf("--parent-task-id cannot be empty")
		}
		body["parentTaskId"] = *parentTaskID
	}
	// What this task exists to CHECK. Distinct from --parent-task-id in the same way membership is
	// distinct from ordering: a verification is not part of its subject, it is a second opinion
	// about it, and the server refuses the shapes where that stops being true.
	if flagWasSet(fs, "verifies-task-id") {
		if strings.TrimSpace(*verifiesTaskID) == "" {
			return fmt.Errorf("--verifies-task-id cannot be empty")
		}
		body["verifiesTaskId"] = *verifiesTaskID
	}
	// The attempt this new task REPLACES. One request creates the successor and records the
	// supersession together, which is the whole point: the two-call version leaves a window where
	// the replacement exists and nothing structured says what it replaced, and this deployment's
	// control loop later re-dispatched an abandoned attempt that had spent weeks in that window.
	if flagWasSet(fs, "supersedes-task-id") {
		if strings.TrimSpace(*supersedesTaskID) == "" {
			return fmt.Errorf("--supersedes-task-id cannot be empty")
		}
		body["supersedesTaskId"] = *supersedesTaskID
	}
	// Free text, not an id, so the blank-is-a-typo rule above does not apply: the server's DTO has
	// no MinLength, and `--acceptance-criteria ""` is a caller deliberately recording none. Sent
	// exactly as given; only omitting the flag omits the field.
	if criteriaSet {
		body["acceptanceCriteria"] = criteria
	}
	if flagWasSet(fs, "completion-criterion") {
		body["completionCriterion"] = *completionCriterion
	}
	if flagWasSet(fs, "completion-criterion-override-reason") {
		if strings.TrimSpace(*completionCriterionOverrideReason) == "" {
			return fmt.Errorf("--completion-criterion-override-reason cannot be blank")
		}
		body["completionCriterionOverrideReason"] = strings.TrimSpace(*completionCriterionOverrideReason)
	}
	if commandSet {
		body["acceptanceCommand"] = *acceptanceCommand
		body["acceptanceExpectedExitCode"] = *acceptanceExpectedExitCode
	}
	if timeoutSet {
		body["acceptanceTimeoutSeconds"] = *acceptanceTimeoutSeconds
	}
	if ownerCeilingSet {
		body["acceptanceOwnerTimeoutCeilingSeconds"] = *acceptanceOwnerTimeoutCeilingSeconds
	}
	if flagWasSet(fs, "due-date") {
		if strings.TrimSpace(*dueDate) == "" {
			return fmt.Errorf("--due-date cannot be empty")
		}
		body["dueDate"] = *dueDate
	}
	if flagWasSet(fs, "provider") {
		if strings.TrimSpace(*provider) == "" {
			return fmt.Errorf("--provider cannot be empty")
		}
		body["provider"] = *provider
	}
	if flagWasSet(fs, "model") {
		if strings.TrimSpace(*model) == "" {
			return fmt.Errorf("--model cannot be empty")
		}
		body["model"] = *model
	}
	if deps := uniqueStrings(dependsOn); len(deps) > 0 {
		body["dependsOnTaskIds"] = deps
	}
	if labelSet := uniqueStrings(labels); len(labelSet) > 0 {
		body["labels"] = labelSet
	}
	if flagWasSet(fs, "auto-run-when-ready") {
		body["autoRunWhenReady"] = *autoRun
	}
	if flagWasSet(fs, "completion-policy") {
		if err := validateTaskCLICompletionPolicy(*completionPolicy); err != nil {
			return err
		}
		body["completionPolicy"] = *completionPolicy
	}
	// The runner API intentionally keeps the user/JWT compatibility default out of agent writes.
	// Refuse locally too: the old server might still accept omission, and a CLI that knows the
	// invariant should never make an avoidable HTTP request that silently creates human work.
	if err := requireRunnerTaskCompletionDeclaration(body); err != nil {
		return err
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	// Inside a session, attribute the task to the acting agent exactly as the MCP task tools do —
	// both read the same ORBIT_AGENT_ID, and the two write paths must not disagree on who created a
	// task. Passing the session also links the task to it and lets the server dedup a redelivered
	// turn's re-created tasks (see TasksService idempotency). ORBIT_AGENT_ID stays the default
	// assignee regardless.
	agentID, sessionID := cliTaskAttribution()
	raw, err := t.createTask(agentID, sessionID, body)
	if err != nil {
		return fmt.Errorf("create task: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

// cliTaskAttribution returns the (agentId, sessionId) a CLI write is attributed to. Inside a
// session the runner injects both, and the CLI claims agent authorship like the MCP server. A
// headless process (launchd/cron) has no ORBIT_SESSION_ID: it keeps runner-owner attribution,
// because its runner credential is shared and must not let any script pose as an agent by setting
// an env var. The credential itself is always the runner token either way; only attribution moves.
func cliTaskAttribution() (agentID, sessionID string) {
	sessionID = strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID"))
	if sessionID == "" {
		return "", ""
	}
	return strings.TrimSpace(os.Getenv("ORBIT_AGENT_ID")), sessionID
}

// cliCapabilityActor names who the mutating commands in the capability document will be recorded
// as. It reads the same resolution the writes use: with no agent id the server falls back to the
// owner even inside a session, so both halves of the pair must be present to claim agent
// authorship.
func cliCapabilityActor() string {
	if agentID, sessionID := cliTaskAttribution(); agentID != "" && sessionID != "" {
		return "agent"
	}
	return "runner_owner"
}

func cliTaskCreateBatch(args []string, in io.Reader, out io.Writer) error {
	fs := newCLIFlagSet("orbit task create-batch")
	tasks := fs.String("tasks", "", "JSON array of task objects")
	tasksFile := fs.String("tasks-file", "", "read the JSON array from stdin (-)")
	// Unit L7: judge the plan and write none of it. The most consequential thing an agent does
	// here is also the least visible — the request is fifty titles and the result is a graph of
	// work filed against somebody's goals — so this is the way to see WHERE those fifty land
	// before any of them exists.
	dryRun := fs.Bool("dry-run", false, "judge the plan and write nothing; report where each item would land")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	raw, rawSet, err := readCLIText(in, *tasks, flagWasSet(fs, "tasks"), *tasksFile, flagWasSet(fs, "tasks-file"), "tasks")
	if err != nil {
		return err
	}
	if !rawSet {
		return fmt.Errorf("--tasks or --tasks-file is required")
	}
	items, err := parseTaskBatchItems(raw)
	if err != nil {
		return err
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	// In-session agent attribution + session link, same as `orbit task create`.
	agentID, sessionID := cliTaskAttribution()
	body := map[string]interface{}{"tasks": items}
	verb := "create tasks"
	if *dryRun {
		body["dryRun"] = true
		verb = "preview plan"
	}
	out2, err := t.createTasksBatch(agentID, sessionID, body)
	if err != nil {
		return fmt.Errorf("%s: %w", verb, err)
	}
	return writeCLIRawJSON(out, out2, *jsonOut)
}

// parseTaskBatchItems accepts either a bare JSON array of task objects or the request
// shape {"tasks": [...]}, and applies the same per-item defaults as `orbit task create`.
func parseTaskBatchItems(raw string) ([]map[string]interface{}, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, fmt.Errorf("tasks is empty")
	}
	var items []map[string]interface{}
	if trimmed[0] == '{' {
		var wrapper struct {
			Tasks []map[string]interface{} `json:"tasks"`
		}
		if err := json.Unmarshal([]byte(trimmed), &wrapper); err != nil {
			return nil, fmt.Errorf("tasks must be a JSON array of task objects: %w", err)
		}
		items = wrapper.Tasks
	} else if err := json.Unmarshal([]byte(trimmed), &items); err != nil {
		return nil, fmt.Errorf("tasks must be a JSON array of task objects: %w", err)
	}
	if len(items) == 0 {
		return nil, fmt.Errorf("tasks must contain at least one task")
	}
	if len(items) > maxTaskBatchCreate {
		return nil, fmt.Errorf("tasks accepts at most %d items per call", maxTaskBatchCreate)
	}
	agentID := strings.TrimSpace(os.Getenv("ORBIT_AGENT_ID"))
	for i, item := range items {
		if item == nil {
			return nil, fmt.Errorf("tasks[%d] must be an object", i)
		}
		title, _ := item["title"].(string)
		if strings.TrimSpace(title) == "" {
			return nil, fmt.Errorf("tasks[%d]: title is required", i)
		}
		if _, ok := item["assigneeId"]; !ok && agentID != "" {
			item["assigneeId"] = agentID
		}
		if err := requireRunnerTaskCompletionDeclaration(item); err != nil {
			return nil, fmt.Errorf("tasks[%d]: %w", i, err)
		}
	}
	return items, nil
}

func cliTaskUpdate(args []string, in io.Reader, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit task update")
	title := fs.String("title", "", "task title")
	description := fs.String("description", "", "task description")
	descriptionFile := fs.String("description-file", "", "read description from stdin (-)")
	status := fs.String("status", "", "task status")
	assigneeID := fs.String("assignee-id", "", "assignee agent id")
	clearAssignee := fs.Bool("clear-assignee", false, "clear assignee")
	listID := fs.String("list-id", "", "task list id")
	clearList := fs.Bool("clear-list", false, "clear task list")
	parentTaskID := fs.String("parent-task-id", "", "make this task a subtask of that task")
	clearParent := fs.Bool("clear-parent", false, "detach this task from its parent task")
	verifiesTaskID := fs.String("verifies-task-id", "", "point this task at the task it verifies")
	clearVerifies := fs.Bool("clear-verifies", false, "detach this task from the task it verifies")
	dueDate := fs.String("due-date", "", "ISO due date")
	clearDueDate := fs.Bool("clear-due-date", false, "clear due date")
	provider := fs.String("provider", "", "run on this provider instead of the assignee's")
	clearProvider := fs.Bool("clear-provider", false, "inherit the assignee's provider again")
	model := fs.String("model", "", "run on this model instead of the assignee's")
	clearModel := fs.Bool("clear-model", false, "inherit the assignee's model again")
	acceptanceCriteria := fs.String("acceptance-criteria", "", "replace what would settle that this task is done")
	acceptanceCriteriaFile := fs.String("acceptance-criteria-file", "", "read the replacement acceptance criteria from stdin (-)")
	clearAcceptanceCriteria := fs.Bool("clear-acceptance-criteria", false, "leave the task with no acceptance criteria")
	completionCriterion := fs.String("completion-criterion", "", "replace the completion criterion (EXECUTABLE|VERIFICATION|EVIDENCE_JUDGMENT)")
	acceptanceCommand := fs.String("acceptance-command", "", "replace the one EXECUTABLE shell acceptance command")
	acceptanceExpectedExitCode := fs.Int("acceptance-expected-exit-code", 0, "replace the exit code that derives DONE")
	acceptanceTimeoutSeconds := fs.Int("acceptance-timeout-seconds", 0, "replace requested v2 timeout seconds")
	acceptanceOwnerTimeoutCeilingSeconds := fs.Int("acceptance-owner-timeout-ceiling-seconds", 0, "replace owner timeout ceiling seconds")
	clearAcceptanceTimeout := fs.Bool("clear-acceptance-timeout", false, "return this executable declaration to the N-1 legacy plan")
	clearExecutableAcceptance := fs.Bool("clear-executable-acceptance", false, "clear the command and expected exit code together")
	var dependsOn csvFlag
	fs.Var(&dependsOn, "depends-on", "replace all prerequisite task ids (comma-separated, repeatable)")
	clearDependencies := fs.Bool("clear-dependencies", false, "clear all prerequisite task ids")
	var labels csvFlag
	fs.Var(&labels, "label", "replace all labels (comma-separated, repeatable)")
	clearLabels := fs.Bool("clear-labels", false, "clear all labels")
	autoRun := fs.Bool("auto-run-when-ready", false, "auto-run after dependencies complete")
	completionPolicy := fs.String("completion-policy", "", "how this task's completion is decided (MANUAL|ALL_CHILDREN_DONE|VERIFICATION_PASSED)")
	verdict := fs.String("verdict", "", "this verification task's conclusion (PASS|FAIL|INCONCLUSIVE)")
	clearVerdict := fs.Bool("clear-verdict", false, "revoke this verification task's conclusion")
	supersededBy := fs.String("superseded-by-task-id", "", "the later attempt that replaced this one")
	clearSuperseded := fs.Bool("clear-superseded", false, "unlink the successor recorded for this task")
	terminalReason := fs.String("terminal-reason", "", "why this task stopped (SUPERSEDED|ABANDONED)")
	clearTerminalReason := fs.Bool("clear-terminal-reason", false, "leave this task with no terminal reason")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	id, err := resolveTaskCLIId(id, fs.Args())
	if err != nil {
		return err
	}
	if err := validateTaskCLIStatus(*status); err != nil {
		return err
	}
	if flagWasSet(fs, "status") && *status == "" {
		return fmt.Errorf("--status cannot be empty")
	}
	if *clearAssignee && flagWasSet(fs, "assignee-id") {
		return fmt.Errorf("--clear-assignee and --assignee-id cannot be used together")
	}
	if *clearList && flagWasSet(fs, "list-id") {
		return fmt.Errorf("--clear-list and --list-id cannot be used together")
	}
	if *clearParent && flagWasSet(fs, "parent-task-id") {
		return fmt.Errorf("--clear-parent and --parent-task-id cannot be used together")
	}
	if *clearVerifies && flagWasSet(fs, "verifies-task-id") {
		return fmt.Errorf("--clear-verifies and --verifies-task-id cannot be used together")
	}
	if *clearDueDate && flagWasSet(fs, "due-date") {
		return fmt.Errorf("--clear-due-date and --due-date cannot be used together")
	}
	if *clearSuperseded && flagWasSet(fs, "superseded-by-task-id") {
		return fmt.Errorf("--clear-superseded and --superseded-by-task-id cannot be used together")
	}
	if *clearTerminalReason && flagWasSet(fs, "terminal-reason") {
		return fmt.Errorf("--clear-terminal-reason and --terminal-reason cannot be used together")
	}
	if *clearProvider && flagWasSet(fs, "provider") {
		return fmt.Errorf("--clear-provider and --provider cannot be used together")
	}
	if *clearModel && flagWasSet(fs, "model") {
		return fmt.Errorf("--clear-model and --model cannot be used together")
	}
	if *clearDependencies && flagWasSet(fs, "depends-on") {
		return fmt.Errorf("--clear-dependencies and --depends-on cannot be used together")
	}
	if flagWasSet(fs, "depends-on") && len(dependsOn) == 0 {
		return fmt.Errorf("--depends-on cannot be empty; use --clear-dependencies")
	}
	if *clearLabels && flagWasSet(fs, "label") {
		return fmt.Errorf("--clear-labels and --label cannot be used together")
	}
	if flagWasSet(fs, "label") && len(labels) == 0 {
		return fmt.Errorf("--label cannot be empty; use --clear-labels")
	}
	// Clearing and replacing are opposite instructions about the same field, so naming both is not a
	// preference order to resolve — including when the replacement is on stdin, which is why this is
	// caught before anything reads it.
	if *clearAcceptanceCriteria && flagWasSet(fs, "acceptance-criteria") {
		return fmt.Errorf("--clear-acceptance-criteria and --acceptance-criteria cannot be used together")
	}
	if *clearAcceptanceCriteria && flagWasSet(fs, "acceptance-criteria-file") {
		return fmt.Errorf("--clear-acceptance-criteria and --acceptance-criteria-file cannot be used together")
	}
	if *clearExecutableAcceptance && flagWasSet(fs, "acceptance-command") {
		return fmt.Errorf("--clear-executable-acceptance and --acceptance-command cannot be used together")
	}
	if *clearExecutableAcceptance && flagWasSet(fs, "acceptance-expected-exit-code") {
		return fmt.Errorf("--clear-executable-acceptance and --acceptance-expected-exit-code cannot be used together")
	}
	if *clearAcceptanceTimeout && flagWasSet(fs, "acceptance-timeout-seconds") {
		return fmt.Errorf("--clear-acceptance-timeout and --acceptance-timeout-seconds cannot be used together")
	}
	if *clearAcceptanceTimeout && flagWasSet(fs, "acceptance-owner-timeout-ceiling-seconds") {
		return fmt.Errorf("--clear-acceptance-timeout and --acceptance-owner-timeout-ceiling-seconds cannot be used together")
	}
	if flagWasSet(fs, "acceptance-owner-timeout-ceiling-seconds") && !flagWasSet(fs, "acceptance-timeout-seconds") {
		return fmt.Errorf("--acceptance-owner-timeout-ceiling-seconds requires --acceptance-timeout-seconds")
	}
	if flagWasSet(fs, "acceptance-timeout-seconds") && (*acceptanceTimeoutSeconds < 1 || *acceptanceTimeoutSeconds > 86400) {
		return fmt.Errorf("--acceptance-timeout-seconds must be between 1 and 86400")
	}
	if flagWasSet(fs, "acceptance-owner-timeout-ceiling-seconds") && (*acceptanceOwnerTimeoutCeilingSeconds < 1 || *acceptanceOwnerTimeoutCeilingSeconds > 86400) {
		return fmt.Errorf("--acceptance-owner-timeout-ceiling-seconds must be between 1 and 86400")
	}
	if flagWasSet(fs, "acceptance-command") && strings.TrimSpace(*acceptanceCommand) == "" {
		return fmt.Errorf("--acceptance-command cannot be blank; use --clear-executable-acceptance")
	}
	if flagWasSet(fs, "completion-criterion") {
		if err := validateTaskCLICompletionCriterion(*completionCriterion); err != nil {
			return err
		}
	}
	// Two fields, one stdin — the same collision `orbit task create` has. readCLIText sees a single
	// field at a time, so nothing downstream can notice that the first read drains the stream and the
	// second gets an empty string: an update that silently blanks a task's criteria (or its
	// description) and reports success. Caught here, before either read and before any request; a
	// direct value for one and stdin for the other is unambiguous and stays legal.
	if flagWasSet(fs, "description-file") && flagWasSet(fs, "acceptance-criteria-file") {
		return fmt.Errorf("--description-file and --acceptance-criteria-file both read stdin and cannot be used together; pass one of them inline")
	}
	desc, descSet, err := readCLIText(in, *description, flagWasSet(fs, "description"), *descriptionFile, flagWasSet(fs, "description-file"), "description")
	if err != nil {
		return err
	}
	criteria, criteriaSet, err := readCLIText(in, *acceptanceCriteria, flagWasSet(fs, "acceptance-criteria"), *acceptanceCriteriaFile, flagWasSet(fs, "acceptance-criteria-file"), "acceptance-criteria")
	if err != nil {
		return err
	}
	body := map[string]interface{}{}
	if flagWasSet(fs, "title") {
		if strings.TrimSpace(*title) == "" {
			return fmt.Errorf("--title cannot be empty")
		}
		body["title"] = *title
	}
	if descSet {
		body["description"] = desc
	}
	if flagWasSet(fs, "status") {
		body["status"] = *status
	}
	if *clearAssignee {
		body["assigneeId"] = nil
	} else if flagWasSet(fs, "assignee-id") {
		if strings.TrimSpace(*assigneeID) == "" {
			return fmt.Errorf("--assignee-id cannot be empty; use --clear-assignee")
		}
		body["assigneeId"] = *assigneeID
	}
	if *clearList {
		body["listId"] = nil
	} else if flagWasSet(fs, "list-id") {
		if strings.TrimSpace(*listID) == "" {
			return fmt.Errorf("--list-id cannot be empty; use --clear-list")
		}
		body["listId"] = *listID
	}
	// Membership, not ordering: this moves the task within the subtask tree and says nothing about
	// when it runs (--depends-on below is that). Blank is a typo or an unset shell variable, the
	// same rule the id flags above use — detaching is what --clear-parent says out loud.
	if *clearParent {
		body["parentTaskId"] = nil
	} else if flagWasSet(fs, "parent-task-id") {
		if strings.TrimSpace(*parentTaskID) == "" {
			return fmt.Errorf("--parent-task-id cannot be empty; use --clear-parent")
		}
		body["parentTaskId"] = *parentTaskID
	}
	// Three-state like --parent-task-id above, and refused outright by the server once this
	// verification has concluded anything: the consequences a verdict already caused name the
	// subject they were about.
	if *clearVerifies {
		body["verifiesTaskId"] = nil
	} else if flagWasSet(fs, "verifies-task-id") {
		if strings.TrimSpace(*verifiesTaskID) == "" {
			return fmt.Errorf("--verifies-task-id cannot be empty; use --clear-verifies")
		}
		body["verifiesTaskId"] = *verifiesTaskID
	}
	if *clearDueDate {
		body["dueDate"] = nil
	} else if flagWasSet(fs, "due-date") {
		if strings.TrimSpace(*dueDate) == "" {
			return fmt.Errorf("--due-date cannot be empty; use --clear-due-date")
		}
		body["dueDate"] = *dueDate
	}
	if *clearProvider {
		body["provider"] = nil
	} else if flagWasSet(fs, "provider") {
		if strings.TrimSpace(*provider) == "" {
			return fmt.Errorf("--provider cannot be empty; use --clear-provider")
		}
		body["provider"] = *provider
	}
	if *clearModel {
		body["model"] = nil
	} else if flagWasSet(fs, "model") {
		if strings.TrimSpace(*model) == "" {
			return fmt.Errorf("--model cannot be empty; use --clear-model")
		}
		body["model"] = *model
	}
	// Whole-field replacement with an explicit way to remove it: null clears, a string replaces, and
	// an absent flag sends nothing so the task keeps what it already states. Free text rather than an
	// id, so the blank-is-a-typo rule the id flags above use does not apply — `--acceptance-criteria
	// ""` is a caller deliberately recording none, and the server's DTO has no MinLength either.
	if *clearAcceptanceCriteria {
		body["acceptanceCriteria"] = nil
	} else if criteriaSet {
		body["acceptanceCriteria"] = criteria
	}
	if flagWasSet(fs, "completion-criterion") {
		body["completionCriterion"] = *completionCriterion
	}
	if *clearExecutableAcceptance {
		body["acceptanceCommand"] = nil
		body["acceptanceExpectedExitCode"] = nil
	} else {
		if flagWasSet(fs, "acceptance-command") {
			body["acceptanceCommand"] = *acceptanceCommand
		}
		if flagWasSet(fs, "acceptance-expected-exit-code") {
			body["acceptanceExpectedExitCode"] = *acceptanceExpectedExitCode
		}
	}
	if *clearAcceptanceTimeout {
		body["acceptanceTimeoutSeconds"] = nil
		body["acceptanceOwnerTimeoutCeilingSeconds"] = nil
	} else {
		if flagWasSet(fs, "acceptance-timeout-seconds") {
			body["acceptanceTimeoutSeconds"] = *acceptanceTimeoutSeconds
		}
		if flagWasSet(fs, "acceptance-owner-timeout-ceiling-seconds") {
			body["acceptanceOwnerTimeoutCeilingSeconds"] = *acceptanceOwnerTimeoutCeilingSeconds
		}
	}
	if *clearDependencies {
		body["dependsOnTaskIds"] = []string{}
	} else if flagWasSet(fs, "depends-on") {
		body["dependsOnTaskIds"] = uniqueStrings(dependsOn)
	}
	// Whole-set replacement, like --depends-on above: --label states what the labels are now,
	// not what to add.
	if *clearLabels {
		body["labels"] = []string{}
	} else if flagWasSet(fs, "label") {
		body["labels"] = uniqueStrings(labels)
	}
	if flagWasSet(fs, "auto-run-when-ready") {
		body["autoRunWhenReady"] = *autoRun
	}
	if flagWasSet(fs, "completion-policy") {
		if err := validateTaskCLICompletionPolicy(*completionPolicy); err != nil {
			return err
		}
		body["completionPolicy"] = *completionPolicy
	}
	// Three-state, like --provider above: revoking a verdict is a real edit — it reopens a subject
	// that VERIFICATION_PASSED had completed — so it needs its own flag rather than an empty string.
	if *clearVerdict {
		if flagWasSet(fs, "verdict") {
			return fmt.Errorf("--verdict and --clear-verdict cannot be combined")
		}
		body["verdict"] = nil
	} else if flagWasSet(fs, "verdict") {
		if err := validateTaskCLIVerdict(*verdict); err != nil {
			return err
		}
		body["verdict"] = *verdict
	}
	// Three-state like the verdict above. Unlinking is a real edit rather than an empty string: it
	// says the replacement is no longer the story, which is a different claim from never having
	// recorded one.
	if *clearSuperseded {
		body["supersededByTaskId"] = nil
	} else if flagWasSet(fs, "superseded-by-task-id") {
		if strings.TrimSpace(*supersededBy) == "" {
			return fmt.Errorf("--superseded-by-task-id cannot be empty; use --clear-superseded")
		}
		body["supersededByTaskId"] = *supersededBy
	}
	if *clearTerminalReason {
		body["terminalReason"] = nil
	} else if flagWasSet(fs, "terminal-reason") {
		switch strings.ToUpper(strings.TrimSpace(*terminalReason)) {
		case "SUPERSEDED", "ABANDONED":
			body["terminalReason"] = strings.ToUpper(strings.TrimSpace(*terminalReason))
		default:
			return fmt.Errorf("--terminal-reason must be one of SUPERSEDED, ABANDONED")
		}
	}
	if len(body) == 0 {
		return fmt.Errorf("no fields to update")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	// The acting session, for the same reason create passes it: the server's independence rule
	// (§13.2) needs to know which run is writing, and a terminal outside a session simply has none.
	_, sessionID := cliTaskAttribution()
	raw, err := t.updateTask(sessionID, id, body)
	if err != nil {
		return fmt.Errorf("update task: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliTaskJudge(args []string, in io.Reader, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit task judge")
	requestID := fs.String("request-id", "", "current open EVIDENCE_JUDGMENT judgment request id")
	evidenceDigest := fs.String("evidence-digest", "", "sha256 digest bound to the current request")
	evidenceText := fs.String("evidence", "", "the finding this judgment is based on")
	evidenceFile := fs.String("evidence-file", "", "read evidence from stdin (-)")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	id, err := resolveTaskCLIId(id, fs.Args())
	if err != nil {
		return err
	}
	if strings.TrimSpace(*requestID) == "" {
		return fmt.Errorf("--request-id is required: decide the current open EVIDENCE_JUDGMENT judgment request")
	}
	if !isSHA256Hex(*evidenceDigest) {
		return fmt.Errorf("--evidence-digest must be the current request's 64-character sha256 digest")
	}
	evidence, evidenceSet, err := readCLIText(
		in,
		*evidenceText,
		flagWasSet(fs, "evidence"),
		*evidenceFile,
		flagWasSet(fs, "evidence-file"),
		"evidence",
	)
	if err != nil {
		return err
	}
	if !evidenceSet || strings.TrimSpace(evidence) == "" {
		return fmt.Errorf("--evidence or --evidence-file - with non-blank evidence is required")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	// A headless invocation has no acting session and is attributed to the runner owner. Carry a
	// session when one exists: that is who the server records as having decided.
	_, sessionID := cliTaskAttribution()
	raw, err := t.judgeTask(sessionID, id, *requestID, strings.ToLower(*evidenceDigest), evidence)
	if err != nil {
		return fmt.Errorf("judge task: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliTaskDelete(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit task delete")
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
	raw, err := t.deleteTask(id)
	if err != nil {
		return fmt.Errorf("delete task: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliTaskStart(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit task start")
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
	// One name for THIS `orbit task start`, drawn once: every resend below it is the same
	// request, and the next invocation of the command is a different one. A draw that fails stops
	// the command rather than starting an unnamed run.
	token, err := newRunRequestToken()
	if err != nil {
		return fmt.Errorf("start task: %w", err)
	}
	raw, err := t.startTask(id, token)
	if err != nil {
		return fmt.Errorf("start task: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliTaskComment(args []string, in io.Reader, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit task comment")
	bodyText := fs.String("body", "", "comment body")
	bodyFile := fs.String("body-file", "", "read body from stdin (-)")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	id, err := resolveTaskCLIId(id, fs.Args())
	if err != nil {
		return err
	}
	body, bodySet, err := readCLIText(in, *bodyText, flagWasSet(fs, "body"), *bodyFile, flagWasSet(fs, "body-file"), "body")
	if err != nil {
		return err
	}
	if !bodySet || strings.TrimSpace(body) == "" {
		return fmt.Errorf("--body or --body-file - is required")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	// In-session comments are authored by the acting agent (same ORBIT_AGENT_ID the MCP path uses);
	// a headless comment stays runner-owner.
	agentID, _ := cliTaskAttribution()
	raw, err := t.commentTask(id, agentID, body)
	if err != nil {
		return fmt.Errorf("comment on task: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliTaskListList(args []string, out io.Writer) error {
	fs := newCLIFlagSet("orbit task-list list")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.listTaskLists()
	if err != nil {
		return fmt.Errorf("list task lists: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliTaskListGet(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit task-list get")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	if id == "" {
		return fmt.Errorf("list id is required")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.getTaskList(id)
	if err != nil {
		return fmt.Errorf("get task list: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliTaskListUpdate(args []string, in io.Reader, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit task-list update")
	title := fs.String("title", "", "task list title")
	instructions := fs.String("instructions", "", "standing instructions for every task in the list")
	instructionsFile := fs.String("instructions-file", "", "read instructions from a file, or - for stdin")
	paused := fs.String("paused", "", "true|false — hold or resume dispatch for the whole list")
	verifyOnDone := fs.String("verify-on-done", "", "true|false — file a verification run when a task here reports DONE")
	maxConcurrent := fs.Int("max-concurrent", 0, "cap the list's concurrently running tasks")
	clearMaxConcurrent := fs.Bool("clear-max-concurrent", false, "remove the concurrency cap")
	foremanWorkspace := fs.String("foreman-workspace-id", "", "workspace that runs this list's coordination")
	clearForeman := fs.Bool("clear-foreman", false, "stop filing a foreman for this list")
	foremanStall := fs.Int("foreman-stall-minutes", 0, "minutes of no activity before a foreman is filed")
	note := fs.String("note", "", "why this change is being made; recorded on the revision")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	if id == "" {
		return fmt.Errorf("list id is required")
	}
	body := map[string]interface{}{}
	// Only flags the caller actually passed are sent: a partial edit must never blank the rest of
	// the policy, and "absent" has to stay distinguishable from "cleared".
	if flagWasSet(fs, "title") {
		body["title"] = *title
	}
	text, textSet, err := readCLIText(in, *instructions, flagWasSet(fs, "instructions"),
		*instructionsFile, flagWasSet(fs, "instructions-file"), "instructions")
	if err != nil {
		return err
	}
	if textSet {
		body["instructions"] = text
	}
	if flagWasSet(fs, "paused") {
		switch *paused {
		case "true":
			body["paused"] = true
		case "false":
			body["paused"] = false
		default:
			return fmt.Errorf("--paused must be true or false")
		}
	}
	if flagWasSet(fs, "verify-on-done") {
		switch *verifyOnDone {
		case "true":
			body["verifyOnDone"] = true
		case "false":
			body["verifyOnDone"] = false
		default:
			return fmt.Errorf("--verify-on-done must be true or false")
		}
	}
	if *clearMaxConcurrent {
		body["maxConcurrent"] = nil
	} else if flagWasSet(fs, "max-concurrent") {
		body["maxConcurrent"] = *maxConcurrent
	}
	if *clearForeman {
		body["foremanWorkspaceId"] = nil
		body["foremanStallMinutes"] = nil
	} else {
		if flagWasSet(fs, "foreman-workspace-id") {
			body["foremanWorkspaceId"] = *foremanWorkspace
		}
		if flagWasSet(fs, "foreman-stall-minutes") {
			body["foremanStallMinutes"] = *foremanStall
		}
	}
	if flagWasSet(fs, "note") {
		body["note"] = *note
	}
	if len(body) == 0 {
		return fmt.Errorf("nothing to update")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.updateTaskList(id, os.Getenv("ORBIT_AGENT_ID"), os.Getenv("ORBIT_SESSION_ID"), body)
	if err != nil {
		return fmt.Errorf("update task list: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliTaskListCreate(args []string, out io.Writer) error {
	fs := newCLIFlagSet("orbit task-list create")
	title := fs.String("title", "", "task list title")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	if strings.TrimSpace(*title) == "" {
		return fmt.Errorf("--title is required")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.createTaskList(*title)
	if err != nil {
		return fmt.Errorf("create task list: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

// cliStringList collects a flag given more than once, which is how a batch of edges is typed.
type cliStringList []string

func (l *cliStringList) String() string { return strings.Join(*l, ",") }

func (l *cliStringList) Set(v string) error {
	*l = append(*l, v)
	return nil
}

// cliTaskListProposeDag is the CLI door onto the same batch, and it deliberately does NOT raise
// an approval: the approval exists to interpose a human between an *agent* and the graph, and at
// a terminal the human is already the one typing. So it previews by default and writes with
// --apply, which is the shape a person actually wants — look, then commit.
func cliTaskListProposeDag(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit task-list propose-dag")
	var adds, removes cliStringList
	fs.Var(&adds, "add", "add edge TASK_ID:DEPENDS_ON_ID (repeatable)")
	fs.Var(&removes, "remove", "remove edge TASK_ID:DEPENDS_ON_ID (repeatable)")
	note := fs.String("note", "", "why this restructure")
	apply := fs.Bool("apply", false, "write the change instead of only previewing it")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	if id == "" {
		return fmt.Errorf("list id is required")
	}
	ops := []interface{}{}
	for _, spec := range adds {
		op, err := parseDagEdge("add", spec)
		if err != nil {
			return err
		}
		ops = append(ops, op)
	}
	for _, spec := range removes {
		op, err := parseDagEdge("remove", spec)
		if err != nil {
			return err
		}
		ops = append(ops, op)
	}
	if len(ops) == 0 {
		return fmt.Errorf("at least one --add or --remove is required")
	}
	body := map[string]interface{}{"ops": ops}
	if *note != "" {
		body["note"] = *note
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	var raw json.RawMessage
	if *apply {
		raw, err = t.dagApply(id, body)
	} else {
		raw, err = t.dagPreview(id, body)
	}
	if err != nil {
		return fmt.Errorf("propose dag: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

// parseDagEdge reads TASK_ID:DEPENDS_ON_ID. Ids are base62 or uuid, neither of which contains a
// colon, so splitting on the last one is unambiguous.
func parseDagEdge(op, spec string) (map[string]interface{}, error) {
	i := strings.LastIndex(spec, ":")
	if i <= 0 || i == len(spec)-1 {
		return nil, fmt.Errorf("--%s expects TASK_ID:DEPENDS_ON_ID, got %q", op, spec)
	}
	return map[string]interface{}{
		"op":              op,
		"taskId":          spec[:i],
		"dependsOnTaskId": spec[i+1:],
	}, nil
}

func cliTaskListDelete(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit task-list delete")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	if id == "" {
		return fmt.Errorf("list id is required")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.deleteTaskList(id)
	if err != nil {
		return fmt.Errorf("delete task list: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

type cliCapabilitySpec struct {
	Tool        string
	Argv        []string
	Usage       string
	Arguments   []string
	Description string
	Mutates     bool
	// Human terminal doors are real CLI commands but must not be advertised to a running agent.
	// Their absence from the MCP descriptor set is intentional, so the capability document only
	// includes them when there is no acting Session.
	HeadlessOnly bool
}

var baseCLICapabilities = withTaskCompletionCapabilityArgs([]cliCapabilitySpec{
	{Tool: "task_list", Argv: []string{"orbit", "task", "list"}, Usage: "orbit task list [--status STATUS] [--list-id ID] [--project-id ID] [--label L] [--limit N | --all [--cursor C]] [--json]", Arguments: []string{"--status <OPEN|IN_PROGRESS|DONE|CANCELLED|FAILED>", "--list-id <id>", "--project-id <id> (only tasks filed under this project; unknown or another owner's lists empty)", "--label <labels[,labels...]> (repeatable; matches tasks carrying ALL of them)", "--limit <n> (default 100, max 200)", "--all (every match as NDJSON, paged; excludes --limit)", "--cursor <c> (resume an interrupted --all)", "--json"}},
	{Tool: "task_labels", Argv: []string{"orbit", "task", "labels"}, Usage: "orbit task labels [--list-id ID] [--json]", Arguments: []string{"--list-id <id>", "--json"}, Description: "Every label in use with its own status breakdown, counted over every task carrying it. One call answers for all labels, where task_list --label answers for one; also how to discover how a label is spelled before filtering on it."},
	{Tool: "task_get", Argv: []string{"orbit", "task", "get"}, Usage: "orbit task get [task-id] [--json]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--json"}},
	{Tool: "task_evidence_list", Argv: []string{"orbit", "task", "evidence-list"}, Usage: "orbit task evidence-list [task-id] [--json]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--json"}, Description: "List immutable structured completion-evidence revisions in task-local order. Reads no comments and depends on no Session lifecycle state."},
	{Tool: "task_evidence_submit", Argv: []string{"orbit", "task", "evidence-submit"}, Usage: "orbit task evidence-submit [task-id] (--evidence JSON | --evidence-file -) [--source-session-id ID] [--idempotency-key KEY] [--json]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--evidence <JSON object> | --evidence-file - (required)", "--source-session-id <id> (defaults to ORBIT_SESSION_ID)", "--idempotency-key <key> (max 200 characters)", "--json"}, Description: "Submit an explicit structured completion-evidence fact from a task Session. It appends or replays a revision without changing Task or Session state and without adding a comment.", Mutates: true},
	{Tool: "task_create", Argv: []string{"orbit", "task", "create"}, Usage: "orbit task create --title TITLE [options]", Arguments: []string{"--title <text> (required)", "--description <text> | --description-file -", "--assignee-id <id> | --unassigned", "--list-id <id>", "--project-id <id> (file the task under this project; orthogonal to --list-id, must be owned by the caller)", "--parent-task-id <id> (create it as a subtask of this existing task; must be owned by the caller and in the same project)", "--verifies-task-id <id> (file it as a verification of this existing task: what makes a check a structured relation, and the precondition for a verdict; same project, not itself, and not itself a verification)", "--supersedes-task-id <id> (record in this same write that the new task REPLACES that stopped attempt: the predecessor must be CANCELLED or FAILED, owned by you and in the same project, and must not already have been replaced)", "--acceptance-criteria <text> | --acceptance-criteria-file - (what would settle that this task is done; max 4,000 characters)", "--criterion-key <key> (criterionKey: which of the PROJECT's stated acceptance criteria this work serves, as a key from project_get; required of a project's judgment session and optional for everybody else)", "--due-date <ISO date>", "--provider <slug>", "--model <model>", "--depends-on <id[,id...]> (repeatable)", "--label <labels[,labels...]> (repeatable)", "--auto-run-when-ready[=true|false]", "--completion-policy <MANUAL|ALL_CHILDREN_DONE|VERIFICATION_PASSED> (how this task's own completion is decided once it has subtasks; MANUAL, the default, never completes it automatically)", "--json"}, Description: "Create a task. Inside a session it is attributed to this agent (ORBIT_AGENT_ID), the same as the MCP task tools; run headless with no session it is attributed to the runner owner. ORBIT_AGENT_ID is also the default assignee. This only records the task; call task_start when it should run immediately. Every runner task creation requires --completion-criterion explicitly; EVIDENCE_JUDGMENT remains available when intended but is never inferred from omission, and verifier, executable, or policy flags do not replace the declaration. --project-id files the task under a project you own, which is orthogonal to --list-id: the project says what the work is for, the list decides how it is dispatched. --parent-task-id makes it a subtask of an existing task, which must be in the same project as this one — pass both flags for a subtask under a project's task, since the project is not inherited from the parent. --acceptance-criteria states what would settle that this task is done — the observable, verifiable result, as opposed to --description, which says what work to perform, and to the project's own acceptance criteria, which settle the whole goal; the server accepts up to 4,000 characters. --acceptance-criteria-file reads it from stdin ('-' only) and cannot be combined with --description-file, which reads the same stream. --supersedes-task-id records, in the same transaction that creates this task, that it replaces an attempt that already stopped: the predecessor keeps the CANCELLED or FAILED it ended with and gains a pointer to this task plus terminalReason SUPERSEDED. Use it instead of creating the replacement and remembering to link it afterwards — the link is what every downstream reader actually consults, and an attempt that never got one is re-dispatched by the control loop as an ordinary unfinished failure.", Mutates: true},
	{Tool: "task_attribution", Argv: []string{"orbit", "task", "attribution"}, Usage: "orbit task attribution [task-id] [--json]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--json"}, Description: "Read one task's attribution boundary — where this work COUNTS (the project's title, Base62 id, status and acceptance epoch: the only authoritative attribution there is), where it was NOTICED (the discovery project, trigger event, source task and source session — evidence, and labelled as evidence, because finding work somewhere grants nothing about where it may be filed), the project acceptance criteria that CITE this task with the verdict each reached and whether that epoch is still the current one (an old PASS stays readable and stops counting), the declared cross-project crossing that touches it with the stable code and required action a writer meeting it is given, and the attribution blocker holding it up. Every absent fact is null beside a reason, so \"no acceptance criterion cites this\" and \"this build cannot tell you\" read differently. Read it BEFORE writing where you are not certain the work belongs: the alternative is learning it from the refusal, which is after the decision was made."},
	{Tool: "task_create_batch", Argv: []string{"orbit", "task", "create-batch"}, Usage: "orbit task create-batch (--tasks JSON | --tasks-file -) [--json]", Arguments: []string{"--tasks <json array> | --tasks-file - (required; every item requires explicit completionCriterion)", "--dry-run (judge the plan and write nothing; report where each item would land)", "--json"}, Description: "Create several tasks in one atomic call — the batch form of task_create. JSON is an array of task objects taking the same fields as task_create; nothing is written unless every item is valid. Every item declares completionCriterion explicitly; EVIDENCE_JUDGMENT is available but never inferred, and verifier, executable, or policy fields do not replace the declaration. An item may carry \"ref\", and a later item may list that ref in \"dependsOnRefs\" to depend on it without knowing its id yet, or name it in \"parentRef\" to be created as a subtask of it — so a plan lands as a tree in one call. The two answer different questions: dependsOnRefs is when an item may run, parentRef is what it is a part of. \"parentTaskId\" is the same link to a task that already exists (same project as the item); one item cannot carry both. Attribution matches task_create: this agent inside a session, the runner owner headless. ORBIT_AGENT_ID is also each item's default assignee. --dry-run judges the plan and writes none of it — not one task, and not even the approval question a declared cross-project crossing would otherwise file — answering instead with where every item WOULD land (project id, title, status and acceptance epoch), every finding that refuses or warns, and how many rows the real call would add. Use it before filing a plan whose attribution you are not certain of: a refusal tells you which item is wrong, and a dry run tells you where the ones that are RIGHT would go.", Mutates: true},
	{Tool: "task_update", Argv: []string{"orbit", "task", "update"}, Usage: "orbit task update [task-id] [options]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--title <text>", "--description <text> | --description-file -", "--status <OPEN|IN_PROGRESS|DONE|CANCELLED|FAILED> (DONE is refused; satisfy the task's declared criterion instead)", "--assignee-id <id> | --clear-assignee", "--list-id <id> | --clear-list", "--parent-task-id <id> | --clear-parent (move this task under that task, or detach it; same project, never itself or one of its own subtasks)", "--verifies-task-id <id> | --clear-verifies (point this task at the task it verifies, or detach it; refused once this verification has concluded anything)", "--due-date <ISO date> | --clear-due-date", "--provider <slug> | --clear-provider", "--model <model> | --clear-model", "--acceptance-criteria <text> | --acceptance-criteria-file - | --clear-acceptance-criteria (replaces what would settle that this task is done; max 4,000 characters)", "--depends-on <id[,id...]> (repeatable; replaces all)", "--clear-dependencies", "--label <labels[,labels...]> (repeatable; replaces all) | --clear-labels", "--auto-run-when-ready[=true|false]", "--completion-policy <MANUAL|ALL_CHILDREN_DONE|VERIFICATION_PASSED> (how this task's completion is decided once it has subtasks)", "--verdict <PASS|FAIL|INCONCLUSIVE> | --clear-verdict (this VERIFICATION task's conclusion about the task it verifies; revoking a PASS reopens a subject VERIFICATION_PASSED had completed)", "--superseded-by-task-id <id> | --clear-superseded ( the later attempt that replaced this one; only a CANCELLED or FAILED task may name one, and it must be in the same project)", "--terminal-reason <SUPERSEDED|ABANDONED> | --clear-terminal-reason (terminalReason: why this task stopped, when its status alone does not say)", "--json"}, Description: "Update a task. Only the flags you pass are sent, so a partial edit never blanks the rest of the task. Direct status DONE is refused for every actor; the structured refusal names the declared EXECUTABLE, VERIFICATION, or EVIDENCE_JUDGMENT path. FAILED remains writable as a run's conservative self-report. --parent-task-id moves the task under another task you own and --clear-parent detaches it, which is how a decomposition is corrected once the tasks exist rather than by deleting and recreating them; the parent must be in the same project, and neither a task itself nor one of its own subtasks may be named (both close a loop). It is membership, not ordering — when a task runs is --depends-on. --acceptance-criteria replaces what would settle that this task is done — the observable, verifiable result, as opposed to --description, which says what work to perform, and to the project's own acceptance criteria, which settle the whole goal rather than this one task. It is a whole-field replacement: omitting it preserves the task's current criteria, text replaces them (\"\" records that there are none worth stating), and --clear-acceptance-criteria removes them, which is why clearing cannot be combined with either form. Expect to use it after creation — what proves a task done is often only clear once the work is understood. The server accepts up to 4,000 characters. --acceptance-criteria-file reads the replacement from stdin ('-' only) and cannot be combined with --description-file, which reads the same stream.", Mutates: true},
	{Tool: "task_judge", Argv: []string{"orbit", "task", "judge"}, Usage: "orbit task judge [task-id] --request-id ID --evidence-digest SHA256 (--evidence TEXT | --evidence-file -) [--json]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--request-id <id> (current open EVIDENCE_JUDGMENT judgment request)", "--evidence-digest <sha256> (exact digest bound to the request)", "--evidence <text> | --evidence-file - (required, non-blank)", "--json"}, Description: "Decide the current evidence-bound EVIDENCE_JUDGMENT judgment request. Records the request, digest, deciding principal, server timestamp, and the non-empty finding; the same transaction derives DONE and closes the request and its derived signal/blocker. Superseded requests are refused; an agent session is not.", Mutates: true},
	{Tool: "task_delete", Argv: []string{"orbit", "task", "delete"}, Usage: "orbit task delete [task-id] [--json]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--json"}, Mutates: true},
	{Tool: "task_start", Argv: []string{"orbit", "task", "start"}, Usage: "orbit task start [task-id] [--json]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--json"}, Mutates: true},
	{Tool: "task_comment", Argv: []string{"orbit", "task", "comment"}, Usage: "orbit task comment [task-id] (--body TEXT | --body-file -) [--json]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--body <text> | --body-file - (required)", "--json"}, Description: "Add a comment to a task, authored by this agent inside a session (like the MCP path) or by the runner owner when run headless.", Mutates: true},
	{Tool: "task_dependency_graph", Argv: []string{"orbit", "task", "dependency-graph"}, Usage: "orbit task dependency-graph [task-id] [--max-depth N] [--max-nodes N] [--json]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--max-depth <n> (server default when unset)", "--max-nodes <n> (server default when unset)", "--json"}},
	{Tool: "task_dependency_add", Argv: []string{"orbit", "task", "dependency-add"}, Usage: "orbit task dependency-add [task-id] --depends-on ID [--json]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--depends-on <id> (required)", "--json"}, Description: "Add one dependency edge: taskId waits for --depends-on. Point it at the SUBJECT rather than at that subject's verification task: once anything checks that task, the server holds the edge until its latest check has PASSED. An edge naming the check resolves to the same gate, so older plans keep working.", Mutates: true},
	{Tool: "task_dependency_remove", Argv: []string{"orbit", "task", "dependency-remove"}, Usage: "orbit task dependency-remove [task-id] --depends-on ID [--json]", Arguments: []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--depends-on <id> (required)", "--json"}, Mutates: true},
	{Tool: "tasklist_list", Argv: []string{"orbit", "task-list", "list"}, Usage: "orbit task-list list [--json]", Arguments: []string{"--json"}},
	{Tool: "tasklist_create", Argv: []string{"orbit", "task-list", "create"}, Usage: "orbit task-list create --title TITLE [--json]", Arguments: []string{"--title <text> (required)", "--json"}, Mutates: true},
	{Tool: "tasklist_get", Argv: []string{"orbit", "task-list", "get"}, Usage: "orbit task-list get LIST_ID [--json]", Arguments: []string{"[list-id] (required)", "--json"}},
	{Tool: "tasklist_update", Argv: []string{"orbit", "task-list", "update"}, Usage: "orbit task-list update LIST_ID [options]", Arguments: []string{"[list-id] (required)", "--title <text>", "--instructions <text> | --instructions-file -", "--paused[=true|false]", "--verify-on-done[=true|false]", "--max-concurrent <n> | --clear-max-concurrent", "--foreman-workspace-id <id> | --clear-foreman", "--foreman-stall-minutes <n>", "--note <text>", "--json"}, Description: "Change a task list's dispatch policy. In a session the change is attributed to this agent (like the MCP path); headless it falls back to the runner owner. Every change is recorded as a restorable revision.", Mutates: true},
	{Tool: "tasklist_propose_dag", Argv: []string{"orbit", "task-list", "propose-dag"}, Usage: "orbit task-list propose-dag LIST_ID --add A:B [--remove C:D] [--apply] [--json]", Arguments: []string{"[list-id] (required)", "--add <task-id>:<depends-on-id> (repeatable, sets ops)", "--remove <task-id>:<depends-on-id> (repeatable, sets ops)", "--note <text>", "--apply", "--json"}, Description: "Preview a batch of dependency changes to a list's DAG, and with --apply write it. Unlike the MCP tool this raises no approval — at a terminal the human is already the one deciding. The preview names what would be written and, more usefully, which tasks change dependency state as a result.", Mutates: true},
	{Tool: "tasklist_delete", Argv: []string{"orbit", "task-list", "delete"}, Usage: "orbit task-list delete LIST_ID [--json]", Arguments: []string{"[list-id] (required)", "--json"}, Description: "Delete a task list. Its tasks are not deleted — they are detached and become listless; the grouping, its standing instructions and its policy revisions are what go, and that cannot be undone. To stop dispatch without discarding them, pass --paused true to task-list update instead.", Mutates: true},
})

func withTaskCompletionCapabilityArgs(capabilities []cliCapabilitySpec) []cliCapabilitySpec {
	// Kept beside the flag implementation instead of expanding the already very wide legacy
	// capability literals above. The capability document must name every MCP field the equivalent
	// CLI can send; completionCriterion and EXECUTABLE's pair stay beside their flag implementation.
	for i := range capabilities {
		switch capabilities[i].Tool {
		case "task_create":
			capabilities[i].Arguments = append(
				capabilities[i].Arguments,
				"--completion-criterion <EXECUTABLE|VERIFICATION|EVIDENCE_JUDGMENT> (required for every runner task creation; EVIDENCE_JUDGMENT is never inferred)",
				"--completion-criterion-override-reason <text> (non-blank audit reason for keeping a criterion after TASK_CRITERION_SHAPE_ADVICE)",
				"--acceptance-command <shell> (the one EXECUTABLE command; use with --acceptance-expected-exit-code)",
				"--acceptance-expected-exit-code <n> (exit code that derives DONE; use with --acceptance-command)",
				"--acceptance-timeout-seconds <n> (requested v2 timeout; admitted exactly or rejected before spawn)",
				"--acceptance-owner-timeout-ceiling-seconds <n> (owner ceiling checked before spawn; requires --acceptance-timeout-seconds)",
			)
		case "task_update":
			capabilities[i].Arguments = append(
				capabilities[i].Arguments,
				"--completion-criterion <EXECUTABLE|VERIFICATION|EVIDENCE_JUDGMENT> (replace the task's one normal completion criterion)",
				"--acceptance-command <shell> (replace the one EXECUTABLE command)",
				"--acceptance-expected-exit-code <n> (replace the exit code that derives DONE)",
				"--acceptance-timeout-seconds <n> (replace the requested v2 timeout; never silently clamped)",
				"--acceptance-owner-timeout-ceiling-seconds <n> (replace the owner ceiling; requires --acceptance-timeout-seconds)",
				"--clear-acceptance-timeout (return the executable declaration to the N-1 legacy plan)",
				"--clear-executable-acceptance (clear both EXECUTABLE fields)",
			)
		}
	}
	return capabilities
}

type cliCapability struct {
	ID             string                 `json:"id"`
	Argv           []string               `json:"argv"`
	HelpArgv       []string               `json:"helpArgv"`
	Usage          string                 `json:"usage"`
	Arguments      []string               `json:"arguments"`
	Description    string                 `json:"description"`
	MCPInputSchema map[string]interface{} `json:"mcpInputSchema"`
	Mutates        bool                   `json:"mutates"`
}

type cliCapabilityContext struct {
	Actor     string `json:"actor"`
	SessionID string `json:"sessionId,omitempty"`
	AgentID   string `json:"agentId,omitempty"`
	TaskID    string `json:"taskId,omitempty"`
	// Present when this process holds a minted service credential, so a headless operator can
	// see which grant is in play without decoding the token by hand.
	ServiceToken *cliServiceTokenContext `json:"serviceToken,omitempty"`
}

type cliServiceTokenContext struct {
	Scopes  []string `json:"scopes"`
	AgentID string   `json:"agentId,omitempty"`
}

type cliCapabilitiesDocument struct {
	SchemaVersion            int                  `json:"schemaVersion"`
	CapabilityRevision       int                  `json:"capabilityRevision"`
	ServerCapabilityRevision int                  `json:"serverCapabilityRevision"`
	ServerSchemaRevision     int                  `json:"serverSchemaRevision"`
	ContractDigest           string               `json:"contractDigest"`
	CapabilityCount          int                  `json:"capabilityCount"`
	CLIVersion               string               `json:"cliVersion"`
	Registered               bool                 `json:"registered"`
	UnavailableReason        string               `json:"unavailableReason,omitempty"`
	Context                  cliCapabilityContext `json:"context"`
	Capabilities             []cliCapability      `json:"capabilities"`
}

func buildCLICapabilities(executable string) cliCapabilitiesDocument {
	ctx := cliCapabilityContext{
		SessionID: strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID")),
		AgentID:   strings.TrimSpace(os.Getenv("ORBIT_AGENT_ID")),
		TaskID:    strings.TrimSpace(os.Getenv("ORBIT_TASK_ID")),
		// Derived from the write path itself rather than restated, so the document cannot claim
		// one author while the tasks it creates record another: in a session these commands
		// stamp the acting agent, headless they write as the runner owner.
		Actor: cliCapabilityActor(),
	}
	// A minted service credential names its own scopes, so it decides what this process may do —
	// including inside a session, where it was passed deliberately rather than injected.
	service := decodeServiceTokenClaims(currentServiceToken())
	includeOrchestration := service == nil && mcpOrchestrationEnabled() && ctx.SessionID != ""
	// No session context at all => a headless process (launchd/cron), which reaches only what its
	// credential grants. An in-session agent whose agent has orchestration off is NOT headless:
	// it keeps seeing no session_* capability.
	includeHeadlessSession := service != nil || (!includeOrchestration && ctx.SessionID == "")
	if service != nil {
		ctx.ServiceToken = &cliServiceTokenContext{Scopes: service.Scopes, AgentID: service.AgentID}
	}
	descriptors := make(map[string]map[string]interface{})
	for _, d := range toolDescriptors(false, includeOrchestration || includeHeadlessSession) {
		name, _ := d["name"].(string)
		descriptors[name] = d
	}
	specs := append([]cliCapabilitySpec{}, baseCLICapabilities...)
	// Ungated like the task commands, whose `provider` field it answers for.
	specs = append(specs, providerCLICapabilities...)
	// Also ungated: it only reads, and the agent that needs a project's goal and acceptance
	// criteria is the plain coordinator session that has no session_* tools at all.
	specs = append(specs, projectCLICapabilities...)
	// Also ungated, and for the same kind of reason: asking your own owner for a human is not an
	// orchestration power, and the agents most likely to need one are the plain single-session
	// ones this document is usually read by.
	specs = append(specs, notifyCLICapabilities...)
	// Same argument again (§13.7): recording that a merge happened is evidence about the caller's
	// own work, not a power over somebody else's session.
	specs = append(specs, mergeReceiptCLICapabilities...)
	if includeOrchestration {
		specs = append(specs, sessionCLICapabilities...)
		// The agent verbs ride the same gate as the session ones and have no headless form:
		// no service-token scope names them, so they never appear outside a live session.
		specs = append(specs, agentCLICapabilities...)
	} else if includeHeadlessSession {
		specs = append(specs, headlessSessionCLICapabilities(headlessAllowedActions(service))...)
	}
	commands := make([]cliCapability, 0, len(specs))
	for _, spec := range specs {
		if spec.HeadlessOnly && ctx.SessionID != "" {
			continue
		}
		d := descriptors[spec.Tool]
		description, _ := d["description"].(string)
		if spec.Description != "" {
			description = spec.Description
		}
		schema, _ := d["inputSchema"].(map[string]interface{})
		argv := append([]string{}, spec.Argv...)
		argv[0] = executable
		commands = append(commands, cliCapability{
			ID:             spec.Tool,
			Argv:           argv,
			HelpArgv:       append(append([]string{}, argv...), "--help"),
			Usage:          spec.Usage,
			Arguments:      append([]string{}, spec.Arguments...),
			Description:    description,
			MCPInputSchema: schema,
			Mutates:        spec.Mutates,
		})
	}
	registered := false
	unavailableReason := ""
	if err := configStoragePrivate(); err == nil {
		registered = loadConfig() != nil
	} else if !os.IsNotExist(err) {
		unavailableReason = "runner credential storage is not private; restart the Orbit runner once to migrate it"
	}
	return cliCapabilitiesDocument{
		SchemaVersion:            runnerWriteSchemaRevision,
		CapabilityRevision:       runnerWriteCapabilityRevision,
		ServerCapabilityRevision: runnerWriteCapabilityRevision,
		ServerSchemaRevision:     runnerWriteSchemaRevision,
		ContractDigest:           runnerWriteContractDigest,
		CapabilityCount:          len(commands),
		CLIVersion:               version,
		Registered:               registered,
		UnavailableReason:        unavailableReason,
		Context:                  ctx,
		Capabilities:             commands,
	}
}

func cmdCapabilitiesCLI(args []string, out io.Writer) error {
	fs := newCLIFlagSet("orbit capabilities")
	jsonOut := fs.Bool("json", false, "emit JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	executable := orbitCLIExecutable()
	if executable == "" {
		return fmt.Errorf("cannot resolve a safe absolute path to the Orbit executable")
	}
	doc := buildCLICapabilities(executable)
	if *jsonOut {
		enc := json.NewEncoder(out)
		enc.SetEscapeHTML(false)
		return enc.Encode(doc)
	}
	if _, err := fmt.Fprintf(out, "Orbit CLI %s — agent-safe capabilities\n", doc.CLIVersion); err != nil {
		return err
	}
	for _, c := range doc.Capabilities {
		if _, err := fmt.Fprintf(out, "  %s\n      %s\n", c.Usage, c.Description); err != nil {
			return err
		}
	}
	return nil
}
