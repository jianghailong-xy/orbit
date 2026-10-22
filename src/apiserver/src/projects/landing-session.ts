import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import {
  Prisma,
  RunStatus,
  SessionDispatchOrigin,
  SessionRunSource,
} from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';

import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { INTEGRATION_ITEM_KINDS } from './project-open-item';
import { LANDING_PROVIDER_SLUG } from '../providers/provider-slug';

/**
 * The landing subject and the LANDING session it addresses
 * (docs/project-integration-line-contract.md §2.9 LS1–LS3, migration 0436).
 *
 * WHAT A SUBJECT IS. One piece of landing work: a TASK segment (one task's work from DONE until it
 * reaches the line) or a PROMOTION round (one merge of the project branch into the upstream, from
 * the first candidate after the previous round settled until the next MERGED / DECLINED /
 * CANCELLED). Every `project_integration_job` of that work names it through `landing_id`; the
 * subject names the session that will represent it.
 *
 * WHAT ACTIVATES THE INSERT. `ensureLandingSession` is called from the compensation points LS1
 * names, all of them after a claim has committed: the heartbeat's dispatch (when the claim that
 * warrants the row is made), a progress report, a result, and a release that hands a claimed job
 * back. Nothing else calls it, and never a clock or a QUEUED candidate. The engine-path guards and
 * the list/seed exclusions (LS6) are installed in the same delivery as these calls.
 */

const logger = new Logger('LandingSession');

export type LandingSubject = 'TASK' | 'PROMOTION';

export type LandingSettledAs =
  | 'LANDED'
  | 'ALREADY_LANDED'
  | 'NOTHING_TO_LAND'
  | 'MERGED'
  | 'HANDLED'
  | 'DECLINED'
  | 'CANCELLED'
  | 'DELETED';

/** The session title's fixed prefix for a task segment. */
const LAND_TITLE = 'Land';

/** The prompt of a landing session. It is a description, never delivered: nothing claims it. */
const LANDING_PROMPT = 'Orbit runs this landing. This conversation is a record, not an engine.';

/** The states that mean the work reached the line. */
const LANDED_JOB_STATES: ReadonlySet<string> = new Set(['LANDED', 'ALREADY_LANDED', 'NOTHING_TO_LAND']);

/** A settlement that ends the container as SUCCEEDED rather than CANCELLED. */
const SUCCESSFUL_SETTLEMENTS: ReadonlySet<LandingSettledAs> = new Set([
  'LANDED', 'ALREADY_LANDED', 'NOTHING_TO_LAND', 'MERGED',
]);

/** What a database door needs, without dragging the Nest provider into the signature. */
export type LandingDb = Pick<Prisma.TransactionClient, '$transaction'>;

export interface OpenedLanding {
  id: string;
  sessionId: string;
  /** True when this call inserted the row, false when it joined one already open. */
  created: boolean;
}

/**
 * Open a TASK segment for one task, or join the one still open.
 *
 * The partial unique index `project_landing_open_task_key` is what makes this one answer under
 * concurrency: the loser of the race inserts nothing and reads the winner's row back. `episode` is
 * the number of segments this task has already had, plus one, so the second DONE after the first
 * segment settled becomes `(#2)`.
 */
export async function openTaskLanding(
  tx: Prisma.TransactionClient,
  input: { ownerId: string; projectId: string; codebaseId: string; taskId: string },
): Promise<OpenedLanding> {
  const open = await tx.projectLanding.findFirst({
    where: { subject: 'TASK', taskId: input.taskId, settledAt: null },
    select: { id: true, sessionId: true },
  });
  if (open) return { ...open, created: false };

  const previous = await tx.projectLanding.aggregate({
    where: { subject: 'TASK', taskId: input.taskId },
    _max: { episode: true },
  });
  const id = randomUUID();
  const sessionId = randomUUID();
  const [created] = await tx.projectLanding.createManyAndReturn({
    data: [{
      id,
      projectId: input.projectId,
      ownerId: input.ownerId,
      codebaseId: input.codebaseId,
      subject: 'TASK',
      taskId: input.taskId,
      promotionId: null,
      episode: (previous._max.episode ?? 0) + 1,
      sessionId,
    }],
    skipDuplicates: true,
    select: { id: true, sessionId: true },
  });
  if (created) return { ...created, created: true };
  // The partial unique index refused our insert: a concurrent enqueue opened the segment first.
  const raced = await tx.projectLanding.findFirstOrThrow({
    where: { subject: 'TASK', taskId: input.taskId, settledAt: null },
    select: { id: true, sessionId: true },
  });
  return { ...raced, created: false };
}

/**
 * Open a PROMOTION round for a project line, or join the round still open.
 *
 * The round is identified by the FIRST candidate after the previous one settled — that candidate's
 * `promotion_id` is what the returned row carries. Later candidates in the same round (including
 * ones that supersede or resubmit) join it through the partial unique index
 * `project_landing_open_round_key`; the caller never re-derives the round from
 * `project_promotion.task_id`, which always names the last landed task and says nothing about which
 * round a candidate belongs to.
 */
export async function openPromotionRound(
  tx: Prisma.TransactionClient,
  input: { ownerId: string; projectId: string; codebaseId: string; promotionId: string },
): Promise<OpenedLanding> {
  const open = await tx.projectLanding.findFirst({
    where: { subject: 'PROMOTION', projectId: input.projectId, codebaseId: input.codebaseId, settledAt: null },
    select: { id: true, sessionId: true },
  });
  if (open) return { ...open, created: false };

  const previous = await tx.projectLanding.aggregate({
    where: { subject: 'PROMOTION', projectId: input.projectId, codebaseId: input.codebaseId },
    _max: { episode: true },
  });
  const id = randomUUID();
  const sessionId = randomUUID();
  const [created] = await tx.projectLanding.createManyAndReturn({
    data: [{
      id,
      projectId: input.projectId,
      ownerId: input.ownerId,
      codebaseId: input.codebaseId,
      subject: 'PROMOTION',
      taskId: null,
      promotionId: input.promotionId,
      episode: (previous._max.episode ?? 0) + 1,
      sessionId,
    }],
    skipDuplicates: true,
    select: { id: true, sessionId: true },
  });
  if (created) return { ...created, created: true };
  const raced = await tx.projectLanding.findFirstOrThrow({
    where: { subject: 'PROMOTION', projectId: input.projectId, codebaseId: input.codebaseId, settledAt: null },
    select: { id: true, sessionId: true },
  });
  return { ...raced, created: false };
}

/**
 * Undo a subject this same transaction opened when the attempt it was opened for was not written
 * (a duplicate idempotency key or the one-inflight landing index won a race). The row is invisible
 * to every other transaction until this one commits, so nothing can have attached to it.
 */
export async function discardOpenedLanding(
  tx: Prisma.TransactionClient,
  landing: OpenedLanding,
): Promise<void> {
  if (!landing.created) return;
  await tx.projectLanding.deleteMany({ where: { id: landing.id, settledAt: null } });
}

export interface EnsuredLandingSession {
  sessionId: string;
  created: boolean;
}

/**
 * Insert the LANDING session row of one subject, after a claim has committed (LS1).
 *
 * This is the row LS1's table describes, and every value in it has a reader that depends on it:
 *
 *   * `status` is AWAITING_INPUT while the subject is open — never RUNNING (the reaper would read a
 *     runner-less RUNNING row as dropped and force-retry it) and never FAILED (a local notification
 *     and automatic retry would follow). A subject that settled before its row existed inserts the
 *     terminal status directly.
 *   * `starts_task_work = false` keeps it out of the claim guard and `isCodeTask`.
 *   * `assigned_runner_id`, `task_id`, `context_task_id`, `parent_session_id`, `root_session_id`
 *     and `last_turn_at` stay NULL: no runner queue, no CHILD membership, no wiki session_settled.
 *   * `engine = NULL`, because `session_engine_check` (0414, widened by 0426) admits only known
 *     engines and `orbit` is not one. `creator_id` is the project owner: the column is NOT NULL
 *     and `SessionsService.create` writes it explicitly on every path; this one does not go through
 *     create.
 *   * `provider = 'orbit'`, `provider_builtin = true`, reserved by migration 0436 the way 0426
 *     reserved `cursor`.
 *   * `dispatch_origin = USER` and `run_source = MANUAL`, the same defaults `create` writes —
 *     deliberately not PROJECT_COORDINATOR, which readers treat as a coordinating conversation.
 *
 * It runs in its OWN transaction (never in the claim statement, never in `SessionsService.create`)
 * and emits no `session.created` / `session.updated`.
 *
 * `jobId` names the attempt whose claim warrants the row. Without one, the newest claimed attempt
 * of the subject is used; a subject no attempt has claimed gets no row, so a candidate superseded
 * while QUEUED never opens a conversation.
 */
export async function ensureLandingSession(
  db: LandingDb,
  landingId: string,
  jobId?: string,
): Promise<EnsuredLandingSession | null> {
  return withTransactionRetry(db, async (tx) => {
    const landing = await tx.projectLanding.findUnique({
      where: { id: landingId },
      select: {
        id: true, projectId: true, ownerId: true, subject: true, taskId: true,
        episode: true, sessionId: true, settledAt: true, settledAs: true,
      },
    });
    if (!landing) return null;
    const existing = await tx.session.findUnique({ where: { id: landing.sessionId }, select: { id: true } });
    if (existing) return { sessionId: landing.sessionId, created: false };

    const job = jobId
      ? await tx.projectIntegrationJob.findFirst({
          where: { id: jobId, landingId },
          select: { id: true, sessionId: true, claimGeneration: true },
        })
      : await tx.projectIntegrationJob.findFirst({
          where: { landingId, claimGeneration: { gt: 0 } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true, sessionId: true, claimGeneration: true },
        });
    if (!job || job.claimGeneration === 0n) return null;

    const title = await landingTitle(tx, landing);
    const workspaceId = landing.subject === 'PROMOTION'
      ? (await tx.project.findFirst({
          where: { id: landing.projectId, ownerId: landing.ownerId },
          select: { coordinatorWorkspaceId: true },
        }))?.coordinatorWorkspaceId ?? null
      : job.sessionId
        ? (await tx.session.findFirst({ where: { id: job.sessionId }, select: { workspaceId: true } }))?.workspaceId ?? null
        : null;

    const settled = landing.settledAt !== null;
    const status = settled
      ? (landing.settledAs && SUCCESSFUL_SETTLEMENTS.has(landing.settledAs as LandingSettledAs)
          ? RunStatus.SUCCEEDED
          : RunStatus.CANCELLED)
      : RunStatus.AWAITING_INPUT;

    const [created] = await tx.session.createManyAndReturn({
      data: [{
        id: landing.sessionId,
        ownerId: landing.ownerId,
        creatorId: landing.ownerId,
        title,
        titleManagedByProject: true,
        prompt: LANDING_PROMPT,
        sessionKind: 'LANDING',
        status,
        startsTaskWork: false,
        assignedRunnerId: null,
        taskId: null,
        contextTaskId: null,
        parentSessionId: null,
        rootSessionId: null,
        lastTurnAt: null,
        workspaceId,
        dispatchOrigin: SessionDispatchOrigin.USER,
        runSource: SessionRunSource.MANUAL,
        provider: LANDING_PROVIDER_SLUG,
        providerBuiltin: true,
        engine: null,
        mergeTargets: [],
        ...(settled ? { completedAt: landing.settledAt } : {}),
      }],
      skipDuplicates: true,
      select: { id: true },
    });
    return { sessionId: landing.sessionId, created: created != null };
  }, loggedRetry(logger, 'landingSession.ensure'));
}

/** The server-generated title: `Land · <task>` (with `(#n)` from the second episode) or
 *  `Merge project/<id> → main · #<n>`. */
async function landingTitle(
  tx: Prisma.TransactionClient,
  landing: { subject: string; taskId: string | null; projectId: string; episode: number },
): Promise<string> {
  if (landing.subject === 'PROMOTION') {
    return `Merge project/${uuidToBase62(landing.projectId)} → main · #${landing.episode}`;
  }
  const task = landing.taskId
    ? await tx.task.findFirst({ where: { id: landing.taskId }, select: { title: true } })
    : null;
  const suffix = landing.episode > 1 ? ` (#${landing.episode})` : '';
  return `${LAND_TITLE} · ${task?.title ?? 'task'}${suffix}`;
}

// ── settlement (LS3) ──────────────────────────────────────────────────────────────────────────────

/**
 * Settle one subject under its own row lock, re-checking the fact first (LS3).
 *
 * Lock order is `session(30) → project_landing(60)` (`common/lock-order.ts`): the session row is
 * locked when it exists, then the subject. Under the subject's lock the fact is asked again and the
 * segment is read for a newer in-flight attempt; if either says no, nothing is written. The row may
 * not have a session yet — LS1 allows settlement before `ensure` ran — in which case only the
 * subject is written.
 */
async function settleLanding(
  db: LandingDb,
  landingId: string,
  settledAs: LandingSettledAs,
  stillHolds: (tx: Prisma.TransactionClient, landing: LandingLockedRow) => Promise<boolean>,
): Promise<boolean> {
  return withTransactionRetry(db, async (tx) => {
    const current = await tx.projectLanding.findUnique({
      where: { id: landingId },
      select: { id: true, sessionId: true, settledAt: true },
    });
    if (!current || current.settledAt) return false;

    // Rank 30 before rank 60. A row that does not exist takes no lock, and `ensure`'s insert of a
    // new one does not conflict with this statement.
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "session" WHERE "id" = ${current.sessionId}::uuid FOR UPDATE`);

    const [locked] = await tx.$queryRaw<LandingLockedRow[]>(Prisma.sql`
      SELECT "id", "project_id" AS "projectId", "owner_id" AS "ownerId",
             "codebase_id" AS "codebaseId", "subject", "task_id" AS "taskId",
             "promotion_id" AS "promotionId", "session_id" AS "sessionId",
             "settled_at" AS "settledAt"
        FROM "project_landing"
       WHERE "id" = ${landingId}::uuid
       FOR UPDATE`);
    if (!locked || locked.settledAt) return false;

    // A newer attempt that could still change where the work is going is the segment's outstanding
    // work: settle when it is terminal, not before. A CHECK_PROMOTION is not one — a check never
    // pushes, so it cannot move this fact — and M-T13's receipt retirement stops one in the very
    // transaction that writes the receipt, which settles here.
    const inFlight = await tx.projectIntegrationJob.count({
      where: { landingId, state: { in: ['QUEUED', 'RUNNING'] }, kind: { not: 'CHECK_PROMOTION' } },
    });
    if (inFlight > 0) return false;
    if (!(await stillHolds(tx, locked))) return false;

    const settledAt = new Date();
    await tx.projectLanding.update({
      where: { id: landingId },
      data: { settledAt, settledAs },
    });
    // The container's terminal state. A row inserted after this point reads the settled subject in
    // `ensure` and starts terminal; a row that exists now moves here.
    const session = await tx.session.findUnique({
      where: { id: locked.sessionId },
      select: { id: true },
    });
    if (session) {
      await tx.session.update({
        where: { id: locked.sessionId },
        data: {
          status: SUCCESSFUL_SETTLEMENTS.has(settledAs) ? RunStatus.SUCCEEDED : RunStatus.CANCELLED,
          completedAt: settledAt,
        },
      });
    }
    return true;
  }, loggedRetry(logger, 'landingSession.settle'));
}

interface LandingLockedRow {
  id: string;
  projectId: string;
  ownerId: string;
  codebaseId: string;
  subject: string;
  taskId: string | null;
  promotionId: string | null;
  sessionId: string;
  settledAt: Date | null;
}

/**
 * The edge a landing / promotion result commits: close the subjects the result is the fact for.
 *
 * For a TASK segment the three landing states (`LANDED`, `ALREADY_LANDED`, `NOTHING_TO_LAND`) are
 * its settlement; on a MAIN line the equivalent job is a `LAND_PROMOTION` whose candidate reached
 * MERGED, and the promotion's state decides that below. For a PROMOTION round, MERGED / DECLINED /
 * CANCELLED close it and SUPERSEDED does not — a superseded candidate is one section of the round,
 * not its end.
 */
export async function settleLandingAfterJobResult(
  db: LandingDb & Pick<
    Prisma.TransactionClient,
    'projectIntegrationJob' | 'projectPromotion' | 'projectLanding' | 'sessionMergeReceipt'
  >,
  jobId: string,
): Promise<boolean> {
  const job = await db.projectIntegrationJob.findUnique({
    where: { id: jobId },
    select: { id: true, landingId: true, state: true, promotionId: true, receiptIds: true },
  });
  // J12's recovered receipts are written for EARLIER jobs on this serial key, so a receipt this
  // result wrote may be the landing fact of another task's segment (M-T13 / errata E5). Every
  // landed receipt settles its own task; the subject below is this attempt's.
  let settled = false;
  if (job?.receiptIds?.length) {
    const receipts = await db.sessionMergeReceipt.findMany({
      where: { id: { in: job.receiptIds }, result: { in: ['MERGED', 'ALREADY_MERGED'] } },
      select: { taskId: true, projectId: true, result: true },
    });
    for (const receipt of receipts) {
      if (await settleTaskSegmentAfterReceipt(db, receipt)) settled = true;
    }
  }
  if (!job?.landingId) return settled;
  const landing = await db.projectLanding.findUnique({
    where: { id: job.landingId },
    select: { subject: true, settledAt: true },
  });
  if (!landing || landing.settledAt) return settled;

  if (landing.subject === 'TASK') {
    if (!LANDED_JOB_STATES.has(job.state)) return settled;
    // 0423: the job's task_id may name a task that is gone; the landing row itself is the subject.
    const closed = await settleLanding(db, job.landingId, job.state as LandingSettledAs, async (tx, locked) => {
      const still = await tx.projectIntegrationJob.findFirst({
        where: { id: jobId, landingId: locked.id, state: job.state },
        select: { id: true },
      });
      return still !== null;
    });
    return closed || settled;
  }

  if (!job.promotionId) return settled;
  return (await settleRoundForPromotion(db, job.promotionId, job.landingId)) || settled;
}

/** The edge the owner's decline / cancel door commits (and a confirmation, which settles nothing). */
export async function settleLandingAfterPromotionDecision(
  db: LandingDb & Pick<Prisma.TransactionClient, 'projectIntegrationJob' | 'projectPromotion' | 'projectLanding'>,
  promotionId: string,
): Promise<boolean> {
  const job = await db.projectIntegrationJob.findFirst({
    where: { promotionId, landingId: { not: null } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { landingId: true },
  });
  if (!job?.landingId) return false;
  return settleRoundForPromotion(db, promotionId, job.landingId);
}

async function settleRoundForPromotion(
  db: LandingDb & Pick<Prisma.TransactionClient, 'projectPromotion' | 'projectIntegrationJob'>,
  promotionId: string,
  landingId: string,
): Promise<boolean> {
  const promotion = await db.projectPromotion.findUnique({
    where: { id: promotionId },
    select: { state: true },
  });
  const settledAs: LandingSettledAs | null = promotion?.state === 'MERGED' ? 'MERGED'
    : promotion?.state === 'DECLINED' ? 'DECLINED'
      : promotion?.state === 'CANCELLED' ? 'CANCELLED'
        : null;
  if (!settledAs) return false;
  return settleLanding(db, landingId, settledAs, async (tx, locked) => {
    if (locked.subject !== 'PROMOTION') return false;
    const still = await tx.projectPromotion.findUnique({
      where: { id: promotionId },
      select: { state: true },
    });
    return still?.state === promotion?.state;
  });
}

/** The open TASK segment of one task, in the project the fact is about. */
async function findOpenTaskLanding(
  db: Pick<Prisma.TransactionClient, 'projectLanding'>,
  taskId: string,
  projectId?: string,
  ownerId?: string,
): Promise<{ id: string } | null> {
  return db.projectLanding.findFirst({
    where: {
      subject: 'TASK',
      taskId,
      settledAt: null,
      ...(projectId ? { projectId } : {}),
      ...(ownerId ? { ownerId } : {}),
    },
    select: { id: true },
  });
}

/**
 * M-T13 / errata E5: a receipt that put the branch on its target from outside the merge card
 * retires the candidate offering it, and that receipt IS the segment's landing fact. `MERGED` is
 * LANDED, `ALREADY_MERGED` is ALREADY_LANDED; the session ends SUCCEEDED.
 */
export async function settleTaskSegmentAfterReceipt(
  db: LandingDb & Pick<Prisma.TransactionClient, 'projectLanding' | 'sessionMergeReceipt'>,
  input: { taskId: string | null; projectId: string | null; result: string },
): Promise<boolean> {
  if (!input.taskId || !input.projectId) return false;
  if (input.result !== 'MERGED' && input.result !== 'ALREADY_MERGED') return false;
  const settledAs: LandingSettledAs = input.result === 'MERGED' ? 'LANDED' : 'ALREADY_LANDED';
  const landing = await findOpenTaskLanding(db, input.taskId, input.projectId);
  if (!landing) return false;
  return settleLanding(db, landing.id, settledAs, async (tx, locked) => {
    const receipt = await tx.sessionMergeReceipt.findFirst({
      where: {
        taskId: input.taskId,
        projectId: input.projectId,
        result: { in: ['MERGED', 'ALREADY_MERGED'] },
      },
      select: { id: true },
    });
    return receipt !== null && locked.taskId === input.taskId;
  });
}

/**
 * Rule 2 of the task segment: the task was written CANCELLED. `settled_as` and the session are
 * both CANCELLED. FAILED, reopen and every retry are deliberately NOT settlement facts.
 */
export async function settleTaskSegmentAfterCancel(
  db: LandingDb & Pick<Prisma.TransactionClient, 'projectLanding' | 'task'>,
  input: { ownerId: string; taskId: string },
): Promise<boolean> {
  const landing = await findOpenTaskLanding(db, input.taskId, undefined, input.ownerId);
  if (!landing) return false;
  return settleLanding(db, landing.id, 'CANCELLED', async (tx) => {
    const task = await tx.task.findFirst({
      where: { id: input.taskId, ownerId: input.ownerId },
      select: { status: true },
    });
    return task?.status === 'CANCELLED';
  });
}

/**
 * Rule 2, the other spelling: the task was deleted. The subject survives — it names a task that is
 * gone, as every history reference here may — and settles as DELETED.
 */
export async function settleTaskSegmentsAfterDelete(
  db: LandingDb & Pick<Prisma.TransactionClient, 'projectLanding' | 'task'>,
  input: { ownerId: string; taskIds: readonly string[] },
): Promise<void> {
  if (input.taskIds.length === 0) return;
  const landings = await db.projectLanding.findMany({
    where: { ownerId: input.ownerId, subject: 'TASK', taskId: { in: [...input.taskIds] }, settledAt: null },
    select: { id: true, taskId: true },
  });
  for (const landing of landings) {
    if (!landing.taskId) continue;
    const taskId = landing.taskId;
    await settleLanding(db, landing.id, 'DELETED', async (tx) => {
      const task = await tx.task.findFirst({
        where: { id: taskId, ownerId: input.ownerId },
        select: { id: true },
      });
      return task === null;
    });
  }
}

/**
 * Rule 3: MOVE_TASK took the task out of this project. The segment in the project it left settles
 * CANCELLED; the project it arrived in opens its own segment through that project's enqueue.
 */
export async function settleTaskSegmentAfterMove(
  db: LandingDb & Pick<Prisma.TransactionClient, 'projectLanding' | 'task'>,
  input: { ownerId: string; taskId: string; fromProjectId: string },
): Promise<boolean> {
  const landing = await findOpenTaskLanding(db, input.taskId, input.fromProjectId, input.ownerId);
  if (!landing) return false;
  return settleLanding(db, landing.id, 'CANCELLED', async (tx) => {
    const task = await tx.task.findFirst({
      where: { id: input.taskId, ownerId: input.ownerId },
      select: { projectId: true },
    });
    return task !== null && task.projectId !== input.fromProjectId;
  });
}

/**
 * Rule 4: the segment's last OPEN integration item was closed by hand (a fix task was filed and
 * processed, `open_item_resolve` → RESOLVED / HANDLED) and the segment neither landed nor has an
 * attempt still moving. `settled_as` and the session are CANCELLED as `HANDLED`.
 */
export async function settleTaskSegmentAfterHandledItem(
  db: LandingDb & Pick<Prisma.TransactionClient, 'projectLanding' | 'projectIntegrationJob' | 'projectOpenItem'>,
  input: { ownerId: string; projectId: string; itemId: string },
): Promise<boolean> {
  const item = await db.projectOpenItem.findFirst({
    where: { id: input.itemId, ownerId: input.ownerId, projectId: input.projectId },
    select: { kind: true, state: true, resolution: true, taskId: true, integrationJobId: true },
  });
  if (!item || item.state !== 'RESOLVED') return false;
  // Only the segment's INTEGRATION_* items: closing a delivery review or a task-failure item by
  // hand is not "the segment's todo was handled".
  if (!(INTEGRATION_ITEM_KINDS as readonly string[]).includes(item.kind)) return false;
  if (item.resolution !== 'HANDLED' && item.resolution !== 'RESOLVED') return false;

  const landingId = item.integrationJobId
    ? (await db.projectIntegrationJob.findUnique({
        where: { id: item.integrationJobId },
        select: { landingId: true },
      }))?.landingId ?? null
    : null;
  const landing = landingId
    ? await db.projectLanding.findFirst({
        where: { id: landingId, subject: 'TASK', settledAt: null },
        select: { id: true },
      })
    : item.taskId
      ? await findOpenTaskLanding(db, item.taskId, input.projectId)
      : null;
  if (!landing) return false;

  return settleLanding(db, landing.id, 'HANDLED', async (tx, locked) => {
    const openItems = await tx.projectOpenItem.count({
      where: {
        projectId: locked.projectId,
        state: 'OPEN',
        kind: { in: [...INTEGRATION_ITEM_KINDS] },
        ...(locked.taskId
          ? { OR: [{ taskId: locked.taskId }, { integrationJobId: { in: await landingJobIds(tx, locked.id) } }] }
          : { integrationJobId: { in: await landingJobIds(tx, locked.id) } }),
      },
    });
    if (openItems > 0) return false;
    // "Neither landed": a segment that already put work on the line closes with its landing fact,
    // not with this one.
    const landed = await tx.projectIntegrationJob.count({
      where: { landingId: locked.id, state: { in: [...LANDED_JOB_STATES] } },
    });
    return landed === 0;
  });
}

async function landingJobIds(tx: Prisma.TransactionClient, landingId: string): Promise<string[]> {
  const jobs = await tx.projectIntegrationJob.findMany({
    where: { landingId },
    select: { id: true },
  });
  return jobs.map((job) => job.id);
}

/**
 * The derived label on a source work session (owner decision 2026-10-19): the newest generation of
 * the landing work this conversation produced work for, and the subject it belongs to.
 *
 * The read is one probe of `project_integration_job_session_created_idx` plus the landing's primary
 * key. `state` is the attempt's own state (what the label draws as "checking", "landing"); the
 * subject's `settledAs` is what it draws once it ended. A conversation that produced no landing
 * work answers null, and so does a landing whose subject row is somehow gone.
 */
export async function readSourceLanding(
  db: Pick<Prisma.TransactionClient, 'projectIntegrationJob' | 'projectLanding'>,
  sessionId: string,
): Promise<{
  landingSessionId: string;
  subject: LandingSubject;
  state: string;
  phase: string | null;
  settledAs: LandingSettledAs | null;
  targetRef: string;
} | null> {
  const job = await db.projectIntegrationJob.findFirst({
    where: { sessionId, landingId: { not: null } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { landingId: true, state: true, phase: true, targetRef: true },
  });
  if (!job?.landingId) return null;
  const landing = await db.projectLanding.findUnique({
    where: { id: job.landingId },
    select: { sessionId: true, subject: true, settledAs: true },
  });
  if (!landing) return null;
  return {
    landingSessionId: landing.sessionId,
    subject: landing.subject as LandingSubject,
    state: job.state,
    phase: job.phase,
    settledAs: (landing.settledAs as LandingSettledAs | null) ?? null,
    targetRef: job.targetRef,
  };
}
