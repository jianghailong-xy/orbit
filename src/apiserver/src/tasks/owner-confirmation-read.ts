import { TaskStatus } from '@prisma/client';
import type { CreatorType, Prisma as PrismaTypes } from '@prisma/client';
import { RunEventType } from '@orbit/shared';
import type { TaskCompletionCriterionValue } from './task-completion-criterion';
import {
  OWNER_CONFIRMATION_UNSETTLED_STATUSES,
  type OwnerDecisionValue,
  waitingOwnerConfirmation,
} from './task-owner-confirmation';

/**
 * The OWNER_CONFIRMED rows, read and written with a transaction client and nothing else.
 *
 * Kept apart from `TaskOwnerConfirmationService` because three places outside it need the same
 * facts: `runnerApi.turnComplete` records the question, the session list counts it
 * (`owner-decision-signal.ts`), and the door decides it. None of them may import a service that
 * imports the sessions module back, and none of them may hold a second opinion about what is
 * waiting — so the one definition lives here.
 *
 * WHAT "WAITING" IS
 * -----------------
 * A task that declares OWNER_CONFIRMED and has not settled, whose newest confirmation request no
 * decision answers yet. A request is recorded when a run of the task both DECLARED the work
 * finished (`recordOwnerConfirmationClaim` below — the agent's own statement, and the only thing
 * that asks at all) AND has stopped working (`runStoppedWorking` below), so a send-back — which
 * answers the request it was sent about — takes the task out of waiting until the agent declares
 * again after the next turn that carries the work forward. Nothing here is a queue: every read
 * recomputes it.
 */

const UNSETTLED: TaskStatus[] = OWNER_CONFIRMATION_UNSETTLED_STATUSES.map((status) => TaskStatus[status]);

/** What a run said when it ended the turn the owner is asked about: its last assistant message. */
export interface OwnerConfirmationReport {
  text: string;
  reportedAt: Date;
}

/** The question in front of the owner now. */
export interface OwnerConfirmationWaiting {
  requestId: string;
  /** The session whose run reported, where the card is drawn and a send-back is delivered. */
  sessionId: string;
  requestedAt: Date;
  report: OwnerConfirmationReport | null;
}

/** One decision the owner recorded, as its receipt draws it. */
export interface RecordedOwnerDecision {
  id: string;
  decision: OwnerDecisionValue;
  note: string | null;
  decidedAt: Date;
  decidedByType: CreatorType;
  /** The request it answered; null for a confirmation pressed while no run was waiting. */
  requestId: string | null;
  /** The session the answered run reported in, where the receipt is drawn; null with `requestId`. */
  sessionId: string | null;
  /** What that run had reported, so a receipt can say what settled it. */
  report: OwnerConfirmationReport | null;
}

/** `GET /tasks/:taskId/owner-confirmation`. */
export interface OwnerConfirmationView {
  taskId: string;
  title: string;
  status: TaskStatus;
  projectId: string | null;
  completionCriterion: TaskCompletionCriterionValue;
  /** What settles the task, in its own words. */
  acceptanceCriteria: string | null;
  /** Null unless the task declares OWNER_CONFIRMED, has not settled, and a run is waiting on it. */
  waiting: OwnerConfirmationWaiting | null;
  /** Every decision recorded about this task, oldest first. */
  decisions: RecordedOwnerDecision[];
}

/**
 * Record that a run of this task declared its work finished — the statement `task_request_confirmation`
 * is, and the only thing that ever asks the owner.
 *
 * Called by `TaskOwnerConfirmationService.claim` under the task's row lock, for a declaration made
 * from the task's own execution session while one of its turns is in flight. One row per turn
 * (`task_owner_confirmation_claim_turn_key`), so a retried tool call declares once. Nothing is
 * concluded and nothing is asked yet: the question waits for the completion that leaves the run with
 * nothing to do.
 */
export async function recordOwnerConfirmationClaim(
  tx: PrismaTypes.TransactionClient,
  claim: { taskId: string; ownerId: string; sessionId: string; turnId: string },
): Promise<{ id: string; claimedAt: Date }> {
  return tx.taskOwnerConfirmationClaim.create({
    data: claim,
    select: { id: true, claimedAt: true },
  });
}

/** The claim this declaration already is, when a retried call arrives under the same turn. */
export function ownerConfirmationClaimForTurn(
  tx: PrismaTypes.TransactionClient,
  sessionId: string,
  turnId: string,
) {
  return tx.taskOwnerConfirmationClaim.findUnique({
    where: { sessionId_turnId: { sessionId, turnId } },
    select: { id: true, claimedAt: true },
  });
}

/**
 * The newest declaration by this session that no question has been asked from yet — "this run says
 * it is done, and the owner has not been told" — or null.
 *
 * Spent is a fact rather than a state: a claim a `task_owner_confirmation_request` names has been
 * asked, and one claim buys one question (`task_owner_confirmation_request_claim_key`). So an agent
 * that declared, was asked, and was sent back with more work must declare again before the next
 * question — which is the whole point of asking on a declaration instead of on a pause.
 *
 * Scoped to the declaring session, deliberately: the declaration is that run's statement, and the
 * question is put where that run's report is. A run whose session ended before its claim was spent
 * takes the claim with it; a later run of the same task declares for itself.
 */
export async function unspentOwnerConfirmationClaim(
  tx: PrismaTypes.TransactionClient,
  sessionId: string,
): Promise<{ id: string; turnId: string } | null> {
  const claim = await tx.taskOwnerConfirmationClaim.findFirst({
    where: { sessionId, requests: { none: {} } },
    orderBy: [{ claimedAt: 'desc' }, { id: 'desc' }],
    select: { id: true, turnId: true },
  });
  return claim ?? null;
}

/**
 * Whether a run that completed a turn has stopped working — the completion a declaration is answered
 * on.
 *
 * ASKED AT THE END OF THE RUN, NOT AT THE END OF EVERY TURN. A task's run ends many turns, and only
 * the last one leaves the run with nothing to do: the queue hands it the next message, a `bg_run`
 * job it started wakes it when the job ends or writes, a sub-workspace it launched reports back, and
 * a wake-up it scheduled for itself comes due. A completion with any of those behind it is not the
 * place to put the question — declaring says "the work is finished", and the owner should read that
 * about the last word the run has, not about a turn it went on past.
 *
 * WHY `runningBgShells` IS NOT READ. It answers "is a process still up", which a dev server the
 * workspace deliberately left running answers forever — the schema keeps the two sets apart for
 * exactly this question, and `runningBgJobs` is the one that means work in flight. An engine's own
 * `Bash run_in_background`/`Monitor` shell carries no kind, so nothing distinguishes it from a
 * watcher, and guessing one way would silence the question for the life of a dev server.
 *
 * `pendingExecutableTurns` is the count the caller's own park decision uses — computed after the
 * requeues a completion performs, so a follow-up that arrived while the turn was running counts.
 * `wakeupWaiting` is `waitingScheduledWakeup` below; it is passed in because it is the one fact of
 * the three that is not already on the session row, and the caller reads it only where the rest of
 * the gate says the question could be asked at all.
 */
export function runStoppedWorking(
  session: {
    runningBgJobs: readonly string[];
    runningSubagents: readonly string[];
  },
  pendingExecutableTurns: number,
  wakeupWaiting: boolean,
): boolean {
  return (
    pendingExecutableTurns === 0
    && session.runningBgJobs.length === 0
    && session.runningSubagents.length === 0
    && !wakeupWaiting
  );
}

/**
 * Whether this session has a wake-up it asked for still waiting — the run coming back by itself,
 * which is why it counts as work in flight. One can be waiting at most, so this is a lookup by the
 * partial unique key, and PENDING is the only state a live wake-up is in.
 */
export async function waitingScheduledWakeup(
  tx: PrismaTypes.TransactionClient,
  sessionId: string,
): Promise<boolean> {
  const waiting = await tx.sessionScheduledWakeup.findFirst({
    where: { sessionId, state: 'PENDING' },
    select: { id: true },
  });
  return waiting != null;
}

/**
 * Record that a run of this task declared the work finished and has now stopped working, so its
 * owner is asked.
 *
 * Called by `runnerApi.turnComplete` in the transaction that acknowledges the turn, under that
 * session's row lock, only for a SUCCEEDED message turn of an unsettled OWNER_CONFIRMED task whose
 * run has stopped working (`runStoppedWorking`) and that has a declaration nobody has been asked
 * about yet (`unspentOwnerConfirmationClaim`) — the claim is what makes the question a statement by
 * the run rather than an inference from its silence. One row per turn
 * (`task_owner_confirmation_request_turn_key`) and one row per claim
 * (`task_owner_confirmation_request_claim_key`); the acknowledgement it rides on is already
 * idempotent, so a retried completion never reaches this twice.
 */
export async function recordOwnerConfirmationRequest(
  tx: PrismaTypes.TransactionClient,
  request: { taskId: string; ownerId: string; sessionId: string; turnId: string; claimId: string },
): Promise<void> {
  await tx.taskOwnerConfirmationRequest.create({ data: request, select: { id: true } });
}

/** The task's newest request, with whether a decision answers it. */
export function latestOwnerConfirmationRequest(tx: PrismaTypes.TransactionClient, taskId: string) {
  return tx.taskOwnerConfirmationRequest.findFirst({
    where: { taskId },
    orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      sessionId: true,
      turnId: true,
      requestedAt: true,
      decisions: { select: { id: true }, take: 1 },
    },
  });
}

/**
 * The last thing the run said in the turn a request is about.
 *
 * Read from the run's own `assistant` events rather than the session's `lastAssistantText`, which a
 * later turn overwrites: a receipt drawn a week later still says what the owner was shown.
 */
export async function ownerConfirmationReport(
  tx: PrismaTypes.TransactionClient,
  request: { sessionId: string; turnId: string },
): Promise<OwnerConfirmationReport | null> {
  const events = await tx.runEvent.findMany({
    where: { sessionId: request.sessionId, turnId: request.turnId, type: RunEventType.ASSISTANT },
    orderBy: { seq: 'desc' },
    take: 20,
    select: { payload: true, createdAt: true },
  });
  for (const event of events) {
    const text = (event.payload as { text?: unknown } | null)?.text;
    if (typeof text === 'string' && text.trim() !== '') {
      return { text: text.trim(), reportedAt: event.createdAt };
    }
  }
  return null;
}

/** The whole confirmation state of one task, or null when this owner has no such task. */
export async function readOwnerConfirmation(
  tx: PrismaTypes.TransactionClient,
  ownerId: string,
  taskId: string,
): Promise<OwnerConfirmationView | null> {
  const task = await tx.task.findFirst({
    where: { id: taskId, ownerId },
    select: {
      id: true,
      title: true,
      status: true,
      projectId: true,
      completionCriterion: true,
      acceptanceCriteria: true,
    },
  });
  if (!task) return null;
  const latest = await latestOwnerConfirmationRequest(tx, taskId);
  const asked = task.completionCriterion === 'OWNER_CONFIRMED' && UNSETTLED.includes(task.status)
    ? waitingOwnerConfirmation({
      latestRequest: latest && {
        id: latest.id,
        sessionId: latest.sessionId,
        decided: latest.decisions.length > 0,
      },
    })
    : null;
  const recorded = await tx.taskOwnerDecision.findMany({
    where: { taskId, ownerId },
    orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      decision: true,
      note: true,
      decidedAt: true,
      decidedByType: true,
      requestId: true,
      request: { select: { sessionId: true, turnId: true } },
    },
  });
  const decisions: RecordedOwnerDecision[] = [];
  for (const row of recorded) {
    decisions.push({
      id: row.id,
      decision: row.decision,
      note: row.note,
      decidedAt: row.decidedAt,
      decidedByType: row.decidedByType,
      requestId: row.requestId,
      sessionId: row.request?.sessionId ?? null,
      report: row.request ? await ownerConfirmationReport(tx, row.request) : null,
    });
  }
  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    projectId: task.projectId,
    completionCriterion: task.completionCriterion as TaskCompletionCriterionValue,
    acceptanceCriteria: task.acceptanceCriteria,
    waiting: asked && latest
      ? {
        requestId: asked.requestId,
        sessionId: asked.sessionId,
        requestedAt: latest.requestedAt,
        report: await ownerConfirmationReport(tx, latest),
      }
      : null,
    decisions,
  };
}

/** One task session an owner confirmation is waiting on: the "where" of the list's signal. */
export interface WaitingOwnerConfirmation {
  sessionId: string;
  taskId: string;
  projectId: string | null;
  requestedAt: Date;
}

/**
 * Every OPEN conversation an owner confirmation is waiting on — the task's own session, whatever
 * project the task is filed under, including none.
 *
 * `sessionIds` narrows it to a page of the session list. Only a task's NEWEST request is a question:
 * an older one a later report replaced is not waiting on anybody, even when the page holds only the
 * older one's session. And only an Open-scope conversation is returned, for the reason the
 * coordinator badge has — a signal says "go here now", and here cannot be a conversation the owner
 * filed away or put in Trash. The question itself is still on the task's own read.
 */
export async function readWaitingOwnerConfirmations(
  tx: PrismaTypes.TransactionClient,
  ownerId: string,
  scope?: { sessionIds?: readonly string[] },
): Promise<WaitingOwnerConfirmation[]> {
  const sessionIds = scope?.sessionIds;
  if (sessionIds && sessionIds.length === 0) return [];
  const candidates = await tx.taskOwnerConfirmationRequest.findMany({
    where: {
      ownerId,
      ...(sessionIds ? { sessionId: { in: [...sessionIds] } } : {}),
      decisions: { none: {} },
      task: { completionCriterion: 'OWNER_CONFIRMED', status: { in: UNSETTLED } },
    },
    select: {
      id: true,
      taskId: true,
      sessionId: true,
      requestedAt: true,
      task: { select: { projectId: true } },
    },
  });
  if (candidates.length === 0) return [];
  const newest = new Set<string>();
  for (const taskId of new Set(candidates.map((candidate) => candidate.taskId))) {
    const latest = await latestOwnerConfirmationRequest(tx, taskId);
    if (latest) newest.add(latest.id);
  }
  const current = candidates.filter((candidate) => newest.has(candidate.id));
  if (current.length === 0) return [];
  const open = await tx.session.findMany({
    where: {
      ownerId,
      id: { in: current.map((candidate) => candidate.sessionId) },
      completedAt: null,
      archivedAt: null,
      deletedAt: null,
    },
    select: { id: true },
  });
  const openIds = new Set(open.map((session) => session.id));
  return current
    .filter((candidate) => openIds.has(candidate.sessionId))
    .map((candidate) => ({
      sessionId: candidate.sessionId,
      taskId: candidate.taskId,
      projectId: candidate.task.projectId,
      requestedAt: candidate.requestedAt,
    }));
}
