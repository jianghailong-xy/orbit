import { randomUUID } from 'node:crypto';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { base62ToUuid, uuidToBase62 } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AgentProvider } from '@orbit/shared';
import { runtimeCatalogModels } from '../common/runtime-model';
import {
  ProjectAutomationPolicyValue,
  authorizeProjectAction,
} from './project-authorization.service';
import {
  ProjectActionEffectRefusal,
  ProjectFilingExecutor,
  ProjectReconcileLease,
  ProjectReconcileService,
} from './project-reconcile.service';
import type { PlannedVerificationFiling } from './project-completion-gap';

/** Titles are the subject's, prefixed; the column is bounded like every other task title. */
const MAX_TASK_TITLE_CHARS = 200;

interface SubjectRow {
  id: string;
  ownerId: string;
  projectId: string | null;
  status: string;
  title: string;
  listId: string | null;
  assigneeId: string | null;
  parentTaskId: string | null;
  completionPolicy: string;
  supersededByTaskId: string | null;
  terminalReason: string | null;
}

/**
 * §13.2 V8: the one path that files the verification a `VERIFICATION_PASSED` task is waiting on.
 *
 * The shape it exists for is §13.1 AG7's second one — a roll-up whose children are all in, whose
 * policy says a passing check completes it, and at which no check points. Nothing else in the loop
 * can move that task: AG6 refuses to dispatch it (correctly — it is not work), aggregation cannot
 * complete it, and a verification is dispatched only after its subject is DONE, which this subject
 * reaches only through the verification. Left alone it is a row nobody is looking at.
 *
 * Everything happens in the action ledger's transaction (V8-f): the claim, the ledger row and the
 * task INSERT commit together under one permanent key or not at all. The key carries a GENERATION
 * (V8-e) rather than the subject alone, which is what separates the two cases a bare subject key
 * conflates — a replay of the same episode, which must do nothing, and a genuinely new attempt
 * after a refusal that had no side effect or after the filed check went away, which must file
 * again. `task.idempotency_key` carries the same generation and is the SECOND lock, for a writer
 * that reached the table without going through the ledger.
 */
@Injectable()
export class ProjectVerificationFilingService
implements ProjectFilingExecutor, OnModuleInit, OnModuleDestroy {
  private unregister?: () => void;

  constructor(
    private readonly prisma: PrismaService,
    private readonly reconciler: ProjectReconcileService,
  ) {}

  onModuleInit(): void {
    this.unregister = this.reconciler.registerFilingExecutor(this);
  }

  onModuleDestroy(): void {
    this.unregister?.();
    this.unregister = undefined;
  }

  /** §8.2's permanent key for one filing attempt, in the ledger's spelling (internal ids). */
  idempotencyKey(projectId: string, subjectTaskId: string, generation: string): string {
    return verificationFilingActionKey(projectId, subjectTaskId, generation);
  }

  actionDetail(planned: PlannedVerificationFiling): Prisma.InputJsonValue {
    return {
      v: 1,
      subjectTaskId: planned.subjectTaskId,
      verifierAgentId: planned.verifierAgentId,
      generation: planned.generation,
    };
  }

  /**
   * File it, or say why the world moved (V6's rule, read across to this action).
   *
   * Every refusal here is `SUPERSEDED`: the plan described a task that has since been finished,
   * cancelled, replaced, re-policied or deleted, and none of those is a failure — it is the answer
   * arriving after the question stopped being asked. A throw would roll back a reconcile that is
   * otherwise correct.
   */
  async fileInTransaction(
    tx: Prisma.TransactionClient,
    lease: ProjectReconcileLease,
    command: { decisionId: string; planned: PlannedVerificationFiling },
    actionId: string,
    now: Date,
  ): Promise<void | ProjectActionEffectRefusal> {
    const planned = command.planned;
    const subjectId = base62ToUuid(planned.subjectTaskId);
    // The project row, for the two facts §9.2 decides on. `config_revision` is the whole of the
    // staleness question for a plan like this one: the automation policy, the team and the
    // permissions this filing was authorised against all move it, so one comparison covers all of
    // them without this method re-deriving the matrix a second time.
    const project = (await tx.$queryRaw<Array<{
      ownerId: string; status: string; configRevision: bigint; coordinatorAgentId: string | null;
      automationPolicy: string; coordinatorEnabled: boolean;
    }>>(Prisma.sql`
      SELECT p."owner_id" AS "ownerId", p."status"::text,
             p."config_revision" AS "configRevision",
             coordinator."agent_id" AS "coordinatorAgentId",
             p."automation_policy"::text AS "automationPolicy",
             p."coordinator_enabled" AS "coordinatorEnabled"
        FROM "project" p
        LEFT JOIN LATERAL (
          SELECT pm."agent_id"
            FROM "project_member" pm
            JOIN "workspace" w ON w."id" = pm."agent_id" AND w."owner_id" = p."owner_id"
           WHERE pm."project_id" = p."id" AND pm."role" = 'COORDINATOR'
           ORDER BY pm."agent_id" LIMIT 1
        ) coordinator ON TRUE
       WHERE p."id" = ${lease.projectId}::uuid
    `))[0];
    if (!project) return superseded('PROJECT_MISSING', {});
    if (String(project.configRevision) !== planned.configRevision) {
      return superseded('PROJECT_CONFIG_CHANGED', {
        planned: planned.configRevision, actual: String(project.configRevision),
      });
    }
    if (project.status !== 'OPEN') {
      return superseded('PROJECT_NOT_OPEN', { status: project.status });
    }
    // The two permissions live on the AGENT row (`workspace`), not on the membership — the same
    // split `decisionInput.world.team` flattens, read here in its unflattened form.
    const coordinator = project.coordinatorAgentId
      ? (await tx.$queryRaw<Array<{
        role: string; enabled: boolean; deletedAt: Date | null;
        canCreateTasks: boolean; canDelegate: boolean;
      }>>(Prisma.sql`
        SELECT m."role"::text, w."enabled", w."deleted_at" AS "deletedAt",
               w."can_create_tasks" AS "canCreateTasks", w."can_delegate" AS "canDelegate"
          FROM "project_member" m
          JOIN "workspace" w ON w."id" = m."agent_id" AND w."owner_id" = ${project.ownerId}::uuid
         WHERE m."project_id" = ${lease.projectId}::uuid
           AND m."agent_id" = ${project.coordinatorAgentId}::uuid
      `))[0]
      : undefined;
    // §9.2, re-answered at the commit point through the SAME function the plan used, on rows read
    // under this transaction rather than on the snapshot. `config_revision` above already refuses a
    // project whose settings moved; this refuses the case where they did not move but the answer
    // still differs — a permission revoked, the coordinator replaced, the project closed.
    const authorization = authorizeProjectAction({
      ...planned.authorization.request,
      project: {
        ...planned.authorization.request.project,
        status: project.status as 'OPEN',
        coordinatorEnabled: project.coordinatorEnabled,
        automationPolicy: project.automationPolicy as ProjectAutomationPolicyValue,
        configRevision: String(project.configRevision),
      },
      principal: {
        agentId: project.coordinatorAgentId ? uuidToBase62(project.coordinatorAgentId) : null,
        coordinatorAgentId: project.coordinatorAgentId
          ? uuidToBase62(project.coordinatorAgentId)
          : null,
        memberRole: coordinator ? (coordinator.role as 'COORDINATOR' | 'MEMBER') : null,
        agentEnabled: coordinator?.enabled ?? false,
        agentDeleted: Boolean(coordinator?.deletedAt),
        canCoordinate: coordinator?.role === 'COORDINATOR',
        canCreateTasks: coordinator?.canCreateTasks ?? false,
        canDelegate: coordinator?.canDelegate ?? false,
      },
    });
    if (authorization.decision !== 'ALLOW') {
      return superseded('FILING_NOT_AUTHORIZED', {
        decision: authorization.decision,
        reasonCode: authorization.reasonCode,
        policyRow: authorization.policyRow,
      });
    }

    // The same `FOR UPDATE` §13.2 takes, and for the same reason: everything below is decided from
    // this row, so it may not move between the read and the INSERT.
    const subject = (await tx.$queryRaw<SubjectRow[]>(Prisma.sql`
      SELECT "id", "owner_id" AS "ownerId", "project_id" AS "projectId", "status", "title",
             "list_id" AS "listId", "assignee_id" AS "assigneeId",
             "parent_task_id" AS "parentTaskId", "completion_policy"::text AS "completionPolicy",
             "superseded_by_task_id" AS "supersededByTaskId",
             "terminal_reason"::text AS "terminalReason"
        FROM "task" WHERE "id" = ${subjectId}::uuid FOR UPDATE
    `))[0];
    if (!subject || subject.projectId !== lease.projectId || subject.ownerId !== project.ownerId) {
      return superseded('VERIFICATION_SUBJECT_MISSING', { subjectTaskId: planned.subjectTaskId });
    }
    if (subject.supersededByTaskId || subject.terminalReason) {
      return superseded('VERIFICATION_SUBJECT_RETIRED', { subjectTaskId: planned.subjectTaskId });
    }
    // Re-read under the lock, not trusted from the snapshot: the whole reason to file is that this
    // task completes ONLY on a passing check, and somebody taking it back to MANUAL between the
    // decision and here has withdrawn the request.
    if (subject.completionPolicy !== 'VERIFICATION_PASSED') {
      return superseded('VERIFICATION_SUBJECT_POLICY_CHANGED', {
        subjectTaskId: planned.subjectTaskId,
        completionPolicy: subject.completionPolicy,
      });
    }
    if (subject.status === 'DONE' || subject.status === 'CANCELLED') {
      return superseded('VERIFICATION_SUBJECT_SETTLED', {
        subjectTaskId: planned.subjectTaskId, status: subject.status,
      });
    }

    // WHO and WITH WHAT, re-read: the plan named one agent and one engine, and every clause that
    // made the pair nameable has to still hold. Independence is re-DERIVED from the rows rather
    // than trusted — the write that would break it (re-assigning a subtask to the verifier, or that
    // agent running one) is exactly the kind of thing that happens between a decision and its
    // commit — and it walks the whole subtree and its Sessions, the same two sources the planner
    // used, because an assignee is a pointer somebody can rewrite and a Session is history.
    const verifierAgentId = base62ToUuid(planned.verifierAgentId);
    const verifier = (await tx.$queryRaw<Array<{
      enabled: boolean; deletedAt: Date | null;
      runnerId: string | null; runnerStatus: string | null;
      capabilitiesReportedAt: Date | null; modelCatalog: unknown;
      ownerId: string; implements: boolean;
    }>>(Prisma.sql`
      WITH RECURSIVE subtree("id") AS (
        SELECT ${subjectId}::uuid
        UNION
        SELECT t."id" FROM "task" t JOIN subtree s ON t."parent_task_id" = s."id"
      )
      SELECT w."enabled", w."deleted_at" AS "deletedAt",
             w."runner_id" AS "runnerId", r."status"::text AS "runnerStatus",
             r."capabilities_reported_at" AS "capabilitiesReportedAt",
             r."model_catalog" AS "modelCatalog", w."owner_id" AS "ownerId",
             (EXISTS (SELECT 1 FROM "task" t JOIN subtree s ON s."id" = t."id"
                       WHERE t."assignee_id" = ${verifierAgentId}::uuid)
              OR EXISTS (SELECT 1 FROM "session" sn JOIN subtree s ON s."id" = sn."task_id"
                          WHERE sn."workspace_id" = ${verifierAgentId}::uuid)) AS "implements"
        FROM "project_member" m
        JOIN "workspace" w ON w."id" = m."agent_id"
        LEFT JOIN "runner" r ON r."id" = w."runner_id"
       WHERE m."project_id" = ${lease.projectId}::uuid AND m."agent_id" = ${verifierAgentId}::uuid
    `))[0];
    if (!verifier || !verifier.enabled || verifier.deletedAt || verifier.ownerId !== project.ownerId
      || verifier.runnerId !== base62ToUuid(planned.runnerId)
      || verifier.runnerStatus !== 'ONLINE' || !verifier.capabilitiesReportedAt
      || verifier.implements) {
      return superseded('VERIFICATION_AGENT_NOT_ELIGIBLE', {
        verifierAgentId: planned.verifierAgentId,
      });
    }
    // The engine, re-read from the machine that would run it and from the provider row. Same
    // parser as the planner, so a catalog that moved is a refusal rather than a filing onto a model
    // that is no longer there.
    // The engine's identity, resolved the way the snapshot resolved it and never by falling back.
    //
    // Two shapes, and the PLAN says which one it meant, so the commit point cannot silently take
    // the other: a built-in slug IS its own runtime and has no `model_provider` row (the built-in
    // slugs are reserved, so a configured provider cannot claim one), while a configured provider
    // borrows a runtime, can be switched off, and is visible either to everybody (`owner_id IS
    // NULL`) or to one owner. A row that belongs to a DIFFERENT owner is not this project's
    // provider even though the slug is globally unique — reading it anyway would run this check on
    // somebody else's endpoint.
    const configured = (await tx.$queryRaw<Array<{
      id: string; runtime: string; enabled: boolean; ownerId: string | null;
    }>>(Prisma.sql`
      SELECT "id", "runtime", "enabled", "owner_id" AS "ownerId"
        FROM "model_provider" WHERE "slug" = ${planned.provider}
    `))[0];
    const engineRefusal = (reason: string): ProjectActionEffectRefusal => superseded(
      'VERIFICATION_ENGINE_NOT_AVAILABLE',
      { provider: planned.provider, model: planned.model, reason },
    );
    if (planned.providerScope === 'BUILTIN') {
      if (planned.providerId !== null || configured) return engineRefusal('SLUG_IS_NOT_BUILTIN');
      if (!Object.values(AgentProvider).includes(planned.provider as AgentProvider)
        || planned.runtime !== planned.provider) {
        return engineRefusal('UNKNOWN_BUILTIN_PROVIDER');
      }
    } else {
      if (!configured) return engineRefusal('PROVIDER_MISSING');
      if (!configured.enabled) return engineRefusal('PROVIDER_DISABLED');
      if (planned.providerId !== null && uuidToBase62(configured.id) !== planned.providerId) {
        return engineRefusal('PROVIDER_REPLACED');
      }
      if (configured.runtime !== planned.runtime) return engineRefusal('PROVIDER_RUNTIME_CHANGED');
      const visible = configured.ownerId === null || configured.ownerId === project.ownerId;
      if (!visible) return engineRefusal('PROVIDER_BELONGS_TO_ANOTHER_OWNER');
      const scope = configured.ownerId === null ? 'SHARED' : 'PROJECT_OWNER';
      if (scope !== planned.providerScope) return engineRefusal('PROVIDER_SCOPE_CHANGED');
    }
    const runtime = planned.runtime;
    if (!runnerServesModel(verifier.modelCatalog, runtime, planned.model)) {
      return engineRefusal('MODEL_NOT_IN_RUNNER_CATALOG');
    }

    // Somebody may have filed one by hand in the meantime — the gap this closes is "there is no
    // live check", and a check that arrived from anywhere closes it just as well.
    //
    // Scoped to this project AND this owner: `verifies_task_id` is only guaranteed to name a task
    // in the same project by a service rule, and a row that got past it (or arrived by a raw write)
    // must not be able to answer for a subject it does not belong to. A CANCELLED check is NOT
    // live — somebody stopped it, so the subject is back to having none, which is the gap.
    const existing = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT v."id" FROM "task" v
       WHERE v."verifies_task_id" = ${subjectId}::uuid
         AND v."project_id" = ${lease.projectId}::uuid
         AND v."owner_id" = ${project.ownerId}::uuid
         AND v."status" <> 'CANCELLED'
         AND v."superseded_by_task_id" IS NULL AND v."terminal_reason" IS NULL
       LIMIT 1
    `);
    if (existing[0]) {
      return superseded('VERIFICATION_ALREADY_FILED', {
        subjectTaskId: planned.subjectTaskId,
        verificationTaskId: uuidToBase62(existing[0].id),
      });
    }

    const key = verificationFilingTaskIdempotencyKey(
      lease.projectId, subjectId, planned.generation,
    );
    const id = randomUUID();
    const title = `[VERIFY] ${subject.title}`.slice(0, MAX_TASK_TITLE_CHARS);
    const inserted = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      INSERT INTO "task" (
        "id", "title", "description", "acceptance_criteria", "status", "owner_id",
        "creator_type", "creator_id", "project_id", "parent_task_id", "list_id", "assignee_id",
        "verifies_task_id", "provider", "model", "dispatch_authority", "auto_run_when_ready",
        "idempotency_key", "created_at", "updated_at"
      ) VALUES (
        ${id}::uuid, ${title}, ${filingBrief(planned, subject)},
        ${filingAcceptanceCriteria(planned)}, 'OPEN', ${subject.ownerId}::uuid,
        'USER', ${subject.ownerId}::uuid, ${lease.projectId}::uuid,
        ${subject.parentTaskId}::uuid, ${subject.listId}::uuid,
        ${verifierAgentId}::uuid, ${subjectId}::uuid,
        ${planned.provider}, ${planned.model},
        -- Stated rather than inferred, and load-bearing either way: §7.8's pass only ever
        -- considers COORDINATOR rows, and this column's DEFAULT is LEGACY, so a check that landed
        -- on the default would sit OPEN for ever — this unit's own silent idling, one step further
        -- along. 0122's task_dispatch_authority_derive trigger derives the same value here (the
        -- policy gate above already refused a project with the coordinator disabled); a reader of
        -- this INSERT should not have to go and find that trigger to know the row will run.
        --
        -- auto_run_when_ready stays false on purpose: §2 B3 / §12.3 D4 make it a user setting, not
        -- a way of telling the loop it may run something.
        'COORDINATOR'::"task_dispatch_authority", false,
        ${key}, ${now}, ${now}
      )
      ON CONFLICT ("idempotency_key") DO NOTHING
      RETURNING "id"
    `);
    // DO NOTHING here means the ledger was bypassed and this generation already filed its check.
    // That is the backstop doing its job, not an error: the world already holds what this wanted.
    if (!inserted[0]) {
      return superseded('VERIFICATION_FILING_ALREADY_LANDED', {
        subjectTaskId: planned.subjectTaskId, generation: planned.generation,
      });
    }
    await tx.$executeRaw(Prisma.sql`
      UPDATE "project_action" SET "reason_code" = 'VERIFICATION_FILED', "updated_at" = ${now}
       WHERE "id" = ${actionId}::uuid
    `);
  }
}

/** §7.3's key template, with the generation §13.2 V8-e requires. Internal ids (§8.2). */
export function verificationFilingActionKey(
  projectId: string,
  subjectTaskId: string,
  generation: string,
): string {
  return `pc:v1:${projectId}:file-verification:${subjectTaskId}:${generation}`;
}

/** V8-f's second lock, on the row itself, for a writer that never went through the ledger. */
export function verificationFilingTaskIdempotencyKey(
  projectId: string,
  subjectTaskId: string,
  generation: string,
): string {
  return `pc:v1:${projectId}:file-verification-task:${subjectTaskId}:${generation}`;
}

/**
 * The check's brief.
 *
 * Base62 throughout, like the defect brief §13.2 files: prose is the one surface
 * `PublicIdInterceptor` cannot rewrite, so a UUID here is an id whoever picks the task up cannot
 * hand back to `task_get`.
 */
function filingBrief(planned: PlannedVerificationFiling, subject: SubjectRow): string {
  return [
    `任务「${subject.title}」（id: ${planned.subjectTaskId}）的 completionPolicy 是 `
      + `VERIFICATION_PASSED：它的子任务已经收敛，但没有任何验证任务指向它，`
      + `因此它既不会被派发、也永远不会自动完成。本任务就是补上的那条验证。`,
    '',
    '请独立核对被验证任务的成果是否满足它的验收标准，然后给出 PASS / FAIL / INCONCLUSIVE。',
    '不要替被验证任务重做它的工作；你的产出是结论与证据。',
    '',
    `- 被验证任务：${planned.subjectTaskId}`,
    '',
    '结论用原生 verdict 写在本任务上：PASS 会让被验证任务按 §13.1 自然完成，'
      + 'FAIL 会退回它并建一条缺陷任务。',
  ].join('\n');
}

function filingAcceptanceCriteria(planned: PlannedVerificationFiling): string {
  return `本任务给出针对 ${planned.subjectTaskId} 的结构化 verdict（PASS / FAIL / INCONCLUSIVE），`
    + '并在评论里记录判定依据、执行过的命令与关键输出。';
}

/** The planner's catalog rule, at the commit point. One parser, one answer. */
function runnerServesModel(catalog: unknown, runtime: string, model: string): boolean {
  if (!Object.values(AgentProvider).includes(runtime as AgentProvider)) return false;
  const models = runtimeCatalogModels(catalog, runtime as AgentProvider);
  return models?.some((row) => row.value === model) ?? false;
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
