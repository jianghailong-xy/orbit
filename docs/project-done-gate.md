# Project DONE: derived facts and the owner's record

This is the live description of both paths to project `DONE`. The projection records what the
facts prove (`done_by = DERIVED`); the account owner can also record a decision with accepted gaps
(`done_by = OWNER`). A coordinator can request that decision, but cannot make it for the owner.
The implementation is in `project-done-derived.ts`, `project-done-request.ts`,
`project-open-item.service.ts` and `project-acceptance.service.ts`, under
`src/apiserver/src/projects/`.

## Derived DONE

`readDerivedProjectDone` reads the same satisfaction and landing answers that `project_get`
serves (`project-criterion-satisfaction.ts` and `project-criterion-landing.ts`). It derives DONE
only when there is at least one stated criterion and both inputs hold:

- Every criterion is satisfied and its landing is `LANDED`. Work on the project's integration
  branch alone is `ON_INTEGRATION_LINE`, not upstream landing. Tasks with nothing to land do not
  hold back other serving work's landing; that does not make a criterion with no landing evidence
  automatically landed. See [the integration-line contract](project-integration-line-contract.md).
- The owner's standard-set confirmation stands for today's criteria, compared by their semantic
  version. Changing an assertion or verification method retires the old confirmation.

Criteria are authored as `acceptanceCriteriaItems` through `project_update`; tasks name the
criterion they serve through `criterion_definition_id`. Satisfaction comes from those tasks'
completion criteria and checks, not from an additional project acceptance run.

`storeDerivedProjectStatus` stores that reading after standard-set confirmation, task writes,
completion-evidence decisions, merge receipts and criteria writes. These post-commit refreshes
read committed facts; a merge receipt is an edge that changes landing, not a third input.
The projection moves between OPEN and DONE in both directions: reopening serving work, adding
unsettled work against a criterion, or changing the criteria can take derived DONE away.
It never writes or overwrites CANCELLED.

A derived record stores `doneBy`, `doneAt`, `doneCriteriaDigest` and empty `acceptedGaps`.
The conditional write protects a concurrent owner decision and makes concurrent derivations
write the transition once. When the projection actually writes OPEN to DONE, it sends the account
owner one project-done push. A re-derivation that writes nothing sends none; an owner-recorded
DONE sends none. Push delivery is best effort and a failure is logged. The DERIVED receipt card
names when the owner confirmed the criteria and offers **Reopen project**; automatic completion
does not require another owner confirmation.

## The owner's record and DONE_REQUEST

Only the project's coordinator conversation may call `project_request_done`, and the project
must be OPEN. It supplies a short judgment and criterion-linked gaps. Each gap requires
`whyNotProven` (why Orbit cannot prove the criterion), `coordinatorChecked` (what the coordinator
checked instead) and `evidenceRefs` (1 to 20 evidence references). Only the gap title is optional.

Before filing anything, `readDoneState` and `doneReadiness` collect all findings:

- `REFUSE`: no criteria, an unsatisfied criterion, tasks running or queued or IN_PROGRESS, open
  owner items, or a landing/merge into main queued or running. The asking conversation's own run
  does not count as work in flight. `DONE_REQUEST_NOT_READY` (409) returns the findings and files
  nothing.
- `WARN`: each criterion not LANDED, with its reason and next action. These warnings accompany
  the request, including when no supplied gap names the criterion.

At most one `DONE_REQUEST` is open per project. An identical request reuses it; a different new
request supersedes the old one. The owner-facing **Is this project done?** card carries the
coordinator's judgment, gaps and warnings, with **Record as done** and **Not yet…** actions.

**Record as done** calls `POST /projects/:id/done`. The owner supplies the current criteria digest,
accepted gaps and, when answering a card, its request id. The server locks the project and request,
refuses a request that is no longer open or whose criteria/work have moved, and atomically records
DONE and resolves the request APPROVED. The record stores `done_by = OWNER`, the time, criteria
digest, accepted gaps and the serving tasks' lifecycle epochs (`done_task_epochs`). It replaces any
previous Reopen press. A CANCELLED project must be reopened first.

**Not yet…** requires the owner's note, resolves the request DECLINED and tells the coordinator
what is missing, retaining the judgment, gaps and warnings. A new request with the same criteria
digest and state digest as the latest decline is refused with
`DONE_REQUEST_UNCHANGED_SINCE_DECLINE` (409), with nothing filed. Rewording the judgment or gaps
alone does not count as changed work; after the work changes, the ordinary readiness check still
has to pass.

The owner can also record DONE without a coordinator request (`requestId: null`). The done-check
reader returns the same refusals and warnings for the clients' card. On recording, the server
recomputes them and appends every finding to `acceptedGaps`, even a REFUSE finding: these findings
block a coordinator's request, not the owner's decision. Each stored entry retains the full
finding and uses its criterion key, or the reserved `project:<id>` anchor with PROJECT scope for a
project-wide finding. The response returns those accepted gaps. Any open done request is answered
by this record too. Recording does not silently turn an unproved criterion into a proved one.

## What takes a DONE record back

| Record | What the next derivation does |
| --- | --- |
| DERIVED | Tracks the current satisfaction, landing and standing confirmation; losing any required input returns the project to OPEN. |
| OWNER | Keeps the owner's accepted-gap decision until the criteria digest changes or a serving task is reopened after the record. Ordinary re-derivation does not erase it merely because a gap remains. |

For OWNER records, reopening is detected by comparing current lifecycle epochs with the counters
captured at record time, not by comparing `doneAt` with `epoch_started_at`. The task epoch advances
when terminal DONE, CANCELLED or FAILED work returns to OPEN or IN_PROGRESS. This catches a reopen
transaction that started before the record and committed afterward, and a task reopened and
finished again before derivation. A newly serving task absent from the snapshot counts if it is
nonterminal. Legacy records without an epoch snapshot retain the timestamp fallback.

When one of these facts invalidates an OWNER record, derivation writes OPEN, or DERIVED DONE if
the facts now prove completion themselves. If it reopens the project, the coordinator receives the
reason (criteria changed or serving task reopened).

## The owner's Reopen press (0469)

Migration `0469` introduced `project.reopened_at` and `reopened_facts`. A signed-in owner's
`PATCH /projects/:id` taking the project out of DONE with `status=OPEN` and a LOGIN credential
records the press through `ProjectsService.reopenRecord` / `reopenRecordOfPress`. A session, token
or runner call is not this press and cannot establish its hold; owner-channel credential and
session-write restrictions still apply.

The press keeps stored status OPEN while the criteria seal and the recorded facts of serving work
stand. Those facts include task status and lifecycle epoch, evidence revisions and decisions,
verdicts and concluded checks, and landing receipts. A rename or progress report does not end it;
neither does work serving no criterion. Merely changing which criterion a task serves, removing a
serving task or attaching already-finished old work is not itself a new fact that ends the hold.
Newly serving work is compared using its dated facts when it has no recorded digest.

`derivedDone` continues to report what the facts prove even while stored status is OPEN. Lists and
the settled-project task-writing rule read stored status, so work can be filed after Reopen. Once
the recorded facts change, automatic DONE can resume if its inputs hold. The coordinator can also
request DONE while the press stands; the owner's new record ends it.

## Requests that go stale and the state digest

`refreshProjectDone` reconciles stale requests on the same post-commit write edges as derivation,
including task writes and merge receipts. If the project is no longer OPEN, its criteria changed,
or its state digest moved, the open request becomes SUPERSEDED with a stored reason and the
coordinator receives a turn naming why. It stops contributing **Ready to close** to the list;
clients retain the stale-request row rather than presenting an actionable old card. Open-items
reads also repair a missed best-effort refresh, and the owner's record endpoint checks freshness
again. The write edge is the normal reconciliation path, not a later page visit.

`doneStateDigest` (version 2) hashes sorted facts only:

- tasks serving a criterion: id, status, criterion id and running/queued state;
- each criterion's id, satisfaction, landing and landing reason;
- in-flight landing jobs: id and state.

The criteria seal is compared separately. A task serving no criterion moving does not change this
digest or supersede the request. This narrower digest is distinct from readiness: the preflight
still checks all project tasks for work in flight and checks owner items. It is also distinct from
the richer serving-work facts captured by a Reopen press.

## Historical note: 0229

On the owner's 2026-09-03 decision, `0229_project_acceptance_judgment_removal` removed the old
project acceptance trigger, application gate, acceptance runs and verdict tables. The later
projection was separately authorized; neither path above restores that old machine. Requests
carrying an acting session still cannot write project status (`PROJECT_STATUS_NOT_SESSION_WRITABLE`).
The surviving merge-evidence history is a record, not the old acceptance evaluator.
