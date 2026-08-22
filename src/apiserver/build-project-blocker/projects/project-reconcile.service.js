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
var ProjectReconcileService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectReconcileService = exports.ProjectLeaseLostError = exports.PROJECT_RECONCILE_STALE_MS = exports.PROJECT_RECONCILE_BACKSTOP_MS = exports.PROJECT_RECONCILE_TIMER_MS = exports.PROJECT_RECONCILE_HEARTBEAT_MS = exports.PROJECT_RECONCILE_LEASE_MS = void 0;
const node_crypto_1 = require("node:crypto");
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const shared_1 = require("@orbit/shared");
const transaction_retry_1 = require("../common/transaction-retry");
const prisma_service_1 = require("../prisma/prisma.service");
const project_decision_service_1 = require("./project-decision.service");
const project_events_service_1 = require("./project-events.service");
const project_completion_gap_1 = require("./project-completion-gap");
const project_blocker_1 = require("./project-blocker");
const project_turn_reason_1 = require("./project-turn-reason");
const project_authorization_service_1 = require("./project-authorization.service");
exports.PROJECT_RECONCILE_LEASE_MS = 60_000;
exports.PROJECT_RECONCILE_HEARTBEAT_MS = 20_000;
exports.PROJECT_RECONCILE_TIMER_MS = 10_000;
exports.PROJECT_RECONCILE_BACKSTOP_MS = 60_000;
exports.PROJECT_RECONCILE_STALE_MS = 5 * 60_000;
const ACTION_TYPES = [
    'DISPATCH_TASK',
    'OPEN_COORDINATOR_TURN',
    'ROTATE_COORDINATOR_SESSION',
    'RAISE_BLOCKER',
    'CLEAR_BLOCKER',
    'APPLY_VERIFICATION_VERDICT',
    'REQUEST_APPROVAL',
    'RUN_PROJECT_ACCEPTANCE',
    'FILE_VERIFICATION_TASK',
];
class ProjectLeaseLostError extends Error {
    constructor(projectId) {
        super(`Project reconcile lease lost for ${projectId}`);
        this.name = 'ProjectLeaseLostError';
    }
}
exports.ProjectLeaseLostError = ProjectLeaseLostError;
/**
 * The Project control loop's execution substrate.
 *
 * Semantic planning is added by later units; this service owns the invariants it must build on:
 * a renewable lease with a monotonic fence, an insert-first action ledger, durable recovery wakes,
 * and one timer shared by event polling, scheduled wakes and the stale-project backstop.
 */
let ProjectReconcileService = ProjectReconcileService_1 = class ProjectReconcileService {
    prisma;
    events;
    decisions;
    log = new common_1.Logger(ProjectReconcileService_1.name);
    instanceId = (0, node_crypto_1.randomUUID)();
    timer;
    unregisterHandler;
    ticking = false;
    lastBackstopAt = 0;
    _backstopHits = 0;
    rotationExecutor;
    verdictExecutor;
    filingExecutor;
    turnExecutor;
    dispatchPass;
    pendingRotations = [];
    pendingTurns = [];
    constructor(prisma, events, 
    // Optional only for the pre-0120 isolated unit harnesses. Nest always provides it; all new
    // production protocol entry points fail closed when it is absent.
    decisions) {
        this.prisma = prisma;
        this.events = events;
        this.decisions = decisions;
    }
    get backstopHits() {
        return this._backstopHits;
    }
    /**
     * Install the sole §7.5 rotation executor, on the same terms the event consumer is installed on:
     * one, replacing a different live one is refused, and the unregister function makes an isolated
     * test's teardown explicit.
     */
    registerRotationExecutor(executor) {
        if (this.rotationExecutor && this.rotationExecutor !== executor) {
            throw new Error('a Project rotation executor is already registered');
        }
        this.rotationExecutor = executor;
        return () => {
            if (this.rotationExecutor === executor)
                this.rotationExecutor = undefined;
        };
    }
    /**
     * Install the sole §13.2 verdict executor, on the terms the rotation executor is installed on.
     */
    registerVerdictExecutor(executor) {
        if (this.verdictExecutor && this.verdictExecutor !== executor) {
            throw new Error('a Project verdict executor is already registered');
        }
        this.verdictExecutor = executor;
        return () => {
            if (this.verdictExecutor === executor)
                this.verdictExecutor = undefined;
        };
    }
    /** Install the sole §13.2 V8 filing executor, on the terms the verdict executor is installed on. */
    registerFilingExecutor(executor) {
        if (this.filingExecutor && this.filingExecutor !== executor) {
            throw new Error('a Project filing executor is already registered');
        }
        this.filingExecutor = executor;
        return () => {
            if (this.filingExecutor === executor)
                this.filingExecutor = undefined;
        };
    }
    /**
     * Install the sole §7.6 turn executor, on the terms the rotation executor is installed on.
     */
    registerTurnExecutor(executor) {
        if (this.turnExecutor && this.turnExecutor !== executor) {
            throw new Error('a Project turn executor is already registered');
        }
        this.turnExecutor = executor;
        return () => {
            if (this.turnExecutor === executor)
                this.turnExecutor = undefined;
        };
    }
    /**
     * Install the sole §7.8 dispatch pass, on the terms every other collaborator is installed on.
     *
     * One, because two passes proposing dispatches for one project would be two clocks; replacing a
     * different live one is refused; and the unregister function makes an isolated test's teardown
     * explicit.
     */
    registerDispatchPass(executor) {
        if (this.dispatchPass && this.dispatchPass !== executor) {
            throw new Error('a Project dispatch pass is already registered');
        }
        this.dispatchPass = executor;
        return () => {
            if (this.dispatchPass === executor)
                this.dispatchPass = undefined;
        };
    }
    onModuleInit() {
        this.unregisterHandler = this.events.registerHandler(this);
        // W1: event polling, due wakes and the backstop all ride this one timer. LISTEN/NOTIFY may
        // request an immediate drain, but it creates no second clock.
        this.timer = setInterval(() => void this.tick(), exports.PROJECT_RECONCILE_TIMER_MS);
        this.timer.unref();
        void this.tick();
    }
    onModuleDestroy() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = undefined;
        this.unregisterHandler?.();
        this.unregisterHandler = undefined;
    }
    /** One deterministic pass, public for integration tests and operational recovery probes. */
    async tick(now = new Date()) {
        if (this.ticking)
            return;
        this.ticking = true;
        try {
            await this.events.drainAvailable();
            await this.flushPendingRotations();
            await this.flushPendingTurns();
            await this.enqueueScheduledWakes(now);
            if (now.getTime() - this.lastBackstopAt >= exports.PROJECT_RECONCILE_BACKSTOP_MS) {
                this.lastBackstopAt = now.getTime();
                const hits = await this.enqueueBackstopWakes(now);
                this._backstopHits += hits;
                if (hits > 0)
                    this.log.warn(`Project reconcile backstop found ${hits} stalled project(s)`);
            }
            // Timer/backstop rows are ordinary durable signals. Draining them here keeps a due Project
            // inside the ten-second path even if PostgreSQL NOTIFY is lost.
            await this.events.drainAvailable();
            await this.flushPendingRotations();
            await this.flushPendingTurns();
        }
        catch (cause) {
            this.log.error(`Project reconcile recovery tick failed: ${errorText(cause)}`);
        }
        finally {
            this.ticking = false;
        }
    }
    /**
     * Event delivery callback. It re-reads current facts, never event payloads, then atomically
     * publishes the runtime state and consumes the batch under the acquired fencing token.
     */
    async handle(tx, projectId, _events) {
        const now = new Date();
        const projects = await tx.$queryRaw(client_1.Prisma.sql `
      SELECT "status", "coordinator_enabled" AS "coordinatorEnabled"
        FROM "project" WHERE "id" = ${projectId}::uuid
    `);
        const project = projects[0];
        if (!project)
            return { disposition: 'DISCARDED_OUT_OF_LOOP' };
        await this.ensureRuntime(tx, projectId, now);
        if (project.status !== 'OPEN' || !project.coordinatorEnabled) {
            // This is terminal/inert cleanup, not a reconcile. Advancing the fence invalidates a holder
            // that raced the user's stop/terminal write; applyAction also re-checks the Project row.
            await tx.$executeRaw(client_1.Prisma.sql `
        UPDATE "project_runtime"
           SET "run_state" = ${project.status === 'OPEN' ? 'PLANNING' : 'SETTLED'}::"project_run_state",
               "next_wake_at" = NULL, "next_wake_reason" = NULL,
               "fencing_token" = "fencing_token" + CASE WHEN "lease_holder" IS NULL THEN 0 ELSE 1 END,
               "lease_holder" = NULL, "lease_expires_at" = NULL, "lease_heartbeat_at" = NULL,
               "updated_at" = ${now}
         WHERE "project_id" = ${projectId}::uuid
      `);
            return { disposition: 'DISCARDED_OUT_OF_LOOP' };
        }
        const lease = await this.acquireLeaseInTransaction(tx, projectId, now);
        if (!lease) {
            const rows = await tx.$queryRaw(client_1.Prisma.sql `
        SELECT "lease_expires_at" AS "leaseExpiresAt" FROM "project_runtime"
         WHERE "project_id" = ${projectId}::uuid
      `);
            return { deferUntil: contentionWake(projectId, rows[0]?.leaseExpiresAt, now) };
        }
        let state;
        let nextWakeAt;
        let nextWakeReason;
        let held;
        let answered;
        if (this.decisions) {
            const captured = await this.decisions.capture(tx, projectId, now);
            const decisionId = (0, project_decision_service_1.createDecisionId)();
            const consumedEventIds = _events.map((event) => (0, shared_1.uuidToBase62)(event.id));
            const base = (0, project_decision_service_1.planProjectDecision)(captured.input, { decisionId, consumedEventIds });
            // §13.2's consequences, proposed by the unit that applies them the way §7.8's dispatch is —
            // `plannedActions` proposes only the rotation, and every other action in §7.3's table comes
            // from its own applier passing its own list. `base.actions` is that list, re-planned with the
            // one verdict this pass will claim appended, so the decision that authorises the action and
            // the pass that applies it read one snapshot.
            const pending = await this.pendingVerificationVerdicts(tx, projectId, captured.input);
            // §13.2 V8, proposed on the same terms and behind the verdicts: both write task rows, so the
            // second of any two in one pass would be refused `STALE_SNAPSHOT` by the effects of the first
            // — and a refusal spends a permanent key. Deferring costs one wake, which the floor below
            // pays for; sharing a pass would cost a generation.
            const filings = pending.length ? [] : this.pendingVerificationFilings(captured.input);
            const proposed = pending.length
                ? [this.verdictAction(projectId, pending[0])]
                : filings.length ? [this.filingAction(projectId, filings[0])] : [];
            const outcome = proposed.length
                ? (0, project_decision_service_1.planProjectDecision)(captured.input, {
                    decisionId,
                    consumedEventIds,
                    actions: [...base.actions, ...proposed],
                })
                : base;
            if (BigInt(outcome.fencingToken) !== lease.fencingToken) {
                throw new ProjectLeaseLostError(projectId);
            }
            await this.decisions.persist(tx, captured, outcome, decisionId);
            // Before the two writers below, and not after them, for a reason the ledger makes concrete:
            // §7.7's staleness gate re-captures the world and compares hashes, and REPEATABLE READ shows
            // a transaction its OWN writes. Aggregating a parent or raising a blocker first would make
            // this pass's snapshot differ from itself, and the rotation it just decided would be refused
            // `STALE_SNAPSHOT` by the very facts it produced.
            //
            // The verdict sits between them for exactly the same reason, and it is why this pass applies
            // at most ONE: a rotation writes the Project row and a verdict writes task rows, so the
            // second of any two would be refused by the effects of the first. Whatever is left over is
            // not lost, it is next: the wake below is floored to now so the loop comes straight back.
            const rotationAttempted = await this.applyCoordinatorRotation(tx, lease, decisionId, outcome, now);
            const verdictsLeft = await this.applyVerificationVerdicts(tx, lease, decisionId, pending, rotationAttempted, now);
            const filingsLeft = await this.applyVerificationFilings(tx, lease, decisionId, filings, rotationAttempted, now);
            // §7.6, third in the same one-gated-write-per-pass chain, and LAST of the three on purpose:
            // a verdict rewrites the very task rows a turn's facts are computed from, so waking the
            // coordinator on the world the verdict PRODUCED — next pass, under a different digest if the
            // facts moved — is the correct order rather than merely a legal one. A rotation never
            // competes with a turn at all: TU7 makes `ROTATE` and `OPEN` mutually exclusive on one
            // snapshot, because a turn needs a live run to land in and a rotation means there is none.
            const turn = await this.applyCoordinatorTurn(tx, lease, decisionId, outcome, {
                gatedWriteTaken: rotationAttempted || pending.length > 0 || filings.length > 0,
                automationPolicy: captured.input.world.project.automationPolicy,
            }, now);
            await this.applyAggregations(tx, projectId, outcome.aggregations, now);
            await this.applyBlockers(tx, projectId, lease, decisionId, outcome.blockers, now);
            state = outcome.runStateAfter;
            nextWakeAt = outcome.nextWakeAt ? new Date(outcome.nextWakeAt) : null;
            nextWakeReason = outcome.nextWakeReason;
            // §10.4 chose a wake for a world that has one more thing to do in it. Floor it — never
            // push it out — and only take the reason when this is genuinely the earlier alarm, so a
            // blocker's own recheck keeps its explanation when it was already due.
            if ((verdictsLeft > 0 || filingsLeft > 0 || turn === 'DEFERRED')
                && !(nextWakeAt && nextWakeAt <= now)) {
                nextWakeAt = now;
                nextWakeReason = verdictsLeft > 0
                    ? `${verdictsLeft} verification verdict(s) awaiting consequences`
                    : filingsLeft > 0
                        ? `${filingsLeft} verification task(s) awaiting filing`
                        : 'coordinator turn awaiting a pass of its own';
            }
            // §7.6 TR2-c: an explicit request's `consumed_at` is written only when it is ANSWERED, and
            // the only answer this pass can give is a committed `MANUAL` turn. Rate-limited, in flight,
            // no live run, refused at the commit point — all of them mean the request has not happened
            // yet, and consuming it would delete a person's "run it now" with nothing to show for it
            // (`PC-CX-31`). It is not a failed delivery either, so `attempts` is untouched: it is put
            // back with a retry instant, which is TR2-b ③ when a window is holding it and this pass's
            // own wake otherwise.
            const requests = captured.input.signals.map((signal) => (0, shared_1.base62ToUuid)(signal.eventId));
            if (requests.length > 0) {
                // TF5: the one turn answers EVERY request outstanding at the time, so they are consumed
                // together — including ones an earlier window held, which is why this is not just "the
                // batch that was delivered".
                if (turn === 'APPLIED' && outcome.turnReason === 'MANUAL')
                    answered = requests;
                else {
                    held = {
                        eventIds: requests,
                        nextAttemptAt: outcome.turn?.verdict === 'RATE_LIMITED' && outcome.turn.windowEndsAt
                            ? new Date(outcome.turn.windowEndsAt)
                            : nextWakeAt ?? new Date(now.getTime() + exports.PROJECT_RECONCILE_BACKSTOP_MS),
                    };
                }
            }
        }
        else {
            state = await this.runStateOf(tx, projectId);
            nextWakeAt = state === 'SETTLED' ? null : new Date(now.getTime() + 60_000);
            nextWakeReason = state === 'PLANNING'
                ? 'planning requires coordinator turn'
                : state === 'EXECUTING'
                    ? 'in-flight session may end'
                    : state === 'AWAITING_VERIFICATION'
                        ? 'verification may settle'
                        : 'reconcile state recheck';
        }
        const updated = await tx.$executeRaw(client_1.Prisma.sql `
      UPDATE "project_runtime"
         SET "run_state" = ${state}::"project_run_state",
             "next_wake_at" = ${nextWakeAt},
             "next_wake_reason" = ${nextWakeAt ? nextWakeReason : null},
             "lease_holder" = NULL, "lease_expires_at" = NULL, "lease_heartbeat_at" = NULL,
             "updated_at" = ${now}
       WHERE "project_id" = ${projectId}::uuid
         AND "lease_holder" = ${lease.holder}::uuid
         AND "fencing_token" = ${lease.fencingToken}
    `);
        if (updated !== 1)
            throw new ProjectLeaseLostError(projectId);
        return { disposition: 'RECONCILED', hold: held, answered };
    }
    /**
     * §8.3's commit has happened; now the rest of the system can be told about it. Nothing here is
     * allowed to be load-bearing — a lost notification costs latency, and the Session it announces is
     * already committed PENDING where the runner's own poll will find it.
     *
     * §7.8's dispatch pass runs from here, and this is the only place it runs from. It needs the
     * lease that `handle` has just released and transactions of its own, so it cannot be inside the
     * delivery; and giving it a timer would make §10.2's "exactly three wake paths" four, which W1
     * calls a production incident by name. Running it per RECONCILED delivery instead means the
     * cadence of dispatch attempts is §10.4's wake schedule — a blocker's `nextCheckAt`, a backoff,
     * the in-flight fallback, the backstop — which is what paces a task that keeps being refused.
     *
     * `DISCARDED` is excluded deliberately: that disposition is §5.5's terminal/inert cleanup for a
     * project that is not OPEN or has the coordinator switched off, and I6 forbids reconciling one.
     */
    async afterCommit(result) {
        await this.flushPendingRotations();
        await this.flushPendingTurns();
        if (!this.dispatchPass || result?.status !== 'CONSUMED')
            return;
        // Never load-bearing, exactly as above: the delivery has committed, and a pass that threw must
        // not turn a durable reconcile into a retried one. The next wake runs it again.
        await this.dispatchPass.runFor(result.projectId).catch((cause) => {
            this.log.error(`Project dispatch pass failed after commit: ${errorText(cause)}`);
        });
    }
    /**
     * §5.4 F22: these events have failed ten deliveries and are about to be discarded for good.
     *
     * What that costs is not recoverable — the signals are gone, and no later pass can re-derive what
     * they would have changed — so this writes the fail-closed row §11.2 BL2 requires, in the SAME
     * transaction that marks them DEAD. Either both happen or neither does: the caller lets this
     * throw precisely so that a blocker that could not be written keeps the events live.
     *
     * It is a raise-OR-touch, not an insert. Repeated, concurrent, out-of-order and post-restart
     * dead letters all land on the one dedupe key §11.3 gives this cause, so the second one moves two
     * display columns instead of opening a second episode, and an episode that is already old enough
     * escalates exactly once. The row then stays open on its own: §11.4 recomputes the condition from
     * `world.deadLetters`, which keeps returning these events until a person acknowledges them.
     *
     * The clock stays too. `next_wake_at` is deliberately the recovery poll this path has always
     * written rather than §10.4's answer — no snapshot was captured here, so there is nothing to run
     * §10.4 against; it is strictly earlier than the escalation alarm, so it costs one recompute and
     * misses nothing, and the pass it schedules is what writes the contract's wake.
     */
    async deadLetter(tx, projectId, events, error) {
        const now = new Date();
        await this.ensureRuntime(tx, projectId, now);
        const lease = await this.acquireLeaseInTransaction(tx, projectId, now);
        if (!lease)
            throw new Error(`cannot persist dead-letter recovery while ${projectId} is leased`);
        const publicProjectId = (0, shared_1.uuidToBase62)(projectId);
        const condition = (0, project_blocker_1.projectDeadLetterCondition)(publicProjectId, events.map((event) => ({
            eventId: (0, shared_1.uuidToBase62)(event.id),
            kind: event.kind,
            // §8.2 / AC1: this lands in a blocker `detail` a person reads, so the uuid inside the
            // event's dedupe key is spelled the way they can paste it — exactly as `capture` does it
            // for the same field on the recomputation side.
            dedupeKey: (0, project_decision_service_1.publicIdempotencyKey)(event.dedupeKey),
            attempts: event.attempts + 1,
        })));
        const dedupeKey = (0, project_blocker_1.projectBlockerDedupeKey)('UNKNOWN_FAILURE', 'PROJECT', publicProjectId);
        // Only THIS key's open row, never the project's whole open set: §11.4's clear is a set
        // difference against what was observed, and handing it rows this call has no opinion about
        // would resolve every other blocker the project has.
        const openRows = await tx.$queryRaw(client_1.Prisma.sql `
      SELECT "id", "kind", "owner"::text, "recovery"::text, "severity"::text,
             "required_action" AS "requiredAction", "subject_type" AS "subjectType",
             "lifecycle_generation" AS "lifecycleGeneration",
             "condition_version" AS "conditionVersion", "first_seen_at" AS "firstSeenAt",
             "last_seen_at" AS "lastSeenAt", "occurrences",
             "next_check_at" AS "nextCheckAt", "escalated_at" AS "escalatedAt"
        FROM "project_blocker"
       WHERE "project_id" = ${projectId}::uuid
         AND "dedupe_key" = ${internalDedupeKey(dedupeKey)}
         AND "resolved_at" IS NULL
    `);
        const plan = (0, project_blocker_1.planProjectBlockers)({
            epoch: Math.floor(now.getTime() / 1_000),
            open: openRows.map((row) => ({
                id: (0, shared_1.uuidToBase62)(row.id),
                kind: row.kind,
                owner: row.owner,
                recovery: row.recovery,
                severity: row.severity,
                requiredAction: row.requiredAction,
                subjectType: row.subjectType,
                // Provably this project: the row was selected BY the key whose third field is its id.
                subjectId: publicProjectId,
                dedupeKey,
                lifecycleGeneration: String(row.lifecycleGeneration),
                conditionVersion: row.conditionVersion,
                firstSeenAt: row.firstSeenAt.toISOString(),
                lastSeenAt: row.lastSeenAt.toISOString(),
                occurrences: row.occurrences,
                nextCheckAt: row.nextCheckAt.toISOString(),
                escalatedAt: row.escalatedAt ? row.escalatedAt.toISOString() : null,
            })),
            observed: [condition],
        });
        await this.applyBlockers(tx, projectId, lease, null, {
            raised: plan.raises,
            touched: plan.touches,
            // Nothing this call saw says any OTHER condition went away, and the only key it was given is
            // the one it just observed — so there is nothing to clear, by construction.
            cleared: [],
            escalated: plan.escalations,
            open: plan.openAfter,
        }, now, {
            // The exception text is a delivery observation, so it stays out of the blocker row that
            // §11.3 rewrites on every touch and goes to the append-only ledger instead: one permanent
            // record per episode, which is where somebody reading "what happened here" should land.
            lastError: errorText(error),
            deadEventIds: condition.facts.deadEventIds,
        });
        // §4.2 RS0 / TS4: the state persisted here has to be the one this snapshot's guards produce,
        // and an open USER blocker makes that AWAITING_HUMAN by guard 2.
        const state = (0, project_blocker_1.blockerRunState)(plan.openAfter) ?? 'PLANNING';
        const updated = await tx.$executeRaw(client_1.Prisma.sql `
      UPDATE "project_runtime"
         SET "run_state" = ${state}::"project_run_state",
             "next_wake_at" = ${new Date(now.getTime() + exports.PROJECT_RECONCILE_STALE_MS)},
             "next_wake_reason" = ${`reconcile dead letter: ${errorText(error)}`},
             "lease_holder" = NULL, "lease_expires_at" = NULL, "lease_heartbeat_at" = NULL,
             "updated_at" = ${now}
       WHERE "project_id" = ${projectId}::uuid
         AND "lease_holder" = ${lease.holder}::uuid
         AND "fencing_token" = ${lease.fencingToken}
    `);
        if (updated !== 1)
            throw new ProjectLeaseLostError(projectId);
    }
    /** Persistently acquire the Project lease; returns null for an inactive, missing or busy row. */
    async acquireLease(projectId, now = new Date()) {
        // Retried whole. Acquiring a lease is a compare-and-set on the project row: an attempt the
        // server threw away took no lease, so a re-run competes for it from the state that exists.
        return (0, transaction_retry_1.withTransactionRetry)(this.prisma, async (tx) => {
            const projects = await tx.$queryRaw(client_1.Prisma.sql `
        SELECT "id" FROM "project"
         WHERE "id" = ${projectId}::uuid AND "status" = 'OPEN' AND "coordinator_enabled" = true
         FOR NO KEY UPDATE
      `);
            if (!projects[0])
                return null;
            await this.ensureRuntime(tx, projectId, now);
            return this.acquireLeaseInTransaction(tx, projectId, now);
        }, (0, transaction_retry_1.loggedRetry)(this.log, 'projectReconcile.acquireLease'));
    }
    async renewLease(lease, now = new Date()) {
        const expiresAt = new Date(now.getTime() + exports.PROJECT_RECONCILE_LEASE_MS);
        const rows = await this.prisma.$queryRaw(client_1.Prisma.sql `
      UPDATE "project_runtime"
         SET "lease_heartbeat_at" = ${now}, "lease_expires_at" = ${expiresAt},
             "updated_at" = ${now}
       WHERE "project_id" = ${lease.projectId}::uuid
         AND "lease_holder" = ${lease.holder}::uuid
         AND "fencing_token" = ${lease.fencingToken}
         AND "lease_expires_at" > ${now}
      RETURNING "fencing_token" AS "fencingToken", "lease_expires_at" AS "leaseExpiresAt"
    `);
        if (!rows[0])
            throw new ProjectLeaseLostError(lease.projectId);
        return {
            ...lease,
            fencingToken: BigInt(rows[0].fencingToken),
            expiresAt: rows[0].leaseExpiresAt,
        };
    }
    async releaseLease(lease) {
        const updated = await this.prisma.$executeRaw(client_1.Prisma.sql `
      UPDATE "project_runtime"
         SET "lease_holder" = NULL, "lease_expires_at" = NULL,
             "lease_heartbeat_at" = NULL, "updated_at" = CURRENT_TIMESTAMP
       WHERE "project_id" = ${lease.projectId}::uuid
         AND "lease_holder" = ${lease.holder}::uuid
         AND "fencing_token" = ${lease.fencingToken}
    `);
        return updated === 1;
    }
    /**
     * Claim a permanent action key, perform its database effect, and publish APPLIED atomically.
     * `effect` must only use the supplied transaction; external side effects cannot satisfy this API.
     */
    async applyAction(lease, action, effect, now = new Date()) {
        this.assertAction(lease, action);
        // Retried whole. `effect` is contractually database-only (see this method's doc comment), the
        // action key is the caller's and computed above, and the claim/publish pair is re-read under
        // the project lock inside the closure — so a re-run either re-claims a key nobody took or
        // finds the winner's, which is the same pair of outcomes a first attempt has.
        return (0, transaction_retry_1.withTransactionRetry)(this.prisma, async (tx) => {
            const projects = await tx.$queryRaw(client_1.Prisma.sql `
        SELECT "status", "coordinator_enabled" AS "coordinatorEnabled"
          FROM "project" WHERE "id" = ${lease.projectId}::uuid FOR NO KEY UPDATE
      `);
            if (projects[0]?.status !== 'OPEN' || !projects[0]?.coordinatorEnabled) {
                throw new ProjectLeaseLostError(lease.projectId);
            }
            const expiresAt = new Date(now.getTime() + exports.PROJECT_RECONCILE_LEASE_MS);
            const fenced = await tx.$executeRaw(client_1.Prisma.sql `
        UPDATE "project_runtime"
           SET "lease_heartbeat_at" = ${now}, "lease_expires_at" = ${expiresAt},
               "updated_at" = ${now}
         WHERE "project_id" = ${lease.projectId}::uuid
           AND "lease_holder" = ${lease.holder}::uuid
           AND "fencing_token" = ${lease.fencingToken}
           AND "lease_expires_at" > ${now}
      `);
            if (fenced !== 1)
                throw new ProjectLeaseLostError(lease.projectId);
            const actionId = (0, node_crypto_1.randomUUID)();
            const inserted = await tx.$queryRaw(client_1.Prisma.sql `
        INSERT INTO "project_action" (
          "id", "project_id", "idempotency_key", "type", "status",
          "subject_type", "subject_id", "fencing_token", "detail", "updated_at"
        ) VALUES (
          ${actionId}::uuid, ${lease.projectId}::uuid, ${action.idempotencyKey},
          ${action.type}::"project_action_type", 'CLAIMED', ${action.subject.type},
          ${action.subject.id ?? null}::uuid, ${lease.fencingToken},
          ${JSON.stringify(action.detail ?? {})}::jsonb, ${now}
        )
        ON CONFLICT ("idempotency_key") DO NOTHING
        RETURNING "id"
      `);
            if (!inserted[0]) {
                const existing = (await tx.$queryRaw(client_1.Prisma.sql `
          SELECT "id", "project_id" AS "projectId", "status"
            FROM "project_action" WHERE "idempotency_key" = ${action.idempotencyKey}
        `))[0];
                if (!existing || existing.projectId !== lease.projectId) {
                    throw new Error(`idempotency key ${action.idempotencyKey} belongs to another Project`);
                }
                return {
                    status: 'ALREADY_APPLIED', actionId: existing.id, actionStatus: existing.status,
                };
            }
            await effect(tx, actionId);
            const published = await tx.$executeRaw(client_1.Prisma.sql `
        UPDATE "project_action" SET "status" = 'APPLIED', "updated_at" = ${now}
         WHERE "id" = ${actionId}::uuid AND "status" = 'CLAIMED'
      `);
            if (published !== 1)
                throw new Error(`failed to publish Project action ${actionId}`);
            return { status: 'APPLIED', actionId };
        }, (0, transaction_retry_1.loggedRetry)(this.log, 'projectReconcile.applyAction'));
    }
    /**
     * Apply one action attributed to a persisted decision. The comparison reuses the decision's
     * frozen evaluation instant, so time passing alone does not invalidate it; any changed world or
     * semantic signal does. A stale proposal is a committed REFUSED audit result plus a durable
     * outbox wake, never a partially applied effect or a silent rollback.
     */
    async applyDecisionAction(lease, decisionId, action, effect, now = new Date()) {
        this.assertAction(lease, action);
        if (action.subject.type === 'PROJECT' && action.subject.id !== lease.projectId) {
            throw new Error('Project action subject belongs to another Project');
        }
        if (!this.decisions)
            throw new Error('Project decision protocol is not configured');
        return this.repeatableRead(async (tx) => this.applyDecisionActionInTransaction(tx, lease, decisionId, action, effect, now));
    }
    /**
     * §8.3's transaction, as a step rather than as a transaction.
     *
     * The published SQL puts the side effect, the ledger row, the decision and the event consumption
     * in ONE commit; `applyDecisionAction` above is that shape when the caller has nothing else to
     * commit, and this is the same shape when it has — the reconcile pass, which is already inside a
     * REPEATABLE READ transaction holding this Project's row lock and its lease. Sharing the body is
     * the point: an action applied from the loop and one applied by a lease holder outside it must
     * pass through the same fence, the same staleness gate and the same ledger, or the two paths
     * would eventually disagree about what "already done" means.
     */
    async applyDecisionActionInTransaction(tx, lease, decisionId, action, effect, now) {
        {
            const projects = await tx.$queryRaw(client_1.Prisma.sql `
        SELECT "status", "coordinator_enabled" AS "coordinatorEnabled"
          FROM "project" WHERE "id" = ${lease.projectId}::uuid FOR NO KEY UPDATE
      `);
            if (projects[0]?.status !== 'OPEN' || !projects[0]?.coordinatorEnabled) {
                throw new ProjectLeaseLostError(lease.projectId);
            }
            const expiresAt = new Date(now.getTime() + exports.PROJECT_RECONCILE_LEASE_MS);
            const fenced = await tx.$executeRaw(client_1.Prisma.sql `
        UPDATE "project_runtime"
           SET "lease_heartbeat_at" = ${now}, "lease_expires_at" = ${expiresAt},
               "updated_at" = ${now}
         WHERE "project_id" = ${lease.projectId}::uuid
           AND "lease_holder" = ${lease.holder}::uuid
           AND "fencing_token" = ${lease.fencingToken}
           AND "lease_expires_at" > ${now}
      `);
            if (fenced !== 1)
                throw new ProjectLeaseLostError(lease.projectId);
            const decision = await this.decisions.getInternal(tx, lease.projectId, decisionId);
            if (!decision)
                throw new Error(`Project decision ${decisionId} does not belong to ${lease.projectId}`);
            const input = decision.decisionInput;
            if (input.decisionInputHash !== decision.decisionInputHash
                || (0, project_decision_service_1.hashDecisionInput)(input) !== decision.decisionInputHash) {
                throw new Error(`Project decision ${decisionId} has an invalid input hash`);
            }
            const decisionOutcome = decision.outcome;
            if (decisionOutcome.decisionInputHash !== decision.decisionInputHash
                || decisionOutcome.reconcileId !== (0, shared_1.uuidToBase62)(decisionId)) {
                throw new Error(`Project decision ${decisionId} has an invalid outcome lineage`);
            }
            const publicSubjectId = action.subject.id ? (0, shared_1.uuidToBase62)(action.subject.id) : null;
            // Both spellings of the key, normalized to the audit's (§6.2). A plan is written in Base62
            // and the ledger row is keyed by the internal id (§8.2); comparing the two raw would make a
            // legitimately planned action look unplanned purely because of how each side spells an id.
            const plannedKey = (0, project_decision_service_1.publicIdempotencyKey)(action.idempotencyKey);
            const planned = decisionOutcome.actions.some((candidate) => candidate.type === action.type
                && (0, project_decision_service_1.publicIdempotencyKey)(candidate.idempotencyKey) === plannedKey
                && candidate.subject.type === action.subject.type
                && (candidate.subject.id ?? null) === publicSubjectId);
            if (!planned) {
                throw new Error(`Project action ${action.idempotencyKey} is not present in decision ${decisionId}`);
            }
            const current = await this.decisions.capture(tx, lease.projectId, new Date(input.readAt));
            const stale = current.input.decisionInputHash !== decision.decisionInputHash;
            const actionId = (0, node_crypto_1.randomUUID)();
            const detail = action.detail && typeof action.detail === 'object' && !Array.isArray(action.detail)
                ? { ...action.detail,
                    decisionInputHash: decision.decisionInputHash,
                    ...(stale ? {
                        actualDecisionInputHash: current.input.decisionInputHash,
                        dispatchFailure: {
                            v: 1, refusalCode: 'STALE_SNAPSHOT', reasonCode: 'STALE_SNAPSHOT',
                            retryable: true, retryAt: now.toISOString(),
                        },
                    } : {}) }
                : {
                    value: action.detail ?? null,
                    decisionInputHash: decision.decisionInputHash,
                    ...(stale ? {
                        actualDecisionInputHash: current.input.decisionInputHash,
                        dispatchFailure: {
                            v: 1, refusalCode: 'STALE_SNAPSHOT', reasonCode: 'STALE_SNAPSHOT',
                            retryable: true, retryAt: now.toISOString(),
                        },
                    } : {}),
                };
            const inserted = await tx.$queryRaw(client_1.Prisma.sql `
        INSERT INTO "project_action" (
          "id", "project_id", "idempotency_key", "type", "status", "subject_type",
          "subject_id", "fencing_token", "decision_id", "refusal_code", "detail", "updated_at"
        ) VALUES (
          ${actionId}::uuid, ${lease.projectId}::uuid, ${action.idempotencyKey},
          ${action.type}::"project_action_type", ${stale ? 'REFUSED' : 'CLAIMED'}::"project_action_status",
          ${action.subject.type}, ${action.subject.id ?? null}::uuid, ${lease.fencingToken},
          ${decisionId}::uuid, ${stale ? 'STALE_SNAPSHOT' : null},
          ${JSON.stringify(detail)}::jsonb, ${now}
        )
        ON CONFLICT ("idempotency_key") DO NOTHING
        RETURNING "id"
      `);
            if (!inserted[0]) {
                const existing = (await tx.$queryRaw(client_1.Prisma.sql `
          SELECT "id", "project_id" AS "projectId", "status"
            FROM "project_action" WHERE "idempotency_key" = ${action.idempotencyKey}
        `))[0];
                if (!existing || existing.projectId !== lease.projectId) {
                    throw new Error(`idempotency key ${action.idempotencyKey} belongs to another Project`);
                }
                return {
                    status: 'ALREADY_APPLIED', actionId: existing.id, actionStatus: existing.status,
                };
            }
            // The attempt belongs to the permanently claimed action key, not to a process invocation.
            // It therefore advances once for stale/refused/applied outcomes and never on a replay.
            if (action.type === 'DISPATCH_TASK' && action.subject.id) {
                await tx.$executeRaw(client_1.Prisma.sql `
          UPDATE "task" SET "dispatch_attempt" = "dispatch_attempt" + 1
           WHERE "id" = ${action.subject.id}::uuid
             AND "project_id" = ${lease.projectId}::uuid
        `);
            }
            if (stale) {
                await this.events.enqueue(tx, {
                    projectId: lease.projectId,
                    kind: 'coordinator.snapshot_stale',
                    source: { type: 'TIMER', id: lease.projectId },
                    dedupeKey: `coordinator.snapshot_stale:${decisionId}:${actionId}`,
                    payload: {
                        decisionId,
                        actionId,
                        expectedDecisionInputHash: decision.decisionInputHash,
                        actualDecisionInputHash: current.input.decisionInputHash,
                    },
                    occurredAt: now,
                });
                const scheduled = await tx.$executeRaw(client_1.Prisma.sql `
          UPDATE "project_runtime"
             SET "next_wake_at" = LEAST(COALESCE("next_wake_at", ${now}), ${now}),
                 "next_wake_reason" = 'stale Coordinator decision requires reconcile',
                 "updated_at" = ${now}
           WHERE "project_id" = ${lease.projectId}::uuid
             AND "lease_holder" = ${lease.holder}::uuid
             AND "fencing_token" = ${lease.fencingToken}
        `);
                if (scheduled !== 1)
                    throw new ProjectLeaseLostError(lease.projectId);
                return {
                    status: 'REFUSED',
                    actionId,
                    refusalCode: 'STALE_SNAPSHOT',
                    expectedDecisionInputHash: decision.decisionInputHash,
                    actualDecisionInputHash: current.input.decisionInputHash,
                };
            }
            const effectResult = await effect(tx, actionId);
            if (effectResult) {
                const reasonCode = effectResult.reasonCode ?? effectResult.refusalCode;
                const refused = await tx.$executeRaw(client_1.Prisma.sql `
          UPDATE "project_action"
             SET "status" = ${effectResult.status}::"project_action_status",
                 "refusal_code" = ${effectResult.refusalCode},
                 "reason_code" = ${reasonCode},
                 "detail" = "detail" || ${JSON.stringify(effectResult.detail ?? {})}::jsonb,
                 "updated_at" = ${now}
           WHERE "id" = ${actionId}::uuid AND "status" = 'CLAIMED'
             AND "decision_id" = ${decisionId}::uuid
        `);
                if (refused !== 1)
                    throw new Error(`failed to refuse Project action ${actionId}`);
                return {
                    status: effectResult.status,
                    actionId,
                    refusalCode: effectResult.refusalCode,
                    reasonCode,
                };
            }
            const published = await tx.$executeRaw(client_1.Prisma.sql `
        UPDATE "project_action" SET "status" = 'APPLIED', "updated_at" = ${now}
         WHERE "id" = ${actionId}::uuid AND "status" = 'CLAIMED'
           AND "decision_id" = ${decisionId}::uuid
      `);
            if (published !== 1)
                throw new Error(`failed to publish Project action ${actionId}`);
            return { status: 'APPLIED', actionId };
        }
    }
    /**
     * PostgreSQL may abort an RR contender whose first snapshot predates a conflicting action.
     *
     * Which failures count as that, what the whole-transaction retry looks like and what it says in
     * the log are the shared `withTransactionRetry` rules (common/transaction-retry) rather than this
     * service's: an aborted transaction means the same thing here as it does anywhere else in the API
     * server, and a second local answer to any of those questions could only ever disagree with the
     * first. The line this used to write is one of them — it interpolated the driver's own error
     * text, which is where the failing SQL and its parameter values live.
     */
    async repeatableRead(effect) {
        return (0, transaction_retry_1.withTransactionRetry)(this.prisma, effect, (0, transaction_retry_1.loggedRetry)(this.log, 'project.applyDecisionAction', {
            transaction: { isolationLevel: client_1.Prisma.TransactionIsolationLevel.RepeatableRead },
        }));
    }
    async acquireLeaseInTransaction(tx, projectId, now) {
        const expiresAt = new Date(now.getTime() + exports.PROJECT_RECONCILE_LEASE_MS);
        const rows = await tx.$queryRaw(client_1.Prisma.sql `
      UPDATE "project_runtime"
         SET "lease_holder" = ${this.instanceId}::uuid,
             "lease_expires_at" = ${expiresAt}, "lease_heartbeat_at" = ${now},
             "fencing_token" = "fencing_token" + 1, "updated_at" = ${now}
       WHERE "project_id" = ${projectId}::uuid
         AND ("lease_holder" IS NULL OR "lease_expires_at" <= ${now})
      RETURNING "fencing_token" AS "fencingToken", "lease_expires_at" AS "leaseExpiresAt"
    `);
        if (!rows[0])
            return null;
        return {
            projectId,
            holder: this.instanceId,
            fencingToken: BigInt(rows[0].fencingToken),
            expiresAt: rows[0].leaseExpiresAt,
        };
    }
    /**
     * Write the parent statuses this pass recomputed (§13.1 AG5).
     *
     * Each one is a compare-and-set against the status the decision snapshot read, and matching zero
     * rows is a normal result with two harmless readings: the parent already holds the recomputed
     * value, or somebody changed it after the snapshot — in which case the row's own write has
     * already enqueued the signal that will bring this loop back with the newer facts. That is the
     * entire concurrency story, and it is why this takes no action-ledger key: there is no permanent
     * identity to collide with when a child goes DONE, OPEN and DONE again (PC-CX-17).
     *
     * The Project row is already held `FOR NO KEY UPDATE` by the delivery transaction, and each
     * write here fires the same `task.status_changed` source every other status write fires — so a
     * level this pass could not see (a parent whose own parent is in another Project, a tree that
     * grew mid-transaction) is picked up by the next reconcile rather than missed.
     *
     * Public for the same reason `applyAction` is: the compare-and-set is the guarantee, so the
     * harness that proves a stale plan writes nothing has to call the real one.
     */
    async applyAggregations(tx, projectId, aggregations, now) {
        let applied = 0;
        for (const aggregation of aggregations) {
            applied += await tx.$executeRaw(client_1.Prisma.sql `
        UPDATE "task"
           SET "status" = ${aggregation.to}::"task_status", "updated_at" = ${now}
         WHERE "id" = ${(0, shared_1.base62ToUuid)(aggregation.taskId)}::uuid
           AND "project_id" = ${projectId}::uuid
           AND "status" = ${aggregation.from}::"task_status"
           AND "status" IS DISTINCT FROM ${aggregation.to}::"task_status"
      `);
        }
        return applied;
    }
    /**
     * Commit §11's plan — the raises, the repeat-cause touches, the auto-clears and the one-shot
     * escalations — inside the SAME transaction that publishes the decision and the runtime state.
     *
     * One transaction is not an optimisation: §11.4 requires that clearing a condition recompute
     * `run_state` and `nextWakeAt` immediately rather than on the next tick, and the outcome this is
     * given was already computed from the post-plan open set. Splitting them would publish a state
     * derived from blockers that had not been written yet.
     *
     * This deliberately does not go through `applyDecisionAction`: that opens its own transaction,
     * and a blocker written in a second one would be a state the runtime row could disagree with.
     * The ledger discipline is kept in full here — every raise and every clear claims its permanent
     * key (§7.3), and §8.5 C1/C2's "conflict is a return value, not a rollback" is the reason the
     * inserts end in `ON CONFLICT DO NOTHING`.
     */
    /**
     * §7.5's rotation, executed by the loop that decided it.
     *
     * Registered rather than injected, exactly as the event handler is: the rotation service needs
     * the ledger and the ledger needs the rotation service, and a registration keeps that a wiring
     * fact instead of a `forwardRef` between two singletons. The reconcile pass is the ONLY
     * production caller, and it calls this INSIDE its own transaction — §8.3's commit is one commit,
     * so the ledger row, the new run, the pointer swap, this pass's decision and the events it
     * consumes either all land or none do.
     *
     * A refusal is a committed audit row and not an exception: the pass carries on and publishes its
     * state, because the reason the rotation did not happen is a fact somebody has to be able to
     * read. An exception, by contrast, rolls the pass back to its savepoint and the events retry —
     * which is the right answer for a fault nobody classified (§8.5 C4) and the wrong one for
     * "this was refused".
     */
    async applyCoordinatorRotation(tx, lease, decisionId, outcome, now) {
        const planned = outcome.coordinator;
        if (planned?.status !== 'ROTATE')
            return false;
        const action = outcome.actions.find((candidate) => candidate.type === 'ROTATE_COORDINATOR_SESSION');
        if (!action)
            return false;
        if (!this.rotationExecutor) {
            // Nest always registers one. Warn rather than throw: a deployment that somehow has none must
            // still publish its run state and consume its events, and the next pass re-plans the same
            // rotation from the same facts.
            this.log.warn(`Project ${lease.projectId} planned a coordinator rotation with no executor`);
            return false;
        }
        const result = await this.applyDecisionActionInTransaction(tx, lease, decisionId, {
            type: 'ROTATE_COORDINATOR_SESSION',
            idempotencyKey: this.rotationExecutor.idempotencyKey(lease.projectId, planned.generation),
            subject: { type: 'PROJECT', id: lease.projectId },
            detail: this.rotationExecutor.actionDetail(planned),
        }, async (effectTx, actionId) => this.rotationExecutor.rotateInTransaction(effectTx, lease, {
            decisionId,
            planned,
        }, actionId, now), now);
        if (result.status === 'APPLIED') {
            // The runner has to be told, and telling it is not a database write — so it happens after the
            // commit this is part of, never inside it. `pendingRotations` is drained by whoever drove the
            // drain, and re-reads the ledger before notifying: a rollback after this point leaves a row
            // that says nothing was applied, and no notification is sent for it.
            this.pendingRotations.push(result.actionId);
        }
        // Whether the ledger was ENTERED, not whether the rotation succeeded. A refusal writes too — a
        // `project_action` row and, for `STALE_SNAPSHOT`, this project's `next_wake_at`, which the
        // snapshot hash is computed over. Reporting "no" here would hand the verdict below a snapshot
        // that its own predecessor had already invalidated.
        return true;
    }
    /**
     * §7.6's turn, applied from the pass that decided it.
     *
     * `deferred` is not a refusal and takes no key: this pass has already spent its one
     * staleness-gated write, so the turn would be refused `STALE_SNAPSHOT` by the effects of the
     * write that went first — and a `STALE_SNAPSHOT` row is a permanent claim on the key, which
     * would make TR3 read the NEXT identical snapshot as "the coordinator already looked at this and
     * changed nothing". Leaving the key unspent and flooring the wake is what keeps the episode
     * intact; the caller does the flooring.
     */
    async applyCoordinatorTurn(tx, lease, decisionId, outcome, context, now) {
        const planned = outcome.turn;
        if (planned?.verdict !== 'OPEN')
            return 'NOT_PLANNED';
        const action = outcome.actions.find((candidate) => candidate.type === 'OPEN_COORDINATOR_TURN');
        if (!action)
            return 'NOT_PLANNED';
        if (!this.turnExecutor) {
            // Nest always registers one. Warn rather than throw, exactly as the rotation does: a
            // deployment that somehow has none must still publish its run state and consume its events,
            // and the next pass re-plans the same turn from the same facts under the same key.
            this.log.warn(`Project ${lease.projectId} planned a coordinator turn with no executor`);
            return 'NOT_PLANNED';
        }
        if (context.gatedWriteTaken)
            return 'DEFERRED';
        // §9.2's cell, asked from the SNAPSHOT before a permanent key is spent — the gate itself is
        // still the commit-time adapter inside the effect, which re-reads the policy under the project
        // row lock and is what actually decides. This is the same rule `pendingVerificationVerdicts`
        // follows for a different reason: do not put an unclaimable key in the audit. The turn key's
        // epoch is `coordinator_generation`, which a refusal does NOT advance (unlike a dispatch's
        // attempt), so claiming under MANUAL would burn this episode's only name on an answer that
        // cannot change until a person acts — and then the turn could never open even after they
        // switched the project to GUARDED_AUTO. §7.2 TU6's `REQUEST_APPROVAL` is not implemented here,
        // so what MANUAL gets instead is: no turn, no spent key, an unconsumed request (TR2-c) and a
        // line in the log — never a silent execution and never a silently dropped request.
        if ((0, project_authorization_service_1.projectPolicyCell)(context.automationPolicy, 'COORDINATOR_ROUTINE') !== 'ALLOW') {
            this.log.warn(`Project ${(0, shared_1.uuidToBase62)(lease.projectId)} needs approval to open a `
                + `${planned.reasonCode} coordinator turn under ${context.automationPolicy}`);
            return 'NEEDS_APPROVAL';
        }
        const result = await this.applyDecisionActionInTransaction(tx, lease, decisionId, {
            type: 'OPEN_COORDINATOR_TURN',
            idempotencyKey: this.turnExecutor.idempotencyKey(lease.projectId, (0, project_turn_reason_1.coordinatorTurnGeneration)(planned.idempotencyKey) ?? '', planned.reasonDigest),
            subject: { type: 'PROJECT', id: lease.projectId },
            detail: this.turnExecutor.actionDetail(planned),
        }, async (effectTx, actionId) => this.turnExecutor.openInTransaction(effectTx, lease, {
            decisionId, planned,
        }, actionId, now), now);
        if (result.status === 'APPLIED') {
            // Post-commit, and re-read from the ledger before anything is sent: a rollback after this
            // point leaves a row that says nothing was applied, and no notification goes out for it.
            this.pendingTurns.push(result.actionId);
            this.log.log(`Project ${(0, shared_1.uuidToBase62)(lease.projectId)} opened a ${planned.reasonCode} coordinator turn`);
            return 'APPLIED';
        }
        // §8.2's keys are permanent, including for a row that was REFUSED — so a turn key spent on a
        // refusal can never be claimed again, while TR1 keeps proposing it (it looks for an APPLIED
        // row, and there is none). The loop does not reach that state: it takes at most one
        // staleness-gated write per pass, and the two that could invalidate this one are checked
        // above. If it is ever reached anyway, say so out loud rather than going quiet — going quiet
        // on an undeliverable turn is the exact shape of the defect this unit exists to close.
        if (result.status === 'ALREADY_APPLIED'
            && (result.actionStatus === 'REFUSED' || result.actionStatus === 'SUPERSEDED')) {
            this.log.error(`Project ${(0, shared_1.uuidToBase62)(lease.projectId)} cannot open its ${planned.reasonCode} turn: `
                + `key ${planned.idempotencyKey} is spent on a ${result.actionStatus} row`);
        }
        return 'ENTERED';
    }
    /**
     * Fire the post-commit notifications an opened turn owes the runner.
     *
     * Called after the delivery transaction has returned. Everything here is an accelerator over a
     * poll that already finds the turn: `claimSessionForRunner` retries every five seconds for a run
     * left `PENDING`, and the inbox long poll re-reads on the same cadence for one already `RUNNING`.
     */
    async flushPendingTurns() {
        const actionIds = this.pendingTurns.splice(0, this.pendingTurns.length);
        for (const actionId of actionIds) {
            try {
                const delivered = await this.turnExecutor?.deliveredTurn(actionId);
                if (delivered)
                    this.turnExecutor?.announce(delivered.sessionId, delivered.status);
            }
            catch (cause) {
                // Never load-bearing (AC4): the turn is committed PENDING on a live coordination run, and
                // both wake paths find it on their own within five seconds.
                this.log.warn(`Project coordinator turn notification failed for ${actionId}: ${errorText(cause)}`);
            }
        }
    }
    /**
     * The verdicts whose consequences this project still owes, newest conclusion per check first
     * in the planner's own order (§13.2).
     *
     * `verificationVerdictPlan` describes the CURRENT conclusion of every verification task, so it
     * keeps describing a FAIL that was applied last week — the row still says FAIL and the revision
     * has not moved. What separates "due" from "done" is the ledger: the action key carries the
     * verdict revision, so one row in `project_action` is the permanent record that this conclusion's
     * consequences have already happened (V2/V7). Filtering on it here is not a second idempotency
     * mechanism, it is what stops every pass from re-proposing conclusions the ledger would only
     * answer `ALREADY_APPLIED` — which, with one verdict applied per pass, would starve a project
     * whose oldest check is settled and whose newest one is not.
     *
     * Empty when no executor is registered: proposing an action nobody can claim would put an
     * unclaimable key in the audit and say the loop decided something it cannot do.
     */
    async pendingVerificationVerdicts(tx, projectId, input) {
        if (!this.verdictExecutor)
            return [];
        const planned = (0, project_decision_service_1.verificationVerdictPlan)(input);
        if (!planned.length)
            return [];
        const keys = planned.map((verdict) => this.verdictKey(projectId, verdict));
        const spent = await tx.$queryRaw(client_1.Prisma.sql `
      SELECT "idempotency_key" AS "idempotencyKey" FROM "project_action"
       WHERE "project_id" = ${projectId}::uuid
         AND "idempotency_key" IN (${client_1.Prisma.join(keys)})
    `);
        const done = new Set(spent.map((row) => row.idempotencyKey));
        return planned.filter((verdict) => !done.has(this.verdictKey(projectId, verdict)));
    }
    /** The ledger's spelling of one verdict's permanent key (§8.2): internal ids throughout. */
    verdictKey(projectId, planned) {
        return this.verdictExecutor.idempotencyKey(projectId, (0, shared_1.base62ToUuid)(planned.verifierTaskId), planned.verdictRevision);
    }
    /** The audit's spelling of the same key, which is what a plan is written in (§6.2 / §8.2). */
    verdictAction(projectId, planned) {
        return {
            type: 'APPLY_VERIFICATION_VERDICT',
            idempotencyKey: (0, project_decision_service_1.publicIdempotencyKey)(this.verdictKey(projectId, planned)),
            // The verifier, not the subject — the action is about a conclusion, and a subject with two
            // checks would otherwise have two actions claiming the same subject id.
            subject: { type: 'TASK', id: planned.verifierTaskId },
        };
    }
    /**
     * Apply the one verdict this pass claimed, and report how many are still owed after it.
     *
     * A refusal is a committed audit row and not an exception, exactly as it is for the rotation
     * above: `SUPERSEDED` is what the effect returns for a conclusion about a world that has moved
     * (V6), and turning that into a throw would roll back a reconcile that is otherwise correct.
     *
     * The count that comes back is what the caller floors the wake on. It counts the verdict just
     * applied as settled and everything else as outstanding, including the case where a rotation
     * took this pass's one write — the loop has to come back, and `next_wake_at` is how it is told.
     */
    async applyVerificationVerdicts(tx, lease, decisionId, pending, rotationAttempted, now) {
        if (!pending.length || !this.verdictExecutor)
            return 0;
        if (rotationAttempted)
            return pending.length;
        const planned = pending[0];
        const result = await this.applyDecisionActionInTransaction(tx, lease, decisionId, {
            type: 'APPLY_VERIFICATION_VERDICT',
            idempotencyKey: this.verdictKey(lease.projectId, planned),
            subject: { type: 'TASK', id: (0, shared_1.base62ToUuid)(planned.verifierTaskId) },
            detail: this.verdictExecutor.actionDetail(planned),
        }, async (effectTx, actionId) => this.verdictExecutor.applyVerdictInTransaction(effectTx, lease, { decisionId, planned }, actionId, now), now);
        if (result.status === 'APPLIED') {
            this.log.log(`Project ${(0, shared_1.uuidToBase62)(lease.projectId)} applied verdict ${planned.verdict} `
                + `from ${planned.verifierTaskId} (revision ${planned.verdictRevision})`);
        }
        return pending.length - 1;
    }
    /**
     * The verification tasks this snapshot says should exist and do not (§13.1 AG7 / §13.2 V8).
     *
     * The generation in the key comes from the snapshot's own ledger history, so this needs no second
     * query to find out what has already been tried — unlike the verdicts above, whose keys are
     * computed from the verifier's revision and therefore have to be checked against the ledger. Two
     * reconciles of the same world compute the same key and the second one conflicts.
     *
     * Empty when no executor is registered, for the reason the verdicts are: proposing an action
     * nobody can claim puts an unclaimable key in the audit and says the loop decided something it
     * cannot do.
     */
    pendingVerificationFilings(input) {
        if (!this.filingExecutor)
            return [];
        return (0, project_completion_gap_1.planCompletionGaps)(input, (0, project_decision_service_1.completionGapPlan)(input)).filings;
    }
    /** The audit's spelling of one filing's key (§6.2 / §8.2). */
    filingAction(projectId, planned) {
        return {
            type: 'FILE_VERIFICATION_TASK',
            idempotencyKey: (0, project_decision_service_1.publicIdempotencyKey)(this.filingExecutor.idempotencyKey(projectId, (0, shared_1.base62ToUuid)(planned.subjectTaskId), planned.generation)),
            subject: { type: 'TASK', id: planned.subjectTaskId },
        };
    }
    /**
     * File the one verification this pass claimed, and report how many are still owed after it.
     *
     * Same shape as the verdicts: one gated write per pass, a refusal is a committed audit row rather
     * than an exception, and what is left over floors the wake so the loop comes straight back.
     */
    async applyVerificationFilings(tx, lease, decisionId, pending, rotationAttempted, now) {
        if (!pending.length || !this.filingExecutor)
            return 0;
        if (rotationAttempted)
            return pending.length;
        const planned = pending[0];
        const result = await this.applyDecisionActionInTransaction(tx, lease, decisionId, {
            type: 'FILE_VERIFICATION_TASK',
            idempotencyKey: this.filingExecutor.idempotencyKey(lease.projectId, (0, shared_1.base62ToUuid)(planned.subjectTaskId), planned.generation),
            subject: { type: 'TASK', id: (0, shared_1.base62ToUuid)(planned.subjectTaskId) },
            detail: this.filingExecutor.actionDetail(planned),
        }, async (effectTx, actionId) => this.filingExecutor.fileInTransaction(effectTx, lease, { decisionId, planned }, actionId, now), now);
        if (result.status === 'APPLIED') {
            this.log.log(`Project ${(0, shared_1.uuidToBase62)(lease.projectId)} filed the verification `
                + `${planned.subjectTaskId} completes on (generation ${planned.generation})`);
        }
        return pending.length - 1;
    }
    /**
     * Fire the post-commit notifications a rotation owes the rest of the system.
     *
     * Called after the delivery transaction has returned, and deliberately re-reading the ledger
     * instead of trusting what was queued: the only thing that makes a rotation real is its APPLIED
     * row and the session it links, and a transaction can still fail between the effect and the
     * COMMIT.
     */
    async flushPendingRotations() {
        const actionIds = this.pendingRotations.splice(0, this.pendingRotations.length);
        for (const actionId of actionIds) {
            try {
                const rows = await this.prisma.$queryRaw(client_1.Prisma.sql `
          SELECT "result_session_id" AS "resultSessionId" FROM "project_action"
           WHERE "id" = ${actionId}::uuid AND "status" = 'APPLIED'
        `);
                const sessionId = rows[0]?.resultSessionId;
                if (sessionId)
                    this.rotationExecutor?.announce(sessionId);
            }
            catch (cause) {
                // A missed notification costs latency, never correctness: the Session is committed PENDING
                // and the runner's own poll finds it.
                this.log.warn(`Project rotation notification failed for ${actionId}: ${errorText(cause)}`);
            }
        }
    }
    async applyBlockers(tx, projectId, lease, decisionId, plan, now, actionDetail = {}) {
        if (!plan)
            return;
        for (const raise of plan.raised) {
            await this.raiseBlocker(tx, projectId, lease, decisionId, raise, now, actionDetail);
        }
        // §11.3 / AC8. The same cause seen again moves exactly two display columns and recomputes the
        // condition digest from CURRENT facts. No new row, no ledger key, no notification — which is
        // the entire content of "duplicate events produce no extra side effect".
        for (const touch of plan.touched) {
            await tx.$executeRaw(client_1.Prisma.sql `
        UPDATE "project_blocker"
           SET "occurrences" = "occurrences" + 1,
               "last_seen_at" = GREATEST("last_seen_at", ${new Date(touch.lastSeenAt)}),
               "condition_version" = ${touch.conditionVersion},
               "next_check_at" = ${new Date(touch.nextCheckAt)},
               "detail" = ${JSON.stringify(touch.detail)}::jsonb,
               "updated_at" = ${now}
         WHERE "id" = ${(0, shared_1.base62ToUuid)(touch.blockerId)}::uuid
           AND "project_id" = ${projectId}::uuid
           AND "resolved_at" IS NULL
      `);
        }
        // §11.4: the condition is gone, so the row is resolved — by AUTO, because nobody did anything;
        // the world simply stopped being that way. The row itself stays forever (BE1).
        for (const clear of plan.cleared) {
            const blockerId = (0, shared_1.base62ToUuid)(clear.blockerId);
            const resolved = await tx.$executeRaw(client_1.Prisma.sql `
        UPDATE "project_blocker"
           SET "resolved_at" = ${now}, "resolved_by" = 'AUTO'::"project_blocker_resolved_by",
               "updated_at" = ${now}
         WHERE "id" = ${blockerId}::uuid
           AND "project_id" = ${projectId}::uuid
           AND "resolved_at" IS NULL
      `);
            if (resolved !== 1)
                continue;
            await this.claimBlockerAction(tx, projectId, lease, decisionId, {
                type: 'CLEAR_BLOCKER',
                idempotencyKey: (0, project_blocker_1.clearBlockerIdempotencyKey)(projectId, blockerId),
                subjectType: 'BLOCKER',
                subjectId: blockerId,
                detail: {
                    blockerId: clear.blockerId,
                    kind: clear.kind,
                    lifecycleGeneration: clear.lifecycleGeneration,
                    resolvedBy: 'AUTO',
                },
            }, now);
        }
        // §11.5: at most once per lifecycle, always to USER (ES3), `recovery` untouched (ES1). The
        // compare-and-set is what makes "at most once" true of the DATABASE and not merely of this
        // code path — and the notification rides the transition, so its count is the count of
        // successful transitions.
        for (const escalation of plan.escalated) {
            const blockerId = (0, shared_1.base62ToUuid)(escalation.blockerId);
            const escalated = await tx.$executeRaw(client_1.Prisma.sql `
        UPDATE "project_blocker"
           SET "owner" = 'USER'::"project_blocker_owner", "escalated_at" = ${now},
               "updated_at" = ${now}
         WHERE "id" = ${blockerId}::uuid
           AND "project_id" = ${projectId}::uuid
           AND "resolved_at" IS NULL
           AND "escalated_at" IS NULL
      `);
            if (escalated !== 1)
                continue;
            await this.events.enqueue(tx, {
                projectId,
                kind: 'blocker.escalated',
                // §5.2's source set is closed and has no BLOCKER. TIMER is the honest one anyway: what
                // produced this is the clock crossing `first_seen_at + threshold`, exactly as it produces
                // `timer.due`.
                source: { type: 'TIMER', id: projectId },
                // One per blocker lifetime, and the outbox's partial unique index coalesces even that.
                dedupeKey: `blocker.escalated:${escalation.blockerId}`,
                payload: {
                    blockerId: escalation.blockerId,
                    kind: escalation.kind,
                    owner: escalation.owner,
                    dueAt: escalation.dueAt,
                },
                occurredAt: now,
            });
        }
    }
    /**
     * §11.3 BE1's raise, as one statement two callers share.
     *
     * The reconcile pass raises from a decision; §5.4's dead letter raises from the batch it is about
     * to discard and has no decision to cite (`decisionId` null, which is what migration 0120 left
     * the column nullable for). Everything else — the generation allocated inside the INSERT, C2's
     * read-back, and the permanent key beside the row — has to be identical, so it is written once.
     */
    async raiseBlocker(tx, projectId, lease, decisionId, raise, now, actionDetail = {}) {
        const subjectId = internalSubjectId(raise.subjectId);
        // §11.3 BE1: the generation is allocated INSIDE the insert as `MAX + 1` over this key's whole
        // history, which is why resolved rows are never deleted. Returning no row means this episode
        // is already open — §8.5 C2: read the existing row, keep ITS generation so the key is
        // unchanged, and skip the side effect.
        const inserted = await tx.$queryRaw(client_1.Prisma.sql `
      INSERT INTO "project_blocker" (
        "id", "project_id", "kind", "owner", "recovery", "severity", "required_action",
        "next_check_at", "subject_type", "subject_id", "detail", "dedupe_key",
        "lifecycle_generation", "condition_version", "first_seen_at", "last_seen_at",
        "occurrences", "created_at", "updated_at"
      )
      SELECT ${(0, node_crypto_1.randomUUID)()}::uuid, ${projectId}::uuid, ${raise.kind},
             ${raise.owner}::"project_blocker_owner",
             ${raise.recovery}::"project_blocker_recovery",
             ${raise.severity}::"project_blocker_severity",
             ${raise.requiredAction}, ${new Date(raise.nextCheckAt)},
             ${raise.subjectType}, ${subjectId ?? raise.subjectId},
             ${JSON.stringify(raise.detail)}::jsonb,
             ${internalDedupeKey(raise.dedupeKey)},
             COALESCE(MAX(b."lifecycle_generation"), 0) + 1,
             ${raise.conditionVersion}, ${new Date(raise.firstSeenAt)},
             ${new Date(raise.firstSeenAt)}, 1, ${now}, ${now}
        FROM "project_blocker" b
       WHERE b."project_id" = ${projectId}::uuid
         AND b."dedupe_key" = ${internalDedupeKey(raise.dedupeKey)}
      ON CONFLICT ("project_id", "dedupe_key") WHERE "resolved_at" IS NULL DO NOTHING
      RETURNING "id", "lifecycle_generation" AS "lifecycleGeneration"
    `);
        const row = inserted[0] ?? (await tx.$queryRaw(client_1.Prisma.sql `
      SELECT "id", "lifecycle_generation" AS "lifecycleGeneration" FROM "project_blocker"
       WHERE "project_id" = ${projectId}::uuid
         AND "dedupe_key" = ${internalDedupeKey(raise.dedupeKey)}
         AND "resolved_at" IS NULL
    `))[0];
        if (!row)
            throw new Error(`failed to raise ${raise.kind} blocker on ${projectId}`);
        await this.claimBlockerAction(tx, projectId, lease, decisionId, {
            type: 'RAISE_BLOCKER',
            idempotencyKey: (0, project_blocker_1.raiseBlockerIdempotencyKey)(projectId, raise.kind, subjectId ?? raise.subjectId, row.lifecycleGeneration),
            subjectType: raise.subjectType,
            subjectId,
            detail: {
                blockerId: (0, shared_1.uuidToBase62)(row.id),
                kind: raise.kind,
                owner: raise.owner,
                recovery: raise.recovery,
                dedupeKey: raise.dedupeKey,
                lifecycleGeneration: String(row.lifecycleGeneration),
                conditionVersion: raise.conditionVersion,
                requiredAction: raise.requiredAction,
                nextCheckAt: raise.nextCheckAt,
                ...actionDetail,
            },
        }, now);
        return row;
    }
    /**
     * Claim a blocker action's permanent key beside the row it describes.
     *
     * Published APPLIED in the same statement rather than CLAIMED-then-published: the effect is
     * already committed in this transaction by the time this runs, so a CLAIMED row that never
     * reached APPLIED could only mean the whole transaction rolled back — taking the row with it.
     */
    async claimBlockerAction(tx, projectId, lease, decisionId, action, now) {
        await tx.$executeRaw(client_1.Prisma.sql `
      INSERT INTO "project_action" (
        "id", "project_id", "idempotency_key", "type", "status", "subject_type",
        "subject_id", "fencing_token", "decision_id", "detail", "created_at", "updated_at"
      ) VALUES (
        ${(0, node_crypto_1.randomUUID)()}::uuid, ${projectId}::uuid, ${action.idempotencyKey},
        ${action.type}::"project_action_type", 'APPLIED', ${action.subjectType},
        ${action.subjectId}::uuid, ${lease.fencingToken}, ${decisionId}::uuid,
        ${JSON.stringify(action.detail)}::jsonb, ${now}, ${now}
      )
      ON CONFLICT ("idempotency_key") DO NOTHING
    `);
    }
    async ensureRuntime(tx, projectId, now) {
        await tx.$executeRaw(client_1.Prisma.sql `
      INSERT INTO "project_runtime" ("project_id", "created_at", "updated_at")
      VALUES (${projectId}::uuid, ${now}, ${now})
      ON CONFLICT ("project_id") DO NOTHING
    `);
    }
    async runStateOf(tx, projectId) {
        const rows = await tx.$queryRaw(client_1.Prisma.sql `
      SELECT p."status",
             EXISTS (
               SELECT 1 FROM "task" t JOIN "session" s ON s."task_id" = t."id"
                WHERE t."project_id" = p."id" AND s."deleted_at" IS NULL
                  AND s."status" IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
             ) AS "hasLiveSession",
             EXISTS (
               SELECT 1 FROM "task" t
                WHERE t."project_id" = p."id" AND t."verifies_task_id" IS NOT NULL
                  AND t."status" <> 'DONE'
             ) AS "hasPendingVerification"
        FROM "project" p WHERE p."id" = ${projectId}::uuid
    `);
        const snapshot = rows[0];
        if (!snapshot || snapshot.status !== 'OPEN')
            return 'SETTLED';
        if (snapshot.hasLiveSession)
            return 'EXECUTING';
        if (snapshot.hasPendingVerification)
            return 'AWAITING_VERIFICATION';
        return 'PLANNING';
    }
    async enqueueScheduledWakes(now) {
        return this.prisma.$executeRaw(client_1.Prisma.sql `
      INSERT INTO "project_event" (
        "id", "project_id", "v", "kind", "occurred_at", "source_type", "source_id",
        "dedupe_key", "payload", "last_at"
      )
      SELECT gen_random_uuid(), p."id", 1, 'timer.due', ${now}, 'TIMER', p."id",
             'timer.due:' || r."next_wake_at"::text,
             jsonb_build_object('reason', r."next_wake_reason"), ${now}
        FROM "project" p JOIN "project_runtime" r ON r."project_id" = p."id"
       WHERE p."status" = 'OPEN' AND p."coordinator_enabled" = true
         AND r."run_state" <> 'SETTLED' AND r."next_wake_at" <= ${now}
      ON CONFLICT ("project_id", "dedupe_key") WHERE "consumed_at" IS NULL
      DO UPDATE SET "occurrences" = "project_event"."occurrences" + 1,
                    "last_at" = GREATEST("project_event"."last_at", EXCLUDED."last_at")
    `);
    }
    /**
     * §10.2 W4's predicate: "the wake that SHOULD exist does not", never "there is no wake".
     *
     * Splitting the NULL-wake case into (ii) and (iii) is the whole of `PC-CX-05`. §10.4 N-null lets
     * exactly one shape stop its own clock — every open blocker `recovery = HUMAN` and already
     * escalated — and a predicate that hits any NULL wake reports that shape as a stalled project
     * every sixty seconds, forever. W2 makes each hit a WARN, so an alarm that is permanently true
     * for every project legitimately waiting on a person is an alarm nobody can read.
     */
    async enqueueBackstopWakes(now) {
        const staleBefore = new Date(now.getTime() - exports.PROJECT_RECONCILE_STALE_MS);
        return this.prisma.$executeRaw(client_1.Prisma.sql `
      INSERT INTO "project_event" (
        "id", "project_id", "v", "kind", "occurred_at", "source_type", "source_id",
        "dedupe_key", "payload", "last_at"
      )
      SELECT gen_random_uuid(), p."id", 1, 'timer.backstop', ${now}, 'TIMER', p."id",
             'timer.backstop', jsonb_build_object('detectedAt', ${now}::text), ${now}
        FROM "project" p JOIN "project_runtime" r ON r."project_id" = p."id"
       WHERE p."status" = 'OPEN' AND p."coordinator_enabled" = true
         AND r."run_state" <> 'SETTLED'
         AND (
           -- (i) the timer path is stuck: due long ago and still not handled.
           r."next_wake_at" < ${staleBefore}
           -- (ii) it stopped its own clock while something could still end without a person, or
           -- while an alarm had not gone off yet.
           OR (r."next_wake_at" IS NULL
               AND (r."lease_holder" IS NULL OR r."lease_expires_at" < ${staleBefore})
               AND EXISTS (
                 SELECT 1 FROM "project_blocker" b
                  WHERE b."project_id" = p."id" AND b."resolved_at" IS NULL
                    AND (b."recovery"::text <> 'HUMAN' OR b."escalated_at" IS NULL)
               ))
           -- (iii) it stopped its own clock with nothing open at all. THIS is silent idling.
           OR (r."next_wake_at" IS NULL
               AND (r."lease_holder" IS NULL OR r."lease_expires_at" < ${staleBefore})
               AND NOT EXISTS (
                 SELECT 1 FROM "project_blocker" b
                  WHERE b."project_id" = p."id" AND b."resolved_at" IS NULL
               ))
           -- (iv) the delivery path is stuck: a committed signal nobody has taken.
           OR EXISTS (
             SELECT 1 FROM "project_event" e
              WHERE e."project_id" = p."id" AND e."consumed_at" IS NULL
                AND COALESCE(e."next_attempt_at", e."occurred_at") < ${staleBefore}
           )
         )
      ON CONFLICT ("project_id", "dedupe_key") WHERE "consumed_at" IS NULL
      DO UPDATE SET "occurrences" = "project_event"."occurrences" + 1,
                    "last_at" = GREATEST("project_event"."last_at", EXCLUDED."last_at")
    `);
    }
    assertAction(lease, action) {
        if (!action.idempotencyKey.startsWith(`pc:v1:${lease.projectId}:`)) {
            throw new RangeError('Project action idempotency key must use pc:v1:<project UUID>:...');
        }
        if (!ACTION_TYPES.includes(action.type)) {
            throw new RangeError(`unsupported Project action type ${action.type}`);
        }
        if (!action.subject.type.trim())
            throw new RangeError('Project action subject type is required');
    }
};
exports.ProjectReconcileService = ProjectReconcileService;
exports.ProjectReconcileService = ProjectReconcileService = ProjectReconcileService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService, project_events_service_1.ProjectEventsService, project_decision_service_1.ProjectDecisionService])
], ProjectReconcileService);
function contentionWake(projectId, expiresAt, now) {
    // Deterministic 0..250ms jitter spreads replicas without making the same dirty world produce a
    // different schedule after restart.
    let hash = 0;
    for (const char of projectId)
        hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
    const base = Math.max(now.getTime() + 1_000, expiresAt?.getTime() ?? now.getTime());
    return new Date(base + (hash % 251));
}
/** A blocker subject is a Base62 row id for everything the control loop can name today; a natural
 *  key (a builtin provider's slug) is not an address and stays out of the uuid column. */
function internalSubjectId(subjectId) {
    try {
        return (0, shared_1.base62ToUuid)(subjectId);
    }
    catch {
        return null;
    }
}
/** The stored key keeps the internal id, so the partial unique index and `MAX + 1` key on the same
 *  bytes the row does; the audit face publicizes it on the way out. */
function internalDedupeKey(dedupeKey) {
    const parts = dedupeKey.split(':');
    if (parts.length !== 3)
        return dedupeKey;
    return `${parts[0]}:${parts[1]}:${internalSubjectId(parts[2]) ?? parts[2]}`;
}
function errorText(cause) {
    const text = cause instanceof Error ? cause.message : String(cause);
    return text.slice(0, 2_000);
}
//# sourceMappingURL=project-reconcile.service.js.map