package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"unicode/utf8"
)

// `orbit project` — the CLI half of the project_* MCP tools. A project is the durable context a
// coordinator works from: what the work is for (goal), what would settle that it is finished
// (acceptanceCriteriaItems), and how it is to be done (instructions). None of that is in a task's
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
  orbit project ensure-coordinator PROJECT_ID [--json]
  orbit project send PROJECT_ID (--message TEXT | --message-file -) [--client-turn-id ID] [--expect-reply [--reply-options JSON] [--reply-within-seconds N]] [--json]
  orbit project resolve-blocker PROJECT_ID --blocker-id ID --reason TEXT [--json]
  orbit project request-start PROJECT_ID --line LINE --automatic[=BOOL] --max-concurrent-tasks N --why TEXT [options]
  orbit project request-done PROJECT_ID --judgment TEXT (--gaps JSON | --gaps-file -) [--json]
  orbit project merge-evidence PROJECT_ID --requirement-id ID --target-branch REF --content-hash SHA256 [options]
  orbit project skip-merge-check PROJECT_ID TASK_ID --reason TEXT [--json]
  orbit project create --title TITLE [options]
  orbit project update PROJECT_ID [options]
  orbit project delete PROJECT_ID [--json]

Run 'orbit project <command> --help' for options.

Logged in as yourself ('orbit login', or ORBIT_USER_TOKEN), these commands call the
REST API with your personal access token and print what they print as the runner.
The ones that act for an Orbit session are refused rather than sent with the runner's
credential: 'orbit api' calls any user route, and 'orbit capabilities --json' marks
which commands run as you.
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
	"get": `orbit project get — one project's goal, acceptance criteria and instructions

Usage:
  orbit project get PROJECT_ID [--json]

Returns the project a coordinator works from: its title, goal, structured
acceptanceCriteriaItems (stable id, order, assertion text, required verificationMethod, and
revision), instructions, project status, coordinator binding, and task distribution
(_count plus tasksByStatus).

Returns the shape of the project, not its tasks — use ` + "`orbit task list`" + ` for those.
PROJECT_ID is the id shown in the web UI URL (e.g. /projects/<id>); a raw UUID works too.
`,
	"ensure-coordinator": `orbit project ensure-coordinator — take the conversation that coordinates this project, opening the next one only when the standing one cannot take a message

Usage:
  orbit project ensure-coordinator PROJECT_ID [--json]

Returns this project's coordinator session. A replacement is opened ONLY when the conversation the
project points at can no longer be handed a message — no runner, a runner that is offline, a run
that never started, a row in Trash, a run that was replaced — and a conversation that CAN still
receive is handed straight back. So a conversation somebody is still in is never displaced, and
this is not a way to end one: that press stays with the account owner.

  created: false   the sessionId returned is the one to send to — ` + "`orbit session send --resume-if-ended`" + `
  created: true    replacedSessionId and replaceReason say what the replacement left behind

The refusal that stays is COORDINATOR_UNAVAILABLE (owner: USER): the project's coordination
workspace is disabled, trashed or no longer recorded, and where a project's coordination lives is
the account owner's decision. It is left exactly as the server raised it, requiredAction included,
because that action names a person — a retry answers the same thing.

This command acts for the session it runs in: the replacement is opened for the conversation that
asks, and a terminal outside one has no such conversation (a person moves a coordinator from the
project page in the Orbit app).

Options:
  --json            emit compact JSON
`,
	"send": `orbit project send — hand one message to this project's coordinator, resolved at delivery

Usage:
  orbit project send PROJECT_ID (--message TEXT | --message-file -) [--client-turn-id ID] [--expect-reply [--reply-options JSON] [--reply-within-seconds N]] [--json]

The project is the ADDRESS. The coordinator is resolved at the moment the message is delivered, so
nothing this call reads can go stale: the id ` + "`orbit project ensure-coordinator`" + ` answers with is a
session that a rotation invalidates, and a message sent to it after one lands on a reader instead
of the project.

  it can take the message        the message is delivered to it, and nothing about the
                                 coordination changes (created: false)
  it has ended, but revivable    the message REVIVES it rather than replacing it, which is what
                                 ` + "`orbit session send --resume-if-ended`" + ` does
  it cannot take a message       the next conversation is opened by the same rotation
                                 ` + "`ensure-coordinator`" + ` performs, and the message goes to it
                                 (created: true, with replacedSessionId and replaceReason)

The response says what actually happened rather than what was asked for, and is passed through
unread. The refusal that stays is COORDINATOR_UNAVAILABLE (owner: USER): the project's coordination
workspace is disabled, trashed or no longer recorded, and where a project's coordination lives is
the account owner's decision — so its requiredAction (rebind) names a person, and a retry answers
the same thing. A message that could not be written onto a coordinator which WAS found comes back
as COORDINATOR_MESSAGE_UNDELIVERED instead, carrying the sentence that refused the write.

--client-turn-id is the key the message is written under, and what makes a retry safe: repeat a
call whose answer you never saw — a dropped connection, a timeout — with the same key and the same
message, and you get that same turn back instead of a second copy of the message. Omitted, the
server mints a key of its own and every call is a new message.

--expect-reply makes the message a request to the coordinator it is DELIVERED to: the call still
returns at once, with "requestId" and "replyBy", and the outcome comes back to this session as a
turn — the answer, or why there is none (NO_REPLY, RECIPIENT_ENDED, EXPIRED, UNDELIVERED). The
request stays with that conversation: if the project rotates to another before it answers, the
outcome is RECIPIENT_ENDED, and asking again reaches the new one.

This command acts for the session it runs in, and it is advertised only where the orchestration
grant it spends exists; a terminal outside a session has no coordinator conversation to reach.

Options:
  --message TEXT              the message to deliver
  --message-file -            read the message from stdin
  --client-turn-id ID         idempotency key: a retry with the same key gets the same turn back
  --expect-reply              ask the coordinator for a reply
  --reply-options JSON        with --expect-reply: 2-4 answers to choose from, a JSON array of
                              {label, description} objects
  --reply-within-seconds N    with --expect-reply: seconds until the request expires (60-2592000,
                              default 86400)
  --json                      emit compact JSON
`,
	"request-start": `orbit project request-start — ask the account owner to start the project this session coordinates

Usage:
  orbit project request-start PROJECT_ID --line PROJECT_BRANCH|MAIN --automatic[=BOOL]
      --max-concurrent-tasks N --why TEXT [--project-branch-name REF] [--merge-check-command CMD] [--json]

Until the owner starts the project, task_start is refused for its tasks; this puts the start in front
of them. Run it once the plan is written: the criteria stated, the work filed as tasks under the
project, and every acceptance criterion served by at least one task (criterionKey on task create).

Orbit checks the plan first. A plan that is not ready is refused (START_REQUEST_NOT_READY) and nothing
is filed, with every reason listed at once and what to do about each: no criteria or no tasks, a
criterion no task serves, a task whose assignee is not on a runner, a project branch asked for with
no repository to hold it. A plan that is ready is filed and the command returns at once with the
request's itemId and any warnings — tasks set to start by hand, Automatic on a project branch with no
merge check. The owner sees a "Start this project?" card with these settings as suggestions and
presses Start; the coordinator is told when the project starts.

Asking again replaces the open request, and changing the plan before the start — tasks, dependencies
or criteria — voids it. Only the conversation the project is coordinated from may ask
(ORBIT_SESSION_ID), and only before the project has started.

Options:
  --line PROJECT_BRANCH|MAIN     where finished tasks land (required)
  --project-branch-name REF      with PROJECT_BRANCH: the branch as a full ref (refs/heads/...)
  --automatic[=BOOL]             whether the coordinator runs the project for the owner (required;
                                 --automatic=false to suggest it off)
  --max-concurrent-tasks N       how many of its tasks may run at once, 1-100 (required)
  --merge-check-command CMD      the check run on the combined tree before anything lands
  --why TEXT                     one sentence, shown to the owner on the card (required)
  --json                         emit compact JSON
`,
	"request-done": `orbit project request-done — ask the account owner to record the project this session coordinates done

Usage:
  orbit project request-done PROJECT_ID --judgment TEXT (--gaps JSON | --gaps-file -) [--json]

Orbit records a project done by itself when it can prove every criterion: met by its work, and that
work on main. Run this when it cannot, and you have checked the project is done anyway — your call in a
sentence or two, and one gap for each thing Orbit cannot prove: the criterion's key, why Orbit cannot
prove it, what you checked instead, and where that evidence is.

Orbit checks the project first. A project that is not ready is refused (DONE_REQUEST_NOT_READY) and
nothing is filed, with every reason listed at once and what to do about each: a criterion its work has
not met, a task running, queued or IN_PROGRESS, an item waiting on the owner, a landing or a merge into
main queued or running. A project that is ready is filed and the command returns at once with the
request's itemId and a warning for every criterion not landed on main, with why. The owner sees an "Is
this project done?" card with your call and gaps, and records the project done on it.

Asking again replaces the open request, and the project moving before the owner answers — its
criteria, a task, a run or a landing — voids it. Only the conversation the project is coordinated from
may ask (ORBIT_SESSION_ID).

Options:
  --judgment TEXT     your call, in a sentence or two — shown first on the card (required)
  --gaps JSON         the gaps, [] for none (required, or --gaps-file):
                      [{"criterionKey":"...","title":"...","whyNotProven":"...",
                        "coordinatorChecked":"...","evidenceRefs":["..."]}]
  --gaps-file -       read the gaps array from stdin
  --json              emit compact JSON
`,
	"resolve-blocker": `orbit project resolve-blocker — end one open blocker, saying why it no longer blocks

Usage:
  orbit project resolve-blocker PROJECT_ID --blocker-id ID --reason TEXT [--json]

Options:
  --blocker-id ID   the blocker to end, as 'orbit project get' spells it in blockers.open[].id
  --reason TEXT     why this no longer blocks — what changed (required)
  --json            emit compact JSON

The write half of what ` + "`orbit project get`" + ` shows. Read it first: blockers.open carries each
blocker's id, its kind, and the one sentence it is asking for (requiredAction).

Run from inside a session, this first puts the blocker and your reason on a confirmation card and
waits for the account owner's answer; nothing is written if they decline. Typed at a terminal
outside one there is no session and nobody to ask, and the resolution is written straight away —
that caller is the owner.

The reason stays on the row as its resolution note, and a resolution is final: an already-resolved
blocker is refused rather than resolved twice. A condition that comes back raises a new episode
rather than reopening this one.
`,
	"skip-merge-check": `orbit project skip-merge-check — queue one landing with the merge check NOT run

Usage:
  orbit project skip-merge-check PROJECT_ID TASK_ID --reason TEXT [--json]

For the red that is about the CHECK rather than the delivery: a merge check command that cannot pass
where the runner runs it — a shell without GNU timeout or bash 4, a tool the machine does not have.
The check does not run on the one landing this queues, and nothing anywhere records it as having
passed.

This is the account owner's decision, and it is taken once:

  * inside a session (ORBIT_SESSION_ID), the confirmation card comes first and the call is the
    coordinating conversation's: nothing is queued unless the owner answers yes, and a decline is
    an answer — the landing stands as it failed;
  * at a terminal as yourself (` + "`orbit login`" + `), there is no card because you are the person it would
    ask, and the row records you as the one who approved it.

Options:
  --reason TEXT   why this check should not hold up this landing (required)

Only a landing that stopped on a check qualifies (CHECK_FAILED). A conflict is the branch's and an
integration error is the machinery's — run those again with integration_retry. Nothing about the
project's own merge check command changes: the next landing and every merge into main are checked
exactly as before, and the generation this queues carries the skipped check, your reason and who
approved it.
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
  --acceptance-criteria-items JSON explicit [{"text":"...","verificationMethod":"..."}]
  --acceptance-criteria-items-file -
                                   read the structured item array from stdin
  --instructions TEXT              how this project's work is to be done (max 10,000 characters)
  --instructions-file -            read the instructions from stdin
  --workspace-id ID                open the coordinator in this workspace instead of here
  --integration-line LINE          where finished tasks land: MAIN or PROJECT_BRANCH
  --project-branch REF             the project branch, as a full refs/heads/... ref
  --upstream-ref REF               what main is for this project, as a full ref
  --merge-check-command TEXT       what runs on the combined tree before anything lands
  --merge-check-timeout-seconds N  that check's budget
  --escalate-after-seconds N       how long an exception waits on the coordinator (300–604800)
  --json                           emit compact JSON

The whole integration object is the account owner's at creation — the line AND the merge check —
accepted at a terminal and refused from inside an agent session, which is refused here before
anyone is asked. A card for a merge check names the project it changes and that project does not
exist yet; and the line is decided at the first integration anyway (code tasks that depend on one
another go through a project branch) and locked from then on, so choosing it HERE is the one cheap
moment — which is why it is the owner's to take. A session that wants either sets it afterwards:
the line from the owner's own doors, the merge check with ` + "`orbit project update --merge-check-command`" + `,
which puts it on the owner's confirmation card.

The project is created under this runner's owner and starts OPEN. It holds no tasks yet —
file them with ` + "`orbit task create --project-id <id>`" + ` once it exists.

Run inside a session, the project is bound to THAT session as its coordinator — and to the
workspace it runs in — in the same write that creates the project, so opening the coordinator
later comes back to this conversation instead of starting a new one. A session coordinates at
most one project: record a second from the same session and it gets a coordinator conversation
of its own, in this same workspace, and the answer says so.
Run headless there is no session to bind and no such binding: the coordinator is opened wherever
the project's work turns out to run, or wherever you say.

--workspace-id says the coordinator belongs somewhere other than here, and naming a workspace
OPENS it there — a project that names a coordination workspace has a coordinator, and recording
the workspace alone would make the project read back as a conversation that went to Trash. It
needs orchestration enabled for this session, because it names a workspace rather than
inheriting one, and headless it is refused for want of anything to check it against.

Only one --*-file flag per invocation: they all read the same stdin, and the second read
would silently come back empty.

Use the item form whenever there is an acceptance condition: every item requires the assertion
text and the concrete procedure/evidence a reader follows to decide it, and ids are assigned by
the server. Migration 0229 removed the legacy prose input and the parser that split it, so this is
the only authoring shape there is — and nothing in Orbit evaluates what it states.
`,
	"update": `orbit project update — revise a project's context, or settle where it stands

Usage:
  orbit project update PROJECT_ID [options]

Options:
  --title TEXT                     rename the project
  --goal TEXT                      replace what the project is trying to achieve (max 4,000)
  --goal-file -                    read the replacement goal from stdin
  --clear-goal                     leave the project with no stated goal
  --acceptance-criteria-items JSON replace with [{"id":"...","text":"...","verificationMethod":"..."}]
  --acceptance-criteria-items-file -
                                   read the structured replacement array from stdin
  --instructions TEXT              replace how the work is to be done (max 10,000 characters)
  --instructions-file -            read the replacement instructions from stdin
  --clear-instructions             leave the project with no standing instructions
  --status OPEN|DONE|CANCELLED     where the work stands
  --integration-line MAIN|PROJECT_BRANCH
                                   where this project's finished tasks land
  --project-branch REF             the project branch's full ref (refs/heads/project/next)
  --upstream-ref REF               what main is for this project, as a full ref
  --merge-check-command CMD        run on the combined tree before a landing (empty removes it)
  --merge-check-timeout-seconds N  that check's budget in seconds
  --expected-config-revision N     only write if the project is still at that configRevision
  --json                           emit compact JSON

Only the flags you pass are sent, so revising the goal never blanks the instructions.
Each prose field is a whole-field replacement: text replaces it, --clear-<field> removes it,
and naming both for one field is refused rather than resolved by a preference order.

Structured acceptance is a whole-collection replacement too. Only a tightening edit lands immediately:
adding an item, reordering, or stepping an item's verificationMethod up the
HUMAN → VERIFICATION → EXECUTABLE ladder. Any other edit — dropping an item, rewriting an item's
text, or rewording verificationMethod any other way — is NOT applied: it is held as a proposal for
the account owner to decide, and the response says so in acceptanceCriteriaHold, beside the
criteria that are still the ones in force. So [] drops every criterion rather than clearing the
collection, and is held whenever there is one to drop. When an edit does land, the set you send
becomes the standard this project states. Preserve ids returned by project_get when editing or
reordering; omit id to add an item. Every
item requires text and verificationMethod, and nothing else: migration 0233 removed the criterion's
completionCriterion, acceptanceCommand, acceptanceExpectedExitCode and evidenceTaskId, so a
criterion no longer names the work that serves it — the work names the criterion. Nothing
evaluates the set either: migration 0229 removed the project acceptance judgment, so what you send
here is a stated condition and no more.

Status is an ordinary field for all three values. The database gate and the API refusal that used
to make DONE automatic-only were removed with the judgment they served, so DONE settles the project
and nothing checks anything first. CANCELLED abandons the work and OPEN reopens it. At
least one flag is required — an update naming no field
is refused here rather than sent as a request that would change nothing, and the fence below
does not count as one: it names nothing to write.

The integration line says where this project's finished tasks land: MAIN puts them straight on the
upstream, PROJECT_BRANCH puts them on the project's own branch, which reaches main later. Choosing
it is the account owner's, so it is accepted here — typed at a terminal there is no session — and
refused for any agent session. A project nobody chose for is decided at its first integration: code
tasks that depend on one another go through a project branch, anything else straight to main. After
that the line is locked and a request to move it is refused; the merge check stays changeable.

The merge check — --merge-check-command, --merge-check-timeout-seconds — is the other half, and it
is answered differently. It is the check run on the combined tree before a landing, and the session
holding a failing one is often the one that knows what the command should be. So inside a session
the change is a PROPOSAL: this command first puts the project, the check as it stands and the check
you are asking for on a confirmation card and waits for the account owner, and the change takes
effect only once they approve it. Nothing is written if they decline, and a second change is a
second question — an approval covers the exact command and timeout it named, so an old card cannot
carry a later edit. Typed at a terminal there is nobody to ask and the write goes straight through.
Passing --merge-check-command with an empty value removes the check, and that too is a change the
owner is asked about.

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

var projectCLICapabilities = []cliCapabilitySpec{
	{Tool: "project_get", Argv: []string{"orbit", "project", "get"}, Usage: "orbit project get PROJECT_ID [--json]", Arguments: []string{"[project-id] (required)", "--json"}},
	{Tool: "project_crossings", Argv: []string{"orbit", "project", "crossings"}, Usage: "orbit project crossings PROJECT_ID [--state STATE] [--json]", Arguments: []string{"[project-id] (required)", "--state <PENDING|APPROVED|DENIED|APPLIED> (only crossings in that state)", "--json"}, Description: "Read every declared cross-project crossing this project is an end of, in BOTH directions — the ones asking to move work INTO it and the ones asking to move work OUT. Each row names the two ends by title and by id, what the crossing is about, its state, the crossing key that identifies the move itself, and when it was asked, answered and expires. Read it when a write was refused CROSS_PROJECT_APPROVAL_REQUIRED or APPROVAL_PENDING: that refusal is about a row in this list, and this is how you learn whether the question has been asked, is still waiting, was refused, or has already been spent. Read only, and deliberately: the approver of a cross-project crossing is the USER, never the target project's coordinator — one agent accepting work on another goal's behalf is the failure the boundary exists to prevent — so point the account owner at the project page to answer it."},
	{Tool: "project_ensure_coordinator", Argv: []string{"orbit", "project", "ensure-coordinator"}, Usage: "orbit project ensure-coordinator PROJECT_ID [--json]", Arguments: []string{"[project-id] (required)", "--json"}, Description: "The session that coordinates this project, opening a replacement ONLY when the conversation the project points at can no longer be handed a message — no runner, an offline runner, a run that never started, a row in Trash, or a run that was replaced (§13.6 SU6) — and never displacing a conversation that can still receive one: alive, or ended in a way its runner can still revive, comes back as created:false with that same sessionId and not one row written. So created:false means that session is the one to send to (`orbit session send --resume-if-ended`), and created:true carries replacedSessionId and replaceReason saying what the replacement left behind. The refusal that stays is COORDINATOR_UNAVAILABLE (owner: USER, requiredAction: rebind): the project's coordination workspace is disabled, trashed or no longer recorded, and where a project's coordination lives is the account owner's decision (§8.2) — so that refusal is theirs to act on, and a retry answers the same thing. The acting session is never the one replaced, and a project with no coordinator at all gets its FIRST one, freely landed where its work already runs. This command acts for the session it runs in, and it is advertised only where the orchestration grant it spends exists.", Mutates: true, RequiresOrchestration: true},
	{Tool: "project_send", Argv: []string{"orbit", "project", "send"}, Usage: "orbit project send PROJECT_ID (--message TEXT | --message-file -) [--client-turn-id ID] [--json]", Arguments: []string{"[project-id] (required)", "--message <text> | --message-file - (required)", "--client-turn-id <id> (idempotency key: repeat it on a retry to get the same turn back)", "--expect-reply", "--reply-options <json array of {label, description}>", "--reply-within-seconds <n> (60-2592000)", "--json"}, Description: "Hand one message to this project's coordinator, addressed by the PROJECT rather than by a session id: the conversation is resolved at the moment the message is DELIVERED, which is the whole of what this adds to project_ensure_coordinator — the id that call answers with is invalidated by a rotation the caller cannot see, and a message sent to it then reaches a reader instead of the project. A conversation that can be handed the message is delivered to and NOT displaced, an ended one whose runner can still revive it included: that case is a REVIVE (what `orbit session send --resume-if-ended` does) rather than a replacement. Only a conversation that cannot take a message at all is replaced — by the same rotation ensure-coordinator performs — and the message goes to the replacement in the same call. The response says what happened rather than what was asked for: created and sessionId name the conversation the message is on, and replacedSessionId/replaceReason are present only when this call rotated to get there. The refusal that stays is COORDINATOR_UNAVAILABLE (409, owner: USER, requiredAction: rebind) — where a project's coordination lives is the account owner's decision, so that one is theirs to act on and a retry answers the same thing — while a write refused after a coordinator WAS found comes back as COORDINATOR_MESSAGE_UNDELIVERED with the sentence that refused it inside. --client-turn-id is the key the message is written under and what makes a retry safe: repeat a call whose answer you never saw with the same key and the same message, and you get that same turn back instead of a second copy; omitted, the server mints one and every call is a new message. The acting session is the authority and there is no headless form: an agent delivers from a session this runner is running, and this command is advertised only where the orchestration grant it spends exists. --expect-reply makes it a request to the coordinator it is delivered to: the call returns at once with requestId and replyBy, and the outcome comes back to this session as a turn.", Mutates: true, RequiresOrchestration: true},
	{Tool: "project_blocker_resolve", Argv: []string{"orbit", "project", "resolve-blocker"}, Usage: "orbit project resolve-blocker PROJECT_ID --blocker-id ID --reason TEXT [--json]", Arguments: []string{"[project-id] (required)", "--blocker-id <id> (required; as 'orbit project get' spells it in blockers.open[].id)", "--reason <text> (required; why this no longer blocks)", "--json"}, Description: "End one of a project's open blockers, saying why it no longer blocks — the write half of what `orbit project get` shows in blockers.open. Run from inside a session it first puts the blocker and your reason on a confirmation card and waits for the account owner's answer: nothing is written if they decline, and the reason they give says what they want instead. Typed at a terminal outside a session there is nobody to ask and the resolution is written straight away, because that caller is the owner. Resolve one when you can say what changed — the work landed, the question was answered elsewhere, the condition no longer holds — and not to get past a wait you disagree with: a HUMAN_DECISION_REQUIRED blocker is the project asking for a judgment, and the card is where you argue for it rather than a formality around it. An agent's resolution records resolved_by = COORDINATOR with the reason it gave; a resolution is final, so an already-resolved blocker is refused rather than restated, and a condition that returns raises a new episode.", Mutates: true},
	{Tool: "integration_skip_merge_check", Argv: []string{"orbit", "project", "skip-merge-check"}, Usage: "orbit project skip-merge-check PROJECT_ID TASK_ID --reason TEXT [--json]", Arguments: []string{"[project-id] (required)", "[task-id] (required; the DONE task whose failed landing should go on without the project's merge check)", "--reason <text> (required; why this check should not hold up this landing)", "--json"}, Description: "Queue ONE landing of a DONE task again with the project's merge check NOT RUN — skipped, never passed — and only with the account owner's yes. For the red that is about the check rather than the delivery: a command that cannot pass where the runner runs it. Every other door is wrong for that red: integration_retry runs the same command against the same machine and is red again by construction, task_reopen sends back work that is not at fault, and the check COMMAND is the owner's to change. Inside a session it first puts the project, the task, the check command and your reason on a confirmation card and waits for the owner's answer: a decline queues nothing and the landing stands as it failed. Typed at a terminal as yourself (`orbit login`) there is no card, because you are the person it would ask, and the row records you as the one who approved it. Only a landing that stopped on a check qualifies; a conflict is the branch's and an integration error is the machinery's (integration_retry answers those). The project's mergeCheckCommand setting is untouched: the next landing and every merge into main are checked as before, and the generation this queues records the skipped check, the reason and who approved it. Only the conversation the project is coordinated from may ask, and only where the failure is still the coordinator's to decide.", Mutates: true},
	{Tool: "project_request_start", Argv: []string{"orbit", "project", "request-start"}, Usage: "orbit project request-start PROJECT_ID --line LINE --automatic[=BOOL] --max-concurrent-tasks N --why TEXT [options]", Arguments: []string{"[project-id] (required)", "--line <PROJECT_BRANCH|MAIN> (required)", "--project-branch-name <ref> (PROJECT_BRANCH only; a full refs/heads/... ref)", "--automatic[=BOOL] (required)", "--max-concurrent-tasks <n> (required, 1-100)", "--merge-check-command <text>", "--why <text> (required; shown to the owner on the card)", "--json"}, Description: "Ask the account owner to start the project this session coordinates. Until they start it, task_start is refused for its tasks; run this once the plan is written — the criteria stated, the work filed as tasks under the project, and every acceptance criterion served by at least one task. Orbit checks the plan first: a plan that is not ready is refused (START_REQUEST_NOT_READY) with every reason at once and what to do about each — no criteria or no tasks, a criterion no task serves, a task whose assignee is not on a runner, a project branch with no repository — and nothing is filed. A ready plan is filed and the command returns at once with the request's itemId and any warnings (a criterion served only by work that looks like it produces no code and does not declare codeless, tasks set to start by hand, Automatic on a project branch with no merge check); the owner sees a \"Start this project?\" card with the settings as suggestions, and the coordinator is told when the project starts. Asking again replaces the open request; changing the plan before the start voids it. Acts for the session it runs in: only the project's coordinating conversation may ask.", Mutates: true, SessionOnly: true},
	{Tool: "project_request_done", Argv: []string{"orbit", "project", "request-done"}, Usage: "orbit project request-done PROJECT_ID --judgment TEXT (--gaps JSON | --gaps-file -) [--json]", Arguments: []string{"[project-id] (required)", "--judgment <text> (required; your call, shown first on the card)", "--gaps <json array> | --gaps-file - (required; one {criterionKey, title, whyNotProven, coordinatorChecked, evidenceRefs} per thing Orbit cannot prove, [] for none)", "--json"}, Description: "Ask the account owner to record the project this session coordinates done. Orbit records a project done by itself when it can prove every criterion; run this when it cannot and you have checked the project is done anyway, with your call in a sentence or two and one gap per thing Orbit cannot prove — the criterion's key, why Orbit cannot prove it, what you checked instead, and where that evidence is. Orbit checks the project first: one that is not ready is refused (DONE_REQUEST_NOT_READY) with every reason at once and what to do about each — a criterion its work has not met, a task running, queued or IN_PROGRESS, an item waiting on the owner, a landing or a merge into main in flight — and nothing is filed. A ready project is filed and the command returns at once with the request's itemId and a warning for every criterion not landed on main, with why; the owner sees an \"Is this project done?\" card and records the project done on it. Asking again replaces the open request; the project moving before the owner answers voids it. Acts for the session it runs in: only the project's coordinating conversation may ask.", Mutates: true, SessionOnly: true},
	{Tool: "project_merge_evidence", Argv: []string{"orbit", "project", "merge-evidence"}, Usage: "orbit project merge-evidence PROJECT_ID --requirement-id ID --target-branch REF --content-hash SHA256 [options]", Arguments: []string{"[project-id] (required)", "--requirement-id <text> (required)", "--target-branch <ref> (required)", "--content-hash <sha256> (required, 64 hex characters)", "--source <text>", "--detail <json>", "--json"}, Description: "Record what a target branch was observed to CONTAIN — the merge half of a project's acceptance evidence. Hash the content you actually read (a normalized `git grep` result, a blob or tree digest, a rendered diff), never `git branch --contains`: after a squash merge that answer is a guaranteed false negative while the content is plainly there. Same content as the last observation and only the observation time moves; different content writes a new row one refGeneration up and advances the evidence version automatically. Nothing judges the observation: migration 0229 removed the project acceptance judgment, so this records what was seen and stops there.", Mutates: true},
	{Tool: "project_create", Argv: []string{"orbit", "project", "create"}, Usage: "orbit project create --title TITLE [options]", Arguments: []string{"--title <text> (required)", "--goal <text> | --goal-file - (what the work is trying to achieve; max 4,000 characters)", "--acceptance-criteria-items <json array> | --acceptance-criteria-items-file - (every item requires text + verificationMethod)", "--instructions <text> | --instructions-file - (how the work is to be done; max 10,000 characters)", "--workspace-id <id> (open the coordinator in this workspace instead of in the calling session; needs orchestration enabled)", "--integration-line <MAIN|PROJECT_BRANCH>", "--project-branch <ref>", "--upstream-ref <ref>", "--merge-check-command <text>", "--merge-check-timeout-seconds <n>", "--escalate-after-seconds <n>", "--json"}, Description: "Create a project under this runner's owner — the durable context a body of work is carried out from, as opposed to a task, which is one piece of that work. Use --acceptance-criteria-items for project outcomes; each item requires assertion text and a reader-facing verificationMethod. Nothing in Orbit evaluates them: migration 0229 removed the project acceptance judgment, so a criterion is a stated condition and no more. Inside a session it first puts a confirmation card in front of the user and waits for the answer: nothing is created if they decline. The project starts OPEN and holds no tasks; file them with `orbit task create --project-id <id>` afterwards. Inside a session the project is also bound to that session as its coordinator, and to the workspace it runs in, in the same write that creates it — so opening the coordinator later returns to this conversation rather than starting another; one session coordinates at most one project — record a second from the same conversation and the server opens THAT project its own coordinator in the same workspace and says so — and headless there is no session and so no such binding. --workspace-id says the coordinator belongs elsewhere: it OPENS the conversation there, since a project that names a coordination workspace has a coordinator, and it needs orchestration enabled because it names a workspace rather than inheriting one. The whole integration object — the line (where this project's finished tasks land, with the project branch and upstream as full refs), the merge check run on the combined tree before a landing, and the window an exception waits on the coordinator — is the account owner's at creation, so it is accepted at a terminal and refused for an agent session: a merge-check card names the project it changes and this one does not exist yet, and the line is decided at the first integration and locked from then on. A session sets the merge check afterwards with `orbit project update --merge-check-command`, which asks the owner first.", Mutates: true},
	{Tool: "project_update", Argv: []string{"orbit", "project", "update"}, Usage: "orbit project update PROJECT_ID [options]", Arguments: []string{"[project-id] (required)", "--title <text>", "--goal <text> | --goal-file - | --clear-goal", "--acceptance-criteria-items <json array> | --acceptance-criteria-items-file - (structured whole replacement; text + verificationMethod required; only a tightening lands immediately, and [] drops every criterion, which is held)", "--instructions <text> | --instructions-file - | --clear-instructions", "--status <OPEN|DONE|CANCELLED>", "--integration-line <MAIN|PROJECT_BRANCH>", "--project-branch <ref>", "--upstream-ref <ref>", "--merge-check-command <text>", "--merge-check-timeout-seconds <n>", "--expected-config-revision <n>", "--json"}, Description: "Update a project you own. The integration settings are two decisions in one object. THE LINE — --integration-line, --project-branch, --upstream-ref — is where this project's finished tasks land (MAIN, or a project branch that reaches main later), and it is the account owner's to choose: accepted at a terminal, refused for an agent session. Unchosen, it is decided at the first integration (code tasks that depend on one another go through a project branch) and locked from then on. THE MERGE CHECK — --merge-check-command, --merge-check-timeout-seconds — is what runs on the combined tree before a landing, and inside a session it is yours to PROPOSE: this command first puts the project, the check as it stands and the check you are asking for on a confirmation card and waits for the account owner, and the change takes effect only if they approve it; nothing is written if they decline, and a second change is a second question, because an approval covers the exact command and timeout it named. At a terminal there is nobody to ask and the write goes straight through. Structured acceptance items are a whole-collection replacement, and only a tightening edit lands immediately — adding an item, reordering, or stepping an item's verificationMethod up the HUMAN → VERIFICATION → EXECUTABLE ladder. Any other edit (dropping an item, rewriting an item's text, or rewording verificationMethod any other way) is held as a proposal for the account owner to decide, reported as acceptanceCriteriaHold with the criteria left as they were; so [] drops every criterion rather than clearing the collection, and is held whenever there is one to drop. Every item requires text and verificationMethod; preserve ids from project_get to retain identity, omit id to add. Nothing evaluates them. At least one flag is required, and --expected-config-revision does not count as one. Only one --*-file flag per invocation, since they all read the same stdin.", Mutates: true},
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
	if _, err := userModeGate("project " + action); err != nil {
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
	case "ensure-coordinator":
		return cliProjectEnsureCoordinator(args[1:], out)
	case "send":
		return cliProjectSend(args[1:], in, out)
	case "resolve-blocker":
		return cliProjectResolveBlocker(args[1:], out)
	case "request-start":
		return cliProjectRequestStart(args[1:], out)
	case "request-done":
		return cliProjectRequestDone(args[1:], in, out)
	case "merge-evidence":
		return cliProjectMergeEvidence(args[1:], in, out)
	case "skip-merge-check":
		return cliProjectSkipMergeCheck(args[1:], out)
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
	t, err := cliProjectTransport()
	if err != nil {
		return err
	}
	raw, err := t.getProject(id)
	if err != nil {
		return fmt.Errorf("get project: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

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
	t, err := cliProjectTransport()
	if err != nil {
		return err
	}
	raw, err := t.getProjectHandoffs(id, *state)
	if err != nil {
		return fmt.Errorf("get project crossings: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

// cliProjectEnsureCoordinator takes the session that coordinates this project, opening the next
// conversation only when the standing one can no longer be handed a message.
//
// The CLI half of the project_ensure_coordinator tool, and the path an agent needs after a
// delivery to its own project's coordinator was refused: the pointer is not a mailbox, and the
// owner's `replace` is behind a confirmation card, so without this the only way out was asking a
// person. What it will not do is end a conversation somebody is still in — that press stays on the
// owner's card — so an agent that meets COORDINATOR_UNAVAILABLE hands it over rather than retrying.
//
// It acts for the conversation it runs in and has no headless form: the replacement is opened FOR
// the session that asks, which is also why the acting session is never the one replaced. The
// session and its credential travel the way every other acting-session call sends them
// (ORBIT_SESSION_ID plus the credential the runner injected), and the orchestration gate this
// spends is the one `project create --workspace-id` spends — which is the grant the capability
// document advertises it under (RequiresOrchestration), so it never appears where its tool is not
// offered either.
func cliProjectEnsureCoordinator(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit project ensure-coordinator")
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
	sessionID := strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID"))
	if sessionID == "" {
		return fmt.Errorf("orbit project ensure-coordinator acts for the Orbit session it runs in " +
			"(ORBIT_SESSION_ID), and there is none here: the replacement it opens is for the " +
			"conversation that asks. Run it from inside a session, or move the project's coordinator " +
			"from its page in the Orbit app")
	}
	if !mcpOrchestrationEnabled() {
		return fmt.Errorf(orchestrationOffMsg)
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.ensureProjectCoordinator(
		sessionID,
		strings.TrimSpace(os.Getenv(envOrchestrationToken)),
		id,
	)
	if err != nil {
		return fmt.Errorf("ensure project coordinator: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

// cliProjectSend hands one message to this project's coordinator, addressed by the project rather
// than by a session id.
//
// It is the one call an agent needs where `ensure-coordinator` followed by `session send` was two,
// and it is one call because the pair has a hole in it: the id ensure answers with is invalidated
// by a rotation the caller cannot see, and the message then reaches a reader instead of the
// project. Delivery resolves the conversation inside the request, and the response reports which
// conversation that turned out to be — `created`, `replacedSessionId` and `replaceReason` say what
// actually happened rather than what was asked for, so nothing here reshapes it.
//
// Everything else it sends is the send door's own: the acting session and its credential, which are
// also why there is no headless form — the server admits no caller that is not a session this
// runner is running, and where the project's coordination lives is the account owner's decision, so
// COORDINATOR_UNAVAILABLE is handed to a person (its requiredAction names one) rather than retried.
func cliProjectSend(args []string, in io.Reader, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit project send")
	message := fs.String("message", "", "the message to deliver")
	messageFile := fs.String("message-file", "", "read the message from stdin (-)")
	clientTurnID := fs.String("client-turn-id", "", "idempotency key for this message")
	request := addSessionRequestFlags(fs)
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
	messageText, messageSet, err := readCLIText(in, *message, flagWasSet(fs, "message"),
		*messageFile, flagWasSet(fs, "message-file"), "message")
	if err != nil {
		return err
	}
	if !messageSet || strings.TrimSpace(messageText) == "" {
		return fmt.Errorf("--message or --message-file - is required")
	}
	sessionID := strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID"))
	if sessionID == "" {
		return fmt.Errorf("orbit project send acts for the Orbit session it runs in " +
			"(ORBIT_SESSION_ID), and there is none here: the delivery is made TO this project's " +
			"coordinator FROM a session this runner is running, and a terminal outside one has no " +
			"such conversation. Run it from inside a session")
	}
	if !mcpOrchestrationEnabled() {
		return fmt.Errorf(orchestrationOffMsg)
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	// The key rides only when there is one, exactly as `session send` sends it: omitted, the request
	// is the one it always was, and the server mints the key itself.
	body := map[string]interface{}{"message": messageText}
	if key := strings.TrimSpace(*clientTurnID); key != "" {
		body["clientTurnId"] = key
	}
	if err := request.apply(body); err != nil {
		return err
	}
	raw, err := t.sendProjectCoordinator(
		sessionID,
		strings.TrimSpace(os.Getenv(envOrchestrationToken)),
		id,
		body,
	)
	if err != nil {
		return fmt.Errorf("send to project coordinator: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

// cliProjectResolveBlocker ends one open blocker with the reason it no longer blocks.
//
// The same card the MCP tool raises, through the same helper: an agent that shells out instead of
// calling the tool meets the identical question, because a gate one door wide is not a gate. What
// differs is only where the session comes from — the env var the runner injects, rather than the
// server object — and headless there is none, so the write goes straight through to the owner's own
// machine, as every create here does.
func cliProjectResolveBlocker(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit project resolve-blocker")
	blockerID := fs.String("blocker-id", "", "the blocker to end, as 'orbit project get' spells it")
	reason := fs.String("reason", "", "why this no longer blocks")
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
	if strings.TrimSpace(*blockerID) == "" {
		return fmt.Errorf("--blocker-id is required: read 'orbit project get %s' for the open ones", id)
	}
	if strings.TrimSpace(*reason) == "" {
		return fmt.Errorf("--reason is required: say why this blocker is no longer blocking")
	}
	t, err := cliProjectTransport()
	if err != nil {
		return err
	}
	var raw json.RawMessage
	var declined string
	if runner, ok := t.(*Transport); ok {
		raw, declined, err = resolveBlockerWithApproval(
			runner,
			strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID")),
			id,
			strings.TrimSpace(*blockerID),
			strings.TrimSpace(*reason),
		)
	} else {
		// As the person: they are the account owner the card would ask, so the write goes straight
		// through, as it does headless.
		raw, err = t.resolveProjectBlocker(id, strings.TrimSpace(*blockerID),
			map[string]interface{}{"reason": strings.TrimSpace(*reason)})
	}
	if err != nil {
		return fmt.Errorf("resolve blocker: %w", err)
	}
	if declined != "" {
		return fmt.Errorf("resolve blocker: the human left this blocker open: %s", declined)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

// cliProjectSkipMergeCheck queues one landing with the project's merge check not run.
//
// The same two sides of one door the MCP tool has, and the same card through the same helper: an
// agent that shells out instead of calling the tool meets the identical question, because a gate one
// door wide is not a gate. Which side this is is decided by the identity, not by a flag: inside a
// session (ORBIT_SESSION_ID) the CLI acts as that conversation and the owner must answer a card,
// while as the person at a terminal (`orbit login`) there is nobody to ask and the write goes
// straight through — the caller is the account owner whose yes the card would be.
func cliProjectSkipMergeCheck(args []string, out io.Writer) error {
	// Two ids, both peeled before the flags are parsed: `flag` stops at the first non-flag argument,
	// so one left in front of them would silently swallow every option behind it.
	id, rest := peelLeadingID(args)
	taskID, rest := peelLeadingID(rest)
	fs := newCLIFlagSet("orbit project skip-merge-check")
	reason := fs.String("reason", "", "why this check should not hold up this landing")
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
	if taskID == "" {
		return fmt.Errorf("task id is required: the DONE task whose failed landing should go on " +
			"without the check (orbit project skip-merge-check PROJECT_ID TASK_ID --reason TEXT)")
	}
	if strings.TrimSpace(*reason) == "" {
		return fmt.Errorf("--reason is required: say why this check should not hold up this landing. " +
			"It is what the account owner decides on, and it stays on the generation it queues")
	}
	t, err := cliProjectTransport()
	if err != nil {
		return err
	}
	var raw json.RawMessage
	if runner, ok := t.(*Transport); ok {
		sessionID := strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID"))
		if sessionID == "" {
			return fmt.Errorf("orbit project skip-merge-check is either the coordinating " +
				"conversation's, with the account owner's card, or the owner's own at a terminal " +
				"(`orbit login`), and this is neither: no session is running it and no login is " +
				"saved. Run it from inside the session that coordinates the project, or log in as " +
				"the account owner and run it again")
		}
		// The facts first, then the card: the owner reads what is being skipped, not the word "skip".
		facts, err := skipMergeCheckFacts(runner, id, taskID, strings.TrimSpace(*reason))
		if err != nil {
			return fmt.Errorf("skip merge check: %w", err)
		}
		approvalID, declined, err := askForSkipMergeCheck(runner, sessionID, facts)
		if err != nil {
			return fmt.Errorf("skip merge check: %w", err)
		}
		if declined != "" {
			return fmt.Errorf("skip merge check: the human did not approve skipping this check, and "+
				"nothing was queued: %s", declined)
		}
		raw, err = runner.skipIntegrationMergeCheck(sessionID, id, taskID, strings.TrimSpace(*reason), approvalID)
		if err != nil {
			return fmt.Errorf("skip merge check: %w", err)
		}
	} else {
		// As the person: they are the account owner the card would ask, so the write goes straight
		// through, as it does headless, and the row records them as the one who approved it. No
		// session to act as and no card to name — this identity is the answer to both.
		raw, err = t.skipIntegrationMergeCheck("", id, taskID, strings.TrimSpace(*reason), "")
		if err != nil {
			return fmt.Errorf("skip merge check: %w", err)
		}
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

// cliProjectRequestStart asks the account owner to start the project this session coordinates: the
// CLI half of project_request_start, with the same body and the same rendering of a refusal
// (`project_start_request.go`).
//
// It acts for the conversation it runs in, as ask_owner does: the server compares the acting session
// with the project's coordinator pointer, so a terminal outside a session has nothing to ask with and
// is told so here rather than by a 403.
func cliProjectRequestStart(args []string, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit project request-start")
	line := fs.String("line", "", "where finished tasks land: PROJECT_BRANCH or MAIN")
	branch := fs.String("project-branch-name", "", "with PROJECT_BRANCH: the branch as a full ref")
	automatic := fs.Bool("automatic", false, "whether the coordinator runs the project for the owner")
	maxConcurrent := fs.Int("max-concurrent-tasks", 0, "how many of its tasks may run at once")
	mergeCheck := fs.String("merge-check-command", "", "the check run on the combined tree")
	why := fs.String("why", "", "one sentence, shown to the owner on the card")
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
	if !flagWasSet(fs, "automatic") {
		return fmt.Errorf("--automatic is required: --automatic to suggest the coordinator runs the " +
			"project for the owner, --automatic=false to suggest they decide")
	}
	sessionID := strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID"))
	if sessionID == "" {
		return fmt.Errorf("orbit project request-start asks as the conversation that coordinates the " +
			"project (ORBIT_SESSION_ID), and there is none here: run it from inside that session")
	}
	fields := map[string]interface{}{
		"line":               *line,
		"automatic":          *automatic,
		"maxConcurrentTasks": float64(*maxConcurrent),
		"why":                *why,
		"projectBranchName":  *branch,
		"mergeCheckCommand":  *mergeCheck,
	}
	if *maxConcurrent == 0 {
		delete(fields, "maxConcurrentTasks")
	}
	body, err := projectStartRequestBody(fields)
	if err != nil {
		return err
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.requestProjectStart(sessionID, id, body)
	if err != nil {
		return errors.New(projectStartRequestRefusal(err))
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

// cliProjectRequestDone asks the account owner to record the project this session coordinates done:
// the CLI half of project_request_done, with the same body and the same rendering of a refusal
// (`project_done_request.go`). It acts for the conversation it runs in, as request-start does, so a
// terminal outside a session is told so here rather than by a 403.
func cliProjectRequestDone(args []string, in io.Reader, out io.Writer) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit project request-done")
	judgment := fs.String("judgment", "", "your call, in a sentence or two — shown first on the card")
	gaps := fs.String("gaps", "", "JSON array: one gap per thing Orbit cannot prove ([] for none)")
	gapsFile := fs.String("gaps-file", "", "read the gaps array from stdin (-)")
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
	sessionID := strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID"))
	if sessionID == "" {
		return fmt.Errorf("orbit project request-done asks as the conversation that coordinates the " +
			"project (ORBIT_SESSION_ID), and there is none here: run it from inside that session")
	}
	text, set, err := readCLIText(in, *gaps, flagWasSet(fs, "gaps"), *gapsFile, flagWasSet(fs, "gaps-file"), "gaps")
	if err != nil {
		return err
	}
	if !set {
		return fmt.Errorf("--gaps (or --gaps-file -) is required: one gap per thing Orbit cannot " +
			"prove, [] for none")
	}
	var parsed interface{}
	if err := json.Unmarshal([]byte(text), &parsed); err != nil {
		return fmt.Errorf("--gaps must be a JSON array of gaps: %w", err)
	}
	body, err := projectDoneRequestBody(map[string]interface{}{"judgment": *judgment, "gaps": parsed})
	if err != nil {
		return err
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.requestProjectDone(sessionID, id, body)
	if err != nil {
		return errors.New(projectDoneRequestRefusal(err))
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
	t, err := cliProjectTransport()
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
// validates against. DONE joined them when migration 0229 removed the gate that used to derive it:
// a project is settled by whoever writes the column. Checked here so a typo is a message naming
// the alternatives rather than a 400 the caller has to decode.
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

// parseProjectAcceptanceItems validates the structural CLI form before it reaches the server.
// Create assigns every id server-side; update may echo ids returned by project_get to retain
// identity. Unknown fields are refused so a misspelling cannot look like a successful metadata
// write that the DTO discarded.
func parseProjectAcceptanceItems(text string, allowIDs bool) ([]map[string]interface{}, error) {
	if strings.TrimSpace(text) == "null" {
		return nil, fmt.Errorf("acceptance criteria items must be a JSON array stating the whole set; omit the flag to leave them unchanged")
	}
	var raw []map[string]interface{}
	if err := json.Unmarshal([]byte(text), &raw); err != nil {
		return nil, fmt.Errorf("acceptance criteria items must be a JSON array of objects: %w", err)
	}
	return normalizeProjectAcceptanceItems(raw, allowIDs)
}

// The four fields a project criterion carried until migration 0233. Kept as a named set rather
// than folded into the unknown-field message so a caller sending yesterday's shape is told what
// happened to it, not merely that the server does not recognise the word.
var removedProjectCriterionWiring = map[string]struct{}{
	"completionCriterion":        {},
	"acceptanceCommand":          {},
	"acceptanceExpectedExitCode": {},
	"evidenceTaskId":             {},
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
			// Named separately from "unknown field" on purpose. These four were fields until
			// migration 0233 dropped them, so a caller sending one is not guessing — it is using
			// the shape it was taught, and the answer it needs is where that relation went.
			if _, removed := removedProjectCriterionWiring[key]; removed {
				return nil, fmt.Errorf("acceptance criterion %d %s was removed by migration 0233: a criterion states text and verificationMethod, and the work that serves it declares the criterion (task.criterionDefinitionId) rather than the criterion naming the work", index+1, key)
			}
			allowed := key == "text" || key == "verificationMethod" ||
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
		normalized := map[string]interface{}{
			"text": value, "verificationMethod": method,
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

// The integration flags create and update share, folded into the one object the server validates
// as a whole. Only a flag that was NAMED reaches the body: an empty --merge-check-command is how
// the check is removed, so "what it carries" cannot stand in for "was it asked for".
func projectIntegrationSettings(
	fs *flag.FlagSet,
	line string,
	projectBranch string,
	upstreamRef string,
	mergeCheckCommand string,
	mergeCheckTimeoutSeconds int,
) (map[string]interface{}, error) {
	integration := map[string]interface{}{}
	if flagWasSet(fs, "integration-line") {
		if line != "MAIN" && line != "PROJECT_BRANCH" {
			return nil, fmt.Errorf("--integration-line must be MAIN or PROJECT_BRANCH")
		}
		integration["line"] = line
	}
	if flagWasSet(fs, "project-branch") {
		integration["projectBranchName"] = projectBranch
	}
	if flagWasSet(fs, "upstream-ref") {
		integration["upstreamRef"] = upstreamRef
	}
	if flagWasSet(fs, "merge-check-command") {
		if strings.TrimSpace(mergeCheckCommand) == "" {
			integration["mergeCheckCommand"] = nil
		} else {
			integration["mergeCheckCommand"] = mergeCheckCommand
		}
	}
	if flagWasSet(fs, "merge-check-timeout-seconds") {
		if mergeCheckTimeoutSeconds <= 0 {
			return nil, fmt.Errorf("--merge-check-timeout-seconds must be a positive number of seconds")
		}
		integration["mergeCheckTimeoutSeconds"] = mergeCheckTimeoutSeconds
	}
	return integration, nil
}

func cliProjectCreate(args []string, in io.Reader, out io.Writer) error {
	fs := newCLIFlagSet("orbit project create")
	title := fs.String("title", "", "what this body of work is called")
	goal := fs.String("goal", "", "what the project is trying to achieve")
	goalFile := fs.String("goal-file", "", "read the goal from stdin (-)")
	acceptanceCriteriaItems := fs.String("acceptance-criteria-items", "", "JSON array of structured acceptance criterion objects")
	acceptanceCriteriaItemsFile := fs.String("acceptance-criteria-items-file", "", "read structured acceptance criteria JSON from stdin (-)")
	instructions := fs.String("instructions", "", "how this project's work is to be done")
	instructionsFile := fs.String("instructions-file", "", "read the instructions from stdin (-)")
	workspaceID := fs.String("workspace-id", "", "open this project's coordinator in this workspace instead of in the calling session")
	integrationLine := fs.String("integration-line", "", "where finished tasks land: MAIN or PROJECT_BRANCH")
	projectBranch := fs.String("project-branch", "", "the project branch as a full ref, e.g. refs/heads/project/next")
	upstreamRef := fs.String("upstream-ref", "", "what main is for this project, as a full ref")
	mergeCheckCommand := fs.String("merge-check-command", "", "the check run on the combined tree before a landing")
	mergeCheckTimeoutSeconds := fs.Int("merge-check-timeout-seconds", 0, "that check's budget in seconds")
	escalateAfterSeconds := fs.Int("escalate-after-seconds", 0, "how long an exception waits on the coordinator before it becomes yours")
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
	if err := projectStdinFlags(fs, "goal-file", "acceptance-criteria-items-file", "instructions-file"); err != nil {
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
	if id := strings.TrimSpace(*workspaceID); id != "" {
		body["workspaceId"] = id
	}
	// The integration line, chosen in the same breath as the project. Same object and same door
	// rule as `orbit project update`: typed at a terminal there is no session, and the server
	// reads that absence as the account owner — the only principal allowed to say where a
	// project's work lands. From inside a session the whole request is refused rather than having
	// the choice dropped.
	integration, err := projectIntegrationSettings(
		fs, *integrationLine, *projectBranch, *upstreamRef, *mergeCheckCommand, *mergeCheckTimeoutSeconds,
	)
	if err != nil {
		return err
	}
	if flagWasSet(fs, "escalate-after-seconds") {
		if *escalateAfterSeconds <= 0 {
			return fmt.Errorf("--escalate-after-seconds must be a positive number of seconds")
		}
		integration["exceptionEscalationSeconds"] = *escalateAfterSeconds
	}
	if len(integration) > 0 {
		body["integration"] = integration
	}
	t, err := cliProjectTransport()
	if err != nil {
		return err
	}
	// The session this ran in, the same env var `orbit task create` attributes a task with and
	// `orbit notify` routes an alert by. Here the server reads it to record that session's
	// workspace as the new project's coordinator default, so the project can be coordinated
	// straight away rather than only once one of its tasks has an assignee to borrow from.
	// Headless (launchd/cron, no ORBIT_SESSION_ID) sends no header and gets no default, which is
	// the honest answer: no session, no workspace to inherit.
	//
	// The orchestration credential travels beside it and is spent only by `--workspace-id`, which
	// names a workspace instead of inheriting one — the server checks that choice against this
	// session's grant. Headless it is empty, and naming a workspace is refused there rather than
	// authorized by a machine credential alone.
	sessionID := strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID"))
	// The same card project_create raises over MCP; headless there is no session and nobody to ask,
	// and as the person there is none either (`orbit task create` says why).
	if runner, ok := t.(*Transport); ok {
		// A session sets no integration setting here, and is told so BEFORE anybody is asked. The
		// server refuses the object whole at creation — a merge-check card has to name the project
		// it changes, and this request is what would create one — so a card filed for it would be an
		// interruption whose only possible answer is "that was refused anyway". The MCP
		// `project_create` tool takes no integration at all, so this door is the one that had to say
		// it; create the project, then propose the check with `orbit project update`.
		if sessionID != "" {
			if _, carries := body["integration"]; carries {
				return fmt.Errorf("create project: the integration settings are the account owner's " +
					"to set at creation, and this is a session — a merge check is set afterwards with " +
					"`orbit project update --merge-check-command`, which asks them first, and the line " +
					"from the web app, the user API or a terminal")
			}
		}
		if declined, err := askBeforeCreate(runner, sessionID, projectCreateApprovalToolName, body); err != nil {
			return fmt.Errorf("create project: %w", err)
		} else if declined != "" {
			return fmt.Errorf("create project: the human rejected this project: %s", declined)
		}
	}
	raw, err := t.createProject(
		sessionID,
		strings.TrimSpace(os.Getenv(envOrchestrationToken)),
		body,
	)
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
	acceptanceCriteriaItems := fs.String("acceptance-criteria-items", "", "JSON array replacing the structured acceptance criteria")
	acceptanceCriteriaItemsFile := fs.String("acceptance-criteria-items-file", "", "read structured acceptance criteria JSON from stdin (-)")
	instructions := fs.String("instructions", "", "replace how this project's work is to be done")
	instructionsFile := fs.String("instructions-file", "", "read the replacement instructions from stdin (-)")
	clearInstructions := fs.Bool("clear-instructions", false, "leave the project with no standing instructions")
	status := fs.String("status", "", "where the work stands: OPEN, DONE or CANCELLED")
	integrationLine := fs.String("integration-line", "", "where finished tasks land: MAIN or PROJECT_BRANCH")
	projectBranch := fs.String("project-branch", "", "the project branch's full ref, e.g. refs/heads/project/next")
	upstreamRef := fs.String("upstream-ref", "", "what main is for this project, as a full ref")
	mergeCheckCommand := fs.String("merge-check-command", "", "the check run on the combined tree before a landing (empty removes it)")
	mergeCheckTimeoutSeconds := fs.Int("merge-check-timeout-seconds", 0, "that check's budget in seconds")
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
	if err := projectStdinFlags(fs, "goal-file", "acceptance-criteria-items-file", "instructions-file"); err != nil {
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
	// The integration line, sent as one object so the server validates the whole choice at once.
	// Typed at a terminal there is no session, and the server reads that absence as the account
	// owner — which is the only principal allowed to choose where a project's work lands.
	integration, err := projectIntegrationSettings(
		fs, *integrationLine, *projectBranch, *upstreamRef, *mergeCheckCommand, *mergeCheckTimeoutSeconds,
	)
	if err != nil {
		return err
	}
	if len(integration) > 0 {
		body["integration"] = integration
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
	t, err := cliProjectTransport()
	if err != nil {
		return err
	}
	// The same card the MCP tool raises, through the same helper: an agent that shells out instead
	// of calling the tool meets the identical question, because a gate one door wide is not a gate.
	// What differs is only where the session comes from — the env var the runner injects, rather
	// than the server object.
	//
	// The session rides with the WRITE only when there is a card to match it to, and that is not
	// tidiness: `orbit project update` has never sent one — a revision is not a "where am I"
	// question, and `project_cli_test.go` holds it that way. A merge check is the exception, and it
	// is forced rather than chosen: the server matches the card the owner answered to the session
	// that asks, so a write resting on a card has to say which session it is. Nothing else here is
	// gated on who is asking, so nothing else needs it.
	var raw json.RawMessage
	var declined string
	if runner, ok := t.(*Transport); ok {
		sessionID := ""
		if mergeCheckCardRequired(body) {
			sessionID = strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID"))
		}
		raw, declined, err = updateProjectWithApproval(runner, sessionID, id, body)
	} else {
		// As the person: they are the account owner the card would ask, so the write goes straight
		// through, as it does headless.
		raw, err = t.updateProject("", id, body)
	}
	if err != nil {
		return fmt.Errorf("update project: %w", err)
	}
	if declined != "" {
		return fmt.Errorf("update project: the owner did not approve this merge-check change: %s", declined)
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
	t, err := cliProjectTransport()
	if err != nil {
		return err
	}
	raw, err := t.deleteProject(id)
	if err != nil {
		return fmt.Errorf("delete project: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}
