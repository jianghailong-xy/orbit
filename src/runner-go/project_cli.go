package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"unicode/utf8"
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
  orbit project crossings PROJECT_ID [--state STATE] [--json]
  orbit project reopen-impact PROJECT_ID [--json]
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
	"crossings": `orbit project crossings — what has been asked about work crossing this project's line

Usage:
  orbit project crossings PROJECT_ID [--state PENDING|APPROVED|DENIED|APPLIED] [--json]

Every declared cross-project crossing this project is an end of, in BOTH directions: the ones
asking to move work INTO it and the ones asking to move work OUT. Each row names the two ends by
title and by id, what the crossing is about, its state, the crossing key that identifies the move
itself, when it was asked, when it was answered and when the answer expires.

Read only, and there is no command that answers one. The approver of a cross-project crossing is
the USER — the target project's coordinator is not, because an agent signing for another goal is
exactly the failure this whole boundary exists to prevent. What this gives a coordinator is the
ability to SEE that it is waiting on a person, and to say so, which is the difference between a
project that is blocked and one that is silently doing nothing.

A write refused CROSS_PROJECT_APPROVAL_REQUIRED or APPROVAL_PENDING is the write this list is
about. Point the account owner at the project page to answer it.

Options:
  --state STATE            Only crossings in that state
  --json
`,
	"reopen-impact": `orbit project reopen-impact — what reopening this project would cost

Usage:
  orbit project reopen-impact PROJECT_ID [--json]

The acceptance epoch this project is in, the one a reopen would start, how many acceptance
attempts stop being current when it does, whether its DONE rests on the pre-acceptance
compatibility stamp, and the acknowledgement a reopen has to name.

Read this when a write was refused PROJECT_REOPEN_REQUIRED. A reopen is not an undo: it starts a
NEW acceptance epoch, and every PASS the project has stops being current — readable afterwards,
and no longer a claim about the world the project is in. That is what an account owner is being
asked for, so ask for it with the number in your hand.

Read only. Reopening is the account owner's door, through the Orbit web app or the user API; a
coordinator does not reopen a settled project it wants to write into.

Options:
  --json
`,
	"get": `orbit project get — one project's goal, acceptance criteria and instructions

Usage:
  orbit project get PROJECT_ID [--json]

Returns the project a coordinator works from: its title, goal, structured
acceptanceCriteriaItems (stable id, order, assertion text, required verificationMethod,
peer completionCriterion plus its configuration, derived currentStatus and revision), the legacy acceptanceCriteria projection and migration
review state, instructions, project status, coordinator binding, and task distribution
(_count plus tasksByStatus).

Returns the shape of the project, not its tasks — use ` + "`orbit task list`" + ` for those.
PROJECT_ID is the id shown in the web UI URL (e.g. /projects/<id>); a raw UUID works too.
`,
	"acceptance": `orbit project acceptance — the evidence a DONE would be checked against

Usage:
  orbit project acceptance PROJECT_ID [--json]

Read this before you claim a project is finished. "The tests passed" written in a comment
is not evidence the server can check; a run in this record is.

Returns:
  criteria         the current structured checklist; a legacy project is conservatively
                   backfilled one non-blank physical line per item
  acceptanceDigest the identity of the current evidence set: the unordered criterion
                   propositions (order alone is cosmetic) and the newest merge observation
                   per requirement
  runs             every evidence version, with the per-criterion standing derived from
                   append-only conclusion events and whether a later version superseded it
  mergeEvidence    what each target branch was last observed to CONTAIN, and at which
                   refGeneration
  audit            append-only: runs opened and concluded, DONEs bound and refused, and
                   every reopen with the fact that caused it
  doneGate         whether a DONE would be allowed right now and, if not, the code and the
                   sentence the write would be refused with

The two refusals: ACCEPTANCE_MISSING (there is no current evidence version, or one or more current
criteria have no PASS conclusion) and ACCEPTANCE_BLOCKED (an open blocker or an unresolved
verification failure). Evidence changes advance the version and are re-evaluated; they do not
create a stale-attempt refusal.

PROJECT_ID is the id shown in the web UI URL (e.g. /projects/<id>); a raw UUID works too.
`,
	"acceptance-run": `orbit project acceptance-run — evaluate the current evidence version

Usage:
  orbit project acceptance-run PROJECT_ID [--json]

Returns the one immutable version row for the project's current criteria and merge evidence.
The operation is idempotent: two evaluators of the same facts receive the same row. When the
evidence set changes its version advances automatically; prior conclusions remain events and
carry forward until a newer-version conclusion refutes them.

A project that states no acceptance criteria is refused — an acceptance with nothing to
check would pass by having nothing to fail.

PROJECT_ID is the id shown in the web UI URL (e.g. /projects/<id>); a raw UUID works too.
`,
	"acceptance-verdict": `orbit project acceptance-verdict — append criterion conclusion events

Usage:
  orbit project acceptance-verdict PROJECT_ID --run-id ID --criteria JSON [--json]

Options:
  --run-id ID          the evidence version evaluated by 'orbit project acceptance-run'
  --criteria JSON      one object per HUMAN_SIGNOFF criterion (see below)
  --criteria-file -    read the criteria array from stdin
  --json               emit compact JSON

--criteria is a JSON array, one entry per HUMAN_SIGNOFF criterion in the evidence version's
snapshot. EXECUTABLE and VERIFICATION criteria are read-only here and reject a fallback verdict:

  [{"ordinal":1,"verdict":"PASS","summary":"28/28 on a disposable database",
    "evidence":{"command":"bash scripts/project-e2e.sh","exitCode":0,"sha":"54744005"}},
   {"criterionKey":"9f2c…","verdict":"FAIL","summary":"clause 12 unmet"}]

Address each human criterion by ordinal (its position in the snapshot), criterionId, or
criterionKey (legacy content identity). Every HUMAN_SIGNOFF criterion must be answered.

The current verdict is DERIVED and cannot be supplied — all PASS is PASS, any FAIL is FAIL,
anything else is INCONCLUSIVE. Each submitted conclusion is an append-only event recording who,
when and which evidence version it was based on. That is the whole difference between writing
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
changed back" visible to a database that cannot lock a git ref. A different observation also
advances the evidence version automatically and re-evaluates the existing conclusion events;
it does not force anyone to reopen an acceptance attempt.
`,
	"create": `orbit project create — record a new project

Usage:
  orbit project create --title TITLE [options]

Options:
  --title TEXT                     what this body of work is called (required)
  --goal TEXT                      what the project is trying to achieve (max 4,000 characters)
  --goal-file -                    read the goal from stdin
  --acceptance-criteria-items JSON explicit [{"text":"...","verificationMethod":"...","completionCriterion":"..."}]
  --acceptance-criteria-items-file -
                                   read the structured item array from stdin
  --acceptance-criteria TEXT       legacy user-API compatibility input (runner write is refused)
  --acceptance-criteria-file -     same legacy input from stdin (runner write is refused)
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

Use the item form whenever there is an acceptance condition: every item requires the concrete
procedure/evidence plus one explicit peer completionCriterion (EXECUTABLE, VERIFICATION, or
HUMAN_SIGNOFF), and ids are assigned by the server. The legacy flags remain recognized only so
old runner scripts fail with an actionable error instead of silently creating HUMAN_SIGNOFF.
Existing legacy project text remains readable, and old user/JWT API clients retain their
compatibility path; legacy text is not an agent authoring fallback.
`,
	"update": `orbit project update — revise a project's context, or settle where it stands

Usage:
  orbit project update PROJECT_ID [options]

Options:
  --title TEXT                     rename the project
  --goal TEXT                      replace what the project is trying to achieve (max 4,000)
  --goal-file -                    read the replacement goal from stdin
  --clear-goal                     leave the project with no stated goal
  --acceptance-criteria-items JSON propose [{"id":"...","text":"...","verificationMethod":"...","completionCriterion":"..."}]
  --acceptance-criteria-items-file -
                                   read the proposed array from stdin
  --acceptance-criteria TEXT       legacy user-API compatibility input (runner write is refused)
  --acceptance-criteria-file -     same legacy input from stdin (runner write is refused)
  --clear-acceptance-criteria      legacy clear spelling (runner write is refused)
  --instructions TEXT              replace how the work is to be done (max 10,000 characters)
  --instructions-file -            read the replacement instructions from stdin
  --clear-instructions             leave the project with no standing instructions
  --status OPEN|CANCELLED          reopen or abandon the work; DONE is derived
  --expected-config-revision N     only write if the project is still at that configRevision
  --json                           emit compact JSON

Only the flags you pass are sent, so revising the goal never blanks the instructions.
Each prose field is a whole-field replacement: text replaces it, --clear-<field> removes it,
and naming both for one field is refused rather than resolved by a preference order.

Structured acceptance is the one field this command does not write. It is a PROPOSAL: the whole
set you send is recorded as one card for the account owner, the criteria already in force keep
deciding whether this project is done, and nothing changes until the owner approves it. Read
acceptanceCriteriaProposal in the response for the card and the semantic diff it will show them.
Preserve ids returned by project_get when editing or reordering; omit id to add an item; [] is
refused, because a project cannot be measured by nothing. Every item requires
verificationMethod and one peer completionCriterion. EXECUTABLE also requires its command,
expected exit code and source Task; VERIFICATION requires an independent verifier Task.
The legacy flags remain recognized only so old runner scripts fail with an actionable error rather
than silently creating HUMAN_SIGNOFF. Existing legacy text remains readable and writable through
the old user/JWT API compatibility path; it is not an agent authoring fallback.

Direct status DONE is refused for every caller: the server derives it when the exact confirmed
standard set has PASS for every criterion. CANCELLED abandons the work and OPEN reopens it. At
least one flag is required — an update naming no field
is refused here rather than sent as a request that would change nothing, and the fence below
does not count as one: it names nothing to write.

--expected-config-revision is a compare-and-swap. Pass the configRevision you read from
'orbit project get' and the write commits only if the project is still at it; otherwise
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

const runnerLegacyProjectCriteriaError = "legacy acceptanceCriteria is user-API and existing-data compatibility only; runner project writes refuse it because it would implicitly create HUMAN_SIGNOFF criteria; use acceptanceCriteriaItems with an explicit verificationMethod and completionCriterion on every item"

var projectCLICapabilities = []cliCapabilitySpec{
	{Tool: "project_get", Argv: []string{"orbit", "project", "get"}, Usage: "orbit project get PROJECT_ID [--json]", Arguments: []string{"[project-id] (required)", "--json"}},
	{Tool: "project_crossings", Argv: []string{"orbit", "project", "crossings"}, Usage: "orbit project crossings PROJECT_ID [--state STATE] [--json]", Arguments: []string{"[project-id] (required)", "--state <PENDING|APPROVED|DENIED|APPLIED> (only crossings in that state)", "--json"}, Description: "Read every declared cross-project crossing this project is an end of, in BOTH directions — the ones asking to move work INTO it and the ones asking to move work OUT. Each row names the two ends by title and by id, what the crossing is about, its state, the crossing key that identifies the move itself, and when it was asked, answered and expires. Read it when a write was refused CROSS_PROJECT_APPROVAL_REQUIRED or APPROVAL_PENDING: that refusal is about a row in this list, and this is how you learn whether the question has been asked, is still waiting, was refused, or has already been spent. Read only, and deliberately: the approver of a cross-project crossing is the USER, never the target project's coordinator — one agent accepting work on another goal's behalf is the failure the boundary exists to prevent — so point the account owner at the project page to answer it."},
	{Tool: "project_reopen_impact", Argv: []string{"orbit", "project", "reopen-impact"}, Usage: "orbit project reopen-impact PROJECT_ID [--json]", Arguments: []string{"[project-id] (required)", "--json"}, Description: "Read what reopening a settled project would cost: the acceptance epoch it is in, the one a reopen would start, how many acceptance attempts stop being current when it does, whether its DONE rests on the pre-acceptance compatibility stamp, and the acknowledgement a reopen has to name. Read it when a write was refused PROJECT_REOPEN_REQUIRED. A reopen is not an undo — it starts a NEW acceptance epoch and every PASS the project has stops being current, readable afterwards and no longer a claim about the world the project is in — so an account owner asked for one should be asked with those numbers in hand. Read only: reopening is the owner's door, and a coordinator does not reopen a settled project it wants to write into."},
	{Tool: "project_acceptance", Argv: []string{"orbit", "project", "acceptance"}, Usage: "orbit project acceptance PROJECT_ID [--json]", Arguments: []string{"[project-id] (required)", "--json"}, Description: "Read the current acceptance evaluation: peer criteria, the criteria+merge evidence identity, the revision-bearing standard-set digest and its confirmation, immutable evidence versions, append-only conclusion events, merge observations, audit and doneGate. Refusals are ACCEPTANCE_MISSING and ACCEPTANCE_BLOCKED; evidence changes are evaluated instead of becoming stale attempts."},
	{Tool: "project_acceptance_run", Argv: []string{"orbit", "project", "acceptance-run"}, Usage: "orbit project acceptance-run PROJECT_ID [--json]", Arguments: []string{"[project-id] (required)", "--json"}, Description: "Evaluate the current project acceptance evidence version. This is idempotent: concurrent callers observing the same criteria and merge evidence receive the same version. Evidence changes advance it automatically; prior conclusion events carry forward until refuted.", Mutates: true},
	{Tool: "project_acceptance_verdict", Argv: []string{"orbit", "project", "acceptance-verdict"}, Usage: "orbit project acceptance-verdict PROJECT_ID --run-id ID --criteria JSON [--json]", Arguments: []string{"[project-id] (required)", "--run-id <id> (the evidence version to conclude against)", "--criteria <json> | --criteria-file - (one entry per HUMAN_SIGNOFF criterion: {criterionId|ordinal|criterionKey, verdict, summary, evidence, evidenceTaskId, evidenceSessionId})", "--json"}, Description: "Append evidence-backed conclusion events for HUMAN_SIGNOFF criteria. EXECUTABLE and VERIFICATION reject fallback human verdicts and use their declared durable input. Current PASS/FAIL/INCONCLUSIVE is derived from the peer outcomes; every event records who, when and which evidence version. A judgment-session or machine-attributed call may refute; human PASS uses the owner-attributed channel. That is workflow and audit provenance, not proof of human presence.", Mutates: true},
	{Tool: "project_merge_evidence", Argv: []string{"orbit", "project", "merge-evidence"}, Usage: "orbit project merge-evidence PROJECT_ID --requirement-id ID --target-branch REF --content-hash SHA256 [options]", Arguments: []string{"[project-id] (required)", "--requirement-id <text> (required)", "--target-branch <ref> (required)", "--content-hash <sha256> (required, 64 hex characters)", "--source <text>", "--detail <json>", "--json"}, Description: "Record what a target branch was observed to CONTAIN — the merge half of a project's acceptance evidence. Hash the content you actually read (a normalized `git grep` result, a blob or tree digest, a rendered diff), never `git branch --contains`: after a squash merge that answer is a guaranteed false negative while the content is plainly there. Same content as the last observation and only the observation time moves; different content writes a new row one refGeneration up, advances the evidence version automatically, and re-evaluates the current acceptance standing without a manual reopen.", Mutates: true},
	{Tool: "project_create", Argv: []string{"orbit", "project", "create"}, Usage: "orbit project create --title TITLE [options]", Arguments: []string{"--title <text> (required)", "--goal <text> | --goal-file - (what the work is trying to achieve; max 4,000 characters)", "--acceptance-criteria-items <json array> | --acceptance-criteria-items-file - (every item requires text + verificationMethod + explicit completionCriterion)", "--instructions <text> | --instructions-file - (how the work is to be done; max 10,000 characters)", "--json"}, Description: "Create a project under this runner's owner — the durable context a body of work is carried out from, as opposed to a task, which is one piece of that work. Use --acceptance-criteria-items for project outcomes; each item requires assertion text, reader-facing verificationMethod, and one explicit peer completionCriterion. Legacy acceptanceCriteria remains readable for existing projects and writable through the old user/JWT API compatibility path, but runner writes refuse it because it would silently declare HUMAN_SIGNOFF; it is not an agent fallback. The project starts OPEN and holds no tasks; file them with `orbit task create --project-id <id>` afterwards. Inside a session the project is also bound to that session as its coordinator, and to the workspace it runs in, in the same write that creates it — so opening the coordinator later returns to this conversation rather than starting another; one session coordinates at most one project, and headless there is no session and so no such binding.", Mutates: true},
	{Tool: "project_update", Argv: []string{"orbit", "project", "update"}, Usage: "orbit project update PROJECT_ID [options]", Arguments: []string{"[project-id] (required)", "--title <text>", "--goal <text> | --goal-file - | --clear-goal", "--acceptance-criteria-items <json array> | --acceptance-criteria-items-file - (the whole set you are PROPOSING; text + verificationMethod + explicit completionCriterion required; [] is refused)", "--instructions <text> | --instructions-file - | --clear-instructions", "--status <OPEN|CANCELLED> (DONE is derived)", "--expected-config-revision <n>", "--json"}, Description: "Update a project you own. Structured acceptance items are a PROPOSAL rather than a write: sending them records one card for the account owner and leaves the criteria in force deciding this project until the owner approves it, so read acceptanceCriteriaProposal in the response and keep working to what is still in force. Every item requires text, verificationMethod and one explicit peer completionCriterion; preserve ids from project_get to retain identity, omit id to add. [] is refused, because a project cannot be measured by nothing. currentStatus and project DONE are derived and cannot be supplied. Legacy acceptanceCriteria remains readable for existing projects and writable through the old user/JWT API compatibility path, but runner writes refuse it because it would silently declare HUMAN_SIGNOFF; it is not an agent fallback. At least one flag is required, and --expected-config-revision does not count as one. Only one --*-file flag per invocation, since they all read the same stdin.", Mutates: true},
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
	case "get":
		return cliProjectGet(args[1:], out)
	case "create":
		return cliProjectCreate(args[1:], in, out)
	case "update":
		return cliProjectUpdate(args[1:], in, out)
	case "delete":
		return cliProjectDelete(args[1:], out)
	case "crossings":
		return cliProjectCrossings(args[1:], out)
	case "reopen-impact":
		return cliProjectReopenImpact(args[1:], out)
	case "acceptance":
		return cliProjectAcceptance(args[1:], out)
	case "acceptance-run":
		return cliProjectAcceptanceRun(args[1:], out)
	case "acceptance-verdict":
		return cliProjectAcceptanceVerdict(args[1:], in, out)
	case "merge-evidence":
		return cliProjectMergeEvidence(args[1:], in, out)
	default:
		return fmt.Errorf("project command %q has help but no dispatcher", action)
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

// cliProjectAcceptance is the read a coordinator makes before it claims a project is finished:
// what the criteria are, what has been checked, and whether a DONE would be allowed right now.
// One GET, one raw body through, exactly like the two reads either side of it.
// cliProjectCrossings lists the declared crossings this project is an end of. One GET, one raw body
// through — the server decides what a crossing row says, and a second opinion formatted here would
// be one that drifts from the API and the web UI.
func cliProjectCrossings(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit project crossings")
	state := fs.String("state", "", "only crossings in that state")
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
	if *state != "" && !isHandoffState(*state) {
		return fmt.Errorf("--state must be one of PENDING, APPROVED, DENIED, APPLIED")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.getProjectHandoffs(id, *state)
	if err != nil {
		return fmt.Errorf("get project crossings: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

// The four states a declared crossing can be stored in. Checked here so a typo is a sentence at the
// terminal rather than a 400 from a round trip — the same reason every other enum flag is.
func isHandoffState(state string) bool {
	switch state {
	case "PENDING", "APPROVED", "DENIED", "APPLIED":
		return true
	}
	return false
}

// cliProjectReopenImpact reads what a reopen would cost. Read only: the reopen itself is the
// account owner's door, and this exists so the ask can carry the numbers.
func cliProjectReopenImpact(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit project reopen-impact")
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
	raw, err := t.getProjectReopenImpact(id)
	if err != nil {
		return fmt.Errorf("get project reopen impact: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

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
		return fmt.Errorf("evaluate project acceptance evidence version: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

// cliProjectAcceptanceVerdict appends one conclusion event per stated criterion.
//
// The array is parsed here only far enough to prove it IS an array of objects — the server decides
// what a valid entry is, and a second opinion held at the terminal would be one that drifts from
// it. What is worth catching locally is the shape mistake that would otherwise arrive as a 400 the
// caller has to decode: a bare object, a string, an empty list.
func cliProjectAcceptanceVerdict(args []string, in io.Reader, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit project acceptance-verdict")
	runID := fs.String("run-id", "", "the acceptance evidence version to conclude against")
	criteria := fs.String("criteria", "", "JSON array, one entry per HUMAN_SIGNOFF criterion")
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
		return fmt.Errorf("--run-id is required; evaluate the current version with 'orbit project acceptance-run'")
	}
	text, set, err := readCLIText(in, *criteria, flagWasSet(fs, "criteria"), *criteriaFile, flagWasSet(fs, "criteria-file"), "criteria")
	if err != nil {
		return err
	}
	if !set || strings.TrimSpace(text) == "" {
		return fmt.Errorf("--criteria is required: one entry per HUMAN_SIGNOFF criterion, addressed by criterionId, ordinal or criterionKey")
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
		return fmt.Errorf("append project acceptance conclusions: %w", err)
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
// `orbit project get` printed.
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
var projectStatuses = []string{"OPEN", "CANCELLED"}

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

// parseProjectAcceptanceItems validates the structural CLI form before it reaches the server.
// Create assigns every id server-side; update may echo ids returned by project_get to retain
// identity. Unknown fields are refused so a misspelling cannot look like a successful metadata
// write that the DTO discarded.
func parseProjectAcceptanceItems(text string, allowIDs bool) ([]map[string]interface{}, error) {
	if strings.TrimSpace(text) == "null" {
		return nil, fmt.Errorf("acceptance criteria items must be a JSON array; use [] to clear them")
	}
	var raw []map[string]interface{}
	if err := json.Unmarshal([]byte(text), &raw); err != nil {
		return nil, fmt.Errorf("acceptance criteria items must be a JSON array of objects: %w", err)
	}
	return normalizeProjectAcceptanceItems(raw, allowIDs)
}

// normalizeProjectAcceptanceItems is shared by CLI JSON and MCP arguments. JSON Schema is useful
// guidance to a model but the MCP transport does not enforce it, so required methods are checked
// here as well as by the server DTO and database constraint.
func normalizeProjectAcceptanceItems(raw []map[string]interface{}, allowIDs bool) ([]map[string]interface{}, error) {
	if len(raw) > 100 {
		return nil, fmt.Errorf("acceptance criteria items may contain at most 100 entries")
	}
	items := make([]map[string]interface{}, 0, len(raw))
	projection := make([]string, 0, len(raw))
	seenIDs := map[string]struct{}{}
	for index, item := range raw {
		for key := range item {
			allowed := key == "text" || key == "verificationMethod" ||
				key == "completionCriterion" || key == "acceptanceCommand" ||
				key == "acceptanceExpectedExitCode" || key == "evidenceTaskId" ||
				key == "completionCriterionOverrideReason" || (key == "id" && allowIDs)
			if !allowed {
				return nil, fmt.Errorf("acceptance criterion %d has unknown field %q", index+1, key)
			}
		}
		value, ok := item["text"].(string)
		value = strings.TrimSpace(value)
		if !ok || value == "" {
			return nil, fmt.Errorf("acceptance criterion %d needs non-blank text", index+1)
		}
		if strings.ContainsAny(value, "\r\n") {
			return nil, fmt.Errorf("acceptance criterion %d text must be one line", index+1)
		}
		method, methodOK := item["verificationMethod"].(string)
		method = strings.TrimSpace(method)
		if !methodOK || method == "" {
			return nil, fmt.Errorf("acceptance criterion %d needs non-blank verificationMethod", index+1)
		}
		if utf8.RuneCountInString(method) > maxProjectAcceptanceVerificationMethodChars {
			return nil, fmt.Errorf("acceptance criterion %d verificationMethod may contain at most %d characters", index+1, maxProjectAcceptanceVerificationMethodChars)
		}
		criterion, criterionOK := item["completionCriterion"].(string)
		criterion = strings.TrimSpace(criterion)
		if !criterionOK || (criterion != "EXECUTABLE" && criterion != "VERIFICATION" && criterion != "HUMAN_SIGNOFF") {
			return nil, fmt.Errorf("acceptance criterion %d requires completionCriterion EXECUTABLE, VERIFICATION, or HUMAN_SIGNOFF", index+1)
		}
		command, commandPresent := item["acceptanceCommand"]
		commandText, commandOK := command.(string)
		commandText = strings.TrimSpace(commandText)
		if commandPresent && (!commandOK || commandText == "") {
			return nil, fmt.Errorf("acceptance criterion %d acceptanceCommand must be a non-blank string", index+1)
		}
		expected, expectedPresent := item["acceptanceExpectedExitCode"]
		expectedNumber, expectedOK := expected.(float64)
		if expectedPresent && (!expectedOK || expectedNumber != float64(int(expectedNumber))) {
			return nil, fmt.Errorf("acceptance criterion %d acceptanceExpectedExitCode must be an integer", index+1)
		}
		evidenceTask, evidencePresent := item["evidenceTaskId"]
		evidenceTaskID, evidenceOK := evidenceTask.(string)
		evidenceTaskID = strings.TrimSpace(evidenceTaskID)
		if evidencePresent && (!evidenceOK || evidenceTaskID == "") {
			return nil, fmt.Errorf("acceptance criterion %d evidenceTaskId must be a non-blank string", index+1)
		}
		switch criterion {
		case "EXECUTABLE":
			if !commandPresent || !expectedPresent || !evidencePresent {
				return nil, fmt.Errorf("acceptance criterion %d EXECUTABLE requires acceptanceCommand, acceptanceExpectedExitCode, and evidenceTaskId", index+1)
			}
		case "VERIFICATION":
			if commandPresent || expectedPresent || !evidencePresent {
				return nil, fmt.Errorf("acceptance criterion %d VERIFICATION requires evidenceTaskId and no executable pair", index+1)
			}
		case "HUMAN_SIGNOFF":
			if commandPresent || expectedPresent || evidencePresent {
				return nil, fmt.Errorf("acceptance criterion %d HUMAN_SIGNOFF cannot declare a command or evidenceTaskId", index+1)
			}
		}
		normalized := map[string]interface{}{
			"text": value, "verificationMethod": method, "completionCriterion": criterion,
		}
		if commandPresent {
			normalized["acceptanceCommand"] = commandText
			normalized["acceptanceExpectedExitCode"] = int(expectedNumber)
		}
		if evidencePresent {
			normalized["evidenceTaskId"] = evidenceTaskID
		}
		if reason, present := item["completionCriterionOverrideReason"]; present {
			reasonText, valid := reason.(string)
			reasonText = strings.TrimSpace(reasonText)
			if !valid || reasonText == "" {
				return nil, fmt.Errorf("acceptance criterion %d completionCriterionOverrideReason must be a non-blank string", index+1)
			}
			if utf8.RuneCountInString(reasonText) > 2000 {
				return nil, fmt.Errorf("acceptance criterion %d completionCriterionOverrideReason may contain at most 2000 characters", index+1)
			}
			normalized["completionCriterionOverrideReason"] = reasonText
		}
		projection = append(projection, fmt.Sprintf("%d. %s", index+1, value))
		if id, present := item["id"]; present {
			idText, valid := id.(string)
			idText = strings.TrimSpace(idText)
			if !valid || idText == "" {
				return nil, fmt.Errorf("acceptance criterion %d id must be a string", index+1)
			}
			if _, repeated := seenIDs[idText]; repeated {
				return nil, fmt.Errorf("acceptance criterion %d repeats id %q", index+1, idText)
			}
			seenIDs[idText] = struct{}{}
			normalized["id"] = idText
		}
		items = append(items, normalized)
	}
	if utf8.RuneCountInString(strings.Join(projection, "\n")) > maxProjectAcceptanceCriteriaChars {
		return nil, fmt.Errorf("structured acceptance criteria must fit the %d-character compatibility projection", maxProjectAcceptanceCriteriaChars)
	}
	return items, nil
}

func normalizeMCPProjectAcceptanceItems(value interface{}, allowIDs bool) ([]map[string]interface{}, error) {
	entries, ok := value.([]interface{})
	if !ok {
		return nil, fmt.Errorf("acceptance criteria items must be an array of objects")
	}
	raw := make([]map[string]interface{}, 0, len(entries))
	for index, entry := range entries {
		item, ok := entry.(map[string]interface{})
		if !ok {
			return nil, fmt.Errorf("acceptance criterion %d must be an object", index+1)
		}
		raw = append(raw, item)
	}
	return normalizeProjectAcceptanceItems(raw, allowIDs)
}

func cliProjectCreate(args []string, in io.Reader, out io.Writer) error {
	fs := newCLIFlagSet("orbit project create")
	title := fs.String("title", "", "what this body of work is called")
	goal := fs.String("goal", "", "what the project is trying to achieve")
	goalFile := fs.String("goal-file", "", "read the goal from stdin (-)")
	acceptanceCriteria := fs.String("acceptance-criteria", "", "what would settle that the goal was reached")
	acceptanceCriteriaFile := fs.String("acceptance-criteria-file", "", "read the acceptance criteria from stdin (-)")
	acceptanceCriteriaItems := fs.String("acceptance-criteria-items", "", "JSON array of structured acceptance criterion objects")
	acceptanceCriteriaItemsFile := fs.String("acceptance-criteria-items-file", "", "read structured acceptance criteria JSON from stdin (-)")
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
	if flagWasSet(fs, "acceptance-criteria") || flagWasSet(fs, "acceptance-criteria-file") {
		return fmt.Errorf("%s", runnerLegacyProjectCriteriaError)
	}
	if err := projectStdinFlags(fs, "goal-file", "acceptance-criteria-file", "acceptance-criteria-items-file", "instructions-file"); err != nil {
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
	criteriaItemsText, criteriaItemsSet, err := readCLIText(in, *acceptanceCriteriaItems, flagWasSet(fs, "acceptance-criteria-items"), *acceptanceCriteriaItemsFile, flagWasSet(fs, "acceptance-criteria-items-file"), "acceptance-criteria-items")
	if err != nil {
		return err
	}
	if criteriaItemsSet {
		items, err := parseProjectAcceptanceItems(criteriaItemsText, false)
		if err != nil {
			return err
		}
		body["acceptanceCriteriaItems"] = items
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
	acceptanceCriteriaItems := fs.String("acceptance-criteria-items", "", "JSON array proposing a new structured acceptance criteria set")
	acceptanceCriteriaItemsFile := fs.String("acceptance-criteria-items-file", "", "read structured acceptance criteria JSON from stdin (-)")
	clearAcceptanceCriteria := fs.Bool("clear-acceptance-criteria", false, "leave the project with no stated acceptance criteria")
	instructions := fs.String("instructions", "", "replace how this project's work is to be done")
	instructionsFile := fs.String("instructions-file", "", "read the replacement instructions from stdin (-)")
	clearInstructions := fs.Bool("clear-instructions", false, "leave the project with no standing instructions")
	status := fs.String("status", "", "where the work stands: OPEN or CANCELLED; DONE is derived")
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
	legacySet := flagWasSet(fs, "acceptance-criteria") || flagWasSet(fs, "acceptance-criteria-file")
	if legacySet || *clearAcceptanceCriteria {
		return fmt.Errorf("%s", runnerLegacyProjectCriteriaError)
	}
	if err := projectStdinFlags(fs, "goal-file", "acceptance-criteria-file", "acceptance-criteria-items-file", "instructions-file"); err != nil {
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
	criteriaItemsText, criteriaItemsSet, err := readCLIText(in, *acceptanceCriteriaItems, flagWasSet(fs, "acceptance-criteria-items"), *acceptanceCriteriaItemsFile, flagWasSet(fs, "acceptance-criteria-items-file"), "acceptance-criteria-items")
	if err != nil {
		return err
	}
	if criteriaItemsSet {
		items, err := parseProjectAcceptanceItems(criteriaItemsText, true)
		if err != nil {
			return err
		}
		body["acceptanceCriteriaItems"] = items
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
			return fmt.Errorf("--expected-config-revision must be the decimal configRevision from `orbit project get`")
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
