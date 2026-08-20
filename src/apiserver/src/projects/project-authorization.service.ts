import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { USAGE_LIMIT_ERROR_MARKERS, uuidToBase62 } from '@orbit/shared';
import {
  MAX_AUTO_RUN_FAILURES,
  retryBackoffUntil,
} from '../tasks/task-retry-policy';

export type ProjectAutomationPolicyValue = 'MANUAL' | 'GUARDED_AUTO' | 'AUTO';

export type ProjectAuthorizationAction =
  | 'SCHEDULE_WAKE'
  | 'NOOP'
  | 'RAISE_BLOCKER'
  | 'CLEAR_BLOCKER'
  | 'AGGREGATE_PARENT'
  | 'REQUEST_APPROVAL'
  | 'DISPATCH_TASK'
  | 'OPEN_COORDINATOR_TURN'
  | 'ROTATE_COORDINATOR_SESSION'
  | 'APPLY_VERIFICATION_VERDICT'
  | 'RUN_PROJECT_ACCEPTANCE'
  | 'SET_PROJECT_DONE'
  | 'DELETE_TASK'
  | 'DELETE_PROJECT'
  | 'CHANGE_ACCEPTANCE_CRITERIA'
  | 'REASSIGN_TASK';

export type ProjectPolicyRowId =
  | 'ALWAYS_SAFE'
  | 'DISPATCH_INITIAL'
  | 'DISPATCH_RETRY'
  | 'DISPATCH_MAX_ATTEMPTS'
  | 'DISPATCH_OVER_LIMIT'
  | 'DISPATCH_PROVIDER_FALLBACK'
  | 'COORDINATOR_ROUTINE'
  | 'PROJECT_ACCEPTANCE'
  | 'USER_CONTROL_ONLY';

export type ProjectPolicyCell = 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';
export type ProjectAuthorizationDecision = ProjectPolicyCell | 'DEFER';
export type ProjectActionRisk = 'LOW' | 'HIGH' | 'PROHIBITED';
export type ProjectRequiredPermission = 'COORDINATE' | 'CREATE_TASK' | 'DELEGATE';
export type ProjectApprovalState = 'NONE' | 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED';

export type ProjectAuthorizationReasonCode =
  | 'POLICY_ALLOWED'
  | 'POLICY_REQUIRES_APPROVAL'
  | 'APPROVAL_PENDING'
  | 'APPROVAL_GRANTED'
  | 'APPROVAL_DENIED'
  | 'APPROVAL_EXPIRED'
  | 'APPROVAL_TARGET_MISMATCH'
  | 'PROJECT_NOT_OPEN'
  | 'COORDINATOR_DISABLED'
  | 'COORDINATOR_NOT_ASSIGNED'
  | 'COORDINATOR_NOT_PROJECT_MEMBER'
  | 'COORDINATOR_AGENT_DISABLED'
  | 'COORDINATOR_PERMISSION_DENIED'
  | 'CREATE_TASK_PERMISSION_DENIED'
  | 'DELEGATE_PERMISSION_DENIED'
  | 'USER_CONTROL_REQUIRED'
  | 'TASK_NOT_OPEN'
  | 'TASK_DISPATCH_HELD'
  | 'TASK_NOT_DUE'
  | 'TASK_DEPENDENCIES_INCOMPLETE'
  | 'TASK_ALREADY_RUNNING'
  | 'WHO_UNRESOLVED'
  | 'WHO_NOT_IN_TEAM'
  | 'WHO_DISABLED'
  | 'RETRY_BACKOFF_ACTIVE'
  | 'MAX_ATTEMPTS_REACHED'
  | 'UNKNOWN_FAILURE'
  | 'PROJECT_CONCURRENCY_LIMIT'
  | 'AGENT_CONCURRENCY_LIMIT'
  | 'SESSION_BUDGET_EXHAUSTED'
  | 'PROVIDER_UNAVAILABLE'
  | 'RUNNER_UNAVAILABLE'
  | 'RUNTIME_REQUIREMENT_UNMET';

export interface ExplicitProviderFallback {
  provider: string;
  model?: string | null;
}

export interface ProviderAvailability {
  provider: string;
  available: boolean;
  models?: string[] | null;
  defaultModel?: string | null;
}

export interface ProjectProviderAuthorizationInput {
  requestedProvider: string;
  requestedModel: string | null;
  // This field is populated from the target Agent row by the transaction adapter. A caller must
  // not invent fallback candidates from fleet availability.
  explicitFallbacks: ExplicitProviderFallback[];
  availability: ProviderAvailability[];
}

export interface ProjectRunnerAuthorizationInput {
  available: boolean;
  capabilitiesReported: boolean;
  capabilities: string[];
  requiredCapabilities: string[];
}

export interface ProjectActionAuthorizationInput {
  v: 1;
  sourceDecisionInputHash: string;
  idempotencyKey: string;
  evaluatedAt: string;
  action: ProjectAuthorizationAction;
  requiredPermission: ProjectRequiredPermission;
  project: {
    id: string;
    status: 'OPEN' | 'DONE' | 'CANCELLED';
    coordinatorEnabled: boolean;
    automationPolicy: ProjectAutomationPolicyValue;
    configRevision: string;
    inFlightTasks: number;
    maxConcurrentTasks: number;
    coordinatorSessionsStartedLast24h: number;
    sessionBudgetPerDay: number | null;
  };
  principal: {
    agentId: string | null;
    coordinatorAgentId: string | null;
    memberRole: 'COORDINATOR' | 'MEMBER' | null;
    agentEnabled: boolean;
    agentDeleted: boolean;
    canCoordinate: boolean;
    canCreateTasks: boolean;
    canDelegate: boolean;
  };
  task?: {
    id: string;
    status: string;
    dispatchHold: boolean;
    runAtDue: boolean;
    dependenciesReady: boolean;
    hasLiveSession: boolean;
    assigneeAgentId: string | null;
    assigneeIsProjectMember: boolean;
    assigneeEnabled: boolean;
    agentInFlightTasks: number;
    agentMaxConcurrentTasks: number | null;
    failureCount: number;
    maxAutoRunFailures: number;
    failureAttributable: boolean;
    retryBackoffUntil: string | null;
  };
  approval: {
    state: ProjectApprovalState;
    targetIdempotencyKey: string | null;
  };
  provider?: ProjectProviderAuthorizationInput;
  runner?: ProjectRunnerAuthorizationInput;
}

export interface ProjectProviderResolution {
  requestedProvider: string;
  requestedModel: string | null;
  selectedProvider: string | null;
  selectedModel: string | null;
  configuredFallbacks: ExplicitProviderFallback[];
  candidatesConsidered: string[];
  fallbackHops: Array<{
    from: string;
    to: string;
    reason: 'PROVIDER_UNAVAILABLE';
  }>;
  usedFallback: boolean;
}

export interface ProjectActionAuthorizationResult {
  v: 1;
  decision: ProjectAuthorizationDecision;
  reasonCode: ProjectAuthorizationReasonCode;
  policyRow: ProjectPolicyRowId;
  risk: ProjectActionRisk;
  providerResolution?: ProjectProviderResolution;
  missingCapabilities?: string[];
  retryAt?: string | null;
  budgetResetsAt?: string | null;
}

export interface ProjectAuthorizationAudit {
  v: 1;
  requestHash: string;
  request: ProjectActionAuthorizationInput;
  result: ProjectActionAuthorizationResult;
}

interface ProjectPolicyMatrixRow {
  id: ProjectPolicyRowId;
  risk: ProjectActionRisk;
  cells: Record<ProjectAutomationPolicyValue, ProjectPolicyCell>;
}

/** The frozen policy matrix. Classification is separate; every policy answer comes from here. */
export const PROJECT_POLICY_MATRIX: readonly ProjectPolicyMatrixRow[] = [
  {
    id: 'ALWAYS_SAFE', risk: 'LOW',
    cells: { MANUAL: 'ALLOW', GUARDED_AUTO: 'ALLOW', AUTO: 'ALLOW' },
  },
  {
    id: 'DISPATCH_INITIAL', risk: 'LOW',
    cells: { MANUAL: 'REQUIRE_APPROVAL', GUARDED_AUTO: 'ALLOW', AUTO: 'ALLOW' },
  },
  {
    id: 'DISPATCH_RETRY', risk: 'LOW',
    cells: { MANUAL: 'REQUIRE_APPROVAL', GUARDED_AUTO: 'ALLOW', AUTO: 'ALLOW' },
  },
  {
    id: 'DISPATCH_MAX_ATTEMPTS', risk: 'HIGH',
    cells: {
      MANUAL: 'REQUIRE_APPROVAL', GUARDED_AUTO: 'REQUIRE_APPROVAL', AUTO: 'REQUIRE_APPROVAL',
    },
  },
  {
    id: 'DISPATCH_OVER_LIMIT', risk: 'HIGH',
    cells: { MANUAL: 'DENY', GUARDED_AUTO: 'DENY', AUTO: 'DENY' },
  },
  {
    id: 'DISPATCH_PROVIDER_FALLBACK', risk: 'HIGH',
    cells: { MANUAL: 'REQUIRE_APPROVAL', GUARDED_AUTO: 'REQUIRE_APPROVAL', AUTO: 'ALLOW' },
  },
  {
    id: 'COORDINATOR_ROUTINE', risk: 'LOW',
    cells: { MANUAL: 'REQUIRE_APPROVAL', GUARDED_AUTO: 'ALLOW', AUTO: 'ALLOW' },
  },
  {
    id: 'PROJECT_ACCEPTANCE', risk: 'HIGH',
    cells: { MANUAL: 'REQUIRE_APPROVAL', GUARDED_AUTO: 'REQUIRE_APPROVAL', AUTO: 'ALLOW' },
  },
  {
    id: 'USER_CONTROL_ONLY', risk: 'PROHIBITED',
    cells: { MANUAL: 'DENY', GUARDED_AUTO: 'DENY', AUTO: 'DENY' },
  },
] as const;

const ALWAYS_SAFE = new Set<ProjectAuthorizationAction>([
  'SCHEDULE_WAKE', 'NOOP', 'RAISE_BLOCKER', 'CLEAR_BLOCKER', 'AGGREGATE_PARENT',
  'REQUEST_APPROVAL',
]);
const COORDINATOR_ROUTINE = new Set<ProjectAuthorizationAction>([
  'OPEN_COORDINATOR_TURN', 'ROTATE_COORDINATOR_SESSION', 'APPLY_VERIFICATION_VERDICT',
]);
const USER_CONTROL_ONLY = new Set<ProjectAuthorizationAction>([
  'SET_PROJECT_DONE', 'DELETE_TASK', 'DELETE_PROJECT', 'CHANGE_ACCEPTANCE_CRITERIA',
  'REASSIGN_TASK',
]);
const SESSION_START_ACTIONS = new Set<ProjectAuthorizationAction>([
  'DISPATCH_TASK', 'ROTATE_COORDINATOR_SESSION',
]);

export function projectPolicyCell(
  policy: ProjectAutomationPolicyValue,
  rowId: ProjectPolicyRowId,
): ProjectPolicyCell {
  const row = PROJECT_POLICY_MATRIX.find((candidate) => candidate.id === rowId);
  if (!row) throw new Error(`unknown Project policy row ${rowId}`);
  return row.cells[policy];
}

export function createProjectAuthorizationAudit(
  request: ProjectActionAuthorizationInput,
): ProjectAuthorizationAudit {
  const requestHash = sha256(request);
  return {
    v: 1,
    requestHash,
    request,
    result: authorizeProjectAction(request),
  };
}

export function replayProjectAuthorizationAudit(audit: ProjectAuthorizationAudit): boolean {
  return audit.v === 1
    && audit.requestHash === sha256(audit.request)
    && canonicalJson(audit.result) === canonicalJson(authorizeProjectAction(audit.request));
}

export function authorizeProjectAction(
  input: ProjectActionAuthorizationInput,
): ProjectActionAuthorizationResult {
  const baseRow = classifyPolicyRow(input, false);
  const baseRisk = riskOf(baseRow);
  const result = (
    decision: ProjectAuthorizationDecision,
    reasonCode: ProjectAuthorizationReasonCode,
    extra: Partial<ProjectActionAuthorizationResult> = {},
  ): ProjectActionAuthorizationResult => ({
    v: 1,
    decision,
    reasonCode,
    policyRow: extra.policyRow ?? baseRow,
    risk: extra.risk ?? baseRisk,
    ...extra,
  });

  if (input.project.status !== 'OPEN') return result('DENY', 'PROJECT_NOT_OPEN');
  if (USER_CONTROL_ONLY.has(input.action)) {
    return result('DENY', 'USER_CONTROL_REQUIRED', {
      policyRow: 'USER_CONTROL_ONLY', risk: 'PROHIBITED',
    });
  }
  if (!input.project.coordinatorEnabled) return result('DENY', 'COORDINATOR_DISABLED');
  if (!input.principal.coordinatorAgentId || !input.principal.agentId
      || input.principal.agentId !== input.principal.coordinatorAgentId) {
    return result('DENY', 'COORDINATOR_NOT_ASSIGNED');
  }
  if (input.principal.memberRole !== 'COORDINATOR') {
    return result('DENY', 'COORDINATOR_NOT_PROJECT_MEMBER');
  }
  if (!input.principal.agentEnabled || input.principal.agentDeleted) {
    return result('DENY', 'COORDINATOR_AGENT_DISABLED');
  }
  if (!input.principal.canCoordinate) {
    return result('DENY', 'COORDINATOR_PERMISSION_DENIED');
  }
  if (input.requiredPermission === 'CREATE_TASK' && !input.principal.canCreateTasks) {
    return result('DENY', 'CREATE_TASK_PERMISSION_DENIED');
  }
  if (input.requiredPermission === 'DELEGATE' && !input.principal.canDelegate) {
    return result('DENY', 'DELEGATE_PERMISSION_DENIED');
  }

  let providerResolution: ProjectProviderResolution | undefined;
  if (input.action === 'DISPATCH_TASK') {
    const taskGate = authorizeTaskState(input);
    if (taskGate) return result(taskGate.decision, taskGate.reasonCode, taskGate.extra);

    if (input.provider) {
      providerResolution = resolveProvider(input.provider);
      if (!providerResolution.selectedProvider) {
        return result('DENY', 'PROVIDER_UNAVAILABLE', { providerResolution });
      }
    }
    if (input.runner && !input.runner.available) {
      return result('DEFER', 'RUNNER_UNAVAILABLE', { providerResolution });
    }
    if (input.runner) {
      const capabilities = new Set(input.runner.capabilities);
      const missing = [...new Set(input.runner.requiredCapabilities)]
        .filter((required) => !input.runner!.capabilitiesReported || !capabilities.has(required))
        .sort();
      if (missing.length > 0) {
        return result('DENY', 'RUNTIME_REQUIREMENT_UNMET', {
          providerResolution,
          missingCapabilities: missing,
        });
      }
    }
  }

  if (input.action === 'DISPATCH_TASK'
      && input.project.inFlightTasks >= input.project.maxConcurrentTasks) {
    return result('DEFER', 'PROJECT_CONCURRENCY_LIMIT', {
      policyRow: 'DISPATCH_OVER_LIMIT', risk: 'HIGH', providerResolution,
    });
  }
  if (input.action === 'DISPATCH_TASK' && input.task?.agentMaxConcurrentTasks != null
      && input.task.agentInFlightTasks >= input.task.agentMaxConcurrentTasks) {
    return result('DEFER', 'AGENT_CONCURRENCY_LIMIT', {
      policyRow: 'DISPATCH_OVER_LIMIT', risk: 'HIGH', providerResolution,
    });
  }
  if (SESSION_START_ACTIONS.has(input.action) && input.project.sessionBudgetPerDay != null
      && input.project.coordinatorSessionsStartedLast24h >= input.project.sessionBudgetPerDay) {
    return result('DEFER', 'SESSION_BUDGET_EXHAUSTED', {
      policyRow: 'DISPATCH_OVER_LIMIT', risk: 'HIGH', providerResolution,
    });
  }

  const rowId = classifyPolicyRow(input, providerResolution?.usedFallback ?? false);
  const cell = projectPolicyCell(input.project.automationPolicy, rowId);
  const risk = riskOf(rowId);
  if (cell === 'DENY') {
    return result('DENY', rowId === 'USER_CONTROL_ONLY'
      ? 'USER_CONTROL_REQUIRED'
      : 'POLICY_REQUIRES_APPROVAL', { policyRow: rowId, risk, providerResolution });
  }
  if (cell === 'ALLOW') {
    return result('ALLOW', 'POLICY_ALLOWED', { policyRow: rowId, risk, providerResolution });
  }

  const approval = input.approval;
  // An approval is authority for exactly one durable action. In particular, an unbound
  // APPROVED bit is not a wildcard grant that may be replayed against another idempotency key.
  if (approval.state === 'APPROVED'
      && approval.targetIdempotencyKey !== input.idempotencyKey) {
    return result('DENY', 'APPROVAL_TARGET_MISMATCH', {
      policyRow: rowId, risk, providerResolution,
    });
  }
  if (approval.state === 'APPROVED') {
    return result('ALLOW', 'APPROVAL_GRANTED', { policyRow: rowId, risk, providerResolution });
  }
  if (approval.state === 'DENIED') {
    return result('DENY', 'APPROVAL_DENIED', { policyRow: rowId, risk, providerResolution });
  }
  if (approval.state === 'PENDING') {
    return result('REQUIRE_APPROVAL', 'APPROVAL_PENDING', {
      policyRow: rowId, risk, providerResolution,
    });
  }
  return result('REQUIRE_APPROVAL', approval.state === 'EXPIRED'
    ? 'APPROVAL_EXPIRED'
    : rowId === 'DISPATCH_MAX_ATTEMPTS'
      ? input.task?.failureAttributable === false ? 'UNKNOWN_FAILURE' : 'MAX_ATTEMPTS_REACHED'
      : 'POLICY_REQUIRES_APPROVAL', { policyRow: rowId, risk, providerResolution });
}

function authorizeTaskState(input: ProjectActionAuthorizationInput): {
  decision: ProjectAuthorizationDecision;
  reasonCode: ProjectAuthorizationReasonCode;
  extra?: Partial<ProjectActionAuthorizationResult>;
} | null {
  const task = input.task;
  if (!task) return { decision: 'DENY', reasonCode: 'TASK_NOT_OPEN' };
  if (task.status !== 'OPEN') return { decision: 'DEFER', reasonCode: 'TASK_NOT_OPEN' };
  if (task.dispatchHold) return { decision: 'DEFER', reasonCode: 'TASK_DISPATCH_HELD' };
  if (!task.runAtDue) return { decision: 'DEFER', reasonCode: 'TASK_NOT_DUE' };
  if (!task.dependenciesReady) {
    return { decision: 'DEFER', reasonCode: 'TASK_DEPENDENCIES_INCOMPLETE' };
  }
  if (task.hasLiveSession) return { decision: 'DEFER', reasonCode: 'TASK_ALREADY_RUNNING' };
  if (!task.assigneeAgentId) return { decision: 'DENY', reasonCode: 'WHO_UNRESOLVED' };
  if (!task.assigneeIsProjectMember) return { decision: 'DENY', reasonCode: 'WHO_NOT_IN_TEAM' };
  if (!task.assigneeEnabled) return { decision: 'DENY', reasonCode: 'WHO_DISABLED' };
  if (task.failureCount > 0 && task.failureCount < task.maxAutoRunFailures
      && task.failureAttributable
      && task.retryBackoffUntil != null
      && Date.parse(task.retryBackoffUntil) > Date.parse(input.evaluatedAt)) {
    return {
      decision: 'DEFER', reasonCode: 'RETRY_BACKOFF_ACTIVE',
      extra: { policyRow: 'DISPATCH_RETRY', retryAt: task.retryBackoffUntil },
    };
  }
  return null;
}

function classifyPolicyRow(
  input: ProjectActionAuthorizationInput,
  usedFallback: boolean,
): ProjectPolicyRowId {
  if (ALWAYS_SAFE.has(input.action)) return 'ALWAYS_SAFE';
  if (USER_CONTROL_ONLY.has(input.action)) return 'USER_CONTROL_ONLY';
  if (input.action === 'RUN_PROJECT_ACCEPTANCE') return 'PROJECT_ACCEPTANCE';
  if (COORDINATOR_ROUTINE.has(input.action)) return 'COORDINATOR_ROUTINE';
  if (input.action === 'DISPATCH_TASK') {
    if (input.project.inFlightTasks >= input.project.maxConcurrentTasks
        || (input.task?.agentMaxConcurrentTasks != null
          && input.task.agentInFlightTasks >= input.task.agentMaxConcurrentTasks)
        || (input.project.sessionBudgetPerDay != null
          && input.project.coordinatorSessionsStartedLast24h >= input.project.sessionBudgetPerDay)) {
      return 'DISPATCH_OVER_LIMIT';
    }
    if (((input.task?.failureCount ?? 0) > 0 && input.task?.failureAttributable === false)
        || (input.task?.failureCount ?? 0)
          >= (input.task?.maxAutoRunFailures ?? MAX_AUTO_RUN_FAILURES)) {
      return 'DISPATCH_MAX_ATTEMPTS';
    }
    if (usedFallback) return 'DISPATCH_PROVIDER_FALLBACK';
    if ((input.task?.failureCount ?? 0) > 0) return 'DISPATCH_RETRY';
    return 'DISPATCH_INITIAL';
  }
  return 'USER_CONTROL_ONLY';
}

function riskOf(rowId: ProjectPolicyRowId): ProjectActionRisk {
  return PROJECT_POLICY_MATRIX.find((row) => row.id === rowId)!.risk;
}

function resolveProvider(input: ProjectProviderAuthorizationInput): ProjectProviderResolution {
  const considered = [input.requestedProvider];
  const requested = findAvailableProvider(
    input.availability,
    input.requestedProvider,
    input.requestedModel,
  );
  if (requested) {
    return {
      requestedProvider: input.requestedProvider,
      requestedModel: input.requestedModel,
      selectedProvider: requested.provider,
      selectedModel: input.requestedModel ?? requested.defaultModel ?? null,
      configuredFallbacks: input.explicitFallbacks,
      candidatesConsidered: considered,
      fallbackHops: [],
      usedFallback: false,
    };
  }

  for (const fallback of input.explicitFallbacks) {
    considered.push(fallback.provider);
    const available = findAvailableProvider(
      input.availability,
      fallback.provider,
      fallback.model ?? null,
    );
    if (!available) continue;
    return {
      requestedProvider: input.requestedProvider,
      requestedModel: input.requestedModel,
      selectedProvider: fallback.provider,
      selectedModel: fallback.model ?? available.defaultModel ?? null,
      configuredFallbacks: input.explicitFallbacks,
      candidatesConsidered: considered,
      fallbackHops: [{
        from: input.requestedProvider,
        to: fallback.provider,
        reason: 'PROVIDER_UNAVAILABLE',
      }],
      usedFallback: true,
    };
  }
  return {
    requestedProvider: input.requestedProvider,
    requestedModel: input.requestedModel,
    selectedProvider: null,
    selectedModel: null,
    configuredFallbacks: input.explicitFallbacks,
    candidatesConsidered: considered,
    fallbackHops: [],
    usedFallback: false,
  };
}

function findAvailableProvider(
  candidates: ProviderAvailability[],
  provider: string,
  model: string | null,
): ProviderAvailability | undefined {
  return candidates.find((candidate) => candidate.provider === provider
    && candidate.available
    && (model == null || candidate.models == null || candidate.models.includes(model)));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  return value;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

interface AuthorizationProjectRow {
  id: string;
  status: 'OPEN' | 'DONE' | 'CANCELLED';
  coordinatorEnabled: boolean;
  automationPolicy: ProjectAutomationPolicyValue;
  configRevision: bigint;
  maxConcurrentTasks: number;
  sessionBudgetPerDay: number | null;
  coordinatorAgentId: string | null;
}

interface AuthorizationAgentRow {
  id: string;
  role: 'COORDINATOR' | 'MEMBER' | null;
  enabled: boolean;
  deletedAt: Date | null;
  canCreateTasks: boolean;
  canDelegate: boolean;
  maxConcurrentTasks: number | null;
  providerFallbacks: unknown;
}

export interface ProjectAuthorizationTransactionCommand {
  ownerId: string;
  projectId: string;
  coordinatorAgentId: string;
  idempotencyKey: string;
  action: ProjectAuthorizationAction;
  requiredPermission?: ProjectRequiredPermission;
  taskId?: string;
  sourceDecisionInputHash: string;
  approval?: {
    state: ProjectApprovalState;
    targetIdempotencyKey?: string | null;
  };
  provider?: Omit<ProjectProviderAuthorizationInput, 'explicitFallbacks'>;
  runner?: ProjectRunnerAuthorizationInput;
}

/**
 * Commit-time, side-effect-free authorization adapter. It locks the Project row and reads every
 * mutable admission fact in the caller's transaction; task 13 can create the Session in that same
 * transaction after ALLOW. This unit deliberately does not dispatch anything itself.
 */
@Injectable()
export class ProjectAuthorizationService {
  async authorizeInTransaction(
    tx: Prisma.TransactionClient,
    command: ProjectAuthorizationTransactionCommand,
    now = new Date(),
  ): Promise<ProjectAuthorizationAudit | null> {
    const projects = await tx.$queryRaw<AuthorizationProjectRow[]>(Prisma.sql`
      SELECT p."id", p."status"::text, p."coordinator_enabled" AS "coordinatorEnabled",
             p."automation_policy"::text AS "automationPolicy",
             p."config_revision" AS "configRevision",
             p."max_concurrent_tasks" AS "maxConcurrentTasks",
             p."session_budget_per_day" AS "sessionBudgetPerDay",
             coordinator."agent_id" AS "coordinatorAgentId"
        FROM "project" p
        LEFT JOIN LATERAL (
          SELECT pm."agent_id" FROM "project_member" pm
           WHERE pm."project_id" = p."id" AND pm."role"::text = 'COORDINATOR'
           ORDER BY pm."id" LIMIT 1
        ) coordinator ON true
       WHERE p."id" = ${command.projectId}::uuid AND p."owner_id" = ${command.ownerId}::uuid
       FOR NO KEY UPDATE OF p
    `);
    const project = projects[0];
    if (!project) return null;

    const agents = await tx.$queryRaw<AuthorizationAgentRow[]>(Prisma.sql`
      SELECT w."id", pm."role"::text, w."enabled", w."deleted_at" AS "deletedAt",
             w."can_create_tasks" AS "canCreateTasks", w."can_delegate" AS "canDelegate",
             w."max_concurrent_tasks" AS "maxConcurrentTasks",
             w."provider_fallbacks" AS "providerFallbacks"
        FROM "workspace" w
        JOIN "project_member" pm
          ON pm."project_id" = ${command.projectId}::uuid AND pm."agent_id" = w."id"
       WHERE w."id" = ${command.coordinatorAgentId}::uuid
         AND w."owner_id" = ${command.ownerId}::uuid
       FOR SHARE OF w, pm
    `);
    const principal = agents[0];

    const taskRows = command.taskId == null ? [] : await tx.$queryRaw<Array<{
      id: string; status: string; dispatchHold: boolean; runAt: Date | null; assigneeAgentId: string | null;
    }>>(Prisma.sql`
      SELECT t."id", t."status"::text, t."dispatch_hold" AS "dispatchHold",
             t."run_at" AS "runAt", t."assignee_id" AS "assigneeAgentId"
        FROM "task" t
       WHERE t."id" = ${command.taskId}::uuid AND t."project_id" = ${command.projectId}::uuid
         AND t."owner_id" = ${command.ownerId}::uuid
       FOR SHARE
    `);
    const task = taskRows[0];

    const targetAgents = !task?.assigneeAgentId ? []
      : await tx.$queryRaw<AuthorizationAgentRow[]>(Prisma.sql`
          SELECT w."id", pm."role"::text, w."enabled", w."deleted_at" AS "deletedAt",
                 w."can_create_tasks" AS "canCreateTasks", w."can_delegate" AS "canDelegate",
                 w."max_concurrent_tasks" AS "maxConcurrentTasks",
                 w."provider_fallbacks" AS "providerFallbacks"
            FROM "workspace" w
            JOIN "project_member" pm
              ON pm."project_id" = ${command.projectId}::uuid AND pm."agent_id" = w."id"
           WHERE w."id" = ${task.assigneeAgentId}::uuid AND w."owner_id" = ${command.ownerId}::uuid
           FOR SHARE OF w, pm
        `);
    const targetAgent = targetAgents[0];

    const [projectConcurrency] = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT count(*)::int AS "count" FROM "session" s
        JOIN "task" t ON t."id" = s."task_id"
       WHERE t."project_id" = ${command.projectId}::uuid
         AND t."owner_id" = ${command.ownerId}::uuid AND s."owner_id" = ${command.ownerId}::uuid
         AND s."deleted_at" IS NULL AND s."status"::text IN ('PENDING', 'RUNNING')
    `);
    const [agentConcurrency] = !task?.assigneeAgentId ? [{ count: 0 }]
      : await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
          SELECT count(*)::int AS "count" FROM "session" s
            JOIN "task" t ON t."id" = s."task_id"
           WHERE t."project_id" = ${command.projectId}::uuid
             AND t."owner_id" = ${command.ownerId}::uuid AND s."owner_id" = ${command.ownerId}::uuid
             AND t."assignee_id" = ${task.assigneeAgentId}::uuid
             AND s."deleted_at" IS NULL AND s."status"::text IN ('PENDING', 'RUNNING')
        `);
    const [dailyBudget] = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT count(*)::int AS "count" FROM "project_action" a
       WHERE a."project_id" = ${command.projectId}::uuid
         AND a."type"::text IN ('DISPATCH_TASK', 'ROTATE_COORDINATOR_SESSION')
         AND a."status"::text IN ('CLAIMED', 'APPLIED')
         AND a."created_at" >= ${new Date(now.getTime() - 24 * 60 * 60 * 1_000)}
    `);
    const [dependencyState] = command.taskId == null ? [{ incomplete: 0 }]
      : await tx.$queryRaw<Array<{ incomplete: number }>>(Prisma.sql`
          SELECT count(*)::int AS "incomplete" FROM "task_dependency" d
            JOIN "task" prerequisite ON prerequisite."id" = d."depends_on_task_id"
           WHERE d."task_id" = ${command.taskId}::uuid
             AND prerequisite."owner_id" = ${command.ownerId}::uuid
             AND prerequisite."status"::text <> 'DONE'
        `);
    const [liveTask] = command.taskId == null ? [{ count: 0 }]
      : await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
          SELECT count(*)::int AS "count" FROM "session" s
           WHERE s."task_id" = ${command.taskId}::uuid AND s."owner_id" = ${command.ownerId}::uuid
             AND s."deleted_at" IS NULL AND s."status"::text IN ('PENDING', 'RUNNING')
        `);
    const failures = command.taskId == null ? []
      : await tx.$queryRaw<Array<{ createdAt: Date; error: string | null }>>(Prisma.sql`
          SELECT s."created_at" AS "createdAt", s."error"
            FROM "session" s
           WHERE s."task_id" = ${command.taskId}::uuid AND s."owner_id" = ${command.ownerId}::uuid
             AND s."status"::text = 'FAILED'
           ORDER BY s."created_at", s."id"
        `);
    const countedFailures = failures.filter((failure) => !isUsageLimitFailure(failure.error));
    const lastFailure = countedFailures.at(-1) ?? null;
    const backoffUntil = retryBackoffUntil(countedFailures.length, lastFailure?.createdAt ?? null);
    const fallbackSource = targetAgent ?? principal;
    const explicitFallbacks = parseFallbacks(fallbackSource?.providerFallbacks);

    return createProjectAuthorizationAudit({
      v: 1,
      sourceDecisionInputHash: command.sourceDecisionInputHash,
      idempotencyKey: command.idempotencyKey,
      evaluatedAt: now.toISOString(),
      action: command.action,
      requiredPermission: command.requiredPermission ?? 'COORDINATE',
      project: {
        id: uuidToBase62(project.id),
        status: project.status,
        coordinatorEnabled: project.coordinatorEnabled,
        automationPolicy: project.automationPolicy,
        configRevision: String(project.configRevision),
        inFlightTasks: projectConcurrency?.count ?? 0,
        maxConcurrentTasks: project.maxConcurrentTasks,
        coordinatorSessionsStartedLast24h: dailyBudget?.count ?? 0,
        sessionBudgetPerDay: project.sessionBudgetPerDay,
      },
      principal: {
        agentId: uuidToBase62(principal?.id ?? command.coordinatorAgentId),
        coordinatorAgentId: project.coordinatorAgentId == null
          ? null
          : uuidToBase62(project.coordinatorAgentId),
        memberRole: principal?.role ?? null,
        agentEnabled: principal?.enabled ?? false,
        agentDeleted: principal?.deletedAt != null,
        canCoordinate: principal?.role === 'COORDINATOR',
        canCreateTasks: principal?.canCreateTasks ?? false,
        canDelegate: principal?.canDelegate ?? false,
      },
      ...(command.action === 'DISPATCH_TASK'
        ? {
            task: {
              id: task?.id == null ? '' : uuidToBase62(task.id),
              status: task?.status ?? 'MISSING',
              dispatchHold: task?.dispatchHold ?? true,
              runAtDue: task?.runAt == null || task.runAt <= now,
              dependenciesReady: (dependencyState?.incomplete ?? 0) === 0,
              hasLiveSession: (liveTask?.count ?? 0) > 0,
              assigneeAgentId: task?.assigneeAgentId == null
                ? null
                : uuidToBase62(task.assigneeAgentId),
              assigneeIsProjectMember: targetAgent?.role != null,
              assigneeEnabled: targetAgent?.enabled === true && targetAgent.deletedAt == null,
              agentInFlightTasks: agentConcurrency?.count ?? 0,
              agentMaxConcurrentTasks: targetAgent?.maxConcurrentTasks ?? null,
              failureCount: countedFailures.length,
              maxAutoRunFailures: MAX_AUTO_RUN_FAILURES,
              failureAttributable: countedFailures.every((failure) => Boolean(failure.error?.trim())),
              retryBackoffUntil: backoffUntil?.toISOString() ?? null,
            },
          }
        : {}),
      approval: {
        state: command.approval?.state ?? 'NONE',
        targetIdempotencyKey: command.approval?.targetIdempotencyKey ?? null,
      },
      ...(command.provider
        ? { provider: { ...command.provider, explicitFallbacks } }
        : {}),
      ...(command.runner ? { runner: command.runner } : {}),
    });
  }
}

function parseFallbacks(value: unknown): ExplicitProviderFallback[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const item = candidate as Record<string, unknown>;
    if (typeof item.provider !== 'string' || !item.provider.trim()) return [];
    if (item.model != null && typeof item.model !== 'string') return [];
    return [{ provider: item.provider, ...(item.model == null ? {} : { model: item.model }) }];
  });
}

function isUsageLimitFailure(error: string | null): boolean {
  if (!error) return false;
  const normalized = error.toLocaleLowerCase();
  return USAGE_LIMIT_ERROR_MARKERS.some((marker) =>
    normalized.includes(marker.toLocaleLowerCase()));
}
