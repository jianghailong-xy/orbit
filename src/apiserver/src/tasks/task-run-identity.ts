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
 * `TASK_RUN_TRIGGER`): the appointment being kept, the moment the task became READY, or the one run
 * a freshly filed task exists for — each stamped with the monotone `task_dispatch_epoch` it was read
 * under. Those are properties of committed rows, so two passes over the same moment name the same
 * request, and two different moments never name the same one.
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
 *    hands the second moment the first moment's receipt, and it never runs.
 *
 * `task_dispatch_epoch` (0137, advanced in one canonical batch since 0154) and §7.7 D5-b4's
 * transition table are what make that impossible: the counter advances once per statement that
 * creates a moment at which an automatic door may legitimately start this task's work, and it only
 * ever goes up. Two passes over the same moment read the same epoch off a committed row — on two
 * replicas, before and after a restart — which is the half that makes a redelivered pass ONE
 * request; and a moment that has passed can never be re-entered, which is the half that lets an
 * automatic stand-down FREEZE its answer instead of leaving the request open for ever.
 *
 * The epoch each token carries is the one that door's own candidate scan OBSERVED, not the one the
 * dispatch finds. That is the point: `execute` compares them, and a delivery whose moment has since
 * been overtaken is answered as stale rather than allowed to start work for a moment that is gone.
 */
export const TASK_RUN_TRIGGER = {
  /**
   * The appointment being kept, at the epoch the sweep read it under.
   *
   * `run_at` is consumed back to NULL by the dispatch that keeps it, so two passes over one due row
   * are one dispatch — and the consumption itself advances the epoch, so the NEXT appointment on
   * this task is a different name that this one can never be replayed into. That is what makes
   * 09:00 -> 10:00 -> 09:00 two requests: the second 09:00 is epoch+2, not epoch.
   */
  scheduled: (taskId: string, epoch: bigint | number | string): string =>
    `sched:${taskId}:${epoch}`,
  /**
   * The moment this task became READY, at the epoch the unlock was read under.
   *
   * Keyed on the epoch rather than on `task_dependency_revision` (0132), which is what H2F carried:
   * the edge set does not change while a prerequisite goes DONE -> reopened -> DONE, nor while this
   * task itself goes DONE -> reopened, so the revision cannot see the second legitimate READY
   * transition and the second one was answered with the first one's Session. The epoch covers the
   * revision's whole trigger surface and the status surface besides — §7.7 D5-b4(3) — so the token
   * needs one number rather than two. 0132's table is untouched: it is the dispatch decision's
   * LOCK, not a name.
   */
  dependency: (taskId: string, epoch: bigint | number | string): string =>
    `dep:${taskId}:${epoch}`,
  /**
   * A task that was created in order to be run once, and immediately — the verification filer and
   * the foreman. Its id is the durable fact: a retry of the creation makes a different task, so
   * "the first run of THIS task" names one request for as long as the row exists.
   *
   * It carries the epoch too, for the uniformity the receipt's key is read under rather than for a
   * race: a freshly filed task is at the epoch its seed trigger gave it and nothing has moved it,
   * so this is that epoch. A task that were ever filed for a first run a second time — reopened,
   * re-dispatched — would be at a later one, and would be a new command rather than a replay of the
   * first filing's answer.
   */
  firstRun: (taskId: string, epoch: bigint | number | string): string =>
    `first-run:${taskId}:${epoch}`,
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
