import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EventEmitter } from 'events';
import {
  AgentProvider,
  ClaimedSession,
  PermissionMode,
  fastModeAvailable,
  type RunnerModelCatalog,
} from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { isBuiltinProvider, resolveProviderExec } from '../providers/custom-provider';
import { ProviderPlanUsageService } from '../providers/plan-usage.service';
import { isPoolCandidate, poolUnavailableReason } from '../providers/pool-admission';
import {
  choosePoolMember,
  poolFallbackNotice,
  poolResumesAt,
  poolSwitchNotice,
  selectPoolMember,
} from '../providers/pool-select';
import {
  normalizeBuiltinPermissionMode,
  normalizeEffortForRuntimeModel,
} from '../common/runtime-provider';
import { worktreeOperationFenceSql } from '../common/session-inbox-fence';
import {
  batchActiveTurns,
  runnerActiveTurns,
  treeActiveTurns,
  treeCeiling,
} from '../common/session-tree-sql';
import {
  OPENCODE_RUNNER_UPGRADE_ERROR,
  SOURCE_PROTOCOL_UNSUPPORTED_ERROR,
} from '../runner-api/runner-provider-support';
import { ALWAYS_ALLOWED_TOOLS, resolvePermissionMode } from '../common/permission-mode';
import { orchestrationEnabled } from '../common/orchestration-switch';
import { dispatchAllowedTools } from '../common/permission-rules';
import {
  loggedRetry,
  RUNNER_POLL_TRANSACTION_MAX_WAIT_MS,
  withTransactionRetry,
} from '../common/transaction-retry';
import { RealtimeService } from '../realtime/realtime.service';
import { sessionSourceSnapshot } from '../projects/session-source';
import { currentWatchRollout, watchClaimFields } from '../watches/watch-rollout';
import { currentWikiRollout, wikiClaimFields } from '../wiki/wiki-rollout';

/**
 * Session claim queue backed by the `Session` table. A runner long-polls for the
 * PENDING sessions assigned to it; claims are atomic via `FOR UPDATE SKIP LOCKED`
 * and gated, server-side, on the runner's `maxConcurrent` active turns. Warm/cold
 * idle runtimes are retained independently and do not consume that limit.
 */
@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  private readonly signal = new EventEmitter();

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    /**
     * An account pool's quota, from the cache the provider pickers fill. Nest always provides it
     * (QueueModule imports ProvidersModule); optional only for the specs that construct this service
     * directly, none of whose sessions names a pool.
     */
    private readonly planUsage?: ProviderPlanUsageService,
  ) {
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
    supportsSourcePin = false,
  ): Promise<ClaimedSession | null> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const job = await this.trySessionClaim(runner, supportsTerminalHandoff, supportsSourcePin);
      if (job) return job;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await this.waitForSignal(Math.min(remaining, 5000));
    }
  }

  private async trySessionClaim(
    runner: { id: string; supportedProviders?: readonly AgentProvider[] },
    supportsTerminalHandoff: boolean,
    supportsSourcePin: boolean,
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
    // Retried whole. A claim is a compare-and-set on rows this closure locks and re-reads: an
    // attempt the server discarded claimed nothing, so a re-run competes from the real state. The
    // claimed session is only handed to the runner once this returns.
      const rows = await withTransactionRetry(this.prisma, async (tx) => {
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
          -- A stall this claim just disproved. Both markers are written by a preflight that saw a
          -- runner unable to drive the row and had nothing else to say why it sat there; the row
          -- being claimed IS the answer, so leaving the text behind would make a running session
          -- read as blocked on the machine that is running it.
          error = CASE
            WHEN error IN (${OPENCODE_RUNNER_UPGRADE_ERROR}, ${SOURCE_PROTOCOL_UNSUPPORTED_ERROR}) THEN NULL
            ELSE error
          END,
          "started_at" = COALESCE("started_at", now()),
          "last_turn_at" = now(),
          -- A claim hands this run to a runner; the runtime that will serve it does not exist
          -- yet (cold spawn) or has not been handed the turn yet (warm reuse). Either way the
          -- engine has not spoken for THIS run, which is what the column means — so every
          -- claim clears it and the next engine-produced event stamps it again. Deliberately
          -- unconditional: COALESCE here would leave a resumed session permanently reading
          -- "ready" and hide exactly the cold-start it exists to show.
          "engine_started_at" = NULL,
          -- A phase belongs to a run, and this claim starts a new one. Cleared unconditionally
          -- for the same reason as the column above: a resumed session must not inherit what the
          -- previous run's engine happened to be doing when it stopped.
          "engine_phase" = NULL,
          -- The wait this claim starts is measured from here (0254). Unlike last_turn_at, which
          -- ingest moves on every event carrying a turn id, nothing else writes it.
          "run_claimed_at" = now(),
          "engine_phase_since" = NULL,
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
            -- SR35. A session whose SOURCE was resolved carries a baseline the runner must PIN
            -- before it may create a worktree; a runner that does not declare the source-pin/v1
            -- capability would receive that snapshot, ignore the field it has never heard of, and
            -- fork from the workDir's HEAD — the exact silent baseline this contract removes. So
            -- the row is not offered at all, and it stays PENDING/SELECTED rather than becoming
            -- REFUSED: upgrading a runner (or bringing a newer one online) makes it runnable,
            -- which is not what a configuration error looks like.
            --
            -- UNBOUND is every Legacy session, which is every session that exists today, so this
            -- predicate is invisible to every runner until a Project binds a codebase.
            AND (
              ${supportsSourcePin}::boolean
              OR s."source_state" = 'UNBOUND'
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
            -- runner also fails it via failAbandonedWorktreeOperations). Shared with the
            -- session list, which names this gate to the user, so the two cannot drift.
            AND NOT ${worktreeOperationFenceSql('s')}
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
      }, loggedRetry(this.logger, 'queue.trySessionClaim', {
        // The claim is a long poll too (claimSessionForRunner's deadline), so it queues behind a
        // busy pool rather than failing into the runner's immediate retry — see
        // RUNNER_POLL_TRANSACTION_MAX_WAIT_MS in runner-api.controller.ts.
        transaction: { maxWait: RUNNER_POLL_TRANSACTION_MAX_WAIT_MS },
      }));
      if (rows.length === 0) return null;
      // The PENDING -> RUNNING commit changes the task row's queued/running overlays. Announce it
      // before hydration: buildSession can fail after the claim committed, and in that case there
      // is still a durable state change every connected client must reconcile.
      this.realtime.publishSessionUpdated(rows[0].id);
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
        // `engines` carries the Codex accounts this runner has, which is where the workspace's
        // chosen account resolves to a CODEX_HOME.
        assignedRunner: {
          select: { runtimeDefaultModels: true, modelCatalog: true, runsAsRoot: true, engines: true },
        },
        // The account-level permission default and orchestration switch, which replaced the
        // per-workspace ones.
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
    // Retried whole. The session row an aborted attempt inserted does not exist, so a re-run
    // inserts one session rather than a second — and the capacity fence it commits under is
    // re-evaluated inside the closure on every attempt.
    //
    // An import session has no prompt to seed (it resumes a conversation that already exists in
    // its transcript), and must not gain one: the runner replays the transcript as events inside
    // its first claim, and a seeded turn would hand the engine an empty "user message" instead.
    // Keyed on the durable provenance and not on importSourceCwd, which /import-result clears as
    // soon as the replay lands: the claim that carried the import is not the only one that has to
    // skip this. The claim a first message arrives on is the same session with the same absent
    // prompt, and a seed there would put an empty turn ahead of the person's own — at seq 1,
    // which the message has already taken.
    //
    // And a seed needs a prompt to lay down: the opening turn IS the session's prompt, so a session
    // with none has nothing to put there. `importSession` is the only creator that writes an empty
    // prompt and leaves the seed to this — `create` writes one only for a session opened with
    // attachments alone, and seeds that turn itself — so for a transcript imported before `importedAt`
    // existed to say so durably, that empty prompt is all that is left of what the row is, and
    // reading it here is what reaches those rows. Without that, the claim a first message arrives
    // on seeds a turn behind the person's own: a runner slot spent spawning an engine to read an
    // empty message, and — before the seq below stopped being a constant — a claim that died on
    // @@unique([sessionId, seq]) for the seq the message had already taken, after committing the
    // session to RUNNING.
    if (!session.importedAt && session.prompt !== '') {
      await withTransactionRetry(this.prisma, async (tx) => {
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
        // Allocated from the table, never assumed to be 1. This was the only producer of a
        // conversation turn that hardcoded a seq; every other one reads max(seq)+1 for the same
        // reason — sessions.insertTurnLocked, the reaper's `end` turn, and the runner's acceptance
        // shell turn — and the message a first claim arrives on has already taken seq 1 by the time
        // this runs.
        const last = await tx.conversationTurn.findFirst({
          where: { sessionId: session.id },
          orderBy: { seq: 'desc' },
          select: { seq: true },
        });
        const turn = await tx.conversationTurn.create({
          data: {
            sessionId: session.id,
            seq: (last?.seq ?? 0) + 1,
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
      }, loggedRetry(this.logger, 'queue.buildSession'));
    }
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
    // user could burn another tenant's key by naming their slug. A slug no provider holds may be one
    // of the owner's account pools, which dispatches as the member chosen for this claim.
    const declaredIsBuiltin = isBuiltinProvider(declared, session.providerBuiltin);
    const customRow = declaredIsBuiltin
      ? null
      : ((await this.prisma.modelProvider.findFirst({
          where: { slug: declared!, OR: [{ ownerId: null }, { ownerId: session.ownerId }] },
        })) ?? (await this.resolvePoolMember(this.prisma, session, declared!)));
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
        codexAccount: workspace?.codexAccount,
        runnerEngines: session.assignedRunner?.engines,
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
    // An imported session's conversation is already on disk — the runner placed the transcript
    // as its first claim's work — so the spawn must resume it, and none of this session's claims
    // has settled a turn (an import settles none, and its own claim spawns no engine). The
    // durable provenance says so where numTurns=1 used to stand in for it: read there, that fake
    // turn was indistinguishable from a real one everywhere else numTurns is consulted.
    let resume = session.numTurns > 0 || session.importedAt != null;
    if (provider === AgentProvider.CLAUDE && !session.runtimeSessionId) {
      const id = randomUUID();
      await this.prisma.session.update({
        where: { id: session.id },
        data: { runtimeSessionId: id, numTurns: 0 },
      });
      session.runtimeSessionId = id;
      session.numTurns = 0;
      resume = false;
    } else if (provider === AgentProvider.CLAUDE && !resume && session.runtimeSessionId) {
      // numTurns alone understates what Claude has already opened: it only advances when a
      // turn settles through turn-complete, and a turn still in flight when the session ends
      // is drained to ANSWERED without it (finalizeRun). A session ended mid-turn therefore
      // keeps numTurns at 0 over a conversation that exists — and a first spawn on an id
      // Claude has already used is refused outright ("Session ID ... is already in use"),
      // failing that run and every message sent after it. The runtime stamps the id it opened
      // on its own events, which is the evidence --resume is the right flag here.
      resume = await this.claudeConversationOpened(session.id, session.runtimeSessionId);
    }
    const runtimeSessionId = session.runtimeSessionId ?? undefined;
    const sessionUuid = runtimeSessionId ?? session.id;
    // §6.3 step 1: hand the runner the frozen SOURCE snapshot. `undefined` for a Legacy session —
    // and that absence is the compatibility guarantee, not an omission: it is exactly the payload
    // every runner has always received, so nothing about their behaviour changes (SR46).
    const source = sessionSourceSnapshot(session, await this.sourceBinding(session.sourceCodebaseId));
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
      // Non-null = import PENDING: the runner performs the transcript import step inside this
      // claim (copy + event replay + /import-result) before spawning the engine.
      importSourceCwd: session.importSourceCwd ?? undefined,
      // …and this claim is the import and nothing else: /import-result parks the session at
      // AWAITING_INPUT (the only place that can — this claim carries no turn), so the runner
      // settles it and goes cold instead of warming an engine nothing has spoken to. Sent
      // separately from the marker above so a runner meeting an older control plane keeps
      // spawning: there /import-result does not park, and the engine is what keeps the session
      // reachable for the next message.
      importOnly: session.importSourceCwd != null,
      // Injected into the runtime process so the `orbit mcp` server knows its context.
      agentId: session.workspaceId ?? undefined,
      // §13.8: a conversation ABOUT a task needs the same tool context as one executing it — the
      // agent is asked to call `task_get` and `task_comment`, and both default to `ORBIT_TASK_ID`.
      // Only the tool default: `context_task_id` takes no execution claim, occupies no slot and is
      // invisible to the reaper, which is exactly why the two columns are separate.
      taskId: session.taskId ?? session.contextTaskId ?? undefined,
      // Mirror the owner's Session orchestration switch so the runner injects
      // ORBIT_ALLOW_ORCHESTRATION and `orbit mcp` exposes the session_* tools only while it is on.
      allowOrchestration: workspace != null && orchestrationEnabled(session.owner),
      // Absent while Watch is on for the owner, the payload runners have always had; `watchesDisabled` otherwise, so
      // the runner spawns the session without the watch tools (docs/watch-rollout.md).
      ...watchClaimFields(currentWatchRollout(), session.ownerId),
      // The same for the wiki (ORBIT_WIKI, wiki/wiki-rollout.ts): `wikiDisabled` when it is not on for the owner, so
      // the runner spawns the session without the wiki tools.
      ...wikiClaimFields(currentWikiRollout(), session.ownerId),
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
        // The root check rides along here for the same reason: a Bypass default reaching a root
        // runner is a session that exits during startup, and this is the last place before it does.
        permissionMode: normalizeBuiltinPermissionMode(
          provider,
          exec.model,
          permissionMode,
          customRow?.enabled === true,
          session.assignedRunner?.runsAsRoot,
          session.assignedRunner?.modelCatalog,
        ),
        // Whether the fast lane is actually on. Policed HERE rather than where it was picked,
        // for the same reason an OpenCode variant is: the constraint is about the model this
        // session dispatches with, which a create request that named none does not know. A
        // session carrying the flag onto a model with no fast lane runs without it — both engines
        // would drop the setting in silence anyway (Claude ignores the key, Codex omits a tier its
        // catalogue does not advertise), and the runner would have sent something that does
        // nothing. For Codex the catalogue is this runner's own report, the same row the picker
        // drew the pill from.
        fastMode:
          session.fastMode &&
          fastModeAvailable(provider, exec.model, session.assignedRunner?.modelCatalog as RunnerModelCatalog | null),
        // Per-session effort wins; otherwise use the workspace's effort setting.
        // An OpenCode variant is model-defined, so it is only checkable once the assigned
        // runner's catalog is known — an account default carried over from another runtime
        // would otherwise reach the CLI as an unsupported `--variant`. A configured model that
        // declares the levels it accepts is held to them the same way.
        effort: normalizeEffortForRuntimeModel(
          provider,
          session.effort ?? workspace?.effort,
          exec.model,
          session.assignedRunner?.modelCatalog,
          exec.reasoningLevels,
        ),
        // Includes a custom provider's injected baseUrl/key (else just the workspace's env).
        env: exec.env,
      },
      source,
    };
  }

  /**
   * When work on `slug` can next go to one of `ownerId`'s account pools, for the brakes that hold work
   * back instead of claiming it: TasksService.quotaGate, AutoRetryService's sweep, and the retry
   * RunnerApiController arms when a quota ends a turn. A pool's slug is in no runner's quota snapshot, so
   * each of them would otherwise read the pool as a quota it cannot see, and wait out a flat backoff or
   * one member's reset while another member has room.
   *
   * `now` while a member has room, the earliest member reset while every member is spent, and null when
   * `slug` is no pool of `ownerId` or the pool reports nothing to go by (pool-select.ts poolResumesAt).
   * Read from the members and the quota cache the claim below picks from, so a brake does not release
   * work the claim would then send to an account known to be spent.
   */
  async accountPoolResumesAt(ownerId: string, slug: string, now: Date): Promise<Date | null> {
    // A built-in engine is never a pool, and with no quota cache there is nothing to judge one by.
    if (!this.planUsage || isBuiltinProvider(slug)) return null;
    const pool = await this.accountPool(ownerId, slug);
    return pool ? poolResumesAt(pool.candidates, now) : null;
  }

  /**
   * Why `slug`, one of `ownerId`'s account pools, can take no session at all — it has no members, or
   * none that can run (selectPoolMember's UNAVAILABLE: each disabled, turned away by the pool's
   * admission, or refused by the endpoint) — or null when one can, or when `slug` names no pool of
   * theirs. The doors that write a provider onto a session or a task refuse such a pool with this:
   * taken, its claim could only run on the Claude default, the runner's own login.
   *
   * A pool whose members are all spent is not refused. It waits for the first of them to reset, as
   * the claim and the brakes above already make it.
   */
  async accountPoolRefusal(
    ownerId: string,
    slug: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<string | null> {
    const pool = await this.accountPool(ownerId, slug, db);
    if (!pool || selectPoolMember(pool.candidates, null, new Date()).kind !== 'UNAVAILABLE') return null;
    return poolUnavailableReason(pool.label, pool.rows);
  }

  /**
   * `ownerId`'s account pool on `slug`: its name, its member rows, and the ones a claim may choose from
   * (isPoolCandidate) as candidates with their quota as the cache has it. Null when `slug` names no pool
   * of theirs.
   */
  private async accountPool(ownerId: string, slug: string, db: Prisma.TransactionClient = this.prisma) {
    const pool = await db.providerPool.findFirst({
      where: { slug, ownerId },
      select: {
        label: true,
        members: {
          where: { ownerId },
          orderBy: { provider: { slug: 'asc' } },
          select: { provider: true },
        },
      },
    });
    if (!pool) return null;
    const rows = pool.members.map((member) => member.provider);
    // A member no claim may choose is no candidate, and nobody asks after its quota.
    const candidates = rows
      .filter(isPoolCandidate)
      .map((row) => ({
        row,
        usage: this.planUsage?.snapshot(row) ?? null,
        refused: this.planUsage?.refused(row) ?? false,
      }));
    return { label: pool.label, rows, candidates };
  }

  /**
   * The member an account pool dispatches this claim on (providers/pool-select.ts), or null when `slug`
   * names no pool of this session's owner or none of its members can run. Null dispatches as a deleted
   * provider does, on the Claude default, so a pool deleted or emptied under a session never fails the
   * claim.
   *
   * A pool is personal: only its owner's sessions resolve it, or naming its slug would spend another
   * user's keys. The member chosen is recorded on the session, which is what the next claim stays on,
   * and a move off another member records the line the transcript owes for it — carried by the next
   * engine start event the runner reports (RunnerApiController.events). So does a claim that finds the
   * pool with no member that can run: every one of those starts an engine on the runner's own login, and
   * says so — naming the pool — rather than leave that to be discovered from a quota that never moved.
   * It records no member, since the run is on none of them.
   *
   * Every door that builds a pool session's engine environment resolves it here — this claim, the
   * reclaim a restarted runner rebuilds the session from, and the reload a provider switch re-spawns it
   * with (RunnerApiController) — so none of them lands on another member, or on the runner's own login.
   * `db` is the caller's client: the reload runs inside the transaction that holds this session's row.
   */
  async resolvePoolMember(
    db: Prisma.TransactionClient | PrismaService,
    session: { id: string; ownerId: string; poolMemberProviderId: string | null },
    slug: string,
  ) {
    const pool = await this.accountPool(session.ownerId, slug, db);
    if (!pool) return null;
    const now = new Date();
    const { rows, candidates } = pool;
    const chosen = choosePoolMember(candidates, session.poolMemberProviderId, now);
    if (!chosen) {
      await db.session.update({
        where: { id: session.id },
        data: { poolMemberProviderId: null, poolSwitchNotice: poolFallbackNotice(pool) },
      });
      return null;
    }
    if (chosen.id === session.poolMemberProviderId) return chosen;
    const previous = rows.find((row) => row.id === session.poolMemberProviderId);
    const standing = candidates.find((candidate) => candidate.row.id === previous?.id);
    await db.session.update({
      where: { id: session.id },
      data: {
        poolMemberProviderId: chosen.id,
        // The first member a session runs on is where it starts, not a move.
        ...(session.poolMemberProviderId
          ? {
              poolSwitchNotice: poolSwitchNotice(
                chosen,
                previous
                  ? {
                      label: previous.label,
                      enabled: previous.enabled,
                      usage: standing?.usage ?? null,
                      refused: standing?.refused ?? false,
                    }
                  : null,
                now,
              ),
            }
          : {}),
      },
    });
    return chosen;
  }

  /**
   * How to ASK the authority, read live — as opposed to WHAT is being asked, which is frozen on the
   * session row (§3.2's nine columns).
   *
   * The remote's local name and the machine a `RUNNER_LOCAL` authority names are not part of the
   * frozen selector, so they are read from the binding at claim time. A binding that has since been
   * deleted returns null and the snapshot falls back to `origin`: `sourceCodebaseId` carries no
   * foreign key precisely so that deleting a binding cannot rewrite a snapshot already frozen
   * against it, which means this lookup has to tolerate the row being gone.
   */
  private async sourceBinding(
    codebaseId: string | null,
  ): Promise<{ remoteName: string; authorityRunnerId: string | null } | null> {
    if (!codebaseId) return null;
    return this.prisma.projectCodebase.findUnique({
      where: { id: codebaseId },
      select: { remoteName: true, authorityRunnerId: true },
    });
  }

  /**
   * Has a Claude process ever run on this runtime session id? Every event Claude streams
   * carries the id of the conversation it opened, so one such event means the local session
   * file exists (and if this runner is not the machine that has it, the runner rebuilds it
   * from Orbit's events before resuming — see transcript_rebuild.go).
   *
   * Ordered by seq so the lookup walks the session's events from the start: the runtime's
   * `init` is the second event of a run, so the match is found immediately.
   */
  private async claudeConversationOpened(
    sessionId: string,
    runtimeSessionId: string,
  ): Promise<boolean> {
    const opened = await this.prisma.runEvent.findFirst({
      where: {
        sessionId,
        type: 'system',
        payload: { path: ['sessionId'], equals: runtimeSessionId },
      },
      orderBy: { seq: 'asc' },
      select: { id: true },
    });
    return opened !== null;
  }
}
