import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AgentProvider,
  ROOT_FALLBACK_PERMISSION_MODE,
  RunEventType,
  permissionModeAvailableOnRunner,
} from '@orbit/shared';
import {
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
import { ProjectBlockerKind } from './project-blocker';
import { DispatchBlockingRow, openBlockersStoppingDispatch } from './project-blocker-guard';

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
    const [result] = await this.prisma.$queryRaw<Array<{
      resultSessionId: string | null; ownerId: string; retriedFromFailed: boolean | null;
    }>>(Prisma.sql`
      SELECT a."result_session_id" AS "resultSessionId", p."owner_id" AS "ownerId",
             (a."detail" ->> 'retriedFromFailed')::boolean AS "retriedFromFailed"
        FROM "project_action" a JOIN "project" p ON p."id" = a."project_id"
       WHERE a."id" = ${action.actionId}::uuid
    `);
    if (action.status === 'APPLIED' && result?.resultSessionId) {
      this.queue.notifySessionQueued();
      this.realtime.publishSessionCreated(result.resultSessionId);
      // Read back from the ledger, never from a flag this process kept: the flip and the row that
      // records it commit together, so a rolled-back dispatch cannot announce a retry that did not
      // happen. Without this the task keeps its Failed pill and its Failed filter position on every
      // open client until something else happens to refetch it — the retry looks like it never ran,
      // which is the same invisibility `clearFailedForRetry` publishes against on the legacy path.
      if (result.retriedFromFailed) {
        this.realtime.publishForUser(result.ownerId, RunEventType.TASK_CHANGED, command.taskId);
      }
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

    // §11 BL1/BL2: an open blocker means this step is KNOWN not to be able to go forward, so the
    // dispatch stops here rather than being re-litigated by the resolution chain. Project-scoped
    // rows stop everything (there is nowhere to run, no coordinator, no budget, a cycle, or an
    // unclassified failure); task-scoped rows stop their own task.
    //
    // The refusal code is deliberately its own — `PROJECT_BLOCKED` is in §11.2's non-blocking list,
    // so a stopped dispatch cannot breed a second blocker about being stopped, and the detector
    // reads THROUGH it to the attempt that actually said something.
    const blocking = await tx.$queryRaw<DispatchBlockingRow[]>(
      openBlockersStoppingDispatch(lease.projectId, command.taskId),
    );
    if (blocking.length > 0) {
      return this.refusal('PROJECT_BLOCKED', 'PROJECT_BLOCKED', {
        blockers: blocking.map((blocker) => ({
          blockerId: blocker.id,
          kind: blocker.kind as ProjectBlockerKind,
          owner: blocker.owner,
          subjectType: blocker.subjectType,
          requiredAction: blocker.requiredAction,
        })),
      }, now);
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
        noRunner ? 'NO_MATCHING_RUNNER' : wireRefusalCode(audit.result.reasonCode),
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
    const permissionIntent = resolvePermissionMode(null, { preferences: row.ownerPreferences });
    // The Project snapshot freezes the account's permission intent. Whether Auto is available is
    // model-dependent and the runtime-default model is not known until Queue claim, so normalizing
    // it here would permanently turn Auto into Default for every built-in Claude task with a null
    // model. Bypass on a root runner is different: Claude cannot start at all, and this safe
    // narrowing is already part of the immutable execution result.
    const permissionMode = permissionModeAvailableOnRunner(permissionIntent, row.runsAsRoot)
      ? permissionIntent
      : ROOT_FALLBACK_PERMISSION_MODE;
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
        "execution_pin_generation", "starts_task_work", "updated_at"
      ) VALUES (
        ${sessionId}::uuid, ${title}, ${row.enableWorktree ? makeBranchName(title) : null},
        ${prompt}, 'PENDING', ${selectedProvider}, ${providerBuiltin},
        ${runtime === AgentProvider.CLAUDE ? runtimeSessionId : null}::uuid, ${selectedModel}, true,
        ${permissionMode}, ${selectedEffort},
        ${row.workspaceId}::uuid, ${row.runnerId}::uuid, ${command.taskId}::uuid, 'user',
        ${row.ownerId}::uuid, ${row.ownerId}::uuid, ${actionId}::uuid,
        'PROJECT_COORDINATOR', 'PROJECT_COORDINATOR', ${JSON.stringify(resolution)}::jsonb,
        ${now}, ${effectiveCapabilities}::text[], ${lease.fencingToken}, true, ${now}
      )
      ON CONFLICT ("task_id") WHERE "task_id" IS NOT NULL AND "deleted_at" IS NULL
        AND "status" IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
      DO NOTHING
      RETURNING "id"
    `);
    // The predicate above must be spelled EXACTLY as `session_task_execution_claim_idx` is (0130),
    // or PostgreSQL infers no index and the INSERT raises instead of landing here. It is the same
    // four statuses §4.2 guard 5 calls live: a run paused at `AWAITING_INPUT` holds its task, and
    // the two-status version of this predicate is what let a second Session be opened on a
    // conversation somebody was in the middle of.
    if (!inserted[0]) {
      return this.refusal('TASK_ALREADY_RUNNING', 'TASK_ALREADY_RUNNING', {
        authorization: audit,
        resolution,
      }, now);
    }
    // §9.5 Q3 row 3, the write half (`PC-CX-64`). A retry that leaves the task at `FAILED` is a
    // retry nobody can see: the row keeps the status of the run that died while a live Session sits
    // on it, it stays counted under Failed, and §7.2 TU2 would read the same episode as still
    // unmoved. `IN_PROGRESS` and not `OPEN` is the target for the reason the legacy sweep already
    // picked it (`clearFailedForRetry`): it is the status `reclaimStalledTask` rewrites when a run
    // ends badly, so a retry that fails again lands back at `FAILED` instead of silently parking as
    // actionable.
    //
    // In THIS transaction, next to the Session insert, because the two are one act: §8.3's
    // exactly-once-effect is a property of the action's effect, and a flip committed separately
    // could survive a rolled-back dispatch (a task marked running with nothing running) or be lost
    // by one (a running task marked failed). Conditional on `FAILED` so a status somebody else
    // wrote in the meantime — a person cancelling it, the run itself reporting — is never dragged
    // backwards, which is the same compare-and-set `clearFailedForRetry` uses.
    //
    // The failed Session is deliberately untouched. It is the evidence §6.1 counts failures from
    // and §9.5's ladder is measured in; rewriting it would reset the very budget this dispatch is
    // spending, and the run's own history would say it never failed.
    const retried = await tx.$executeRaw(Prisma.sql`
      UPDATE "task" SET "status" = 'IN_PROGRESS', "updated_at" = ${now}
       WHERE "id" = ${command.taskId}::uuid AND "owner_id" = ${row.ownerId}::uuid
         AND "status" = 'FAILED'
    `);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "project_action"
         SET "result_session_id" = ${sessionId}::uuid,
             "detail" = "detail" || ${JSON.stringify({ retriedFromFailed: retried > 0 })}::jsonb,
             "updated_at" = ${now}
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

/**
 * §13.1 AG6's mixed-version wire rule: the code that goes in `project_action.refusal_code` must be
 * one every reader in the fleet ALREADY classifies.
 *
 * `refusal_code` is not a log line — it is a durable column that other processes read and turn into
 * §11 rows. BL2 fails an unrecognised code CLOSED, to `UNKNOWN_FAILURE`, whose subject is the
 * PROJECT, and §11 BL1 reads a PROJECT-subject row as "stop everything". So during a rolling deploy
 * a NEW replica writing a code the OLD replica's frozen non-blocking list does not contain would
 * stop that project's dispatch entirely, permanently — and §11.4 could never clear it, because it
 * clears rows only by letting an attempt through and watching it not be refused, and this one
 * always will be. Adding the code to this build's list fixes THIS build's reader and does nothing
 * at all for the one still running next to it.
 *
 * `STALE_SNAPSHOT` is the code that goes on the wire, and it is not a euphemism: reaching this gate
 * at all means the plan was made against a world that no longer describes the task. §7.8's pass
 * skips an aggregate parent, so a candidate that arrives here either gained its children after the
 * snapshot was taken or was proposed by a replica that does not have the rule — both are exactly
 * "the snapshot this action was planned from is out of date". Old readers already treat it as
 * non-blocking, and it already means "re-plan", which is the correct next step.
 *
 * The precise reason is not lost, it is just not on the wire: `reasonCode` carries
 * `TASK_AGGREGATE_PARENT` verbatim, the authorization audit in `detail` carries the facts the gate
 * read, and both are what a person and this build's own tooling see. Only the one column old code
 * branches on is held to the old vocabulary.
 *
 * This mapping is what a fleet capability gate would otherwise be needed for. When there is a
 * provable one — every reader at or past this release — this function is the single place that has
 * to change.
 */
export function wireRefusalCode(reasonCode: string): string {
  return reasonCode === 'TASK_AGGREGATE_PARENT' ? 'STALE_SNAPSHOT' : reasonCode;
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
