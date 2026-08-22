import { randomUUID } from 'node:crypto';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { base62ToUuid, uuidToBase62 } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { taskRetirement } from '../tasks/task-supersession';
import {
  ProjectActionApplyResult,
  ProjectActionEffectRefusal,
  ProjectReconcileLease,
  ProjectReconcileService,
  ProjectVerdictExecutor,
} from './project-reconcile.service';
import {
  PlannedVerificationVerdict,
  verificationDefectIdempotencyKey,
  verificationVerdictActionKey,
} from './task-verification-verdict';

/** Defect titles are the subject's, prefixed; the column is bounded like every other task title. */
const MAX_TASK_TITLE_CHARS = 200;

export interface ApplyVerificationVerdictCommand {
  decisionId: string;
  /** One entry from `planVerificationVerdicts`, ids in Base62 exactly as planned. */
  planned: PlannedVerificationVerdict;
}

export interface ApplyVerificationVerdictResult {
  action: ProjectActionApplyResult;
  /** Base62, and null whenever this verdict filed no defect (PASS, INCONCLUSIVE, or a replay). */
  defectTaskId: string | null;
  /** Base62 id of the condition row this raised, or null for PASS and for a replay. */
  failureId: string | null;
  subjectReverted: boolean;
  conditionsResolved: number;
}

interface VerifierRow {
  id: string;
  ownerId: string;
  projectId: string | null;
  status: string;
  verdict: string | null;
  verdictRevision: bigint;
  verifiesTaskId: string | null;
  /** §13.6 SU6's two columns, read under the same `FOR UPDATE` as everything else here. */
  supersededByTaskId: string | null;
  terminalReason: string | null;
}

interface SubjectRow {
  id: string;
  ownerId: string;
  projectId: string | null;
  status: string;
  title: string;
  listId: string | null;
  assigneeId: string | null;
  supersededByTaskId: string | null;
  terminalReason: string | null;
}

/**
 * The one path that turns a verification conclusion into facts (contract AC6 / §13.2).
 *
 * Everything it does happens inside the action ledger's transaction, so the whole set — the
 * revert, the defect subtask, the condition that stops the work downstream — commits together
 * under one permanent key or not at all. The key carries the verdict REVISION rather than the
 * verdict, which is what lets a second failure of the same check happen again in full while a
 * redelivered or out-of-order reconcile of the same conclusion happens exactly once (V2 / V4 / V7).
 *
 * It changes no downstream task's status (V3). Blocking is a dispatch precondition read from the
 * condition row, because a task that was quietly moved is a task whose reason has to be excavated.
 *
 * **Who calls it.** The reconcile pass, through `ProjectVerdictExecutor` — registered here at
 * startup on the terms §7.5's rotation is registered on. That wiring is the whole of AC6 and it did
 * not exist until now: `verificationVerdictPlan` computed these consequences on every pass, handed
 * them to §11.4's condition detector, and the detector raised a `VERIFICATION_FAILED` blocker and
 * discarded the rest. Everything below was reachable only from a test. A production FAIL left its
 * subject DONE, filed no defect, and wrote no row into `task_verification_failure` — which is the
 * table `ProjectAuthorizationService` reads before it lets a dependent task run, so a task whose
 * upstream check had failed dispatched anyway. `apply` stays public beside the executor because the
 * e2e rig and the pg specs drive exactly one conclusion and assert on what it did.
 */
@Injectable()
export class ProjectVerificationVerdictService
implements ProjectVerdictExecutor, OnModuleInit, OnModuleDestroy {
  private unregister?: () => void;

  constructor(
    private readonly prisma: PrismaService,
    private readonly reconciler: ProjectReconcileService,
  ) {}

  onModuleInit(): void {
    this.unregister = this.reconciler.registerVerdictExecutor(this);
  }

  onModuleDestroy(): void {
    this.unregister?.();
    this.unregister = undefined;
  }

  /** §8.2's permanent key for one conclusion, in the ledger's spelling. */
  idempotencyKey(projectId: string, verifierTaskId: string, verdictRevision: string): string {
    return verificationVerdictActionKey(projectId, verifierTaskId, verdictRevision);
  }

  /**
   * What the ledger row records about this conclusion.
   *
   * Base62 throughout and structured, because `project_action.detail` is read back over the audit
   * API: it is the row somebody lines up against `GET /projects/:id/verifications` when they want
   * to know which conclusion caused which consequence.
   */
  actionDetail(planned: PlannedVerificationVerdict): Prisma.InputJsonValue {
    return {
      v: 1,
      verdict: planned.verdict,
      verdictRevision: planned.verdictRevision,
      verifierTaskId: planned.verifierTaskId,
      subjectTaskId: planned.subjectTaskId,
      consequences: { ...planned.consequences },
      evidence: { ...planned.evidence, session: planned.evidence.session ?? null },
    } as unknown as Prisma.InputJsonValue;
  }

  /**
   * The effect, for a caller that already holds the ledger's transaction — the reconcile pass.
   *
   * One body, two entry points, exactly as `applyDecisionAction` and its in-transaction twin are
   * one body: a conclusion applied from inside the loop and one applied by a lease holder outside
   * it must write the same rows under the same key, or the two paths would eventually disagree
   * about what a FAIL did.
   */
  async applyVerdictInTransaction(
    tx: Prisma.TransactionClient,
    lease: ProjectReconcileLease,
    command: { decisionId: string; planned: PlannedVerificationVerdict },
    actionId: string,
    now: Date,
  ): Promise<void | ProjectActionEffectRefusal> {
    return this.applyInTransaction(tx, lease, command.planned, actionId, now, {
      defectTaskId: null, failureId: null, subjectReverted: false, conditionsResolved: 0,
    });
  }

  async apply(
    lease: ProjectReconcileLease,
    command: ApplyVerificationVerdictCommand,
    now = new Date(),
  ): Promise<ApplyVerificationVerdictResult> {
    const planned = command.planned;
    const verifierId = internalId(planned.verifierTaskId);
    const outcome = {
      defectTaskId: null as string | null,
      failureId: null as string | null,
      subjectReverted: false,
      conditionsResolved: 0,
    };
    const action = await this.reconciler.applyDecisionAction(
      lease,
      command.decisionId,
      {
        type: 'APPLY_VERIFICATION_VERDICT',
        idempotencyKey: this.idempotencyKey(
          lease.projectId,
          verifierId,
          planned.verdictRevision,
        ),
        // The verifier, not the subject: the action is about a conclusion, and a subject with two
        // checks would otherwise have two actions claiming the same subject id.
        subject: { type: 'TASK', id: verifierId },
        detail: this.actionDetail(planned),
      },
      async (tx, actionId) => this.applyInTransaction(tx, lease, planned, actionId, now, outcome),
      now,
    );
    return { action, ...outcome };
  }

  private async applyInTransaction(
    tx: Prisma.TransactionClient,
    lease: ProjectReconcileLease,
    planned: PlannedVerificationVerdict,
    actionId: string,
    now: Date,
    outcome: {
      defectTaskId: string | null;
      failureId: string | null;
      subjectReverted: boolean;
      conditionsResolved: number;
    },
  ): Promise<void | ProjectActionEffectRefusal> {
    const verifierId = internalId(planned.verifierTaskId);
    const subjectId = internalId(planned.subjectTaskId);
    // Both rows locked before anything is read out of them, in id order — the same rule the rest
    // of the loop follows, so two verdicts landing on overlapping trees cannot deadlock.
    const [first, second] = [verifierId, subjectId].sort();
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "task" WHERE "id" IN (${first}::uuid, ${second}::uuid)
       ORDER BY "id" FOR UPDATE
    `);
    void rows;

    const verifiers = await tx.$queryRaw<VerifierRow[]>(Prisma.sql`
      SELECT "id", "owner_id" AS "ownerId", "project_id" AS "projectId", "status"::text,
             "verdict"::text, "verdict_revision" AS "verdictRevision",
             "verifies_task_id" AS "verifiesTaskId",
             "superseded_by_task_id" AS "supersededByTaskId",
             "terminal_reason" AS "terminalReason"
        FROM "task" WHERE "id" = ${verifierId}::uuid
    `);
    const verifier = verifiers[0];
    // V6. The verification and its subject can be deleted mid-run — a fixture teardown takes the
    // whole tree — and `task.verifies_task_id` cascades, so losing the subject loses the verifier
    // too. Neither is an error and neither may wedge the loop: the conclusion is simply about a
    // world that no longer exists, and SUPERSEDED is the ledger's word for that.
    if (!verifier || verifier.projectId !== lease.projectId) {
      return superseded('VERIFICATION_VERIFIER_MISSING', {
        verifierTaskId: planned.verifierTaskId,
      });
    }
    if (verifier.verifiesTaskId !== subjectId) {
      return superseded('VERIFICATION_SUBJECT_REPOINTED', {
        verifierTaskId: planned.verifierTaskId,
        subjectTaskId: planned.subjectTaskId,
        currentSubjectTaskId: verifier.verifiesTaskId == null
          ? null
          : uuidToBase62(verifier.verifiesTaskId),
      });
    }
    // §13.6 SU6, at the commit point and under the `FOR UPDATE` taken above. The planner refuses a
    // retired check on the snapshot; this is the half that answers "the supersession was recorded
    // AFTER we planned". Read through the row lock, so the link and this apply serialize on the
    // task row instead of each reading the other as absent — and refused BEFORE the first write, so
    // a replaced finding cannot revert a subject, file a defect, write a failure row or open a turn.
    const verifierRetirement = taskRetirement(verifier);
    if (verifierRetirement) {
      return superseded('VERIFICATION_VERIFIER_RETIRED', {
        verifierTaskId: planned.verifierTaskId,
        terminalReason: verifierRetirement,
        supersededByTaskId: verifier.supersededByTaskId == null
          ? null
          : uuidToBase62(verifier.supersededByTaskId),
      });
    }
    // The snapshot's conclusion has to still be the row's conclusion. A newer verdict has a newer
    // revision and therefore its own action; applying this one on top would replay a superseded
    // finding against a subject that has since moved on.
    if (verifier.verdict !== planned.verdict
        || verifier.verdictRevision !== BigInt(planned.verdictRevision)) {
      return superseded('VERDICT_SUPERSEDED', {
        verdict: planned.verdict,
        verdictRevision: planned.verdictRevision,
        currentVerdict: verifier.verdict,
        currentVerdictRevision: String(verifier.verdictRevision),
      });
    }

    const subjects = await tx.$queryRaw<SubjectRow[]>(Prisma.sql`
      SELECT "id", "owner_id" AS "ownerId", "project_id" AS "projectId", "status"::text,
             "title", "list_id" AS "listId", "assignee_id" AS "assigneeId",
             "superseded_by_task_id" AS "supersededByTaskId",
             "terminal_reason" AS "terminalReason"
        FROM "task" WHERE "id" = ${subjectId}::uuid
    `);
    const subject = subjects[0];
    if (!subject || subject.projectId !== lease.projectId) {
      return superseded('VERIFICATION_SUBJECT_MISSING', { subjectTaskId: planned.subjectTaskId });
    }
    // The other side, same lock and same reason. A finding about work that has been REPLACED must
    // not revert that work (nothing will dispatch it again) or file a defect under it (a work item
    // nobody can close, holding acceptance open for as long as it exists).
    const subjectRetirement = taskRetirement(subject);
    if (subjectRetirement) {
      return superseded('VERIFICATION_SUBJECT_RETIRED', {
        subjectTaskId: planned.subjectTaskId,
        terminalReason: subjectRetirement,
        supersededByTaskId: subject.supersededByTaskId == null
          ? null
          : uuidToBase62(subject.supersededByTaskId),
      });
    }

    if (planned.consequences.resolveConditions) {
      // PASS clears every unresolved condition ABOUT THIS SUBJECT, not only the ones this verifier
      // raised: two checks on one task are two opinions about the same claim, and a later pass is
      // the fact that the claim now holds. Nothing else resolves a condition — in particular
      // revoking the verdict does not, or deleting an inconvenient finding would be the way to
      // unblock the work (V4).
      outcome.conditionsResolved = await tx.$executeRaw(Prisma.sql`
        UPDATE "task_verification_failure"
           SET "resolved_at" = ${now}, "resolved_by_task_id" = ${verifierId}::uuid,
               "updated_at" = ${now}
         WHERE "subject_task_id" = ${subjectId}::uuid AND "resolved_at" IS NULL
      `);
      return;
    }

    if (planned.consequences.revertSubject) {
      // The native revert. Conditional on DONE: a subject somebody already reopened is in the
      // state this wanted, and one that was cancelled is a decision this must not overturn.
      outcome.subjectReverted = (await tx.$executeRaw(Prisma.sql`
        UPDATE "task" SET "status" = 'OPEN', "updated_at" = ${now}
         WHERE "id" = ${subjectId}::uuid AND "status" = 'DONE'
      `)) === 1;
    }

    let defectTaskId: string | null = null;
    if (planned.consequences.fileDefect) {
      defectTaskId = await this.fileDefect(tx, lease, planned, subject, now);
      outcome.defectTaskId = uuidToBase62(defectTaskId);
    }

    if (planned.consequences.raiseCondition) {
      const failureId = randomUUID();
      const inserted = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        INSERT INTO "task_verification_failure" (
          "id", "project_id", "verifier_task_id", "subject_task_id", "verdict",
          "verdict_revision", "blocks_downstream", "defect_task_id", "raised_by_action_id",
          "evidence", "updated_at"
        ) VALUES (
          ${failureId}::uuid, ${lease.projectId}::uuid, ${verifierId}::uuid, ${subjectId}::uuid,
          ${planned.verdict}::"task_verdict", ${BigInt(planned.verdictRevision)},
          ${planned.consequences.blockDownstream}, ${defectTaskId}::uuid, ${actionId}::uuid,
          ${JSON.stringify(planned.evidence)}::jsonb, ${now}
        )
        ON CONFLICT ("verifier_task_id", "verdict_revision") DO NOTHING
        RETURNING "id"
      `);
      outcome.failureId = uuidToBase62(inserted[0]?.id ?? failureId);
    }
  }

  /**
   * One defect subtask under the subject, carrying what the check found.
   *
   * Keyed on `(verifier, revision)` through `task.idempotencyKey`, which is already unique: the
   * action ledger makes this run once, and the key makes it once again if the ledger is ever
   * bypassed. Filed under the subject so §13.1's aggregation sees it — a subject on
   * ALL_CHILDREN_DONE cannot re-complete while its defect is open, which is the same statement
   * this row makes to the dispatch guard, arrived at from the other direction.
   */
  private async fileDefect(
    tx: Prisma.TransactionClient,
    lease: ProjectReconcileLease,
    planned: PlannedVerificationVerdict,
    subject: SubjectRow,
    now: Date,
  ): Promise<string> {
    const verifierId = internalId(planned.verifierTaskId);
    const key = verificationDefectIdempotencyKey(
      lease.projectId,
      verifierId,
      planned.verdictRevision,
    );
    const id = randomUUID();
    const title = `[DEFECT] ${subject.title}`.slice(0, MAX_TASK_TITLE_CHARS);
    const inserted = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      INSERT INTO "task" (
        "id", "title", "description", "acceptance_criteria", "status", "owner_id",
        "creator_type", "creator_id", "project_id", "parent_task_id", "list_id", "assignee_id",
        "auto_run_when_ready", "idempotency_key", "created_at", "updated_at"
      ) VALUES (
        ${id}::uuid, ${title}, ${defectBrief(planned, subject)},
        ${defectAcceptanceCriteria(planned)}, 'OPEN', ${subject.ownerId}::uuid,
        'USER', ${subject.ownerId}::uuid, ${lease.projectId}::uuid, ${subject.id}::uuid,
        ${subject.listId}::uuid, ${subject.assigneeId}::uuid,
        false, ${key}, ${now}, ${now}
      )
      ON CONFLICT ("idempotency_key") DO NOTHING
      RETURNING "id"
    `);
    if (inserted[0]) return inserted[0].id;
    const existing = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "task" WHERE "idempotency_key" = ${key}
    `);
    if (!existing[0]) throw new Error(`defect subtask for ${key} vanished during its own insert`);
    return existing[0].id;
  }
}

/**
 * The defect's brief.
 *
 * Structured, and every id in it is Base62 — this is prose, the one surface `PublicIdInterceptor`
 * cannot rewrite, so an id spelled as a UUID here is one whoever picks the defect up cannot hand
 * back to `task_get`. It quotes no free text from the run: V1 puts the conclusion in a column, and
 * a brief that paraphrased the verifier would be a second, unversioned copy of the verdict.
 */
function defectBrief(planned: PlannedVerificationVerdict, subject: SubjectRow): string {
  const session = planned.evidence.session;
  const lines = [
    `验收任务 ${planned.verifierTaskId} 对任务「${subject.title}」`
      + `（id: ${planned.subjectTaskId}）给出的结论是 ${planned.verdict}`
      + `（第 ${planned.verdictRevision} 次结论），该任务已被自动退回 OPEN。`,
    '',
    '本任务是这次失败对应的缺陷修复项，请修好它所描述的问题，而不是重新执行原任务。',
    '',
    `- 被验收任务：${planned.subjectTaskId}`,
    `- 验收任务：${planned.verifierTaskId}`,
    `- 结论：${planned.verdict}（verdictRevision ${planned.verdictRevision}）`,
    session
      ? `- 验收运行：${session.id}，终态 ${session.runStatus}`
        + `${session.finishedAt ? `，结束于 ${session.finishedAt}` : ''}`
      : '- 验收运行：无（该结论没有对应的运行记录）',
    '',
    `修复完成后，被验收任务需要重新运行验收才能重新通过：旧结论不会自动变成 PASS。`
      + `详细结论请用 task_get 读验收任务 ${planned.verifierTaskId} 的评论与运行记录。`,
  ];
  return lines.join('\n');
}

function defectAcceptanceCriteria(planned: PlannedVerificationVerdict): string {
  return `验收任务 ${planned.verifierTaskId} 指出的问题已修复，且被验收任务 `
    + `${planned.subjectTaskId} 重新运行的验收给出 PASS（新的 verdictRevision，`
    + `不是第 ${planned.verdictRevision} 次的旧结论）。`;
}

function superseded(
  refusalCode: string,
  detail: Record<string, unknown>,
): ProjectActionEffectRefusal {
  return {
    status: 'SUPERSEDED',
    refusalCode,
    reasonCode: refusalCode,
    detail: { v: 1, ...detail } as Prisma.InputJsonValue,
  };
}

/**
 * Base62 in, UUID out.
 *
 * The plan speaks Base62 because it is audit material; the ledger key, the row locks and every
 * `::uuid` cast below need the internal form. Doing it here means a malformed id is a throw at the
 * boundary rather than a Postgres cast error halfway through the effect.
 */
function internalId(publicId: string): string {
  return base62ToUuid(publicId);
}
