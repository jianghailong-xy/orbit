import { createHash, randomUUID } from 'node:crypto';

import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { CreatorType, Prisma, RunStatus, TaskStatus } from '@prisma/client';

import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import {
  CoordinatorJudgmentService,
  type JudgmentOutcome,
} from './coordinator-judgment.service';
import { attemptEndedUnsettledFact } from './coordinator-wake';

/** The project vanished between the committed attempt read and wake authorization. */
export const ATTEMPT_WAKE_PROJECT_GONE = 'PROJECT_GONE';

/** The project still exists, but its automation switch is off at authorization time. */
export const ATTEMPT_WAKE_COORDINATOR_DISABLED = 'COORDINATOR_DISABLED';

/**
 * An interactive task-work Session is parked after a complete turn, so opening a parallel
 * judgment would race work which is still legally resumable. The durable human signal is the
 * exit for this legacy shape; it is deliberately a refusal, never evidence that the Task is DONE.
 */
export const ATTEMPT_WAKE_SESSION_PARKED = 'ATTEMPT_SESSION_PARKED';

/** A task without a Project has no coordinator to which an L2 judgment can be delivered. */
export const ATTEMPT_WAKE_NO_PROJECT_COORDINATOR = 'NO_PROJECT_COORDINATOR';

/** Stable diagnosis carried by both the blocker and its task timeline comment. */
export const ATTEMPT_UNJUDGED_SIGNAL_CODE = 'ATTEMPT_ENDED_WITHOUT_JUDGMENT_PATH';

/** Existing blocker kind whose USER/HUMAN policy puts the Project on its needs-human surface. */
export const ATTEMPT_UNJUDGED_BLOCKER_KIND = 'HUMAN_DECISION_REQUIRED';

const ATTEMPT_UNJUDGED_COMMENT_MARKER =
  `<!-- orbit:${ATTEMPT_UNJUDGED_SIGNAL_CODE} -->`;
const ATTEMPT_UNJUDGED_DEDUPE_SUBJECT = 'TASK_NO_JUDGMENT';
const HUMAN_SIGNAL_RECHECK_MS = 30 * 60 * 1_000;
const STARTUP_RECONCILE_LIMIT = 100;

export interface AttemptHumanSignal {
  signalCode: typeof ATTEMPT_UNJUDGED_SIGNAL_CODE;
  blockerId: string | null;
  commentId: string | null;
}

export type AttemptEndedDelivery =
  | {
      outcome:
        | 'NOT_ENDED'
        | 'NOT_TASK_SESSION'
        | 'TASK_SETTLED'
        | 'JUDGMENT_PATH_AVAILABLE'
        | 'HUMAN_SIGNAL_EXISTS';
    }
  | {
      outcome: 'NOT_PROJECT_TASK';
      taskId: string;
      signal: AttemptHumanSignal;
    }
  | {
      outcome: JudgmentOutcome['outcome'];
      projectId: string;
      taskId: string;
      signal?: AttemptHumanSignal;
    };

const TERMINAL_SESSION_STATUSES: readonly RunStatus[] = [
  RunStatus.SUCCEEDED,
  RunStatus.FAILED,
  RunStatus.CANCELLED,
];

interface AttemptSessionSnapshot {
  id: string;
  status: RunStatus;
  retryAt: Date | null;
  engineTurnActive: boolean;
  startsTaskWork: boolean;
  numTurns: number;
  hasUnansweredTurn: boolean;
  task: {
    id: string;
    status: TaskStatus;
    projectId: string | null;
    acceptanceCommand: string | null;
    hasLiveVerifier: boolean;
  } | null;
}

interface HumanSignalInput {
  taskId: string;
  projectId: string | null;
  sessionId: string;
  sessionStatus: RunStatus;
  l2RefusalCode: string;
}

/**
 * Turn a committed ended task attempt into T2's `ATTEMPT_ENDED_UNSETTLED` fact.
 *
 * The caller supplies only the Session identity. Status, task settlement and the three judgment
 * paths are re-read after the transaction that ended the turn committed, so a request body cannot
 * claim its own result and a pre-commit snapshot cannot race the Task write. A retry which is still
 * armed is not an ended attempt yet: the same Session may run another turn.
 *
 * There are two admissible sources:
 *
 *  - a Session in SUCCEEDED / FAILED / CANCELLED, which may take the ordinary L2 judgment path;
 *  - a task-work Session parked in AWAITING_INPUT after at least one fully answered turn, with no
 *    engine generation or retry still active. It is the legacy shape in which work has stopped but
 *    the Session remains resumable, so L2 is refused rather than raced and a person is signaled.
 *
 * L0 and L1 are checked before either branch. Their existence means this producer has no decision
 * to make: executable acceptance or a live verifier owns the verdict. No branch here writes Task
 * status, especially DONE.
 */
@Injectable()
export class AttemptEndedUnsettledProducer implements OnApplicationBootstrap {
  private readonly logger = new Logger(AttemptEndedUnsettledProducer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly judgments: CoordinatorJudgmentService,
    private readonly convergence: CoordinatorConvergenceService,
  ) {}

  /**
   * One bounded compatibility pass at process start recovers facts committed before this exit
   * existed. It is intentionally not a timer: future facts arrive through the runner's existing
   * post-commit delivery, while a restart only repairs rows an older binary could have stranded.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const result = await this.reconcileUnsettledAttempts(STARTUP_RECONCILE_LIMIT);
      if (result.scanned > 0 || result.resolved > 0) {
        this.logger.log(
          `ATTEMPT_ENDED_UNSETTLED startup reconciliation scanned ${result.scanned}, `
            + `signaled ${result.signaled}, resolved ${result.resolved}`,
        );
      }
    } catch (error) {
      // A compatibility delivery cannot honestly roll back application startup or an older task.
      // The error is loud and the rows remain derivable for the next restart/manual redelivery.
      this.logger.error(
        `ATTEMPT_ENDED_UNSETTLED startup reconciliation failed: `
          + (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  async afterCommit(sessionId: string): Promise<AttemptEndedDelivery> {
    const session = await this.readSession(sessionId);
    if (!session) return { outcome: 'NOT_ENDED' };
    const task = session.task;
    if (!task) return { outcome: 'NOT_TASK_SESSION' };

    if (this.isSettled(task.status)) {
      await this.resolveHumanSignal(task.id, task.projectId);
      return { outcome: 'TASK_SETTLED' };
    }
    if (task.acceptanceCommand != null || task.hasLiveVerifier) {
      await this.resolveHumanSignal(task.id, task.projectId);
      return { outcome: 'JUDGMENT_PATH_AVAILABLE' };
    }

    const terminal = TERMINAL_SESSION_STATUSES.includes(session.status)
      && session.retryAt == null;
    const parked = this.isParkedAttempt(session);
    if (!terminal && !parked) return { outcome: 'NOT_ENDED' };

    if (!task.projectId) {
      const signal = await this.raiseHumanSignal({
        taskId: task.id,
        projectId: null,
        sessionId,
        sessionStatus: session.status,
        l2RefusalCode: ATTEMPT_WAKE_NO_PROJECT_COORDINATOR,
      });
      return { outcome: 'NOT_PROJECT_TASK', taskId: task.id, signal };
    }

    // A parked fact already carrying an open human signal needs no second refused wake row. A
    // terminal redelivery is different: it retries L2, because the landing may have been repaired
    // since the signal was raised and a successful judgment is what resolves that signal.
    if (parked && await this.hasOpenHumanSignal(task.id, task.projectId)) {
      return { outcome: 'HUMAN_SIGNAL_EXISTS' };
    }

    const projectId = task.projectId;
    const fact = attemptEndedUnsettledFact({
      projectId,
      taskId: task.id,
      taskStatus: task.status,
      sessionId,
      sessionStatus: session.status,
    });
    if (!fact) {
      await this.resolveHumanSignal(task.id, projectId);
      return { outcome: 'TASK_SETTLED' };
    }

    const result = await this.judgments.wake(fact, async (claimedFact, claim) => {
      if (parked) {
        return { allowed: false as const, refusalCode: ATTEMPT_WAKE_SESSION_PARKED };
      }
      const project = await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { coordinatorEnabled: true },
      });
      if (!project) {
        return { allowed: false as const, refusalCode: ATTEMPT_WAKE_PROJECT_GONE };
      }
      if (!project.coordinatorEnabled) {
        return { allowed: false as const, refusalCode: ATTEMPT_WAKE_COORDINATOR_DISABLED };
      }
      return this.convergence.authorizeWake(claimedFact, claim);
    });

    if (result.outcome === 'OPENED' || result.outcome === 'ALREADY_OPEN') {
      await this.resolveHumanSignal(task.id, projectId);
      return { outcome: result.outcome, projectId, taskId: task.id };
    }
    if (result.outcome !== 'REFUSED') {
      return { outcome: result.outcome, projectId, taskId: task.id };
    }

    const signal = await this.raiseHumanSignal({
      taskId: task.id,
      projectId,
      sessionId,
      sessionStatus: session.status,
      l2RefusalCode: result.refusalCode,
    });
    return { outcome: result.outcome, projectId, taskId: task.id, signal };
  }

  /** A post-commit producer cannot roll the already committed runner transaction back. */
  async afterCommitQuietly(sessionId: string): Promise<void> {
    try {
      await this.afterCommit(sessionId);
    } catch (error) {
      this.logger.error(
        `ATTEMPT_ENDED_UNSETTLED delivery failed for session ${sessionId}: `
          + (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  /**
   * Repair pre-T11 terminal/parked task attempts once at startup. Candidates are facts, not time:
   * the query asks only whether work is inactive and every queued turn has a durable answer.
   */
  async reconcileUnsettledAttempts(
    limit = STARTUP_RECONCILE_LIMIT,
  ): Promise<{ scanned: number; signaled: number; resolved: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > STARTUP_RECONCILE_LIMIT) {
      throw new Error(`limit must be an integer from 1 to ${STARTUP_RECONCILE_LIMIT}`);
    }
    const resolved = await this.reconcileResolvedHumanSignals();
    const candidates = await this.prisma.$queryRaw<Array<{ sessionId: string }>>(Prisma.sql`
      SELECT DISTINCT ON (s."task_id") s."id" AS "sessionId"
        FROM "session" s
        JOIN "task" t ON t."id" = s."task_id"
       WHERE s."starts_task_work" = true
         AND s."retry_at" IS NULL
         AND s."deleted_at" IS NULL
         AND t."status" NOT IN ('DONE', 'CANCELLED')
         AND t."acceptance_command" IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM "task" verifier
            WHERE verifier."verifies_task_id" = t."id"
              AND verifier."status" IN ('OPEN', 'IN_PROGRESS')
              AND verifier."terminal_reason" IS NULL
              AND verifier."superseded_by_task_id" IS NULL
         )
         AND (
           s."status" IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
           OR (
             s."status" = 'AWAITING_INPUT'
             AND s."engine_turn_active" = false
             AND s."num_turns" > 0
             AND NOT EXISTS (
               SELECT 1 FROM "conversation_turn" turn_row
                WHERE turn_row."session_id" = s."id" AND turn_row."status" <> 'ANSWERED'
             )
             AND NOT EXISTS (
               SELECT 1 FROM "project_blocker" blocker
                WHERE blocker."project_id" = t."project_id"
                  AND blocker."dedupe_key" =
                      ${ATTEMPT_UNJUDGED_BLOCKER_KIND}
                      || ':' || ${ATTEMPT_UNJUDGED_DEDUPE_SUBJECT} || ':' || t."id"::text
                  AND blocker."resolved_at" IS NULL
             )
             AND (
               t."project_id" IS NOT NULL
               OR NOT EXISTS (
                 SELECT 1 FROM "task_comment" comment_row
                  WHERE comment_row."task_id" = t."id"
                    AND comment_row."body" LIKE ${`${ATTEMPT_UNJUDGED_COMMENT_MARKER}%`}
               )
             )
           )
         )
       ORDER BY s."task_id", s."updated_at" DESC, s."id" DESC
       LIMIT ${limit}
    `);

    let signaled = 0;
    for (const candidate of candidates) {
      const delivery = await this.afterCommit(candidate.sessionId);
      if (
        'signal' in delivery
        && delivery.signal
        && (delivery.signal.blockerId || delivery.signal.commentId)
      ) {
        signaled += 1;
      }
    }
    return { scanned: candidates.length, signaled, resolved };
  }

  private async readSession(sessionId: string): Promise<AttemptSessionSnapshot | null> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        status: true,
        retryAt: true,
        engineTurnActive: true,
        startsTaskWork: true,
        numTurns: true,
        turns: {
          where: { status: { not: 'ANSWERED' } },
          select: { id: true },
          take: 1,
        },
        task: {
          select: {
            id: true,
            status: true,
            projectId: true,
            acceptanceCommand: true,
            verifiedBy: {
              where: {
                status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS] },
                terminalReason: null,
                supersededByTaskId: null,
              },
              select: { id: true },
              take: 1,
            },
          },
        },
      },
    });
    if (!session) return null;
    return {
      id: session.id,
      status: session.status,
      retryAt: session.retryAt,
      engineTurnActive: session.engineTurnActive,
      startsTaskWork: session.startsTaskWork,
      numTurns: session.numTurns,
      hasUnansweredTurn: session.turns.length > 0,
      task: session.task
        ? {
            id: session.task.id,
            status: session.task.status,
            projectId: session.task.projectId,
            acceptanceCommand: session.task.acceptanceCommand,
            hasLiveVerifier: session.task.verifiedBy.length > 0,
          }
        : null,
    };
  }

  private isParkedAttempt(session: AttemptSessionSnapshot): boolean {
    return session.status === RunStatus.AWAITING_INPUT
      && session.retryAt == null
      && session.startsTaskWork
      && !session.engineTurnActive
      && session.numTurns > 0
      && !session.hasUnansweredTurn;
  }

  private isSettled(status: TaskStatus): boolean {
    return status === TaskStatus.DONE || status === TaskStatus.CANCELLED;
  }

  private dedupeKey(taskId: string): string {
    return `${ATTEMPT_UNJUDGED_BLOCKER_KIND}:${ATTEMPT_UNJUDGED_DEDUPE_SUBJECT}:${taskId}`;
  }

  private async hasOpenHumanSignal(taskId: string, projectId: string): Promise<boolean> {
    return (await this.prisma.projectBlocker.count({
      where: { projectId, dedupeKey: this.dedupeKey(taskId), resolvedAt: null },
    })) > 0;
  }

  /**
   * One transaction turns an L2 refusal into the existing needs-human surface and the Task's own
   * readable evidence. The task row is re-read under lock and both other paths are checked again;
   * a path added after the wake refusal therefore wins and no stale signal is committed.
   */
  private async raiseHumanSignal(input: HumanSignalInput): Promise<AttemptHumanSignal> {
    return withTransactionRetry(this.prisma, async (tx) => {
      // The owner graph mutex is the rank-10 fence every Task/verification write takes. The first
      // read only discovers which mutex to take; the locked Task read below is authoritative.
      const owner = await tx.task.findUnique({
        where: { id: input.taskId },
        select: { ownerId: true },
      });
      if (!owner) {
        return {
          signalCode: ATTEMPT_UNJUDGED_SIGNAL_CODE,
          blockerId: null,
          commentId: null,
        };
      }
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "user" WHERE "id" = ${owner.ownerId}::uuid FOR UPDATE
      `);
      if (input.projectId) {
        await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "project"
           WHERE "id" = ${input.projectId}::uuid
           FOR NO KEY UPDATE
        `);
      }
      const [task] = await tx.$queryRaw<Array<{
        id: string;
        status: TaskStatus;
        projectId: string | null;
        acceptanceCommand: string | null;
        assigneeId: string | null;
        creatorType: CreatorType;
        creatorId: string;
        hasLiveVerifier: boolean;
      }>>(Prisma.sql`
        SELECT t."id", t."status", t."project_id" AS "projectId",
               t."acceptance_command" AS "acceptanceCommand",
               t."assignee_id" AS "assigneeId", t."creator_type" AS "creatorType",
               t."creator_id" AS "creatorId", EXISTS (
                 SELECT 1 FROM "task" verifier
                  WHERE verifier."verifies_task_id" = t."id"
                    AND verifier."status" IN ('OPEN', 'IN_PROGRESS')
                    AND verifier."terminal_reason" IS NULL
                    AND verifier."superseded_by_task_id" IS NULL
               ) AS "hasLiveVerifier"
          FROM "task" t
         WHERE t."id" = ${input.taskId}::uuid
         FOR NO KEY UPDATE
      `);
      if (
        !task
        || this.isSettled(task.status)
        || task.acceptanceCommand != null
        || task.hasLiveVerifier
        || task.projectId !== input.projectId
      ) {
        return {
          signalCode: ATTEMPT_UNJUDGED_SIGNAL_CODE,
          blockerId: null,
          commentId: null,
        };
      }

      const now = new Date();
      const detail = {
        signalCode: ATTEMPT_UNJUDGED_SIGNAL_CODE,
        source: 'ATTEMPT_ENDED_UNSETTLED',
        sessionId: input.sessionId,
        sessionStatus: input.sessionStatus,
        taskStatus: task.status,
        paths: {
          L0: { outcome: 'UNAVAILABLE', reason: 'NO_ACCEPTANCE_COMMAND' },
          L1: { outcome: 'UNAVAILABLE', reason: 'NO_LIVE_VERIFICATION_TASK' },
          L2: { outcome: 'REFUSED', reason: input.l2RefusalCode },
        },
        automaticTaskStatusWrite: 'NONE',
      } as const;
      const conditionVersion = createHash('sha256')
        .update(JSON.stringify(detail))
        .digest('hex');
      const body = this.humanSignalComment(input, task.status);

      let blockerId: string | null = null;
      if (input.projectId) {
        const proposedId = randomUUID();
        const nextCheckAt = new Date(now.getTime() + HUMAN_SIGNAL_RECHECK_MS);
        const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          INSERT INTO "project_blocker" (
            "id", "project_id", "kind", "owner", "recovery", "severity", "required_action",
            "next_check_at", "subject_type", "subject_id", "detail", "dedupe_key",
            "lifecycle_generation", "condition_version", "first_seen_at", "last_seen_at",
            "updated_at"
          )
          SELECT ${proposedId}::uuid, ${input.projectId}::uuid,
                 ${ATTEMPT_UNJUDGED_BLOCKER_KIND}, 'USER'::"project_blocker_owner",
                 'HUMAN'::"project_blocker_recovery", 'CRITICAL'::"project_blocker_severity",
                 ${'工作可能已经完成，但系统没有合法判定路径；请查看交付证据并明确判定任务结果。'},
                 ${nextCheckAt}, 'TASK', ${input.taskId}, ${JSON.stringify(detail)}::jsonb,
                 ${this.dedupeKey(input.taskId)},
                 coalesce(max(blocker."lifecycle_generation"), 0) + 1,
                 ${conditionVersion}, ${now}, ${now}, ${now}
            FROM "project_blocker" blocker
           WHERE blocker."project_id" = ${input.projectId}::uuid
             AND blocker."dedupe_key" = ${this.dedupeKey(input.taskId)}
          ON CONFLICT ("project_id", "dedupe_key") WHERE "resolved_at" IS NULL DO NOTHING
          RETURNING "id"
        `);
        blockerId = rows[0]?.id ?? null;
      }

      // A project blocker owns dedupe for project tasks. A project-less task uses the marker in
      // its timeline, because there is no project row on which a blocker could legally hang.
      const shouldComment = input.projectId
        ? blockerId != null
        : !(await tx.taskComment.findFirst({
            where: { taskId: input.taskId, body: { startsWith: ATTEMPT_UNJUDGED_COMMENT_MARKER } },
            select: { id: true },
          }));
      if (!shouldComment) {
        return { signalCode: ATTEMPT_UNJUDGED_SIGNAL_CODE, blockerId, commentId: null };
      }
      const comment = await tx.taskComment.create({
        data: {
          taskId: input.taskId,
          authorType: task.assigneeId ? CreatorType.AGENT : task.creatorType,
          authorId: task.assigneeId ?? task.creatorId,
          body,
        },
        select: { id: true },
      });
      return {
        signalCode: ATTEMPT_UNJUDGED_SIGNAL_CODE,
        blockerId,
        commentId: comment.id,
      };
    }, loggedRetry(this.logger, 'attemptEndedUnsettled.raiseHumanSignal'));
  }

  private humanSignalComment(input: HumanSignalInput, taskStatus: TaskStatus): string {
    const sessionLine = TERMINAL_SESSION_STATUSES.includes(input.sessionStatus)
      ? `执行会话 ${input.sessionId} 已到终态 ${input.sessionStatus}`
      : `执行会话 ${input.sessionId} 的工作回合已结束，当前停在 ${input.sessionStatus}`;
    return `${ATTEMPT_UNJUDGED_COMMENT_MARKER}\n`
      + `**需要人工判定（系统自动记录）**\n\n`
      + `${sessionLine}，但任务仍为 ${taskStatus}。\n\n`
      + `- L0 不可用：任务没有 acceptanceCommand\n`
      + `- L1 不可用：任务没有活跃的验证任务\n`
      + `- L2 不可用：${input.l2RefusalCode}\n\n`
      + `工作可能已经完成，但系统没有合法证据自动判定 DONE；任务状态未被修改。`
      + `请查看交付证据并明确判定任务结果。\n\n`
      + `信号来源：ATTEMPT_ENDED_UNSETTLED / ${ATTEMPT_UNJUDGED_SIGNAL_CODE}`;
  }

  private async resolveHumanSignal(taskId: string, projectId: string | null): Promise<void> {
    if (!projectId) return;
    const now = new Date();
    await this.prisma.projectBlocker.updateMany({
      where: { projectId, dedupeKey: this.dedupeKey(taskId), resolvedAt: null },
      data: { resolvedAt: now, resolvedBy: 'AUTO', updatedAt: now },
    });
  }

  /** Resolve signals whose missing path has since been supplied or whose Task was decided. */
  private async reconcileResolvedHumanSignals(): Promise<number> {
    const now = new Date();
    const changed = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "project_blocker" blocker
         SET "resolved_at" = ${now}, "resolved_by" = 'AUTO', "updated_at" = ${now}
       WHERE blocker."resolved_at" IS NULL
         AND blocker."kind" = ${ATTEMPT_UNJUDGED_BLOCKER_KIND}
         AND blocker."dedupe_key" LIKE
             ${`${ATTEMPT_UNJUDGED_BLOCKER_KIND}:${ATTEMPT_UNJUDGED_DEDUPE_SUBJECT}:%`}
         AND (
           NOT EXISTS (
             SELECT 1 FROM "task" t WHERE t."id" = blocker."subject_id"::uuid
           )
           OR EXISTS (
             SELECT 1 FROM "task" t
              WHERE t."id" = blocker."subject_id"::uuid
                AND (
                  t."status" IN ('DONE', 'CANCELLED')
                  OR t."acceptance_command" IS NOT NULL
                  OR (t."status" = 'FAILED' AND t."updated_at" > blocker."first_seen_at")
                  OR EXISTS (
                    SELECT 1 FROM "task" verifier
                     WHERE verifier."verifies_task_id" = t."id"
                       AND verifier."status" IN ('OPEN', 'IN_PROGRESS')
                       AND verifier."terminal_reason" IS NULL
                       AND verifier."superseded_by_task_id" IS NULL
                  )
                  OR EXISTS (
                    SELECT 1 FROM "project_coordinator_wake" wake
                     WHERE wake."project_id" = blocker."project_id"
                       AND wake."event" = 'ATTEMPT_ENDED_UNSETTLED'
                       AND wake."subject_type" = 'TASK'
                       AND wake."subject_id" = t."id"::text
                       AND wake."status" = 'SESSION_OPENED'
                       AND wake."created_at" >= blocker."first_seen_at"
                  )
                )
           )
         )
    `);
    return changed;
  }
}
