import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';
import { ClaimedSession, PermissionMode } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Session claim queue backed by the `Session` table. A runner long-polls for the
 * PENDING sessions assigned to it; claims are atomic via `FOR UPDATE SKIP LOCKED`
 * and gated, server-side, on the runner's `maxConcurrent` so it never gets more
 * live sessions than it can host.
 */
@Injectable()
export class QueueService {
  private readonly signal = new EventEmitter();

  constructor(private readonly prisma: PrismaService) {
    this.signal.setMaxListeners(0);
  }

  /** Wake long-poll waiters after a session transitions to PENDING. */
  notifySessionQueued(): void {
    this.signal.emit('queued');
  }

  private waitForSignal(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.signal.off('queued', done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.signal.once('queued', done);
    });
  }

  async claimSessionForRunner(runner: { id: string }, waitMs = 0): Promise<ClaimedSession | null> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const job = await this.trySessionClaim(runner);
      if (job) return job;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await this.waitForSignal(Math.min(remaining, 5000));
    }
  }

  private async trySessionClaim(runner: { id: string }): Promise<ClaimedSession | null> {
    // Atomically claim one PENDING session assigned to this runner. The runner id
    // must be cast to ::uuid: Prisma binds template params as text, and Postgres
    // has no `uuid = text` operator (claim silently fails otherwise — 42883).
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "session" SET status = 'RUNNING', "started_at" = now(), "last_turn_at" = now(), "updated_at" = now()
      WHERE id = (
        SELECT s.id FROM "session" s
        WHERE s.status = 'PENDING'
          AND s."assigned_runner_id" = ${runner.id}::uuid
          -- A runner may only ever drive sessions owned by its own owner.
          AND s."owner_id" = (SELECT r."owner_id" FROM "runner" r WHERE r.id = ${runner.id}::uuid)
          -- Server-authoritative concurrency cap: never hand a runner more live
          -- sessions (RUNNING/AWAITING_INPUT/INTERRUPTED stay live between turns)
          -- than its maxConcurrent, even if its self-gating drifts after a restart.
          AND (
            SELECT count(*) FROM "session" live
            WHERE live."assigned_runner_id" = ${runner.id}::uuid
              AND live."status" IN ('RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
          ) < (SELECT r."max_concurrent" FROM "runner" r WHERE r.id = ${runner.id}::uuid)
        ORDER BY s."created_at" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING id
    `;
    if (rows.length === 0) return null;
    return this.buildSession(rows[0].id);
  }

  private async buildSession(sessionId: string): Promise<ClaimedSession> {
    const session = await this.prisma.session.findUniqueOrThrow({
      where: { id: sessionId },
      include: { agent: true },
    });
    // A session claimed before already has turns (drained, not deleted) and a claude
    // session registered under claudeSessionId. Re-claiming it (revived from an ended
    // state) must --resume that session, not seed a new first turn or re-use
    // --session-id. A truly fresh session has no turns yet.
    const priorTurns = await this.prisma.conversationTurn.count({
      where: { sessionId: session.id },
    });
    const resume = priorTurns > 0;
    if (!resume) {
      // Seed the first turn from the session prompt so every turn (incl. the first)
      // flows through the same inbox + turn-complete path on the runner.
      await this.prisma.conversationTurn.create({
        data: {
          sessionId: session.id,
          seq: 1,
          clientTurnId: `initial-${session.id}`,
          kind: 'message',
          content: session.prompt,
          status: 'PENDING',
        },
      });
    }
    // Continue the monotonic event seq past whatever a prior run persisted, so a
    // resumed session's new events never collide with its history (0 when fresh).
    const maxSeq = resume
      ? ((await this.prisma.runEvent.aggregate({ where: { sessionId: session.id }, _max: { seq: true } }))._max
          .seq ?? 0)
      : 0;
    const agent = session.agent;
    return {
      sessionId: session.id,
      title: session.title,
      prompt: session.prompt,
      // The project directory claude runs in comes from the session's agent.
      workDir: agent?.workDir ?? undefined,
      // We spawn claude with --session-id = claudeSessionId, so it's known up front.
      sessionUuid: session.claudeSessionId ?? session.id,
      maxSeq,
      resume,
      agent: {
        // Per-session override wins over the agent, then a server default.
        model: session.model ?? agent?.model ?? 'claude-sonnet-4-6',
        appendSystemPrompt: agent?.appendSystemPrompt ?? undefined,
        systemPrompt: agent?.systemPrompt ?? undefined,
        allowedTools: (agent?.allowedTools as string[] | null) ?? [],
        disallowedTools: (agent?.disallowedTools as string[] | null) ?? [],
        permissionMode:
          (session.permissionMode as PermissionMode) ??
          (agent?.permissionMode as PermissionMode) ??
          PermissionMode.DONT_ASK,
        effort: session.effort ?? undefined,
        maxTurns: agent?.maxTurns ?? undefined,
        maxBudgetUsd: agent?.maxBudgetUsd ?? undefined,
        mcpConfig: (agent?.mcpConfig as Record<string, unknown> | null) ?? undefined,
      },
    };
  }
}
