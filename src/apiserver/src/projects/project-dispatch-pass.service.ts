import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { base62ToUuid, uuidToBase62 } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  ProjectDecisionService,
  createDecisionId,
  planProjectDecision,
  publicIdempotencyKey,
} from './project-decision.service';
import {
  ProjectDispatchPassExecutor,
  ProjectLeaseLostError,
  ProjectReconcileLease,
  ProjectReconcileService,
} from './project-reconcile.service';
import {
  PROJECT_DISPATCH_PASS_MAX_PER_WAKE,
  ProjectDispatchSelection,
  projectDispatchIdempotencyKey,
  selectDispatchableTasks,
} from './project-dispatch-pass';
import { ProjectTaskDispatcherService } from './project-task-dispatcher.service';

/** What one pass did, for the log line and for a test that wants to assert on a single wake. */
export interface ProjectDispatchPassResult {
  projectId: string;
  /** `null` when the project was not leasable — a normal outcome, not a failure. */
  leased: boolean;
  dispatched: string[];
  refused: Array<{ taskId: string; refusalCode: string | null }>;
  /** The last selection this pass computed, for diagnosis when nothing was dispatched. */
  selection: ProjectDispatchSelection | null;
}

/**
 * §7.8 — the pass that proposes `DISPATCH_TASK`.
 *
 * `plannedActions` plans exactly one action itself and says why: "every other action in §7.3's
 * table is proposed by the unit that applies it, which passes its own list." This is that unit for
 * dispatch, and until it existed the sentence described nobody — `ProjectTaskDispatcherService`
 * had one non-spec caller, the e2e rig, and production reached `dispatch()` from nowhere at all.
 *
 * **When it runs.** Immediately after a reconcile pass commits, and only then. §10.2 freezes the
 * wake paths at *exactly three* and W1 makes a second `setInterval` a named production incident, so
 * this deliberately owns no clock: it registers with the ledger and is invoked from the post-commit
 * callback the delivery already makes, for the project that delivery just reconciled. Everything
 * that decides *how often* a project is looked at therefore stays in §10.4 — a blocker's
 * `nextCheckAt`, a backoff, an in-flight session's fallback, the backstop. That is not only
 * economy: it is what paces re-attempts. §11.2's resolution-chain kinds do not stop the next
 * attempt (they are cleared by one succeeding), so a task refused `NO_MATCHING_RUNNER` is retried
 * on that blocker's own two-minute recheck instead of on every tick of a private timer.
 *
 * **What it does per candidate.** The sequence the e2e rig froze, in the same order and for the
 * same reasons: take the lease; inside ONE `REPEATABLE READ` transaction capture the world, choose
 * from that captured snapshot, plan a decision carrying the single `DISPATCH_TASK` it chose, and
 * persist it; then hand the dispatcher the lease and the decision id. §8.3 refuses an action no
 * decision proposed, so the choosing and the planning have to see one snapshot — which is why the
 * selection runs *inside* the capture transaction rather than against a snapshot read earlier.
 *
 * **Why one decision per dispatch.** §7.7's staleness gate re-captures the world at apply time and
 * compares hashes. A dispatch that succeeded created a Session, which changes the world — so a
 * second dispatch attributed to the *same* decision would be refused `STALE_SNAPSHOT` by the effect
 * of the first. Re-capturing per candidate is not a cost, it is the only shape that is correct, and
 * it has a second benefit worth naming: the next candidate is chosen against a world that already
 * contains the previous Session, so §9.4's free-slot count is re-derived from truth rather than
 * decremented in memory.
 *
 * **What it does not do.** It does not evaluate §9.2's matrix, §9.4's caps at the commit point,
 * approvals, providers or PAC §5's resolution chain. Those are the dispatcher's, inside the ledger
 * transaction under the project row lock, and a second copy here would be §7.4 A6's disagreement
 * with extra steps. This pass chooses; the dispatcher admits.
 */
@Injectable()
export class ProjectDispatchPassService
implements ProjectDispatchPassExecutor, OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ProjectDispatchPassService.name);
  private unregister?: () => void;

  constructor(
    private readonly prisma: PrismaService,
    private readonly reconciler: ProjectReconcileService,
    private readonly decisions: ProjectDecisionService,
    private readonly dispatcher: ProjectTaskDispatcherService,
  ) {}

  /**
   * The production wiring, and the whole of it. Registered rather than injected for the reason
   * §7.5's rotation is: the ledger would otherwise depend on a service that depends on the ledger,
   * and a `forwardRef` between two singletons hides a wiring fact behind a decorator.
   */
  onModuleInit(): void {
    this.unregister = this.reconciler.registerDispatchPass(this);
  }

  onModuleDestroy(): void {
    this.unregister?.();
    this.unregister = undefined;
  }

  /**
   * One pass over one project.
   *
   * Public because §10.2's three wake paths are not the only legitimate callers: an operational
   * recovery probe and the e2e rig both need to drive exactly one pass and assert on what it did.
   *
   * The loop stops on the first of four things: the snapshot proposes nothing, every candidate has
   * already been attempted in this pass, the pass limit is reached, or the lease is lost. The
   * "already attempted" set is load-bearing — a refusal does not raise its blocker until the NEXT
   * reconcile recomputes §11.4, so without it a task the dispatcher just refused would be selected
   * again by the very next capture, and the pass would spin until it hit the limit, minting one
   * permanent action key per turn of the loop.
   */
  async runFor(projectId: string, limit = PROJECT_DISPATCH_PASS_MAX_PER_WAKE): Promise<ProjectDispatchPassResult> {
    const result: ProjectDispatchPassResult = {
      projectId, leased: false, dispatched: [], refused: [], selection: null,
    };
    const lease = await this.reconciler.acquireLease(projectId);
    // Not a failure: the reconcile pass that woke us may still hold it, or another instance does.
    // Whoever holds it publishes a `next_wake_at`, so the project is not left without a clock.
    if (!lease) return result;
    result.leased = true;
    const attempted = new Set<string>();
    try {
      for (let i = 0; i < limit; i += 1) {
        const planned = await this.planOne(lease, attempted);
        if (!planned) break;
        result.selection = planned.selection;
        attempted.add(planned.taskId);
        const outcome = await this.dispatcher.dispatch(lease, {
          decisionId: planned.decisionId,
          taskId: base62ToUuid(planned.taskId),
          idempotencyKey: planned.idempotencyKey,
        });
        // `ALREADY_APPLIED` is a replay landing on a key this pass has already spent — the same
        // outcome as APPLIED for the world, and deliberately not counted as a dispatch here
        // because this pass did not perform one.
        if (outcome.action.status === 'APPLIED' && outcome.sessionId) {
          result.dispatched.push(planned.taskId);
        } else {
          result.refused.push({
            taskId: planned.taskId,
            refusalCode: 'refusalCode' in outcome.action ? outcome.action.refusalCode : null,
          });
        }
      }
    } catch (cause) {
      // Losing the lease mid-pass is the ordinary outcome of somebody else taking over, and every
      // effect so far is already committed under the token that was still valid when it landed.
      // Anything else is a fault this pass did not classify: it is logged and swallowed for the
      // same reason `tick` swallows one, since the caller is a post-commit callback whose
      // transaction is already durable and must not be turned into a failed delivery.
      if (cause instanceof ProjectLeaseLostError) {
        this.log.debug(`Project dispatch pass lost the lease for ${uuidToBase62(projectId)}`);
      } else {
        this.log.error(`Project dispatch pass failed for ${uuidToBase62(projectId)}: ${errorText(cause)}`);
      }
    } finally {
      await this.reconciler.releaseLease(lease).catch(() => undefined);
    }
    if (result.dispatched.length > 0) {
      this.log.log(
        `Project ${uuidToBase62(projectId)} dispatched ${result.dispatched.length} task(s): ${result.dispatched.join(', ')}`,
      );
    }
    return result;
  }

  /**
   * Capture, choose and plan in one `REPEATABLE READ` transaction, returning the single action the
   * decision it just persisted proposes — or `null` when this snapshot proposes nothing new.
   *
   * `capture` refuses to run outside REPEATABLE READ, and that is the point: the hash this decision
   * is keyed by has to describe one snapshot, or §7.7's gate at apply time would be comparing
   * against a world nobody ever saw.
   */
  private async planOne(
    lease: ProjectReconcileLease,
    attempted: ReadonlySet<string>,
  ): Promise<{
    decisionId: string;
    taskId: string;
    idempotencyKey: string;
    selection: ProjectDispatchSelection;
  } | null> {
    const decisionId = createDecisionId();
    return this.prisma.$transaction(async (tx) => {
      const captured = await this.decisions.capture(tx, lease.projectId);
      const selection = selectDispatchableTasks(captured.input);
      const chosen = selection.candidates.find((candidate) => !attempted.has(candidate.taskId));
      if (!chosen) return null;
      const idempotencyKey = projectDispatchIdempotencyKey(
        lease.projectId, base62ToUuid(chosen.taskId), chosen.attempt,
      );
      const outcome = planProjectDecision(captured.input, {
        decisionId,
        // §8.2: a PLAN is spelled the way the audit spells everything — Base62 — while the ledger
        // row is keyed by the internal id. `publicIdempotencyKey` is the one translation between
        // them, and `applyDecisionAction` normalizes both sides through it before comparing.
        actions: [{
          type: 'DISPATCH_TASK',
          idempotencyKey: publicIdempotencyKey(idempotencyKey),
          subject: { type: 'TASK', id: chosen.taskId },
        }],
      });
      // The snapshot was taken under this lease, so a token that moved means somebody else holds
      // it now and this decision must not be written at all.
      if (BigInt(outcome.fencingToken) !== lease.fencingToken) {
        throw new ProjectLeaseLostError(lease.projectId);
      }
      await this.decisions.persist(tx, captured, outcome, decisionId);
      return { decisionId, taskId: chosen.taskId, idempotencyKey, selection };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
