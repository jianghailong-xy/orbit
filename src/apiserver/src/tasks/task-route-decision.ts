import { Prisma, TaskEvidenceDecisionValue, TaskVerdict } from '@prisma/client';
import { RELEASE_FAILURE_SELECT, releaseWasFailure } from '../common/session-release';
import {
  AgentProvider,
  accountCapWindows,
  cursorUsageRead,
  isEngine,
  runnerCatalogRow,
  quotaExpiry,
  quotaNearLimit,
  spentPlanUsage,
  withEnginePlanUsage,
  type AccountEngine,
  type PlanUsage,
  type PlanUsageSnapshot,
  type PlanUsageWindow,
  type RunnerModelCatalog,
} from '@orbit/shared';
import { runnerAccountPausedUntil } from '../common/account-pause';
import { runNotCounted } from '../common/run-not-counted';
import { routingHealthIndex } from '../providers/account-health.service';
import { runnerSubjectAccount, subjectKey } from '../providers/account-health';
import { runnerWithHealth } from '../providers/account-health-blocked';
import { sanitizeRunnerEngines } from '../common/runner-engines';
import { modelRoutingEnabled, optimizeForOf } from '../common/model-routing-switch';
import { resolvePermissionMode } from '../common/permission-mode';
import { firstRuntimeCatalogModel, sanitizeRuntimeDefaultModels } from '../common/runtime-model';
import { normalizeEffortForProvider } from '../common/runtime-provider';
import type { PrismaService } from '../prisma/prisma.service';
import { subagentRouteInput } from '../runner-api/subagent-route';
import {
  defaultDeepSeekKey,
  resolvedCredentialEngines,
  taskPinCredential,
  type ResolvedCredential,
} from '../providers/engine-provider';
import { sessionEngine, sessionEnginesOf } from '../providers/session-engine';
import { ACCOUNT_CHOICE } from '../providers/account';
import { automaticAccount, runAccount } from '../providers/plan-usage-accounts';
import { followsRuntimeCatalog } from '../providers/preset-overlay';
import { signedOutEngineRefusal } from '../sessions/engine-signin-preflight';
import { LEGACY_STATUS_SELECT, legacySessionStatus } from '../sessions/session-legacy-words';
import { blockedRunnerRegion } from '../runners/runner-region';
import { taskRunSeed } from '../workspaces/start-anchor';
import { RUNNER_BEATS } from '../runners/runner-presence';
import { readExecutableAcceptanceOutcome } from './executable-acceptance-round';
import {
  MODEL_ROUTING_LEVELS,
  baselineHealth,
  priorLevel,
  routeTaskRun,
  type ModelRoutingEngineState,
  type ModelRoutingHold,
  type ModelRoutingInput,
  type ModelRoutingLevel,
  type ModelRoutingRun,
  type RoutingHealthEntry,
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
        runnerId: true, effort: true,
        env: true, codexAccount: true, claudeAccount: true, kimiAccount: true, antigravityAccount: true, cursorAccount: true,
      },
    })),
    /** What an unpinned run of this task starts on: its project's coordinator, else its workspace's
     *  seed (start-anchor.ts) — the baseline routing starts from (model-routing-design.md §2). */
    seed: (workspaceId: string, taskId?: string | null) => once(
      `seed:${workspaceId}:${taskId ?? ''}`,
      () => taskRunSeed(prisma, taskId, workspaceId),
    ),
    runner: (id: string) => once(`runner:${id}`, () => prisma.runner.findFirst({
      where: { id, ownerId },
      select: {
        id: true, modelCatalog: true, runtimeDefaultModels: true, planUsage: true,
        name: true, displayName: true, status: true, ...RUNNER_BEATS, engines: true, accountNames: true,
        accountPauses: true, defaultRemoved: true,
        // The Claude region check's verdict, which rules Claude's own sign-in out as a sign-out does (engineState).
        capabilities: true, region: true,
      },
    })),
    engine: (provider: string, providerBuiltin: boolean | null) => once(
      `engine:${provider}:${providerBuiltin}`,
      () => routeEngine(prisma, ownerId, provider, providerBuiltin),
    ),
    deepSeekKey: () => once('deepseek-key', () => defaultDeepSeekKey(prisma, ownerId)),
    /** The owner's live account health by subject key (docs/routing-account-health-design.md §7.1): one batched read. */
    health: () => once('health', () => routingHealthIndex(prisma, ownerId, now)),
  };
}

/** The health index with one account's due trial read as being tried by another run: a dispatch that lost its claim
 *  routes again with that account excluded (§6.5). */
export function withTrialHeld(index: ReadonlyMap<string, RoutingHealthEntry[]>, subject: string): Map<string, RoutingHealthEntry[]> {
  const next = new Map(index);
  const entries = next.get(subject);
  if (entries) next.set(subject, entries.map((entry) => (entry.model === null && entry.state === 'trial-due' ? { ...entry, state: 'trial-running' } : entry)));
  return next;
}

export type TaskRouteReads = ReturnType<typeof taskRouteReads>;

/**
 * What a slug names (engine-provider.ts), read without refusing anything: a pin or a seed may name a key
 * disabled since, which still says which engines it runs on. `providerBuiltin` is a seed's — a configured
 * `kimi` or `dsh` stays configured, and is nothing once it is gone — and null for a task pin, which has
 * none.
 */
async function routeCredential(
  prisma: PrismaService,
  ownerId: string,
  provider: string,
  providerBuiltin: boolean | null,
): Promise<ResolvedCredential | null> {
  const keyword = provider === AgentProvider.KIMI || provider === AgentProvider.DSH;
  if (keyword && providerBuiltin === true) {
    return provider === AgentProvider.KIMI ? { kind: 'login', engine: AgentProvider.KIMI } : { kind: 'legacy-dsh' };
  }
  const credential = await taskPinCredential(prisma, ownerId, provider);
  // A configured identity under a keyword that is gone names nothing: never the built-in engine.
  if (keyword && providerBuiltin === false && (credential?.kind === 'login' || credential?.kind === 'legacy-dsh')) return null;
  return credential;
}

/**
 * Whether a run on `engine` with `credential` has a model space of its own rather than the engine's
 * runner-reported one, which is the only space a tier table describes (§4.3, docs/provider-engine-
 * contract.md §2.2): a key on Claude Code or OpenCode — unless its vendor IS that engine's own endpoint
 * (followsRuntimeCatalog), on that engine — and a credential nobody can resolve, which is not routed at
 * all. DeepSeek Harness reads its runtime catalogue on whatever DeepSeek key it spends.
 */
function ownModelSpace(credential: ResolvedCredential | null, engine: string): boolean {
  if (!credential) return true;
  if (engine === AgentProvider.DSH || credential.kind !== 'key') return false;
  const native = resolvedCredentialEngines(credential)[0];
  return native !== engine || credential.row.runtime === AgentProvider.DSH || !followsRuntimeCatalog(credential.row);
}

/**
 * Which engine a credential runs on when nothing else is named, and whether its models there are that
 * engine's own (§4.3). A slug nobody can resolve has no model space anybody can describe, so it has no
 * tier table either, and names no engine of its own: it is never read as the slug itself.
 */
async function routeEngine(
  prisma: PrismaService,
  ownerId: string,
  provider: string,
  providerBuiltin: boolean | null,
): Promise<{ credential: ResolvedCredential | null; engines: AgentProvider[]; runtime: string; hasOwnModelSpace: boolean }> {
  const credential = await routeCredential(prisma, ownerId, provider, providerBuiltin);
  const engines = credential ? resolvedCredentialEngines(credential) : [];
  const runtime = (credential?.kind === 'key' && credential.alias ? credential.alias.engine : engines[0])
    ?? AgentProvider.CLAUDE;
  return { credential, engines, runtime, hasOwnModelSpace: ownModelSpace(credential, runtime) };
}

/**
 * The engine and credential a run of this task starts on (docs/provider-engine-contract.md §1.2, §4.4):
 * its pins — both, an engine alone on that engine's own credential, a provider alone on the engine it
 * runs on by default — else the Agent's seed, re-checked as a new session re-checks it.
 */
async function routeBaseline(
  reads: TaskRouteReads,
  task: { id?: string; engine?: string | null; provider?: string | null },
  workspaceId: string,
) {
  const pinnedEngine = isEngine(task.engine) ? task.engine : null;
  const pinnedProvider = task.provider ?? null;
  let provider: string;
  let providerBuiltin: boolean | null = null;
  let providerSource: 'task-pin' | 'engine-pin' | 'agent-seed';
  let seedEngine: AgentProvider | null = null;
  if (pinnedProvider) {
    provider = pinnedProvider;
    providerSource = 'task-pin';
  } else if (pinnedEngine) {
    // An engine pinned alone runs on that engine's own credential: its sign-in, OpenCode's own config,
    // or DeepSeek Harness's default DeepSeek key.
    provider = pinnedEngine === AgentProvider.DSH
      ? (await reads.deepSeekKey())?.slug ?? pinnedEngine
      : pinnedEngine;
    providerSource = 'engine-pin';
  } else {
    const seed = await reads.seed(workspaceId, task.id);
    provider = seed.provider;
    providerBuiltin = seed.providerBuiltin;
    seedEngine = seed.engine;
    providerSource = 'agent-seed';
  }
  const { credential, engines, runtime } = await reads.engine(provider, providerBuiltin);
  const engine: string = pinnedEngine
    ?? (seedEngine && engines.includes(seedEngine) ? seedEngine : null)
    ?? (credential ? runtime : seedEngine)
    ?? AgentProvider.CLAUDE;
  return {
    engine,
    engineSource: pinnedEngine ? 'task-pin' : providerSource === 'task-pin' ? 'provider-pin' : 'agent-seed',
    provider,
    providerSource,
    /** Every engine the baseline credential runs on: where a route may take it along (§4.4). */
    engines,
    credential,
  };
}

/**
 * The baseline a run of this task starts on (routeBaseline), and its runner.
 *
 * The reads here and in `planTaskRunRoute` are awaited one at a time on purpose: one that failed
 * while the others were still in flight would leave their rejections unhandled.
 */
async function routeEnvironment(
  reads: TaskRouteReads,
  task: { id?: string; engine?: string | null; provider?: string | null },
  workspaceId: string,
  runnerId: string | null,
) {
  const { credential, ...baseline } = await routeBaseline(reads, task, workspaceId);
  const runner = runnerId ? await reads.runner(runnerId) : null;
  const owner = await reads.owner();
  return {
    ...baseline,
    runtime: baseline.engine,
    hasOwnModelSpace: ownModelSpace(credential, baseline.engine),
    runner,
    modelCatalog: (runner?.modelCatalog ?? null) as RunnerModelCatalog | null,
    runtimeDefaultModels: sanitizeRuntimeDefaultModels(runner?.runtimeDefaultModels),
    planUsage: (runner?.planUsage ?? null) as PlanUsage | null,
    owner,
    // What a task run gets: it names no mode, so the account's default, else the floor.
    permissionMode: resolvePermissionMode(null, owner),
  };
}

export type RouteAgent = NonNullable<Awaited<ReturnType<TaskRouteReads['workspace']>>>;
export type RouteRunner = NonNullable<Awaited<ReturnType<TaskRouteReads['runner']>>>;

/** What reasons call a reported window: by its length, else by the slot it was reported in. */
function windowName(window: PlanUsageWindow | undefined, slot: string): string {
  const mins = window?.windowDurationMins;
  if (!mins) return slot;
  if (mins === 7 * 24 * 60) return 'weekly';
  if (mins % (24 * 60) === 0) return `${mins / (24 * 60)}-day`;
  return mins % 60 === 0 ? `${mins / 60}-hour` : slot;
}

/**
 * When an account's quota goes to waste and whether it is nearly spent, as account selection weighs them
 * (quotaExpiresAt, quotaNearLimit in planUsage.ts): what the SubAgent router spends first (§4.2).
 */
export function quotaTiming(
  snapshot: PlanUsageSnapshot | null | undefined,
  now: Date,
): { expiresAt: number | null; expiryWindowMins: number | null; nearLimit: boolean; opusUtilization: number | null } {
  // A model family's own window (Opus or Sonnet weekly) caps that family, not the account: it moves the family's
  // rows (opusUtilization), never the account's place.
  const account = snapshot ? { ...snapshot, sevenDayOpus: undefined, sevenDaySonnet: undefined } : snapshot;
  const { at, mins } = quotaExpiry(account, now);
  const opus = snapshot?.sevenDayOpus;
  const live = opus && !(Date.parse(opus.resetsAt ?? '') <= now.getTime());
  return {
    expiresAt: Number.isFinite(at) ? at : null,
    expiryWindowMins: Number.isFinite(at) ? mins : null,
    nearLimit: quotaNearLimit(account, now),
    opusUtilization: live ? opus.utilization : null,
  };
}

/**
 * The fullest live window of one account's snapshot, the one that caps the whole engine — a model family's
 * own window (Opus weekly) is not one. Null when none is live: one past its reset has given its quota back.
 */
export function fullestWindow(snapshot: PlanUsageSnapshot | null | undefined, now: Date): ModelRoutingEngineState['quota'] {
  const windows: Array<[PlanUsageWindow | undefined, string]> = snapshot
    ? [
      [snapshot.fiveHour, '5-hour'],
      [snapshot.sevenDay, 'weekly'],
      // Kimi Code's monthly pair.
      [snapshot.month, 'monthly'],
      [snapshot.monthCode, 'monthly'],
      [snapshot.primary, windowName(snapshot.primary, 'primary')],
      [snapshot.secondary, windowName(snapshot.secondary, 'secondary')],
      // Antigravity's shared buckets and a Cursor account's usage limit (accountCapWindows).
      ...accountCapWindows(snapshot),
    ]
    : [];
  let quota: ModelRoutingEngineState['quota'] = null;
  for (const [window, name] of windows) {
    if (!window || Date.parse(window.resetsAt ?? '') <= now.getTime()) continue;
    if (!quota || window.utilization > quota.utilization) quota = { utilization: window.utilization, window: name };
  }
  return quota;
}

/**
 * Where an engine stands on the target runner for the account a run there would use (§6) — the
 * account `sessions.create` would start it on (automaticAccount, runAccount), signed in as its
 * preflight judges it (signedOutEngineRefusal). The quota is the fullest window that caps the whole
 * engine; a model family's own window (Opus weekly) only moves the tier's model (§5).
 *
 * Claude's sign-in talks to Anthropic, so on a runner whose Claude connection to Anthropic is in a region
 * Anthropic does not offer Claude in (docs/claude-region-check-contract.md §12) it is ruled out the way a
 * signed-out one is: `sessions.create` would refuse the run there with CLAUDE_REGION_UNSUPPORTED.
 */
export function engineState(
  engine: AccountEngine,
  agent: RouteAgent,
  runner: RouteRunner,
  now: Date,
  health?: ReadonlyMap<string, RoutingHealthEntry[]>,
): ModelRoutingEngineState {
  // Automatic's account skips one account health set aside, as it skips a paused one (§7.6), so a second account on
  // the engine is the one judged here; with every account out the pick is today's, and health removes the engine.
  const healthy = runnerWithHealth(runner, 'id' in runner ? (runner.id as string | null) : null, health, now);
  const automatic = automaticAccount(engine, agent, healthy, now);
  const accounts = {
    codexAccount: agent.codexAccount,
    claudeAccount: agent.claudeAccount,
    kimiAccount: agent.kimiAccount,
    antigravityAccount: agent.antigravityAccount,
    cursorAccount: agent.cursorAccount,
    ...(automatic ? { [ACCOUNT_CHOICE[engine]]: automatic } : {}),
  };
  const signedOut = signedOutEngineRefusal({
    runtime: engine,
    bringsOwnCredentials: false,
    workspaceEnv: agent.env,
    accounts,
    runner,
    nowMs: now.getTime(),
  }) !== null;
  const account = runAccount(engine, agent.env, accounts, healthy, now);
  // Antigravity's reading travels with its engine health, not in planUsage: folded in as every quota reader does.
  const usage = withEnginePlanUsage(runner.planUsage as PlanUsage | null, sanitizeRunnerEngines(runner.engines));
  const snapshot = account === null ? undefined : spentPlanUsage(usage, engine, account);
  const quota = fullestWindow(snapshot, now);
  // No reading at all, or one without a window fullestWindow reads (a runner that fetched nothing for it).
  // Antigravity reads as read once it reports any bucket (one of a model's own is a reading too); Cursor once it
  // reports its included usage.
  const quotaUnread = !snapshot
    || (![snapshot.fiveHour, snapshot.sevenDay, snapshot.month, snapshot.monthCode, snapshot.primary, snapshot.secondary].some(Boolean)
      && !(snapshot.buckets?.length) && !cursorUsageRead(snapshot));
  const regionBlocked = engine === AgentProvider.CLAUDE && blockedRunnerRegion(runner, now) !== null;
  // Only the SubAgent router reads it (routeSubagent); chooseEngine does not.
  const paused = runnerAccountPausedUntil(runner.accountPauses, engine, account, now) !== null;
  // What account health learned of that account on this runner (§6.1, §7.1): the subject the ingest records it under.
  const subjectAccount = runnerSubjectAccount(account);
  const entries = health && subjectAccount !== null && 'id' in runner && runner.id
    ? health.get(subjectKey({ type: 'runner', runnerId: runner.id, engine, account: subjectAccount }))
    : undefined;
  return {
    signedOut, quota, ...quotaTiming(snapshot, now), ...(quotaUnread ? { quotaUnread } : {}), ...(regionBlocked ? { regionBlocked } : {}), ...(paused ? { paused } : {}),
    ...(entries?.length ? { health: entries } : {}),
  };
}

/** The engine a task's newest work run was created on: what a verification looks past (§6). */
async function lastRunEngine(reads: TaskRouteReads, taskId: string): Promise<string | null> {
  const run = await reads.prisma.session.findFirst({
    where: { ownerId: reads.ownerId, taskId, startsTaskWork: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { engine: true, provider: true, providerBuiltin: true, ownerId: true },
  });
  return run ? sessionEngine(reads.prisma, run) : null;
}

/** For a verification task, the engine the task it verifies last ran on (§6): the pick moves off it when it can. */
async function routeEngines(
  reads: TaskRouteReads,
  task: TaskRouteSubject,
): Promise<NonNullable<ModelRoutingInput['engines']>> {
  return { verifiedRunEngine: task.verifiesTaskId ? await lastRunEngine(reads, task.verifiesTaskId) : null };
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
      id: true, createdAt: true, ...RELEASE_FAILURE_SELECT, ...LEGACY_STATUS_SELECT, error: true, failureKind: true, accountHealthEffect: true,
      engine: true, provider: true, providerBuiltin: true, ownerId: true, model: true, effort: true,
    },
  });
  // The engine each ran on: its recorded one, else what the old rules derive (§5.4).
  const engines = await sessionEnginesOf(prisma, runs);
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
    // The run failed: released by a failure (common/session-release.ts).
    const failed = releaseWasFailure(run);
    const next = runs[index + 1]?.createdAt;
    const judged = (at: Date) => at >= run.createdAt && (!next || at < next);
    return {
      ordinal: index + 1,
      // The word derived from the facts (plan §3.1); a task's run is never a LANDING container.
      status: legacySessionStatus(run),
      // Skipped for escalation when its failure was the account's or the provider's (common/run-not-counted.ts, §7.4).
      ...(failed && runNotCounted(run) ? { notCounted: runNotCounted(run) } : {}),
      ...(failed && run.accountHealthEffect === 'TRIAL' ? { trialOf: run.provider } : {}),
      level: MODEL_ROUTING_LEVELS.find((level) => level === levels.get(run.id)) ?? null,
      model: run.model,
      effort: run.effort,
      runtime: engines.get(run.id) ?? undefined,
      // The run's own end first, then what was said about its work afterwards.
      outcome: failed
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
  engine?: string | null;
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
 * `applied` whenever a tier was decided: the run is then created on the routed provider, model and
 * effort (§7.4). There is no per-Agent switch any more (owner, 2026-11-20; `workspace.modelRouting`
 * is no longer read): the account's switch alone decides.
 *
 * Null when the account has smart model selection off (common/model-routing-switch.ts): routing
 * does not exist then, so there is no decision to record, and the run is dispatched as before routing.
 */
/** What a dispatch acts on before it freezes a plan (docs/routing-account-health-design.md §6.5, §7.5). */
interface PlannedHealth {
  /** Nothing can run it now: no run is started, and the task waits. */
  hold?: ModelRoutingHold;
  /** The pick's account is due its trial, which the dispatch claims before the run starts. */
  trial?: { subject: string; scopeModel: string; provider: string };
}

/**
 * A planned route, with what the dispatch acts on before it freezes one. With smart model selection off there is no
 * route, and only what account health says of the baseline's account (`notRouted`): the run is dispatched as before
 * routing, unless health holds it.
 */
export type PlannedTaskRunRoute = (TaskRunRoute & PlannedHealth & { notRouted?: undefined }) | (PlannedHealth & { notRouted: true });

/** The route a plan freezes, without what the dispatch acted on: null when nothing was routed. */
export function routeOfPlan(planned: PlannedTaskRunRoute | null): TaskRunRoute | null {
  if (!planned || planned.notRouted) return null;
  const { hold: _hold, trial: _trial, notRouted: _notRouted, ...route } = planned;
  return route;
}

export async function planTaskRunRoute(
  reads: TaskRouteReads,
  task: TaskRouteSubject,
  workspace: { id: string; runnerId: string },
  prompt: string,
  health?: ReadonlyMap<string, RoutingHealthEntry[]>,
): Promise<PlannedTaskRunRoute | null> {
  if (!modelRoutingEnabled(await reads.owner())) return baselineHealthPlan(reads, task, workspace, health);
  const { prisma, ownerId } = reads;
  const env = await routeEnvironment(reads, task, workspace.id, workspace.runnerId);
  const agent = await reads.workspace(workspace.id);
  const history = await readRunHistory(prisma, ownerId, task.id);
  const dependents = await prisma.taskDependency.count({ where: { dependsOnTaskId: task.id } });
  // The effort `sessions.create` gives a run that names none: the Agent's, else the account's.
  const named = agent && agent.effort !== null
    ? agent.effort
    : ((env.owner?.preferences ?? {}) as { defaultEffort?: string }).defaultEffort || undefined;
  const effort = normalizeEffortForProvider(env.engine as AgentProvider, named) || null;
  const modelHint = MODEL_ROUTING_LEVELS.find((level) => level === task.modelHint) ?? null;
  const engines = await routeEngines(reads, task);
  // The pool the SubAgent router picks from, read for this Agent's runner the way a SubAgent there reads it.
  const pool = await subagentRouteInput(prisma as unknown as Prisma.TransactionClient, {
    ownerId,
    workspaceId: workspace.id,
    runnerId: workspace.runnerId,
    dto: { toolUseId: '', type: 'task', definitionSource: 'builtin' },
    parent: { engine: env.engine, provider: env.provider, model: task.model ?? '', effort },
    now: reads.now,
    health: health ?? await reads.health(),
  });
  const structuralFeatures = {
    completionCriterion: task.completionCriterion ?? null,
    hasAcceptanceCommand: task.acceptanceCommand != null,
    verifiesTask: task.verifiesTaskId != null,
    isForeman: task.isForeman === true,
    dependents,
    promptChars: prompt.length,
  };
  // The account's, for every Agent (owner, 2026-11-19).
  const optimizeFor = optimizeForOf(await reads.owner());
  const decision = routeTaskRun({
    optimizeFor,
    relaxBlockedPins: relaxBlockedPinsOf(await reads.owner()),
    features: structuralFeatures,
    task: {
      engine: task.engine ?? null,
      provider: task.provider ?? null,
      model: task.model ?? null,
      modelHint,
      modelHintReason: task.modelHintReason ?? null,
    },
    baseline: { engine: env.engine, engines: env.engines, provider: env.provider, model: task.model ?? null, effort },
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
    pool,
  });
  // The run the router compared against: the newest one that is counted (§7.4).
  const skipped = history.findIndex((run) => !run.notCounted);
  const last = skipped < 0 ? undefined : history[skipped];
  const passedOver = skipped < 0 ? history : history.slice(0, skipped);
  const lastLevel = last ? priorLevel(last, env.runtime) : null;
  const escalatedFrom = decision.level && lastLevel && last?.outcome !== 'OK'
    && MODEL_ROUTING_LEVELS.indexOf(decision.level) > MODEL_ROUTING_LEVELS.indexOf(lastLevel)
    ? lastLevel
    : null;
  return {
    policyVersion: decision.policyVersion,
    // Only a decided tier is applied: one that kept the baseline (a model pin, no suggestion, no
    // provider that can take it) changes nothing. A pin relaxed off an account health set aside is applied too
    // (docs/routing-account-health-design.md §7.5): a model pin moves with no tier.
    applied: decision.level !== null || decision.relaxed === true,
    level: decision.level,
    engine: decision.engine,
    provider: decision.provider,
    model: decision.model,
    effort: decision.effort,
    baseline: {
      engine: env.engine,
      engineSource: env.engineSource,
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
      ...structuralFeatures,
      optimizeFor,
      priorRuns: history.length,
      priorFailures: history
        .filter((run) => run.outcome !== 'OK' && !run.notCounted).length,
      quotaFailuresSkipped: passedOver.filter((run) => run.notCounted === 'usage-limit').length,
      capacityFailuresSkipped: passedOver.filter((run) => run.notCounted === 'capacity').length,
      // The rest of what §7.4 does not count: an account's refusal, a lost connection, a failure at admission.
      accountFailuresSkipped: passedOver.filter((run) => run.notCounted === 'account' || run.notCounted === 'admission').length,
      lastRun: last
        ? { ordinal: last.ordinal, level: lastLevel, model: last.model ?? null, outcome: last.outcome }
        : null,
      escalatedFrom,
      opusWeeklyUtilization: env.planUsage?.claude?.sevenDayOpus?.utilization ?? null,
      verifiedRunEngine: engines.verifiedRunEngine ?? null,
    },
    reasons: decision.reasons,
    ...(decision.hold ? { hold: decision.hold } : {}),
    ...(decision.trial ? { trial: decision.trial } : {}),
  };
}

/** UserPreferences.relaxBlockedPins (docs/routing-account-health-design.md §7.5): on only when written true. */
export function relaxBlockedPinsOf(owner: { preferences: unknown } | null | undefined): boolean {
  return (owner?.preferences as { relaxBlockedPins?: unknown } | null | undefined)?.relaxBlockedPins === true;
}

/**
 * The plan of a run that is not routed, the owner's smart model selection being off: what account health says of the
 * account its baseline (or its pins) would spend. A run there is not started while health sets that account aside,
 * and claims the trial it is due, as a routed one does (§6.5, §7.5); no tier and no relaxation, which are routing.
 * Null when health has nothing to say: an owner with no live row pays the one read the dispatch makes anyway.
 */
async function baselineHealthPlan(
  reads: TaskRouteReads,
  task: TaskRouteSubject,
  workspace: { id: string; runnerId: string },
  health?: ReadonlyMap<string, RoutingHealthEntry[]>,
): Promise<PlannedTaskRunRoute | null> {
  const index = health ?? await reads.health();
  if (![...index.values()].some((entries) => entries.length > 0)) return null;
  const env = await routeEnvironment(reads, task, workspace.id, workspace.runnerId);
  const pool = await subagentRouteInput(reads.prisma as unknown as Prisma.TransactionClient, {
    ownerId: reads.ownerId,
    workspaceId: workspace.id,
    runnerId: workspace.runnerId,
    dto: { toolUseId: '', type: 'task', definitionSource: 'builtin' },
    parent: { engine: env.engine, provider: env.provider, model: task.model ?? '', effort: null },
    now: reads.now,
    health: index,
  });
  const verdict = baselineHealth({
    task: { engine: task.engine ?? null, provider: task.provider ?? null, model: task.model ?? null },
    baseline: { engine: env.engine, engines: env.engines, provider: env.provider, model: task.model ?? null, effort: null },
    history: [],
    environment: { runtime: env.runtime },
    pool,
  });
  return verdict.hold || verdict.trial ? { notRouted: true, ...verdict } : null;
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
      // The credential the run spends — an engine's own sign-in is named by the engine (§4.4).
      provider: route.provider ?? route.engine ?? '',
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
  /** The §7.5 sentence when the run went elsewhere because its pin could not run (`relaxedRunSentence`); else null. */
  relaxedRun: string | null;
  policyVersion: number;
  decidedAt: Date;
}

/**
 * The §7.5 sentence of a run that went elsewhere because its pin could not run: which pin, where it ran and why, as
 * model-routing's relaxedPin and samePinnedModel wrote it into the decision's reasons. Null for any other run.
 */
export function relaxedRunSentence(reasons: readonly string[] | null | undefined): string | null {
  return reasons?.find((r) => r.startsWith('Pinned to ') && r.includes("can't run now")) ?? null;
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
    relaxedRun: relaxedRunSentence(row.reasons),
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
 * Each tier as the router would resolve it for this task on its Agent's runner, from the same pool
 * and the same catalogue rules — so the picker never shows a model routing would not pick. What
 * the runner says of each sign-in and every account's quota are left out: they move a single
 * decision, not what a tier means.
 */
export async function readModelHintOptions(
  reads: TaskRouteReads,
  task: { id?: string; engine?: string | null; provider?: string | null; assigneeId?: string | null },
): Promise<ModelHintOption[]> {
  const agent = task.assigneeId ? await reads.workspace(task.assigneeId) : null;
  const env = agent ? await routeEnvironment(reads, task, task.assigneeId!, agent.runnerId) : null;
  const read = agent && env ? await subagentRouteInput(reads.prisma as unknown as Prisma.TransactionClient, {
    ownerId: reads.ownerId,
    workspaceId: task.assigneeId!,
    runnerId: agent.runnerId,
    dto: { toolUseId: '', type: 'task', definitionSource: 'builtin' },
    parent: { engine: env.engine, provider: env.provider, model: '', effort: null },
    now: reads.now,
  }) : null;
  const pool = read && {
    ...read,
    engines: null,
    providers: read.providers.map(({ account: _account, ...provider }) => (provider.pool
      ? { ...provider, pool: { members: provider.pool.members.map((m) => ({ label: m.label })) } }
      : provider)),
  };
  return MODEL_ROUTING_LEVELS.map((level) => {
    const decision = env && routeTaskRun({
      task: { engine: task.engine ?? null, provider: task.provider ?? null, modelHint: level },
      baseline: { engine: env.engine, engines: env.engines, provider: env.provider, model: null, effort: null },
      history: [],
      environment: {
        runtime: env.runtime,
        hasOwnModelSpace: env.hasOwnModelSpace,
        modelCatalog: env.modelCatalog,
        runtimeDefaultModels: env.runtimeDefaultModels,
        defaultPermissionMode: env.permissionMode,
      },
      pool,
    });
    const model = decision?.level ? decision.model : null;
    return {
      level,
      provider: (model ? decision!.provider : null) ?? env?.provider ?? task.provider ?? null,
      model,
      label: model ? runnerCatalogRow(decision!.engine, model, env!.modelCatalog)?.label ?? model : null,
      effort: model ? decision!.effort : null,
    };
  });
}
