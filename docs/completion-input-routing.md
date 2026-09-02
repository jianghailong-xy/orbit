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
and the ordinary one-shot task execution machinery; fact routing never steers the Project's
person-opened `coordinator_session_id` conversation.

The N6 exit for the durable open question remains `OPEN_JUDGMENT_REQUEST`: it closes when the
bound N11 request is `DECIDED` or `SUPERSEDED`. Wake rows are delivery receipts, not open blockers,
so they add no second unresolved-signal family.
