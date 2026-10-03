import { Prisma, RunStatus } from '@prisma/client';
import {
  AgentProvider,
  USAGE_LIMIT_ERROR_MARKERS,
  runnerCatalogRow,
  type PlanUsage,
  type RunnerModelCatalog,
} from '@orbit/shared';
import { resolvePermissionMode } from '../common/permission-mode';
import { firstRuntimeCatalogModel, sanitizeRuntimeDefaultModels } from '../common/runtime-model';
import { normalizeEffortForProvider, normalizeRuntimeProvider } from '../common/runtime-provider';
import type { PrismaService } from '../prisma/prisma.service';
import { accountPoolRuntime, isBuiltinProvider } from '../providers/custom-provider';
import { followsRuntimeCatalog } from '../providers/preset-overlay';
import { agentProviderSeed } from '../workspaces/workspace-provider';
import {
  MODEL_ROUTING_LEVELS,
  priorLevel,
  routeTaskRun,
  type ModelRoutingLevel,
  type ModelRoutingRun,
} from './model-routing';
import type { TaskRunRoute } from './task-run-receipt';

/**
 * Everything a dispatch reads to route a fresh run (docs/model-routing-design.md §8.1), in the lease
 * and outside any transaction, and none of it over the network: the router itself is pure.
 *
 * Per Agent, per runner and per account, each read once — a bulk Run routes many tasks against the
 * same few of them (§8.2).
 */
export function taskRouteReads(prisma: PrismaService, ownerId: string) {
  const cached = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, read: () => Promise<T>): Promise<T> => {
    if (!cached.has(key)) cached.set(key, read());
    return cached.get(key) as Promise<T>;
  };
  return {
    prisma,
    ownerId,
    owner: () => once('owner', () => prisma.user.findUnique({
      where: { id: ownerId },
      select: { preferences: true },
    })),
    workspace: (id: string) => once(`workspace:${id}`, () => prisma.workspace.findFirst({
      where: { id, ownerId },
      select: { runnerId: true, effort: true, modelRouting: true },
    })),
    seed: (workspaceId: string) => once(`seed:${workspaceId}`, () => agentProviderSeed(prisma, workspaceId)),
    runner: (id: string) => once(`runner:${id}`, () => prisma.runner.findFirst({
      where: { id, ownerId },
      select: { modelCatalog: true, runtimeDefaultModels: true, planUsage: true },
    })),
    engine: (provider: string, providerBuiltin: boolean) => once(
      `engine:${provider}:${providerBuiltin}`,
      () => routeEngine(prisma, ownerId, provider, providerBuiltin),
    ),
  };
}

export type TaskRouteReads = ReturnType<typeof taskRouteReads>;

/**
 * Which runtime a provider runs on, and whether its models are that runtime's own (§4.3). A
 * configured provider is resolved the way `sessions.create` resolves it; one that resolves to
 * nothing has no model space anybody can describe, so it has no tier table either.
 */
async function routeEngine(
  prisma: PrismaService,
  ownerId: string,
  provider: string,
  providerBuiltin: boolean,
): Promise<{ runtime: string; hasOwnModelSpace: boolean }> {
  if (providerBuiltin) {
    return { runtime: normalizeRuntimeProvider(provider, true), hasOwnModelSpace: false };
  }
  const configured = await prisma.modelProvider.findFirst({
    where: { slug: provider, enabled: true, OR: [{ ownerId: null }, { ownerId }] },
    select: { runtime: true, presetSlug: true, followsPreset: true, models: true, defaultModel: true },
  });
  if (configured) {
    return {
      runtime: normalizeRuntimeProvider(configured.runtime),
      hasOwnModelSpace: !followsRuntimeCatalog(configured),
    };
  }
  // An account pool runs on the accounts of one runtime, in that runtime's model space.
  const pooled = await accountPoolRuntime(prisma, ownerId, provider);
  return pooled
    ? { runtime: pooled, hasOwnModelSpace: false }
    : { runtime: provider, hasOwnModelSpace: true };
}

/**
 * The engine a run of this task starts on (the task's pin, else the Agent's seed) and its runner.
 *
 * The reads here and in `planTaskRunRoute` are awaited one at a time on purpose: one that failed
 * while the others were still in flight would leave their rejections unhandled.
 */
async function routeEnvironment(
  reads: TaskRouteReads,
  task: { provider?: string | null },
  workspaceId: string,
  runnerId: string | null,
) {
  const pinned = task.provider ?? null;
  const seed = pinned ? null : await reads.seed(workspaceId);
  const provider = pinned ?? seed!.provider;
  const providerBuiltin = pinned
    ? Object.values(AgentProvider).includes(pinned as AgentProvider)
    : seed!.providerBuiltin;
  const engine = await reads.engine(provider, providerBuiltin);
  const runner = runnerId ? await reads.runner(runnerId) : null;
  const owner = await reads.owner();
  return {
    provider,
    providerSource: pinned ? 'task-pin' : 'agent-seed',
    runtime: engine.runtime,
    hasOwnModelSpace: engine.hasOwnModelSpace,
    modelCatalog: (runner?.modelCatalog ?? null) as RunnerModelCatalog | null,
    runtimeDefaultModels: sanitizeRuntimeDefaultModels(runner?.runtimeDefaultModels),
    planUsage: (runner?.planUsage ?? null) as PlanUsage | null,
    owner,
    // What a task run gets: it names no mode, so the account's default, else the floor.
    permissionMode: resolvePermissionMode(null, owner),
  };
}

/** `autoRunHoldOff`'s reading: an error naming a spent quota says nothing about the task (§3.3). */
function quotaFailure(error: string | null): boolean {
  const text = error?.toLowerCase() ?? '';
  return USAGE_LIMIT_ERROR_MARKERS.some((marker) => text.includes(marker));
}

/** What a dispatch already holds of the task it routes. */
export interface TaskRouteSubject {
  id: string;
  provider?: string | null;
  model?: string | null;
  modelHint?: string | null;
  modelHintReason?: string | null;
  completionCriterion?: string | null;
  acceptanceCommand?: string | null;
  verifiesTaskId?: string | null;
  isForeman?: boolean | null;
}

/**
 * Route one fresh run: read the router's inputs, call it, and return the decision with the
 * baseline and features it is recorded with (§7.3).
 *
 * Shadow mode only: `applied` is false, so the run is dispatched exactly as it was before routing
 * existed and the decision records what routing would have picked.
 */
export async function planTaskRunRoute(
  reads: TaskRouteReads,
  task: TaskRouteSubject,
  workspace: { id: string; runnerId: string },
  prompt: string,
): Promise<TaskRunRoute> {
  const { prisma, ownerId } = reads;
  const env = await routeEnvironment(reads, task, workspace.id, workspace.runnerId);
  const agent = await reads.workspace(workspace.id);
  const runs = await prisma.session.findMany({
    where: { ownerId, taskId: task.id, startsTaskWork: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { status: true, error: true, provider: true, providerBuiltin: true, model: true, effort: true },
  });
  const dependents = await prisma.taskDependency.count({ where: { dependsOnTaskId: task.id } });
  // The effort `sessions.create` gives a run that names none: the Agent's, else the account's.
  const named = agent && agent.effort !== null
    ? agent.effort
    : ((env.owner?.preferences ?? {}) as { defaultEffort?: string }).defaultEffort || undefined;
  const effort = normalizeEffortForProvider(normalizeRuntimeProvider(env.runtime), named) || null;
  // Work runs only, newest first, numbered in the order they were started — "run 1" is the first.
  const history: ModelRoutingRun[] = runs.map((run, index): ModelRoutingRun => ({
    ordinal: index + 1,
    status: run.status,
    quotaFailure: run.status === RunStatus.FAILED && quotaFailure(run.error),
    model: run.model,
    effort: run.effort,
    runtime: isBuiltinProvider(run.provider, run.providerBuiltin)
      ? normalizeRuntimeProvider(run.provider, run.providerBuiltin)
      : run.provider,
    outcome: run.status === RunStatus.FAILED ? 'FAILED' : 'OK',
  })).reverse();
  const modelHint = MODEL_ROUTING_LEVELS.find((level) => level === task.modelHint) ?? null;
  const decision = routeTaskRun({
    task: {
      provider: task.provider ?? null,
      model: task.model ?? null,
      modelHint,
      modelHintReason: task.modelHintReason ?? null,
    },
    baseline: { provider: env.provider, model: task.model ?? null, effort },
    history,
    environment: {
      runtime: env.runtime,
      hasOwnModelSpace: env.hasOwnModelSpace,
      modelCatalog: env.modelCatalog,
      runtimeDefaultModels: env.runtimeDefaultModels,
      defaultPermissionMode: env.permissionMode,
      planUsage: env.planUsage,
    },
  });
  // The run the router compared against: the newest one that did not stop at a usage limit.
  const skipped = history.findIndex((run) => !run.quotaFailure);
  const last = skipped < 0 ? undefined : history[skipped];
  const lastLevel = last ? priorLevel(last, env.runtime) : null;
  const escalatedFrom = decision.level && lastLevel && last?.outcome !== 'OK'
    && MODEL_ROUTING_LEVELS.indexOf(decision.level) > MODEL_ROUTING_LEVELS.indexOf(lastLevel)
    ? lastLevel
    : null;
  return {
    policyVersion: decision.policyVersion,
    applied: false,
    level: decision.level,
    provider: decision.provider,
    model: decision.model,
    effort: decision.effort,
    baseline: {
      provider: env.provider,
      providerSource: env.providerSource,
      // Null is the runtime default, which the first claim resolves.
      model: task.model ?? null,
      runtimeDefaultModel: env.hasOwnModelSpace
        ? null
        : env.runtimeDefaultModels[env.runtime as AgentProvider]
          ?? firstRuntimeCatalogModel(env.modelCatalog, env.runtime as AgentProvider)
          ?? null,
      effort,
      permissionMode: env.permissionMode,
    },
    // No ids: earlier runs are named by ordinal, as the clients name them.
    features: {
      modelHint,
      completionCriterion: task.completionCriterion ?? null,
      hasAcceptanceCommand: task.acceptanceCommand != null,
      verifiesTask: task.verifiesTaskId != null,
      isForeman: task.isForeman === true,
      dependents,
      promptChars: prompt.length,
      priorRuns: history.length,
      priorFailures: history.filter((run) => run.outcome !== 'OK' && !run.quotaFailure).length,
      quotaFailuresSkipped: skipped < 0 ? history.length : skipped,
      lastRun: last
        ? { ordinal: last.ordinal, level: lastLevel, model: last.model ?? null, outcome: last.outcome }
        : null,
      escalatedFrom,
      opusWeeklyUtilization: env.planUsage?.claude?.sevenDayOpus?.utilization ?? null,
      modelRouting: agent?.modelRouting === true,
    },
    reasons: decision.reasons,
  };
}

/**
 * Write a fresh run's Route Decision, once per run request: `UNIQUE (task_id, request_token)` makes
 * a takeover replaying the same plan meet its predecessor's row and add nothing.
 *
 * `sessionId` is the Session the plan names, which does not exist yet — and never will if the
 * dispatch is refused — so the column carries no foreign key.
 */
export async function recordTaskRouteDecision(
  prisma: PrismaService,
  decision: { ownerId: string; taskId: string; requestToken: string; sessionId: string; route: TaskRunRoute },
): Promise<void> {
  const { route } = decision;
  await prisma.taskRouteDecision.createMany({
    data: [{
      ownerId: decision.ownerId,
      taskId: decision.taskId,
      requestToken: decision.requestToken,
      sessionId: decision.sessionId,
      applied: route.applied,
      policyVersion: route.policyVersion,
      level: route.level,
      provider: route.provider,
      model: route.model,
      effort: route.effort,
      baseline: route.baseline as Prisma.InputJsonValue,
      features: route.features as Prisma.InputJsonValue,
      reasons: route.reasons,
    }],
    skipDuplicates: true,
  });
}

/** What clients show beside one run (§7.5): the decision, without its baseline and features. */
export interface TaskRouteSummary {
  level: ModelRoutingLevel | null;
  provider: string;
  model: string | null;
  effort: string | null;
  applied: boolean;
  /** One tier above the previous run, because that run failed — the ↑ beside the tier. */
  escalated: boolean;
  reasons: string[];
  policyVersion: number;
  decidedAt: Date;
}

/** The Route Decision behind each of these Sessions; a Session without one is absent from the map. */
export async function readTaskRouteSummaries(
  prisma: PrismaService,
  ownerId: string,
  sessionIds: string[],
): Promise<Map<string, TaskRouteSummary>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await prisma.taskRouteDecision.findMany({
    where: { ownerId, sessionId: { in: sessionIds } },
    orderBy: { createdAt: 'asc' },
    select: {
      sessionId: true,
      level: true,
      provider: true,
      model: true,
      effort: true,
      applied: true,
      features: true,
      reasons: true,
      policyVersion: true,
      createdAt: true,
    },
  });
  return new Map(rows.map((row) => [row.sessionId!, {
    level: row.level as ModelRoutingLevel | null,
    provider: row.provider,
    model: row.model,
    effort: row.effort,
    applied: row.applied,
    escalated: (row.features as { escalatedFrom?: unknown } | null)?.escalatedFrom != null,
    reasons: row.reasons,
    policyVersion: row.policyVersion,
    decidedAt: row.createdAt,
  }]));
}

/** One entry of the task's Suggested picker: the model and effort a tier resolves to (§7.5). */
export interface ModelHintOption {
  level: ModelRoutingLevel;
  provider: string | null;
  /** Null when the engine has no tier table, or no runner of the Agent's has reported its models. */
  model: string | null;
  label: string | null;
  effort: string | null;
}

/**
 * Each tier as the router would resolve it for this task's engine on its Agent's runner, from the
 * same tier table and the same catalogue rules — so the picker never shows a model routing would
 * not pick. A runner's quota is left out: it moves a single decision, not what a tier means.
 */
export async function readModelHintOptions(
  reads: TaskRouteReads,
  task: { provider?: string | null; assigneeId?: string | null },
): Promise<ModelHintOption[]> {
  const agent = task.assigneeId ? await reads.workspace(task.assigneeId) : null;
  const env = agent ? await routeEnvironment(reads, task, task.assigneeId!, agent.runnerId) : null;
  return MODEL_ROUTING_LEVELS.map((level) => {
    const decision = env && routeTaskRun({
      task: { provider: task.provider ?? null, modelHint: level },
      baseline: { provider: env.provider, model: null, effort: null },
      history: [],
      environment: {
        runtime: env.runtime,
        hasOwnModelSpace: env.hasOwnModelSpace,
        modelCatalog: env.modelCatalog,
        runtimeDefaultModels: env.runtimeDefaultModels,
        defaultPermissionMode: env.permissionMode,
      },
    });
    const model = decision?.level ? decision.model : null;
    return {
      level,
      provider: env?.provider ?? task.provider ?? null,
      model,
      label: model ? runnerCatalogRow(env!.runtime, model, env!.modelCatalog)?.label ?? model : null,
      effort: model ? decision!.effort : null,
    };
  });
}
