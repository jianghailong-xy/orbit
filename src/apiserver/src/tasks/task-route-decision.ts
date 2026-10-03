import { Prisma, RunStatus, TaskEvidenceDecisionValue, TaskVerdict } from '@prisma/client';
import {
  AgentProvider,
  USAGE_LIMIT_ERROR_MARKERS,
  runnerCatalogRow,
  spentPlanUsage,
  type AccountEngine,
  type PlanUsage,
  type PlanUsageWindow,
  type RunnerModelCatalog,
} from '@orbit/shared';
import { resolvePermissionMode } from '../common/permission-mode';
import { firstRuntimeCatalogModel, sanitizeRuntimeDefaultModels } from '../common/runtime-model';
import { normalizeEffortForProvider, normalizeRuntimeProvider } from '../common/runtime-provider';
import type { PrismaService } from '../prisma/prisma.service';
import { accountPoolRuntime, isBuiltinProvider } from '../providers/custom-provider';
import { automaticAccount, runAccount } from '../providers/plan-usage-accounts';
import { followsRuntimeCatalog } from '../providers/preset-overlay';
import { signedOutEngineRefusal, type EnginePreflightRunner } from '../sessions/engine-signin-preflight';
import { agentProviderSeed } from '../workspaces/workspace-provider';
import { readExecutableAcceptanceOutcome } from './executable-acceptance-round';
import {
  MODEL_ROUTING_ENGINES,
  MODEL_ROUTING_LEVELS,
  priorLevel,
  routeTaskRun,
  type ModelRoutingEngineState,
  type ModelRoutingInput,
  type ModelRoutingLevel,
  type ModelRoutingRun,
} from './model-routing';
import type { TaskRunRoute } from './task-run-receipt';

/**
 * Everything a dispatch reads to route a fresh run (docs/model-routing-design.md §8.1), in the lease
 * and outside any transaction, and none of it over the network: the router itself is pure.
 *
 * Per Agent, per runner and per account, each read once — a bulk Run routes many tasks against the
 * same few of them (§8.2). `now` is the instant a runner's report is judged at (§6).
 */
export function taskRouteReads(prisma: PrismaService, ownerId: string, now: Date = new Date()) {
  const cached = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, read: () => Promise<T>): Promise<T> => {
    if (!cached.has(key)) cached.set(key, read());
    return cached.get(key) as Promise<T>;
  };
  return {
    prisma,
    ownerId,
    now,
    owner: () => once('owner', () => prisma.user.findUnique({
      where: { id: ownerId },
      select: { preferences: true },
    })),
    workspace: (id: string) => once(`workspace:${id}`, () => prisma.workspace.findFirst({
      where: { id, ownerId },
      select: {
        runnerId: true, effort: true, modelRouting: true, modelRoutingProviders: true,
        env: true, codexAccount: true, claudeAccount: true,
      },
    })),
    seed: (workspaceId: string) => once(`seed:${workspaceId}`, () => agentProviderSeed(prisma, workspaceId)),
    runner: (id: string) => once(`runner:${id}`, () => prisma.runner.findFirst({
      where: { id, ownerId },
      select: {
        modelCatalog: true, runtimeDefaultModels: true, planUsage: true,
        name: true, displayName: true, status: true, lastHeartbeatAt: true, engines: true, accountNames: true,
      },
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
    runner,
    modelCatalog: (runner?.modelCatalog ?? null) as RunnerModelCatalog | null,
    runtimeDefaultModels: sanitizeRuntimeDefaultModels(runner?.runtimeDefaultModels),
    planUsage: (runner?.planUsage ?? null) as PlanUsage | null,
    owner,
    // What a task run gets: it names no mode, so the account's default, else the floor.
    permissionMode: resolvePermissionMode(null, owner),
  };
}

type RouteAgent = NonNullable<Awaited<ReturnType<TaskRouteReads['workspace']>>>;
type RouteRunner = NonNullable<Awaited<ReturnType<TaskRouteReads['runner']>>>;

/** What reasons call a reported window: by its length, else by the slot it was reported in. */
function windowName(window: PlanUsageWindow | undefined, slot: string): string {
  const mins = window?.windowDurationMins;
  if (!mins) return slot;
  if (mins === 7 * 24 * 60) return 'weekly';
  if (mins % (24 * 60) === 0) return `${mins / (24 * 60)}-day`;
  return mins % 60 === 0 ? `${mins / 60}-hour` : slot;
}

/**
 * Where an engine stands on the target runner for the account a run there would use (§6) — the
 * account `sessions.create` would start it on (automaticAccount, runAccount), signed in as its
 * preflight judges it (signedOutEngineRefusal). The quota is the fullest window that caps the whole
 * engine; a model family's own window (Opus weekly) only moves the tier's model (§5).
 */
function engineState(
  engine: AccountEngine,
  agent: RouteAgent,
  runner: RouteRunner,
  now: Date,
): ModelRoutingEngineState {
  const automatic = automaticAccount(engine, agent, runner.engines, runner.planUsage, now);
  const accounts = {
    codexAccount: agent.codexAccount,
    claudeAccount: agent.claudeAccount,
    ...(automatic ? { [engine === AgentProvider.CLAUDE ? 'claudeAccount' : 'codexAccount']: automatic } : {}),
  };
  const signedOut = signedOutEngineRefusal({
    runtime: engine,
    bringsOwnCredentials: false,
    workspaceEnv: agent.env,
    accounts,
    runner: runner as EnginePreflightRunner,
    nowMs: now.getTime(),
  }) !== null;
  const account = runAccount(engine, agent.env, accounts, runner.engines);
  const snapshot = account === null ? undefined : spentPlanUsage(runner.planUsage as PlanUsage | null, engine, account);
  const windows: Array<[PlanUsageWindow | undefined, string]> = snapshot
    ? [
      [snapshot.fiveHour, '5-hour'],
      [snapshot.sevenDay, 'weekly'],
      [snapshot.primary, windowName(snapshot.primary, 'primary')],
      [snapshot.secondary, windowName(snapshot.secondary, 'secondary')],
    ]
    : [];
  let quota: ModelRoutingEngineState['quota'] = null;
  for (const [window, name] of windows) {
    // One past its reset has given its quota back.
    if (!window || Date.parse(window.resetsAt ?? '') <= now.getTime()) continue;
    if (!quota || window.utilization > quota.utilization) quota = { utilization: window.utilization, window: name };
  }
  return { signedOut, quota };
}

/** The engine a task's newest work run was created on, by runtime: what a verification looks past (§6). */
async function lastRunEngine(reads: TaskRouteReads, taskId: string): Promise<string | null> {
  const run = await reads.prisma.session.findFirst({
    where: { ownerId: reads.ownerId, taskId, startsTaskWork: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { provider: true, providerBuiltin: true },
  });
  return run ? (await reads.engine(run.provider, run.providerBuiltin)).runtime : null;
}

/**
 * The router's cross-engine input (§6): the engines the owner allowed this Agent's task runs, what
 * the target runner says of each one a run could start on, and for a verification the engine the
 * task it verifies last ran on. Nothing past the allowed list when the task pins its engine or the
 * owner allowed none: the run cannot leave its own engine then.
 */
async function routeEngines(
  reads: TaskRouteReads,
  task: TaskRouteSubject,
  agent: RouteAgent | null,
  env: Awaited<ReturnType<typeof routeEnvironment>>,
): Promise<NonNullable<ModelRoutingInput['engines']>> {
  const allowed = (agent?.modelRoutingProviders ?? []).filter((engine) => MODEL_ROUTING_ENGINES.includes(engine));
  if (task.provider || allowed.length === 0 || !agent) return { allowed };
  const states: Record<string, ModelRoutingEngineState> = {};
  for (const engine of new Set([env.provider, ...allowed])) {
    if (env.runner && (engine === AgentProvider.CLAUDE || engine === AgentProvider.CODEX)) {
      states[engine] = engineState(engine, agent, env.runner, reads.now);
    }
  }
  const verifiedRunEngine = task.verifiesTaskId ? await lastRunEngine(reads, task.verifiesTaskId) : null;
  return { allowed, states, verifiedRunEngine };
}

/** `autoRunHoldOff`'s reading: an error naming a spent quota says nothing about the task (§3.3). */
function quotaFailure(error: string | null): boolean {
  const text = error?.toLowerCase() ?? '';
  return USAGE_LIMIT_ERROR_MARKERS.some((marker) => text.includes(marker));
}

/**
 * The task's work runs as the router reads them (§3.3): newest first, numbered in the order they
 * were started ("run 1" is the first), each with the tier its own Route Decision named — a shadow
 * one included — and how it ended.
 *
 * A verifier's FAIL and the owner's SEND_BACK come after the run they judge, so each belongs to the
 * newest run started before it: the reading the routing report counts failures by (§10.1), so the
 * run routing escalated after is the run the report counts as failed. A verifier keeps only the
 * verdict it holds now, dated by its row's last write.
 */
async function readRunHistory(
  prisma: PrismaService,
  ownerId: string,
  taskId: string,
): Promise<ModelRoutingRun[]> {
  const runs = await prisma.session.findMany({
    where: { ownerId, taskId, startsTaskWork: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true, createdAt: true, status: true, error: true,
      provider: true, providerBuiltin: true, model: true, effort: true,
    },
  });
  if (runs.length === 0) return [];
  const decisions = await prisma.taskRouteDecision.findMany({
    where: { ownerId, taskId, sessionId: { in: runs.map((run) => run.id) } },
    select: { sessionId: true, level: true },
  });
  const failedVerdicts = await prisma.task.findMany({
    where: { ownerId, verifiesTaskId: taskId, verdict: TaskVerdict.FAIL },
    select: { updatedAt: true },
  });
  const sendBacks = await prisma.taskEvidenceDecision.findMany({
    where: { ownerId, taskId, decision: TaskEvidenceDecisionValue.SEND_BACK },
    select: { decidedAt: true },
  });
  const levels = new Map(decisions.map((row) => [row.sessionId, row.level]));
  return runs.map((run, index): ModelRoutingRun => {
    const next = runs[index + 1]?.createdAt;
    const judged = (at: Date) => at >= run.createdAt && (!next || at < next);
    return {
      ordinal: index + 1,
      status: run.status,
      quotaFailure: run.status === RunStatus.FAILED && quotaFailure(run.error),
      level: MODEL_ROUTING_LEVELS.find((level) => level === levels.get(run.id)) ?? null,
      model: run.model,
      effort: run.effort,
      runtime: isBuiltinProvider(run.provider, run.providerBuiltin)
        ? normalizeRuntimeProvider(run.provider, run.providerBuiltin)
        : run.provider,
      // The run's own end first, then what was said about its work afterwards.
      outcome: run.status === RunStatus.FAILED
        ? (readExecutableAcceptanceOutcome(run.error) ? 'ACCEPTANCE_FAILED' : 'FAILED')
        : failedVerdicts.some((row) => judged(row.updatedAt)) ? 'VERIFICATION_FAILED'
          : sendBacks.some((row) => judged(row.decidedAt)) ? 'SENT_BACK'
            : 'OK',
    };
  }).reverse();
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
 * `applied` when the Agent has smart selection on (`workspace.modelRouting`) and a tier was decided:
 * the run is then created on the routed provider, model and effort (§7.4). Otherwise it is the
 * shadow — the run is dispatched exactly as it was before routing existed, and the decision records
 * what routing would have picked.
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
  const history = await readRunHistory(prisma, ownerId, task.id);
  const dependents = await prisma.taskDependency.count({ where: { dependsOnTaskId: task.id } });
  // The effort `sessions.create` gives a run that names none: the Agent's, else the account's.
  const named = agent && agent.effort !== null
    ? agent.effort
    : ((env.owner?.preferences ?? {}) as { defaultEffort?: string }).defaultEffort || undefined;
  const effort = normalizeEffortForProvider(normalizeRuntimeProvider(env.runtime), named) || null;
  const modelHint = MODEL_ROUTING_LEVELS.find((level) => level === task.modelHint) ?? null;
  const engines = await routeEngines(reads, task, agent, env);
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
    engines,
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
    // Only a decided tier is applied: one that kept the baseline (a model pin, no tier table, no
    // suggestion, no catalogue) changes nothing whether the switch is on or not.
    applied: agent?.modelRouting === true && decision.level !== null,
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
      // Cross-engine (§6): what the owner allowed, and what the runner said of each candidate.
      modelRoutingProviders: engines.allowed ?? [],
      engineStates: engines.states ?? null,
      verifiedRunEngine: engines.verifiedRunEngine ?? null,
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
