import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { base62ToUuid, uuidToBase62 } from '@orbit/shared';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import {
  ProjectDecisionBlockerAudit,
  ProjectDecisionInput,
  ProjectDecisionOutcome,
  ProjectDecisionService,
  createDecisionId,
  hashDecisionInput,
  planProjectDecision,
  completionGapPlan,
  publicIdempotencyKey,
  verificationVerdictPlan,
} from './project-decision.service';
import {
  ProjectEventDeliveryResult,
  ProjectEventEnvelope,
  ProjectEventHandleResult,
  ProjectEventHandler,
  ProjectEventsService,
} from './project-events.service';
import { PlannedTaskAggregation } from './task-aggregation';
import { PlannedVerificationFiling, planCompletionGaps } from './project-completion-gap';
import {
  PlannedBlockerRaise,
  ProjectBlockerFact,
  blockerRunState,
  clearBlockerIdempotencyKey,
  planProjectBlockers,
  projectBlockerDedupeKey,
  projectDeadLetterCondition,
  raiseBlockerIdempotencyKey,
} from './project-blocker';
import type { PlannedCoordinatorRotation } from './project-coordinator-session';
import { PlannedCoordinatorTurn, coordinatorTurnGeneration } from './project-turn-reason';
import {
  ProjectAutomationPolicyValue,
  projectPolicyCell,
} from './project-authorization.service';
import {
  PlannedVerificationVerdict,
  VERDICT_APPLY_EXHAUSTED,
  verdictApplyAttempt,
  verdictApplyExhausted,
  verdictApplyRetryable,
  verificationVerdictActionKey,
} from './task-verification-verdict';

export const PROJECT_RECONCILE_LEASE_MS = 60_000;
export const PROJECT_RECONCILE_HEARTBEAT_MS = 20_000;
export const PROJECT_RECONCILE_TIMER_MS = 10_000;
export const PROJECT_RECONCILE_BACKSTOP_MS = 60_000;
export const PROJECT_RECONCILE_STALE_MS = 5 * 60_000;

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
] as const;

export type ProjectReconcileActionType = (typeof ACTION_TYPES)[number];
export type ProjectReconcileRunState =
  | 'PLANNING'
  | 'EXECUTING'
  | 'AWAITING_VERIFICATION'
  | 'BLOCKED'
  | 'AWAITING_HUMAN'
  | 'ACCEPTANCE'
  | 'SETTLED';

export interface ProjectReconcileLease {
  projectId: string;
  holder: string;
  fencingToken: bigint;
  expiresAt: Date;
}

export interface ProjectReconcileAction {
  idempotencyKey: string;
  type: ProjectReconcileActionType;
  subject: { type: string; id?: string | null };
  detail?: Prisma.InputJsonValue;
  /**
   * `[K5]`: this key may be CLAIMED again when the row already there is a refusal with budget left.
   *
   * Off for every caller but one, and the default is what every caller had before it existed: a key
   * already in the ledger answers `ALREADY_APPLIED` and the effect does not run. That is right for
   * an action whose refusal is a DECISION — a dispatch refused because the task is not OPEN is not
   * waiting for another try.
   *
   * `APPLY_VERIFICATION_VERDICT` is the exception, because its refusals are not all decisions. A
   * snapshot that moved under the apply is a race: the conclusion is still true, and nothing else
   * in the system will ever apply it. The key is permanent, so "already in the ledger" and "already
   * happened" had become the same sentence. This is what separates them again — bounded by
   * `VERDICT_APPLY_MAX_ATTEMPTS`, because an unbounded retry is the other way to never finish.
   */
  reclaimRefused?: boolean;
}

export type ProjectActionApplyResult =
  | { status: 'APPLIED'; actionId: string }
  | {
      status: 'REFUSED';
      actionId: string;
      refusalCode: 'STALE_SNAPSHOT';
      expectedDecisionInputHash: string;
      actualDecisionInputHash: string;
    }
  | {
      status: 'REFUSED' | 'SUPERSEDED';
      actionId: string;
      refusalCode: string;
      reasonCode: string;
      expectedDecisionInputHash?: string;
      actualDecisionInputHash?: string;
    }
  | {
      status: 'ALREADY_APPLIED';
      actionId: string;
      actionStatus: 'CLAIMED' | 'APPLIED' | 'REFUSED' | 'SUPERSEDED';
    };

export interface ProjectActionEffectRefusal {
  status: 'REFUSED' | 'SUPERSEDED';
  refusalCode: string;
  reasonCode?: string;
  detail?: Prisma.InputJsonValue;
}

interface LeaseRow {
  fencingToken: bigint;
  leaseExpiresAt: Date;
}

/** §5.4's dead letter reads back the one open row it may be touching, in the columns §11.3's plan
 *  is a function of. */
interface OpenBlockerRow {
  id: string;
  kind: string;
  owner: string;
  recovery: string;
  severity: string;
  requiredAction: string;
  subjectType: string;
  lifecycleGeneration: bigint;
  conditionVersion: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  occurrences: number;
  nextCheckAt: Date;
  escalatedAt: Date | null;
}

interface ExistingActionRow {
  id: string;
  projectId: string;
  status: 'CLAIMED' | 'APPLIED' | 'REFUSED' | 'SUPERSEDED';
}

/** `[K5]`: the same row, plus the two columns a re-claim has to judge it on. */
interface ReclaimableActionRow extends ExistingActionRow {
  refusalCode: string | null;
  /** The judgment that first proposed it. Frozen by migration 0120 once it is set. */
  existingDecisionId: string | null;
  detail: unknown;
}

/**
 * What the reconcile pass needs from §7.5's rotation, and nothing else.
 *
 * Stated here rather than imported so the ledger does not depend on the service that uses it: the
 * rotation service registers itself at startup, the way the event consumer does.
 */
export interface ProjectRotationExecutor {
  idempotencyKey(projectId: string, generation: string): string;
  actionDetail(planned: PlannedCoordinatorRotation): Prisma.InputJsonValue;
  rotateInTransaction(
    tx: Prisma.TransactionClient,
    lease: ProjectReconcileLease,
    command: { decisionId: string; planned: PlannedCoordinatorRotation },
    actionId: string,
    now: Date,
  ): Promise<void | ProjectActionEffectRefusal>;
  /** Post-commit only: wake the runner for a Session that is already committed PENDING. */
  announce(sessionId: string): void;
}

/**
 * What the ledger needs from §13.2's verdict unit, and nothing else.
 *
 * Same terms as `ProjectRotationExecutor` above, for the same reason: the ledger applies the
 * action, the unit owns the effect, and neither may import the other.
 * `ProjectVerificationVerdictService` registers itself at startup — and until it did, §13.2's
 * three consequences were computed by
 * `verificationVerdictPlan`, used to raise one blocker, and dropped. A FAIL reverted nothing, filed
 * no defect and stopped nothing downstream in production, while the specs that cover the effect
 * stayed green because they called it themselves. That is the same hole `task-aggregation-writer`
 * was cut to fill for §13.1 and `ProjectDispatchPassService` for §7.8.
 */
export interface ProjectVerdictExecutor {
  idempotencyKey(projectId: string, verifierTaskId: string, verdictRevision: string): string;
  actionDetail(planned: PlannedVerificationVerdict): Prisma.InputJsonValue;
  applyVerdictInTransaction(
    tx: Prisma.TransactionClient,
    lease: ProjectReconcileLease,
    command: { decisionId: string; planned: PlannedVerificationVerdict },
    actionId: string,
    now: Date,
  ): Promise<void | ProjectActionEffectRefusal>;
}

/**
 * What the ledger needs from §13.2 V8's filing, and nothing else.
 *
 * Same terms as the verdict executor above, and registered the same way. Split out rather than
 * folded into it because the two answer different questions — one turns a conclusion that exists
 * into consequences, the other creates the check that does not exist — and a single executor with
 * a discriminated command would make "is a verdict due" and "is a filing due" one condition.
 */
export interface ProjectFilingExecutor {
  idempotencyKey(projectId: string, subjectTaskId: string, generation: string): string;
  actionDetail(planned: PlannedVerificationFiling): Prisma.InputJsonValue;
  fileInTransaction(
    tx: Prisma.TransactionClient,
    lease: ProjectReconcileLease,
    command: { decisionId: string; planned: PlannedVerificationFiling },
    actionId: string,
    now: Date,
  ): Promise<void | ProjectActionEffectRefusal>;
}

/**
 * What the ledger needs from §7.6's turn, and nothing else.
 *
 * Same terms as the two executors above. Until this existed, §7.2's total order ended in a plan
 * nobody claimed: the pass committed a decision saying "wake the coordinator" and the coordinator
 * was never woken — the ledger's `planned` gate only refuses a claim that no decision proposed, so
 * a proposal nobody claims is silent by construction.
 */
export interface ProjectTurnExecutor {
  idempotencyKey(projectId: string, generation: string, reasonDigest: string): string;
  actionDetail(planned: PlannedCoordinatorTurn): Prisma.InputJsonValue;
  openInTransaction(
    tx: Prisma.TransactionClient,
    lease: ProjectReconcileLease,
    command: { decisionId: string; planned: PlannedCoordinatorTurn },
    actionId: string,
    now: Date,
  ): Promise<void | ProjectActionEffectRefusal>;
  /** Post-commit only: the committed turn, read back from the ledger. */
  deliveredTurn(
    actionId: string,
  ): Promise<{ sessionId: string; status: string; turnId: string } | null>;
  /** Post-commit only: wake the runner for a turn that is already committed PENDING. */
  announce(sessionId: string, status: string): void;
}

/**
 * What the ledger needs from §7.8's dispatch pass, and nothing else.
 *
 * Stated here rather than imported for the reason `ProjectRotationExecutor` is: the ledger must not
 * depend on the services that use it. The pass registers itself at startup, the way the rotation
 * executor and the event consumer do.
 */
export interface ProjectDispatchPassExecutor {
  /** One pass over one project. Post-commit only: it takes its own lease and its own transactions. */
  runFor(projectId: string): Promise<unknown>;
}

export class ProjectLeaseLostError extends Error {
  constructor(projectId: string) {
    super(`Project reconcile lease lost for ${projectId}`);
    this.name = 'ProjectLeaseLostError';
  }
}

/**
 * The Project control loop's execution substrate.
 *
 * Semantic planning is added by later units; this service owns the invariants it must build on:
 * a renewable lease with a monotonic fence, an insert-first action ledger, durable recovery wakes,
 * and one timer shared by event polling, scheduled wakes and the stale-project backstop.
 */
@Injectable()
export class ProjectReconcileService
implements ProjectEventHandler, OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ProjectReconcileService.name);
  private readonly instanceId = randomUUID();
  private timer?: ReturnType<typeof setInterval>;
  private unregisterHandler?: () => void;
  private ticking = false;
  private lastBackstopAt = 0;
  private _backstopHits = 0;
  private rotationExecutor?: ProjectRotationExecutor;
  private verdictExecutor?: ProjectVerdictExecutor;
  private filingExecutor?: ProjectFilingExecutor;
  private turnExecutor?: ProjectTurnExecutor;
  private dispatchPass?: ProjectDispatchPassExecutor;
  private readonly pendingRotations: string[] = [];
  private readonly pendingTurns: string[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: ProjectEventsService,
    // Optional only for the pre-0120 isolated unit harnesses. Nest always provides it; all new
    // production protocol entry points fail closed when it is absent.
    private readonly decisions?: ProjectDecisionService,
  ) {}

  get backstopHits(): number {
    return this._backstopHits;
  }

  /**
   * Install the sole §7.5 rotation executor, on the same terms the event consumer is installed on:
   * one, replacing a different live one is refused, and the unregister function makes an isolated
   * test's teardown explicit.
   */
  registerRotationExecutor(executor: ProjectRotationExecutor): () => void {
    if (this.rotationExecutor && this.rotationExecutor !== executor) {
      throw new Error('a Project rotation executor is already registered');
    }
    this.rotationExecutor = executor;
    return () => {
      if (this.rotationExecutor === executor) this.rotationExecutor = undefined;
    };
  }

  /**
   * Install the sole §13.2 verdict executor, on the terms the rotation executor is installed on.
   */
  registerVerdictExecutor(executor: ProjectVerdictExecutor): () => void {
    if (this.verdictExecutor && this.verdictExecutor !== executor) {
      throw new Error('a Project verdict executor is already registered');
    }
    this.verdictExecutor = executor;
    return () => {
      if (this.verdictExecutor === executor) this.verdictExecutor = undefined;
    };
  }

  /** Install the sole §13.2 V8 filing executor, on the terms the verdict executor is installed on. */
  registerFilingExecutor(executor: ProjectFilingExecutor): () => void {
    if (this.filingExecutor && this.filingExecutor !== executor) {
      throw new Error('a Project filing executor is already registered');
    }
    this.filingExecutor = executor;
    return () => {
      if (this.filingExecutor === executor) this.filingExecutor = undefined;
    };
  }

  /**
   * Install the sole §7.6 turn executor, on the terms the rotation executor is installed on.
   */
  registerTurnExecutor(executor: ProjectTurnExecutor): () => void {
    if (this.turnExecutor && this.turnExecutor !== executor) {
      throw new Error('a Project turn executor is already registered');
    }
    this.turnExecutor = executor;
    return () => {
      if (this.turnExecutor === executor) this.turnExecutor = undefined;
    };
  }

  /**
   * Install the sole §7.8 dispatch pass, on the terms every other collaborator is installed on.
   *
   * One, because two passes proposing dispatches for one project would be two clocks; replacing a
   * different live one is refused; and the unregister function makes an isolated test's teardown
   * explicit.
   */
  registerDispatchPass(executor: ProjectDispatchPassExecutor): () => void {
    if (this.dispatchPass && this.dispatchPass !== executor) {
      throw new Error('a Project dispatch pass is already registered');
    }
    this.dispatchPass = executor;
    return () => {
      if (this.dispatchPass === executor) this.dispatchPass = undefined;
    };
  }

  onModuleInit(): void {
    this.unregisterHandler = this.events.registerHandler(this);
    // W1: event polling, due wakes and the backstop all ride this one timer. LISTEN/NOTIFY may
    // request an immediate drain, but it creates no second clock.
    this.timer = setInterval(() => void this.tick(), PROJECT_RECONCILE_TIMER_MS);
    this.timer.unref();
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.unregisterHandler?.();
    this.unregisterHandler = undefined;
  }

  /** One deterministic pass, public for integration tests and operational recovery probes. */
  async tick(now = new Date()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.events.drainAvailable();
      await this.flushPendingRotations();
      await this.flushPendingTurns();
      await this.enqueueScheduledWakes(now);
      if (now.getTime() - this.lastBackstopAt >= PROJECT_RECONCILE_BACKSTOP_MS) {
        this.lastBackstopAt = now.getTime();
        const hits = await this.enqueueBackstopWakes(now);
        this._backstopHits += hits;
        if (hits > 0) this.log.warn(`Project reconcile backstop found ${hits} stalled project(s)`);
      }
      // Timer/backstop rows are ordinary durable signals. Draining them here keeps a due Project
      // inside the ten-second path even if PostgreSQL NOTIFY is lost.
      await this.events.drainAvailable();
      await this.flushPendingRotations();
      await this.flushPendingTurns();
    } catch (cause) {
      this.log.error(`Project reconcile recovery tick failed: ${errorText(cause)}`);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Event delivery callback. It re-reads current facts, never event payloads, then atomically
   * publishes the runtime state and consumes the batch under the acquired fencing token.
   */
  async handle(
    tx: Prisma.TransactionClient,
    projectId: string,
    _events: readonly ProjectEventEnvelope[],
  ): Promise<ProjectEventHandleResult> {
    const now = new Date();
    const projects = await tx.$queryRaw<Array<{
      status: 'OPEN' | 'DONE' | 'CANCELLED';
      coordinatorEnabled: boolean;
    }>>(Prisma.sql`
      SELECT "status", "coordinator_enabled" AS "coordinatorEnabled"
        FROM "project" WHERE "id" = ${projectId}::uuid
    `);
    const project = projects[0];
    if (!project) return { disposition: 'DISCARDED_OUT_OF_LOOP' };

    await this.ensureRuntime(tx, projectId, now);
    if (project.status !== 'OPEN' || !project.coordinatorEnabled) {
      // This is terminal/inert cleanup, not a reconcile. Advancing the fence invalidates a holder
      // that raced the user's stop/terminal write; applyAction also re-checks the Project row.
      await tx.$executeRaw(Prisma.sql`
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
      const rows = await tx.$queryRaw<Array<{ leaseExpiresAt: Date | null }>>(Prisma.sql`
        SELECT "lease_expires_at" AS "leaseExpiresAt" FROM "project_runtime"
         WHERE "project_id" = ${projectId}::uuid
      `);
      return { deferUntil: contentionWake(projectId, rows[0]?.leaseExpiresAt, now) };
    }

    let state: ProjectReconcileRunState;
    let nextWakeAt: Date | null;
    let nextWakeReason: string | null;
    let held: ProjectEventHandleResult['hold'];
    let answered: ProjectEventHandleResult['answered'];
    if (this.decisions) {
      const captured = await this.decisions.capture(tx, projectId, now);
      const decisionId = createDecisionId();
      const consumedEventIds = _events.map((event) => uuidToBase62(event.id));
      const base = planProjectDecision(captured.input, { decisionId, consumedEventIds });
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
        ? planProjectDecision(captured.input, {
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
      const rotationAttempted =
        await this.applyCoordinatorRotation(tx, lease, decisionId, outcome, now);
      const verdictsLeft = await this.applyVerificationVerdicts(
        tx, lease, decisionId, pending, rotationAttempted, now,
      );
      const filingsLeft = await this.applyVerificationFilings(
        tx, lease, decisionId, filings, rotationAttempted, now,
      );
      // §7.6, third in the same one-gated-write-per-pass chain, and LAST of the three on purpose:
      // a verdict rewrites the very task rows a turn's facts are computed from, so waking the
      // coordinator on the world the verdict PRODUCED — next pass, under a different digest if the
      // facts moved — is the correct order rather than merely a legal one. A rotation never
      // competes with a turn at all: TU7 makes `ROTATE` and `OPEN` mutually exclusive on one
      // snapshot, because a turn needs a live run to land in and a rotation means there is none.
      const turn = await this.applyCoordinatorTurn(
        tx, lease, decisionId, outcome,
        {
          gatedWriteTaken: rotationAttempted || pending.length > 0 || filings.length > 0,
          automationPolicy: captured.input.world.project.automationPolicy,
        },
        now,
      );
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
      const requests = captured.input.signals.map((signal) => base62ToUuid(signal.eventId));
      if (requests.length > 0) {
        // TF5: the one turn answers EVERY request outstanding at the time, so they are consumed
        // together — including ones an earlier window held, which is why this is not just "the
        // batch that was delivered".
        if (turn === 'APPLIED' && outcome.turnReason === 'MANUAL') answered = requests;
        else {
          held = {
            eventIds: requests,
            nextAttemptAt: outcome.turn?.verdict === 'RATE_LIMITED' && outcome.turn.windowEndsAt
              ? new Date(outcome.turn.windowEndsAt)
              : nextWakeAt ?? new Date(now.getTime() + PROJECT_RECONCILE_BACKSTOP_MS),
          };
        }
      }
    } else {
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
    const updated = await tx.$executeRaw(Prisma.sql`
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
    if (updated !== 1) throw new ProjectLeaseLostError(projectId);
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
  async afterCommit(result?: ProjectEventDeliveryResult): Promise<void> {
    await this.flushPendingRotations();
    await this.flushPendingTurns();
    if (!this.dispatchPass || result?.status !== 'CONSUMED') return;
    // Never load-bearing, exactly as above: the delivery has committed, and a pass that threw must
    // not turn a durable reconcile into a retried one. The next wake runs it again.
    await this.dispatchPass.runFor(result.projectId).catch((cause: unknown) => {
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
  async deadLetter(
    tx: Prisma.TransactionClient,
    projectId: string,
    events: readonly ProjectEventEnvelope[],
    error: string,
  ): Promise<void> {
    const now = new Date();
    await this.ensureRuntime(tx, projectId, now);
    const lease = await this.acquireLeaseInTransaction(tx, projectId, now);
    if (!lease) throw new Error(`cannot persist dead-letter recovery while ${projectId} is leased`);

    const publicProjectId = uuidToBase62(projectId);
    const condition = projectDeadLetterCondition(publicProjectId, events.map((event) => ({
      eventId: uuidToBase62(event.id),
      kind: event.kind,
      // §8.2 / AC1: this lands in a blocker `detail` a person reads, so the uuid inside the
      // event's dedupe key is spelled the way they can paste it — exactly as `capture` does it
      // for the same field on the recomputation side.
      dedupeKey: publicIdempotencyKey(event.dedupeKey),
      attempts: event.attempts + 1,
    })));
    const dedupeKey = projectBlockerDedupeKey('UNKNOWN_FAILURE', 'PROJECT', publicProjectId);
    // Only THIS key's open row, never the project's whole open set: §11.4's clear is a set
    // difference against what was observed, and handing it rows this call has no opinion about
    // would resolve every other blocker the project has.
    const openRows = await tx.$queryRaw<OpenBlockerRow[]>(Prisma.sql`
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
    const plan = planProjectBlockers({
      epoch: Math.floor(now.getTime() / 1_000),
      open: openRows.map((row) => ({
        id: uuidToBase62(row.id),
        kind: row.kind as ProjectBlockerFact['kind'],
        owner: row.owner as ProjectBlockerFact['owner'],
        recovery: row.recovery as ProjectBlockerFact['recovery'],
        severity: row.severity as ProjectBlockerFact['severity'],
        requiredAction: row.requiredAction,
        subjectType: row.subjectType as ProjectBlockerFact['subjectType'],
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
      deadEventIds: (condition.facts as { deadEventIds: string[] }).deadEventIds,
    });

    // §4.2 RS0 / TS4: the state persisted here has to be the one this snapshot's guards produce,
    // and an open USER blocker makes that AWAITING_HUMAN by guard 2.
    const state = blockerRunState(plan.openAfter) ?? 'PLANNING';
    const updated = await tx.$executeRaw(Prisma.sql`
      UPDATE "project_runtime"
         SET "run_state" = ${state}::"project_run_state",
             "next_wake_at" = ${new Date(now.getTime() + PROJECT_RECONCILE_STALE_MS)},
             "next_wake_reason" = ${`reconcile dead letter: ${errorText(error)}`},
             "lease_holder" = NULL, "lease_expires_at" = NULL, "lease_heartbeat_at" = NULL,
             "updated_at" = ${now}
       WHERE "project_id" = ${projectId}::uuid
         AND "lease_holder" = ${lease.holder}::uuid
         AND "fencing_token" = ${lease.fencingToken}
    `);
    if (updated !== 1) throw new ProjectLeaseLostError(projectId);
  }

  /** Persistently acquire the Project lease; returns null for an inactive, missing or busy row. */
  async acquireLease(projectId: string, now = new Date()): Promise<ProjectReconcileLease | null> {
    // Retried whole. Acquiring a lease is a compare-and-set on the project row: an attempt the
    // server threw away took no lease, so a re-run competes for it from the state that exists.
    return withTransactionRetry(this.prisma, async (tx) => {
      const projects = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "project"
         WHERE "id" = ${projectId}::uuid AND "status" = 'OPEN' AND "coordinator_enabled" = true
         FOR NO KEY UPDATE
      `);
      if (!projects[0]) return null;
      await this.ensureRuntime(tx, projectId, now);
      return this.acquireLeaseInTransaction(tx, projectId, now);
    }, loggedRetry(this.log, 'projectReconcile.acquireLease'));
  }

  async renewLease(
    lease: ProjectReconcileLease,
    now = new Date(),
  ): Promise<ProjectReconcileLease> {
    const expiresAt = new Date(now.getTime() + PROJECT_RECONCILE_LEASE_MS);
    const rows = await this.prisma.$queryRaw<LeaseRow[]>(Prisma.sql`
      UPDATE "project_runtime"
         SET "lease_heartbeat_at" = ${now}, "lease_expires_at" = ${expiresAt},
             "updated_at" = ${now}
       WHERE "project_id" = ${lease.projectId}::uuid
         AND "lease_holder" = ${lease.holder}::uuid
         AND "fencing_token" = ${lease.fencingToken}
         AND "lease_expires_at" > ${now}
      RETURNING "fencing_token" AS "fencingToken", "lease_expires_at" AS "leaseExpiresAt"
    `);
    if (!rows[0]) throw new ProjectLeaseLostError(lease.projectId);
    return {
      ...lease,
      fencingToken: BigInt(rows[0].fencingToken),
      expiresAt: rows[0].leaseExpiresAt,
    };
  }

  async releaseLease(lease: ProjectReconcileLease): Promise<boolean> {
    const updated = await this.prisma.$executeRaw(Prisma.sql`
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
  async applyAction(
    lease: ProjectReconcileLease,
    action: ProjectReconcileAction,
    effect: (tx: Prisma.TransactionClient, actionId: string) => Promise<void>,
    now = new Date(),
  ): Promise<ProjectActionApplyResult> {
    this.assertAction(lease, action);
    // Retried whole. `effect` is contractually database-only (see this method's doc comment), the
    // action key is the caller's and computed above, and the claim/publish pair is re-read under
    // the project lock inside the closure — so a re-run either re-claims a key nobody took or
    // finds the winner's, which is the same pair of outcomes a first attempt has.
    return withTransactionRetry(this.prisma, async (tx) => {
      const projects = await tx.$queryRaw<Array<{
        status: 'OPEN' | 'DONE' | 'CANCELLED'; coordinatorEnabled: boolean;
      }>>(Prisma.sql`
        SELECT "status", "coordinator_enabled" AS "coordinatorEnabled"
          FROM "project" WHERE "id" = ${lease.projectId}::uuid FOR NO KEY UPDATE
      `);
      if (projects[0]?.status !== 'OPEN' || !projects[0]?.coordinatorEnabled) {
        throw new ProjectLeaseLostError(lease.projectId);
      }

      const expiresAt = new Date(now.getTime() + PROJECT_RECONCILE_LEASE_MS);
      const fenced = await tx.$executeRaw(Prisma.sql`
        UPDATE "project_runtime"
           SET "lease_heartbeat_at" = ${now}, "lease_expires_at" = ${expiresAt},
               "updated_at" = ${now}
         WHERE "project_id" = ${lease.projectId}::uuid
           AND "lease_holder" = ${lease.holder}::uuid
           AND "fencing_token" = ${lease.fencingToken}
           AND "lease_expires_at" > ${now}
      `);
      if (fenced !== 1) throw new ProjectLeaseLostError(lease.projectId);

      const actionId = randomUUID();
      const inserted = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
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
        const existing = (await tx.$queryRaw<ExistingActionRow[]>(Prisma.sql`
          SELECT "id", "project_id" AS "projectId", "status"
            FROM "project_action" WHERE "idempotency_key" = ${action.idempotencyKey}
        `))[0];
        if (!existing || existing.projectId !== lease.projectId) {
          throw new Error(`idempotency key ${action.idempotencyKey} belongs to another Project`);
        }
        return {
          status: 'ALREADY_APPLIED', actionId: existing.id, actionStatus: existing.status,
        } as const;
      }

      await effect(tx, actionId);
      const published = await tx.$executeRaw(Prisma.sql`
        UPDATE "project_action" SET "status" = 'APPLIED', "updated_at" = ${now}
         WHERE "id" = ${actionId}::uuid AND "status" = 'CLAIMED'
      `);
      if (published !== 1) throw new Error(`failed to publish Project action ${actionId}`);
      return { status: 'APPLIED', actionId } as const;
    }, loggedRetry(this.log, 'projectReconcile.applyAction'));
  }

  /**
   * Apply one action attributed to a persisted decision. The comparison reuses the decision's
   * frozen evaluation instant, so time passing alone does not invalidate it; any changed world or
   * semantic signal does. A stale proposal is a committed REFUSED audit result plus a durable
   * outbox wake, never a partially applied effect or a silent rollback.
   */
  async applyDecisionAction(
    lease: ProjectReconcileLease,
    decisionId: string,
    action: ProjectReconcileAction,
    effect: (
      tx: Prisma.TransactionClient,
      actionId: string,
    ) => Promise<void | ProjectActionEffectRefusal>,
    now = new Date(),
  ): Promise<ProjectActionApplyResult> {
    this.assertAction(lease, action);
    if (action.subject.type === 'PROJECT' && action.subject.id !== lease.projectId) {
      throw new Error('Project action subject belongs to another Project');
    }
    if (!this.decisions) throw new Error('Project decision protocol is not configured');
    return this.repeatableRead(async (tx) =>
      this.applyDecisionActionInTransaction(tx, lease, decisionId, action, effect, now));
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
  private async applyDecisionActionInTransaction(
    tx: Prisma.TransactionClient,
    lease: ProjectReconcileLease,
    decisionId: string,
    action: ProjectReconcileAction,
    effect: (
      tx: Prisma.TransactionClient,
      actionId: string,
    ) => Promise<void | ProjectActionEffectRefusal>,
    now: Date,
  ): Promise<ProjectActionApplyResult> {
    {
      const projects = await tx.$queryRaw<Array<{
        status: 'OPEN' | 'DONE' | 'CANCELLED'; coordinatorEnabled: boolean;
      }>>(Prisma.sql`
        SELECT "status", "coordinator_enabled" AS "coordinatorEnabled"
          FROM "project" WHERE "id" = ${lease.projectId}::uuid FOR NO KEY UPDATE
      `);
      if (projects[0]?.status !== 'OPEN' || !projects[0]?.coordinatorEnabled) {
        throw new ProjectLeaseLostError(lease.projectId);
      }

      const expiresAt = new Date(now.getTime() + PROJECT_RECONCILE_LEASE_MS);
      const fenced = await tx.$executeRaw(Prisma.sql`
        UPDATE "project_runtime"
           SET "lease_heartbeat_at" = ${now}, "lease_expires_at" = ${expiresAt},
               "updated_at" = ${now}
         WHERE "project_id" = ${lease.projectId}::uuid
           AND "lease_holder" = ${lease.holder}::uuid
           AND "fencing_token" = ${lease.fencingToken}
           AND "lease_expires_at" > ${now}
      `);
      if (fenced !== 1) throw new ProjectLeaseLostError(lease.projectId);

      const decision = await this.decisions!.getInternal(tx, lease.projectId, decisionId);
      if (!decision) throw new Error(`Project decision ${decisionId} does not belong to ${lease.projectId}`);
      const input = decision.decisionInput as ProjectDecisionInput;
      if (input.decisionInputHash !== decision.decisionInputHash
        || hashDecisionInput(input) !== decision.decisionInputHash) {
        throw new Error(`Project decision ${decisionId} has an invalid input hash`);
      }
      const decisionOutcome = decision.outcome as ProjectDecisionOutcome;
      if (decisionOutcome.decisionInputHash !== decision.decisionInputHash
        || decisionOutcome.reconcileId !== uuidToBase62(decisionId)) {
        throw new Error(`Project decision ${decisionId} has an invalid outcome lineage`);
      }
      const publicSubjectId = action.subject.id ? uuidToBase62(action.subject.id) : null;
      // Both spellings of the key, normalized to the audit's (§6.2). A plan is written in Base62
      // and the ledger row is keyed by the internal id (§8.2); comparing the two raw would make a
      // legitimately planned action look unplanned purely because of how each side spells an id.
      const plannedKey = publicIdempotencyKey(action.idempotencyKey);
      const planned = decisionOutcome.actions.some((candidate) =>
        candidate.type === action.type
        && publicIdempotencyKey(candidate.idempotencyKey) === plannedKey
        && candidate.subject.type === action.subject.type
        && (candidate.subject.id ?? null) === publicSubjectId);
      if (!planned) {
        throw new Error(`Project action ${action.idempotencyKey} is not present in decision ${decisionId}`);
      }
      const current = await this.decisions!.capture(
        tx,
        lease.projectId,
        new Date(input.readAt),
      );
      const stale = current.input.decisionInputHash !== decision.decisionInputHash;

      const insertId = randomUUID();
      const detail = action.detail && typeof action.detail === 'object' && !Array.isArray(action.detail)
        ? { ...(action.detail as Record<string, Prisma.JsonValue>),
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
      const inserted = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        INSERT INTO "project_action" (
          "id", "project_id", "idempotency_key", "type", "status", "subject_type",
          "subject_id", "fencing_token", "decision_id", "refusal_code", "detail", "updated_at"
        ) VALUES (
          ${insertId}::uuid, ${lease.projectId}::uuid, ${action.idempotencyKey},
          ${action.type}::"project_action_type", ${stale ? 'REFUSED' : 'CLAIMED'}::"project_action_status",
          ${action.subject.type}, ${action.subject.id ?? null}::uuid, ${lease.fencingToken},
          ${decisionId}::uuid, ${stale ? 'STALE_SNAPSHOT' : null},
          ${JSON.stringify(detail)}::jsonb, ${now}
        )
        ON CONFLICT ("idempotency_key") DO NOTHING
        RETURNING "id"
      `);
      let claimedId = inserted[0]?.id ?? null;
      let ledgerDecisionId = decisionId;
      if (!claimedId) {
        const existing = (await tx.$queryRaw<ReclaimableActionRow[]>(Prisma.sql`
          SELECT "id", "project_id" AS "projectId", "status", "refusal_code" AS "refusalCode",
                 "decision_id" AS "existingDecisionId", "detail"
            FROM "project_action" WHERE "idempotency_key" = ${action.idempotencyKey}
        `))[0];
        if (!existing || existing.projectId !== lease.projectId) {
          throw new Error(`idempotency key ${action.idempotencyKey} belongs to another Project`);
        }
        // `[K5]`: one more attempt on a refusal that was a race rather than a decision. Not when
        // THIS pass is already stale — a stale claim would spend an attempt on a snapshot the fence
        // above has just refused, which is paying for the retry twice.
        if (!(action.reclaimRefused === true && !stale && verdictApplyRetryable(existing))) {
          return {
            status: 'ALREADY_APPLIED', actionId: existing.id, actionStatus: existing.status,
          } as const;
        }
        const attempt = verdictApplyAttempt(existing.detail) + 1;
        // Conditional on the row STILL being the refusal that was read, so two passes racing to
        // re-claim it cannot both win: the loser updates nothing and reads `ALREADY_APPLIED`,
        // exactly as it did before this branch existed.
        const reclaimed = await tx.$executeRaw(Prisma.sql`
          UPDATE "project_action"
             SET "status" = 'CLAIMED'::"project_action_status",
                 "refusal_code" = NULL, "reason_code" = NULL,
                 -- decision_id is NOT touched. Migration 0120 freezes it once it is set, and it
                 -- is right that it does: the lineage says which judgment PROPOSED this action, and
                 -- a retry is the same action being attempted again rather than a new one. Which
                 -- decision drove each retry is recorded beside the counter instead. (No backticks
                 -- in here: this is inside a template literal and one would close it early, which
                 -- surfaces as a TS1005 pointing at the wrong line.)
                 "fencing_token" = ${lease.fencingToken},
                 -- The counter is the BOUND, so it is written with the CLAIM and not with the
                 -- outcome: a process that dies between the two has still spent that attempt, and
                 -- a crash loop cannot buy itself an unbounded number of them.
                 "detail" = "detail" || ${JSON.stringify({
                   verdictApplyAttempt: attempt, verdictApplyRetriedBy: uuidToBase62(decisionId),
                 })}::jsonb,
                 "updated_at" = ${now}
           WHERE "id" = ${existing.id}::uuid AND "status" = 'REFUSED'
             AND "refusal_code" = ${existing.refusalCode}
        `);
        if (reclaimed !== 1) {
          return {
            status: 'ALREADY_APPLIED', actionId: existing.id, actionStatus: existing.status,
          } as const;
        }
        claimedId = existing.id;
        // The row's own lineage, which the publish and refuse clauses below match on. A re-claim
        // keeps the decision that first proposed it, so comparing against THIS pass's decision
        // would match nothing and the publish would fail on a row it had just legally claimed.
        ledgerDecisionId = existing.existingDecisionId ?? decisionId;
      }
      const actionId = claimedId;

      // The attempt belongs to the permanently claimed action key, not to a process invocation.
      // It therefore advances once for stale/refused/applied outcomes and never on a replay.
      if (action.type === 'DISPATCH_TASK' && action.subject.id) {
        await tx.$executeRaw(Prisma.sql`
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
        const scheduled = await tx.$executeRaw(Prisma.sql`
          UPDATE "project_runtime"
             SET "next_wake_at" = LEAST(COALESCE("next_wake_at", ${now}), ${now}),
                 "next_wake_reason" = 'stale Coordinator decision requires reconcile',
                 "updated_at" = ${now}
           WHERE "project_id" = ${lease.projectId}::uuid
             AND "lease_holder" = ${lease.holder}::uuid
             AND "fencing_token" = ${lease.fencingToken}
        `);
        if (scheduled !== 1) throw new ProjectLeaseLostError(lease.projectId);
        return {
          status: 'REFUSED',
          actionId,
          refusalCode: 'STALE_SNAPSHOT',
          expectedDecisionInputHash: decision.decisionInputHash,
          actualDecisionInputHash: current.input.decisionInputHash,
        } as const;
      }

      const effectResult = await effect(tx, actionId);
      if (effectResult) {
        const reasonCode = effectResult.reasonCode ?? effectResult.refusalCode;
        const refused = await tx.$executeRaw(Prisma.sql`
          UPDATE "project_action"
             SET "status" = ${effectResult.status}::"project_action_status",
                 "refusal_code" = ${effectResult.refusalCode},
                 "reason_code" = ${reasonCode},
                 "detail" = "detail" || ${JSON.stringify(effectResult.detail ?? {})}::jsonb,
                 "updated_at" = ${now}
           WHERE "id" = ${actionId}::uuid AND "status" = 'CLAIMED'
             AND "decision_id" = ${ledgerDecisionId}::uuid
        `);
        if (refused !== 1) throw new Error(`failed to refuse Project action ${actionId}`);
        return {
          status: effectResult.status,
          actionId,
          refusalCode: effectResult.refusalCode,
          reasonCode,
        } as const;
      }
      const published = await tx.$executeRaw(Prisma.sql`
        UPDATE "project_action" SET "status" = 'APPLIED', "updated_at" = ${now}
         WHERE "id" = ${actionId}::uuid AND "status" = 'CLAIMED'
           AND "decision_id" = ${ledgerDecisionId}::uuid
      `);
      if (published !== 1) throw new Error(`failed to publish Project action ${actionId}`);
      return { status: 'APPLIED', actionId } as const;
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
  private async repeatableRead<T>(effect: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return withTransactionRetry(
      this.prisma,
      effect,
      loggedRetry(this.log, 'project.applyDecisionAction', {
        transaction: { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      }),
    );
  }

  private async acquireLeaseInTransaction(
    tx: Prisma.TransactionClient,
    projectId: string,
    now: Date,
  ): Promise<ProjectReconcileLease | null> {
    const expiresAt = new Date(now.getTime() + PROJECT_RECONCILE_LEASE_MS);
    const rows = await tx.$queryRaw<LeaseRow[]>(Prisma.sql`
      UPDATE "project_runtime"
         SET "lease_holder" = ${this.instanceId}::uuid,
             "lease_expires_at" = ${expiresAt}, "lease_heartbeat_at" = ${now},
             "fencing_token" = "fencing_token" + 1, "updated_at" = ${now}
       WHERE "project_id" = ${projectId}::uuid
         AND ("lease_holder" IS NULL OR "lease_expires_at" <= ${now})
      RETURNING "fencing_token" AS "fencingToken", "lease_expires_at" AS "leaseExpiresAt"
    `);
    if (!rows[0]) return null;
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
  async applyAggregations(
    tx: Prisma.TransactionClient,
    projectId: string,
    aggregations: readonly PlannedTaskAggregation[],
    now: Date,
  ): Promise<number> {
    let applied = 0;
    for (const aggregation of aggregations) {
      applied += await tx.$executeRaw(Prisma.sql`
        UPDATE "task"
           SET "status" = ${aggregation.to}::"task_status", "updated_at" = ${now}
         WHERE "id" = ${base62ToUuid(aggregation.taskId)}::uuid
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
  private async applyCoordinatorRotation(
    tx: Prisma.TransactionClient,
    lease: ProjectReconcileLease,
    decisionId: string,
    outcome: ProjectDecisionOutcome,
    now: Date,
  ): Promise<boolean> {
    const planned = outcome.coordinator;
    if (planned?.status !== 'ROTATE') return false;
    const action = outcome.actions.find((candidate) =>
      candidate.type === 'ROTATE_COORDINATOR_SESSION');
    if (!action) return false;
    if (!this.rotationExecutor) {
      // Nest always registers one. Warn rather than throw: a deployment that somehow has none must
      // still publish its run state and consume its events, and the next pass re-plans the same
      // rotation from the same facts.
      this.log.warn(`Project ${lease.projectId} planned a coordinator rotation with no executor`);
      return false;
    }
    const result = await this.applyDecisionActionInTransaction(
      tx,
      lease,
      decisionId,
      {
        type: 'ROTATE_COORDINATOR_SESSION',
        idempotencyKey: this.rotationExecutor.idempotencyKey(lease.projectId, planned.generation),
        subject: { type: 'PROJECT', id: lease.projectId },
        detail: this.rotationExecutor.actionDetail(planned),
      },
      async (effectTx, actionId) =>
        this.rotationExecutor!.rotateInTransaction(effectTx, lease, {
          decisionId,
          planned,
        }, actionId, now),
      now,
    );
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
  private async applyCoordinatorTurn(
    tx: Prisma.TransactionClient,
    lease: ProjectReconcileLease,
    decisionId: string,
    outcome: ProjectDecisionOutcome,
    context: { gatedWriteTaken: boolean; automationPolicy: string },
    now: Date,
  ): Promise<'APPLIED' | 'ENTERED' | 'DEFERRED' | 'NEEDS_APPROVAL' | 'NOT_PLANNED'> {
    const planned = outcome.turn;
    if (planned?.verdict !== 'OPEN') return 'NOT_PLANNED';
    const action = outcome.actions.find((candidate) =>
      candidate.type === 'OPEN_COORDINATOR_TURN');
    if (!action) return 'NOT_PLANNED';
    if (!this.turnExecutor) {
      // Nest always registers one. Warn rather than throw, exactly as the rotation does: a
      // deployment that somehow has none must still publish its run state and consume its events,
      // and the next pass re-plans the same turn from the same facts under the same key.
      this.log.warn(`Project ${lease.projectId} planned a coordinator turn with no executor`);
      return 'NOT_PLANNED';
    }
    if (context.gatedWriteTaken) return 'DEFERRED';
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
    if (projectPolicyCell(
      context.automationPolicy as ProjectAutomationPolicyValue, 'COORDINATOR_ROUTINE') !== 'ALLOW') {
      this.log.warn(
        `Project ${uuidToBase62(lease.projectId)} needs approval to open a `
        + `${planned.reasonCode} coordinator turn under ${context.automationPolicy}`,
      );
      return 'NEEDS_APPROVAL';
    }
    const result = await this.applyDecisionActionInTransaction(
      tx,
      lease,
      decisionId,
      {
        type: 'OPEN_COORDINATOR_TURN',
        idempotencyKey: this.turnExecutor.idempotencyKey(
          lease.projectId,
          coordinatorTurnGeneration(planned.idempotencyKey) ?? '',
          planned.reasonDigest,
        ),
        subject: { type: 'PROJECT', id: lease.projectId },
        detail: this.turnExecutor.actionDetail(planned),
      },
      async (effectTx, actionId) => this.turnExecutor!.openInTransaction(effectTx, lease, {
        decisionId, planned,
      }, actionId, now),
      now,
    );
    if (result.status === 'APPLIED') {
      // Post-commit, and re-read from the ledger before anything is sent: a rollback after this
      // point leaves a row that says nothing was applied, and no notification goes out for it.
      this.pendingTurns.push(result.actionId);
      this.log.log(
        `Project ${uuidToBase62(lease.projectId)} opened a ${planned.reasonCode} coordinator turn`,
      );
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
      this.log.error(
        `Project ${uuidToBase62(lease.projectId)} cannot open its ${planned.reasonCode} turn: `
        + `key ${planned.idempotencyKey} is spent on a ${result.actionStatus} row`,
      );
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
  private async flushPendingTurns(): Promise<void> {
    const actionIds = this.pendingTurns.splice(0, this.pendingTurns.length);
    for (const actionId of actionIds) {
      try {
        const delivered = await this.turnExecutor?.deliveredTurn(actionId);
        if (delivered) this.turnExecutor?.announce(delivered.sessionId, delivered.status);
      } catch (cause) {
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
  private async pendingVerificationVerdicts(
    tx: Prisma.TransactionClient,
    projectId: string,
    input: ProjectDecisionInput,
  ): Promise<PlannedVerificationVerdict[]> {
    if (!this.verdictExecutor) return [];
    const planned = verificationVerdictPlan(input);
    if (!planned.length) return [];
    const keys = planned.map((verdict) => this.verdictKey(projectId, verdict));
    const spent = await tx.$queryRaw<Array<{
      idempotencyKey: string; status: string; refusalCode: string | null; detail: unknown;
    }>>(Prisma.sql`
      SELECT "idempotency_key" AS "idempotencyKey", "status"::text AS "status",
             "refusal_code" AS "refusalCode", "detail"
        FROM "project_action"
       WHERE "project_id" = ${projectId}::uuid
         AND "idempotency_key" IN (${Prisma.join(keys)})
    `);
    // `[K5]` criterion 7. "A row exists" used to be the whole test, and that is what made a
    // retryable refusal permanent: the row was there, so the conclusion was never proposed again,
    // so DEP4's gate stayed `VERDICT_NOT_APPLIED` and every dependent waited on a pass that had
    // stopped being able to do anything about it. A row with budget left is NOT spent.
    const done = new Set(spent
      .filter((row) => !verdictApplyRetryable(row))
      .map((row) => row.idempotencyKey));
    // …and a row with NO budget left is escalated here, on the pass that notices, whichever door
    // spent the last attempt.
    await this.stampExhaustedVerdictApplies(tx, projectId, planned, new Date(input.readAt));
    return planned.filter((verdict) => !done.has(this.verdictKey(projectId, verdict)));
  }

  /** The ledger's spelling of one verdict's permanent key (§8.2): internal ids throughout. */
  private verdictKey(projectId: string, planned: PlannedVerificationVerdict): string {
    return this.verdictExecutor!.idempotencyKey(
      projectId, base62ToUuid(planned.verifierTaskId), planned.verdictRevision,
    );
  }

  /** The audit's spelling of the same key, which is what a plan is written in (§6.2 / §8.2). */
  private verdictAction(
    projectId: string,
    planned: PlannedVerificationVerdict,
  ): ProjectDecisionOutcome['actions'][number] {
    return {
      type: 'APPLY_VERIFICATION_VERDICT',
      idempotencyKey: publicIdempotencyKey(this.verdictKey(projectId, planned)),
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
  private async applyVerificationVerdicts(
    tx: Prisma.TransactionClient,
    lease: ProjectReconcileLease,
    decisionId: string,
    pending: readonly PlannedVerificationVerdict[],
    rotationAttempted: boolean,
    now: Date,
  ): Promise<number> {
    if (!pending.length || !this.verdictExecutor) return 0;
    if (rotationAttempted) return pending.length;
    const planned = pending[0];
    const result = await this.applyDecisionActionInTransaction(
      tx,
      lease,
      decisionId,
      {
        type: 'APPLY_VERIFICATION_VERDICT',
        idempotencyKey: this.verdictKey(lease.projectId, planned),
        subject: { type: 'TASK', id: base62ToUuid(planned.verifierTaskId) },
        detail: this.verdictExecutor.actionDetail(planned),
        // The one action type whose refusals are not all decisions — see `reclaimRefused`.
        reclaimRefused: true,
      },
      async (effectTx, actionId) => this.verdictExecutor!.applyVerdictInTransaction(
        effectTx, lease, { decisionId, planned }, actionId, now,
      ),
      now,
    );
    if (result.status === 'APPLIED') {
      this.log.log(
        `Project ${uuidToBase62(lease.projectId)} applied verdict ${planned.verdict} `
        + `from ${planned.verifierTaskId} (revision ${planned.verdictRevision})`,
      );
    }
    return pending.length - 1;
  }

  /**
   * `[K5]` criterion 7: mark every conclusion whose apply has run out of attempts.
   *
   * Derived on every pass from the ledger, rather than written by the attempt that happened to
   * spend the last one. Two doors reach this action — the loop, and
   * `ProjectVerificationVerdictService.apply` for a lease holder outside it — and only one of them
   * is this method. A stamp written by the failing attempt would therefore be missing exactly when
   * the other door exhausted the budget, which is the case a person most needs told about.
   *
   * `refusal_code` is left as the failure wrote it: that is the audit, and overwriting it would
   * lose why the apply actually failed. `reason_code` is the BUCKET, which is how this table
   * already uses it, and it is the field a condition detector can read — the decision snapshot
   * carries `reasonCode` and carries no `detail`, so an attempt counter would be invisible to §11
   * and this is not.
   *
   * Idempotent by its WHERE clause, so a pass that finds the stamp already there writes nothing and
   * BL7's churn rule is never tripped.
   */
  private async stampExhaustedVerdictApplies(
    tx: Prisma.TransactionClient,
    projectId: string,
    planned: readonly PlannedVerificationVerdict[],
    now: Date,
  ): Promise<void> {
    if (!planned.length) return;
    const keys = planned.map((verdict) => this.verdictKey(projectId, verdict));
    const rows = await tx.$queryRaw<Array<{
      id: string; status: string; refusalCode: string | null; detail: unknown;
    }>>(Prisma.sql`
      SELECT "id", "status"::text AS "status", "refusal_code" AS "refusalCode", "detail"
        FROM "project_action"
       WHERE "project_id" = ${projectId}::uuid
         AND "idempotency_key" IN (${Prisma.join(keys)})
    `);
    for (const row of rows) {
      if (!verdictApplyExhausted(row)) continue;
      const stamped = await tx.$executeRaw(Prisma.sql`
        UPDATE "project_action"
           SET "reason_code" = ${VERDICT_APPLY_EXHAUSTED}, "updated_at" = ${now}
         WHERE "id" = ${row.id}::uuid AND "status" = 'REFUSED'
           AND "reason_code" IS DISTINCT FROM ${VERDICT_APPLY_EXHAUSTED}
      `);
      if (stamped === 1) {
        this.log.warn(
          `Project ${uuidToBase62(projectId)} exhausted the retry budget applying a verdict `
          + `(action ${row.id}, ${verdictApplyAttempt(row.detail)} attempts); escalating`,
        );
      }
    }
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
  private pendingVerificationFilings(
    input: ProjectDecisionInput,
  ): PlannedVerificationFiling[] {
    if (!this.filingExecutor) return [];
    return planCompletionGaps(input, completionGapPlan(input)).filings;
  }

  /** The audit's spelling of one filing's key (§6.2 / §8.2). */
  private filingAction(
    projectId: string,
    planned: PlannedVerificationFiling,
  ): ProjectDecisionOutcome['actions'][number] {
    return {
      type: 'FILE_VERIFICATION_TASK',
      idempotencyKey: publicIdempotencyKey(this.filingExecutor!.idempotencyKey(
        projectId, base62ToUuid(planned.subjectTaskId), planned.generation,
      )),
      subject: { type: 'TASK', id: planned.subjectTaskId },
    };
  }

  /**
   * File the one verification this pass claimed, and report how many are still owed after it.
   *
   * Same shape as the verdicts: one gated write per pass, a refusal is a committed audit row rather
   * than an exception, and what is left over floors the wake so the loop comes straight back.
   */
  private async applyVerificationFilings(
    tx: Prisma.TransactionClient,
    lease: ProjectReconcileLease,
    decisionId: string,
    pending: readonly PlannedVerificationFiling[],
    rotationAttempted: boolean,
    now: Date,
  ): Promise<number> {
    if (!pending.length || !this.filingExecutor) return 0;
    if (rotationAttempted) return pending.length;
    const planned = pending[0];
    const result = await this.applyDecisionActionInTransaction(
      tx,
      lease,
      decisionId,
      {
        type: 'FILE_VERIFICATION_TASK',
        idempotencyKey: this.filingExecutor.idempotencyKey(
          lease.projectId, base62ToUuid(planned.subjectTaskId), planned.generation,
        ),
        subject: { type: 'TASK', id: base62ToUuid(planned.subjectTaskId) },
        detail: this.filingExecutor.actionDetail(planned),
      },
      async (effectTx, actionId) => this.filingExecutor!.fileInTransaction(
        effectTx, lease, { decisionId, planned }, actionId, now,
      ),
      now,
    );
    if (result.status === 'APPLIED') {
      this.log.log(
        `Project ${uuidToBase62(lease.projectId)} filed the verification `
        + `${planned.subjectTaskId} completes on (generation ${planned.generation})`,
      );
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
  private async flushPendingRotations(): Promise<void> {
    const actionIds = this.pendingRotations.splice(0, this.pendingRotations.length);
    for (const actionId of actionIds) {
      try {
        const rows = await this.prisma.$queryRaw<Array<{ resultSessionId: string | null }>>(Prisma.sql`
          SELECT "result_session_id" AS "resultSessionId" FROM "project_action"
           WHERE "id" = ${actionId}::uuid AND "status" = 'APPLIED'
        `);
        const sessionId = rows[0]?.resultSessionId;
        if (sessionId) this.rotationExecutor?.announce(sessionId);
      } catch (cause) {
        // A missed notification costs latency, never correctness: the Session is committed PENDING
        // and the runner's own poll finds it.
        this.log.warn(`Project rotation notification failed for ${actionId}: ${errorText(cause)}`);
      }
    }
  }

  private async applyBlockers(
    tx: Prisma.TransactionClient,
    projectId: string,
    lease: ProjectReconcileLease,
    decisionId: string | null,
    plan: ProjectDecisionBlockerAudit | undefined,
    now: Date,
    actionDetail: Record<string, unknown> = {},
  ): Promise<void> {
    if (!plan) return;

    for (const raise of plan.raised) {
      await this.raiseBlocker(tx, projectId, lease, decisionId, raise, now, actionDetail);
    }

    // §11.3 / AC8. The same cause seen again moves exactly two display columns and recomputes the
    // condition digest from CURRENT facts. No new row, no ledger key, no notification — which is
    // the entire content of "duplicate events produce no extra side effect".
    for (const touch of plan.touched) {
      await tx.$executeRaw(Prisma.sql`
        UPDATE "project_blocker"
           SET "occurrences" = "occurrences" + 1,
               "last_seen_at" = GREATEST("last_seen_at", ${new Date(touch.lastSeenAt)}),
               "condition_version" = ${touch.conditionVersion},
               "next_check_at" = ${new Date(touch.nextCheckAt)},
               "detail" = ${JSON.stringify(touch.detail)}::jsonb,
               "updated_at" = ${now}
         WHERE "id" = ${base62ToUuid(touch.blockerId)}::uuid
           AND "project_id" = ${projectId}::uuid
           AND "resolved_at" IS NULL
      `);
    }

    // §11.4: the condition is gone, so the row is resolved — by AUTO, because nobody did anything;
    // the world simply stopped being that way. The row itself stays forever (BE1).
    for (const clear of plan.cleared) {
      const blockerId = base62ToUuid(clear.blockerId);
      const resolved = await tx.$executeRaw(Prisma.sql`
        UPDATE "project_blocker"
           SET "resolved_at" = ${now}, "resolved_by" = 'AUTO'::"project_blocker_resolved_by",
               "updated_at" = ${now}
         WHERE "id" = ${blockerId}::uuid
           AND "project_id" = ${projectId}::uuid
           AND "resolved_at" IS NULL
      `);
      if (resolved !== 1) continue;
      await this.claimBlockerAction(tx, projectId, lease, decisionId, {
        type: 'CLEAR_BLOCKER',
        idempotencyKey: clearBlockerIdempotencyKey(projectId, blockerId),
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
      const blockerId = base62ToUuid(escalation.blockerId);
      const escalated = await tx.$executeRaw(Prisma.sql`
        UPDATE "project_blocker"
           SET "owner" = 'USER'::"project_blocker_owner", "escalated_at" = ${now},
               "updated_at" = ${now}
         WHERE "id" = ${blockerId}::uuid
           AND "project_id" = ${projectId}::uuid
           AND "resolved_at" IS NULL
           AND "escalated_at" IS NULL
      `);
      if (escalated !== 1) continue;
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
  private async raiseBlocker(
    tx: Prisma.TransactionClient,
    projectId: string,
    lease: ProjectReconcileLease,
    decisionId: string | null,
    raise: PlannedBlockerRaise,
    now: Date,
    actionDetail: Record<string, unknown> = {},
  ): Promise<{ id: string; lifecycleGeneration: bigint }> {
    const subjectId = internalSubjectId(raise.subjectId);
    // §11.3 BE1: the generation is allocated INSIDE the insert as `MAX + 1` over this key's whole
    // history, which is why resolved rows are never deleted. Returning no row means this episode
    // is already open — §8.5 C2: read the existing row, keep ITS generation so the key is
    // unchanged, and skip the side effect.
    const inserted = await tx.$queryRaw<Array<{ id: string; lifecycleGeneration: bigint }>>(Prisma.sql`
      INSERT INTO "project_blocker" (
        "id", "project_id", "kind", "owner", "recovery", "severity", "required_action",
        "next_check_at", "subject_type", "subject_id", "detail", "dedupe_key",
        "lifecycle_generation", "condition_version", "first_seen_at", "last_seen_at",
        "occurrences", "created_at", "updated_at"
      )
      SELECT ${randomUUID()}::uuid, ${projectId}::uuid, ${raise.kind},
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
    const row = inserted[0] ?? (await tx.$queryRaw<Array<{ id: string; lifecycleGeneration: bigint }>>(Prisma.sql`
      SELECT "id", "lifecycle_generation" AS "lifecycleGeneration" FROM "project_blocker"
       WHERE "project_id" = ${projectId}::uuid
         AND "dedupe_key" = ${internalDedupeKey(raise.dedupeKey)}
         AND "resolved_at" IS NULL
    `))[0];
    if (!row) throw new Error(`failed to raise ${raise.kind} blocker on ${projectId}`);
    await this.claimBlockerAction(tx, projectId, lease, decisionId, {
      type: 'RAISE_BLOCKER',
      idempotencyKey: raiseBlockerIdempotencyKey(
        projectId, raise.kind, subjectId ?? raise.subjectId, row.lifecycleGeneration,
      ),
      subjectType: raise.subjectType,
      subjectId,
      detail: {
        blockerId: uuidToBase62(row.id),
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
  private async claimBlockerAction(
    tx: Prisma.TransactionClient,
    projectId: string,
    lease: ProjectReconcileLease,
    decisionId: string | null,
    action: {
      type: 'RAISE_BLOCKER' | 'CLEAR_BLOCKER';
      idempotencyKey: string;
      subjectType: string;
      subjectId: string | null;
      detail: Record<string, unknown>;
    },
    now: Date,
  ): Promise<void> {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "project_action" (
        "id", "project_id", "idempotency_key", "type", "status", "subject_type",
        "subject_id", "fencing_token", "decision_id", "detail", "created_at", "updated_at"
      ) VALUES (
        ${randomUUID()}::uuid, ${projectId}::uuid, ${action.idempotencyKey},
        ${action.type}::"project_action_type", 'APPLIED', ${action.subjectType},
        ${action.subjectId}::uuid, ${lease.fencingToken}, ${decisionId}::uuid,
        ${JSON.stringify(action.detail)}::jsonb, ${now}, ${now}
      )
      ON CONFLICT ("idempotency_key") DO NOTHING
    `);
  }

  private async ensureRuntime(
    tx: Prisma.TransactionClient,
    projectId: string,
    now: Date,
  ): Promise<void> {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "project_runtime" ("project_id", "created_at", "updated_at")
      VALUES (${projectId}::uuid, ${now}, ${now})
      ON CONFLICT ("project_id") DO NOTHING
    `);
  }

  private async runStateOf(
    tx: Prisma.TransactionClient,
    projectId: string,
  ): Promise<ProjectReconcileRunState> {
    const rows = await tx.$queryRaw<Array<{
      status: 'OPEN' | 'DONE' | 'CANCELLED';
      hasLiveSession: boolean;
      hasPendingVerification: boolean;
    }>>(Prisma.sql`
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
    if (!snapshot || snapshot.status !== 'OPEN') return 'SETTLED';
    if (snapshot.hasLiveSession) return 'EXECUTING';
    if (snapshot.hasPendingVerification) return 'AWAITING_VERIFICATION';
    return 'PLANNING';
  }

  private async enqueueScheduledWakes(now: Date): Promise<number> {
    return this.prisma.$executeRaw(Prisma.sql`
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
  private async enqueueBackstopWakes(now: Date): Promise<number> {
    const staleBefore = new Date(now.getTime() - PROJECT_RECONCILE_STALE_MS);
    return this.prisma.$executeRaw(Prisma.sql`
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

  private assertAction(lease: ProjectReconcileLease, action: ProjectReconcileAction): void {
    if (!action.idempotencyKey.startsWith(`pc:v1:${lease.projectId}:`)) {
      throw new RangeError('Project action idempotency key must use pc:v1:<project UUID>:...');
    }
    if (!(ACTION_TYPES as readonly string[]).includes(action.type)) {
      throw new RangeError(`unsupported Project action type ${action.type}`);
    }
    if (!action.subject.type.trim()) throw new RangeError('Project action subject type is required');
  }
}

function contentionWake(projectId: string, expiresAt: Date | null | undefined, now: Date): Date {
  // Deterministic 0..250ms jitter spreads replicas without making the same dirty world produce a
  // different schedule after restart.
  let hash = 0;
  for (const char of projectId) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  const base = Math.max(now.getTime() + 1_000, expiresAt?.getTime() ?? now.getTime());
  return new Date(base + (hash % 251));
}

/** A blocker subject is a Base62 row id for everything the control loop can name today; a natural
 *  key (a builtin provider's slug) is not an address and stays out of the uuid column. */
function internalSubjectId(subjectId: string): string | null {
  try {
    return base62ToUuid(subjectId);
  } catch {
    return null;
  }
}

/** The stored key keeps the internal id, so the partial unique index and `MAX + 1` key on the same
 *  bytes the row does; the audit face publicizes it on the way out. */
function internalDedupeKey(dedupeKey: string): string {
  const parts = dedupeKey.split(':');
  if (parts.length !== 3) return dedupeKey;
  return `${parts[0]}:${parts[1]}:${internalSubjectId(parts[2]) ?? parts[2]}`;
}

function errorText(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.slice(0, 2_000);
}
