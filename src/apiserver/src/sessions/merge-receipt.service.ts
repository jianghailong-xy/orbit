import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  forwardRef,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ModuleRef } from '@nestjs/core';
import { CompletionInputRouter } from '../projects/completion-input-router.service';
import { TasksService } from '../tasks/tasks.service';

/**
 * The one thing a landing asks of the task side (contract §2.5 J10). It answers with the dependents
 * it released and did not start — the ones that wait for a decision (`DEPENDENT_READY`).
 */
export interface LandingDispatcher {
  dispatchDependentsOf(ownerId: string, doneTaskId: string): Promise<string[]>;
}
import {
  MERGE_RECEIPT_MAX_CONFLICTS,
  MergeReceiptRecorder,
  MergeReceiptResult,
  MergeReceiptRow,
  mergeReceiptIdempotencyKey,
  mergeReceiptRow,
  mergeStatusForResult,
  normalizeSha,
  resultLanded,
} from './merge-receipt';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { storeDerivedProjectStatus } from '../projects/project-done-derived';
import {
  checkpointIdForCommit,
  checkpointLandingGate,
} from '../projects/task-checkpoint.service';
import { checkpointMergeReceiptKey } from '../projects/task-checkpoint';

export interface RecordMergeReceiptInput {
  result: MergeReceiptResult;
  sourceBranch?: string | null;
  sourceSha: string;
  targetBranch: string;
  targetShaBefore?: string | null;
  targetShaAfter?: string | null;
  rebaseBaseSha?: string | null;
  conflicts?: string[] | null;
  detail?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  /** `[K6]` §7: the test-evidence digest the caller claims this landing rests on. Compared with the
   *  checkpoint's, never trusted — a second measurement that disagrees with the recorded one is
   *  `TEST_EVIDENCE_MISMATCH`, not a tie broken in favour of whoever spoke last. */
  evidenceDigest?: string | null;
}

/**
 * The merge receipt writer and reader (contract §13.7).
 *
 * A service of its own rather than four more methods on `SessionsService` (4,000 lines) because
 * everything here is one narrow question — "did this branch land, and can that be re-checked" —
 * and because three different callers write it: the user API, the runner's own merge-result path,
 * and an agent recording a merge it made itself in its worktree.
 *
 * The third caller is the one this exists for. `session.merge_status` is written by exactly one
 * code path, Orbit's Merge button; a branch merged the way these branches actually get merged left
 * that column NULL and `branch_merged` false permanently, so the control plane's honest answer to
 * "did this task's work land" was "no idea". The receipt is the durable record, and the projection
 * below is what makes the existing columns stop lying.
 */
@Injectable()
export class MergeReceiptService {
  private readonly logger = new Logger(MergeReceiptService.name);

  constructor(
    private prisma: PrismaService,
    /**
     * The completion-input doors a committed receipt has to knock on, and the whole of why this
     * class has a second constructor parameter.
     *
     * WHY IT IS INJECTED HERE AND NOT REACHED FROM THE THREE CALL SITES
     * ================================================================
     * There are three writers of a merge receipt — the user API, the agent door, and the runner's
     * own merge-result — and until this parameter existed not one of them delivered anything. The
     * only driver of `routeSettledProjects` / `routeReadyCriteria` / `routeUnlandedCriteria` was a
     * TASK write (`TasksService.deliverProjectFactsOfTask`), so the order this repository actually
     * runs in — last task settles, judgment session opens, it merges and records the receipt, and
     * then nothing writes a task again — left the facts a receipt moves derived by nobody. Putting
     * the knock on the one class all three writers already go through is what makes that a single
     * answer rather than three that can drift.
     *
     * WHY `forwardRef`, AND WHY BOTH MODULES CARRY ONE
     * ===============================================
     * `CoordinatorJudgmentModule` imports `SessionsModule`, because the router's producers reach
     * `SessionsService` to open a judgment session and to write a turn on the standing
     * conversation. Injecting the router back into a SessionsModule provider closes that ring, so
     * both sides declare it with `forwardRef` and Nest resolves the pair after both are defined.
     *
     * The alternative shapes were considered and are worse. Wiring only the two RUNNER controllers
     * (they see `CompletionInputRouter` already, through `ProjectsModule`'s re-export, with no ring
     * at all) leaves the user's own `POST /sessions/:id/merge-receipts` — the door a person clicks
     * — driving nothing, because `SessionsController` is a SessionsModule controller and needs the
     * very same `forwardRef` to see the router. And a small provider owned by neither module cannot
     * exist: everything that reaches these doors reaches `SessionsService` through them, so such a
     * provider would be a second name for this same ring rather than a way out of it.
     *
     * `@Optional()`, and last in the signature, for the pg fixtures that construct this service
     * directly over one client. A fixture that wires no router is a fixture about the receipt row,
     * and `deliverProjectFactsAfterCommit` below is a no-op for it — the same shape, and for the
     * same reason, as `TasksService`'s own optional router.
     */
    @Optional()
    @Inject(forwardRef(() => CompletionInputRouter))
    private readonly completionInputs?: CompletionInputRouter,
    /**
     * The work a committed landing releases (contract §2.5 J10), for a caller that hands it over.
     *
     * A dependency waits for its prerequisite to be ON the project's integration line, not merely
     * DONE (§2.5 J9), so the receipt that records the landing is the fact that makes a dependent
     * runnable — and until this existed, nothing derived anything from it: the DONE edge had
     * already run and found the predicate unsatisfied, and the next automatic look was the
     * 60-second sweep.
     *
     * Typed structurally and resolved through `ModuleRef` below rather than injected as
     * `TasksService`, because the declarative form costs more than it is worth here: SessionsModule
     * would have to import TasksModule, which closes a ring through CoordinatorJudgmentModule and —
     * the part that actually bites — makes every consumer of SessionsModule instantiate TasksModule
     * and PushModule as well. A pg fixture passes its own dispatcher here; nothing else does.
     */
    @Optional()
    private readonly tasks?: LandingDispatcher,
    /**
     * How the running server finds `TasksService` without this module importing TasksModule.
     * Always available, needs no import, and resolved at CALL time — by which point every module
     * is loaded, so the lookup cannot see a half-built graph.
     */
    @Optional()
    private readonly moduleRef?: ModuleRef,
  ) {}

  /** The dispatcher this receipt should release work through, or nothing if there is none. */
  private landingDispatcher(): LandingDispatcher | undefined {
    if (this.tasks) return this.tasks;
    try {
      return this.moduleRef?.get(TasksService, { strict: false });
    } catch {
      // No TasksService in this application context — a fixture, or a process that does not run
      // tasks. The receipt is still recorded; nothing downstream of it is waiting here.
      return undefined;
    }
  }

  /**
   * Deliver the project facts one COMMITTED merge receipt may have moved.
   *
   * AFTER THE COMMIT, for the two reasons `TasksService.deliverSettledProjects` gives about its own
   * position: each fact's version is a digest of rows that actually committed, so deriving it from
   * inside the transaction would key it on a world no reader can see; and a delivery may open a
   * judgment session or write a turn, which is heavy enough to queue a runner and is not something
   * a receipt write may hold a row lock across.
   *
   * ALL THREE DOORS, and the same generosity the task write path shows. A receipt is exactly what
   * `CRITERION_UNLANDED` is defined over and exactly the last missing input of
   * `PROJECT_ACCEPTANCE_LANDED`, so those two are the point. `CRITERION_READY` is knocked beside
   * them rather than skipped because deciding here that a receipt cannot have moved it would be
   * this door holding an opinion about a predicate that belongs to that producer — and because a
   * readiness delivery that an earlier task write logged and swallowed is re-derived from the same
   * rows by whoever knocks next. Which is what this is.
   *
   * Nothing is decided here and no project is filtered out: the producers re-read the committed
   * rows and answer for themselves, exactly as they do for the task write path.
   *
   * A failed delivery is LOGGED, never raised. The receipt is already committed and is not undone
   * by a wake that could not be recorded — an exception here would turn "the coordinator was
   * briefly unreachable" into "your merge was not recorded", which is the one outcome this table
   * exists to prevent. The same fact is re-derived from the same rows by the next delivery.
   *
   * AND THE PROJECTION, WHICH IS THE FOURTH THING THIS EDGE DOES
   * ===========================================================
   * `project.status` is derived rather than written: every stated criterion satisfied AND landed,
   * plus an owner's confirmation naming the version of the criteria that stands
   * (`projects/project-done-derived.ts`). A merge receipt is the whole of the landing half, so this
   * edge re-projects it exactly as `TasksService.deliverSettledProjects` re-projects it on the task
   * write path — the same function, not a second opinion about what DONE means.
   *
   * Until it did, the hole was narrow and real: an owner who confirmed the criteria BEFORE the last
   * branch landed was left with a column asserting OPEN until a task write or a second confirmation
   * happened along, which in the order this repository runs in is "until something unrelated
   * happens". `project-done-derived.pg.spec.ts` case (5) is what holds this to it — it records the
   * last receipt through `record` and then touches nothing else at all.
   *
   * LAST, and logged like its siblings. It is a read of committed rows followed by a compare-and-
   * set, so a delivery that failed above does not make it wrong; and a projection that could not be
   * stored must no more un-record a merge than a wake that could not be delivered.
   */
  async deliverProjectFactsAfterCommit(
    projectId: string | null | undefined,
    landedTaskId?: string | null,
  ): Promise<void> {
    if (!projectId) return;
    await this.deliverCompletionInputs(projectId);
    // LAST, and outside the router's own guard: this one is not a delivery to a coordinator, it is
    // the platform starting the next task (§2.5 J10). A receipt that could not be announced to
    // anybody still landed the work that the tasks downstream of it were waiting for.
    const undecided = await this.dispatchWhatThisLandingReleased(landedTaskId);
    // And what the dispatch just skipped on purpose: a released dependent that does not start by
    // itself (`autoRunWhenReady = false`) is a decision for the coordinator, and this receipt is the
    // fact that puts it there. Last, so the facts above reach a coordinator in the order they always
    // did; logged and never raised, like every other knock on this edge.
    if (undecided.length > 0) {
      await this.completionInputs?.routeReadyDependents(undecided).catch((e) =>
        this.logger.warn(`ready-dependent delivery failed after a merge receipt: ${e?.message ?? e}`),
      );
    }
  }

  /** The three completion-input doors and the DONE projection, unchanged. */
  private async deliverCompletionInputs(projectId: string): Promise<void> {
    if (!this.completionInputs) return;
    const projectIds = [projectId];
    await this.completionInputs.routeSettledProjects(projectIds).catch((e) =>
      this.logger.warn(`settled-project delivery failed after a merge receipt: ${e?.message ?? e}`),
    );
    await this.completionInputs.routeReadyCriteria(projectIds).catch((e) =>
      this.logger.warn(`ready-criterion delivery failed after a merge receipt: ${e?.message ?? e}`),
    );
    await this.completionInputs.routeUnlandedCriteria(projectIds).catch((e) =>
      this.logger.warn(`unlanded-criterion delivery failed after a merge receipt: ${e?.message ?? e}`),
    );
    await this.reprojectProjectStatus(projectId);
  }

  /**
   * Start the work this landing released (§2.5 J10).
   *
   * The owner comes from the TASK rather than from the receipt: a receipt's `ownerId` is provenance
   * about who recorded the merge, and what is being dispatched here is the tenant's own work — the
   * same distinction `reprojectProjectStatus` makes when it reads the project's owner instead.
   *
   * Logged and never raised, like everything else on this edge. The receipt is committed, the
   * predicate that reads it is the same one the 60-second sweep reads, and a dispatch that failed
   * is re-derived from the same rows there.
   *
   * Answers with the released dependents it left for a decision, and with nothing when there was
   * no dispatch to ask.
   */
  private async dispatchWhatThisLandingReleased(landedTaskId?: string | null): Promise<string[]> {
    const tasks = this.landingDispatcher();
    if (!tasks || !landedTaskId) return [];
    const task = await this.prisma.task.findUnique({
      where: { id: landedTaskId },
      select: { ownerId: true },
    }).catch(() => null);
    if (!task) return [];
    return tasks.dispatchDependentsOf(task.ownerId, landedTaskId).catch((e) => {
      this.logger.warn(`dependents of a landed task were not dispatched: ${e?.message ?? e}`);
      return [];
    });
  }

  /**
   * Store what `project.status` projects from the rows this receipt is now part of.
   *
   * `TasksService.reprojectProjectStatus`, over one project instead of many: the owner is read from
   * the project row rather than taken from the receipt, because the projection is scoped to the
   * tenant whose project it is and a receipt's own `ownerId` is provenance about who recorded it.
   * A project that has been deleted between the commit and this line simply has nothing to project.
   *
   * Behind the same `completionInputs` check as the doors above, for the reason the constructor
   * gives: a fixture that wires no router is a fixture about the receipt row, and a read it never
   * asked for would be a query its doubles have to answer.
   */
  private async reprojectProjectStatus(projectId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { ownerId: true },
    }).catch(() => null);
    if (!project) return;
    await storeDerivedProjectStatus(this.prisma, project.ownerId, projectId).catch((e) =>
      this.logger.warn(`derived project status not reconciled after a merge receipt: ${e?.message ?? e}`),
    );
  }

  /**
   * Record one merge. Idempotent by MR4's key: the same merge reported twice returns the FIRST
   * receipt with `created: false`, so a retrying caller (or two callers racing) leaves one row.
   *
   * `recordedBy` is provenance and is chosen by the caller's own boundary — an agent cannot claim
   * to be the runner, because the parameter is not in the request body.
   */
  async record(
    ownerId: string,
    sessionId: string,
    input: RecordMergeReceiptInput,
    recordedBy: MergeReceiptRecorder,
    tx?: Prisma.TransactionClient,
  ): Promise<{ receipt: ReturnType<typeof mergeReceiptRow>; created: boolean }> {
    const run = async (db: Prisma.TransactionClient) => {
      const session = await db.session.findFirst({
        where: { id: sessionId, ownerId },
        select: { id: true, branch: true, taskId: true, mergeStatus: true, task: { select: { projectId: true } } },
      });
      if (!session) throw new NotFoundException('session not found');

      const sourceBranch = (input.sourceBranch ?? session.branch ?? '').trim();
      const targetBranch = (input.targetBranch ?? '').trim();
      if (sourceBranch === '') {
        throw new BadRequestException(
          'sourceBranch is required — this session has no recorded branch to fall back to',
        );
      }
      if (targetBranch === '') throw new BadRequestException('targetBranch is required');

      let sourceSha: string | null;
      let targetShaBefore: string | null;
      let targetShaAfter: string | null;
      let rebaseBaseSha: string | null;
      try {
        sourceSha = normalizeSha(input.sourceSha, 'sourceSha');
        targetShaBefore = normalizeSha(input.targetShaBefore, 'targetShaBefore');
        targetShaAfter = normalizeSha(input.targetShaAfter, 'targetShaAfter');
        rebaseBaseSha = normalizeSha(input.rebaseBaseSha, 'rebaseBaseSha');
      } catch (e) {
        throw new BadRequestException((e as Error).message);
      }
      if (!sourceSha) throw new BadRequestException('sourceSha is required');
      // The database says this too (0128's merged_target_check); said here as well so the caller
      // gets the reason rather than a constraint name.
      if (input.result === 'MERGED' && !targetShaAfter) {
        throw new BadRequestException(
          'a MERGED receipt must name targetShaAfter — a merge that cannot say where the target ' +
            'ended up is a claim, not a receipt',
        );
      }
      const conflicts =
        input.result === 'CONFLICT'
          ? (input.conflicts ?? []).map((p) => String(p)).slice(0, MERGE_RECEIPT_MAX_CONFLICTS)
          : [];

      // `[K6]` §7 CP3, for a caller that CLAIMS the work landed.
      //
      // Only a landed claim is gated. A `CONFLICT` or an `ERROR` about a commit that should never
      // have been merged is still the truth about an attempt somebody made, and refusing to record
      // it would delete the audit of the very thing this gate exists to prevent — which is also why
      // an older CONFLICT receipt is never rewritten when the merge later succeeds: the two are
      // separate rows about separate events.
      if (resultLanded(input.result)) {
        const gate = await checkpointLandingGate(db, {
          ownerId,
          taskId: session.taskId,
          sourceSha,
          evidenceDigest: input.evidenceDigest ?? null,
        });
        if (gate && gate.decision !== 'ALLOWED') {
          throw new ConflictException(`${gate.decision}: ${gate.detail}`);
        }
      }

      const checkpointId = await checkpointIdForCommit(db, {
        ownerId,
        taskId: session.taskId,
        commitSha: sourceSha,
      });

      // CP4: keyed on the CHECKPOINT when there is one, and the caller does not get a vote.
      //
      // MR4's key is scoped to a session, which makes a redelivery from the same session a no-op
      // and is the right answer for a merge nobody planned. It is the wrong answer for verified
      // work: a checkpoint outlives the session that produced it, so the same landing re-reported
      // by a takeover, by a recovery on another runner, or by the retry of a request whose response
      // was lost mints a SECOND receipt for one landing. `result` stays in both keys — a conflict
      // and a successful merge of one checkpoint are two things that happened, not one reported
      // twice.
      //
      // The caller's own key is OVERRIDDEN here rather than preferred, and that is the whole of
      // "exactly once" across the two doors. A supplied key says "these two reports are the same
      // report"; a checkpoint says the same thing more strongly, across sessions and across
      // processes. Letting the weaker claim win is not a tie broken politely — the runner's door
      // derives the checkpoint key unconditionally, so one caller key on the agent's door is a
      // SECOND row in the unique index for one landing, which is the exact defect CP4 exists to
      // prevent. Nothing is lost: what the caller asked for is kept on the receipt's `detail`, and
      // the key it actually got comes back on the row.
      const callerKey = (input.idempotencyKey ?? '').trim();
      const idempotencyKey = checkpointId
        ? checkpointMergeReceiptKey({ checkpointId, targetBranch, result: input.result })
        : callerKey ||
          mergeReceiptIdempotencyKey({ sessionId, sourceSha, targetBranch, result: input.result });
      const overriddenKey = checkpointId && callerKey && callerKey !== idempotencyKey ? callerKey : null;

      // Looked up by whichever identity this receipt HAS. Reading by session when the row is keyed
      // by checkpoint would miss the receipt a different session already wrote, and the insert
      // below would then lose to the partial unique index instead of returning the original — a
      // 500 where the correct answer is "yes, that already landed".
      const existing = await db.sessionMergeReceipt.findFirst({
        where: checkpointId ? { checkpointId, idempotencyKey } : { sessionId, idempotencyKey },
      });
      if (existing) {
        return { receipt: mergeReceiptRow(existing as unknown as MergeReceiptRow), created: false };
      }

      const created = await db.sessionMergeReceipt.create({
        data: {
          ownerId,
          sessionId,
          taskId: session.taskId,
          checkpointId,
          // Denormalised from the task at write time so a project's acceptance read is one indexed
          // lookup and stays answerable after the task is re-filed or deleted.
          projectId: session.task?.projectId ?? null,
          result: input.result,
          sourceBranch,
          sourceSha,
          targetBranch,
          targetShaBefore,
          targetShaAfter,
          rebaseBaseSha,
          conflicts,
          recordedBy,
          detail: {
            ...(input.detail ?? {}),
            // Kept rather than dropped: an audit asking why this row is not under the key the
            // caller asked for gets the answer on the row instead of having to infer it.
            ...(overriddenKey ? { callerIdempotencyKey: overriddenKey } : {}),
          } as Prisma.InputJsonValue,
          idempotencyKey,
        },
      });

      // Make the columns every client already reads stop being blank (MR5).
      //
      // Skipped while an Orbit merge is in flight: `pending` carries the operation fence the
      // runner echoes back, and overwriting it here would let a receipt cancel a merge that is
      // still running. The receipt is recorded either way — the durable half never depends on
      // whether the transient half could be updated.
      if (session.mergeStatus !== 'pending') {
        const landed = resultLanded(input.result);
        await db.session.update({
          where: { id: sessionId },
          data: {
            mergeStatus: mergeStatusForResult(input.result),
            mergeTarget: targetBranch,
            mergeError: landed ? null : (MergeReceiptService.errorText(input) ?? null),
            mergedAt: landed ? created.createdAt : null,
            ...(landed ? { branchMerged: true, mergedSourceSha: sourceSha } : {}),
          },
        });
      }

      return { receipt: mergeReceiptRow(created as unknown as MergeReceiptRow), created: true };
    };

    // A caller holding its own transaction owns the commit, and therefore owns the delivery too.
    // Knocking here would read a world this receipt is not yet part of and derive the facts
    // WITHOUT it — worse than not knocking, because it would spend each key on the old answer.
    // `deliverProjectFactsAfterCommit` is public for exactly that caller to call once it commits;
    // `runner-api.controller.ts`'s merge-result is the one that does.
    if (tx) return run(tx);
    // Retried whole, but only on the branch that OWNS the transaction. When a caller passes `tx`
    // this is part of THEIR unit of work and theirs to re-run — a nested retry would re-run a
    // closure inside a transaction the server has already thrown away. The receipt is keyed by
    // `idempotencyKey`, computed above and outside, so every attempt writes the same row.
    const recorded = await withTransactionRetry(
      this.prisma, run, loggedRetry(this.logger, 'sessionMergeReceipt.record'));
    // The project the receipt was denormalised onto, which is `session.task.projectId` read under
    // the same transaction that wrote the row. Delivered for a redelivery (`created: false`) as
    // well as for a new row: an idempotent replay is exactly the state a caller retrying a request
    // whose response was lost is in, and the first attempt's delivery is the one that may have been
    // lost with it. Re-deriving a fact nothing has moved answers ALREADY_AWAKE and costs a read.
    await this.deliverProjectFactsAfterCommit(recorded.receipt.projectId, recorded.receipt.taskId);
    return recorded;
  }

  /** One session's receipts, newest first. */
  async list(ownerId: string, sessionId: string, limit = 50) {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, ownerId },
      select: { id: true },
    });
    if (!session) throw new NotFoundException('session not found');
    const rows = await this.prisma.sessionMergeReceipt.findMany({
      where: { sessionId, ownerId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(limit, 1), 200),
    });
    return {
      sessionId,
      receipts: rows.map((r) => mergeReceiptRow(r as unknown as MergeReceiptRow)),
      receiptsEmptyReason: rows.length > 0 ? null : ('NO_MERGE_RECORDED' as const),
    };
  }

  /** A receipt for a runner-reported merge outcome, written from inside the runner's own
   *  transaction so a recorded merge and the session state it produced commit together. */
  static async fromRunnerMergeResult(
    tx: Prisma.TransactionClient,
    args: {
      ownerId: string;
      sessionId: string;
      taskId: string | null;
      projectId: string | null;
      result: MergeReceiptResult;
      sourceBranch: string;
      sourceSha: string;
      targetBranch: string;
      targetShaBefore: string | null;
      targetShaAfter: string | null;
      rebaseBaseSha: string | null;
      conflicts: string[];
      message: string | null;
      operationId: string | null;
      /** `[K6]` CP4: the §7 checkpoint this landing is about, when the work has one. */
      checkpointId?: string | null;
    },
  ): Promise<void> {
    // CP4: the same identity the other door derives. Both doors report the same landings — the
    // runner's own merge and an agent recording one it made itself — so a key that differed between
    // them would put two rows in the table for one merge, which is the exact thing MR4 exists to
    // stop and which `[K6]` widened from "one session" to "one checkpoint".
    const idempotencyKey = args.checkpointId
      ? checkpointMergeReceiptKey({
          checkpointId: args.checkpointId,
          targetBranch: args.targetBranch,
          result: args.result,
        })
      : mergeReceiptIdempotencyKey({
          sessionId: args.sessionId,
          sourceSha: args.sourceSha,
          targetBranch: args.targetBranch,
          result: args.result,
        });
    // createMany + skipDuplicates rather than a find-then-create: the runner retries a merge result
    // on redelivery, and the unique index is the thing that has to decide, not a read that raced.
    await tx.sessionMergeReceipt.createMany({
      data: [
        {
          ownerId: args.ownerId,
          sessionId: args.sessionId,
          taskId: args.taskId,
          projectId: args.projectId,
          result: args.result,
          sourceBranch: args.sourceBranch,
          sourceSha: args.sourceSha,
          targetBranch: args.targetBranch,
          targetShaBefore: args.targetShaBefore,
          targetShaAfter: args.targetShaAfter,
          rebaseBaseSha: args.rebaseBaseSha,
          // 0128 refuses paths on any non-CONFLICT result: a merge that succeeded has none, and a
          // list attached to one would be a leftover from the attempt before it.
          conflicts: args.result === 'CONFLICT'
            ? args.conflicts.slice(0, MERGE_RECEIPT_MAX_CONFLICTS)
            : [],
          recordedBy: 'RUNNER',
          detail: {
            source: 'merge-result',
            ...(args.message ? { message: args.message } : {}),
            ...(args.operationId ? { operationId: args.operationId } : {}),
          } as Prisma.InputJsonValue,
          idempotencyKey,
          checkpointId: args.checkpointId ?? null,
        },
      ],
      skipDuplicates: true,
    });
  }

  /**
   * The receipt for a landing the PLATFORM made (contract §2.5 J8).
   *
   * A third door beside the runner's own merge and the agent's own record, and the only one whose
   * caller can say what tree it verified: the job row carries `testedTreeSha` and `landedTreeSha`,
   * the database refuses a LANDED row where they differ (J2), and both are written into `detail` so
   * a reader of the receipt can re-check that claim without joining back to the job.
   *
   * Returns the receipt ids — the job row keeps them, so "what did this job write" is a column
   * rather than a key somebody has to re-derive.
   */
  static async fromIntegrationJob(
    tx: Prisma.TransactionClient,
    args: {
      ownerId: string;
      sessionId: string;
      taskId: string | null;
      projectId: string | null;
      jobId: string;
      /**
       * `NOTHING_TO_LAND` is the line's answer that the branch it was handed carried nothing of the
       * task's (0300). It is recorded as `ALREADY_MERGED` — nothing moved, and a `target_sha_after`
       * here would claim it did — and it is written by the caller only when the task has no branch
       * with reported work of its own: the receipt is what §2.5 J9 releases dependents on.
       */
      state: 'LANDED' | 'ALREADY_LANDED' | 'NOTHING_TO_LAND';
      sourceBranch: string;
      targetBranch: string;
      sourceSha: string | null;
      targetShaBefore: string | null;
      landedSha: string | null;
      rebaseBaseSha: string | null;
      testedTreeSha: string | null;
      landedTreeSha: string | null;
      mainSyncSha: string | null;
      /** A merge into the upstream nobody pressed: the project's Automatic setting confirmed it
       *  (integration contract §3.3 M-T11). Written into the receipt's `detail` so the ledger itself
       *  says which merges a person made and which the platform made on its own. */
      confirmedAutomatically?: boolean;
    },
  ): Promise<string[]> {
    const sourceSha = normalizeSha(args.sourceSha, 'sourceSha');
    if (!sourceSha) throw new BadRequestException('an integration receipt needs the source SHA');
    const result: MergeReceiptResult = args.state === 'LANDED' ? 'MERGED' : 'ALREADY_MERGED';
    // ALREADY_MERGED names no `targetShaAfter`: nothing moved, and a SHA here would claim it did.
    const targetShaAfter = result === 'MERGED' ? normalizeSha(args.landedSha, 'landedSha') : null;
    if (result === 'MERGED' && !targetShaAfter) {
      throw new BadRequestException('a landed integration must name where the target ended up');
    }
    const created = await tx.sessionMergeReceipt.createManyAndReturn({
      data: [{
        ownerId: args.ownerId,
        sessionId: args.sessionId,
        taskId: args.taskId,
        projectId: args.projectId,
        result,
        sourceBranch: args.sourceBranch,
        sourceSha,
        targetBranch: args.targetBranch,
        targetShaBefore: normalizeSha(args.targetShaBefore, 'targetShaBefore'),
        targetShaAfter,
        rebaseBaseSha: normalizeSha(args.rebaseBaseSha, 'rebaseBaseSha'),
        conflicts: [],
        recordedBy: 'RUNNER',
        detail: {
          source: 'integration-job',
          integrationJobId: args.jobId,
          ...(args.testedTreeSha ? { testedTreeSha: args.testedTreeSha } : {}),
          ...(args.landedTreeSha ? { landedTreeSha: args.landedTreeSha } : {}),
          ...(args.mainSyncSha ? { mainSyncSha: args.mainSyncSha } : {}),
          ...(args.confirmedAutomatically ? { confirmedAutomatically: true } : {}),
        } as Prisma.InputJsonValue,
        idempotencyKey: mergeReceiptIdempotencyKey({
          sessionId: args.sessionId,
          sourceSha,
          targetBranch: args.targetBranch,
          result,
        }),
      }],
      skipDuplicates: true,
      select: { id: true },
    });
    return created.map((row) => row.id);
  }

  private static errorText(input: RecordMergeReceiptInput): string | null {
    const detail = input.detail ?? {};
    const message = (detail as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim() !== '') return message;
    if (input.result === 'CONFLICT' && (input.conflicts ?? []).length > 0) {
      return `conflict in ${(input.conflicts ?? []).length} path(s)`;
    }
    return null;
  }

}
