/**
 * `[K5]`: the one door a finding comes through, and the one transaction its consequence lands in.
 *
 * Everything commits together or not at all — the finding row, `[K2]`'s judgment about it, the
 * counters that judgment moved, and whichever single artifact §3 says the classification produces.
 * That is not tidiness. A finding whose Task did not land is a defect nobody is fixing that the
 * audit says was filed; a Task whose finding did not land is work with no reason attached, and the
 * NEXT finding on the same failure would file it again because FD1's key was never written.
 *
 * Two keys and not one, because they answer different questions:
 *
 *   - `dedupKey` (FD1) is the identity of the FINDING. The same defect reported twice, by a second
 *     check, or after a restart, collides here and the second submission returns the first one's
 *     row having written nothing.
 *   - `effectIdempotencyKey` is the identity of its ONE consequence, and it is also written to
 *     `task.idempotency_key`. It is the second lock, for the case the first cannot see: a
 *     transaction that rolled back after creating the Task but before committing the finding leaves
 *     no dedup row to collide with, and the replay must not file a second Task.
 *
 * What this service deliberately does NOT do is raise the blocker for the two classes whose result
 * is one. §11.4 recomputes conditions from the world every pass, so a blocker DERIVED from the
 * finding row gets its exit for free — it clears when the task settles or the scope revision moves.
 * A row inserted here would outlive the fact it asserts, which is the obsolete-blocker shape `[H1]`
 * had to go back and filter out. The finding records WHICH kind it will raise, atomically, and
 * `findingConditions` reads it.
 */

import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { ConvergenceLedgerService } from './convergence-ledger.service';
import { ConvergenceDecidedBy } from './convergence-ledger';
import { EMPTY_PROGRESS_VECTOR } from './convergence-progress';
import { ScopeActor } from './convergence-contract';
import {
  EFFECT_BLOCKER_KIND,
  FindingAddress,
  FindingSeverity,
  FindingTriage,
  VerificationFinding,
  decideFinding,
  findingDedupKey,
  findingEffectKey,
} from './verification-finding';

/** Titles are the subject's, prefixed; the column is bounded like every other task title. */
const MAX_TASK_TITLE_CHARS = 200;

export interface SubmitFindingInput {
  ownerId: string;
  /** Internal UUID of the task the finding is ABOUT. */
  subjectTaskId: string;
  finding: VerificationFinding;
  reporter: ScopeActor;
  /** FD4: the revision the reporter measured against. */
  scopeRevision: number;
  /** Historical attribution. Recorded, never dereferenced. */
  reporterTaskId?: string | null;
  reporterSessionId?: string | null;
  decidedBy?: ConvergenceDecidedBy;
  now?: Date;
}

export interface SubmitFindingResult {
  findingId: string;
  /** True when FD1's key already existed: nothing was written, and this is the original. */
  duplicate: boolean;
  triage: FindingTriage;
  /** Base62. Null for the two classes whose result is a blocker, and for `RETRY_WITHIN_BUDGET`. */
  effectTaskId: string | null;
  effectBlockerKind: string | null;
  decisionId: string | null;
}

interface SubjectRow {
  id: string;
  ownerId: string;
  projectId: string | null;
  title: string;
  listId: string | null;
  assigneeId: string | null;
  parentTaskId: string | null;
  scopeRevision: number;
}

@Injectable()
export class VerificationFindingService {
  private readonly logger = new Logger(VerificationFindingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: ConvergenceLedgerService,
  ) {}

  /**
   * §6 in, §3 out.
   *
   * The order inside the transaction is load-bearing, and it is `[K2]`'s order for its reasons:
   *
   *  1. lock the task, which serialises every writer on it and makes step 2 a decision rather than
   *     a guess. The SAME lock the ledger takes, from the same call, so a finding and a judgment
   *     about one task can never interleave;
   *  2. look FD1's key up FIRST. A redelivery returns the committed row having written nothing —
   *     not even the ledger row, which would otherwise charge the counters a second time before
   *     discovering the conflict;
   *  3. validate and triage against the state just read;
   *  4. create the artifact, THEN the judgment, THEN the finding. That way round because the
   *     finding's `effect_chk` requires the artifact to exist and its `decision_id` requires the
   *     judgment to, and because the database's own FD4 fence reads the task row the judgment may
   *     have just moved.
   */
  async submit(input: SubmitFindingInput): Promise<SubmitFindingResult> {
    const now = input.now ?? new Date();
    return withTransactionRetry(this.prisma, async (tx) => {
      const state = await this.ledger.lockAndRead(tx, input.subjectTaskId, input.ownerId);
      const subject = await this.subject(tx, input.subjectTaskId, input.ownerId);
      // Judging a task is what puts it under management, and a finding is a judgment: without the
      // revision row the finding's composite foreign key has nothing to point at, and the failure
      // would read as a constraint violation rather than as "this task has no ledger yet".
      if (!state.managed) {
        await this.ledger.ensureBaseline(tx, input.subjectTaskId, input.ownerId);
      }

      const address: FindingAddress = {
        projectId: subject.projectId ?? subject.ownerId,
        subjectTaskId: input.subjectTaskId,
        scopeRevision: input.scopeRevision,
        reporter: input.reporter,
      };
      const dedupKey = findingDedupKey(
        address.projectId, input.subjectTaskId, input.scopeRevision,
        input.finding.failureFingerprint,
      );
      const [existing] = await tx.$queryRaw<Array<{
        id: string;
        effectTaskId: string | null;
        effectBlockerKind: string | null;
        decisionId: string | null;
        outcome: string;
        effectiveClassification: string;
        overrideReason: string | null;
        effectKind: string;
        requiredAction: string;
        owner: string;
      }>>(Prisma.sql`
        SELECT "id", "effect_task_id" AS "effectTaskId",
               "effect_blocker_kind" AS "effectBlockerKind", "decision_id" AS "decisionId",
               "outcome", "effective_classification" AS "effectiveClassification",
               "override_reason" AS "overrideReason", "effect_kind" AS "effectKind",
               "required_action" AS "requiredAction", "owner"
          FROM "task_verification_finding" WHERE "dedup_key" = ${dedupKey}
      `);
      if (existing) {
        return {
          findingId: uuidToBase62(existing.id),
          duplicate: true,
          // The triage this finding produced when it was NEW, read back rather than recomputed.
          // Recomputing it would answer with today's counters, and the caller would be told a
          // different consequence than the one that actually happened.
          triage: {
            outcome: existing.outcome,
            effectiveClassification: existing.effectiveClassification,
            override: existing.overrideReason,
            effect: existing.effectKind,
            requiredAction: existing.requiredAction,
            owner: existing.owner,
          } as unknown as FindingTriage,
          effectTaskId: existing.effectTaskId ? uuidToBase62(existing.effectTaskId) : null,
          effectBlockerKind: existing.effectBlockerKind,
          decisionId: existing.decisionId ? uuidToBase62(existing.decisionId) : null,
        };
      }

      const lastRepairSeverity = await this.lastRepairSeverity(
        tx, input.subjectTaskId, state.scopeRevision);
      const decision = decideFinding(
        input.finding,
        address,
        {
          scopeRevision: state.scopeRevision,
          progressState: state.progressState,
          counters: state.counters,
          lastFingerprint: state.lastFingerprint,
          lastRepairSeverity,
        },
        state.thresholds,
      );
      if (!decision.ok) {
        throw new BadRequestException({
          message: `finding refused: ${decision.refusal}`,
          code: decision.refusal,
          field: decision.field,
        });
      }
      const triage = decision.triage;
      const effectKey = findingEffectKey(dedupKey);

      // §3's one artifact. `RETRY_WITHIN_BUDGET` and the two blocker classes create no row here —
      // the first because retrying is what the loop was already going to do, the other two because
      // §11.4 recomputes their row from this finding on every pass.
      const effectTaskId = triage.effect === 'DEFECT_SUBTASK'
        || triage.effect === 'PREREQUISITE_TASK'
        || triage.effect === 'REPLAN_TASK'
        ? await this.fileTask(tx, subject, input, triage, effectKey, now)
        : null;
      const effectBlockerKind = triage.effect === 'SYSTEM_BLOCKER'
        || triage.effect === 'USER_BLOCKER'
        ? EFFECT_BLOCKER_KIND[triage.effect]
        : null;

      // `[K2]`'s judgment, from the same locked state this triage read. It re-derives the counters
      // from the same rule (`advanceCounters`) and the same committed row, so the two agree by
      // construction rather than by a check at the commit point.
      const judged = await this.ledger.record(tx, input.subjectTaskId, input.ownerId, {
        observationKey: `finding:${input.finding.failureFingerprint}`,
        event: triage.event,
        classification: triage.effectiveClassification,
        failure: {
          stage: 'VERIFY',
          subjectKind: 'TASK',
          scopeHash: state.scopeHash,
          violatedInvariant: input.finding.violatedInvariant,
          // Carried for the audit. It is NOT what identifies this failure — see the line below.
          message: input.finding.minimalRepro,
        },
        // The reporter's own fingerprint, handed over rather than left to be re-derived (§5 FP1,
        // and §6's table makes it a required field of the finding).
        //
        // This is the whole of FP1's "one failure, one identity". The finding row stores the
        // reporter's fingerprint and `chargeFinding` compares it against `lastFingerprint`; the
        // ledger row is where `lastFingerprint` comes from. Letting the ledger hash the facts above
        // into a second value would make those two comparisons ask about different things, and
        // §8's repeat line — the one that stops a loop re-filing the same defect — could never
        // fire: every repetition of one failure would arrive looking new.
        authoritativeFingerprint: input.finding.failureFingerprint,
        progressVector: { ...EMPTY_PROGRESS_VECTOR, scopeHash: state.scopeHash },
        observedAt: now,
        decidedBy: input.decidedBy ?? 'ORCHESTRATOR',
        verificationRoundClosed: triage.counters.verificationRounds > state.counters.verificationRounds,
        // The effect AND the finding it belongs to. `[K2]`'s action key is
        // `(task, revision, generation, action)`, so a bare `DEFECT_SUBTASK` would make the SECOND
        // distinct failure on one revision collide with the first — one logical action per
        // decision is exactly right, and "file a defect" is not the action: "file the defect for
        // THIS finding" is. FD1's key is that identity, so it is what the action names.
        action: triage.effect === 'NONE' ? null : `${triage.effect}:${dedupKey}`,
        // §5's identity of the failure this proposal is about, for §8's repeated-action line. Not
        // the action key: that carries the attempt generation so a redelivery can be recognised,
        // and an identity that carried it could never see a repeat (FP5).
        actionIdentity: input.finding.failureFingerprint,
        sessionId: input.reporterSessionId ?? null,
      });

      const seq = await this.nextSeq(tx, input.subjectTaskId);
      const id = randomUUID();
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "task_verification_finding" (
          "id", "task_id", "owner_id", "project_id", "seq", "scope_revision", "scope_hash",
          "dedup_key", "severity", "violated_invariant", "minimal_repro", "failure_fingerprint",
          "scope_classification", "evidence", "verdict", "reporter", "reporter_task_id",
          "reporter_session_id", "effective_classification", "outcome", "override_reason",
          "effect_kind", "effect_idempotency_key", "effect_task_id", "effect_blocker_kind",
          "decision_id", "required_action", "owner", "next_check_at", "created_at"
        ) VALUES (
          ${id}::uuid, ${input.subjectTaskId}::uuid, ${input.ownerId}::uuid,
          ${subject.projectId}::uuid, ${seq}, ${state.scopeRevision}, ${state.scopeHash},
          ${dedupKey}, ${input.finding.severity}, ${input.finding.violatedInvariant},
          ${input.finding.minimalRepro}, ${input.finding.failureFingerprint},
          ${input.finding.scopeClassification},
          ${JSON.stringify(input.finding.evidence)}::jsonb, ${input.finding.verdict},
          ${input.reporter}, ${input.reporterTaskId ?? null}::uuid,
          ${input.reporterSessionId ?? null}::uuid,
          ${triage.effectiveClassification}, ${triage.outcome}, ${triage.override},
          ${triage.effect}, ${effectKey}, ${effectTaskId}::uuid, ${effectBlockerKind},
          ${judged.id}::uuid, ${triage.requiredAction}, ${triage.owner},
          ${triage.owner === 'USER' ? null : nextCheck(now)}, ${now}
        )
      `);

      return {
        findingId: uuidToBase62(id),
        duplicate: false,
        triage,
        effectTaskId: effectTaskId ? uuidToBase62(effectTaskId) : null,
        effectBlockerKind,
        decisionId: uuidToBase62(judged.id),
      };
    }, loggedRetry(this.logger, 'verificationFinding.submit'));
  }

  /** Every finding on one task, newest first — the read face of `finding → Task/decision`. */
  async describe(ownerId: string, taskId: string) {
    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT f."id", f."seq", f."scope_revision" AS "scopeRevision", f."severity",
             f."violated_invariant" AS "violatedInvariant", f."minimal_repro" AS "minimalRepro",
             f."failure_fingerprint" AS "failureFingerprint",
             f."scope_classification" AS "scopeClassification",
             f."effective_classification" AS "effectiveClassification",
             f."verdict", f."evidence", f."reporter",
             f."reporter_task_id" AS "reporterTaskId",
             f."reporter_session_id" AS "reporterSessionId",
             f."outcome", f."override_reason" AS "overrideReason",
             f."effect_kind" AS "effectKind", f."effect_task_id" AS "effectTaskId",
             f."effect_blocker_kind" AS "effectBlockerKind",
             f."decision_id" AS "decisionId", f."required_action" AS "requiredAction",
             f."owner", f."next_check_at" AS "nextCheckAt", f."created_at" AS "createdAt"
        FROM "task_verification_finding" f
       WHERE f."task_id" = ${taskId}::uuid AND f."owner_id" = ${ownerId}::uuid
       ORDER BY f."seq" DESC
    `);
    return rows.map((row) => ({
      ...row,
      id: uuidToBase62(row.id as string),
      seq: String(row.seq),
      effectTaskId: row.effectTaskId ? uuidToBase62(row.effectTaskId as string) : null,
      decisionId: row.decisionId ? uuidToBase62(row.decisionId as string) : null,
      reporterTaskId: row.reporterTaskId ? uuidToBase62(row.reporterTaskId as string) : null,
      reporterSessionId: row.reporterSessionId
        ? uuidToBase62(row.reporterSessionId as string)
        : null,
    }));
  }

  /**
   * The one Task a finding files, and where it sits.
   *
   * The three shapes differ in exactly one thing each, and each difference is the classification's
   * own meaning rendered as a graph edge:
   *
   *  - `DEFECT_SUBTASK` is a CHILD of the subject. The work is inside the subject's scope, so it
   *    belongs under it — and a subject on `ALL_CHILDREN_DONE` or `VERIFICATION_PASSED` cannot
   *    re-complete while it is open, which is the mechanical half of "fix it before you pass".
   *  - `PREREQUISITE_TASK` is a SIBLING the subject DEPENDS ON. §3's definition is "work outside
   *    this task's scope that this task needs", so it is not a child (it is not part of this task)
   *    and it is not merely adjacent (this task cannot proceed without it).
   *  - `REPLAN_TASK` is a SIBLING with no edge at all, and the absence is the point. OW3 forbids a
   *    coordinator from minting a new scope revision, so this row is a REQUEST addressed to a
   *    person; wiring the frozen subject to depend on it would assert that the answer is already
   *    known to be "do this next", which is the decision being asked for.
   */
  private async fileTask(
    tx: Prisma.TransactionClient,
    subject: SubjectRow,
    input: SubmitFindingInput,
    triage: FindingTriage,
    effectKey: string,
    now: Date,
  ): Promise<string> {
    const id = randomUUID();
    const parentTaskId = triage.effect === 'DEFECT_SUBTASK' ? subject.id : subject.parentTaskId;
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "task" (
        "id", "title", "description", "acceptance_criteria", "status", "owner_id", "project_id",
        "list_id", "assignee_id", "parent_task_id", "creator_type", "creator_id",
        "dispatch_authority", "idempotency_key", "created_at", "updated_at"
      ) VALUES (
        ${id}::uuid, ${title(subject, triage)}, ${brief(input, triage)},
        ${acceptance(input, triage)}, 'OPEN', ${subject.ownerId}::uuid,
        ${subject.projectId}::uuid, ${subject.listId}::uuid,
        ${triage.effect === 'REPLAN_TASK' ? null : subject.assigneeId}::uuid,
        -- The same creator pair §13.2's defect filer writes, and for its reason: creator_id is
        -- NOT NULL and names a PRINCIPAL, so the owner is what goes in it. WHICH check reported the
        -- finding is on the finding's own reporter_task_id column, where it cannot be mistaken for
        -- the identity that filed this row. (No backticks in here: this is inside a template
        -- literal, and one would close it -- see the TS1005 that points at the wrong line.)
        ${parentTaskId}::uuid, 'USER', ${subject.ownerId}::uuid,
        'COORDINATOR', ${effectKey}, ${now}, ${now}
      )
      ON CONFLICT ("idempotency_key") DO NOTHING
    `);
    // The row that is THERE, which is this one or the one a replay already committed under the same
    // key. Reading it back rather than trusting the insert is what makes the crash-between-the-two
    // case land on one Task instead of none.
    const [row] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "task" WHERE "idempotency_key" = ${effectKey}
    `);
    if (!row) throw new Error(`finding effect task for ${effectKey} vanished during its own insert`);

    if (triage.effect === 'PREREQUISITE_TASK') {
      // The subject waits on it. `ON CONFLICT DO NOTHING` for the replay, and no cycle check needed
      // — the prerequisite was created by this statement and depends on nothing.
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "task_dependency" ("id", "task_id", "depends_on_task_id", "created_at")
        VALUES (${randomUUID()}::uuid, ${subject.id}::uuid, ${row.id}::uuid, ${now})
        ON CONFLICT ("task_id", "depends_on_task_id") DO NOTHING
      `);
    }
    return row.id;
  }

  /**
   * FD3': how bad the last finding on this revision that produced a repair was.
   *
   * Only the two outcomes that file WORK count as a repair. A blocker, a freeze and a transient
   * retry all leave the defect exactly where it was, so treating one as "we already tried" would
   * freeze the next genuine defect on its first report.
   */
  private async lastRepairSeverity(
    tx: Prisma.TransactionClient,
    taskId: string,
    scopeRevision: number,
  ): Promise<FindingSeverity | null> {
    const [row] = await tx.$queryRaw<Array<{ severity: string }>>(Prisma.sql`
      SELECT "severity" FROM "task_verification_finding"
       WHERE "task_id" = ${taskId}::uuid AND "scope_revision" = ${scopeRevision}
         AND "effect_kind" IN ('DEFECT_SUBTASK', 'PREREQUISITE_TASK')
       ORDER BY "seq" DESC LIMIT 1
    `);
    return (row?.severity as FindingSeverity) ?? null;
  }

  private async nextSeq(tx: Prisma.TransactionClient, taskId: string): Promise<bigint> {
    const [row] = await tx.$queryRaw<Array<{ next: bigint }>>(Prisma.sql`
      SELECT coalesce(max("seq"), 0) + 1 AS "next"
        FROM "task_verification_finding" WHERE "task_id" = ${taskId}::uuid
    `);
    return row?.next ?? 1n;
  }

  private async subject(
    tx: Prisma.TransactionClient,
    taskId: string,
    ownerId: string,
  ): Promise<SubjectRow> {
    const [row] = await tx.$queryRaw<Array<SubjectRow>>(Prisma.sql`
      SELECT "id", "owner_id" AS "ownerId", "project_id" AS "projectId", "title",
             "list_id" AS "listId", "assignee_id" AS "assigneeId",
             "parent_task_id" AS "parentTaskId", "scope_revision" AS "scopeRevision"
        FROM "task" WHERE "id" = ${taskId}::uuid AND "owner_id" = ${ownerId}::uuid
    `);
    if (!row) throw new NotFoundException('task not found');
    return row;
  }
}

/** BL5's poll for a finding the loop still owns. A USER-owned one gets none (§11.1). */
function nextCheck(now: Date): Date {
  return new Date(now.getTime() + 10 * 60_000);
}

function title(subject: SubjectRow, triage: FindingTriage): string {
  const prefix = triage.effect === 'DEFECT_SUBTASK'
    ? 'Defect'
    : triage.effect === 'PREREQUISITE_TASK' ? 'Prerequisite' : 'Re-plan';
  return `${prefix}: ${subject.title}`.slice(0, MAX_TASK_TITLE_CHARS);
}

/**
 * The brief, carrying §6's finding verbatim.
 *
 * Ids are Base62 throughout, on the same rule the defect subtask `[H0]` files already follows: this
 * is text a person and an agent read and hand back, and an id spelled as an internal UUID is one
 * neither of them can use anywhere else.
 */
function brief(input: SubmitFindingInput, triage: FindingTriage): string {
  const lines = [
    `A verification of ${uuidToBase62(input.subjectTaskId)} reported a ${input.finding.severity} `
      + `finding classified ${triage.effectiveClassification}.`,
    '',
    `Violated invariant: ${input.finding.violatedInvariant}`,
    `Minimal repro: ${input.finding.minimalRepro}`,
    `Failure fingerprint: ${input.finding.failureFingerprint}`,
    `Verdict: ${input.finding.verdict}`,
    '',
    `Required action: ${triage.requiredAction}`,
  ];
  if (triage.override) {
    lines.push(
      '',
      `This is a re-plan rather than a repair because: ${triage.override}. The classification the `
      + 'reporter submitted was ' + input.finding.scopeClassification + '.',
    );
  }
  lines.push('', 'Evidence:', JSON.stringify(input.finding.evidence, null, 2));
  return lines.join('\n');
}

/**
 * What would settle the filed task.
 *
 * The repro is the criterion, deliberately and for §6's reason: a finding that could not be
 * reproduced was refused at the door, so every finding that gets this far carries the one command
 * that decides whether the work is finished. A defect closed against a description rather than
 * against a repro is the shape that produces a second round on the same fingerprint.
 */
function acceptance(input: SubmitFindingInput, triage: FindingTriage): string {
  if (triage.effect === 'REPLAN_TASK') {
    return 'A person has re-scoped the subject task (a new scope revision, or a split into tasks '
      + 'that are each achievable), or has extended its convergence budget with a reason. '
      + `The finding that stopped it: ${input.finding.violatedInvariant} — repro: `
      + `${input.finding.minimalRepro}`;
  }
  return `\`${input.finding.minimalRepro}\` no longer reproduces `
    + `${input.finding.violatedInvariant}, and the fingerprint `
    + `${input.finding.failureFingerprint} does not recur on the subject's re-verification.`;
}
