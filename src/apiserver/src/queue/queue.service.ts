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
          -- Batch-run cap, independent of the runner cap above: a session tagged with a
          -- batch_id may only start while fewer than batch_max_concurrent of its batch
          -- siblings are live (counted across all runners). Untagged sessions skip this.
          AND (
            s."batch_id" IS NULL
            OR (
              SELECT count(*) FROM "session" bl
              WHERE bl."batch_id" = s."batch_id"
                AND bl."status" IN ('RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
            ) < s."batch_max_concurrent"
          )
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
    // Resume claude only when it actually established its conversation — i.e. the
    // session has at least one completed turn (numTurns > 0). A first spawn that
    // died before claude ever ran (bad PATH, missing cwd, …) still leaves a seeded
    // turn behind, so "has any turn" would wrongly --resume a claude session that
    // was never created, failing forever with "No conversation found".
    const turnCount = await this.prisma.conversationTurn.count({
      where: { sessionId: session.id },
    });
    const resume = session.numTurns > 0;
    if (turnCount === 0) {
      // Truly fresh (first claim ever): seed the first turn from the session prompt
      // so every turn (incl. the first) flows through the same inbox + turn-complete
      // path on the runner.
      const turn = await this.prisma.conversationTurn.create({
        data: {
          sessionId: session.id,
          seq: 1,
          clientTurnId: `initial-${session.id}`,
          kind: 'message',
          content: session.prompt,
          status: 'PENDING',
        },
        select: { id: true },
      });
      // Link any images pasted on the compose page (scoped to this session on create,
      // still turn-less) to this first turn, so the inbox delivers them like any other
      // turn's attachments. No-op for a text-only first turn.
      await this.prisma.attachment.updateMany({
        where: { sessionId: session.id, turnId: null },
        data: { turnId: turn.id },
      });
    }
    // Continue the monotonic event seq past whatever a prior run persisted (incl. a
    // failed first run's error events) so new events never collide; 0 when fresh.
    const maxSeq =
      (await this.prisma.runEvent.aggregate({ where: { sessionId: session.id }, _max: { seq: true } }))._max.seq ??
      0;
    const agent = session.agent;
    return {
      sessionId: session.id,
      title: session.title,
      prompt: session.prompt,
      // The project directory claude runs in comes from the session's agent.
      workDir: agent?.workDir ?? undefined,
      // Per-session worktree branch (generated at creation); the runner isolates the
      // session in a `git worktree` on this branch when workDir is a git repo.
      branch: session.branch ?? undefined,
      // Agent opt-in: auto-`git init` a non-git workDir so it can be isolated.
      autoInitGit: agent?.autoInitGit ?? undefined,
      // We spawn claude with --session-id = claudeSessionId, so it's known up front.
      sessionUuid: session.claudeSessionId ?? session.id,
      maxSeq,
      resume,
      // Injected into the claude process so the `orbit mcp` server knows its context.
      agentId: session.agentId ?? undefined,
      taskId: session.taskId ?? undefined,
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
        env: (agent?.env as Record<string, string> | null) ?? undefined,
      },
    };
  }
}
