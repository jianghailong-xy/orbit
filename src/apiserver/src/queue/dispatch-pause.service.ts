import { Injectable, Logger } from '@nestjs/common';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  SESSION_CLAIM_LOCK,
  type DispatchPauseView,
  type RunningIntegrationJob,
  type RunningTurn,
  type RunningWorktreeOperation,
} from './dispatch-pause';
import { QueueService } from './queue.service';

/** Reads and switches the runner dispatch pause (dispatch-pause.ts). */
@Injectable()
export class DispatchPauseService {
  private readonly logger = new Logger(DispatchPauseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly realtime: RealtimeService,
  ) {}

  /** The switch, and the turns, integration jobs and merges/commits still running. */
  async read(): Promise<DispatchPauseView> {
    const state = await this.prisma.dispatchPause.findUnique({ where: { id: 1 } });
    // From the open sessions (OPEN_SESSION_STATUSES) into their turns, both indexed (`session_status_idx`,
    // `(session_id, status)`): a turn of a session that has ended runs nowhere.
    const turns = await this.prisma.$queryRaw<RunningTurn[]>`
      SELECT t."id"::text AS "turnId", t."session_id"::text AS "sessionId",
             s."assigned_runner_id"::text AS "runnerId", t."kind",
             t."delivered_at" AS "deliveredAt", t."lease_deadline_at" AS "leaseDeadlineAt",
             floor(extract(epoch FROM now() - t."delivered_at"))::int AS "elapsedSeconds"
        FROM "session" s
        JOIN "conversation_turn" t ON t."session_id" = s."id" AND t."status" = 'IN_FLIGHT'
       WHERE s."status" IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
         AND t."kind" IN ('message', 'shell')
       ORDER BY t."delivered_at" ASC NULLS FIRST, t."id"`;
    const integrationJobs = await this.prisma.$queryRaw<RunningIntegrationJob[]>`
      SELECT j."id"::text AS "jobId", j."project_id"::text AS "projectId", j."kind",
             j."runner_id"::text AS "runnerId", j."phase", j."claimed_at" AS "claimedAt",
             floor(extract(epoch FROM now() - j."claimed_at"))::int AS "elapsedSeconds"
        FROM "project_integration_job" j
       WHERE j."state" = 'RUNNING'
       ORDER BY j."claimed_at" ASC NULLS FIRST, j."id"`;
    // Any session: a merge asked for after its session ended is still carried out (drainMergeRequests).
    const worktreeOperations = await this.prisma.$queryRaw<RunningWorktreeOperation[]>`
      SELECT s."id"::text AS "sessionId", s."assigned_runner_id"::text AS "runnerId", op."operation",
             op."owner" IS NOT NULL AS "claimed", op."requestedAt",
             floor(extract(epoch FROM now() - op."requestedAt"))::int AS "elapsedSeconds"
        FROM "session" s
        CROSS JOIN LATERAL (VALUES
          ('merge', s."merge_status", s."merge_operation_owner", s."merge_requested_at"),
          ('commit', s."commit_status", s."commit_operation_owner", s."commit_requested_at")
        ) AS op("operation", "status", "owner", "requestedAt")
       WHERE (s."merge_status" = 'pending' OR s."commit_status" = 'pending')
         AND op."status" = 'pending'
       ORDER BY op."requestedAt" ASC NULLS FIRST, s."id", op."operation"`;
    return {
      paused: state?.paused ?? false,
      updatedAt: state?.updatedAt ?? null,
      updatedById: state?.updatedById ?? null,
      running: { turns, integrationJobs, worktreeOperations },
    };
  }

  /**
   * Switch it, as `adminId`. Asking for the state it is already in writes nothing. Turning it off wakes the
   * work it held (`wake`). Answered with what `read` answers.
   */
  async set(adminId: string, paused: boolean): Promise<DispatchPauseView> {
    // Retried whole: the current state is re-read under the claim lock in each attempt, so a re-run decides
    // against what a concurrent switch committed, and writes only when the state really changes.
    const switched = await withTransactionRetry(this.prisma, async (tx) => {
      await tx.$executeRawUnsafe(SESSION_CLAIM_LOCK);
      const [current] = await tx.$queryRaw<Array<{ paused: boolean }>>`
        SELECT "paused" FROM "dispatch_pause" WHERE "id" = 1`;
      if ((current?.paused ?? false) === paused) return false;
      await tx.$executeRaw`
        INSERT INTO "dispatch_pause" ("id", "paused", "updated_at", "updated_by_id")
        VALUES (1, ${paused}, now(), ${adminId}::uuid)
        ON CONFLICT ("id") DO UPDATE
          SET "paused" = EXCLUDED."paused",
              "updated_at" = EXCLUDED."updated_at",
              "updated_by_id" = EXCLUDED."updated_by_id"`;
      return true;
    }, loggedRetry(this.logger, 'dispatchPause.set'));
    if (switched) {
      this.logger.log(`runner dispatch ${paused ? 'paused' : 'resumed'} by administrator ${adminId}`);
      if (!paused) await this.wake();
    }
    return this.read();
  }

  /**
   * After the pause is turned off, the claim, the inbox and the heartbeat hand out what it held on their
   * next round; this wakes each of them once rather than leaving it to that round. This replica's claim
   * long polls at once — the signal never leaves the process, so another replica's claims follow within
   * their 5 s re-poll — the inbox of every session holding a turn the pause kept back, and every runner a
   * queued integration job waits for, which then beats at once. Best effort: the switch has committed, and
   * nothing here is what delivers the work.
   */
  private async wake(): Promise<void> {
    try {
      this.queue.notifySessionQueued();
      const held = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT DISTINCT s."id"::text AS "id"
          FROM "session" s
          JOIN "conversation_turn" t ON t."session_id" = s."id" AND t."status" = 'PENDING'
         WHERE s."status" IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
           AND t."kind" IN ('message', 'shell', 'reload')`;
      for (const { id } of held) this.realtime.notifyInbox(id);
      const runners = await this.prisma.$queryRaw<Array<{ runnerId: string }>>`
        SELECT DISTINCT w."runner_id"::text AS "runnerId"
          FROM "project_integration_job" j
          JOIN "session" s ON s."id" = j."session_id"
          JOIN "workspace" w ON w."id" = s."workspace_id"
         WHERE j."state" = 'QUEUED'
           AND w."runner_id" IS NOT NULL`;
      for (const { runnerId } of runners) this.realtime.notifyRunnerWake(runnerId);
    } catch (error) {
      this.logger.warn(`dispatch resumed, but the wake did not finish: ${error instanceof Error ? error.message : error}`);
    }
  }
}
