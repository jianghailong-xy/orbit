import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AgentProvider } from '@orbit/shared';
import {
  normalizeBuiltinPermissionMode,
  normalizeEffortForProvider,
  normalizeRuntimeProvider,
} from '../common/runtime-provider';
import { sanitizeRunnerEngines } from '../common/runner-engines';
import { resolvePermissionMode } from '../common/permission-mode';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { makeBranchName } from '../sessions/naming';
import { buildTaskExecutionPrompt } from '../tasks/tasks.service';
import {
  ProjectApprovalState,
  ProjectAuthorizationAudit,
  ProjectAuthorizationService,
  ProviderAvailability,
} from './project-authorization.service';
import {
  ProjectActionApplyResult,
  ProjectReconcileLease,
  ProjectReconcileService,
} from './project-reconcile.service';
import {
  normalizedCapabilities,
  ProjectRunnerCandidate,
  scheduleProjectRunner,
} from './project-runner-scheduler';

const BUILTIN_PROVIDERS = Object.values(AgentProvider);
const PROVIDER_RETRY_MS = 5 * 60_000;
const RUNNER_RETRY_MS = 60_000;

export interface ProjectTaskDispatchCommand {
  decisionId: string;
  taskId: string;
  idempotencyKey: string;
  approval?: {
    state: ProjectApprovalState;
    targetIdempotencyKey?: string | null;
  };
}

export interface ProjectTaskDispatchResult {
  action: ProjectActionApplyResult;
  sessionId: string | null;
}

interface DispatchRow {
  ownerId: string;
  title: string;
  description: string | null;
  provider: string | null;
  model: string | null;
  isForeman: boolean;
  verifiesTaskId: string | null;
  requiredCapabilities: string[];
  listInstructions: string | null;
  workspaceId: string | null;
  workspaceEnabled: boolean | null;
  enableWorktree: boolean | null;
  workspaceEffort: string | null;
  runnerId: string | null;
  runnerStatus: string | null;
  runnerPosition: number | null;
  runnerCapabilities: string[] | null;
  capabilitiesReportedAt: Date | null;
  engines: unknown;
  runsAsRoot: boolean | null;
  ownerPreferences: unknown;
  coordinatorAgentId: string | null;
  sourceDecisionInputHash: string;
}

interface ProviderRow {
  slug: string;
  runtime: string;
  enabled: boolean;
  models: unknown;
  defaultModel: string | null;
}

/**
 * The only Project path allowed to materialize a task Session. Policy is evaluated by the task-12
 * adapter and runner selection by the pure scheduler; this service only joins their frozen answers
 * to the action and Session in the same transaction.
 */
@Injectable()
export class ProjectTaskDispatcherService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reconciler: ProjectReconcileService,
    private readonly authorization: ProjectAuthorizationService,
    private readonly queue: QueueService,
    private readonly realtime: RealtimeService,
  ) {}

  async dispatch(
    lease: ProjectReconcileLease,
    command: ProjectTaskDispatchCommand,
    now = new Date(),
  ): Promise<ProjectTaskDispatchResult> {
    const action = await this.reconciler.applyDecisionAction(
      lease,
      command.decisionId,
      {
        type: 'DISPATCH_TASK',
        idempotencyKey: command.idempotencyKey,
        subject: { type: 'TASK', id: command.taskId },
      },
      async (tx, actionId) => this.dispatchInTransaction(
        tx,
        lease,
        command,
        actionId,
        now,
      ),
      now,
    );
    const result = await this.prisma.projectAction.findUnique({
      where: { id: action.actionId },
      select: { resultSessionId: true },
    });
    if (action.status === 'APPLIED' && result?.resultSessionId) {
      this.queue.notifySessionQueued();
      this.realtime.publishSessionCreated(result.resultSessionId);
    }
    return { action, sessionId: result?.resultSessionId ?? null };
  }

  private async dispatchInTransaction(
    tx: Prisma.TransactionClient,
    lease: ProjectReconcileLease,
    command: ProjectTaskDispatchCommand,
    actionId: string,
    now: Date,
  ) {
    const rows = await tx.$queryRaw<DispatchRow[]>(Prisma.sql`
      SELECT p."owner_id" AS "ownerId", t."title", t."description", t."provider", t."model",
             t."is_foreman" AS "isForeman", t."verifies_task_id" AS "verifiesTaskId",
             t."required_capabilities" AS "requiredCapabilities",
             l."instructions" AS "listInstructions",
             w."id" AS "workspaceId", w."enabled" AS "workspaceEnabled",
             w."enable_worktree" AS "enableWorktree", w."effort" AS "workspaceEffort",
             r."id" AS "runnerId", r."status"::text AS "runnerStatus",
             r."position" AS "runnerPosition", r."capabilities" AS "runnerCapabilities",
             r."capabilities_reported_at" AS "capabilitiesReportedAt", r."engines",
             r."runs_as_root" AS "runsAsRoot", u."preferences" AS "ownerPreferences",
             d."coordinator_agent_id" AS "coordinatorAgentId",
             d."decision_input_hash" AS "sourceDecisionInputHash"
        FROM "project_decision" d
        JOIN "project" p ON p."id" = d."project_id"
        JOIN "task" t ON t."project_id" = p."id" AND t."id" = ${command.taskId}::uuid
        JOIN "user" u ON u."id" = p."owner_id"
        LEFT JOIN "task_list" l ON l."id" = t."list_id"
        LEFT JOIN "workspace" w ON w."id" = t."assignee_id" AND w."owner_id" = p."owner_id"
        LEFT JOIN "runner" r ON r."id" = w."runner_id" AND r."owner_id" = p."owner_id"
       WHERE d."id" = ${command.decisionId}::uuid
         AND d."project_id" = ${lease.projectId}::uuid
       FOR SHARE OF t
    `);
    const row = rows[0];
    if (!row) {
      return this.refusal('TASK_NOT_OPEN', 'TASK_NOT_OPEN', null, now);
    }
    if (row.runnerId) {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "runner" WHERE "id" = ${row.runnerId}::uuid FOR SHARE
      `);
    }

    const providerRows = await tx.$queryRaw<ProviderRow[]>(Prisma.sql`
      SELECT mp."slug", mp."runtime", mp."enabled", mp."models",
             mp."default_model" AS "defaultModel"
        FROM "model_provider" mp
       WHERE mp."owner_id" IS NULL OR mp."owner_id" = ${row.ownerId}::uuid
       ORDER BY mp."slug"
       FOR SHARE
    `);
    const availability = providerAvailability(providerRows);
    const baseCapabilities = normalizedCapabilities(row.requiredCapabilities ?? []);
    const candidate = runnerCandidate(row);
    const runnerResolution = scheduleProjectRunner({
      capabilities: baseCapabilities,
      candidates: candidate ? [candidate] : [],
    });
    const coordinatorAgentId = row.coordinatorAgentId;
    if (!coordinatorAgentId) {
      return this.refusal('COORDINATOR_NOT_ASSIGNED', 'COORDINATOR_NOT_ASSIGNED', {
        runnerResolution,
      }, now);
    }

    const requestedProvider = row.provider ?? AgentProvider.CLAUDE;
    const audit = await this.authorization.authorizeInTransaction(tx, {
      ownerId: row.ownerId,
      projectId: lease.projectId,
      coordinatorAgentId,
      idempotencyKey: command.idempotencyKey,
      action: 'DISPATCH_TASK',
      taskId: command.taskId,
      sourceDecisionInputHash: row.sourceDecisionInputHash,
      currentActionId: actionId,
      approval: command.approval,
      provider: {
        requestedProvider,
        requestedModel: row.model,
        availability,
      },
      runner: {
        available: candidate?.available ?? false,
        capabilitiesReported: candidate?.capabilitiesReported ?? false,
        capabilities: [...(candidate?.capabilities ?? [])],
        requiredCapabilities: baseCapabilities,
      },
    }, now);
    if (!audit) return this.refusal('PROJECT_NOT_OPEN', 'PROJECT_NOT_OPEN', null, now);
    if (audit.result.decision !== 'ALLOW') {
      const noRunner = audit.result.reasonCode === 'RUNNER_UNAVAILABLE'
        || audit.result.reasonCode === 'RUNTIME_REQUIREMENT_UNMET';
      return this.refusal(
        noRunner ? 'NO_MATCHING_RUNNER' : audit.result.reasonCode,
        audit.result.reasonCode,
        { authorization: audit, runnerResolution },
        now,
        audit.result.retryAt,
      );
    }

    const providerResolution = audit.result.providerResolution;
    if (!providerResolution?.selectedProvider || !candidate || !runnerResolution.selectedRunnerId) {
      return this.refusal('NO_MATCHING_RUNNER', 'RUNNER_UNAVAILABLE', {
        authorization: audit,
        runnerResolution,
      }, now);
    }
    const selectedProvider = providerResolution.selectedProvider;
    const configuredProvider = providerRows.find((provider) => provider.slug === selectedProvider);
    const providerBuiltin = BUILTIN_PROVIDERS.includes(selectedProvider as AgentProvider);
    const runtime = configuredProvider
      ? normalizeRuntimeProvider(configuredProvider.runtime)
      : normalizeRuntimeProvider(selectedProvider, providerBuiltin);
    const runtimeCapability = `runtime:${runtime}`;
    const effectiveCapabilities = normalizedCapabilities([...baseCapabilities, runtimeCapability]);
    const runtimeCandidate: ProjectRunnerCandidate = {
      ...candidate,
      capabilitiesReported: true,
      capabilities: runtimeAvailable(row.engines, runtime, !providerBuiltin)
        ? normalizedCapabilities([...candidate.capabilities, runtimeCapability])
        : candidate.capabilities,
    };
    const finalRunnerResolution = scheduleProjectRunner({
      capabilities: effectiveCapabilities,
      candidates: [runtimeCandidate],
    });
    if (!finalRunnerResolution.selectedRunnerId) {
      return this.refusal('NO_MATCHING_RUNNER', 'RUNTIME_REQUIREMENT_UNMET', {
        authorization: audit,
        runnerResolution: finalRunnerResolution,
      }, now);
    }

    const selectedModel = providerResolution?.selectedModel ?? null;
    const permissionMode = normalizeBuiltinPermissionMode(
      runtime,
      selectedModel ?? '',
      resolvePermissionMode(null, { preferences: row.ownerPreferences }),
      !providerBuiltin,
      row.runsAsRoot,
    );
    const selectedEffort = normalizeEffortForProvider(runtime, row.workspaceEffort) ?? null;
    const resolution = {
      v: 1,
      who: {
        agentId: row.workspaceId,
        source: 'task-assignee',
      },
      with: {
        provider: selectedProvider,
        model: selectedModel,
        effort: selectedEffort,
        source: providerResolution.usedFallback
          ? 'explicit-agent-fallback'
          : row.provider
            ? 'task-pin'
            : 'owner-default',
        ...(providerResolution.usedFallback
          ? {
              pinned: {
                provider: providerResolution.requestedProvider,
                model: providerResolution.requestedModel,
              },
            }
          : {}),
        fallbackHops: providerResolution.fallbackHops,
      },
      where: {
        workspaceId: row.workspaceId,
        runnerId: row.runnerId,
        source: 'task-assignee',
        required: effectiveCapabilities,
        candidatesConsidered: finalRunnerResolution.candidatesConsidered.length,
      },
    };
    const executionResult = {
      provider: selectedProvider,
      model: selectedModel,
      workspaceId: row.workspaceId,
      runnerId: row.runnerId,
      permissionMode,
      requiredCapabilities: effectiveCapabilities,
      resolution,
    };
    const executionContext = {
      v: 1,
      decisionId: command.decisionId,
      actionId,
      frozenAt: now.toISOString(),
      authorization: audit,
      result: executionResult,
    };
    const [digests] = await tx.$queryRaw<Array<{ authorization: string; result: string }>>(Prisma.sql`
      SELECT "coordinator_json_digest"(${JSON.stringify(audit)}::jsonb) AS "authorization",
             "coordinator_json_digest"(${JSON.stringify(executionContext)}::jsonb - 'authorization') AS "result"
    `);
    if (!digests) throw new Error('failed to freeze Project dispatch context');
    await tx.$executeRaw(Prisma.sql`
      UPDATE "project_action"
         SET "execution_context" = ${JSON.stringify(executionContext)}::jsonb,
             "execution_context_digest" = ${digests.authorization},
             "execution_result_digest" = ${digests.result},
             "reason_code" = ${audit.result.reasonCode},
             "detail" = "detail" || ${JSON.stringify({ authorization: audit, resolution })}::jsonb,
             "updated_at" = ${now}
       WHERE "id" = ${actionId}::uuid AND "status" = 'CLAIMED'
    `);

    const prompt = buildTaskExecutionPrompt({
      title: row.title,
      description: row.description,
      isForeman: row.isForeman,
      verifiesTaskId: row.verifiesTaskId,
      list: { instructions: row.listInstructions },
    });
    const sessionId = randomUUID();
    const runtimeSessionId = randomUUID();
    const title = `执行任务：${row.title}`.slice(0, 80);
    const inserted = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      INSERT INTO "session" (
        "id", "title", "branch", "prompt", "status", "provider", "provider_builtin",
        "runtime_session_id", "model", "uses_runtime_default_model", "permission_mode",
        "effort", "workspace_id", "assigned_runner_id", "task_id", "source",
        "creator_id", "owner_id", "project_action_id", "dispatch_origin", "run_source",
        "resolution", "snapshot_frozen_at", "required_capabilities",
        "execution_pin_generation", "updated_at"
      ) VALUES (
        ${sessionId}::uuid, ${title}, ${row.enableWorktree ? makeBranchName(title) : null},
        ${prompt}, 'PENDING', ${selectedProvider}, ${providerBuiltin},
        ${runtime === AgentProvider.CLAUDE ? runtimeSessionId : null}::uuid, ${selectedModel}, true,
        ${permissionMode}, ${selectedEffort},
        ${row.workspaceId}::uuid, ${row.runnerId}::uuid, ${command.taskId}::uuid, 'user',
        ${row.ownerId}::uuid, ${row.ownerId}::uuid, ${actionId}::uuid,
        'PROJECT_COORDINATOR', 'PROJECT_COORDINATOR', ${JSON.stringify(resolution)}::jsonb,
        ${now}, ${effectiveCapabilities}::text[], ${lease.fencingToken}, ${now}
      )
      ON CONFLICT ("task_id") WHERE "task_id" IS NOT NULL AND "deleted_at" IS NULL
        AND "status" IN ('PENDING', 'RUNNING')
      DO NOTHING
      RETURNING "id"
    `);
    if (!inserted[0]) {
      return this.refusal('TASK_ALREADY_RUNNING', 'TASK_ALREADY_RUNNING', {
        authorization: audit,
        resolution,
      }, now);
    }
    await tx.$executeRaw(Prisma.sql`
      UPDATE "project_action" SET "result_session_id" = ${sessionId}::uuid, "updated_at" = ${now}
       WHERE "id" = ${actionId}::uuid AND "status" = 'CLAIMED'
    `);
  }

  private refusal(
    refusalCode: string,
    reasonCode: string,
    detail: unknown,
    now: Date,
    retryAt?: string | null,
  ) {
    const retryable = reasonCode === 'PROVIDER_UNAVAILABLE'
      || reasonCode === 'RUNNER_UNAVAILABLE'
      || reasonCode === 'RUNTIME_REQUIREMENT_UNMET'
      || reasonCode === 'PROJECT_CONCURRENCY_LIMIT'
      || reasonCode === 'AGENT_CONCURRENCY_LIMIT'
      || reasonCode === 'SESSION_BUDGET_EXHAUSTED'
      || reasonCode === 'RETRY_BACKOFF_ACTIVE';
    const fallbackRetryAt = reasonCode === 'PROVIDER_UNAVAILABLE'
      ? new Date(now.getTime() + PROVIDER_RETRY_MS).toISOString()
      : refusalCode === 'NO_MATCHING_RUNNER'
        ? new Date(now.getTime() + RUNNER_RETRY_MS).toISOString()
        : null;
    const detailObject = detail && typeof detail === 'object' && !Array.isArray(detail)
      ? detail as Record<string, unknown>
      : {};
    return {
      status: 'REFUSED' as const,
      refusalCode,
      reasonCode,
      detail: JSON.parse(JSON.stringify({
        ...detailObject,
        dispatchFailure: {
          v: 1,
          refusalCode,
          reasonCode,
          retryable,
          retryAt: retryAt ?? fallbackRetryAt,
        },
      })) as Prisma.InputJsonValue,
    };
  }
}

function runnerCandidate(row: DispatchRow): ProjectRunnerCandidate | null {
  if (!row.workspaceId || !row.runnerId || row.workspaceEnabled !== true) return null;
  return {
    workspaceId: row.workspaceId,
    runnerId: row.runnerId,
    available: row.runnerStatus === 'ONLINE',
    capabilitiesReported: row.capabilitiesReportedAt != null,
    capabilities: normalizedCapabilities(row.runnerCapabilities ?? []),
    position: row.runnerPosition,
  };
}

function runtimeAvailable(engines: unknown, runtime: AgentProvider, configured: boolean): boolean {
  if (configured || runtime === AgentProvider.OPENCODE) return true;
  const health = sanitizeRunnerEngines(engines)?.find((entry) => entry.engine === runtime);
  // Absent/unknown/not-installed remain compatible with existing on-demand installation. Only an
  // online runner's explicit signed-out report is a reliable fail-closed runtime fact.
  return !(health?.installed && health.auth === 'no');
}

function providerAvailability(rows: ProviderRow[]): ProviderAvailability[] {
  return [
    ...BUILTIN_PROVIDERS.map((provider) => ({ provider, available: true, models: null })),
    ...rows.map((row) => ({
      provider: row.slug,
      available: row.enabled,
      models: providerModels(row.models),
      defaultModel: row.defaultModel,
    })),
  ];
}

function providerModels(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry) => {
    if (typeof entry === 'string' && entry.trim()) return [entry.trim()];
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const model = (entry as Record<string, unknown>).value;
      if (typeof model === 'string' && model.trim()) return [model.trim()];
    }
    return [];
  });
}
