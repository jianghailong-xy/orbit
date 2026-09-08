# Completion-input routing

Project completion is reevaluated when an immutable input to a declared criterion changes. Task
collection shape and Session lifecycle are not criterion inputs.

## Old and new read/producer surfaces

| Old producer | Old read / gate | New committed producer | New fact identity | Consumer |
| --- | --- | --- | --- | --- |
| `ProjectTasksSettledProducer` after general Task mutations | Every Task in the Project; refused delivery until every row was `DONE` or `CANCELLED` | `TaskCompletionEvidenceService.submit` | `COMPLETION_EVIDENCE_REVISED + taskId + revision/criterionRevision/evidenceDigest` | `JUDGMENT_REQUEST_DERIVER` |
| Runner `AttemptEndedUnsettledProducer` | Session status, including a special parked `AWAITING_INPUT` branch | Runner command-result commit | `EXECUTABLE_RESULT_RECORDED + requestId + resultId/evidenceDigest` | `DERIVED_COMPLETION_EVALUATOR` |
| General verifier Task settlement, indirectly through the whole-project scan | All Project Task statuses | Evidence-bound `TasksService.update` verdict commit | `VERIFICATION_VERDICT_RECORDED + requestId + verdictRevision/evidenceDigest/verdict` | `DERIVED_COMPLETION_EVALUATOR`; the evidence-bound verifier remains the one-shot agent carrier |
| Parked-attempt human blocker/comment | Session lifecycle and absence of L0/L1/L2 paths | N11 EVIDENCE_JUDGMENT request creation | `EVIDENCE_JUDGMENT_REQUESTED + requestId + criterionRevision/evidenceDigest` | `HUMAN_INBOX` (N12 request/inbox delivery), never an agent Session |
| No first-class replacement delivery | Whole-project rescan happened later | N11 request supersession by new evidence | `EVIDENCE_JUDGMENT_REQUEST_SUPERSEDED + oldRequestId + replacementRequestId/replacementDigest` | `HUMAN_INBOX` |
| General Task settlement after judgment | All Project Task statuses | `TasksService.judge` decision commit | `EVIDENCE_JUDGMENT_DECIDED + requestId + evidenceDigest/decision` | `DERIVED_COMPLETION_EVALUATOR` |

`PROJECT_TASKS_SETTLED` remains readable as historical wake audit and its old producer remains usable
only by historical direct tests; neither `TasksService`, `RunnerApiController` nor the production
module invokes or provides it. An OPEN sibling therefore cannot suppress a new input.

## Delivery and replay contract

The existing `project_coordinator_wake` partial-unique ledger owns the key. The key is still
`event + subject type/id + immutable subject version`; it is inserted before authorization. A
refusal changes the claim to `REFUSED`, which releases the partial unique key while retaining the
audit row. A repaired authority can deliver the identical fact again. Successful non-session
delivery compare-and-sets `CLAIMED` to `CONSUMED` and records `consumer_type`/`consumed_at`, so an
unchanged replay cannot run a consumer twice; a new evidence/result/verdict version gets a new key.

There is no scheduler, timeout, startup sweep or elapsed-time interpretation in this path.
`AWAITING_INPUT` neither refuses nor delays evidence/request routing. EVIDENCE_JUDGMENT consumers are
people and use the request/inbox surface. Only VERIFICATION uses its deterministic verifier Task
and the ordinary one-shot task execution machinery.

Since migration 0243 some fact kinds do reach the Project's person-opened `coordinator_session_id`
conversation, and each one is there because what it needs is an ACTION rather than a judgment. The
first was `CRITERION_UNLANDED`, whose work is finished and is on nobody's default branch: what it
needs done is a merge — irreversible and owed exactly once — so opening a conversation per such
fact would mean two coordinators racing for one branch, and the conversation already coordinating
the project is the one that should be told. `COMPLETION_EVIDENCE_REVISED` joined it through the
evidence ledger's own door, carrying the questions its reader is being sent to ask. Migration 0246
added the third, `PROJECT_ACCEPTANCE_LANDED` — every Task terminal AND every stated criterion
satisfied with its work on the branch — whose action is to put the criteria in front of the account
owner for the one act reserved to them (`CONFIRM_ACCEPTANCE_CRITERIA`). It is a separate event from
`PROJECT_TASKS_SETTLED` rather than a branch of it because merge receipts are written by paths the
Task write path does not touch: keyed on the settlement alone, the card would share a key the
judgment branch spends first and could then never be sent at all. The wake ends
`DELIVERED`, naming that conversation and creating no Session row, and the message is a NEXT_TURN
message rather than a steer: a conversation running a turn reads it after that turn ends. Delivery
is refused, with the key released, when there is no such conversation, when it has ended, and when
it has not yet read the last thing it was told. Every other fact kind is unchanged — recorded, or
judged in a one-shot session opened for it — and nothing here steers a running turn.

`PROJECT_TASKS_SETTLED` therefore no longer has two terminals. A settled Project whose stated
criteria are all satisfied and landed derives `PROJECT_ACCEPTANCE_LANDED` and is carded; any other
settled Project derives `PROJECT_TASKS_SETTLED` and is judged. At most one of the two exists per
derivation, so no Project is both carded and judged for one pass.

The N6 exit for the durable open question remains `OPEN_JUDGMENT_REQUEST`: it closes when the
bound N11 request is `DECIDED` or `SUPERSEDED`. Wake rows are delivery receipts, not open blockers,
so they add no second unresolved-signal family.

## A2: the evidence-judgment card, its timeout fallback, and its turn boundary

Design review of 2026-09-07, ahead of moving the EVIDENCE_JUDGMENT decision from the per-session
`NEEDS YOUR DECISION` rail to an `AskUserQuestion` card in the project's person-opened coordinator
conversation. Two questions were open; both are settled here, and the implementation tasks that
follow are bound by these answers rather than free to re-derive them.

Every line anchor below was re-read against `e821f967` rather than remembered. Anchors drift: quote
the sentence as well as the number, and if a number no longer lands on the quoted sentence, trust the
sentence and re-anchor it.

### D1 — the timeout fallback is (b), the derived pending read

**What is actually true about the 1800s, first.** It is the *engine's* deadline, not the control
plane's. `permissionPrompt` polls without a wall-clock cap (`src/runner-go/mcp.go:1170`), and
`Approval` (`src/apiserver/prisma/schema.prisma:1450-1475`) has no expiry column and no clock over
it. So when the engine abandons the tool call, nothing is written anywhere: the approval row stays
`PENDING` forever and the API server never learns the question died.

Two consequences follow, and the second is a defect the implementation must handle rather than a
nicety:

1. The wake is spent. A successful delivery ends it `DELIVERED`
   (`coordinator-delivery.service.ts:266`), and `DELIVERED` sits inside 0174's partial index by
   design — "0174's index excludes `REFUSED` and nothing else" (`coordinator-wake.ts:133`). The
   fact holds its key from then on. `coordinator-delivery.service.ts:49-53` already states the
   limit it stops at: a delivery that **could not be made** releases the key. A delivery that WAS
   made and then went unanswered is outside that sentence, and that gap is exactly this one.
2. **A stale `PENDING` approval is a trap, not a fallback.** The web re-fetches every pending
   approval when a session is selected (`WorkspaceView.tsx:2921`) and renders each one
   (`WorkspaceView.tsx:5496`), with no filter for whether the turn that asked is still alive. So
   after the abort the card is still on screen and still clickable — and answering it reaches
   nobody, because the poll loop that would have consumed the decision (`mcp.go:1174`) died with
   the turn. A surface that looks answerable and silently isn't is worse than no surface.

**Why (a) — release the wake on timeout so the same fact can be re-delivered — is rejected.**
Four reasons, none of them a preference:

- **`release` cannot reach the row.** `CoordinatorWakeService.release` compare-and-sets on
  `status = 'CLAIMED'` (`coordinator-wake.service.ts:155-159`); by the time a question is
  outstanding the wake is `DELIVERED`. So "reuse 0174's shape" is not reuse — it needs a new writer
  that moves a terminal success back out of the index, which is the property 0174 explicitly chose
  against: "The predicate is negative on purpose… a positive predicate would release the key the
  moment such a status were written, and the fact would wake a second session. For an index whose
  job is to stop a second wake, failing closed is the direction to fail in"
  (`0174_project_coordinator_wake/migration.sql:26-31`).
- **There is no committed fact that says the question timed out.** There is only "an approval has
  been `PENDING` longer than N", which is elapsed time. This document already states the contract
  for this path: "There is no scheduler, timeout, startup sweep or elapsed-time interpretation in
  this path" (line 30). And `coordinator-wake.ts` §0 lets a clock "re-observe, lease and re-deliver
  an already committed immutable fact" while forbidding it to "CREATE, DECIDE or RESOLVE a wake" —
  moving a spent wake back out of the index is resolving one.
- **Re-delivery is refused by the very state it is diagnosing, and the refusal feeds itself.** The
  timeout case *is* "the person is not there". Somebody not there has not read the message; a
  coordinator holding an unread message is `PENDING`; `resume` refuses it `NOT_TERMINAL` and the key
  goes back (`coordinator-delivery.service.ts:74-84`); the producer re-derives and is refused
  again. One wake row per pass and no progress on any of them — `COORDINATOR_NO_PROGRESS` rebuilt
  exactly, which `coordinator-wake.ts` §0 exists to keep out.
- **What it buys is asking an absent person the same question again**, on a timer. That is a retry
  clock, and this path does not have one: "There is no retry clock: the producer retries only when
  the same committed fact is delivered again" (`completion-input-router.service.ts:66-67`).

**Why (b) holds, on the same axis (a) was reaching for.** `readPendingEvidenceJudgments`
(`pending-evidence-judgments.ts:208`) is not a queue: "There is no row anywhere that says 'this is
pending'. Pending is a shape the facts already have… this read cannot fall out of date with them,
cannot be delivered twice, and cannot be lost" (lines 22-27). A question asked and never answered
still has that shape — the task is unsettled and the latest revision has no decision bound to it
(`pending-evidence-judgments.ts:247`). And its answer path needs no live turn: the rail writes
`POST /tasks/:id/evidence/decision` directly (`DecisionRail.tsx:586`), touching no approval row, no
MCP child and no engine. It is the one surface that still works in precisely the state the card
failed in.

Read structurally, (b) *is* the "re-observe committed rows" design (a) was groping toward — only
evaluated at read time rather than on a clock. A clock fires while nobody is watching and produces
nothing; the read fires when a person opens a window, which is the only moment an answer can be
given. It also costs no migration, no new wake status and no new wake event, so it trips none of
the census suites those would.

**The cost of (b), stated rather than hidden.** A2 does not delete the rail. The motivation for the
change was the rail's fan-out — S open sessions × T pending rows × (2 + C) statements every 20s —
and keeping it as the fallback keeps that read alive. The fan-out must therefore be reduced by
narrowing *who the rail is read for*, not by removing it. That narrowing is a separate decision and
is not made here.

**What this binds the implementation to.** The card is the primary surface, the rail is the
fallback, and answering either settles the row because there is only one door: a single
`TaskCompletionEvidenceService.decide` (`task-completion-evidence.service.ts:623`), which the
runner protocol reaches deliberately rather than by accident — "The app reaches the same service at
`POST /tasks/:taskId/evidence/decision`… and that named session is put through the identical check,
so the account owner gets the same door rather than a shorter one"
(`runner-task-completion-evidence.controller.ts:41-49`). The fallback therefore needs no second
write path, and cannot drift from the card's. The fallback spec must submit evidence, deliver the
turn, never answer, and assert the row is still returned by `readPendingEvidenceJudgments` for an
independent session — paired with a negative control on the
same fixture where a recorded decision returns zero rows, because a bare "still visible" assertion
is also true of a read that filters nothing. And a stale `PENDING` approval must stop presenting
itself as the live question.

### D2 — one bounded question is not a conversation steered three hundred times

The history this has to answer to is `coordinator-judgment.service.ts:13-25` (§0), whose second
paragraph (`:15-19`) is the accident itself: the version removed on 2026-08-24 "failed because ONE
conversation was steered three hundred times: every turn looked busy, the context filled with its
own earlier reasoning, and it never crossed a single line in `attempt-budget.ts` §0 — there was no
line to cross, because a budget is spent per attempt and the whole thing was one attempt that never
ended."

Three things had to be true at once for that: the next turn was justified by the previous turn's
output; the budget's unit was the attempt and the attempt never ended, so no bound could bind; and
each turn's judgment formed on accumulated reasoning rather than on the database. A2 breaks the
first two structurally and bounds the third.

1. **The justification lives outside the conversation.** A turn exists because
   `COMPLETION_EVIDENCE_REVISED` was committed at `task-completion-evidence.service.ts:379-393`,
   keyed `(revision, criterionRevision, evidenceDigest)`, and 0174's partial unique index picks one
   winner per key. The coordinator cannot manufacture its own next turn: it may not submit evidence
   on a task it judges (`decidingSessionDisqualification`, `pending-evidence-judgments.ts:249`), and
   the wake it was delivered is already holding its key (`coordinator-wake.ts:133`), so one revision
   cannot be delivered twice. Turn count is bounded by evidence revisions somebody else chose to
   submit. The 300-steer loop's next turn came from itself; this one's cannot.
2. **The turn has a terminus written into its shape.** Not "drive this project" but "ask one
   question, record the answer, stop". The terminus is a row — a `TaskCompletionEvidenceDecision` —
   and writing it is what removes the question from the pending read
   (`pending-evidence-judgments.ts:247`). A turn whose completion is defined by a row it writes has
   an end; a turn defined by "make progress" does not. The carrier reinforces it: this is a
   NEXT_TURN message, not a steer — "A message is a notification, never an interrupt. Claude does
   not steer mid-turn: a conversation that is running a turn sees this after that turn ends"
   (`coordinator-delivery.service.ts:42-44`). Extending a running turn is the literal act the
   accident consisted of, and nothing here does it.
3. **What continues is a person's attention, not an agent's decision to keep going.**
   `coordinator-judgment.service.ts:27-33` (§1) draws the line A2 must respect, in its own words
   at `:30`: `project.coordinator_session_id` is "a person opening a long-lived conversation to
   drive a project by hand". A2 does not move judgment into the steered loop's role; it puts one
   question into a conversation the person already has open, and the party being asked *is* the
   person. The unbounded quantity in the accident was an agent's own choice to continue. Here the
   agent's part is one bounded turn per committed fact.

**The residual, named rather than waved away.** The coordinator conversation is long-lived, so its
context does accumulate: §0's first named loss, "judgment quality decays with context noise", is the
one A2 genuinely inherits. Two bounds hold it. The turn's prompt is built from committed rows rather
than from the transcript — which is what the pending read was built for, every row carrying the
criterion, the claim, the declared gaps and what each citation resolved to, so that "The decider is
meant to be able to decide from the row" (`pending-evidence-judgments.ts:41`) — and a turn that
reads the row needs none of the previous turn's reasoning, which keeps the decision replayable. And
the window is finite and spent per message: one coordinator conversation measured 365 turns and 481k
of a 1000k window on 2026-09-06 (`coordinator-delivery.service.ts:45-48`), which is why only a fact
with an action attached earns one. An evidence revision awaiting a human decision has an action
attached.

**How we would know the boundary leaked.** The turns a coordinator session runs must not exceed its
human-authored turns plus the distinct `COMPLETION_EVIDENCE_REVISED` wakes bound to it. If they ever
do, something is generating turns from turns and claim 1 above is false.

### Comment drafts for the implementation files

To be pasted by the tasks that touch these files; not applied by the review task that wrote them.

`task-completion-evidence.service.ts`, replacing the "Nothing derives a judgment request from this
fact any more" note at the `route(...)` call (lines 389-391):

> The evidence revision is delivered to the project's standing coordinator conversation, which asks
> a person and records their answer. Nothing is derived here and no session is opened: the wake ends
> `DELIVERED`, and the reason the carrier is a message rather than a fresh judgment session is
> `coordinator-delivery.service.ts` §0 — this fact wants the conversation a person already has open,
> not continuity of reasoning. The stored consumer label is unchanged because it is what these rows
> have always said.

`coordinator-delivery.service.ts`, a new paragraph under §1.3:

> §1.4 — AND AN UNANSWERED QUESTION IS NOT A FAILED DELIVERY. §3 releases the key for a delivery
> that could not be MADE. A delivery that was made, asked a person, and got no answer before the
> engine abandoned the tool call is not that: the message arrived, the wake is `DELIVERED`, and the
> key stays held. Nothing here retries it and nothing should — the timeout is the engine's
> (`runner-go/mcp.go:1170` polls uncapped; `approval` has no expiry), so "it timed out" is not a
> committed fact, and re-deriving it would ask an absent person again on a clock this path does not
> have (`completion-input-router.service.ts:66`). What catches it is
> `readPendingEvidenceJudgments`, which recomputes the question from the same rows whenever a person
> next opens a window. The card is the delivery; the rail is the floor under it.

`pending-evidence-judgments.ts`, appended to the "A DERIVED READ, NOT A QUEUE" section:

> This is also the FALLBACK under the coordinator card. A card can be asked and never answered —
> the engine abandons `AskUserQuestion` after 1800s and writes nothing anywhere — and the wake that
> delivered it is spent and holds its key. Because pending is a shape the rows already have rather
> than a row somebody wrote, an unanswered question is still here on the next read, and the answer
> written from here (`POST /tasks/:id/evidence/decision`) needs no live turn to receive it. Removing
> this read would make a missed card permanent silence.

