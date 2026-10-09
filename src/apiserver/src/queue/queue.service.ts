import { randomUUID } from 'crypto';
import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma, type ManagedRunnerManagementState } from '@prisma/client';
import { EventEmitter } from 'events';
import {
  AgentProvider,
  isAccountEngine,
  ClaimedSession,
  PermissionMode,
  fastModeAvailable,
  openCodeKeyOf,
  type PlanUsageSnapshot,
  type RunnerModelCatalog,
} from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { codexPoolUnavailableReason } from '../providers/codex-login';
import { loginCanRun, loginPoolResumesAt, loginRunsAgainAt, type LoginAccount } from '../providers/pool-login-select';
import { choosePoolCredential } from '../providers/pool-credential-select';
import {
  accountPoolRuntime,
  adminOnlyProviderRefusal,
  isBuiltinProvider,
  openCodeKeyRows,
  resolveProviderExec,
  runsOnOpenCode,
  usableProviderScope,
  usableProviderSql,
  type ModelProviderRow,
} from '../providers/custom-provider';
import { ProviderPlanUsageService } from '../providers/plan-usage.service';
import { isPoolCandidate, poolUnavailableReason } from '../providers/pool-admission';
import { keyCanRun, keyRunsAgainAt, poolKeysResumeAt } from '../providers/pool-key-select';
import {
  mintPoolGatewayToken,
  mintPoolLoginToken,
  sharedPoolExecRow,
  sharedPoolKeyCandidates,
  sharedPoolUnavailableReason,
} from '../providers/shared-pool';
import { PoolNotices } from '../providers/pool-notice';
import { ACCOUNT_MOVE_CAPABILITY } from '../providers/account-move-capability';
import {
  accountBeforeDispatch,
  accountSwitchNotice,
  sessionAccountPausedUntil,
  type WorkspaceAccountChoices,
} from '../providers/plan-usage-accounts';
import { ACCOUNT_CHOICE, ACCOUNT_PINNED } from '../providers/account';
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
  ADMIN_ONLY_PROVIDER_ERROR,
  ANTIGRAVITY_RUNNER_UPGRADE_ERROR,
  DSH_NOT_INSTALLED_ERROR,
  DSH_PLATFORM_UNSUPPORTED_ERROR,
  DSH_RUNNER_UPGRADE_ERROR,
  DSH_VERSION_INCOMPATIBLE_ERROR,
  OPENCODE_RUNNER_UPGRADE_ERROR,
  PROVIDER_UNAVAILABLE_ERROR,
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
import { branchName } from '../projects/project-criterion-landing';
import {
  wikiMaintenanceRunOf,
  wikiMaintenanceSessionSql,
  withWikiMaintenanceRun,
} from '../wiki/wiki-maintenance-session';
import { managedRunnerInstanceClaimable, type ManagedRunnerInstance } from '../managed-runners/managed-runner-instance';

/** The runner asking for work, as the claim route knows it. */
export interface ClaimingRunner {
  id: string;
  supportedProviders?: readonly AgentProvider[];
  dshUnavailable?: string | null;
  /** The managed runner instance the runner guard authorized; absent for a self-managed runner. */
  managedInstance?: ManagedRunnerInstance;
}

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

  private waitForSignal(timeoutMs: number, hungUp?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.signal.off('queued', done);
        hungUp?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.signal.once('queued', done);
      hungUp?.addEventListener('abort', done, { once: true });
    });
  }

  /**
   * `hungUp` is the runner's connection closing. A claim committed after it moves the row
   * PENDING -> RUNNING for a process that is no longer listening: nobody takes it over, and nothing
   * on this side ever puts it back. On 2026-10-03 the long poll a self-updating runner had left
   * open claimed a task's session 4s after the runner re-executed, and it read "Starting" for 15
   * minutes — until an unrelated failed claim made the new process reconcile.
   */
  async claimSessionForRunner(
    runner: ClaimingRunner,
    waitMs = 0,
    supportsTerminalHandoff = false,
    supportsSourcePin = false,
    supportsWikiMaintenance = false,
    hungUp?: AbortSignal,
  ): Promise<ClaimedSession | null> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      if (hungUp?.aborted) return null;
      const job = await this.trySessionClaim(runner, supportsTerminalHandoff, supportsSourcePin, supportsWikiMaintenance, hungUp);
      if (job) return job;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await this.waitForSignal(Math.min(remaining, 5000), hungUp);
    }
  }

  /** Evaluate pauses before the short global claim lock. The inbox rechecks after claim,
   * so a concurrent pause cannot leak a new turn; paused rows never occupy runner capacity.
   * `dshUnavailable` is why a runner that declares dsh cannot start it (dshRuntimeUnavailable):
   * its dsh rows are held with that notice too, until a heartbeat reports the CLI ready. */
  private async pausedPendingSessions(
    runnerId: string, supportsWikiMaintenance: boolean, dshUnavailable?: string | null,
  ): Promise<string[]> {
    const now = new Date();
    const pending = await this.prisma.session.findMany({
      where: {
        assignedRunnerId: runnerId, status: 'PENDING', cancelRequestedAt: null,
        OR: [
          { providerBuiltin: false },
          { assignedRunner: { accountPauses: { not: Prisma.DbNull } } },
          ...(dshUnavailable ? [{ provider: AgentProvider.DSH, providerBuiltin: true }] : []),
          // An OpenCode session on one of the owner's configured keys (shared `openCodeKeys`).
          { provider: AgentProvider.OPENCODE, model: { startsWith: 'orbit-' } },
        ],
      },
      select: {
        id: true, ownerId: true, provider: true, providerBuiltin: true, error: true, model: true,
        codexAccount: true, codexAccountPinned: true, claudeAccount: true, claudeAccountPinned: true,
        antigravityAccount: true, antigravityAccountPinned: true,
        workspace: { select: { env: true, codexAccount: true, claudeAccount: true, antigravityAccount: true } },
        assignedRunner: { select: { engines: true, accountPauses: true, planUsage: true, capabilities: true } },
      },
    });
    const blocked: string[] = [];
    const poolPauses = new Map<string, Date | null>();
    for (const session of pending) {
      const runner = session.assignedRunner;
      let until = runner ? sessionAccountPausedUntil(session, session.workspace, runner, now) : null;
      const engine = session.provider;
      let unavailable = false;
      // What an unavailable session waits with: a member's session on a shared provider is told who can
      // run it (ADMIN_ONLY_PROVIDER_ERROR) rather than to check a configuration that is not theirs.
      let unavailableError = PROVIDER_UNAVAILABLE_ERROR;
      let dshHeld = !!dshUnavailable && session.providerBuiltin && engine === AgentProvider.DSH;
      if (until && runner && isAccountEngine(engine)) {
        const canMove = runner.capabilities.includes(ACCOUNT_MOVE_CAPABILITY[engine]);
        const move = canMove && accountBeforeDispatch(engine, {
          account: session[ACCOUNT_CHOICE[engine]],
          pinned: session[ACCOUNT_PINNED[engine]],
        }, session.workspace, runner.engines, runner.planUsage, now, runner.accountPauses);
        if (move) until = null;
      }
      if (!isBuiltinProvider(engine, session.providerBuiltin) && engine) {
        const provider = await this.prisma.modelProvider.findFirst({
          where: { slug: engine, ...(await usableProviderScope(this.prisma, session.ownerId)) },
          select: { enabled: true, runtime: true },
        });
        unavailable = provider
          ? !provider.enabled || !['claude', 'codex', 'kimi', 'antigravity', 'dsh'].includes(provider.runtime)
          : !await accountPoolRuntime(this.prisma, session.ownerId, engine);
        if (unavailable && !provider && await adminOnlyProviderRefusal(this.prisma, session.ownerId, engine)) {
          unavailableError = ADMIN_ONLY_PROVIDER_ERROR;
        }
        dshHeld = !!dshUnavailable && provider?.runtime === AgentProvider.DSH;
        // A Wiki maintenance session is not held for it by a runner that declares wiki-maintenance-run/v1: the
        // claim hands it over with its refusal (wiki/wiki-maintenance-session.ts), which that runner ends FAILED
        // without starting any engine. Held here, it would wait PENDING for good, and its space's maintenance with it.
        if (unavailable && supportsWikiMaintenance) {
          const maintained = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            SELECT s.id FROM "session" s WHERE s.id = ${session.id}::uuid AND ${wikiMaintenanceSessionSql('s')}`);
          if (maintained.length > 0) unavailable = false;
        }
        const key = `${session.ownerId}:${engine}`;
        if (!poolPauses.has(key)) poolPauses.set(key, await this.accountPoolPausedUntil(session.ownerId, engine, now));
        until = poolPauses.get(key) ?? null;
      }
      // The key an OpenCode model names has to be there to run it on: gone, disabled or not one
      // OpenCode may spend, the session waits with the same reason a configured provider's does,
      // rather than being claimed and refused by resolveProviderExec.
      const openCodeKey = engine === AgentProvider.OPENCODE ? openCodeKeyOf(session.model) : null;
      if (openCodeKey) {
        const row = await this.prisma.modelProvider.findFirst({
          where: { slug: openCodeKey.slug, ...(await usableProviderScope(this.prisma, session.ownerId)) },
          select: { enabled: true, runtime: true, apiKeyEnc: true },
        });
        unavailable = !row || !runsOnOpenCode(row);
        if (!row && await adminOnlyProviderRefusal(this.prisma, session.ownerId, openCodeKey.slug)) {
          unavailableError = ADMIN_ONLY_PROVIDER_ERROR;
        }
      }
      if (!until && !unavailable && !dshHeld) continue;
      blocked.push(session.id);
      const error = unavailable
        ? unavailableError
        : until ? `Account paused until ${until.toISOString()}` : dshUnavailable!;
      if (session.error !== error) {
        const updated = await this.prisma.session.updateMany({
          where: { id: session.id, status: 'PENDING' }, data: { error },
        });
        if (updated.count) this.realtime.publishSessionUpdated(session.id);
      }
    }
    return blocked;
  }

  /** The mapping row under FOR SHARE, and whether `instance` may still be handed work. */
  private async managedInstanceClaimable(tx: Prisma.TransactionClient, instance: ManagedRunnerInstance): Promise<boolean> {
    const [mapping] = await tx.$queryRaw<Array<{
      id: string;
      generation: number;
      podUid: string | null;
      managementState: ManagedRunnerManagementState;
    }>>`SELECT id::text AS id, generation, pod_uid AS "podUid", management_state::text AS "managementState"
        FROM managed_runner WHERE id = ${instance.mappingId}::uuid FOR SHARE`;
    return managedRunnerInstanceClaimable(mapping ?? null, instance);
  }

  private async trySessionClaim(
    runner: ClaimingRunner,
    supportsTerminalHandoff: boolean,
    supportsSourcePin: boolean,
    supportsWikiMaintenance: boolean,
    hungUp?: AbortSignal,
  ): Promise<ClaimedSession | null> {
    const supportsOpenCode = runner.supportedProviders?.includes(AgentProvider.OPENCODE) ?? false;
    const supportsAntigravity = runner.supportedProviders?.includes(AgentProvider.ANTIGRAVITY) ?? false;
    // A runner that declares dsh but whose engine report does not show the CLI ready
    // (RunnerApiController.claim, dshRuntimeUnavailable) is withheld dsh rows like one that does not.
    const supportsDsh = (runner.supportedProviders?.includes(AgentProvider.DSH) ?? false) && !runner.dshUnavailable;
    const paused = await this.pausedPendingSessions(runner.id, supportsWikiMaintenance, runner.dshUnavailable);
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
        // Migrations 0080, 0367 and 0377 install database triggers so an older apiserver replica cannot
        // claim OpenCode, Antigravity or dsh as Claude during a rolling control-plane deploy (0372
        // widened the Antigravity one to the configured rows that borrow it). These
        // transaction-local capabilities are the positive signal that lets only the new, capable
        // path pass. One statement sets all three inside the global claim lock above.
        await tx.$executeRaw`SELECT set_config('orbit.runner_supports_opencode', ${supportsOpenCode ? '1' : '0'}, true), set_config('orbit.runner_supports_antigravity', ${supportsAntigravity ? '1' : '0'}, true), set_config('orbit.runner_supports_dsh', ${supportsDsh ? '1' : '0'}, true)`;
        // Asked again here, after the waits for a connection and for the lock above (up to 20s
        // under a busy pool): the runner may have hung up during them.
        if (hungUp?.aborted) return [];
        // A managed runner is handed work only while the instance that asked is still the one the
        // manager authorizes, and not draining (managed-runner-instance.ts). The guard answered when
        // the long poll began; this answers at the claim itself. FOR SHARE: a fencing or generation
        // advance that committed first is seen here, and one that comes later waits for this claim.
        if (runner.managedInstance && !(await this.managedInstanceClaimable(tx, runner.managedInstance))) return [];
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
            WHEN error IN (
              ${OPENCODE_RUNNER_UPGRADE_ERROR},
              ${ANTIGRAVITY_RUNNER_UPGRADE_ERROR},
              ${DSH_RUNNER_UPGRADE_ERROR},
              ${DSH_NOT_INSTALLED_ERROR},
              ${DSH_PLATFORM_UNSUPPORTED_ERROR},
              ${DSH_VERSION_INCOMPATIBLE_ERROR},
              ${PROVIDER_UNAVAILABLE_ERROR},
              ${ADMIN_ONLY_PROVIDER_ERROR},
              ${SOURCE_PROTOCOL_UNSUPPORTED_ERROR}
            ) OR error LIKE 'Account paused until %' THEN NULL
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
            AND NOT (s.id = ANY(${paused}::uuid[]))
            AND s."cancel_requested_at" IS NULL
            AND s."assigned_runner_id" = ${runnerId}
            -- An unresolved/disabled configured identity must never become a Claude job. A Wiki maintenance
            -- session does not become one: a runner that declares wiki-maintenance-run/v1 is handed it with its
            -- refusal and no provider (buildSession), and ends it FAILED without starting any engine. A shared
            -- provider resolves for an admin's session only (usableProviderScope): a member's is never claimed.
            AND (
              COALESCE(s.provider, 'claude') IN ('claude', 'codex', 'opencode', 'antigravity')
              OR (s."provider_builtin" AND s.provider IN ('kimi', 'dsh'))
              OR (NOT s."provider_builtin" AND (
                EXISTS (
                  SELECT 1 FROM "model_provider" mp
                  WHERE mp.slug = s.provider AND mp.enabled
                    AND mp.runtime IN ('claude', 'codex', 'kimi', 'antigravity', 'dsh')
                    AND ${usableProviderSql('mp', Prisma.raw('s.owner_id'))}
                ) OR EXISTS (
                  SELECT 1 FROM "provider_pool" pp
                  WHERE pp.slug = s.provider AND (
                    (pp.owner_id = s.owner_id AND NOT pp.shared)
                    OR (pp.engine = 'codex' AND EXISTS (
                      SELECT 1 FROM "provider_pool_person" person
                      WHERE person.pool_id = pp.id AND person.user_id = s.owner_id
                    ))
                  )
                )
              ))
              OR (${supportsWikiMaintenance}::boolean AND ${wikiMaintenanceSessionSql('s')})
            )
            -- Both the request and the heartbeat must declare Harness. The database trigger
            -- repeats this so a legacy API transaction cannot bypass the capability gate.
            AND (
              NOT ((s.provider = 'dsh' AND s."provider_builtin") OR EXISTS (
                SELECT 1 FROM "model_provider" mp
                WHERE NOT s."provider_builtin" AND mp.slug = s.provider AND mp.runtime = 'dsh'
                  AND ${usableProviderSql('mp', Prisma.raw('s.owner_id'))}
              )) OR (${supportsDsh} AND EXISTS (
                SELECT 1 FROM "runner" r WHERE r.id = ${runnerId}
                  AND r."capabilities_reported_at" IS NOT NULL
                  AND 'provider:dsh' = ANY(r.capabilities)
              ))
            )
            -- Legacy runners treat an unknown provider as Claude. Require a positive OpenCode
            -- capability advertisement so an upgraded server can never dispatch one of these
            -- rows to a pre-0.1.82 process during a rolling release.
            AND (
              ${supportsOpenCode}
              OR COALESCE(s.provider, 'claude') <> 'opencode'
            )
            -- The same gate for Antigravity (migration 0367): every runner shipped before one
            -- that advertises it reads the slug as Claude.
            AND (
              ${supportsAntigravity}
              OR COALESCE(s.provider, 'claude') <> 'antigravity'
            )
            -- …and for a configured provider that borrows Antigravity (a Gemini key): the slug is
            -- the row's own, but the runner is handed an antigravity job all the same. The rows
            -- dispatch resolves, an enabled one the session's owner may use (providerSlugsOn);
            -- migration 0372's trigger still counts every shared row, which can only refuse a
            -- claim this statement never makes.
            AND (
              ${supportsAntigravity}
              OR NOT EXISTS (
                SELECT 1 FROM "model_provider" mp
                WHERE mp."slug" = s.provider
                  AND mp."runtime" = 'antigravity'
                  AND NOT (s.provider = 'dsh' AND s."provider_builtin")
                  AND mp."enabled"
                  AND ${usableProviderSql('mp', Prisma.raw('s."owner_id"'))}
              )
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
            -- The same refusal for a Wiki maintenance session (wiki/wiki-maintenance-session.ts): it is
            -- started clean, pinned and bounded, and a runner that does not declare wiki-maintenance-run/v1
            -- would start it as an ordinary session instead. It waits for a runner that can.
            AND (
              ${supportsWikiMaintenance}::boolean
              OR NOT ${wikiMaintenanceSessionSql('s')}
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
      try {
        return await this.buildSession(rows[0].id);
      } catch (error: any) {
        const refusal = error?.getResponse?.();
        if (refusal?.code !== 'POOL_ACCOUNT_PAUSED') throw error;
        await this.prisma.session.updateMany({
          where: { id: rows[0].id, status: 'RUNNING' },
          data: { status: 'PENDING', error: `Account paused until ${refusal.pausedUntil}` },
        });
        this.realtime.publishSessionUpdated(rows[0].id);
        return null;
      }
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

  /**
   * The Codex and Claude accounts a claim builds `session`'s engine on: its own, else its workspace's.
   *
   * On Automatic — nobody pinned it, and its workspace leaves the account to Orbit — one its runner's
   * own snapshot already reports spent is left first, for one with room (accountBeforeDispatch), when
   * the runner can carry the conversation there. Before, the engine was built on it anyway, its first
   * turn failed on the usage limit, and only then did the turn-complete or events path make this same
   * move and the retry sweep send the message again: a failed start and up to a sweep's wait, for a
   * reset time the snapshot had already stated.
   *
   * The move is a compare-and-set on the account the claim read, so a pick made in between wins; it owes
   * the transcript its line (the one a failure's move says), which the engine this claim starts carries
   * on its first event.
   */
  private async accountsForClaim(session: {
    id: string;
    provider: string | null;
    providerBuiltin: boolean;
    codexAccount: string | null;
    codexAccountPinned: boolean;
    claudeAccount: string | null;
    claudeAccountPinned: boolean;
    antigravityAccount: string | null;
    antigravityAccountPinned: boolean;
    workspace: ({ env: unknown } & WorkspaceAccountChoices) | null;
    assignedRunner: { engines: unknown; accountNames: unknown; accountPauses?: unknown; planUsage: unknown; capabilities: string[] } | null;
  }): Promise<WorkspaceAccountChoices> {
    const workspace = session.workspace;
    const accounts: WorkspaceAccountChoices = {
      codexAccount: session.codexAccount ?? workspace?.codexAccount,
      claudeAccount: session.claudeAccount ?? workspace?.claudeAccount,
      antigravityAccount: session.antigravityAccount ?? workspace?.antigravityAccount,
    };
    const engine = isAccountEngine(session.provider) ? session.provider : null;
    const runner = session.assignedRunner;
    if (!engine || !isBuiltinProvider(session.provider, session.providerBuiltin) || !runner) return accounts;
    if (!(runner.capabilities ?? []).includes(ACCOUNT_MOVE_CAPABILITY[engine])) return accounts;
    const column = ACCOUNT_CHOICE[engine];
    const own = session[column];
    const move = accountBeforeDispatch(
      engine,
      { account: own, pinned: session[ACCOUNT_PINNED[engine]] },
      workspace,
      runner.engines,
      runner.planUsage,
      new Date(),
      runner.accountPauses,
    );
    if (!move) return accounts;
    const { count } = await this.prisma.session.updateMany({
      where: { id: session.id, [column]: own, [ACCOUNT_PINNED[engine]]: false },
      data: { [column]: move.to },
    });
    if (count === 0) return accounts;
    // Owed only when no other line is: one already owed (a pool's) is said first, as PoolNotices.owe keeps it.
    await this.prisma.session.updateMany({
      where: { id: session.id, poolSwitchNotice: null },
      data: { poolSwitchNotice: accountSwitchNotice(engine, move, runner) },
    });
    // A resident engine still holds the previous account's environment. Reload before
    // the next message so a pause cannot be bypassed by reusing that warm process.
    if (move.paused) await new PoolNotices(this.prisma, this.realtime).carrier(session.id, engine);
    return { ...accounts, [column]: move.to };
  }

  private async buildSession(sessionId: string): Promise<ClaimedSession> {
    const session = await this.prisma.session.findUniqueOrThrow({
      where: { id: sessionId },
      include: {
        // The workspace's standing "always allow" grants ride along: they are what turns an
        // approval a human already answered into one this session never has to ask again.
        workspace: { include: { permissionRules: { orderBy: { createdAt: 'asc' } } } },
        task: {
          select: {
            codeless: true,
            project: {
              select: {
                codebases: {
                  where: { slot: 'primary' },
                  select: { integrationRef: true },
                  take: 1,
                },
              },
            },
          },
        },
        // `engines` carries the Codex and Claude accounts this runner has, which is where the chosen
        // account resolves to a CODEX_HOME or a CLAUDE_CONFIG_DIR.
        assignedRunner: {
          select: {
            runtimeDefaultModels: true,
            modelCatalog: true,
            runsAsRoot: true,
            engines: true,
            // What naming the account it moves to reads (accountSwitchNotice).
            accountNames: true,
            accountPauses: true,
            // What moving it off a spent account before this start reads (accountsForClaim).
            planUsage: true,
            capabilities: true,
          },
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
    const taskIntegrationRef = session.task && !session.task.codeless
      ? session.task.project?.codebases[0]?.integrationRef
      : null;
    // The account this start builds the engine on — moved first off one the runner's own snapshot
    // already reports spent, on Automatic, rather than after the engine's first turn fails there.
    const accounts = await this.accountsForClaim(session);
    // A Wiki maintenance session's run (wiki/wiki-maintenance-session.ts), null for every other session.
    const maintenance = await wikiMaintenanceRunOf(this.prisma, session);
    // One that may not start is built on no provider at all: the runner ends it FAILED with its refusal and
    // starts no engine, so it is handed no provider's endpoint or key — not its pin's, not a pool member's —
    // and its row is not given a model it never ran.
    const refused = maintenance?.refusal !== undefined;
    const declared = refused ? AgentProvider.CLAUDE : session.provider ?? null;
    const declaredProviderBuiltin = refused || session.providerBuiltin;
    // A configured (custom) provider borrows a built-in runtime: resolve the runner-facing
    // built-in provider, model, and process env (baseUrl + decrypted key injected)
    // here, so the runner receives a plain claude/codex job and needs no changes. Ownership
    // scope: a personal (BYOK) provider resolves only for its owner's sessions — otherwise a
    // user could burn another tenant's key by naming their slug — and a shared one only for an
    // admin's (usableProviderScope). A slug no provider holds may be one
    // of the owner's account pools, which dispatches as the member chosen for this claim — or, for a Codex
    // pool of their own, through the pool gateway on the ChatGPT login it holds — or a shared pool the
    // owner is in, which dispatches through the pool gateway; each on a token minted for this claim.
    const declaredIsBuiltin = isBuiltinProvider(declared, declaredProviderBuiltin);
    // A maintenance run is never dispatched through a pool: it has no member to fall back on (its refusal says so).
    const customRow = declaredIsBuiltin
      ? null
      : ((await this.prisma.modelProvider.findFirst({
          where: { slug: declared!, ...(await usableProviderScope(this.prisma, session.ownerId)) },
        })) ??
        (maintenance
          ? null
          : ((await this.resolveLoginPool(this.prisma, session, declared!, true)) ??
            (await this.resolvePoolMember(this.prisma, session, declared!, true)) ??
            (await this.resolveSharedPool(this.prisma, session, declared!, true)))));
    // A Claude pool of the owner's own that none of its members can run still dispatches, on the Claude
    // default: the line resolvePoolMember just owed the transcript says so. Any other slug nothing holds
    // is refused by resolveProviderExec. A Codex pool always resolves to its gateway above, never to the
    // runner's own login.
    const poolFallback = !declaredIsBuiltin && !customRow
      && (await accountPoolRuntime(this.prisma, session.ownerId, declared!)) === AgentProvider.CLAUDE;
    // An OpenCode model may name one of the owner's configured keys, which the exec writes in.
    const openCodeKeys = declared === AgentProvider.OPENCODE ? await openCodeKeyRows(this.prisma, session.ownerId) : undefined;
    const resolveExec = (sessionModel: string | null) =>
      resolveProviderExec({
        declaredProvider: poolFallback ? AgentProvider.CLAUDE : declared,
        declaredProviderBuiltin: poolFallback || declaredProviderBuiltin,
        customRow,
        openCodeKeys,
        sessionModel,
        usesRuntimeDefaultModel: session.usesRuntimeDefaultModel,
        runtimeDefaultModels: session.assignedRunner?.runtimeDefaultModels,
        workspaceModel: workspace?.model,
        modelCatalog: session.assignedRunner?.modelCatalog,
        workspaceEnv: workspace?.env as Record<string, string> | null,
        // The account picked for this session, else its workspace's (accountsForClaim).
        codexAccount: accounts.codexAccount,
        claudeAccount: accounts.claudeAccount,
        antigravityAccount: accounts.antigravityAccount,
        runnerEngines: session.assignedRunner?.engines,
      });
    let exec = resolveExec(session.model);
    // Snapshot an inherited default on the session at its first claim, and refresh one the runtime
    // has since retired. Later Runtime heartbeat changes must not silently switch an
    // already-established conversation on reclaim/resume — only a model that is no longer offered
    // at all moves, and then the row must stop naming it or the pickers would keep showing a dead
    // id the session isn't running.
    if (!refused && (session.model === null || session.model.trim() === '' || exec.retiredPin)) {
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
    // A maintenance session's run goes on top: its guardrails, and the clean start the runner reads it by.
    return withWikiMaintenanceRun({
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
      // The branch this session merges into — its own recorded target, a code task's project
      // integration line, else the workspace's remembered default. Lets the runner judge
      // "already merged" against that branch instead of main.
      mergeTarget: session.mergeTarget
        ?? (taskIntegrationRef
          ? branchName(taskIntegrationRef)
          : workspace?.defaultMergeTarget ?? undefined),
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
    }, maintenance);
  }

  /** Manual pauses wait at dispatch, before a credential or runner default can be consumed. */
  async accountPoolPausedUntil(
    ownerId: string, slug: string, now: Date, db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<Date | null> {
    // This caller has only a slug. A pre-existing dsh pool keeps that identity; a native dsh
    // selection simply finds no pool. Other built-ins remain unambiguous.
    if (slug !== AgentProvider.DSH && isBuiltinProvider(slug)) return null;
    const own = await this.accountPool(ownerId, slug, db);
    if (own && own.engine !== AgentProvider.CODEX) {
      const paused = own.candidates.filter((candidate) => candidate.pausedUntil && candidate.pausedUntil > now);
      if (!paused.length) return null;
      const selection = selectPoolMember(own.candidates, null, now);
      if (selection.kind === 'SELECTED') return null;
      return selection.kind === 'EXHAUSTED' && selection.resetsAt
        ? selection.resetsAt
        : new Date(Math.min(...paused.map((candidate) => candidate.pausedUntil!.getTime())));
    }
    const pool = own ?? await this.sharedPoolOf(db, ownerId, slug);
    if (!pool) return null;
    const keys = await sharedPoolKeyCandidates(db, pool.id, now);
    const pauses = [...pool.logins, ...keys].flatMap((row) => row.pausedUntil && row.pausedUntil > now ? [row.pausedUntil.getTime()] : []);
    if (!pauses.length || pool.logins.some((login) => loginCanRun(login, now)) || keys.some((key) => keyCanRun(key, ownerId, now))) return null;
    return earliest(loginPoolResumesAt(pool.logins, now), poolKeysResumeAt(keys, ownerId, now)) ?? new Date(Math.min(...pauses));
  }

  /** The selected member may have been paused after the claim; inbox requeues before the next turn. */
  async pausedPoolMemberUntil(
    ownerId: string,
    slug: string,
    session: { providerBuiltin?: boolean; poolMemberProviderId: string | null; poolCodexAccountId: string | null; poolKeyId: string | null },
    now: Date,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<Date | null> {
    if (isBuiltinProvider(slug, session.providerBuiltin ?? (slug !== AgentProvider.DSH))) return null;
    const pool = await db.providerPool.findFirst({
      where: { slug, OR: [{ ownerId, shared: false }, { engine: AgentProvider.CODEX, people: { some: { userId: ownerId } } }] },
      select: { id: true, engine: true },
    });
    if (!pool) return null;
    // The inbox calls inside its session transaction. Holding this membership through delivery makes
    // pause and delivery ordered: either this turn was delivered before pause, or it sees the pause.
    const rows = pool.engine !== AgentProvider.CODEX && session.poolMemberProviderId
      ? await db.$queryRaw<Array<{ pausedUntil: Date | null }>>`
          SELECT "paused_until" AS "pausedUntil" FROM "provider_pool_member"
          WHERE "pool_id" = ${pool.id}::uuid AND "provider_id" = ${session.poolMemberProviderId}::uuid FOR SHARE`
      : session.poolCodexAccountId
        ? await db.$queryRaw<Array<{ pausedUntil: Date | null }>>`
            SELECT "paused_until" AS "pausedUntil" FROM "pool_codex_login"
            WHERE "pool_id" = ${pool.id}::uuid AND "account_id" = ${session.poolCodexAccountId} FOR SHARE`
        : session.poolKeyId
          ? await db.$queryRaw<Array<{ pausedUntil: Date | null }>>`
              SELECT "paused_until" AS "pausedUntil" FROM "pool_api_key"
              WHERE "pool_id" = ${pool.id}::uuid AND "id" = ${session.poolKeyId}::uuid FOR SHARE`
          : [];
    const pausedUntil = rows[0]?.pausedUntil;
    return pausedUntil && pausedUntil > now ? pausedUntil : null;
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
   *
   * A Codex pool answers from its ChatGPT accounts the same way (pool-login-select.ts loginPoolResumesAt):
   * `now` while one can run, the first of them to come back while none can — an account's `spent_until`,
   * the reset the Codex backend named, and the resets of the windows its last reading says are used up —
   * and null while it holds none or OpenAI signed every one out, which no wait mends. Its API keys
   * (migration 0358) answer beside them, since every session of the pool runs on a key when no account
   * can: whichever of the two comes back first. That is one pool of one's own (migrations 0323/0324) and
   * one of somebody else's own `ownerId` was added to, whose accounts run their sessions too
   * (pool-credential-select.ts); a shared pool (0321) holds no account and answers from its keys alone
   * (pool-key-select.ts poolKeysResumeAt).
   */
  async accountPoolResumesAt(ownerId: string, slug: string, now: Date): Promise<Date | null> {
    // A built-in engine is never a pool.
    if (slug !== AgentProvider.DSH && isBuiltinProvider(slug)) return null;
    // With no quota cache there is nothing to judge an account pool by.
    const pool = this.planUsage ? await this.accountPool(ownerId, slug) : null;
    // A Codex pool of one's own is judged by its ChatGPT accounts (migration 0324) and its keys (0358), not by
    // a member's quota.
    if (pool?.engine === AgentProvider.CODEX) {
      return earliest(
        loginPoolResumesAt(pool.logins, now),
        poolKeysResumeAt(await sharedPoolKeyCandidates(this.prisma, pool.id, now), ownerId, now),
      );
    }
    if (pool) return poolResumesAt(pool.candidates, now);
    const shared = await this.sharedPoolOf(this.prisma, ownerId, slug);
    if (!shared) return null;
    return earliest(
      loginPoolResumesAt(shared.logins, now),
      poolKeysResumeAt(await sharedPoolKeyCandidates(this.prisma, shared.id, now), ownerId, now),
    );
  }

  /**
   * When a turn of a session on somebody else's Codex pool (migrations 0321/0358) that failed on its
   * credential is to be sent again — the gateway refused the key (switched off, refused or disabled by
   * OpenAI, its cap spent by the others, gone), OpenAI said it is out of budget or refused it, or the
   * ChatGPT account it runs on was spent or signed out — for the arm turn-complete and finalize put on a
   * failed run (RunnerApiController). `now` while another credential can take it, which the next claim
   * then chooses; the first reset while nothing can; null when nothing comes back by waiting.
   *
   * Null too when the credential the session is on can still run — the failure was not its, and the
   * ordinary rules apply — and when `session` is on no such pool. A rate limit is one of these only while
   * the gateway could wait it out: one that outlasted that wait leaves a short `throttled_until` on the
   * credential (migration 0382, providers/pool-gateway.service.ts), so the credential cannot run, and this
   * answers for it exactly as it does for a spent one. Decided from the accounts and the keys as the
   * database holds them, not from the words the engine ended with.
   *
   * `patienceMs` is the one thing the caller decides rather than the pool: when the credential the session
   * is already on comes back inside it, that moment is answered instead of the pool's — see
   * `worthWaitingFor` and `POOL_RATE_LIMIT_WAIT_MS`. Zero, the default, is the pool's own answer, which is
   * what every caller but the rate-limited retry wants.
   */
  async sharedPoolRetryAt(
    db: Prisma.TransactionClient | PrismaService,
    session: {
      ownerId: string;
      provider: string | null;
      providerBuiltin?: boolean;
      poolKeyId: string | null;
      poolCodexAccountId: string | null;
    },
    now: Date,
    patienceMs = 0,
  ): Promise<Date | null> {
    if (!session.provider || isBuiltinProvider(
      session.provider, session.providerBuiltin ?? (session.provider !== AgentProvider.DSH),
    )) return null;
    const pool = await this.sharedPoolOf(db, session.ownerId, session.provider);
    if (!pool) return null;
    const keys = await sharedPoolKeyCandidates(db, pool.id, now);
    // What the session is on: the ChatGPT account its row names (a pool of somebody else's own), else the
    // key. One on a credential that can still run failed on something else.
    const account = pool.logins.find((login) => login.accountId === session.poolCodexAccountId);
    if (account) {
      if (loginCanRun(account, now)) return null;
      const own = loginRunsAgainAt(account, now);
      if (worthWaitingFor(own, now, patienceMs)) return own;
    } else {
      const current = keys.find((key) => key.id === session.poolKeyId);
      if (current && keyCanRun(current, session.ownerId, now)) return null;
      const own = current ? keyRunsAgainAt(current, session.ownerId, now) : null;
      if (worthWaitingFor(own, now, patienceMs)) return own;
    }
    return earliest(loginPoolResumesAt(pool.logins, now), poolKeysResumeAt(keys, session.ownerId, now));
  }

  /**
   * When a turn of a login-pool session that failed on its account is to be sent again — its usage limit
   * is reached (`spent_until`, which the gateway wrote before the 429 went back, or a window its last
   * reading says is used up), OpenAI signed it out, or it left the pool — for the arm turn-complete and
   * finalize put on a failed run (RunnerApiController), beside sharedPoolRetryAt: `now` while another
   * account can take it, which the next claim then moves the session to (resolveLoginPool); the first
   * account to come back while none can; null when none comes back by waiting.
   *
   * Null too when the account the session is on can still run — the failure was not the account's, and the
   * ordinary rules apply — and when `session` is on no login pool of its owner's. A rate limit counts among
   * the reasons only once the gateway could not wait it out and marked the account `throttled_until`
   * (migration 0382); a short one is waited out inside the request it was answered to, and moves nothing.
   * Decided from the accounts as the database holds them, not from the words the engine ended with.
   *
   * The pool's API keys (migration 0358) count beside its accounts: the owner's session runs on a key when
   * no account can (resolveLoginPool), so one on a key that can still run is null as one on an account is,
   * and another key that can run — or an account come back — is `now`.
   *
   * `patienceMs` is `sharedPoolRetryAt`'s: the moment the credential the session is already on comes back,
   * when that is near enough to be worth more than the move.
   */
  async loginPoolRetryAt(
    db: Prisma.TransactionClient | PrismaService,
    session: { ownerId: string; provider: string | null; providerBuiltin?: boolean; poolCodexAccountId: string | null; poolKeyId?: string | null },
    now: Date,
    patienceMs = 0,
  ): Promise<Date | null> {
    if (!session.provider || isBuiltinProvider(
      session.provider, session.providerBuiltin ?? (session.provider !== AgentProvider.DSH),
    )) return null;
    const pool = await this.accountPool(session.ownerId, session.provider, db);
    if (pool?.engine !== AgentProvider.CODEX) return null;
    const keys = await sharedPoolKeyCandidates(db, pool.id, now);
    if (session.poolCodexAccountId) {
      const current = pool.logins.find((login) => login.accountId === session.poolCodexAccountId);
      if (current && loginCanRun(current, now)) return null;
      const own = current ? loginRunsAgainAt(current, now) : null;
      if (worthWaitingFor(own, now, patienceMs)) return own;
    } else {
      const current = keys.find((key) => key.id === (session.poolKeyId ?? null));
      if (current && keyCanRun(current, session.ownerId, now)) return null;
      const own = current ? keyRunsAgainAt(current, session.ownerId, now) : null;
      if (worthWaitingFor(own, now, patienceMs)) return own;
    }
    return earliest(loginPoolResumesAt(pool.logins, now), poolKeysResumeAt(keys, session.ownerId, now));
  }

  /**
   * The Codex pool on `slug` `ownerId` runs on as one of its people, or null — nobody else's is theirs to
   * name: a shared pool they are in (migration 0321), or a pool of somebody else's own its owner added
   * them to (migration 0358). Either may hold ChatGPT accounts — whoever in the pool signed each one in
   * (migration 0371) — and every person's sessions run on them (pool-credential-select.ts). A pool of
   * their own is not this but accountPool's (resolveLoginPool). `logins` are the pool's accounts, oldest
   * first, as choosing reads them.
   */
  private async sharedPoolOf(db: Prisma.TransactionClient | PrismaService, ownerId: string, slug: string) {
    const pool = await db.providerPool.findFirst({
      where: {
        slug,
        engine: AgentProvider.CODEX,
        people: { some: { userId: ownerId } },
        OR: [{ shared: true }, { ownerId: { not: ownerId } }],
      },
      select: { id: true, label: true, ownKeyFirst: true, ownerId: true, shared: true },
    });
    if (!pool) return null;
    return { ...pool, logins: await poolLogins(db, pool.id) };
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
   *
   * A pool of somebody else's own `ownerId` was added to (migration 0358, and 0321's shared pools too
   * since 2026-10-03): every session of it runs on its ChatGPT accounts first — whoever in the pool signed
   * each one in (migration 0371) — and on its API keys while none can, so it is refused only while
   * neither can run (codexPoolUnavailableReason). A pool holding no account at all is refused in the
   * keys' own words (sharedPoolUnavailableReason) — it has none, or each is switched off or refused by
   * OpenAI — and not when its keys are only spent to their share caps, which come back on the first of
   * the month.
   */
  async accountPoolRefusal(
    ownerId: string,
    slug: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<string | null> {
    const pool = await this.accountPool(ownerId, slug, db);
    if (!pool) {
      const shared = await this.sharedPoolOf(db, ownerId, slug);
      if (!shared) return null;
      const keys = await db.poolApiKey.findMany({
        where: { poolId: shared.id },
        orderBy: { id: 'asc' },
        select: { label: true, enabled: true, state: true },
      });
      if (shared.logins.length === 0) return sharedPoolUnavailableReason(shared.label, keys);
      const account = shared.logins.find((login) => login.state === 'ACTIVE') ?? shared.logins[0] ?? null;
      return codexPoolUnavailableReason(shared.label, account, keys, account?.userId === ownerId);
    }
    // A Codex pool of the owner's own (migration 0323) has no members to choose from: its accounts are the
    // credential, and it takes a session exactly while one of them is ACTIVE, which the claim can put the
    // session on — or, with none, while one of its API keys (migration 0358) is switched on and unrefused,
    // which the claim puts it on instead. Every account signed out (named by the oldest), or nobody signed
    // in yet, with no such key, refuses it here, where the person can act on the reason. A quota that has
    // not been read is not that and does not appear here at all; nor does a spent one, which is waited for.
    if (pool.engine === AgentProvider.CODEX) {
      const keys = await db.poolApiKey.findMany({ where: { poolId: pool.id }, select: { enabled: true, state: true } });
      const account = pool.logins.find((login) => login.state === 'ACTIVE') ?? pool.logins[0] ?? null;
      return codexPoolUnavailableReason(pool.label, account, keys, account?.userId === ownerId);
    }
    if (selectPoolMember(pool.candidates, null, new Date()).kind !== 'UNAVAILABLE') return null;
    return poolUnavailableReason(pool.label, pool.rows);
  }

  /**
   * `ownerId`'s account pool on `slug`: its name, its member rows, and the ones a claim may choose from
   * (isPoolCandidate) as candidates with their quota as the cache has it. Null when `slug` names no pool
   * of theirs — and when it names a shared pool (migration 0321), whose keys are no members of this kind.
   */
  private async accountPool(ownerId: string, slug: string, db: Prisma.TransactionClient = this.prisma) {
    const pool = await db.providerPool.findFirst({
      where: { slug, ownerId, shared: false },
      select: {
        id: true,
        label: true,
        engine: true,
        // A `codex` pool's rule for choosing among its API keys (migration 0358), as a shared pool's.
        ownKeyFirst: true,
        members: {
          where: { ownerId },
          orderBy: { provider: { slug: 'asc' } },
          select: { provider: true, pausedUntil: true },
        },
      },
    });
    if (!pool) return null;
    const rows = pool.members.map((member) => ({ ...member.provider, pausedUntil: member.pausedUntil }));
    // A member no claim may choose is no candidate, and nobody asks after its quota.
    const candidates = rows
      .filter(isPoolCandidate)
      .map((row) => {
        const standing = this.planUsage?.usageStanding(row) ?? null;
        return {
          row,
          pausedUntil: row.pausedUntil,
          usage: this.planUsage?.snapshot(row) ?? null,
          refused: standing === 'KEY_REFUSED',
          usageUnreadable: standing === 'USAGE_UNKNOWN',
        };
      });
    return {
      id: pool.id,
      label: pool.label,
      engine: pool.engine,
      ownKeyFirst: pool.ownKeyFirst,
      logins: await poolLogins(db, pool.id),
      rows,
      candidates,
    };
  }

  /**
   * The member an account pool dispatches this claim on (providers/pool-select.ts), or null when `slug`
   * names no pool of this session's owner or none of its members can run. A pool of theirs with none that
   * can run dispatches on the Claude default (each door's `poolFallback`), so a pool emptied under a
   * session never fails the claim; a slug that names no pool of theirs — another owner's, or one deleted —
   * is never claimed at all (trySessionClaim), and waits as PROVIDER_UNAVAILABLE_ERROR.
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
    atClaim = false,
  ) {
    const pool = await this.accountPool(session.ownerId, slug, db);
    // A Codex pool of one's own has no members to choose: it is resolveLoginPool's.
    if (!pool || pool.engine === AgentProvider.CODEX) return null;
    const now = new Date();
    const { rows, candidates } = pool;
    const chosen = choosePoolMember(candidates, session.poolMemberProviderId, now);
    if (!chosen && candidates.some((candidate) => candidate.pausedUntil && candidate.pausedUntil > now)) {
      const pausedUntil = await this.accountPoolPausedUntil(session.ownerId, slug, now, db);
      throw new ConflictException({ code: 'POOL_ACCOUNT_PAUSED', message: 'The pool accounts are paused', pausedUntil: pausedUntil?.toISOString() });
    }
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
                      pausedUntil: previous.pausedUntil,
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
    if (atClaim && previous?.pausedUntil && previous.pausedUntil > now) {
      await new PoolNotices(this.prisma, this.realtime).carrier(session.id, slug);
    }
    return chosen;
  }

  /**
   * What a session on a Codex pool of its owner's own (migrations 0323/0324) dispatches as, or null when
   * `slug` names no such pool of this session's owner — nobody else's session is handed its gateway, a
   * token or anything about its account.
   *
   * The engine gets the pool gateway as its OpenAI endpoint and a session token minted here as its key
   * (shared-pool.ts sharedPoolExecRow) — never the login, which only the gateway ever reads, decrypts or
   * refreshes. The account the session runs on is chosen here (pool-credential-select.ts, by
   * pool-login-select.ts chooseLoginAccount: the one it is on while that can run, else the one that can
   * whose quota resets soonest, else it stays) and recorded on the session (`pool_codex_account_id`),
   * which is how a session says which account it ran on — and, since migration 0355, the only thing that
   * says it: the token names no account, and the gateway sends every request of the token on whichever
   * account its session is on then, so an engine warm on an older token follows the move with nothing
   * re-spawned. A pool holding no account still dispatches here, and the gateway answers why — rather than
   * on the runner's own login, which is exactly what a login pool is not.
   *
   * A move off another account records the line the transcript owes for it (loginSwitchNotice), in place
   * of the one the gateway owed when that account was spent or signed out — "Switched to …" says why. At
   * the claim (`atClaim`), a line owed either way is given its carrier, as resolveSharedPool's is; the
   * reclaim and the reload re-spawn their engine, whose own start carries it.
   *
   * The pool may hold API keys beside its accounts (migration 0358), and its owner's session runs on one
   * of them while none of its accounts can run — the key pool-key-select.ts chooses for the owner, as for
   * any person of a shared pool — recorded as `pool_key_id`, with `pool_codex_account_id` cleared, and back
   * on an account at the first claim that finds one that can (pool-credential-select.ts). The
   * gateway sends on whichever of the two the session names: the token is the same login pool token
   * either way, and authenticates (pool, owner, session) alone. With neither able to run, the session
   * stays on what it is on. Each move says so, as a move between accounts does.
   *
   * Every door that builds such a session's engine environment resolves it here — the claim, a restarted
   * runner's reclaim, a provider-switch reload (RunnerApiController) — and each mints its own token.
   * `db` is the caller's client: the reload runs inside the transaction that holds this session's row.
   */
  async resolveLoginPool(
    db: Prisma.TransactionClient | PrismaService,
    session: {
      id: string;
      ownerId: string;
      poolCodexAccountId: string | null;
      poolKeyId: string | null;
      poolSwitchNotice?: string | null;
    },
    slug: string,
    atClaim = false,
  ): Promise<ModelProviderRow | null> {
    const pool = await this.accountPool(session.ownerId, slug, db);
    if (pool?.engine !== AgentProvider.CODEX) return null;
    const now = new Date();
    // accountPool found it as a pool of the session's owner's own, never a shared one: its accounts first.
    const { chosen, next, notice } = choosePoolCredential(
      {
        ownerId: session.ownerId,
        accounts: pool.logins,
        keys: await sharedPoolKeyCandidates(db, pool.id, now),
        ownKeyFirst: pool.ownKeyFirst,
      },
      { ownerId: session.ownerId, accountId: session.poolCodexAccountId, keyId: session.poolKeyId },
      now,
    );
    if (!chosen) {
      const pausedUntil = await this.accountPoolPausedUntil(session.ownerId, slug, now, db);
      if (pausedUntil) throw new ConflictException({
        code: 'POOL_ACCOUNT_PAUSED', message: 'The pool accounts are paused', pausedUntil: pausedUntil.toISOString(),
      });
    }
    if (next.accountId !== session.poolCodexAccountId || next.keyId !== session.poolKeyId) {
      await db.session.update({
        where: { id: session.id },
        data: {
          poolCodexAccountId: next.accountId,
          poolKeyId: next.keyId,
          ...(notice ? { poolSwitchNotice: notice } : {}),
        },
      });
    }
    const token = await mintPoolLoginToken(
      db,
      { poolId: pool.id, userId: session.ownerId, sessionId: session.id },
      now,
    );
    // The line is said before the turn this claim runs: a resident engine starts nothing, so it is handed
    // a reload that changes nothing and answers it with a `resumed` that carries the line (pool-notice.ts).
    if (atClaim && (notice || session.poolSwitchNotice)) {
      await new PoolNotices(this.prisma, this.realtime).carrier(session.id);
    }
    return sharedPoolExecRow(token);
  }

  /**
   * What a session on somebody else's Codex pool dispatches as, or null when `slug` names no pool this
   * session's owner is one of its people of — which then dispatches as a deleted provider does, exactly
   * as a slug nothing holds. Such a pool is reached by its people only: nobody else's session is handed
   * its gateway, a token or anything about its credentials.
   *
   * The engine gets the pool gateway as its OpenAI endpoint and a session token minted here as its key
   * (shared-pool.ts sharedPoolExecRow) — never a key or a login of the pool, which only the gateway ever
   * reads. The credential this session's requests go out on is chosen here (pool-credential-select.ts)
   * and recorded on the session for the gateway: `poolCodexAccountId` for one of the pool's ChatGPT
   * accounts (2026-10-03 — they run the people its owner added too, not its owner's sessions alone), or
   * `poolKeyId` for one of its API keys, which is what a shared pool (migration 0321) holds and what any
   * session falls to while no account can run. Within each kind the rules are pool-login-select.ts's and
   * pool-key-select.ts's. When nothing can run the session stays on the credential it had (null for one
   * that never had any), which the gateway answers with the reason, and moves at the first claim that
   * finds one that can — so a move after a wait still says what it left. Every door that builds such a
   * session's engine environment resolves it here — this claim, a restarted runner's reclaim and a
   * provider-switch reload (RunnerApiController) — and each mints its own token, since only a hash is
   * kept and a new process needs the token in its environment.
   * `db` is the caller's client: the reload runs inside the transaction that holds this session's row.
   *
   * A move off another credential records the line the transcript owes for it (pool-key-select.ts
   * poolKeySwitchNotice, pool-login-select.ts's account lines), carried by the next engine start event the
   * runner reports, as a pool of one's own accounts are. The gateway moves no session itself, so every
   * move happens here — and a claim may land on a resident engine, which starts nothing and so reports no
   * such event. `atClaim` says this is the claim, and a move then also queues a `reload` that changes
   * nothing (pool-notice.ts PoolNotices.carrier): the resident engine answers it with a `resumed`, which
   * carries the line, ahead of the message it runs on the new credential. The reclaim and the reload
   * re-spawn their engine, whose own start carries it.
   *
   * The token is a person's (`pool_gateway_token`), never a login pool's, whose table names nobody but a
   * pool's owner: a session of somebody the owner added runs on that pool's accounts without any token
   * row of its own naming one (migration 0355 — the token names no account at all, and the gateway sends
   * on whichever credential the session is on when the request arrives).
   */
  async resolveSharedPool(
    db: Prisma.TransactionClient | PrismaService,
    session: {
      id: string;
      ownerId: string;
      poolKeyId: string | null;
      poolCodexAccountId: string | null;
      poolSwitchNotice?: string | null;
    },
    slug: string,
    atClaim = false,
  ): Promise<ModelProviderRow | null> {
    const pool = await this.sharedPoolOf(db, session.ownerId, slug);
    if (!pool) return null;
    const now = new Date();
    // This person's sessions run on the pool's ChatGPT accounts first — whoever in the pool signed each
    // one in (migration 0371) — and on its keys when none can run (pool-credential-select.ts).
    const { chosen, next, notice } = choosePoolCredential(
      {
        ownerId: pool.ownerId,
        accounts: pool.logins,
        keys: await sharedPoolKeyCandidates(db, pool.id, now),
        ownKeyFirst: pool.ownKeyFirst,
      },
      { ownerId: session.ownerId, accountId: session.poolCodexAccountId, keyId: session.poolKeyId },
      now,
    );
    if (!chosen) {
      const pausedUntil = await this.accountPoolPausedUntil(session.ownerId, slug, now, db);
      if (pausedUntil) throw new ConflictException({
        code: 'POOL_ACCOUNT_PAUSED', message: 'The pool accounts are paused', pausedUntil: pausedUntil.toISOString(),
      });
    }
    if (next.keyId !== session.poolKeyId || next.accountId !== session.poolCodexAccountId) {
      await db.session.update({
        where: { id: session.id },
        data: {
          poolKeyId: next.keyId,
          poolCodexAccountId: next.accountId,
          ...(notice ? { poolSwitchNotice: notice } : {}),
        },
      });
    }
    // The line is said before the turn this claim runs: a resident engine starts nothing, so it is handed
    // a reload that changes nothing and answers it with a `resumed` that carries the line (pool-notice.ts)
    // — the one this choosing wrote, or the one the gateway left when the account it is on was spent or
    // signed out and no other can run.
    if (atClaim && (notice || session.poolSwitchNotice)) {
      await new PoolNotices(this.prisma, this.realtime).carrier(session.id);
    }
    const token = await mintPoolGatewayToken(
      db,
      { poolId: pool.id, userId: session.ownerId, sessionId: session.id },
      now,
    );
    return sharedPoolExecRow(token);
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

/**
 * A pool's ChatGPT logins as choosing reads them, oldest first — each signed in by whichever person of
 * the pool contributed it (migration 0371), so they hang off no relation of the pool's row. Never a token
 * or a ciphertext: none is selected.
 */
async function poolLogins(
  db: Prisma.TransactionClient | PrismaService,
  poolId: string,
): Promise<Array<LoginAccount & { userId: string }>> {
  const rows = await db.poolCodexLogin.findMany({
    where: { poolId },
    orderBy: [{ createdAt: 'asc' }, { accountId: 'asc' }],
    select: { accountId: true, userId: true, email: true, state: true, spentUntil: true, throttledUntil: true, pausedUntil: true, usage: true },
  });
  return rows.map((login) => ({ ...login, usage: login.usage as PlanUsageSnapshot | null }));
}

/** The earlier of two times, either of which may be none: when the first of two things comes back. */
function earliest(a: Date | null, b: Date | null): Date | null {
  return a && b ? (a.getTime() <= b.getTime() ? a : b) : (a ?? b);
}

/**
 * Whether a session is better off waiting on the credential it is already on than taking the pool's
 * answer — the bit of the retry that is the caller's to ask for, not the pool's.
 *
 * `at` is when that credential can run again, and `patienceMs` 0 says no wait is worth anything: the callers
 * that arm a session off a credential that cannot run at all (spent, signed out, refused) want the pool's
 * answer, which is a move when another credential can take the session. A rate limit passes a patience
 * instead, because what a move costs is the prompt cache (see `POOL_RATE_LIMIT_WAIT_MS`).
 */
function worthWaitingFor(at: Date | null, now: Date, patienceMs: number): at is Date {
  return at !== null && at.getTime() > now.getTime() && at.getTime() - now.getTime() <= patienceMs;
}
