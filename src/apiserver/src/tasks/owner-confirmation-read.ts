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
 * decision answers yet. A request is recorded when a run of the task ends a turn successfully, so a
 * send-back — which answers the request it was sent about — takes the task out of waiting until the
 * next successful turn records the next one. Nothing here is a queue: every read recomputes it.
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
 * Record that a run of this task ended a turn successfully and so asks its owner.
 *
 * Called by `runnerApi.turnComplete` in the transaction that acknowledges the turn, under that
 * session's row lock, only for a SUCCEEDED message turn of an unsettled OWNER_CONFIRMED task. One
 * row per turn (`task_owner_confirmation_request_turn_key`); the acknowledgement it rides on is
 * already idempotent, so a retried completion never reaches this twice.
 */
export async function recordOwnerConfirmationRequest(
  tx: PrismaTypes.TransactionClient,
  request: { taskId: string; ownerId: string; sessionId: string; turnId: string },
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
