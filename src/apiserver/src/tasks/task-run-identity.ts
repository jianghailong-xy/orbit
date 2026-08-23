import { derivedUuid } from '../projects/project-dispatch-identity';

/**
 * What a LEGACY task-run REQUEST is, as a name.
 *
 * The legacy entrances — Run Now, `task_start`, `orbit task start`, the schedule sweep, the
 * dependency sweep, the foreman sweep, a batch — all reach one Session insert, and §7.7 D5's
 * execution claim means two of them arriving together produce one insert and one duplicate-key
 * error. The loser then has to answer the question the error does not: WHICH row won.
 *
 * Before this it SEARCHED: "the newest live Session on this task". Both halves of that move while
 * the lookup is being made, and each moved in a different direction — "newest" hands a request
 * somebody else's run, "live" reports a winner that has already reached `SUCCEEDED`, `FAILED` or
 * `CANCELLED` as ABSENT (and the raw `P2002` then reached the API as a 500), and a winner parked at
 * `AWAITING_INPUT`/`INTERRUPTED` fell out of both and was named to its own caller as somebody
 * ELSE's live claim.
 *
 * So the Session is NAMED instead. Its id is a pure function of the request, which makes it
 * computable without the response, before the row exists and after it has finished; the recovery is
 * then `WHERE id = <this>` with no status, no ordering and no `deleted_at` — the only rule that is
 * the same for all seven statuses a winner can be in.
 *
 * WHAT MAKES TWO CALLS THE SAME REQUEST — and the one thing the server cannot decide for itself.
 * A retry of press A and a fresh press B are the same bytes on the wire. No property of the
 * database tells them apart: not the newest Session, not the live one, and not the set of Sessions
 * the task already has (an insert that commits changes that set, so a replay after a lost response
 * would compute a DIFFERENT name and either be refused or start a second run — which is exactly the
 * bug, moved). The identity therefore has to be CARRIED, and it is: `triggerId`, generated once per
 * press or per tool invocation and reused by every retry of it, exactly as
 * `POST /projects/:id/coordinator/trigger` already does.
 *
 * A caller that sends none gets a server-minted one. That is honest for a first press and buys
 * exactly one thing — two doors racing over one task still collapse onto one run, because each
 * still names its own Session — but it is NOT lost-response idempotency: a token the caller never
 * received is a token it cannot send again.
 *
 * The automatic doors have no press, so each carries the durable fact it is acting on instead (see
 * `TASK_RUN_TRIGGER`): the appointment being kept, the prerequisite revision that unlocked the
 * task, or the one run a freshly filed task exists for. Those are properties of committed rows, so
 * two sweep passes reading the same world name the same request.
 */
export function taskRunRequestKey(request: { taskId: string; requestToken: string }): string {
  return `task-run:v1:${request.taskId}:${request.requestToken}`;
}

/**
 * The id the Session for this request must be created with.
 *
 * Shaped like the Coordinator's `dispatchDesiredSessionId` and derived by the same function, in its
 * own namespace so the two doors can never mint the same id for different work. The cost is the one
 * that unit already documented and paid: the PRIMARY KEY becomes reachable, so the insert's
 * duplicate is no longer proof of anything by itself and the answer is decided by READING — here,
 * `createTaskSessionOrReadWinner`.
 */
export function taskRunDesiredSessionId(requestKey: string): string {
  return derivedUuid(`task-run:v1:session:${requestKey}`);
}

/**
 * The request tokens the AUTOMATIC doors carry, each naming the durable fact that door acted on.
 *
 * SCOPE NOTE. Making these ABA-safe is H2G's unit, not this one: §7.7 D5-b4 writes down the
 * contract and the transition table, and 0137 already ships `task_dispatch_epoch` and its triggers
 * so that unit is a wiring change rather than a migration. What this unit owes is the rule that
 * keeps the gap safe in the meantime — an automatic stand-down releases its receipt instead of
 * freezing it, so a moment that re-derives an earlier name is still evaluated.
 *
 * Every one is `<kind>:<task>:<epoch>`, and all three parts carry weight:
 *
 *  - the KIND separates two doors that can both act at the same epoch;
 *  - the TASK separates two of one owner's tasks — the receipt is keyed `(owner, door, token)`, so
 *    a token that said only "the first run" or "the 09:00 appointment" would be one two tasks
 *    produce identically, and the second task's dispatch would be answered with the first's;
 *  - the EPOCH separates two MOMENTS on one task, and it is a monotone counter rather than the
 *    fact's current value because those values come back. `run_at` 09:00 -> 10:00 -> 09:00 is a
 *    legitimate second appointment; a prerequisite going DONE -> reopened -> DONE is a legitimate
 *    second READY transition under an unchanged edge set. Naming either by what it looks like now
 *    hands the second moment the first moment's receipt, and it never runs. `task_dispatch_epoch`
 *    (0137) and §7.7 D5-b4's transition table are what make that impossible.
 *
 * Two passes over the same moment read the same epoch off a committed row — on two replicas,
 * before and after a restart — which is the half that makes a redelivered pass one request.
 */
export const TASK_RUN_TRIGGER = {
  /**
   * The appointment being kept. `run_at` is consumed back to NULL by the dispatch that keeps it, so
   * two passes over one due row are one dispatch.
   *
   * NOT ABA-safe, and knowingly so: `run_at` can go 09:00 -> 10:00 -> 09:00, and the second 09:00
   * is a legitimate second appointment that re-derives this name. §7.7 D5-b4 fixes that with a
   * monotone `task_dispatch_epoch` (the table and its triggers ship in 0137; wiring these tokens
   * onto it is H2G). Until then the rule that keeps it safe is the one D5-b4(6) states: a
   * stand-down on this door may only RELEASE its receipt, never freeze it, so a second appointment
   * that re-derives the name still evaluates.
   */
  scheduled: (taskId: string, runAt: Date): string => `sched:${taskId}:${runAt.toISOString()}`,
  /**
   * The prerequisite set that unlocked the task, by `task_dependency_revision.revision` (0132).
   *
   * Carries the same limit as `scheduled` and the same interim rule: the edge set does not change
   * while a prerequisite goes DONE -> reopened -> DONE, so the revision cannot see the second
   * legitimate READY transition. H2G re-keys it onto the epoch.
   */
  dependency: (taskId: string, revision: bigint | number | string): string =>
    `dep:${taskId}:${revision}`,
  /**
   * A task that was created in order to be run once, and immediately — the verification filer and
   * the foreman. Its id is the durable fact: a retry of the creation makes a different task, so
   * "the first run of THIS task" names one request for as long as the row exists.
   */
  firstRun: (taskId: string): string => `first-run:${taskId}`,
  /** One press of a bulk Run, scoped to the task inside it that this dispatch is for. */
  batch: (pressToken: string, taskId: string): string => `batch:${pressToken}:${taskId}`,
} as const;

/**
 * The identity of the manual Project trigger this run request records, scoped to one Project.
 *
 * `execute` writes a durable USER signal for the Project a started task belongs to, and that signal
 * used to be named by a `randomUUID()` minted per CALL. So a press whose response was lost recorded
 * a SECOND trigger on replay — the Session was correctly recovered, and the audit and the
 * Coordinator wake were duplicated anyway. The press is the request, so the press names the signal:
 * `project_event_manual_trigger` deduplicates on this id (`project_event_open_dedupe_idx`, unique
 * on `(project_id, dedupe_key)` while unconsumed), which makes the repeat coalesce onto the row the
 * first attempt wrote instead of adding one.
 *
 * Project-scoped rather than one id for the whole press, because a bulk Run can span Projects and
 * the outbox key is per Project: deriving from the pair keeps one signal per Project per press,
 * which is what the original comment here claimed and what a shared random id could not deliver
 * across a retry. A different press derives a different id and is a new trigger, which is the half
 * that must keep working — two deliberate clicks are two requests.
 */
export function taskRunManualTriggerId(requestToken: string, projectId: string): string {
  return derivedUuid(`task-run:v1:manual-trigger:${projectId}:${requestToken}`);
}

/**
 * The turn a run request delivers to a run that is PAUSED, named after the request.
 *
 * `conversation_turn (session_id, client_turn_id)` is unique, so this is what makes the delivery
 * exactly-once: whichever attempt writes it first wins, and every later one — a concurrent
 * duplicate, a redelivered sweep tick, a client retrying a POST it never saw the answer to —
 * collapses onto the same turn instead of putting the task's brief in front of the agent again.
 *
 * It replaces a key derived from the session's own `numTurns`, which is not stable across the very
 * event the delivery causes: the turn gets answered, the count advances, and a repeat of one press
 * derives a different key and delivers a second prompt. The count moves; the press does not.
 *
 * Scoped to the session as well as the press, so one press that reaches two different paused runs —
 * a bulk Run — delivers one turn to each rather than one in total.
 */
export function taskRunResumeTurnId(requestToken: string, sessionId: string): string {
  return `task-run:v1:${sessionId}:${requestToken}`;
}

/**
 * The batch a press's Sessions are tied together by, when the press set a concurrency cap.
 *
 * Derived rather than drawn, for the same reason everything else here is: `randomUUID()` gave every
 * DELIVERY of one press its own batch, so a repeat recognised its own Sessions, reported them as
 * dispatched — and answered with a `batchId` no Session carries. The client then had a cap it could
 * watch that governed nothing, and an empty batch beside the real one.
 *
 * Owner-scoped as well as press-scoped, because the id is a `session.batch_id` this tenant's queue
 * counts live siblings by: two accounts must not be able to name one batch even if a token leaked.
 */
export function taskRunBatchId(ownerId: string, requestToken: string): string {
  return derivedUuid(`task-run:v1:batch:${ownerId}:${requestToken}`);
}
