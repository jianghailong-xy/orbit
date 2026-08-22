import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  AttemptBudget,
  ConvergenceAutomationPolicy,
  ConvergenceCounters,
  ConvergenceDispatchRefusal,
  ConvergenceThresholds,
  ScopeAuthorization,
  TaskProgressState,
  ZERO_COUNTERS,
  isDispatchableProgressState,
  resolveAttemptBudget,
  resolveThresholds,
} from './convergence-contract';
import { ProgressVector, convergenceDispatchRefusal } from './convergence-progress';
import {
  ConvergenceLedgerEntry,
  ConvergenceObservation,
  PlannedConvergenceDecision,
  ScopeRevisionProposal,
  convergenceDecisionKey,
  planConvergenceDecision,
  planScopeRevision,
  recoverConvergenceState,
  scopeHash,
} from './convergence-ledger';

/**
 * `[K2]`: the ledger, written down.
 *
 * Three things happen here and nowhere else, and each of them is the durable half of a rule `[K1]`
 * could only state:
 *
 *  - **A judgment is committed once.** `record` is keyed on the FACT's identity, so a redelivered
 *    or out-of-order event reads the row it already wrote instead of writing a second one and
 *    charging the budget twice (AC1).
 *  - **A scope change is a signed row.** `reviseScope` refuses an unauthorized actor and keeps
 *    every superseded revision, so "what was this task asking for when those attempts were spent"
 *    stays answerable (AC2).
 *  - **The state survives the process.** Everything a decision reads is a committed column or a
 *    committed row, so a crash or a takeover resumes from the ledger rather than from zero (AC4).
 *
 * The service is not the enforcement. Migration 0138 refuses the same things at the database,
 * because the writer that breaks an invariant is by definition the one that did not come through
 * here.
 */
@Injectable()
export class ConvergenceLedgerService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Put a task under convergence management, idempotently.
   *
   * A task is managed exactly when it has a `task_scope_revision` row, and this is what writes the
   * first one — freezing what the task asks for AT THE MOMENT the control loop first judges it,
   * which is the first moment freezing means anything. Everything filed before `[K2]` therefore
   * behaves exactly as it did (project AC11): no revision row, no freeze, no fence.
   *
   * The baseline is unsigned (`authorized_by_actor` NULL). That is honest rather than convenient:
   * revision 1 is the task's original statement of scope, and nobody revised it into being. Only
   * revisions 2 and up name a signatory, which is precisely where §1's authority table applies.
   */
  async ensureBaseline(
    tx: Prisma.TransactionClient,
    taskId: string,
    ownerId: string,
  ): Promise<{ scopeRevision: number; scopeHash: string }> {
    const [task] = await tx.$queryRaw<Array<{
      title: string;
      description: string | null;
      acceptanceCriteria: string | null;
      scopeRevision: number;
    }>>(Prisma.sql`
      SELECT "title", "description", "acceptance_criteria" AS "acceptanceCriteria",
             "scope_revision" AS "scopeRevision"
        FROM "task" WHERE "id" = ${taskId}::uuid AND "owner_id" = ${ownerId}::uuid
    `);
    if (!task) throw new NotFoundException('task not found');

    const [existing] = await tx.$queryRaw<Array<{ revision: number; scopeHash: string }>>(Prisma.sql`
      SELECT "revision", "scope_hash" AS "scopeHash" FROM "task_scope_revision"
       WHERE "task_id" = ${taskId}::uuid AND "revision" = ${task.scopeRevision}
    `);
    if (existing) return { scopeRevision: existing.revision, scopeHash: existing.scopeHash };

    const hash = scopeHash(task);
    // ON CONFLICT rather than a second read: two passes may reach an unmanaged task at once, and
    // the loser has to end up with the winner's baseline, not with an exception.
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "task_scope_revision" (
        "id", "task_id", "owner_id", "revision", "scope_hash",
        "title", "description", "acceptance_criteria", "reason"
      ) VALUES (
        ${randomUUID()}::uuid, ${taskId}::uuid, ${ownerId}::uuid, ${task.scopeRevision}, ${hash},
        ${task.title}, ${task.description}, ${task.acceptanceCriteria},
        'baseline recorded when the task entered convergence management'
      )
      ON CONFLICT ("task_id", "revision") DO NOTHING
    `);
    const [settled] = await tx.$queryRaw<Array<{ revision: number; scopeHash: string }>>(Prisma.sql`
      SELECT "revision", "scope_hash" AS "scopeHash" FROM "task_scope_revision"
       WHERE "task_id" = ${taskId}::uuid AND "revision" = ${task.scopeRevision}
    `);
    if (!settled) throw new Error('failed to record the task scope baseline');
    return { scopeRevision: settled.revision, scopeHash: settled.scopeHash };
  }

  /**
   * Commit one coordination judgment.
   *
   * The order inside the transaction is load-bearing:
   *
   *  1. lock the task row, which serialises every writer on this task and makes step 2 a decision
   *     rather than a guess;
   *  2. look the idempotency key up FIRST. A redelivery returns the committed row having written
   *     nothing — not even the attempt generation, which an `ATTEMPT_STARTED` would otherwise
   *     allocate a second time before discovering the conflict;
   *  3. plan against the committed state;
   *  4. move the task columns, THEN insert the row. That way round because the database's staleness
   *     fence checks the row against the task's current revision and generation, and an
   *     `ATTEMPT_STARTED` writes the generation it just allocated.
   */
  async record(
    tx: Prisma.TransactionClient,
    taskId: string,
    ownerId: string,
    observation: ConvergenceObservation,
  ): Promise<{ decision: PlannedConvergenceDecision | null; id: string; duplicate: boolean }> {
    const state = await this.lockAndRead(tx, taskId, ownerId);
    // Judging a task is what puts it under management, so the baseline is written here rather than
    // left as a precondition a caller can forget: without the revision row the ledger's composite
    // foreign key has nothing to point at, and the failure would surface as a constraint violation
    // rather than as "you did not open this task's ledger". `state.scopeHash` is already the value
    // this writes — both sides call `scopeHash` on the same three columns — so no re-read is owed.
    if (!state.managed) await this.ensureBaseline(tx, taskId, ownerId);

    const key = convergenceDecisionKey(taskId, state.scopeRevision, observation.observationKey);
    const [duplicate] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "task_convergence_decision" WHERE "idempotency_key" = ${key}
    `);
    if (duplicate) return { decision: null, id: duplicate.id, duplicate: true };

    const planned = planConvergenceDecision(
      taskId,
      { ...state, sameActionPriorCount: await this.sameActionPriorCount(tx, taskId, state, observation) },
      observation,
      state.thresholds,
    );
    const id = randomUUID();

    await tx.$executeRaw(Prisma.sql`
      UPDATE "task"
         SET "attempt_generation" = ${BigInt(planned.taskState.attemptGeneration)},
             "progress_state" = ${planned.taskState.progressState},
             "convergence_counters" = ${JSON.stringify(planned.taskState.counters)}::jsonb,
             "last_progress_at" = ${planned.taskState.lastProgressAt},
             "known_good_sha" = ${planned.taskState.knownGoodSha},
             -- The wall clock, not the observation time: a redelivery processed late must not drag
             -- a task updated_at backwards past writes that really did come after it.
             "updated_at" = CURRENT_TIMESTAMP
       WHERE "id" = ${taskId}::uuid AND "owner_id" = ${ownerId}::uuid
    `);

    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "task_convergence_decision" (
        "id", "task_id", "owner_id", "seq", "scope_revision", "scope_hash", "attempt_generation",
        "idempotency_key", "input_hash", "input", "event", "from_state", "to_state",
        "classification", "decision", "action", "action_idempotency_key", "failure_fingerprint",
        "action_identity", "hypothesis_identity", "evidence_freshness", "evidence_as_of",
        "progress_vector", "progress_vector_digest", "progressed", "counters",
        "non_convergence_reason", "known_good_sha", "required_action", "owner", "next_check_at",
        "decided_by", "session_id", "project_decision_id", "created_at"
      ) VALUES (
        ${id}::uuid, ${taskId}::uuid, ${ownerId}::uuid, ${state.nextSeq},
        ${planned.scopeRevision}, ${planned.scopeHash}, ${BigInt(planned.attemptGeneration)},
        ${key}, ${planned.inputHash}, ${JSON.stringify(planned.input)}::jsonb,
        ${planned.event}, ${planned.fromState}, ${planned.toState},
        ${planned.classification}, ${planned.decision}, ${planned.action},
        ${planned.actionIdempotencyKey}, ${planned.failureFingerprint},
        ${planned.actionIdentity}, ${planned.hypothesisIdentity},
        ${planned.evidenceFreshness}, ${planned.evidenceAsOf},
        ${JSON.stringify(planned.progressVector)}::jsonb, ${planned.progressVectorDigest},
        ${planned.progressed}, ${JSON.stringify(planned.counters)}::jsonb,
        ${planned.nonConvergenceReason}, ${planned.knownGoodSha},
        ${planned.requiredAction}, ${planned.owner}, ${planned.nextCheckAt},
        ${observation.decidedBy}, ${observation.sessionId ?? null}::uuid,
        ${observation.projectDecisionId ?? null}::uuid, ${observation.observedAt}
      )
    `);

    return { decision: planned, id, duplicate: false };
  }

  /**
   * §1: revise what a task is asking for, with somebody's name on it.
   *
   * Two writes, in this order and in one transaction: the new revision row first, then the task.
   * The database's freeze guard reads the revision row to check the task is being changed to
   * exactly what was recorded, so the row has to exist before the update it authorizes — and an
   * update that is rolled back leaves no revision claiming to have authorized it.
   *
   * A new revision is a new budget (§4 PV4's licence, the only one besides strict progress), so the
   * counters reset and the attempt generation restarts. The OLD revision's spend is not erased —
   * it stays in its own row and in every ledger row that names it, which is the audit AC2 asks for.
   */
  async reviseScope(
    ownerId: string,
    taskId: string,
    proposal: ScopeRevisionProposal,
  ): Promise<{ revision: number; scopeHash: string }> {
    return this.prisma.$transaction(async (tx) => {
      const state = await this.lockAndRead(tx, taskId, ownerId);
      const planned = planScopeRevision(state, proposal, state.policy);
      if (typeof planned === 'string') throw new ConflictException(planned);

      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "task_scope_revision" (
          "id", "task_id", "owner_id", "revision", "scope_hash", "title", "description",
          "acceptance_criteria", "authorized_by_actor", "authorized_by_principal",
          "automation_policy", "reason", "supersedes_revision"
        ) VALUES (
          ${randomUUID()}::uuid, ${taskId}::uuid, ${ownerId}::uuid, ${planned.revision},
          ${planned.scopeHash}, ${planned.title}, ${planned.description},
          ${planned.acceptanceCriteria}, ${planned.actor}, ${planned.principal},
          ${planned.policy}, ${planned.reason}, ${planned.supersedesRevision}
        )
      `);

      await tx.$executeRaw(Prisma.sql`
        UPDATE "task"
           SET "title" = ${planned.title},
               "description" = ${planned.description},
               "acceptance_criteria" = ${planned.acceptanceCriteria},
               "scope_revision" = ${planned.revision},
               "attempt_generation" = 0,
               "progress_state" = 'CONVERGING',
               "convergence_counters" = ${JSON.stringify(planned.counters)}::jsonb,
               "last_progress_at" = NULL,
               "updated_at" = CURRENT_TIMESTAMP
         WHERE "id" = ${taskId}::uuid AND "owner_id" = ${ownerId}::uuid
      `);

      return { revision: planned.revision, scopeHash: planned.scopeHash };
    });
  }

  /**
   * AC4: what the ledger says the task's state is, independent of its columns.
   *
   * Returned beside the columns rather than instead of them, so a caller can compare. They agree
   * on every path this service writes; a disagreement is a writer that went round it, and that is
   * a thing worth being able to see rather than a thing to paper over by trusting one of them.
   */
  async recover(ownerId: string, taskId: string): Promise<{
    scopeRevision: number;
    scopeHash: string;
    fromLedger: ReturnType<typeof recoverConvergenceState>;
    fromColumns: {
      attemptGeneration: number;
      progressState: TaskProgressState;
      counters: ConvergenceCounters;
      lastProgressAt: Date | null;
      knownGoodSha: string | null;
    };
    consistent: boolean;
  }> {
    const state = await this.readState(this.prisma, taskId, ownerId);
    const entries = await this.entries(this.prisma, taskId);
    const fromLedger = recoverConvergenceState(state.scopeRevision, state.scopeHash, entries);
    const fromColumns = {
      attemptGeneration: state.attemptGeneration,
      progressState: state.progressState,
      counters: state.counters,
      lastProgressAt: state.lastProgressAt,
      knownGoodSha: state.knownGoodSha,
    };
    const consistent = fromLedger.attemptGeneration === fromColumns.attemptGeneration
      && fromLedger.progressState === fromColumns.progressState
      && fromLedger.knownGoodSha === fromColumns.knownGoodSha
      && JSON.stringify(fromLedger.counters) === JSON.stringify(fromColumns.counters);
    return { scopeRevision: state.scopeRevision, scopeHash: state.scopeHash, fromLedger, fromColumns, consistent };
  }

  /**
   * The read face (project AC10). Every id leaves as Base62 and every threshold is the RESOLVED
   * one — a caller asking why a task stopped needs the limit that applied, not the override column
   * that may be null because the default applied instead.
   */
  async describe(ownerId: string, taskId: string) {
    const state = await this.readState(this.prisma, taskId, ownerId);
    const revisions = await this.prisma.$queryRaw<Array<{
      revision: number;
      scopeHash: string;
      title: string;
      description: string | null;
      acceptanceCriteria: string | null;
      authorizedByActor: string | null;
      authorizedByPrincipal: string | null;
      automationPolicy: string | null;
      reason: string;
      supersedesRevision: number | null;
      createdAt: Date;
    }>>(Prisma.sql`
      SELECT "revision", "scope_hash" AS "scopeHash", "title", "description",
             "acceptance_criteria" AS "acceptanceCriteria",
             "authorized_by_actor" AS "authorizedByActor",
             "authorized_by_principal" AS "authorizedByPrincipal",
             "automation_policy" AS "automationPolicy", "reason",
             "supersedes_revision" AS "supersedesRevision", "created_at" AS "createdAt"
        FROM "task_scope_revision" WHERE "task_id" = ${taskId}::uuid
       ORDER BY "revision"
    `);

    const ledger = await this.prisma.$queryRaw<Array<LedgerRow>>(Prisma.sql`
      SELECT "id", "seq", "scope_revision" AS "scopeRevision", "scope_hash" AS "scopeHash",
             "attempt_generation" AS "attemptGeneration", "idempotency_key" AS "idempotencyKey",
             "input_hash" AS "inputHash", "event", "from_state" AS "fromState",
             "to_state" AS "toState", "classification", "decision", "action",
             "action_idempotency_key" AS "actionIdempotencyKey",
             "failure_fingerprint" AS "failureFingerprint",
             "action_identity" AS "actionIdentity",
             "hypothesis_identity" AS "hypothesisIdentity",
             "evidence_freshness" AS "evidenceFreshness", "evidence_as_of" AS "evidenceAsOf",
             "progress_vector" AS "progressVector",
             "progress_vector_digest" AS "progressVectorDigest", "progressed", "counters",
             "non_convergence_reason" AS "nonConvergenceReason",
             "known_good_sha" AS "knownGoodSha", "required_action" AS "requiredAction",
             "owner", "next_check_at" AS "nextCheckAt", "decided_by" AS "decidedBy",
             "session_id" AS "sessionId", "project_decision_id" AS "projectDecisionId",
             "created_at" AS "createdAt"
        FROM "task_convergence_decision" WHERE "task_id" = ${taskId}::uuid
       ORDER BY "seq" DESC
       LIMIT 50
    `);

    return {
      taskId: uuidToBase62(taskId),
      managed: state.managed,
      scopeRevision: state.scopeRevision,
      scopeHash: state.scopeHash,
      attemptGeneration: state.attemptGeneration,
      progressState: state.progressState,
      counters: state.counters,
      thresholds: state.thresholds,
      attemptBudget: state.attemptBudget,
      lastProgressAt: state.lastProgressAt,
      knownGoodSha: state.knownGoodSha,
      automationPolicy: state.policy,
      // `authorizedByPrincipal` is free text naming whoever signed, and whoever writes it may well
      // write an id. Publicizing is a no-op on anything that was never one.
      revisions: revisions.map((row) => ({
        ...row,
        authorizedByPrincipal: row.authorizedByPrincipal === null
          ? null
          : publicConvergenceKey(row.authorizedByPrincipal),
      })),
      ledger: ledger.map((row) => ({
        ...row,
        id: uuidToBase62(row.id),
        seq: String(row.seq),
        attemptGeneration: String(row.attemptGeneration),
        // The key embeds the task's UUID, and the interceptor cannot see inside a string — the same
        // reason `publicDedupeKey` exists for a blocker's.
        idempotencyKey: publicConvergenceKey(row.idempotencyKey),
        actionIdempotencyKey: row.actionIdempotencyKey === null
          ? null
          : publicConvergenceKey(row.actionIdempotencyKey),
        sessionId: row.sessionId === null ? null : uuidToBase62(row.sessionId),
        projectDecisionId: row.projectDecisionId === null
          ? null
          : uuidToBase62(row.projectDecisionId),
      })),
    };
  }

  /**
   * §8's repeat line for actions: how many committed decisions in the CURRENT no-progress window
   * already proposed this one.
   *
   * The window is "since the last decision that progressed", not "the previous decision", and the
   * difference is the whole reason this is a query rather than a counter. A consecutive counter is
   * defeated by alternating two actions — A, B, A, B never repeats twice in a row, and the
   * incident's loop had exactly that shape — while a count over the window notices the third A
   * however many Bs are interleaved.
   *
   * Rows of superseded revisions are excluded by the `scope_revision` predicate: after a re-plan
   * the same action is a proposal about a different question (§5 FP3), and charging it against the
   * old revision's repeats would refuse the new revision its first attempt.
   */
  private async sameActionPriorCount(
    tx: Prisma.TransactionClient,
    taskId: string,
    state: { scopeRevision: number },
    observation: ConvergenceObservation,
  ): Promise<number> {
    if (!observation.actionIdentity) return 0;
    const [row] = await tx.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
      SELECT count(*) AS "n"
        FROM "task_convergence_decision"
       WHERE "task_id" = ${taskId}::uuid
         AND "scope_revision" = ${state.scopeRevision}
         AND "action_identity" = ${observation.actionIdentity}
         AND "seq" > coalesce((
               SELECT max("seq") FROM "task_convergence_decision"
                WHERE "task_id" = ${taskId}::uuid
                  AND "scope_revision" = ${state.scopeRevision}
                  AND "progressed"
             ), 0)
    `);
    return Number(row?.n ?? 0n);
  }

  /**
   * §9's gate, read under the task row lock.
   *
   * The lock is the point. A breaker that trips in one transaction while a dispatcher decides in
   * another is not a breaker — both read a world in which the task was still allowed, and the
   * retry the trip was supposed to stop happens anyway. Taking the same `FOR UPDATE` lock the
   * writer takes serialises the two: whichever runs second sees what the first committed.
   *
   * Returns §9's refusal or null, plus what SM2 says about the state, so the caller (`[K7]`) can
   * ask both questions from one read without this method inventing an answer to either.
   */
  async dispatchGate(
    tx: Prisma.TransactionClient,
    taskId: string,
    ownerId: string,
  ): Promise<{
    refusal: ConvergenceDispatchRefusal | null;
    dispatchable: boolean;
    progressState: TaskProgressState;
  }> {
    const state = await this.lockAndRead(tx, taskId, ownerId);
    return {
      refusal: convergenceDispatchRefusal(state, state.thresholds),
      dispatchable: isDispatchableProgressState(state.progressState),
      progressState: state.progressState,
    };
  }

  /**
   * The task's committed convergence state, with the row locked.
   *
   * `FOR UPDATE` on the task and nothing else. It is the whole concurrency story of this service:
   * every write here is about one task, so one row lock serialises them, and `seq` can be allocated
   * as `MAX + 1` without a second writer computing the same one. Nothing takes a lock on `project`
   * — the policy is read, not written — so this adds no edge to the project/task lock order.
   *
   * Public for `[K5]`: a finding is triaged against the same committed state a decision is planned
   * against, so it takes the SAME lock in the SAME transaction and reads the SAME row. Two readers
   * with two spellings of "what does this task currently say" is how a finding comes to be filed
   * against counters the ledger never had.
   */
  async lockAndRead(
    tx: Prisma.TransactionClient,
    taskId: string,
    ownerId: string,
  ): Promise<ReadState & { nextSeq: number }> {
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "task" WHERE "id" = ${taskId}::uuid AND "owner_id" = ${ownerId}::uuid
      FOR UPDATE
    `);
    const state = await this.readState(tx, taskId, ownerId);
    const [seq] = await tx.$queryRaw<Array<{ next: bigint }>>(Prisma.sql`
      SELECT coalesce(max("seq"), 0) + 1 AS "next"
        FROM "task_convergence_decision" WHERE "task_id" = ${taskId}::uuid
    `);
    return { ...state, nextSeq: Number(seq?.next ?? 1n) };
  }

  private async readState(
    tx: Prisma.TransactionClient | PrismaService,
    taskId: string,
    ownerId: string,
  ): Promise<ReadState> {
    const [row] = await tx.$queryRaw<Array<TaskStateRow>>(Prisma.sql`
      SELECT t."scope_revision" AS "scopeRevision",
             t."attempt_generation" AS "attemptGeneration",
             t."progress_state" AS "progressState",
             t."convergence_counters" AS "counters",
             t."last_progress_at" AS "lastProgressAt",
             t."known_good_sha" AS "knownGoodSha",
             t."title", t."description", t."acceptance_criteria" AS "acceptanceCriteria",
             r."scope_hash" AS "scopeHash",
             coalesce(p."automation_policy"::text, 'GUARDED_AUTO') AS "automationPolicy",
             p."convergence_thresholds" AS "thresholdOverrides",
             p."attempt_budget" AS "budgetOverrides",
             p."unbounded_authorized_by" AS "unboundedAuthorizedBy"
        FROM "task" t
        LEFT JOIN "project" p ON p."id" = t."project_id"
        LEFT JOIN "task_scope_revision" r
               ON r."task_id" = t."id" AND r."revision" = t."scope_revision"
       WHERE t."id" = ${taskId}::uuid AND t."owner_id" = ${ownerId}::uuid
    `);
    if (!row) throw new NotFoundException('task not found');

    const last = await this.entries(tx, taskId, 1);
    const previous = last[0];
    const policy = row.automationPolicy as ConvergenceAutomationPolicy;
    const authorization = row.unboundedAuthorizedBy as ScopeAuthorization | null;

    return {
      managed: row.scopeHash !== null,
      scopeRevision: row.scopeRevision,
      // An unmanaged task has no revision row yet; its scope digest is still well defined, and
      // computing it here means `describe` answers for a task the loop has never touched — and
      // that `record` can open the ledger without a second read, because this is the same value
      // `ensureBaseline` is about to write.
      scopeHash: row.scopeHash ?? scopeHash(row),
      attemptGeneration: Number(row.attemptGeneration),
      progressState: row.progressState as TaskProgressState,
      counters: row.counters as unknown as ConvergenceCounters,
      lastProgressAt: row.lastProgressAt,
      knownGoodSha: row.knownGoodSha,
      progressVector: previous?.scopeRevision === row.scopeRevision
        ? previous.progressVector
        : null,
      lastFingerprint: previous?.scopeRevision === row.scopeRevision
        ? previous.failureFingerprint
        : null,
      policy,
      thresholds: resolveThresholds(
        row.thresholdOverrides as Partial<ConvergenceThresholds> | null,
        authorization,
      ),
      attemptBudget: resolveAttemptBudget(
        row.budgetOverrides as Partial<AttemptBudget> | null,
        authorization,
      ),
    };
  }

  private async entries(
    tx: Prisma.TransactionClient | PrismaService,
    taskId: string,
    limit?: number,
  ): Promise<ConvergenceLedgerEntry[]> {
    const rows = await tx.$queryRaw<Array<{
      seq: bigint;
      scopeRevision: number;
      scopeHash: string;
      attemptGeneration: bigint;
      event: string;
      toState: string;
      progressed: boolean;
      counters: unknown;
      progressVector: unknown;
      failureFingerprint: string | null;
      knownGoodSha: string | null;
      createdAt: Date;
    }>>(Prisma.sql`
      SELECT "seq", "scope_revision" AS "scopeRevision", "scope_hash" AS "scopeHash",
             "attempt_generation" AS "attemptGeneration", "event", "to_state" AS "toState",
             "progressed", "counters", "progress_vector" AS "progressVector",
             "failure_fingerprint" AS "failureFingerprint", "known_good_sha" AS "knownGoodSha",
             "created_at" AS "createdAt"
        FROM "task_convergence_decision" WHERE "task_id" = ${taskId}::uuid
       ORDER BY "seq" DESC
       ${limit === undefined ? Prisma.empty : Prisma.sql`LIMIT ${limit}`}
    `);
    return rows.map((row) => ({
      seq: Number(row.seq),
      scopeRevision: row.scopeRevision,
      scopeHash: row.scopeHash,
      attemptGeneration: Number(row.attemptGeneration),
      event: row.event as ConvergenceLedgerEntry['event'],
      toState: row.toState as TaskProgressState,
      progressed: row.progressed,
      counters: row.counters as ConvergenceCounters,
      progressVector: row.progressVector as ProgressVector,
      failureFingerprint: row.failureFingerprint,
      knownGoodSha: row.knownGoodSha,
      createdAt: row.createdAt,
    }));
  }
}

interface ReadState {
  /** Whether this task has a scope revision row — see `ensureBaseline`. */
  managed: boolean;
  scopeRevision: number;
  scopeHash: string;
  attemptGeneration: number;
  progressState: TaskProgressState;
  counters: ConvergenceCounters;
  lastProgressAt: Date | null;
  knownGoodSha: string | null;
  progressVector: ProgressVector | null;
  lastFingerprint: string | null;
  policy: ConvergenceAutomationPolicy;
  thresholds: ConvergenceThresholds;
  attemptBudget: AttemptBudget;
}

interface TaskStateRow {
  scopeRevision: number;
  attemptGeneration: bigint;
  progressState: string;
  counters: unknown;
  lastProgressAt: Date | null;
  knownGoodSha: string | null;
  title: string;
  description: string | null;
  acceptanceCriteria: string | null;
  scopeHash: string | null;
  automationPolicy: string;
  thresholdOverrides: unknown;
  budgetOverrides: unknown;
  unboundedAuthorizedBy: unknown;
}

interface LedgerRow {
  id: string;
  seq: bigint;
  scopeRevision: number;
  scopeHash: string;
  attemptGeneration: bigint;
  idempotencyKey: string;
  inputHash: string;
  event: string;
  fromState: string;
  toState: string;
  classification: string | null;
  decision: string;
  action: string | null;
  actionIdempotencyKey: string | null;
  failureFingerprint: string | null;
  actionIdentity: string | null;
  hypothesisIdentity: string | null;
  evidenceFreshness: string | null;
  evidenceAsOf: Date | null;
  progressVector: unknown;
  progressVectorDigest: string;
  progressed: boolean;
  counters: unknown;
  nonConvergenceReason: string | null;
  knownGoodSha: string | null;
  requiredAction: string | null;
  owner: string | null;
  nextCheckAt: Date | null;
  decidedBy: string;
  sessionId: string | null;
  projectDecisionId: string | null;
  createdAt: Date;
}

/** The Base62 spelling of a machine key, exactly as `publicIdempotencyKey` does for an action's. */
export function publicConvergenceKey(key: string): string {
  return key.replace(UUID_PATTERN, (id) => uuidToBase62(id));
}

const UUID_PATTERN = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

export { ZERO_COUNTERS };
