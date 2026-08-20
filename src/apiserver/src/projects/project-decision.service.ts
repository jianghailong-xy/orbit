import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AgentProvider, uuidToBase62 } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';

export const PROJECT_DECISION_INPUT_VERSION = 1 as const;

export type ProjectDecisionRunState =
  | 'PLANNING'
  | 'EXECUTING'
  | 'AWAITING_VERIFICATION'
  | 'BLOCKED'
  | 'AWAITING_HUMAN'
  | 'ACCEPTANCE'
  | 'SETTLED';

export interface ProjectDecisionInput {
  v: typeof PROJECT_DECISION_INPUT_VERSION;
  readAt: string;
  decisionInputHash: string;
  world: {
    project: {
      id: string;
      ownerId: string;
      title: string;
      goal: string | null;
      acceptanceCriteria: string | null;
      status: 'OPEN' | 'DONE' | 'CANCELLED';
      coordinatorEnabled: boolean;
      automationPolicy: string;
      maxConcurrentTasks: number;
      sessionBudgetPerDay: number | null;
      configRevision: string;
      coordinatorAgentId: string | null;
      coordinatorSessionId: string | null;
      coordinatorWorkspaceId: string | null;
    };
    runtime: {
      runState: ProjectDecisionRunState;
      fencingToken: string;
      coordinatorGeneration: string;
      nextWakeAt: string | null;
      acceptanceAttempt: string;
    };
    team: Array<{
      projectMemberId: string;
      agentId: string;
      role: string;
      enabled: boolean;
      deletedAt: string | null;
      runnerId: string | null;
      model: string | null;
      effort: string | null;
    }>;
    tasks: Array<{
      id: string;
      title: string;
      contentHash: string;
      status: string;
      parentTaskId: string | null;
      assigneeAgentId: string | null;
      provider: string | null;
      model: string | null;
      autoRunWhenReady: boolean;
      dispatchHold: boolean;
      runAt: string | null;
      verifiesTaskId: string | null;
      dependsOnTaskIds: string[];
      liveSessionIds: string[];
      updatedAt: string;
    }>;
    sessions: Array<{
      id: string;
      taskId: string | null;
      workspaceId: string | null;
      assignedRunnerId: string | null;
      runStatus: string;
      provider: string;
      model: string | null;
      permissionMode: string | null;
      effort: string | null;
      createdAt: string;
      startedAt: string | null;
      finishedAt: string | null;
      completedAt: string | null;
      deletedAt: string | null;
    }>;
    coordinatorSession: {
      id: string;
      runStatus: string;
      workspaceId: string | null;
      assignedRunnerId: string | null;
      startedAt: string | null;
      finishedAt: string | null;
      completedAt: string | null;
      deletedAt: string | null;
    } | null;
    workspaces: Array<{
      workspaceId: string;
      runnerId: string | null;
      enabled: boolean;
      deletedAt: string | null;
      model: string | null;
      effort: string | null;
      defaultMergeTarget: string | null;
      workDirExists: boolean | null;
      workDirIsGit: boolean | null;
      workDirProbedAt: string | null;
    }>;
    runners: Array<{
      runnerId: string;
      status: string;
      labels: string[];
      version: string | null;
      lastHeartbeatAt: string | null;
      modelCatalog: unknown;
    }>;
    providers: Array<{
      providerId: string | null;
      slug: string;
      runtime: string;
      enabled: boolean;
      models: unknown;
      defaultModel: string | null;
      scope: 'BUILTIN' | 'SHARED' | 'PROJECT_OWNER';
    }>;
    actions: Array<{
      actionId: string;
      type: string;
      status: string;
      subjectType: string;
      subjectId: string | null;
      decisionId: string | null;
      resultSessionId: string | null;
      refusalCode: string | null;
      idempotencyKeyHash: string;
      detailHash: string;
      createdAt: string;
    }>;
    evidence: {
      branches: Array<{
        sessionId: string;
        taskId: string | null;
        branch: string;
        baseSha: string | null;
        worktreeBranch: string | null;
        worktreeDirty: boolean | null;
        commitStatus: string | null;
        mergeStatus: string | null;
        mergeTarget: string | null;
        mergedSourceSha: string | null;
        branchMerged: boolean | null;
        changedFiles: unknown;
      }>;
      tests: Array<{
        verificationTaskId: string;
        verifiesTaskId: string;
        taskStatus: string;
        sessionId: string | null;
        runStatus: string | null;
        finishedAt: string | null;
        resultHash: string | null;
        errorHash: string | null;
      }>;
    };
  };
  evaluation: {
    epoch: number;
    dueTasks: Record<string, { runAtDue: boolean }>;
  };
  signals: Array<{ eventId: string; kind: 'user.manual_trigger'; dedupeKey: string }>;
}

export interface ProjectDecisionOutcome {
  v: 1;
  reconcileId: string;
  fencingToken: string;
  decisionInputHash: string;
  configRevision: string;
  runStateBefore: ProjectDecisionRunState;
  runStateAfter: ProjectDecisionRunState;
  decidedBy: 'ORCHESTRATOR' | 'COORDINATOR_AGENT';
  reason: string;
  actions: Array<{
    type: string;
    idempotencyKey: string;
    subject: { type: string; id?: string | null };
  }>;
  blockersOpened: string[];
  blockersCleared: string[];
  nextWakeAt: string | null;
  nextWakeReason: string | null;
  consumedEventIds: string[];
}

export interface CapturedProjectDecisionInput {
  input: ProjectDecisionInput;
  attribution: {
    ownerId: string;
    coordinatorAgentId: string | null;
    coordinatorSessionId: string | null;
  };
}

export interface PersistedProjectDecision {
  id: string;
  input: ProjectDecisionInput;
  outcome: ProjectDecisionOutcome;
}

interface ProjectRow {
  id: string;
  ownerId: string;
  title: string;
  goal: string | null;
  acceptanceCriteria: string | null;
  status: 'OPEN' | 'DONE' | 'CANCELLED';
  coordinatorEnabled: boolean;
  automationPolicy: string;
  maxConcurrentTasks: number;
  sessionBudgetPerDay: number | null;
  configRevision: bigint;
  coordinatorAgentId: string | null;
  coordinatorSessionId: string | null;
  coordinatorWorkspaceId: string | null;
  runState: ProjectDecisionRunState;
  fencingToken: bigint;
  coordinatorGeneration: bigint;
  nextWakeAt: Date | null;
  acceptanceAttempt: bigint;
}

interface TeamRow {
  projectMemberId: string;
  agentId: string;
  role: string;
  enabled: boolean;
  deletedAt: Date | null;
  runnerId: string | null;
  model: string | null;
  effort: string | null;
}

interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  acceptanceCriteria: string | null;
  labels: string[];
  status: string;
  parentTaskId: string | null;
  assigneeAgentId: string | null;
  provider: string | null;
  model: string | null;
  autoRunWhenReady: boolean;
  dispatchHold: boolean;
  runAt: Date | null;
  verifiesTaskId: string | null;
  updatedAt: Date;
}

interface DependencyRow {
  taskId: string;
  dependsOnTaskId: string;
}

interface SessionRow {
  id: string;
  taskId: string | null;
  workspaceId: string | null;
  assignedRunnerId: string | null;
  status: string;
  provider: string;
  model: string | null;
  permissionMode: string | null;
  effort: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  completedAt: Date | null;
  deletedAt: Date | null;
  result: string | null;
  error: string | null;
  branch: string | null;
  baseSha: string | null;
  changedFiles: unknown;
  mergeStatus: string | null;
  mergedSourceSha: string | null;
  mergeTarget: string | null;
  branchMerged: boolean | null;
  worktreeBranch: string | null;
  worktreeDirty: boolean | null;
  commitStatus: string | null;
}

interface WorkspaceRow {
  workspaceId: string;
  runnerId: string | null;
  enabled: boolean;
  deletedAt: Date | null;
  model: string | null;
  effort: string | null;
  defaultMergeTarget: string | null;
  workDirExists: boolean | null;
  workDirIsGit: boolean | null;
  workDirProbedAt: Date | null;
}

interface RunnerRow {
  runnerId: string;
  status: string;
  labels: string[];
  version: string | null;
  lastHeartbeatAt: Date | null;
  modelCatalog: unknown;
}

interface ProviderRow {
  providerId: string;
  slug: string;
  runtime: string;
  enabled: boolean;
  models: unknown;
  defaultModel: string | null;
  ownerId: string | null;
}

interface ActionRow {
  actionId: string;
  idempotencyKey: string;
  type: string;
  status: string;
  subjectType: string;
  subjectId: string | null;
  decisionId: string | null;
  resultSessionId: string | null;
  refusalCode: string | null;
  detail: unknown;
  createdAt: Date;
}

interface SignalRow {
  id: string;
  kind: 'user.manual_trigger';
  dedupeKey: string;
}

interface DecisionRow {
  id: string;
  projectId: string;
  ownerId: string;
  decisionInputHash: string;
  decisionInput: unknown;
  outcome: unknown;
  decidedBy: 'ORCHESTRATOR' | 'COORDINATOR_AGENT';
  coordinatorAgentId: string | null;
  coordinatorSessionId: string | null;
  fencingToken: bigint;
  reason: string;
  createdAt: Date;
}

interface DecisionActionRow extends ActionRow {
  updatedAt: Date;
}

/**
 * Captures and persists the Coordinator protocol boundary. All UUIDs inside the JSON snapshot are
 * rendered as Base62 before hashing; UUID columns remain internal so database constraints and
 * action keys keep their stable identities.
 */
@Injectable()
export class ProjectDecisionService {
  constructor(private readonly prisma: PrismaService) {}

  async capture(
    tx: Prisma.TransactionClient,
    projectId: string,
    readAt = new Date(),
  ): Promise<CapturedProjectDecisionInput> {
    const isolation = await tx.$queryRaw<Array<{ isolation: string }>>(Prisma.sql`
      SELECT current_setting('transaction_isolation') AS "isolation"
    `);
    if (!['repeatable read', 'serializable'].includes(isolation[0]?.isolation)) {
      throw new Error('Project decision snapshots require REPEATABLE READ or SERIALIZABLE');
    }

    const projects = await tx.$queryRaw<ProjectRow[]>(Prisma.sql`
      SELECT p."id", p."owner_id" AS "ownerId", p."title", p."goal",
             p."acceptance_criteria" AS "acceptanceCriteria", p."status",
             p."coordinator_enabled" AS "coordinatorEnabled",
             p."automation_policy"::text AS "automationPolicy",
             p."max_concurrent_tasks" AS "maxConcurrentTasks",
             p."session_budget_per_day" AS "sessionBudgetPerDay",
             p."config_revision" AS "configRevision",
             p."coordinator_session_id" AS "coordinatorSessionId",
             p."coordinator_workspace_id" AS "coordinatorWorkspaceId",
             coordinator."agent_id" AS "coordinatorAgentId",
             r."run_state"::text AS "runState", r."fencing_token" AS "fencingToken",
             r."coordinator_generation" AS "coordinatorGeneration",
             r."next_wake_at" AS "nextWakeAt",
             r."acceptance_attempt" AS "acceptanceAttempt"
        FROM "project" p
        JOIN "project_runtime" r ON r."project_id" = p."id"
        LEFT JOIN LATERAL (
          SELECT pm."agent_id"
            FROM "project_member" pm
            JOIN "workspace" w ON w."id" = pm."agent_id" AND w."owner_id" = p."owner_id"
           WHERE pm."project_id" = p."id" AND pm."role" = 'COORDINATOR'
           ORDER BY pm."id" LIMIT 1
        ) coordinator ON true
       WHERE p."id" = ${projectId}::uuid
    `);
    const project = projects[0];
    if (!project) throw new Error(`Project decision snapshot cannot find Project ${projectId}`);

    // A transaction owns one PostgreSQL connection. Keep these reads sequential: REPEATABLE READ
    // gives them one MVCC snapshot, while concurrent client.query calls on that connection are an
    // unsupported pg scheduling accident rather than useful parallelism.
    const teamRows = await tx.$queryRaw<TeamRow[]>(Prisma.sql`
        SELECT pm."id" AS "projectMemberId", pm."agent_id" AS "agentId", pm."role"::text,
               w."enabled", w."deleted_at" AS "deletedAt", w."runner_id" AS "runnerId",
               w."model", w."effort"
          FROM "project_member" pm
          JOIN "project" p ON p."id" = pm."project_id"
          JOIN "workspace" w ON w."id" = pm."agent_id" AND w."owner_id" = p."owner_id"
         WHERE pm."project_id" = ${projectId}::uuid AND p."owner_id" = ${project.ownerId}::uuid
         ORDER BY pm."id"
      `);
    const taskRows = await tx.$queryRaw<TaskRow[]>(Prisma.sql`
        SELECT t."id", t."title", t."description",
               t."acceptance_criteria" AS "acceptanceCriteria", t."labels", t."status"::text,
               t."parent_task_id" AS "parentTaskId", t."assignee_id" AS "assigneeAgentId",
               t."provider", t."model", t."auto_run_when_ready" AS "autoRunWhenReady",
               t."dispatch_hold" AS "dispatchHold", t."run_at" AS "runAt",
               t."verifies_task_id" AS "verifiesTaskId", t."updated_at" AS "updatedAt"
          FROM "task" t JOIN "project" p ON p."id" = t."project_id"
         WHERE t."project_id" = ${projectId}::uuid
           AND t."owner_id" = p."owner_id" AND p."owner_id" = ${project.ownerId}::uuid
         ORDER BY t."id"
      `);
    const dependencyRows = await tx.$queryRaw<DependencyRow[]>(Prisma.sql`
        SELECT d."task_id" AS "taskId", d."depends_on_task_id" AS "dependsOnTaskId"
          FROM "task_dependency" d
          JOIN "task" source ON source."id" = d."task_id"
          JOIN "task" target ON target."id" = d."depends_on_task_id"
          JOIN "project" p ON p."id" = source."project_id"
         WHERE source."project_id" = ${projectId}::uuid
           AND target."project_id" = p."id"
           AND source."owner_id" = p."owner_id" AND target."owner_id" = p."owner_id"
           AND p."owner_id" = ${project.ownerId}::uuid
         ORDER BY d."task_id", d."depends_on_task_id"
      `);
    const sessionRows = await tx.$queryRaw<SessionRow[]>(Prisma.sql`
        SELECT s."id", s."task_id" AS "taskId", s."workspace_id" AS "workspaceId",
               s."assigned_runner_id" AS "assignedRunnerId", s."status"::text,
               s."provider", s."model", s."permission_mode" AS "permissionMode", s."effort",
               s."created_at" AS "createdAt",
               s."started_at" AS "startedAt", s."finished_at" AS "finishedAt",
               s."completed_at" AS "completedAt", s."deleted_at" AS "deletedAt",
               s."result", s."error", s."branch", s."base_sha" AS "baseSha",
               s."changed_files" AS "changedFiles", s."merge_status" AS "mergeStatus",
               s."merged_source_sha" AS "mergedSourceSha", s."merge_target" AS "mergeTarget",
               s."branch_merged" AS "branchMerged", s."worktree_branch" AS "worktreeBranch",
               s."worktree_dirty" AS "worktreeDirty", s."commit_status" AS "commitStatus"
          FROM "session" s
          JOIN "project" p ON p."id" = ${projectId}::uuid
          LEFT JOIN "task" t ON t."id" = s."task_id"
         WHERE s."owner_id" = p."owner_id" AND p."owner_id" = ${project.ownerId}::uuid
           AND ((t."project_id" = p."id" AND t."owner_id" = p."owner_id")
                OR s."id" = p."coordinator_session_id")
         ORDER BY s."id"
      `);
    const workspaceRows = await tx.$queryRaw<WorkspaceRow[]>(Prisma.sql`
        SELECT w."id" AS "workspaceId", w."runner_id" AS "runnerId", w."enabled",
               w."deleted_at" AS "deletedAt", w."model", w."effort",
               w."default_merge_target" AS "defaultMergeTarget",
               w."work_dir_exists" AS "workDirExists", w."work_dir_is_git" AS "workDirIsGit",
               w."work_dir_probed_at" AS "workDirProbedAt"
          FROM "workspace" w JOIN "project" p ON p."id" = ${projectId}::uuid
         WHERE w."owner_id" = p."owner_id" AND p."owner_id" = ${project.ownerId}::uuid
           AND (
             w."id" = p."coordinator_workspace_id"
             OR EXISTS (SELECT 1 FROM "project_member" pm
                         WHERE pm."project_id" = p."id" AND pm."agent_id" = w."id")
             OR EXISTS (SELECT 1 FROM "task" t
                         WHERE t."project_id" = p."id" AND t."owner_id" = p."owner_id"
                           AND t."assignee_id" = w."id")
             OR EXISTS (SELECT 1 FROM "session" s JOIN "task" t ON t."id" = s."task_id"
                         WHERE t."project_id" = p."id" AND t."owner_id" = p."owner_id"
                           AND s."owner_id" = p."owner_id" AND s."workspace_id" = w."id")
             OR EXISTS (SELECT 1 FROM "session" s
                         WHERE s."id" = p."coordinator_session_id"
                           AND s."owner_id" = p."owner_id" AND s."workspace_id" = w."id")
           )
         ORDER BY w."id"
      `);
    const runnerRows = await tx.$queryRaw<RunnerRow[]>(Prisma.sql`
        SELECT r."id" AS "runnerId", r."status"::text, r."labels", r."version",
               r."last_heartbeat_at" AS "lastHeartbeatAt", r."model_catalog" AS "modelCatalog"
          FROM "runner" r JOIN "project" p ON p."id" = ${projectId}::uuid
         WHERE r."owner_id" = p."owner_id" AND p."owner_id" = ${project.ownerId}::uuid
           AND (
             EXISTS (SELECT 1 FROM "workspace" w
                      WHERE w."owner_id" = p."owner_id" AND w."runner_id" = r."id"
                        AND (w."id" = p."coordinator_workspace_id"
                          OR EXISTS (SELECT 1 FROM "project_member" pm
                                     WHERE pm."project_id" = p."id" AND pm."agent_id" = w."id")
                          OR EXISTS (SELECT 1 FROM "task" t
                                     WHERE t."project_id" = p."id" AND t."owner_id" = p."owner_id"
                                       AND t."assignee_id" = w."id")))
             OR EXISTS (SELECT 1 FROM "session" s JOIN "task" t ON t."id" = s."task_id"
                        WHERE t."project_id" = p."id" AND t."owner_id" = p."owner_id"
                          AND s."owner_id" = p."owner_id" AND s."assigned_runner_id" = r."id")
             OR EXISTS (SELECT 1 FROM "session" s
                        WHERE s."id" = p."coordinator_session_id"
                          AND s."owner_id" = p."owner_id" AND s."assigned_runner_id" = r."id")
           )
         ORDER BY r."id"
      `);
    const providerRows = await tx.$queryRaw<ProviderRow[]>(Prisma.sql`
        SELECT mp."id" AS "providerId", mp."slug", mp."runtime", mp."enabled", mp."models",
               mp."default_model" AS "defaultModel", mp."owner_id" AS "ownerId"
          FROM "model_provider" mp
         WHERE (mp."owner_id" IS NULL OR mp."owner_id" = ${project.ownerId}::uuid)
           AND (
             EXISTS (SELECT 1 FROM "task" t
                      WHERE t."project_id" = ${projectId}::uuid
                        AND t."owner_id" = ${project.ownerId}::uuid AND t."provider" = mp."slug")
             OR EXISTS (SELECT 1 FROM "session" s JOIN "task" t ON t."id" = s."task_id"
                        WHERE t."project_id" = ${projectId}::uuid
                          AND t."owner_id" = ${project.ownerId}::uuid
                          AND s."owner_id" = ${project.ownerId}::uuid AND s."provider" = mp."slug")
           )
         ORDER BY mp."slug", mp."id"
      `);
    const actionRows = await tx.$queryRaw<ActionRow[]>(Prisma.sql`
        SELECT a."id" AS "actionId", a."idempotency_key" AS "idempotencyKey", a."type"::text,
               a."status"::text, a."subject_type" AS "subjectType", a."subject_id" AS "subjectId",
               a."decision_id" AS "decisionId", a."result_session_id" AS "resultSessionId",
               a."refusal_code" AS "refusalCode", a."detail", a."created_at" AS "createdAt"
          FROM "project_action" a JOIN "project" p ON p."id" = a."project_id"
         WHERE a."project_id" = ${projectId}::uuid AND p."owner_id" = ${project.ownerId}::uuid
         ORDER BY a."created_at", a."id"
      `);
    const signalRows = await tx.$queryRaw<SignalRow[]>(Prisma.sql`
        SELECT e."id", e."kind", e."dedupe_key" AS "dedupeKey"
          FROM "project_event" e JOIN "project" p ON p."id" = e."project_id"
         WHERE e."project_id" = ${projectId}::uuid AND p."owner_id" = ${project.ownerId}::uuid
           AND e."consumed_at" IS NULL AND e."kind" = 'user.manual_trigger'
         ORDER BY e."dedupe_key", e."id"
      `);

    const dependencies = new Map<string, string[]>();
    for (const row of dependencyRows) {
      const list = dependencies.get(row.taskId) ?? [];
      list.push(toPublicId(row.dependsOnTaskId));
      dependencies.set(row.taskId, list);
    }
    const liveSessions = new Map<string, string[]>();
    for (const row of sessionRows) {
      if (!row.taskId || row.deletedAt || !isLiveSession(row.status)) continue;
      const list = liveSessions.get(row.taskId) ?? [];
      list.push(toPublicId(row.id));
      liveSessions.set(row.taskId, list);
    }

    const tasks = taskRows.map((row) => ({
      id: toPublicId(row.id),
      title: row.title,
      contentHash: sha256({
        title: row.title,
        description: row.description,
        acceptanceCriteria: row.acceptanceCriteria,
        labels: [...row.labels].sort(),
      }),
      status: row.status,
      parentTaskId: toPublicIdOrNull(row.parentTaskId),
      assigneeAgentId: toPublicIdOrNull(row.assigneeAgentId),
      provider: row.provider,
      model: row.model,
      autoRunWhenReady: row.autoRunWhenReady,
      dispatchHold: row.dispatchHold,
      runAt: iso(row.runAt),
      verifiesTaskId: toPublicIdOrNull(row.verifiesTaskId),
      dependsOnTaskIds: dependencies.get(row.id) ?? [],
      liveSessionIds: liveSessions.get(row.id) ?? [],
      updatedAt: isoRequired(row.updatedAt),
    }));

    const sessions = sessionRows.map((row) => ({
      id: toPublicId(row.id),
      taskId: toPublicIdOrNull(row.taskId),
      workspaceId: toPublicIdOrNull(row.workspaceId),
      assignedRunnerId: toPublicIdOrNull(row.assignedRunnerId),
      runStatus: row.status,
      provider: row.provider,
      model: row.model,
      permissionMode: row.permissionMode,
      effort: row.effort,
      createdAt: isoRequired(row.createdAt),
      startedAt: iso(row.startedAt),
      finishedAt: iso(row.finishedAt),
      completedAt: iso(row.completedAt),
      deletedAt: iso(row.deletedAt),
    }));

    const coordinator = project.coordinatorSessionId
      ? sessionRows.find((row) => row.id === project.coordinatorSessionId)
      : undefined;
    const coordinatorSession = coordinator
      ? {
          id: toPublicId(coordinator.id),
          runStatus: coordinator.status,
          workspaceId: toPublicIdOrNull(coordinator.workspaceId),
          assignedRunnerId: toPublicIdOrNull(coordinator.assignedRunnerId),
          startedAt: iso(coordinator.startedAt),
          finishedAt: iso(coordinator.finishedAt),
          completedAt: iso(coordinator.completedAt),
          deletedAt: iso(coordinator.deletedAt),
        }
      : null;

    const taskById = new Map(taskRows.map((row) => [row.id, row]));
    const latestVerificationSession = new Map<string, SessionRow>();
    for (const row of sessionRows) {
      if (!row.taskId || !taskById.get(row.taskId)?.verifiesTaskId) continue;
      const previous = latestVerificationSession.get(row.taskId);
      if (!previous || row.createdAt > previous.createdAt
        || (row.createdAt.getTime() === previous.createdAt.getTime() && row.id > previous.id)) {
        latestVerificationSession.set(row.taskId, row);
      }
    }
    const customProviderSlugs = new Set(providerRows.map((row) => row.slug));
    const referencedProviderSlugs = new Set([
      ...taskRows.map((row) => row.provider),
      ...sessionRows.map((row) => row.provider),
    ].filter((slug): slug is string => Boolean(slug)));
    const builtinProviders: ProjectDecisionInput['world']['providers'] =
      [...referencedProviderSlugs]
        .filter((slug) => Object.values(AgentProvider).includes(slug as AgentProvider)
          && !customProviderSlugs.has(slug))
        .map((slug) => {
          const catalogs = runnerRows.flatMap((runner) => providerModels(runner.modelCatalog, slug));
          return {
            providerId: null,
            slug,
            runtime: slug,
            enabled: runnerRows.some((runner) =>
              runner.status === 'ONLINE' && providerModels(runner.modelCatalog, slug).length > 0),
            models: catalogs,
            defaultModel: null,
            scope: 'BUILTIN' as const,
          };
        });

    const world: ProjectDecisionInput['world'] = {
      project: {
        id: toPublicId(project.id),
        ownerId: toPublicId(project.ownerId),
        title: project.title,
        goal: project.goal,
        acceptanceCriteria: project.acceptanceCriteria,
        status: project.status,
        coordinatorEnabled: project.coordinatorEnabled,
        automationPolicy: project.automationPolicy,
        maxConcurrentTasks: project.maxConcurrentTasks,
        sessionBudgetPerDay: project.sessionBudgetPerDay,
        configRevision: String(project.configRevision),
        coordinatorAgentId: toPublicIdOrNull(project.coordinatorAgentId),
        coordinatorSessionId: toPublicIdOrNull(project.coordinatorSessionId),
        coordinatorWorkspaceId: toPublicIdOrNull(project.coordinatorWorkspaceId),
      },
      runtime: {
        runState: project.runState,
        fencingToken: String(project.fencingToken),
        coordinatorGeneration: String(project.coordinatorGeneration),
        nextWakeAt: iso(project.nextWakeAt),
        acceptanceAttempt: String(project.acceptanceAttempt),
      },
      team: teamRows.map((row) => ({
        projectMemberId: toPublicId(row.projectMemberId),
        agentId: toPublicId(row.agentId),
        role: row.role,
        enabled: row.enabled,
        deletedAt: iso(row.deletedAt),
        runnerId: toPublicIdOrNull(row.runnerId),
        model: row.model,
        effort: row.effort,
      })),
      tasks,
      sessions,
      coordinatorSession,
      workspaces: workspaceRows.map((row) => ({
        workspaceId: toPublicId(row.workspaceId),
        runnerId: toPublicIdOrNull(row.runnerId),
        enabled: row.enabled,
        deletedAt: iso(row.deletedAt),
        model: row.model,
        effort: row.effort,
        defaultMergeTarget: row.defaultMergeTarget,
        workDirExists: row.workDirExists,
        workDirIsGit: row.workDirIsGit,
        workDirProbedAt: iso(row.workDirProbedAt),
      })),
      runners: runnerRows.map((row) => ({
        runnerId: toPublicId(row.runnerId),
        status: row.status,
        labels: [...row.labels].sort(),
        version: row.version,
        lastHeartbeatAt: iso(row.lastHeartbeatAt),
        modelCatalog: jsonValue(row.modelCatalog),
      })),
      providers: [...providerRows.map((row) => ({
        providerId: toPublicId(row.providerId),
        slug: row.slug,
        runtime: row.runtime,
        enabled: row.enabled,
        models: jsonValue(row.models),
        defaultModel: row.defaultModel,
        scope: row.ownerId ? 'PROJECT_OWNER' as const : 'SHARED' as const,
      })), ...builtinProviders].sort((a, b) =>
        a.slug.localeCompare(b.slug) || (a.providerId ?? '').localeCompare(b.providerId ?? '')),
      actions: actionRows.map((row) => ({
        actionId: toPublicId(row.actionId),
        type: row.type,
        status: row.status,
        subjectType: row.subjectType,
        subjectId: toPublicIdOrNull(row.subjectId),
        decisionId: toPublicIdOrNull(row.decisionId),
        resultSessionId: toPublicIdOrNull(row.resultSessionId),
        refusalCode: row.refusalCode,
        idempotencyKeyHash: sha256(row.idempotencyKey),
        detailHash: sha256(jsonValue(row.detail)),
        createdAt: isoRequired(row.createdAt),
      })),
      evidence: {
        branches: sessionRows.filter((row): row is SessionRow & { branch: string } => Boolean(row.branch))
          .map((row) => ({
            sessionId: toPublicId(row.id),
            taskId: toPublicIdOrNull(row.taskId),
            branch: row.branch,
            baseSha: row.baseSha,
            worktreeBranch: row.worktreeBranch,
            worktreeDirty: row.worktreeDirty,
            commitStatus: row.commitStatus,
            mergeStatus: row.mergeStatus,
            mergeTarget: row.mergeTarget,
            mergedSourceSha: row.mergedSourceSha,
            branchMerged: row.branchMerged,
            changedFiles: jsonValue(row.changedFiles),
          })),
        tests: taskRows.filter((row): row is TaskRow & { verifiesTaskId: string } => Boolean(row.verifiesTaskId))
          .map((row) => {
            const evidence = latestVerificationSession.get(row.id);
            return {
              verificationTaskId: toPublicId(row.id),
              verifiesTaskId: toPublicId(row.verifiesTaskId),
              taskStatus: row.status,
              sessionId: evidence ? toPublicId(evidence.id) : null,
              runStatus: evidence?.status ?? null,
              finishedAt: iso(evidence?.finishedAt ?? null),
              resultHash: evidence?.result == null ? null : sha256(evidence.result),
              errorHash: evidence?.error == null ? null : sha256(evidence.error),
            };
          }),
      },
    };

    const epoch = Math.floor(readAt.getTime() / 1_000);
    const evaluation: ProjectDecisionInput['evaluation'] = {
      epoch,
      dueTasks: Object.fromEntries(tasks.map((task) => [
        task.id,
        { runAtDue: task.runAt != null && Date.parse(task.runAt) <= epoch * 1_000 },
      ])),
    };
    const signals = signalRows.map((row) => ({
      eventId: toPublicId(row.id),
      kind: row.kind,
      dedupeKey: row.dedupeKey,
    }));
    const decisionInputHash = hashDecisionInput({ world, evaluation, signals });
    const input: ProjectDecisionInput = {
      v: PROJECT_DECISION_INPUT_VERSION,
      readAt: readAt.toISOString(),
      decisionInputHash,
      world,
      evaluation,
      signals,
    };

    return {
      input,
      attribution: {
        ownerId: project.ownerId,
        coordinatorAgentId: project.coordinatorAgentId,
        coordinatorSessionId: project.coordinatorSessionId,
      },
    };
  }

  async persist(
    tx: Prisma.TransactionClient,
    captured: CapturedProjectDecisionInput,
    outcome: ProjectDecisionOutcome,
    decisionId: string,
  ): Promise<PersistedProjectDecision> {
    assertDecisionReplay(captured.input, outcome);
    if (outcome.reconcileId !== toPublicId(decisionId)) {
      throw new Error('Project decision outcome reconcileId does not match its durable row');
    }
    const inserted = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      INSERT INTO "project_decision" (
        "id", "project_id", "input_version", "decision_input_hash", "decision_input",
        "outcome", "decided_by", "coordinator_agent_id", "coordinator_session_id",
        "fencing_token", "reason", "created_at"
      ) VALUES (
        ${decisionId}::uuid, ${toInternalProjectId(captured.input)}::uuid,
        ${captured.input.v}, ${captured.input.decisionInputHash},
        ${JSON.stringify(captured.input)}::jsonb, ${JSON.stringify(outcome)}::jsonb,
        ${outcome.decidedBy}, ${captured.attribution.coordinatorAgentId}::uuid,
        ${captured.attribution.coordinatorSessionId}::uuid,
        ${BigInt(outcome.fencingToken)}, ${outcome.reason}, ${new Date(captured.input.readAt)}
      )
      RETURNING "id"
    `);
    if (inserted[0]?.id !== decisionId) throw new Error('failed to persist Project decision');
    return { id: decisionId, input: captured.input, outcome };
  }

  async getInternal(
    tx: Prisma.TransactionClient,
    projectId: string,
    decisionId: string,
  ): Promise<DecisionRow | null> {
    const rows = await tx.$queryRaw<DecisionRow[]>(Prisma.sql`
      SELECT d."id", d."project_id" AS "projectId", p."owner_id" AS "ownerId",
             d."decision_input_hash" AS "decisionInputHash", d."decision_input" AS "decisionInput",
             d."outcome", d."decided_by" AS "decidedBy",
             d."coordinator_agent_id" AS "coordinatorAgentId",
             d."coordinator_session_id" AS "coordinatorSessionId",
             d."fencing_token" AS "fencingToken", d."reason", d."created_at" AS "createdAt"
        FROM "project_decision" d JOIN "project" p ON p."id" = d."project_id"
       WHERE d."id" = ${decisionId}::uuid AND d."project_id" = ${projectId}::uuid
    `);
    return rows[0] ?? null;
  }

  async replay(ownerId: string, decisionId: string): Promise<{
    matches: boolean;
    hashMatches: boolean;
    outcomeMatches: boolean;
    actionsTraceable: boolean;
    decision: unknown;
  } | null> {
    const rows = await this.prisma.$queryRaw<DecisionRow[]>(Prisma.sql`
      SELECT d."id", d."project_id" AS "projectId", p."owner_id" AS "ownerId",
             d."decision_input_hash" AS "decisionInputHash", d."decision_input" AS "decisionInput",
             d."outcome", d."decided_by" AS "decidedBy",
             d."coordinator_agent_id" AS "coordinatorAgentId",
             d."coordinator_session_id" AS "coordinatorSessionId",
             d."fencing_token" AS "fencingToken", d."reason", d."created_at" AS "createdAt"
        FROM "project_decision" d JOIN "project" p ON p."id" = d."project_id"
       WHERE d."id" = ${decisionId}::uuid AND p."owner_id" = ${ownerId}::uuid
    `);
    const row = rows[0];
    if (!row) return null;
    const input = row.decisionInput as ProjectDecisionInput;
    const stored = row.outcome as ProjectDecisionOutcome;
    const hashMatches = input.decisionInputHash === row.decisionInputHash
      && hashDecisionInput(input) === row.decisionInputHash;
    const replayed = planProjectDecision(input, {
      decisionId: row.id,
      decidedBy: row.decidedBy,
      consumedEventIds: stored.consumedEventIds,
      actions: stored.actions,
      blockersOpened: stored.blockersOpened,
      blockersCleared: stored.blockersCleared,
    });
    const outcomeMatches = canonicalJson(replayed) === canonicalJson(stored);
    const actions = await this.prisma.$queryRaw<DecisionActionRow[]>(Prisma.sql`
      SELECT a."id" AS "actionId", a."idempotency_key" AS "idempotencyKey", a."type"::text,
             a."status"::text, a."subject_type" AS "subjectType", a."subject_id" AS "subjectId",
             a."decision_id" AS "decisionId", a."result_session_id" AS "resultSessionId",
             a."refusal_code" AS "refusalCode", a."detail",
             a."created_at" AS "createdAt", a."updated_at" AS "updatedAt"
        FROM "project_action" a
       WHERE a."decision_id" = ${decisionId}::uuid AND a."project_id" = ${row.projectId}::uuid
       ORDER BY a."created_at", a."id"
    `);
    const actionsTraceable = actions.every((action) => {
      const detail = action.detail && typeof action.detail === 'object' && !Array.isArray(action.detail)
        ? action.detail as Record<string, unknown>
        : {};
      return detail.decisionInputHash === row.decisionInputHash
        && stored.actions.some((planned) =>
          planned.type === action.type
          && planned.idempotencyKey === action.idempotencyKey
          && planned.subject.type === action.subjectType
          && (planned.subject.id ?? null) === toPublicIdOrNull(action.subjectId));
    });
    return {
      matches: hashMatches && outcomeMatches && actionsTraceable,
      hashMatches,
      outcomeMatches,
      actionsTraceable,
      decision: publicAudit(row, input, stored, actions),
    };
  }
}

export function createDecisionId(): string {
  return randomUUID();
}

export function planProjectDecision(
  input: ProjectDecisionInput,
  options: {
    decisionId: string;
    decidedBy?: 'ORCHESTRATOR' | 'COORDINATOR_AGENT';
    consumedEventIds?: string[];
    actions?: ProjectDecisionOutcome['actions'];
    blockersOpened?: string[];
    blockersCleared?: string[];
  },
): ProjectDecisionOutcome {
  if (hashDecisionInput(input) !== input.decisionInputHash) {
    throw new Error('Project decision input hash mismatch');
  }
  const runStateAfter = runStateOf(input);
  const nextWakeAt = runStateAfter === 'SETTLED'
    ? null
    : new Date((input.evaluation.epoch + 60) * 1_000).toISOString();
  const nextWakeReason = runStateAfter === 'PLANNING'
    ? 'planning requires coordinator decision'
    : runStateAfter === 'EXECUTING'
      ? 'in-flight session may end'
      : runStateAfter === 'AWAITING_VERIFICATION'
        ? 'verification may settle'
        : runStateAfter === 'SETTLED'
          ? null
          : 'reconcile state recheck';
  return {
    v: 1,
    reconcileId: toPublicId(options.decisionId),
    fencingToken: input.world.runtime.fencingToken,
    decisionInputHash: input.decisionInputHash,
    configRevision: input.world.project.configRevision,
    runStateBefore: input.world.runtime.runState,
    runStateAfter,
    decidedBy: options.decidedBy ?? 'ORCHESTRATOR',
    reason: nextWakeReason ?? 'Project is outside the active coordination loop',
    actions: options.actions ?? [],
    blockersOpened: options.blockersOpened ?? [],
    blockersCleared: options.blockersCleared ?? [],
    nextWakeAt,
    nextWakeReason,
    consumedEventIds: options.consumedEventIds ?? [],
  };
}

export function hashDecisionInput(
  input: Pick<ProjectDecisionInput, 'world' | 'evaluation' | 'signals'>,
): string {
  return sha256({ world: input.world, evaluation: input.evaluation, signals: input.signals });
}

export function canonicalJson(value: unknown): string {
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

function runStateOf(input: ProjectDecisionInput): ProjectDecisionRunState {
  if (input.world.project.status !== 'OPEN') return 'SETTLED';
  if (input.world.sessions.some((session) =>
    session.taskId != null && !session.deletedAt && isLiveSession(session.runStatus))) {
    return 'EXECUTING';
  }
  if (input.world.tasks.some((task) => task.verifiesTaskId && task.status !== 'DONE')) {
    return 'AWAITING_VERIFICATION';
  }
  return 'PLANNING';
}

function assertDecisionReplay(input: ProjectDecisionInput, outcome: ProjectDecisionOutcome): void {
  const taskIds = new Set(input.world.tasks.map((task) => task.id));
  for (const action of outcome.actions) {
    const subjectId = action.subject.id ?? null;
    if (action.subject.type === 'PROJECT' && subjectId !== input.world.project.id) {
      throw new Error('Project decision action names a Project outside its snapshot');
    }
    if (action.subject.type === 'TASK' && (!subjectId || !taskIds.has(subjectId))) {
      throw new Error('Project decision action names a Task outside its snapshot');
    }
    if (subjectId) toInternalId(subjectId);
  }
  const replayed = planProjectDecision(input, {
    decisionId: toInternalId(outcome.reconcileId),
    decidedBy: outcome.decidedBy,
    consumedEventIds: outcome.consumedEventIds,
    actions: outcome.actions,
    blockersOpened: outcome.blockersOpened,
    blockersCleared: outcome.blockersCleared,
  });
  if (canonicalJson(replayed) !== canonicalJson(outcome)) {
    throw new Error('Project decision outcome is not reproducible from its input');
  }
}

function publicAudit(
  row: DecisionRow,
  input: ProjectDecisionInput,
  outcome: ProjectDecisionOutcome,
  actions: DecisionActionRow[],
): unknown {
  return publicizeIds({
    id: row.id,
    projectId: row.projectId,
    input,
    outcome,
    decidedBy: row.decidedBy,
    coordinatorAgentId: row.coordinatorAgentId,
    coordinatorSessionId: row.coordinatorSessionId,
    fencingToken: String(row.fencingToken),
    reason: row.reason,
    createdAt: isoRequired(row.createdAt),
    actions: actions.map((action) => ({
      id: action.actionId,
      type: action.type,
      status: action.status,
      subject: { type: action.subjectType, id: action.subjectId },
      decisionId: action.decisionId,
      resultSessionId: action.resultSessionId,
      refusalCode: action.refusalCode,
      idempotencyKey: action.idempotencyKey,
      idempotencyKeyHash: sha256(action.idempotencyKey),
      detail: jsonValue(action.detail),
      createdAt: isoRequired(action.createdAt),
      updatedAt: isoRequired(action.updatedAt),
    })),
  });
}

function publicizeIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicizeIds);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, publicizeIds(item)]));
  }
  if (typeof value !== 'string') return value;
  return value.replace(
    /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
    (id) => toPublicId(id),
  );
}

function sha256(value: unknown): string {
  const source = typeof value === 'string' ? value : canonicalJson(value);
  return createHash('sha256').update(source).digest('hex');
}

function jsonValue(value: unknown): unknown {
  return value == null ? null : canonicalValue(value);
}

function providerModels(catalog: unknown, slug: string): unknown[] {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return [];
  const value = (catalog as Record<string, unknown>)[slug];
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function isLiveSession(status: string): boolean {
  return ['PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED'].includes(status);
}

function iso(value: Date | string | null | undefined): string | null {
  return value == null ? null : isoRequired(value);
}

function isoRequired(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toPublicId(id: string): string {
  return uuidToBase62(id);
}

function toPublicIdOrNull(id: string | null | undefined): string | null {
  return id == null ? null : toPublicId(id);
}

function toInternalId(publicId: string): string {
  // Avoid importing the permissive route decoder into the protocol surface. A decision outcome
  // written here always came from uuidToBase62, so this local inverse is exact and closed.
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  if (!publicId) throw new Error('empty Project decision public id');
  let n = 0n;
  for (const char of publicId) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new Error('invalid Project decision public id');
    n = n * 62n + BigInt(digit);
  }
  if (n >= (1n << 128n)) throw new Error('Project decision public id overflows UUID');
  const hex = n.toString(16).padStart(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function toInternalProjectId(input: ProjectDecisionInput): string {
  return toInternalId(input.world.project.id);
}
