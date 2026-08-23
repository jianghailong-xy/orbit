import { ConflictException } from '@nestjs/common';

/**
 * The doors a legacy run request can arrive at. One token used at two doors is two requests, so the
 * kind is part of the receipt's key rather than an attribute of it.
 */
export const TASK_RUN_ACTION = {
  execute: 'TASK_EXECUTE',
  batchExecute: 'TASK_BATCH_EXECUTE',
} as const;

/**
 * WHAT THE CALLER ASKED FOR, canonically.
 *
 * A token is a NAME for a request, and a name that could be attached to two different payloads is
 * not one — a client that reuses a `triggerId` for a different task would otherwise be handed the
 * first task's Session and told its second request succeeded. So the receipt stores what was asked
 * and refuses a repeat that disagrees, rather than answering it.
 *
 * The batch form is order-insensitive and duplicate-insensitive on purpose: `[a,b]` and `[b,a,b]`
 * are the same set of tasks to run, `batchExecute` already collapses duplicates, and a client that
 * rebuilt its selection in a different order between two deliveries of one press has not changed
 * its mind. `maxConcurrent` IS part of it — the cap is a property of the press, and it decides the
 * batch every Session in it is admitted under.
 */
export const taskRunFingerprint = {
  execute: (taskId: string): string => `task:${taskId}`,
  batchExecute: (taskIds: readonly string[], maxConcurrent?: number): string =>
    `tasks:${[...new Set(taskIds)].sort().join(',')}|max:${maxConcurrent ?? ''}`,
} as const;

/**
 * WHAT A REQUEST DECIDED TO DO, written down before it does it.
 *
 * Three shapes, and each names the row its effect lands on:
 *
 *  - `ADOPT` — the run this request is asking for already exists and is this request's own. There
 *    is nothing to do, which is also the only thing that can safely be done twice.
 *  - `RESUME` — a paused run gets the task's prompt as a turn. The effect lands on somebody else's
 *    Session, so the TARGET has to be recorded: the token derives the key, but not the session it
 *    goes on, and by the time a crashed attempt is taken over that run may have finished with a
 *    second one opened beside it.
 *  - `CREATE` — a fresh Session under the id the request names.
 */
export type TaskRunPlan =
  | { kind: 'ADOPT'; sessionId: string }
  | { kind: 'RESUME'; sessionId: string; turnId: string }
  | { kind: 'CREATE'; sessionId: string };

/**
 * THE FROZEN COMMAND for a single run — every input its effects need, and nothing that has to be
 * looked up again.
 *
 * A takeover must not re-run the door's gates: prerequisites, the hold, the assignee and its
 * runner, the aggregate and retirement rules, the schedule. Every one of them is mutable, and
 * re-reading them is how a repeat of one press answers something the press never asked. So the
 * holder that DID pass them writes down what it decided WITH, and a takeover applies exactly that.
 *
 * Commit-time database guards still apply and are still obeyed — a supersession that lands between
 * the plan and its application refuses the write, and that refusal is the answer. What a takeover
 * may never do is choose a different plan because the world moved.
 */
export interface TaskRunExecuteTarget {
  v: 1;
  kind: 'RUN';
  plan: TaskRunPlan;
  taskId: string;
  /** The Session title and the prompt, frozen: a retitled task must not change a started run. */
  title: string;
  prompt: string;
  workspaceId: string;
  runnerId: string;
  provider: string | null;
  model: string | null;
  /** The Project this run's durable USER signal belongs to, decided when the press was read. */
  projectId: string | null;
  /** The list-as-batch admission this run was planned under. */
  batch: { id: string; maxConcurrent: number } | null;
  dispatchOrigin: string;
  runSource: string;
  /** The appointment this run keeps, so a takeover consumes the one the press kept. */
  runAt: string | null;
  /** Whether the press was a retry of a FAILED task, so the status flip is the one it planned. */
  clearFailed: boolean;
  /** Automatic doors record no USER trigger, exactly as they did before the receipt existed. */
  auto: boolean;
}

/**
 * One task's place in a bulk Run's plan: where it goes, and everything applying it needs.
 *
 * The same freezing the single door does, per item — a task retitled, re-pinned or reassigned
 * between two deliveries of one press must not change what that press started.
 */
export type TaskRunBatchItemPlan = TaskRunPlan & {
  taskId: string;
  title: string;
  prompt: string;
  workspaceId: string;
  runnerId: string;
  provider: string | null;
  model: string | null;
  runAt: string | null;
  clearFailed: boolean;
  /** The Project this item's durable USER signal belongs to, as the press saw it. */
  projectId: string | null;
};

/** A bulk Run's plan: the batch it admits its Sessions under, and where each task goes. */
export interface TaskRunBatchPlan {
  v: 1;
  kind: 'BATCH';
  batchId: string | null;
  maxConcurrent: number | null;
  items: TaskRunBatchItemPlan[];
  skipped: Array<{ id: string; title: string; reason: string }>;
  runnerIds: string[];
}

/**
 * THE FROZEN COMMAND for a request that is going to write NOTHING, and means it.
 *
 * An automatic door that stands down because the moment it names has passed is not refusing — it is
 * ANSWERING, terminally, and §7.7 D5-b4(6) is why: `task_dispatch_epoch` only goes up, so the moment
 * this token names can never come back and there is nothing a later delivery could usefully
 * re-decide. So the answer is frozen like any other.
 *
 * Which makes it a plan, and it has to be written down as one. 0137's `task_run_request_target_check`
 * says a receipt that is not OPEN has a target — the state and the plan are one fact and cannot
 * disagree — and the reason that constraint exists applies here exactly: a delivery that crashes
 * between deciding "this moment is gone" and freezing that answer leaves a row a takeover has to be
 * able to read. Reading THIS says "carry out the plan: write nothing, answer `reason`", which is
 * the same answer the holder would have given.
 *
 * `observedEpoch` and `currentEpoch` are the evidence rather than the mechanism — nothing re-reads
 * them, and a takeover must not, because they are what the holder saw. They are here so that "why
 * did this appointment never run" has an answer on the row somebody can look at.
 */
export interface TaskRunStandDownTarget {
  v: 1;
  kind: 'STAND_DOWN';
  taskId: string;
  /** The typed answer this request is frozen with. */
  reason: 'stale-epoch';
  /** The moment the delivery was answering, as text — `epoch` is a BIGINT and JSON has no bigint. */
  observedEpoch: string;
  /** The moment the row was actually at when the door read it. */
  currentEpoch: string;
}

/**
 * Everything a receipt's `target` can be, discriminated.
 *
 * A takeover reads this off a row and acts on it, so "what kind of thing is this" cannot be
 * inferred from the shape or assumed from the door: a stand-down frozen by the schedule sweep and a
 * run frozen by Run Now are both `BOUND` receipts, and casting one to the other sends a takeover
 * looking for a task that this request deliberately never touched. An unknown `kind` or `v` is
 * refused rather than guessed — a receipt written by a newer binary is not this one's to finish.
 */
export type TaskRunTargetRecord =
  | TaskRunExecuteTarget
  | TaskRunBatchPlan
  | TaskRunStandDownTarget;

/** A receipt as it comes back off the row. */
export interface TaskRunReceipt {
  fingerprint: string;
  status: 'OPEN' | 'BOUND' | 'COMPLETED';
  target: unknown;
  result: unknown;
}

/**
 * The right to answer one request, as an immutable value.
 *
 * Everything a later write needs to prove it is still the holder travels IN HERE, and nothing is
 * kept in a process: a lease is a fact about a row, and a map keyed by anything less than
 * `(owner, door, token)` collides the moment two owners press Run on their own tasks under the same
 * durable token — `first-run:…`, `dep:…` — while a map at all is invisible to the second replica
 * and to this one after a restart.
 */
export interface TaskRunClaim {
  ownerId: string;
  actionKind: string;
  requestToken: string;
  /** The lease string this delivery wrote, which its own writes are fenced by. */
  leaseHolder: string;
  /** The attempt this lease is, which fences it against a takeover that has since happened. */
  attempt: number;
}

/**
 * The proof a caller hands to the thing that writes the EFFECT.
 *
 * The same five values as the claim, and deliberately a separate name: a claim is what a delivery
 * HOLDS, and this is what it PRESENTS at the write. `SessionsService` takes one and does the write
 * inside a transaction that first locks the receipt row and proves it — so the effect and the right
 * to produce it commit together, rather than the right being checked and then lost.
 */
export type TaskRunEffectFence = TaskRunClaim;

/**
 * The refusal for a delivery that reached the write after losing its lease.
 *
 * Thrown from inside the effect transaction, so nothing it was about to write exists. Not an HTTP
 * shape: the door that catches it answers for it, because "this delivery is no longer the one" is a
 * fact about the request rather than about the task.
 */
export class TaskRunFenceLost extends Error {
  constructor(readonly requestToken: string) {
    super(`the lease on run request ${requestToken} was taken over before this effect committed`);
    this.name = 'TaskRunFenceLost';
  }
}

/** What `leaseRunRequest` hands back: the answer, or the right to produce it. */
export type TaskRunLease =
  /** Already answered. Return this and touch nothing. */
  | { held: false; result: unknown }
  /** This delivery evaluates. The claim fences everything it writes. */
  | { held: true; claim: TaskRunClaim; status: 'OPEN' | 'BOUND'; target: unknown };

/** How long one delivery may hold the right to evaluate a request before it is taken over. */
export const TASK_RUN_LEASE_MS = 60_000;

/**
 * The refusal for "somebody else is answering this exact request right now".
 *
 * Retryable and structured, and NOT the same thing as `TASK_ALREADY_RUNNING`: that one is about the
 * task, this one is about the request. A client that sent the same `triggerId` twice in parallel is
 * told to wait for the answer it is already going to get, rather than being allowed to evaluate a
 * second time and apply a second effect.
 */
export function taskRunInProgress(kind: string, token: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'TASK_RUN_REQUEST_IN_PROGRESS',
    message:
      `this ${kind === TASK_RUN_ACTION.batchExecute ? 'bulk run' : 'run'} request is being ` +
      'answered right now — nothing was changed by this delivery. Ask again with the same ' +
      'triggerId to read the answer',
    owner: 'USER',
    requiredAction: 'retry the same request in a moment',
    triggerId: token,
  });
}

/**
 * The refusal for one token naming two different requests.
 *
 * A 409 rather than a 400: the request is well-formed, and what is wrong is a fact about the
 * server's history that the caller can see once it is told. Named `TASK_RUN_REQUEST_MISMATCH` so a
 * client can tell it from the other 409s this door gives (something else is running) — those mean
 * "wait", this one means "you reused an id".
 */
export function taskRunTokenMismatch(kind: string, token: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'TASK_RUN_REQUEST_MISMATCH',
    message:
      `this ${kind === TASK_RUN_ACTION.batchExecute ? 'bulk run' : 'run'} request id has already ` +
      'been used for a different request, and one id cannot name two — send a new triggerId for a ' +
      'new request, or repeat the original request unchanged to get its answer back',
    owner: 'USER',
    requiredAction: 'use a fresh triggerId for this request',
    triggerId: token,
  });
}

/**
 * The refusal for a receipt this binary cannot finish.
 *
 * A `BOUND` row whose `target` names a kind or a version this code does not know was written by
 * something else — a newer replica mid-deploy, or a shape this one predates. Guessing at it is how
 * a takeover applies the wrong effect; saying so is how a rolling deploy stays safe, because the
 * replica that DOES understand it still holds or will take the lease.
 */
export function taskRunUnreadableTarget(kind: string, token: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'TASK_RUN_REQUEST_UNREADABLE',
    message:
      'this run request was planned by a different version of the server and cannot be finished ' +
      'here — nothing was changed by this delivery. Ask again with the same triggerId',
    owner: 'SYSTEM',
    requiredAction: 'retry the same request; a replica that understands it will answer',
    triggerId: token,
    actionKind: kind,
  });
}

/**
 * The refusal for "something else is already doing this task's work".
 *
 * STRUCTURED, and that is the point. This answer is read by clients — the web Run button, the
 * runner's `task_start`, a script — and until now it was a sentence: a caller that wanted to tell
 * "wait for the run that is going" from "you reused a triggerId" had to parse English. So it
 * carries a stable `code`, the row in the way as a PUBLIC id, and what to do about it.
 *
 * The conflicting Session is Base62 like every other id this API hands out. A raw UUID here would
 * be the one part of a refusal nobody could hand back to `session_get` — and `PublicIdInterceptor`
 * rewrites response FIELDS, not the inside of an exception body somebody assembled by hand.
 */
export function taskAlreadyRunning(context: {
  taskPublicId: string;
  sessionPublicId: string;
  sessionStatus: string;
  /** True when the run in the way belongs to a different agent than the one this request targets. */
  onAnotherAgent?: boolean;
  /** True when that run is on its way to a terminal status rather than doing the work. */
  ending?: boolean;
  /** True when the row holding the claim was opened to look at the task, not to run it. */
  notWork?: boolean;
}): ConflictException {
  const why = context.ending
    ? 'and is ending'
    : context.notWork
      ? 'and is a session opened to look at the task, not run it'
      : context.onAnotherAgent
        ? 'on a different agent'
        : `(${context.sessionStatus})`;
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'TASK_ALREADY_RUNNING',
    message:
      `task ${context.taskPublicId} could not be started: session ${context.sessionPublicId} ` +
      `${why} holds its execution claim. Let that run reach a terminal status of its own, then ` +
      'start the task again',
    owner: 'USER',
    requiredAction:
      'wait for the run that holds this task to reach a terminal status, then start it again',
    taskId: context.taskPublicId,
    conflictingSessionId: context.sessionPublicId,
    conflictingSessionStatus: context.sessionStatus,
    retryable: true,
  });
}

/**
 * The refusal for "this task is pinned to something the run in the way is not on".
 *
 * A separate code from `TASK_ALREADY_RUNNING` because the remedy is different: waiting fixes it,
 * but so does un-pinning, and a client that cannot tell them apart can only offer the first.
 */
export function taskRunPinConflict(context: {
  taskPublicId: string;
  sessionPublicId: string;
  field: 'provider' | 'model';
  pinned: string;
  running: string;
}): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'TASK_RUN_PIN_CONFLICT',
    message:
      `task ${context.taskPublicId} is pinned to ${context.field === 'model' ? 'model ' : ''}` +
      `${context.pinned}, but session ${context.sessionPublicId} holds its execution claim on ` +
      `${context.running}. A running session's ${context.field} is not switched under it; let it ` +
      'reach a terminal status of its own, and the next attempt starts on the pinned one',
    owner: 'USER',
    requiredAction:
      `wait for the run that holds this task to end, or clear the task's ${context.field} pin`,
    taskId: context.taskPublicId,
    conflictingSessionId: context.sessionPublicId,
    pinnedTo: context.pinned,
    runningOn: context.running,
    retryable: true,
  });
}

/** After this many deliveries, an unsettled request says so rather than asking to be repeated. */
export const TASK_RUN_UNSETTLED_ATTEMPTS = 5;

/** How long a caller should wait before repeating a request that did not settle. */
export const TASK_RUN_RETRY_AFTER_SECONDS = 2;

/**
 * The answer for "this request is not finished and nothing about it is decided yet".
 *
 * A bulk Run's answer is a TALLY, and a tally is frozen as this press's answer for ever — so an
 * item that ended in a contended lock, an exhausted retry or a lease taken over is not allowed into
 * one. The Session may be about to commit under a holder that is still writing, and a caller handed
 * `{ ok: false }` about it has no reason to ask again and would be told, on the next delivery, that
 * the same item is running. That is the answer contradicting the artifact.
 *
 * So the whole request answers RETRYABLE instead: a structured 409 the caller can act on, with the
 * receipt left unfrozen and its plan still bound, so repeating the request re-applies exactly what
 * it planned and every item that landed resolves to its own row.
 */
export function taskRunUnsettled(context: {
  actionKind: string;
  requestToken: string;
  /** The tasks whose outcome could not be established, as PUBLIC ids. */
  pendingTaskIds: string[];
  /** How many deliveries of this request have now failed to settle it. */
  attempt: number;
}): ConflictException {
  // BOUNDED, and visible. A request that keeps failing to settle is not one to keep asking about
  // silently: past this many deliveries the caller is told somebody has to look, rather than being
  // left in a retry loop nothing reports.
  const escalate = context.attempt >= TASK_RUN_UNSETTLED_ATTEMPTS;
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'TASK_RUN_REQUEST_UNSETTLED',
    message:
      `this bulk run did not settle: ${context.pendingTaskIds.length} of its tasks are still being ` +
      'written, so no answer for it is final yet. Nothing was decided by this delivery — ' +
      (escalate
        ? `it has now failed to settle ${context.attempt} times, which is no longer an ordinary ` +
          'contention; the runs it names need looking at'
        : 'ask again with the same triggerId and the request continues from where it is'),
    owner: escalate ? 'SYSTEM' : 'USER',
    requiredAction: escalate
      ? 'inspect the runs named below; this request has not settled after repeated deliveries'
      : 'repeat the request with the same triggerId',
    triggerId: context.requestToken,
    pendingTaskIds: context.pendingTaskIds,
    retryable: true,
    retryAfterSeconds: TASK_RUN_RETRY_AFTER_SECONDS,
    attempt: context.attempt,
    escalate,
  });
}
