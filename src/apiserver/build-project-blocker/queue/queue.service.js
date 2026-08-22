"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var QueueService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.QueueService = void 0;
const crypto_1 = require("crypto");
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const events_1 = require("events");
const shared_1 = require("@orbit/shared");
const prisma_service_1 = require("../prisma/prisma.service");
const custom_provider_1 = require("../providers/custom-provider");
const runtime_provider_1 = require("../common/runtime-provider");
const session_inbox_fence_1 = require("../common/session-inbox-fence");
const session_tree_sql_1 = require("../common/session-tree-sql");
const runner_provider_support_1 = require("../runner-api/runner-provider-support");
const permission_mode_1 = require("../common/permission-mode");
const permission_rules_1 = require("../common/permission-rules");
const transaction_retry_1 = require("../common/transaction-retry");
/**
 * Session claim queue backed by the `Session` table. A runner long-polls for the
 * PENDING sessions assigned to it; claims are atomic via `FOR UPDATE SKIP LOCKED`
 * and gated, server-side, on the runner's `maxConcurrent` active turns. Warm/cold
 * idle runtimes are retained independently and do not consume that limit.
 */
let QueueService = QueueService_1 = class QueueService {
    prisma;
    logger = new common_1.Logger(QueueService_1.name);
    signal = new events_1.EventEmitter();
    constructor(prisma) {
        this.prisma = prisma;
        this.signal.setMaxListeners(0);
    }
    /** Wake long-poll waiters after a session transitions to PENDING. */
    notifySessionQueued() {
        this.signal.emit('queued');
    }
    waitForSignal(timeoutMs) {
        return new Promise((resolve) => {
            const done = () => {
                clearTimeout(timer);
                this.signal.off('queued', done);
                resolve();
            };
            const timer = setTimeout(done, timeoutMs);
            this.signal.once('queued', done);
        });
    }
    async claimSessionForRunner(runner, waitMs = 0, supportsTerminalHandoff = false) {
        const deadline = Date.now() + waitMs;
        for (;;) {
            const job = await this.trySessionClaim(runner, supportsTerminalHandoff);
            if (job)
                return job;
            const remaining = deadline - Date.now();
            if (remaining <= 0)
                return null;
            await this.waitForSignal(Math.min(remaining, 5000));
        }
    }
    async trySessionClaim(runner, supportsTerminalHandoff) {
        const supportsOpenCode = runner.supportedProviders?.includes(shared_1.AgentProvider.OPENCODE) ?? false;
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
            const rows = await (0, transaction_retry_1.withTransactionRetry)(this.prisma, async (tx) => {
                // pg_advisory_xact_lock returns PostgreSQL void, which queryRaw cannot deserialize;
                // executeRaw deliberately discards that result (same pattern as pg_notify).
                await tx.$executeRaw `SELECT pg_advisory_xact_lock(1330792788, 1)`;
                // Migration 0080 installs a database trigger so an older apiserver replica cannot
                // claim OpenCode as Claude during a rolling control-plane deploy. This transaction-
                // local capability is the positive signal that lets only the new, capable path pass.
                await tx.$executeRaw `SELECT set_config('orbit.runner_supports_opencode', ${supportsOpenCode ? '1' : '0'}, true)`;
                // Prisma.sql rather than a bare tagged template so the cap fragments below are the
                // SAME SQL the session list uses to explain a queued row. Written twice they drift,
                // and a UI that names the wrong gate is worse than one that names none.
                const runnerId = client_1.Prisma.sql `${runner.id}::uuid`;
                return tx.$queryRaw(client_1.Prisma.sql `
        UPDATE "session" SET
          status = 'RUNNING',
          error = CASE
            WHEN error = ${runner_provider_support_1.OPENCODE_RUNNER_UPGRADE_ERROR} THEN NULL
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
            AND ${(0, session_tree_sql_1.runnerActiveTurns)(runnerId)}
                  < (SELECT r."max_concurrent" FROM "runner" r WHERE r.id = ${runnerId})
            -- Batch-run cap, independent of the runner cap above: a closed set the user
            -- dispatched together, with the cap they chose for it.
            AND (
              s."batch_id" IS NULL
              OR ${(0, session_tree_sql_1.batchActiveTurns)('s')} < s."batch_max_concurrent"
            )
            -- Spawn-tree cap, independent of both caps above. Where a batch run is closed and
            -- user-capped, a tree grows on its own and is capped by the server. See
            -- session-tree-sql.ts for why the ceiling is a share of the runner and why a
            -- supervisor is exempt from the count.
            AND (
              s."root_session_id" IS NULL
              OR ${(0, session_tree_sql_1.treeActiveTurns)('s')} < ${(0, session_tree_sql_1.treeCeiling)(runnerId)}
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
                OR s."merge_requested_at" > now() - (${session_inbox_fence_1.WORKTREE_OPERATION_STALE_MS} * interval '1 millisecond')
              )
            )
            AND NOT (
              s."commit_status" IS NOT DISTINCT FROM 'pending'
              AND (
                s."commit_requested_at" IS NULL
                OR s."commit_requested_at" > now() - (${session_inbox_fence_1.WORKTREE_OPERATION_STALE_MS} * interval '1 millisecond')
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
            }, (0, transaction_retry_1.loggedRetry)(this.logger, 'queue.trySessionClaim'));
            if (rows.length === 0)
                return null;
            return this.buildSession(rows[0].id);
        }
        catch (err) {
            // pg error 55P03 = lock_not_available: FOR UPDATE NOWAIT cannot lock the
            // candidate row because a concurrent transaction (e.g. activateLeases in a
            // reclaim storm) holds it. Return null so the outer claimSessionForRunner
            // loop waits on the signal and retries instead of starving forever.
            if (err?.code === '55P03' ||
                err?.meta?.code === '55P03' ||
                String(err?.message ?? '').includes('55P03') ||
                String(err?.message ?? '').includes('lock_not_available')) {
                return null;
            }
            throw err;
        }
    }
    async buildSession(sessionId) {
        const session = await this.prisma.session.findUniqueOrThrow({
            where: { id: sessionId },
            include: {
                // The workspace's standing "always allow" grants ride along: they are what turns an
                // approval a human already answered into one this session never has to ask again.
                workspace: { include: { permissionRules: { orderBy: { createdAt: 'asc' } } } },
                assignedRunner: {
                    select: { runtimeDefaultModels: true, modelCatalog: true, runsAsRoot: true },
                },
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
        // Retried whole. The session row an aborted attempt inserted does not exist, so a re-run
        // inserts one session rather than a second — and the capacity fence it commits under is
        // re-evaluated inside the closure on every attempt.
        await (0, transaction_retry_1.withTransactionRetry)(this.prisma, async (tx) => {
            await tx.$queryRaw `SELECT id FROM "session" WHERE id = ${session.id}::uuid FOR UPDATE`;
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
            if (existingSeed)
                return;
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
        }, (0, transaction_retry_1.loggedRetry)(this.logger, 'queue.buildSession'));
        // Continue the monotonic event seq past whatever a prior run persisted (incl. a
        // failed first run's error events) so new events never collide; 0 when fresh.
        const maxSeq = (await this.prisma.runEvent.aggregate({ where: { sessionId: session.id }, _max: { seq: true } }))._max.seq ??
            0;
        const workspace = session.workspace;
        const declared = session.provider ?? null;
        // A configured (custom) provider borrows a built-in runtime: resolve the runner-facing
        // built-in provider, model, and process env (baseUrl + decrypted key injected)
        // here, so the runner receives a plain claude/codex job and needs no changes. Ownership
        // scope: a personal (BYOK) provider resolves only for its owner's sessions — otherwise a
        // user could burn another tenant's key by naming their slug.
        const declaredIsBuiltin = (0, custom_provider_1.isBuiltinProvider)(declared, session.providerBuiltin);
        const customRow = declaredIsBuiltin
            ? null
            : await this.prisma.modelProvider.findFirst({
                where: { slug: declared, OR: [{ ownerId: null }, { ownerId: session.ownerId }] },
            });
        const resolveExec = (sessionModel) => (0, custom_provider_1.resolveProviderExec)({
            declaredProvider: declared,
            declaredProviderBuiltin: session.providerBuiltin,
            customRow,
            sessionModel,
            usesRuntimeDefaultModel: session.usesRuntimeDefaultModel,
            runtimeDefaultModels: session.assignedRunner?.runtimeDefaultModels,
            workspaceModel: workspace?.model,
            modelCatalog: session.assignedRunner?.modelCatalog,
            workspaceEnv: workspace?.env,
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
            const materialized = await this.prisma.$executeRaw `
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
        const permissionMode = (0, permission_mode_1.resolvePermissionMode)(session.permissionMode, session.owner);
        // Claude spawns with a pre-generated --session-id, so a Claude row without one has no
        // conversation the runtime could resume — it was created before the column existed, or
        // its id was minted by a different runtime. Generate a fresh UUID, persist it, reset
        // numTurns so the runner does a first spawn instead of --resume (which would fail —
        // Claude has no session file for the new id), and force resume=false so the runner
        // doesn't try to pick up a non-existent conversation.
        let resume = session.numTurns > 0;
        if (provider === shared_1.AgentProvider.CLAUDE && !session.runtimeSessionId) {
            const id = (0, crypto_1.randomUUID)();
            await this.prisma.session.update({
                where: { id: session.id },
                data: { runtimeSessionId: id, numTurns: 0 },
            });
            session.runtimeSessionId = id;
            session.numTurns = 0;
            resume = false;
        }
        else if (provider === shared_1.AgentProvider.CLAUDE && !resume && session.runtimeSessionId) {
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
            // §13.8: a conversation ABOUT a task needs the same tool context as one executing it — the
            // agent is asked to call `task_get` and `task_comment`, and both default to `ORBIT_TASK_ID`.
            // Only the tool default: `context_task_id` takes no execution claim, occupies no slot and is
            // invisible to the reaper, which is exactly why the two columns are separate.
            taskId: session.taskId ?? session.contextTaskId ?? undefined,
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
                allowedTools: (0, permission_rules_1.dispatchAllowedTools)(provider, permission_mode_1.ALWAYS_ALLOWED_TOOLS, workspace?.permissionRules ?? []),
                disallowedTools: workspace?.disallowedTools ?? [],
                // Configured providers still borrow one of these runtimes, so the same runtime-level
                // guard applies to API/MCP/old-client input as it does to built-in identities; their
                // vendor-defined model space is exempt from the Claude allow-list though.
                // The root check rides along here for the same reason: a Bypass default reaching a root
                // runner is a session that exits during startup, and this is the last place before it does.
                permissionMode: (0, runtime_provider_1.normalizeBuiltinPermissionMode)(provider, exec.model, permissionMode, customRow?.enabled === true, session.assignedRunner?.runsAsRoot),
                // Per-session effort wins; otherwise use the workspace's effort setting.
                // An OpenCode variant is model-defined, so it is only checkable once the assigned
                // runner's catalog is known — an account default carried over from another runtime
                // would otherwise reach the CLI as an unsupported `--variant`.
                effort: (0, runtime_provider_1.normalizeEffortForRuntimeModel)(provider, session.effort ?? workspace?.effort, exec.model, session.assignedRunner?.modelCatalog),
                // Includes a custom provider's injected baseUrl/key (else just the workspace's env).
                env: exec.env,
            },
        };
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
    async claudeConversationOpened(sessionId, runtimeSessionId) {
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
};
exports.QueueService = QueueService;
exports.QueueService = QueueService = QueueService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], QueueService);
//# sourceMappingURL=queue.service.js.map