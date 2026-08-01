import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';
import { AgentProvider, ClaimedSession, PermissionMode } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { isBuiltinProvider, resolveProviderExec } from '../providers/custom-provider';
import { claudeOauthTokenFor } from '../providers/subscription-token';
import { normalizeEffortForProvider } from '../common/runtime-provider';

/**
 * Session claim queue backed by the `Session` table. A runner long-polls for the
 * PENDING sessions assigned to it; claims are atomic via `FOR UPDATE SKIP LOCKED`
 * and gated, server-side, on the runner's `maxConcurrent` active turns. Warm/cold
 * idle runtimes are retained independently and do not consume that limit.
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
    // Serialize the short count+claim critical section across API replicas. Row locking
    // only the candidate is insufficient: two concurrent statements can lock different
    // PENDING rows, both observe the same RUNNING count, and over-claim the final slot.
    // The global transaction-scoped advisory lock also makes a batch cap spanning several
    // runners authoritative. buildSession deliberately stays outside this short lock.
    const rows = await this.prisma.$transaction(async (tx) => {
      // pg_advisory_xact_lock returns PostgreSQL void, which queryRaw cannot deserialize;
      // executeRaw deliberately discards that result (same pattern as pg_notify).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1330792788, 1)`;
      return tx.$queryRaw<Array<{ id: string }>>`
        UPDATE "session" SET
          status = 'RUNNING',
          "started_at" = COALESCE("started_at", now()),
          "last_turn_at" = now(),
          "updated_at" = now()
        WHERE id = (
          SELECT s.id FROM "session" s
          WHERE s.status = 'PENDING'
            AND s."cancel_requested_at" IS NULL
            AND s."assigned_runner_id" = ${runner.id}::uuid
            -- A runner may only ever drive sessions owned by its own owner.
            AND s."owner_id" = (SELECT r."owner_id" FROM "runner" r WHERE r.id = ${runner.id}::uuid)
            -- A slot is an active turn, not a warm process. Idle AWAITING_INPUT and
            -- legacy INTERRUPTED sessions remain resumable without consuming capacity.
            AND (
              SELECT count(*) FROM "session" active
              WHERE active."assigned_runner_id" = ${runner.id}::uuid
                AND active."status" = 'RUNNING'
            ) < (SELECT r."max_concurrent" FROM "runner" r WHERE r.id = ${runner.id}::uuid)
            -- Batch-run cap, independent of the runner cap above. It has the same
            -- active-turn semantics: only a sibling currently RUNNING consumes capacity.
            AND (
              s."batch_id" IS NULL
              OR (
                SELECT count(*) FROM "session" ba
                WHERE ba."batch_id" = s."batch_id"
                  AND ba."status" = 'RUNNING'
              ) < s."batch_max_concurrent"
            )
          ORDER BY s."created_at" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        RETURNING id
      `;
    });
    if (rows.length === 0) return null;
    return this.buildSession(rows[0].id);
  }

  private async buildSession(sessionId: string): Promise<ClaimedSession> {
    const session = await this.prisma.session.findUniqueOrThrow({
      where: { id: sessionId },
      include: { agent: true },
    });
    // Resume only when the runtime actually established its conversation — i.e. the
    // session has at least one completed turn (numTurns > 0). A first spawn that
    // died before the runtime ever ran (bad PATH, missing cwd, …) still leaves a seeded
    // turn behind, so "has any turn" would wrongly resume a session that
    // was never created, failing forever with "No conversation found".
    const resume = session.numTurns > 0;
    // Serialize lazy first-turn seeding with createTurn. A message can arrive after the
    // PENDING->RUNNING claim but before buildSession runs; without the Session row lock it
    // could take seq=1 and make this path mistake the follow-up for the opening prompt.
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "session" WHERE id = ${session.id}::uuid FOR UPDATE`;
      const turnCount = await tx.conversationTurn.count({ where: { sessionId: session.id } });
      if (turnCount > 0) return;
      const turn = await tx.conversationTurn.create({
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
      await tx.attachment.updateMany({
        where: { sessionId: session.id, turnId: null },
        data: { turnId: turn.id },
      });
    });
    // Continue the monotonic event seq past whatever a prior run persisted (incl. a
    // failed first run's error events) so new events never collide; 0 when fresh.
    const maxSeq =
      (await this.prisma.runEvent.aggregate({ where: { sessionId: session.id }, _max: { seq: true } }))._max.seq ??
      0;
    const agent = session.agent;
    const declared = session.provider ?? agent?.provider ?? null;
    // A configured (custom) provider borrows a built-in runtime: resolve the runner-facing
    // built-in provider, model, and process env (baseUrl + decrypted key injected)
    // here, so the runner receives a plain claude/codex job and needs no changes. Ownership
    // scope: a personal (BYOK) provider resolves only for its owner's sessions — otherwise a
    // user could burn another tenant's key by naming their slug.
    const customRow = isBuiltinProvider(declared, session.providerBuiltin)
      ? null
      : await this.prisma.modelProvider.findFirst({
          where: { slug: declared!, OR: [{ ownerId: null }, { ownerId: session.ownerId }] },
        });
    const exec = resolveProviderExec({
      declaredProvider: declared,
      declaredProviderBuiltin: session.providerBuiltin,
      customRow,
      sessionModel: session.model,
      agentModel: agent?.model,
      agentEnv: agent?.env as Record<string, string> | null,
      claudeOauthToken: await claudeOauthTokenFor(this.prisma, session.ownerId),
    });
    const provider = exec.provider;
    const runtimeSessionId = session.runtimeSessionId ?? session.claudeSessionId ?? undefined;
    const sessionUuid =
      provider === AgentProvider.CLAUDE
        ? (session.claudeSessionId ?? runtimeSessionId ?? session.id)
        : (runtimeSessionId ?? session.id);
    return {
      sessionId: session.id,
      provider,
      runtimeSessionId,
      leaseOwner: session.inboxLeaseOwner ?? undefined,
      title: session.title,
      prompt: session.prompt,
      // The project directory the runtime runs in comes from the session's agent.
      workDir: agent?.workDir ?? undefined,
      // Per-session worktree branch (generated at creation); the runner isolates the
      // session in a `git worktree` on this branch when workDir is a git repo.
      branch: session.branch ?? undefined,
      // Agent opt-in: auto-`git init` a non-git workDir so it can be isolated.
      autoInitGit: agent?.autoInitGit ?? undefined,
      // The branch this session merges into — its own recorded target, else the agent's
      // remembered default (what the status bar's Merge button offers). Lets the runner
      // judge "already merged" against that branch instead of main.
      mergeTarget: session.mergeTarget ?? agent?.defaultMergeTarget ?? undefined,
      sessionUuid,
      maxSeq,
      resume,
      // Injected into the runtime process so the `orbit mcp` server knows its context.
      agentId: session.agentId ?? undefined,
      taskId: session.taskId ?? undefined,
      // Mirror the agent's orchestration opt-in so the runner injects ORBIT_ALLOW_ORCHESTRATION
      // and `orbit mcp` exposes the session_* tools only for enabled agents.
      allowOrchestration: agent?.enableOrchestration ?? false,
      agent: {
        provider,
        // Resolved above: a per-session/agent override (coerced for built-ins so the runner
        // never execs `codex -m claude-*`), or a custom provider's own model.
        model: exec.model,
        appendSystemPrompt: agent?.appendSystemPrompt ?? undefined,
        systemPrompt: agent?.systemPrompt ?? undefined,
        allowedTools: (agent?.allowedTools as string[] | null) ?? [],
        disallowedTools: (agent?.disallowedTools as string[] | null) ?? [],
        permissionMode:
          (session.permissionMode as PermissionMode) ??
          (agent?.permissionMode as PermissionMode) ??
          PermissionMode.DONT_ASK,
        // Per-session effort wins; else the agent's default effort (like model/mode above).
        effort: normalizeEffortForProvider(provider, session.effort ?? agent?.effort),
        maxTurns: agent?.maxTurns ?? undefined,
        maxBudgetUsd: agent?.maxBudgetUsd ?? undefined,
        mcpConfig: (agent?.mcpConfig as Record<string, unknown> | null) ?? undefined,
        // Includes a custom provider's injected baseUrl/key (else just the agent's env).
        env: exec.env,
      },
    };
  }
}
