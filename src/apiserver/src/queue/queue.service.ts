import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EventEmitter } from 'events';
import { AgentProvider, ClaimedSession, PermissionMode } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { isBuiltinProvider, resolveProviderExec } from '../providers/custom-provider';
import {
  normalizeBuiltinPermissionMode,
  normalizeEffortForRuntimeModel,
} from '../common/runtime-provider';
import { WORKTREE_OPERATION_STALE_MS } from '../common/session-inbox-fence';
import {
  batchActiveTurns,
  runnerActiveTurns,
  treeActiveTurns,
  treeCeiling,
} from '../common/session-tree-sql';
import { OPENCODE_RUNNER_UPGRADE_ERROR } from '../runner-api/runner-provider-support';
import { ALWAYS_ALLOWED_TOOLS, resolvePermissionMode } from '../common/permission-mode';
import { dispatchAllowedTools } from '../common/permission-rules';

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

  async claimSessionForRunner(
    runner: { id: string; supportedProviders?: readonly AgentProvider[] },
    waitMs = 0,
    supportsTerminalHandoff = false,
  ): Promise<ClaimedSession | null> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const job = await this.trySessionClaim(runner, supportsTerminalHandoff);
      if (job) return job;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await this.waitForSignal(Math.min(remaining, 5000));
    }
  }

  private async trySessionClaim(
    runner: { id: string; supportedProviders?: readonly AgentProvider[] },
    supportsTerminalHandoff: boolean,
  ): Promise<ClaimedSession | null> {
    const supportsOpenCode = runner.supportedProviders?.includes(AgentProvider.OPENCODE) ?? false;
    // Atomically claim one PENDING session assigned to this runner. The runner id
    // must be cast to ::uuid: Prisma binds template params as text, and Postgres
    // has no `uuid = text` operator (claim silently fails otherwise — 42883).
    // Serialize the short count+claim critical section across API replicas. Row locking
    // only the candidate is insufficient: two concurrent statements can lock different
    // PENDING rows, both observe the same RUNNING count, and over-claim the final slot.
    // The global transaction-scoped advisory lock also makes a batch cap spanning several
    // runners authoritative. buildSession deliberately stays outside this short lock.
    //
    // Uses FOR UPDATE NOWAIT: when a concurrent transaction (e.g. activateLeases) holds
    // a row lock on the candidate, Postgres immediately raises lock_not_available (55P03)
    // instead of silently skipping the row (SKIP LOCKED) or blocking. The catch clause
    // returns null so the outer claimSessionForRunner loop waits on the signal and
    // retries; this prevents lock storms from starving new sessions indefinitely.
    try {
      const rows = await this.prisma.$transaction(async (tx) => {
        // pg_advisory_xact_lock returns PostgreSQL void, which queryRaw cannot deserialize;
        // executeRaw deliberately discards that result (same pattern as pg_notify).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1330792788, 1)`;
        // Migration 0080 installs a database trigger so an older apiserver replica cannot
        // claim OpenCode as Claude during a rolling control-plane deploy. This transaction-
        // local capability is the positive signal that lets only the new, capable path pass.
        await tx.$executeRaw`SELECT set_config('orbit.runner_supports_opencode', ${supportsOpenCode ? '1' : '0'}, true)`;
        // Prisma.sql rather than a bare tagged template so the cap fragments below are the
        // SAME SQL the session list uses to explain a queued row. Written twice they drift,
        // and a UI that names the wrong gate is worse than one that names none.
        const runnerId = Prisma.sql`${runner.id}::uuid`;
        return tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        UPDATE "session" SET
          status = 'RUNNING',
          error = CASE
            WHEN error = ${OPENCODE_RUNNER_UPGRADE_ERROR} THEN NULL
            ELSE error
          END,
          "started_at" = COALESCE("started_at", now()),
          "last_turn_at" = now(),
          "updated_at" = now()
        WHERE id = (
          SELECT s.id FROM "session" s
          WHERE s.status = 'PENDING'
            AND s."cancel_requested_at" IS NULL
            AND s."assigned_runner_id" = ${runnerId}
            -- Legacy runners treat an unknown provider as Claude. Require a positive OpenCode
            -- capability advertisement so an upgraded server can never dispatch one of these
            -- rows to a pre-0.1.82 process during a rolling release.
            AND (
              ${supportsOpenCode}
              OR COALESCE(s.provider, 'claude') <> 'opencode'
            )
            -- A runner may only ever drive sessions owned by its own owner.
            AND s."owner_id" = (SELECT r."owner_id" FROM "runner" r WHERE r.id = ${runnerId})
            -- A terminal revive uses a reserved predecessor owner until a runner
            -- explicitly capable of local supervisor handoff claims it. Older
            -- runners stay online but leave this row queued for an upgrade.
            AND (
              ${supportsTerminalHandoff}::boolean
              OR substring(s."inbox_lease_owner"::text, 15, 1) IS DISTINCT FROM '5'
            )
            -- A slot is an active turn, not a warm process. Idle AWAITING_INPUT and
            -- legacy INTERRUPTED sessions remain resumable without consuming capacity.
            AND ${runnerActiveTurns(runnerId)}
                  < (SELECT r."max_concurrent" FROM "runner" r WHERE r.id = ${runnerId})
            -- Batch-run cap, independent of the runner cap above: a closed set the user
            -- dispatched together, with the cap they chose for it.
            AND (
              s."batch_id" IS NULL
              OR ${batchActiveTurns('s')} < s."batch_max_concurrent"
            )
            -- Spawn-tree cap, independent of both caps above. Where a batch run is closed and
            -- user-capped, a tree grows on its own and is capped by the server. See
            -- session-tree-sql.ts for why the ceiling is a share of the runner and why a
            -- supervisor is exempt from the count.
            AND (
              s."root_session_id" IS NULL
              OR ${treeActiveTurns('s')} < ${treeCeiling(runnerId)}
            )
            -- A message may be queued behind a merge/commit still executing on this
            -- session's checkout (createTurn enqueues it PENDING rather than rejecting).
            -- Don't hand it a slot until that git operation settles off 'pending', or the
            -- turn would run concurrently with the mutation. Mirrors, in SQL, the staleness
            -- bound of pendingWorktreeOperationMayBeExecuting: a dead owner past the margin
            -- stops fencing so a crashed operation can't wedge the turn forever (a live
            -- runner also fails it via failAbandonedWorktreeOperations).
            -- NULL-safe equality: plain "= 'pending'" is SQL NULL (not false) for the
            -- common case of a session that has never had a merge/commit, and NOT(NULL)
            -- is NULL too — which a WHERE clause treats as non-matching, excluding the
            -- row from every claim forever. IS NOT DISTINCT FROM always yields a real
            -- boolean.
            AND NOT (
              s."merge_status" IS NOT DISTINCT FROM 'pending'
              AND (
                s."merge_requested_at" IS NULL
                OR s."merge_requested_at" > now() - (${WORKTREE_OPERATION_STALE_MS} * interval '1 millisecond')
              )
            )
            AND NOT (
              s."commit_status" IS NOT DISTINCT FROM 'pending'
              AND (
                s."commit_requested_at" IS NULL
                OR s."commit_requested_at" > now() - (${WORKTREE_OPERATION_STALE_MS} * interval '1 millisecond')
              )
            )
          -- Fair-queue across spawn trees, then oldest first. A hard sub-cap can only make a
          -- runner idle while work waits; ordering gives the same protection without that —
          -- the tree already holding the most active turns is picked last, so one tree may use
          -- the whole machine while nothing else wants it and yields the next slot the moment
          -- something does. A session in no tree counts 0 and therefore sorts ahead of every
          -- contended tree, which is what keeps ordinary work from queueing behind orchestration.
          --
          -- This only decides who takes the NEXT free slot; it cannot reclaim one already held,
          -- and turns are long, so convergence is slow by construction. Preemption is the thing
          -- that would fix that, and is deliberately not attempted here.
          ORDER BY (
              SELECT count(*) FROM "session" busy
              WHERE busy."root_session_id" = s."root_session_id"
                AND busy."status" = 'RUNNING'
            ) ASC,
            s."created_at" ASC
          FOR UPDATE NOWAIT
          LIMIT 1
        )
        RETURNING id
      `);
      });
      if (rows.length === 0) return null;
      return this.buildSession(rows[0].id);
    } catch (err: any) {
      // pg error 55P03 = lock_not_available: FOR UPDATE NOWAIT cannot lock the
      // candidate row because a concurrent transaction (e.g. activateLeases in a
      // reclaim storm) holds it. Return null so the outer claimSessionForRunner
      // loop waits on the signal and retries instead of starving forever.
      if (
        err?.code === '55P03' ||
        err?.meta?.code === '55P03' ||
        String(err?.message ?? '').includes('55P03') ||
        String(err?.message ?? '').includes('lock_not_available')
      ) {
        return null;
      }
      throw err;
    }
  }

  private async buildSession(sessionId: string): Promise<ClaimedSession> {
    const session = await this.prisma.session.findUniqueOrThrow({
      where: { id: sessionId },
      include: {
        // The workspace's standing "always allow" grants ride along: they are what turns an
        // approval a human already answered into one this session never has to ask again.
        workspace: { include: { permissionRules: { orderBy: { createdAt: 'asc' } } } },
        assignedRunner: { select: { runtimeDefaultModels: true, modelCatalog: true } },
        // The account-level permission default, which replaced the per-workspace one.
        owner: { select: { preferences: true } },
      },
    });
    // Resume only when the runtime actually established its conversation — i.e. the
    // session has at least one completed turn (numTurns > 0). A first spawn that
    // died before the runtime ever ran (bad PATH, missing cwd, …) still leaves a seeded
    // turn behind, so "has any turn" would wrongly resume a session that
    // was never created, failing forever with "No conversation found".
    // Serialize lazy first-turn seeding with createTurn. A message can arrive after the
    // PENDING->RUNNING claim but before buildSession runs; without the Session row lock it
    // could take seq=1 and make this path mistake the follow-up for the opening prompt.
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "session" WHERE id = ${session.id}::uuid FOR UPDATE`;
      const seedClientTurnId = `initial-${session.id}`;
      const existingSeed = await tx.conversationTurn.findUnique({
        where: {
          sessionId_clientTurnId: {
            sessionId: session.id,
            clientTurnId: seedClientTurnId,
          },
        },
        select: { id: true },
      });
      if (existingSeed) return;
      const turn = await tx.conversationTurn.create({
        data: {
          sessionId: session.id,
          seq: 1,
          clientTurnId: seedClientTurnId,
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
    const workspace = session.workspace;
    const declared = session.provider ?? null;
    // A configured (custom) provider borrows a built-in runtime: resolve the runner-facing
    // built-in provider, model, and process env (baseUrl + decrypted key injected)
    // here, so the runner receives a plain claude/codex job and needs no changes. Ownership
    // scope: a personal (BYOK) provider resolves only for its owner's sessions — otherwise a
    // user could burn another tenant's key by naming their slug.
    const declaredIsBuiltin = isBuiltinProvider(declared, session.providerBuiltin);
    const customRow = declaredIsBuiltin
      ? null
      : await this.prisma.modelProvider.findFirst({
          where: { slug: declared!, OR: [{ ownerId: null }, { ownerId: session.ownerId }] },
        });
    const resolveExec = (sessionModel: string | null) =>
      resolveProviderExec({
        declaredProvider: declared,
        declaredProviderBuiltin: session.providerBuiltin,
        customRow,
        sessionModel,
        usesRuntimeDefaultModel: session.usesRuntimeDefaultModel,
        runtimeDefaultModels: session.assignedRunner?.runtimeDefaultModels,
        workspaceModel: workspace?.model,
        modelCatalog: session.assignedRunner?.modelCatalog,
        workspaceEnv: workspace?.env as Record<string, string> | null,
      });
    let exec = resolveExec(session.model);
    // Snapshot an inherited default on the session at its first claim, and refresh one the runtime
    // has since retired. Later Runtime heartbeat changes must not silently switch an
    // already-established conversation on reclaim/resume — only a model that is no longer offered
    // at all moves, and then the row must stop naming it or the pickers would keep showing a dead
    // id the session isn't running.
    if (session.model === null || session.model.trim() === '' || exec.retiredPin) {
      // A user may PATCH an explicit session model after this snapshot was read. Compare against
      // the exact value that resolution ran on, so materialization is a compare-and-set instead of
      // overwriting that concurrent choice.
      const materialized = await this.prisma.$executeRaw`
        UPDATE "session"
        SET "model" = ${exec.model}
        WHERE "id" = ${session.id}::uuid
          AND "model" IS NOT DISTINCT FROM ${session.model}
      `;
      if (materialized === 0) {
        // A concurrent Session config PATCH won the CAS. Dispatch must use that explicit choice,
        // not the stale Runtime/legacy default resolved from the pre-PATCH snapshot. Re-resolving
        // also retains the built-in cross-provider safety coercion.
        const winner = await this.prisma.session.findUniqueOrThrow({
          where: { id: session.id },
          select: { model: true },
        });
        exec = resolveExec(winner.model);
      }
    }
    const provider = exec.provider;
    const permissionMode = resolvePermissionMode(session.permissionMode, session.owner);
    // Claude spawns with a pre-generated --session-id, so a Claude row without one has no
    // conversation the runtime could resume — it was created before the column existed, or
    // its id was minted by a different runtime. Generate a fresh UUID, persist it, reset
    // numTurns so the runner does a first spawn instead of --resume (which would fail —
    // Claude has no session file for the new id), and force resume=false so the runner
    // doesn't try to pick up a non-existent conversation.
    let resume = session.numTurns > 0;
    if (provider === AgentProvider.CLAUDE && !session.runtimeSessionId) {
      const id = randomUUID();
      await this.prisma.session.update({
        where: { id: session.id },
        data: { runtimeSessionId: id, numTurns: 0 },
      });
      session.runtimeSessionId = id;
      session.numTurns = 0;
      resume = false;
    }
    const runtimeSessionId = session.runtimeSessionId ?? undefined;
    const sessionUuid = runtimeSessionId ?? session.id;
    return {
      sessionId: session.id,
      provider,
      runtimeSessionId,
      leaseOwner: session.inboxLeaseOwner ?? undefined,
      title: session.title,
      prompt: session.prompt,
      // The project directory the runtime runs in comes from the session's workspace.
      workDir: workspace?.workDir ?? undefined,
      // Per-session worktree branch (generated at creation); the runner isolates the
      // session in a `git worktree` on this branch when workDir is a git repo.
      branch: session.branch ?? undefined,
      // Workspace opt-in: auto-`git init` a non-git workDir so it can be isolated.
      autoInitGit: workspace?.autoInitGit ?? undefined,
      // The branch this session merges into — its own recorded target, else the workspace's
      // remembered default (what the status bar's Merge button offers). Lets the runner
      // judge "already merged" against that branch instead of main.
      mergeTarget: session.mergeTarget ?? workspace?.defaultMergeTarget ?? undefined,
      sessionUuid,
      maxSeq,
      resume,
      // Injected into the runtime process so the `orbit mcp` server knows its context.
      agentId: session.workspaceId ?? undefined,
      taskId: session.taskId ?? undefined,
      // Mirror the workspace's orchestration opt-in so the runner injects ORBIT_ALLOW_ORCHESTRATION
      // and `orbit mcp` exposes the session_* tools only for enabled workspaces.
      allowOrchestration: workspace?.enableOrchestration ?? false,
      // Lets `orbit mcp` shrink its wait budget with depth, so a nested session_create(wait)
      // cannot outlast the one waiting on it.
      spawnDepth: session.spawnDepth,
      agent: {
        provider,
        // Resolved above: a per-session override, Runtime default/catalog value (coerced for
        // built-ins so the runner never execs `codex -m claude-*`), or ModelProvider default.
        model: exec.model,
        appendSystemPrompt: workspace?.appendSystemPrompt ?? undefined,
        systemPrompt: workspace?.systemPrompt ?? undefined,
        allowedTools: dispatchAllowedTools(
          provider,
          ALWAYS_ALLOWED_TOOLS,
          workspace?.permissionRules ?? [],
        ),
        disallowedTools: (workspace?.disallowedTools as string[] | null) ?? [],
        // Configured providers still borrow one of these runtimes, so the same runtime-level
        // guard applies to API/MCP/old-client input as it does to built-in identities; their
        // vendor-defined model space is exempt from the Claude allow-list though.
        permissionMode: normalizeBuiltinPermissionMode(
          provider,
          exec.model,
          permissionMode,
          customRow?.enabled === true,
        ),
        // Per-session effort wins; otherwise use the workspace's effort setting.
        // An OpenCode variant is model-defined, so it is only checkable once the assigned
        // runner's catalog is known — an account default carried over from another runtime
        // would otherwise reach the CLI as an unsupported `--variant`.
        effort: normalizeEffortForRuntimeModel(
          provider,
          session.effort ?? workspace?.effort,
          exec.model,
          session.assignedRunner?.modelCatalog,
        ),
        // Includes a custom provider's injected baseUrl/key (else just the workspace's env).
        env: exec.env,
      },
    };
  }
}
