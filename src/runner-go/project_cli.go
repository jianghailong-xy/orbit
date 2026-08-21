package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
)

// `orbit project` — the CLI half of the project_* MCP tools. A project is the durable context a
// coordinator works from: what the work is for (goal), what would settle that it is finished
// (acceptanceCriteria), and how it is to be done (instructions). None of that is in a task's
// description, and a coordinator session that cannot read it is left inferring the objective from
// whichever task it happens to be looking at.
//
// An agent may also state it. `create` records a project it was asked to set up, and `update`
// revises the prose or settles the status when the work lands — the same fields, through the same
// server DTOs, as the person typing them into the web UI. `delete` mirrors the user door's guarded
// removal: only an empty project can be destroyed. Listing projects and opening a coordinator are
// still the human's door.
//
// `create` is the one that carries the session it ran in, because a project recorded from inside a
// session is bound to that session as its coordinator, together with the workspace it runs in.
// Opening the coordinator is still the human's door; which conversation it opens is settled at
// creation, so that door leads back here rather than somewhere new.
//
// Scope is the runner's owner throughout: the credential names a machine, so the only account
// these commands can read or write is the one that machine belongs to.

const projectHelp = `orbit project — read and write an Orbit project's durable context

Usage:
  orbit project get PROJECT_ID [--json]
  orbit project status PROJECT_ID [--json]
  orbit project blockers PROJECT_ID [--history] [--json]
  orbit project verifications PROJECT_ID [--json]
  orbit project acceptance PROJECT_ID [--json]
  orbit project acceptance-run PROJECT_ID [--json]
  orbit project acceptance-verdict PROJECT_ID --run-id ID --criteria JSON [--json]
  orbit project merge-evidence PROJECT_ID --requirement-id ID --target-branch REF --content-hash SHA256 [options]
  orbit project create --title TITLE [options]
  orbit project update PROJECT_ID [options]
  orbit project delete PROJECT_ID [--json]

Run 'orbit project <command> --help' for options.
`

var projectActionHelp = map[string]string{
	"blockers": `orbit project blockers — what is stopping this project, and what used to

Usage:
  orbit project blockers PROJECT_ID [--history] [--json]

Each open blocker says four things: what kind of stop it is, who can clear it, what would clear
it, and when it is next rechecked — plus one executable sentence rather than a restated error.

--history adds the episodes that are already over, with what ended them and when. Those rows are
never deleted on resolution: the next episode on the same key takes its lifecycle generation from
the whole history, so "what was blocking this last Tuesday" stays a question the audit answers.

Read it when a project is OPEN and nothing is running. An open blocker is a precondition, not a
status somebody rewrote, so nothing else about the project looks unusual.

Options:
  --history                Include resolved episodes
  --json
`,
	"get": `orbit project get — one project's goal, acceptance criteria and instructions

Usage:
  orbit project get PROJECT_ID [--json]

Returns the project a coordinator works from: its title, goal, acceptanceCriteria and
instructions, its status, the session and workspace it is coordinated from, and how its
tasks are distributed (_count plus tasksByStatus).

Returns the shape of the project, not its tasks — use ` + "`orbit task list`" + ` for those.
PROJECT_ID is the id shown in the web UI URL (e.g. /projects/<id>); a raw UUID works too.
`,
	"status": `orbit project status — what the coordinator is doing, and why it is not doing more

Usage:
  orbit project status PROJECT_ID [--json]

The answer to "why is this project not moving". One read, eleven sections:

  project        title, lifecycle status and how its tasks are distributed
  coordination   which agent coordinates it, where it runs, the coordination session and
                 which generation that is (the agent outlives every one of them)
  policy         whether the coordinator is switched on at all, how far it may go when it
                 runs (MANUAL / GUARDED_AUTO / AUTO), and configRevision
  consumption    tasks in flight against the cap, coordinator sessions against the daily
                 budget — the same numbers the admission gates compare against
  runtime        run state, whether a pass holds the lease and until when, fencing token
  nextWake       when it looks again and why, plus the candidates that lost
  decisions      the last few judgments: what each decided, and the actions and idempotency
                 keys it produced
  pendingActions claimed but not yet published — what is in flight this second
  blockers       what is stopping it, who can fix it, what would clear it, when it is
                 rechecked, and the resolved episodes
  events         durable signals still pending, with attempts and backoff, plus recent ones
  acceptance     the stated criteria, the last acceptance run, verdict tallies and the
                 per-branch merge evidence

A fact that is absent is null with a reason beside it — agentIdAbsentReason,
leaseAbsentReason, candidatesAbsentReason — never a missing field. "Nothing is blocking
this project" and "this build cannot tell you" are different answers and read differently.

Read only. Asking the coordinator to run now is the account owner's, through the Orbit web
app or the user API; a runner credential names a machine, and a machine that could trigger
its own coordinator would be driving the project MANUAL says only a person drives.

PROJECT_ID is the id shown in the web UI URL (e.g. /projects/<id>); a raw UUID works too.
`,
	"verifications": `orbit project verifications — what the checks concluded, and what they hold up

Usage:
  orbit project verifications PROJECT_ID [--json]

Returns three lists:
  verifications  each check in the project, its subject, its verdict, and which conclusion
                 that is (verdictRevision — a re-run gets a new one, so the same verdict
                 twice is two findings rather than one)
  failures       what each FAIL or INCONCLUSIVE left behind: the defect subtask filed under
                 the subject, the action that raised it, and whether a later PASS resolved it
  blockedTasks   the tasks that cannot be dispatched because of an unresolved failure, and
                 the reason for each (SUBJECT_DEFECT_OPEN, or UPSTREAM for a dependent)

Read it when a task looks ready and is not running. A blocked task looks like an ordinary
OPEN task on purpose — the block is a dispatch precondition, not a status anybody rewrote —
so this is the only place that says why.

A FAIL sends its subject back to OPEN and files the defect on its own. Fixing the defect is
what makes the subject runnable again; the check still has to run again before the work
downstream is released, because an old verdict never becomes a pass by itself.

PROJECT_ID is the id shown in the web UI URL (e.g. /projects/<id>); a raw UUID works too.
`,
	"acceptance": `orbit project acceptance — the evidence a DONE would be checked against

Usage:
  orbit project acceptance PROJECT_ID [--json]

Read this before you claim a project is finished. "The tests passed" written in a comment
is not evidence the server can check; a run in this record is.

Returns:
  criteria         the stated acceptance criteria, decomposed one per non-blank line — this
                   is the checklist an acceptance run has to answer, item for item
  acceptanceDigest the digest of the facts a DONE is checked against: the criteria text,
                   every task with its status and completion policy, every verification
                   verdict, and the newest merge observation per requirement
  runs             every attempt: its verdict, its per-criterion conclusions and evidence,
                   the digest of the facts it judged, and whether it has been superseded
  mergeEvidence    what each target branch was last observed to CONTAIN, and at which
                   refGeneration
  audit            append-only: runs opened and concluded, DONEs bound and refused, and
                   every reopen with the fact that caused it
  doneGate         whether a DONE would be allowed right now and, if not, the code and the
                   sentence the write would be refused with

The three refusals: ACCEPTANCE_MISSING (no usable PASS — none run, not concluded, concluded
FAIL or INCONCLUSIVE, or concluded by a person rather than the coordinator),
ACCEPTANCE_EVIDENCE_STALE (a PASS exists but a task, a verdict, the criteria or the branch
content has changed since it ran), ACCEPTANCE_BLOCKED (an open blocker or an unresolved
verification failure).

PROJECT_ID is the id shown in the web UI URL (e.g. /projects/<id>); a raw UUID works too.
`,
	"acceptance-run": `orbit project acceptance-run — open an acceptance attempt

Usage:
  orbit project acceptance-run PROJECT_ID [--json]

Freezes the project's acceptance criteria with their digest and creates one empty row per
stated criterion — the checklist ` + "`orbit project acceptance-verdict`" + ` has to fill.

Opening an attempt supersedes any earlier live one, so there is never a choice of which
conclusion to believe. Run it when you are about to CHECK the project, not when you are
about to report on it: the digest is taken now, and a fact that changes afterwards makes
this attempt stale rather than wrong.

A project that states no acceptance criteria is refused — an acceptance with nothing to
check would pass by having nothing to fail.

PROJECT_ID is the id shown in the web UI URL (e.g. /projects/<id>); a raw UUID works too.
`,
	"acceptance-verdict": `orbit project acceptance-verdict — conclude an acceptance attempt

Usage:
  orbit project acceptance-verdict PROJECT_ID --run-id ID --criteria JSON [--json]

Options:
  --run-id ID          the attempt to conclude (from 'orbit project acceptance-run')
  --criteria JSON      one object per stated criterion (see below)
  --criteria-file -    read the criteria array from stdin
  --json               emit compact JSON

--criteria is a JSON array, one entry per criterion in the attempt's snapshot:

  [{"ordinal":1,"verdict":"PASS","summary":"28/28 on a disposable database",
    "evidence":{"command":"bash scripts/project-e2e.sh","exitCode":0,"sha":"54744005"}},
   {"criterionKey":"9f2c…","verdict":"FAIL","summary":"clause 12 unmet"}]

Address each criterion by ordinal (its position in the snapshot) or by criterionKey (its
content). Every criterion must be answered: a missing one is refused, because a project-
level PASS is the conjunction of them, and one nobody checked is not a pass.

The attempt's own verdict is DERIVED and cannot be supplied — all PASS is PASS, any FAIL is
FAIL, anything else is INCONCLUSIVE. That is the whole difference between this and writing
"all green" in a task comment.

Put real evidence in ` + "`evidence`" + `: the command, its exit code, the key output, the SHA and
the environment. It is JSON so that a later reviewer can check it rather than read it.
`,
	"merge-evidence": `orbit project merge-evidence — record what a target branch was observed to contain

Usage:
  orbit project merge-evidence PROJECT_ID --requirement-id ID --target-branch REF
                               --content-hash SHA256 [options]

Options:
  --requirement-id ID    what was required, in the words the acceptance criteria use
  --target-branch REF    where it had to land (e.g. main, feat/project)
  --content-hash SHA256  sha256 of the observed CONTENT — 64 hex characters
  --source TEXT          who observed it (default MERGE_EVIDENCE_WRITER)
  --detail JSON          the raw observation: the command, its output, the blob ids
  --json                 emit compact JSON

By CONTENT, never by ` + "`git branch --contains`" + `: after a squash merge that answer is a
guaranteed false negative while the content is plainly there. Hash what you actually read —
a normalized ` + "`git grep`" + ` result, a blob or tree digest, a rendered diff.

Same content as the last observation and only the observation time moves. Different content
and a NEW row is written one refGeneration up — which is what makes "the branch changed and
changed back" visible to a database that cannot lock a git ref. If the project was DONE
against the old content, that same write reopens it.
`,
	"create": `orbit project create — record a new project

Usage:
  orbit project create --title TITLE [options]

Options:
  --title TEXT                     what this body of work is called (required)
  --goal TEXT                      what the project is trying to achieve (max 4,000 characters)
  --goal-file -                    read the goal from stdin
  --acceptance-criteria TEXT       what would settle that the goal was reached (max 4,000)
  --acceptance-criteria-file -     read the acceptance criteria from stdin
  --instructions TEXT              how this project's work is to be done (max 10,000 characters)
  --instructions-file -            read the instructions from stdin
  --json                           emit compact JSON

The project is created under this runner's owner and starts OPEN. It holds no tasks yet —
file them with ` + "`orbit task create --project-id <id>`" + ` once it exists.

Run inside a session, the project is bound to THAT session as its coordinator — and to the
workspace it runs in — in the same write that creates the project, so opening the coordinator
later comes back to this conversation instead of starting a new one. A session coordinates at
most one project, so recording a second from the same session is refused and nothing is created.
Run headless there is no session to bind and no such binding: the coordinator is opened wherever
the project's work turns out to run, or wherever you say.

Only one --*-file flag per invocation: they all read the same stdin, and the second read
would silently come back empty.
`,
	"update": `orbit project update — revise a project's context, or settle where it stands

Usage:
  orbit project update PROJECT_ID [options]

Options:
  --title TEXT                     rename the project
  --goal TEXT                      replace what the project is trying to achieve (max 4,000)
  --goal-file -                    read the replacement goal from stdin
  --clear-goal                     leave the project with no stated goal
  --acceptance-criteria TEXT       replace what would settle the goal was reached (max 4,000)
  --acceptance-criteria-file -     read the replacement acceptance criteria from stdin
  --clear-acceptance-criteria      leave the project with no stated acceptance criteria
  --instructions TEXT              replace how the work is to be done (max 10,000 characters)
  --instructions-file -            read the replacement instructions from stdin
  --clear-instructions             leave the project with no standing instructions
  --status OPEN|DONE|CANCELLED     where the work stands
  --expected-config-revision N     only write if the project is still at that configRevision
  --json                           emit compact JSON

Only the flags you pass are sent, so revising the goal never blanks the instructions.
Each prose field is a whole-field replacement: text replaces it, --clear-<field> removes it,
and naming both for one field is refused rather than resolved by a preference order.

--status DONE says the goal was reached and CANCELLED says it will not be; neither is a way
to file the project out of sight. At least one flag is required — an update naming no field
is refused here rather than sent as a request that would change nothing, and the fence below
does not count as one: it names nothing to write.

--expected-config-revision is a compare-and-swap. Pass the configRevision you read from
'orbit project status' and the write commits only if the project is still at it; otherwise
it is refused with STALE_CONFIG_REVISION and nothing is written. Use it when you read the
project first and are acting on what you read — the account owner may have changed its
coordination settings since, and being told beats overwriting a decision you did not see.
Omit it and the write behaves exactly as it always has.

Only one --*-file flag per invocation: they all read the same stdin.
`,
	"delete": `orbit project delete — permanently delete an empty project

Usage:
  orbit project delete PROJECT_ID [--json]

This cannot be undone. The project must hold no tasks: deleting a project never deletes or
detaches its tasks, because their project records what they are for. If any remain, the server
refuses the whole request; move them to another project or delete them first.

PROJECT_ID is the id shown in the web UI URL (e.g. /projects/<id>); a raw UUID works too.
`,
}

var projectCLICapabilities = []cliCapabilitySpec{
	{Tool: "project_get", Argv: []string{"orbit", "project", "get"}, Usage: "orbit project get PROJECT_ID [--json]", Arguments: []string{"[project-id] (required)", "--json"}},
	{Tool: "project_status", Argv: []string{"orbit", "project", "status"}, Usage: "orbit project status PROJECT_ID [--json]", Arguments: []string{"[project-id] (required)", "--json"}, Description: "Read everything the control loop knows about one project — the answer to \"why is this project not moving\", which is otherwise spread over seven tables and usually misread as \"it is broken\". Returns its run state and lifecycle; which agent coordinates it, where, and the coordination session and generation; whether the coordinator is switched on and how far it may go (MANUAL / GUARDED_AUTO / AUTO) with the configRevision a control write states back; tasks in flight against the cap and coordinator sessions against the daily budget, counted exactly as the admission gates count them; whether a pass holds the lease; when it next wakes, why, and which candidates lost; the last few decisions with the actions and idempotency keys they produced; actions claimed but not yet published; what is blocking it, who can fix it, what would clear it and when it is rechecked; durable signals still pending with their attempts and backoff; and the acceptance evidence — stated criteria, last acceptance run, verdict tallies and per-branch merge state. Every absent fact is null beside a reason, so \"nothing is blocking this\" and \"this cannot be reported\" are different answers."},
	{Tool: "project_blockers", Argv: []string{"orbit", "project", "blockers"}, Usage: "orbit project blockers PROJECT_ID [--history] [--json]", Arguments: []string{"[project-id] (required)", "--history (include the episodes that are already resolved)", "--json"}, Description: "Read what is stopping one project: each open blocker's kind, who can clear it (owner), what would clear it (recovery), what it is about, the one executable sentence that would resolve it, when it is next rechecked, and which action raised it. --history adds the episodes that are already over, with what ended them and when — those rows are never deleted, because the lifecycle generation of the next episode on the same key is allocated over the whole history, so \"what was blocking this yesterday\" stays a question the audit can answer. Read it when a project is OPEN and nothing is running: an open blocker is a precondition rather than a status anybody rewrote, so nothing else on the project looks unusual."},
	{Tool: "project_verifications", Argv: []string{"orbit", "project", "verifications"}, Usage: "orbit project verifications PROJECT_ID [--json]", Arguments: []string{"[project-id] (required)", "--json"}, Description: "Read what every verification in one project concluded and what those conclusions are still holding up: each check's verdict and verdictRevision, the defect subtask each FAIL filed under its subject, the action that raised it, whether a later PASS resolved it, and blockedTasks — the exact tasks that cannot be dispatched because of an unresolved failure, with the reason. Read it when a task looks ready and is not running: a blocked task looks like an ordinary OPEN task on purpose, because the block is a dispatch precondition rather than a status anybody rewrote."},
	{Tool: "project_acceptance", Argv: []string{"orbit", "project", "acceptance"}, Usage: "orbit project acceptance PROJECT_ID [--json]", Arguments: []string{"[project-id] (required)", "--json"}, Description: "Read the evidence a project's DONE would be checked against, and whether it would be allowed right now. Returns the stated acceptance criteria decomposed one per line (the checklist an acceptance run has to answer item for item), acceptanceDigest — the digest of the criteria text, every task with its status and completion policy, every verification verdict and the newest merge observation per requirement — every attempt with its per-criterion conclusions and evidence, what each target branch was last observed to contain, the append-only audit of runs, bindings, refusals and reopens, and doneGate: allowed, or the code and sentence the write would be refused with (ACCEPTANCE_MISSING, ACCEPTANCE_EVIDENCE_STALE, ACCEPTANCE_BLOCKED). Read it before claiming a project is finished: a comment saying the tests passed is not evidence the server can check."},
	{Tool: "project_acceptance_run", Argv: []string{"orbit", "project", "acceptance-run"}, Usage: "orbit project acceptance-run PROJECT_ID [--json]", Arguments: []string{"[project-id] (required)", "--json"}, Description: "Open a project acceptance attempt: the acceptance criteria are frozen with their digest and one empty row per stated criterion is created — the checklist project_acceptance_verdict then has to fill. Open it when you are about to CHECK the project, not when you are about to report on it: the digest of the facts is taken now, and a task, verdict, criteria or branch-content change afterwards makes this attempt stale rather than wrong. Opening an attempt supersedes any earlier live one, so there is never a choice of which conclusion to believe. A project stating no acceptance criteria is refused, because an acceptance with nothing to check would pass by having nothing to fail.", Mutates: true},
	{Tool: "project_acceptance_verdict", Argv: []string{"orbit", "project", "acceptance-verdict"}, Usage: "orbit project acceptance-verdict PROJECT_ID --run-id ID --criteria JSON [--json]", Arguments: []string{"[project-id] (required)", "--run-id <id> (the attempt to conclude)", "--criteria <json> | --criteria-file - (one entry per stated criterion: {ordinal|criterionKey, verdict, summary, evidence, evidenceTaskId, evidenceSessionId})", "--json"}, Description: "Conclude a project acceptance attempt with one verdict per stated criterion. Address each criterion by ordinal (its position in the snapshot) or criterionKey (its content); every criterion must be answered, because a project-level PASS is the conjunction of them and one nobody checked is not a pass. The attempt's own verdict is DERIVED and cannot be supplied — all PASS is PASS, any FAIL is FAIL, anything else is INCONCLUSIVE — which is the whole difference between this and writing 'all green' in a task comment. Put real evidence in `evidence`: the command, its exit code, the key output, the SHA, the environment. Only a PASS recorded here lets the project be set DONE, and only while the facts it judged are still the current ones.", Mutates: true},
	{Tool: "project_merge_evidence", Argv: []string{"orbit", "project", "merge-evidence"}, Usage: "orbit project merge-evidence PROJECT_ID --requirement-id ID --target-branch REF --content-hash SHA256 [options]", Arguments: []string{"[project-id] (required)", "--requirement-id <text> (required)", "--target-branch <ref> (required)", "--content-hash <sha256> (required, 64 hex characters)", "--source <text>", "--detail <json>", "--json"}, Description: "Record what a target branch was observed to CONTAIN — the merge half of a project's acceptance evidence. Hash the content you actually read (a normalized `git grep` result, a blob or tree digest, a rendered diff), never `git branch --contains`: after a squash merge that answer is a guaranteed false negative while the content is plainly there. Same content as the last observation and only the observation time moves; different content writes a new row one refGeneration up, which is what makes 'the branch changed and changed back' visible to a database that cannot lock a git ref — and if the project was DONE against the old content, the same write reopens it.", Mutates: true},
	{Tool: "project_create", Argv: []string{"orbit", "project", "create"}, Usage: "orbit project create --title TITLE [options]", Arguments: []string{"--title <text> (required)", "--goal <text> | --goal-file - (what the work is trying to achieve; max 4,000 characters)", "--acceptance-criteria <text> | --acceptance-criteria-file - (what would settle that the goal was reached; max 4,000 characters)", "--instructions <text> | --instructions-file - (how the work is to be done; max 10,000 characters)", "--json"}, Description: "Create a project under this runner's owner — the durable context a body of work is carried out from, as opposed to a task, which is one piece of that work. Use it when you are asked to set up or plan out a body of work: --goal says what it is trying to achieve, --acceptance-criteria what would settle that the goal was reached, and --instructions how the work is to be done. The project starts OPEN and holds no tasks; file them with `orbit task create --project-id <id>` afterwards. Inside a session the project is also bound to that session as its coordinator, and to the workspace it runs in, in the same write that creates it — so opening the coordinator later returns to this conversation rather than starting another; one session coordinates at most one project, and headless there is no session and so no such binding.", Mutates: true},
	{Tool: "project_update", Argv: []string{"orbit", "project", "update"}, Usage: "orbit project update PROJECT_ID [options]", Arguments: []string{"[project-id] (required)", "--title <text>", "--goal <text> | --goal-file - | --clear-goal", "--acceptance-criteria <text> | --acceptance-criteria-file - | --clear-acceptance-criteria", "--instructions <text> | --instructions-file - | --clear-instructions", "--status <OPEN|DONE|CANCELLED>", "--expected-config-revision <n>", "--json"}, Description: "Update a project you own. Only the flags you pass are sent, so revising the goal never blanks the instructions. Each prose field is a whole-field replacement: text replaces it and --clear-<field> removes it, which is why naming both for one field is refused. --status DONE records that the goal was reached and CANCELLED that it will not be — say so when the work actually lands, and note that neither is a way to file the project out of sight. At least one flag is required, and --expected-config-revision does not count as one: it is a compare-and-swap that names nothing to write. Pass it the configRevision you read from `orbit project status` and the write commits only if the project is still at it — otherwise it is refused with STALE_CONFIG_REVISION and nothing is written, which is what stops you silently overwriting a coordination setting the account owner changed after you read it. Only one --*-file flag per invocation, since they all read the same stdin.", Mutates: true},
	{Tool: "project_delete", Argv: []string{"orbit", "project", "delete"}, Usage: "orbit project delete PROJECT_ID [--json]", Arguments: []string{"[project-id] (required)", "--json"}, Description: "Permanently delete an empty project in the account this runner belongs to. This cannot be undone. A project that still holds tasks is refused without deleting or detaching any of them, because a task's project records what that task is for; move those tasks to another project or delete them first.", Mutates: true},
}

func cmdProjectCLI(args []string, in io.Reader, out io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		_, err := fmt.Fprint(out, projectHelp)
		return err
	}
	if args[0] == "help" {
		if len(args) == 1 {
			_, err := fmt.Fprint(out, projectHelp)
			return err
		}
		h, ok := projectActionHelp[args[1]]
		if !ok {
			return fmt.Errorf("unknown command %q", args[1])
		}
		_, err := fmt.Fprint(out, h)
		return err
	}
	action := args[0]
	h, known := projectActionHelp[action]
	if !known {
		return fmt.Errorf("unknown command %q\n\n%s", action, projectHelp)
	}
	if wantsHelp(args[1:]) {
		_, err := fmt.Fprint(out, h)
		return err
	}
	switch action {
	case "create":
		return cliProjectCreate(args[1:], in, out)
	case "update":
		return cliProjectUpdate(args[1:], in, out)
	case "delete":
		return cliProjectDelete(args[1:], out)
	case "status":
		return cliProjectCoordinatorStatus(args[1:], out)
	case "blockers":
		return cliProjectBlockers(args[1:], out)
	case "verifications":
		return cliProjectVerifications(args[1:], out)
	case "acceptance":
		return cliProjectAcceptance(args[1:], out)
	case "acceptance-run":
		return cliProjectAcceptanceRun(args[1:], out)
	case "acceptance-verdict":
		return cliProjectAcceptanceVerdict(args[1:], in, out)
	case "merge-evidence":
		return cliProjectMergeEvidence(args[1:], in, out)
	default:
		return cliProjectGet(args[1:], out)
	}
}

func cliProjectGet(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit project get")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	// No ORBIT_PROJECT_ID fallback, unlike the task commands: the runner injects no such id, so
	// there is no current project to default to and guessing one would read the wrong project.
	if id == "" {
		return fmt.Errorf("project id is required")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.getProject(id)
	if err != nil {
		return fmt.Errorf("get project: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

// cliProjectCoordinatorStatus is the control loop's own state at a terminal: one GET, one raw body
// through. Same shape as the two reads either side of it — the server decides what the sections
// are, and a second opinion formatted here would be one that drifts from the API and the web UI.
func cliProjectBlockers(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit project blockers")
	history := fs.Bool("history", false, "include the episodes that are already resolved")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	if id == "" {
		return fmt.Errorf("project id is required")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.getProjectBlockers(id, *history)
	if err != nil {
		return fmt.Errorf("get project blockers: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliProjectCoordinatorStatus(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit project status")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	if id == "" {
		return fmt.Errorf("project id is required")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.getProjectCoordinatorStatus(id)
	if err != nil {
		return fmt.Errorf("get project status: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

// cliProjectVerifications is the read half of §13.2 at a terminal: what the checks concluded and
// which tasks are waiting on one. Same shape as `get` — one path segment, one raw body through.
func cliProjectVerifications(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit project verifications")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	if id == "" {
		return fmt.Errorf("project id is required")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.getProjectVerifications(id)
	if err != nil {
		return fmt.Errorf("get project verifications: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

// cliProjectAcceptance is the read a coordinator makes before it claims a project is finished:
// what the criteria are, what has been checked, and whether a DONE would be allowed right now.
// One GET, one raw body through, exactly like the two reads either side of it.
func cliProjectAcceptance(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit project acceptance")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	if id == "" {
		return fmt.Errorf("project id is required")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.getProjectAcceptance(id)
	if err != nil {
		return fmt.Errorf("get project acceptance: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

// cliProjectAcceptanceRun opens an attempt. No flags beyond --json, and deliberately none for who
// is concluding: the credential is a machine's, so the server records the coordinator agent. A flag
// for it would be this process claiming an identity rather than the server reading one.
func cliProjectAcceptanceRun(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit project acceptance-run")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	if id == "" {
		return fmt.Errorf("project id is required")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.openProjectAcceptanceRun(id, map[string]interface{}{})
	if err != nil {
		return fmt.Errorf("open project acceptance run: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

// cliProjectAcceptanceVerdict concludes an attempt with one conclusion per stated criterion.
//
// The array is parsed here only far enough to prove it IS an array of objects — the server decides
// what a valid entry is, and a second opinion held at the terminal would be one that drifts from
// it. What is worth catching locally is the shape mistake that would otherwise arrive as a 400 the
// caller has to decode: a bare object, a string, an empty list.
func cliProjectAcceptanceVerdict(args []string, in io.Reader, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit project acceptance-verdict")
	runID := fs.String("run-id", "", "the acceptance attempt to conclude")
	criteria := fs.String("criteria", "", "JSON array, one entry per stated criterion")
	criteriaFile := fs.String("criteria-file", "", "read the criteria array from stdin (-)")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	if id == "" {
		return fmt.Errorf("project id is required")
	}
	if *runID == "" {
		return fmt.Errorf("--run-id is required; open an attempt with 'orbit project acceptance-run'")
	}
	text, set, err := readCLIText(in, *criteria, flagWasSet(fs, "criteria"), *criteriaFile, flagWasSet(fs, "criteria-file"), "criteria")
	if err != nil {
		return err
	}
	if !set || strings.TrimSpace(text) == "" {
		return fmt.Errorf("--criteria is required: one entry per stated criterion, addressed by ordinal or criterionKey")
	}
	var parsed []map[string]interface{}
	if err := json.Unmarshal([]byte(text), &parsed); err != nil {
		return fmt.Errorf("--criteria must be a JSON array of objects: %w", err)
	}
	if len(parsed) == 0 {
		return fmt.Errorf("--criteria must state a conclusion for every criterion; an empty array states none")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.finalizeProjectAcceptanceRun(id, *runID, map[string]interface{}{"criteria": parsed})
	if err != nil {
		return fmt.Errorf("conclude project acceptance run: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

// cliProjectMergeEvidence records what a branch was observed to contain. The hash is checked here
// for shape only — 64 hex characters — so that the commonest mistake, passing a commit SHA, is a
// message naming what the value should be instead of a 400 to decode.
func cliProjectMergeEvidence(args []string, in io.Reader, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit project merge-evidence")
	requirement := fs.String("requirement-id", "", "what was required, in the acceptance criteria's words")
	branch := fs.String("target-branch", "", "where it had to land")
	hash := fs.String("content-hash", "", "sha256 of the observed content (64 hex characters)")
	source := fs.String("source", "", "who observed it")
	detail := fs.String("detail", "", "JSON object: the command, its output, the blob ids")
	detailFile := fs.String("detail-file", "", "read the detail object from stdin (-)")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	if id == "" {
		return fmt.Errorf("project id is required")
	}
	if *requirement == "" || *branch == "" {
		return fmt.Errorf("--requirement-id and --target-branch are required")
	}
	if !isSHA256Hex(*hash) {
		return fmt.Errorf("--content-hash must be 64 hex characters: a sha256 of the CONTENT you " +
			"read, not a commit SHA and not `git branch --contains` (a squash makes both wrong)")
	}
	body := map[string]interface{}{
		"requirementId": *requirement,
		"targetBranch":  *branch,
		"contentHash":   strings.ToLower(*hash),
	}
	if *source != "" {
		body["source"] = *source
	}
	text, set, err := readCLIText(in, *detail, flagWasSet(fs, "detail"), *detailFile, flagWasSet(fs, "detail-file"), "detail")
	if err != nil {
		return err
	}
	if set && strings.TrimSpace(text) != "" {
		var parsed map[string]interface{}
		if err := json.Unmarshal([]byte(text), &parsed); err != nil {
			return fmt.Errorf("--detail must be a JSON object: %w", err)
		}
		body["detail"] = parsed
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.recordProjectMergeEvidence(id, body)
	if err != nil {
		return fmt.Errorf("record project merge evidence: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

// isSHA256Hex is the same shape the server's CONTENT_HASH_PATTERN validates.
func isSHA256Hex(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, r := range value {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') && (r < 'A' || r > 'F') {
			return false
		}
	}
	return true
}

// isDecimalRevision is the same shape the server's CONFIG_REVISION_PATTERN validates.
//
// Checked here so a typo is a message naming what the value should be rather than a 400 the caller
// has to decode — and kept a STRING rather than parsed, because `configRevision` is a bigint column
// served as a decimal string: turning it into a number here would silently round the exact value
// `orbit project status` printed.
func isDecimalRevision(value string) bool {
	if value == "" || len(value) > 20 {
		return false
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// projectStatuses is what --status accepts, and the same three values the server's UpdateProjectDto
// validates against. Checked here so a typo is a message naming the alternatives rather than a 400
// the caller has to decode.
var projectStatuses = []string{"OPEN", "DONE", "CANCELLED"}

func validateProjectCLIStatus(status string) error {
	for _, valid := range projectStatuses {
		if status == valid {
			return nil
		}
	}
	return fmt.Errorf("--status must be one of %s", strings.Join(projectStatuses, ", "))
}

// projectStdinFlags rejects naming more than one --*-file flag in a single invocation.
//
// They all read the same stdin, one field at a time, and nothing downstream can notice that the
// first read drained the stream: the second field arrives as an empty string and the command
// reports success having blanked it. Caught before any read and before any request — a direct
// value for one field and stdin for another stays legal, because that is unambiguous.
func projectStdinFlags(fs *flag.FlagSet, names ...string) error {
	set := []string{}
	for _, name := range names {
		if flagWasSet(fs, name) {
			set = append(set, "--"+name)
		}
	}
	if len(set) > 1 {
		return fmt.Errorf("%s all read stdin and cannot be used together; pass one of them inline",
			strings.Join(set, " and "))
	}
	return nil
}

func cliProjectCreate(args []string, in io.Reader, out io.Writer) error {
	fs := newCLIFlagSet("orbit project create")
	title := fs.String("title", "", "what this body of work is called")
	goal := fs.String("goal", "", "what the project is trying to achieve")
	goalFile := fs.String("goal-file", "", "read the goal from stdin (-)")
	acceptanceCriteria := fs.String("acceptance-criteria", "", "what would settle that the goal was reached")
	acceptanceCriteriaFile := fs.String("acceptance-criteria-file", "", "read the acceptance criteria from stdin (-)")
	instructions := fs.String("instructions", "", "how this project's work is to be done")
	instructionsFile := fs.String("instructions-file", "", "read the instructions from stdin (-)")
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
	if err := projectStdinFlags(fs, "goal-file", "acceptance-criteria-file", "instructions-file"); err != nil {
		return err
	}
	body := map[string]interface{}{"title": *title}
	goalText, goalSet, err := readCLIText(in, *goal, flagWasSet(fs, "goal"), *goalFile, flagWasSet(fs, "goal-file"), "goal")
	if err != nil {
		return err
	}
	if goalSet {
		body["goal"] = goalText
	}
	criteria, criteriaSet, err := readCLIText(in, *acceptanceCriteria, flagWasSet(fs, "acceptance-criteria"), *acceptanceCriteriaFile, flagWasSet(fs, "acceptance-criteria-file"), "acceptance-criteria")
	if err != nil {
		return err
	}
	if criteriaSet {
		body["acceptanceCriteria"] = criteria
	}
	instructionsText, instructionsSet, err := readCLIText(in, *instructions, flagWasSet(fs, "instructions"), *instructionsFile, flagWasSet(fs, "instructions-file"), "instructions")
	if err != nil {
		return err
	}
	if instructionsSet {
		body["instructions"] = instructionsText
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	// The session this ran in, the same env var `orbit task create` attributes a task with and
	// `orbit notify` routes an alert by. Here the server reads it to record that session's
	// workspace as the new project's coordinator default, so the project can be coordinated
	// straight away rather than only once one of its tasks has an assignee to borrow from.
	// Headless (launchd/cron, no ORBIT_SESSION_ID) sends no header and gets no default, which is
	// the honest answer: no session, no workspace to inherit.
	raw, err := t.createProject(strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID")), body)
	if err != nil {
		return fmt.Errorf("create project: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliProjectUpdate(args []string, in io.Reader, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit project update")
	title := fs.String("title", "", "rename the project")
	goal := fs.String("goal", "", "replace what the project is trying to achieve")
	goalFile := fs.String("goal-file", "", "read the replacement goal from stdin (-)")
	clearGoal := fs.Bool("clear-goal", false, "leave the project with no stated goal")
	acceptanceCriteria := fs.String("acceptance-criteria", "", "replace what would settle that the goal was reached")
	acceptanceCriteriaFile := fs.String("acceptance-criteria-file", "", "read the replacement acceptance criteria from stdin (-)")
	clearAcceptanceCriteria := fs.Bool("clear-acceptance-criteria", false, "leave the project with no stated acceptance criteria")
	instructions := fs.String("instructions", "", "replace how this project's work is to be done")
	instructionsFile := fs.String("instructions-file", "", "read the replacement instructions from stdin (-)")
	clearInstructions := fs.Bool("clear-instructions", false, "leave the project with no standing instructions")
	status := fs.String("status", "", "where the work stands: OPEN, DONE or CANCELLED")
	expectedConfigRevision := fs.String("expected-config-revision", "", "only write if the project is still at this configRevision")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	if id == "" {
		return fmt.Errorf("project id is required")
	}
	if flagWasSet(fs, "status") {
		if err := validateProjectCLIStatus(*status); err != nil {
			return err
		}
	}
	// Clearing and replacing are opposite instructions about the same field, so naming both is not
	// a preference order to resolve — including when the replacement is on stdin, which is why this
	// is caught before anything reads it.
	for _, field := range []struct {
		name  string
		clear bool
	}{
		{"goal", *clearGoal},
		{"acceptance-criteria", *clearAcceptanceCriteria},
		{"instructions", *clearInstructions},
	} {
		if !field.clear {
			continue
		}
		if flagWasSet(fs, field.name) {
			return fmt.Errorf("--clear-%s and --%s cannot be used together", field.name, field.name)
		}
		if flagWasSet(fs, field.name+"-file") {
			return fmt.Errorf("--clear-%s and --%s-file cannot be used together", field.name, field.name)
		}
	}
	if err := projectStdinFlags(fs, "goal-file", "acceptance-criteria-file", "instructions-file"); err != nil {
		return err
	}
	body := map[string]interface{}{}
	if flagWasSet(fs, "title") {
		if strings.TrimSpace(*title) == "" {
			return fmt.Errorf("--title cannot be empty")
		}
		body["title"] = *title
	}
	// Whole-field replacement with an explicit way to remove it: null clears, a string replaces,
	// and an absent flag sends nothing so the project keeps what it already states. Free text
	// rather than an id, so `--goal ""` is a caller deliberately recording none rather than a typo.
	goalText, goalSet, err := readCLIText(in, *goal, flagWasSet(fs, "goal"), *goalFile, flagWasSet(fs, "goal-file"), "goal")
	if err != nil {
		return err
	}
	if *clearGoal {
		body["goal"] = nil
	} else if goalSet {
		body["goal"] = goalText
	}
	criteria, criteriaSet, err := readCLIText(in, *acceptanceCriteria, flagWasSet(fs, "acceptance-criteria"), *acceptanceCriteriaFile, flagWasSet(fs, "acceptance-criteria-file"), "acceptance-criteria")
	if err != nil {
		return err
	}
	if *clearAcceptanceCriteria {
		body["acceptanceCriteria"] = nil
	} else if criteriaSet {
		body["acceptanceCriteria"] = criteria
	}
	instructionsText, instructionsSet, err := readCLIText(in, *instructions, flagWasSet(fs, "instructions"), *instructionsFile, flagWasSet(fs, "instructions-file"), "instructions")
	if err != nil {
		return err
	}
	if *clearInstructions {
		body["instructions"] = nil
	} else if instructionsSet {
		body["instructions"] = instructionsText
	}
	if flagWasSet(fs, "status") {
		body["status"] = *status
	}
	// An update naming no field would be a request the server accepts and that changes nothing —
	// which reads to the caller as "the edit went through". Refused here instead, and counted
	// BEFORE the fence goes in: the fence names nothing to write, so an invocation carrying only
	// it is exactly the no-op this refuses.
	if len(body) == 0 {
		return fmt.Errorf("no fields to update")
	}
	if flagWasSet(fs, "expected-config-revision") {
		if !isDecimalRevision(*expectedConfigRevision) {
			return fmt.Errorf("--expected-config-revision must be the decimal configRevision from `orbit project status`")
		}
		body["expectedConfigRevision"] = *expectedConfigRevision
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.updateProject(id, body)
	if err != nil {
		return fmt.Errorf("update project: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func cliProjectDelete(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit project delete")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	if id == "" {
		return fmt.Errorf("project id is required")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.deleteProject(id)
	if err != nil {
		return fmt.Errorf("delete project: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}
