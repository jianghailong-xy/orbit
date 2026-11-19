import {
  AgentProvider,
  PermissionMode,
  autoAvailable,
  credentialIsAnthropicBound,
  runnerCatalogRow,
  type AnthropicBoundCredential,
  type PlanUsage,
  type RunnerModelCatalog,
  type RunnerModelInfo,
  type RuntimeDefaultModels,
} from '@orbit/shared';

export const MODEL_ROUTING_POLICY_VERSION = 2;
export const MODEL_ROUTING_LEVELS = ['S', 'M', 'L', 'XL'] as const;
export type ModelRoutingLevel = (typeof MODEL_ROUTING_LEVELS)[number];

export const DEFAULT_MODEL_TIER_TABLE = {
  claude: {
    S: { prefix: 'claude-sonnet-', effort: 'low' },
    M: { prefix: 'claude-sonnet-', effort: 'medium' },
    L: { prefix: 'claude-opus-', effort: 'high' },
    XL: { prefix: 'claude-opus-', effort: 'max' },
  },
  codex: {
    S: { effort: 'low' },
    M: { effort: 'medium' },
    L: { effort: 'high' },
    XL: { effort: 'xhigh' },
  },
  // SubAgent routing only (MODEL_ROUTING_ENGINES does not list it). Each tier takes the first of its models
  // the runner reports: catalogues differ by account and site, and K3 is on every one reported so far.
  // Efforts are Kimi's own thinking levels (low, high, max).
  kimi: {
    S: { models: ['kimi-code/k3'], effort: 'low' },
    M: { models: ['kimi-code/k3'], effort: 'high' },
    L: { models: ['kimi-code/k3.1-pro', 'kimi-code/k3'], effort: 'high' },
    XL: { models: ['kimi-code/k3.1-pro', 'kimi-code/k3'], effort: 'max' },
  },
} as const;

/** The built-in engines with a tier table: the only ones a run can be routed onto from another (§4.3, §6). */
export const MODEL_ROUTING_ENGINES: readonly string[] = [AgentProvider.CLAUDE, AgentProvider.CODEX];

/** At or above this share of a window used, an engine is not picked for a fresh run (§6). */
export const ENGINE_QUOTA_LIMIT = 90;

/** What the target runner says of one engine, for the account a run there would use (§6). */
export interface ModelRoutingEngineState {
  signedOut?: boolean;
  /** Claude's own sign-in on a runner whose Claude connection to Anthropic is in a region Anthropic does not offer
   *  Claude in (docs/claude-region-check-contract.md §12): ruled out as a signed-out engine is. */
  regionBlocked?: boolean;
  /** The fullest of that account's windows that cap the whole engine, not one model family. */
  quota?: { utilization: number; window: string } | null;
  /** That account is paused on the runner. */
  paused?: boolean;
  /** No quota reading for that account: `quota` null then says nothing about its headroom. Only the SubAgent
   *  router reads it (routeSubagent ranks such an account after those whose headroom is known). */
  quotaUnread?: boolean;
  /** When what that account has left goes to waste (quotaExpiresAt, ms); null when no reset is known. And whether a
   *  window is nearly spent (quotaNearLimit). Only the SubAgent router reads them: soonest expiry first. */
  expiresAt?: number | null;
  nearLimit?: boolean;
  /** That account's Opus weekly window, in percent; null when none is live. At ENGINE_QUOTA_LIMIT Opus is not routed onto. */
  opusUtilization?: number | null;
}

export interface ModelRoutingSelection {
  /** The credential the run spends (docs/provider-engine-contract.md §4.4): the baseline's own, or —
   *  on an engine the baseline credential cannot run — that engine's own sign-in, named by the engine. */
  provider: string;
  model: string | null;
  effort: string | null;
}

export type ModelRoutingOutcome =
  'FAILED' | 'ACCEPTANCE_FAILED' | 'VERIFICATION_FAILED' | 'SENT_BACK' | 'OK';

/**
 * What a run's error says when the provider found the model at capacity ("Selected model is at
 * capacity"), matched case-insensitively as a substring. Keep it identical to isCodexCapacityError in
 * src/runner-go/codex.go.
 */
export const MODEL_AT_CAPACITY_ERROR_MARKER = 'at capacity';

export interface ModelRoutingRun {
  ordinal: number;
  status: string;
  quotaFailure: boolean;
  /** Failed on "Selected model is at capacity"; skipped for escalation like quotaFailure. */
  capacityFailure?: boolean;
  /** The prior decision's tier, including a shadow decision; null falls back to the actual model. */
  level?: ModelRoutingLevel | null;
  model?: string | null;
  effort?: string | null;
  runtime?: string;
  /** Includes a verifier FAIL or owner SEND_BACK after this work run. */
  outcome?: ModelRoutingOutcome;
}

export interface ModelRoutingFeatures {
  completionCriterion?: string | null;
  hasAcceptanceCommand?: boolean;
  verifiesTask?: boolean;
  isForeman?: boolean;
  dependents?: number;
  promptChars?: number;
}

/** Structural inference uses only the same value snapshot recorded with the decision. */
export function inferRuleTier(features: ModelRoutingFeatures = {}): {
  level: ModelRoutingLevel | null; source: 'rule'; reasons: string[];
} {
  const validCount = (value: number | undefined): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  const { completionCriterion, hasAcceptanceCommand, verifiesTask, isForeman, dependents, promptChars } = features;
  let level: ModelRoutingLevel | null = null;
  let body = 'No structural rule matched';
  if (isForeman === true || verifiesTask === true ||
      completionCriterion === 'OWNER_CONFIRMED' || completionCriterion === 'VERIFICATION') {
    level = 'L';
    body = 'Tier L: review or coordination requires a conservative starting tier';
  } else if ((validCount(dependents) && dependents >= 3) || (validCount(promptChars) && promptChars >= 8000)) {
    level = 'L';
    body = 'Tier L: broad dependency impact or a large prompt';
  } else if (completionCriterion === 'EXECUTABLE' && hasAcceptanceCommand === true) {
    level = 'M';
    body = 'Tier M: executable work with acceptance feedback';
    if (dependents === 0 && validCount(promptChars) && promptChars > 0 && promptChars <= 2000) {
      level = 'S';
      body = 'Tier S: bounded executable work with immediate acceptance feedback';
    }
  }
  return { level, source: 'rule', reasons: [`[rule] Rule inference — ${body}`] };
}

export type ModelRoutingOptimizeFor = 'cost' | 'balance' | 'intelligence';

export interface ModelRoutingInput {
  optimizeFor?: ModelRoutingOptimizeFor;
  features?: ModelRoutingFeatures;
  task: {
    /** The task's engine pin: like a provider pin, it keeps the run on its engine. */
    engine?: string | null;
    provider?: string | null;
    model?: string | null;
    modelHint?: ModelRoutingLevel | null;
    modelHintReason?: string | null;
  };
  baseline: ModelRoutingSelection & {
    /** The engine the baseline runs on; absent, `environment.runtime`. */
    engine?: string;
    /** Every engine the baseline credential can run on (the shared compatibility table). A run moved to
     *  one of them keeps that credential; absent, the credential runs on its own engine only. */
    engines?: readonly string[];
  };
  /** Work runs only, newest first. The caller supplies ordering and quota classification. */
  history: readonly ModelRoutingRun[];
  environment: {
    /** Resolved runtime of task.provider, or baseline.provider when the task has no provider pin. */
    runtime: string;
    /** Configured providers with their own model space have no runtime tier table. */
    hasOwnModelSpace?: boolean;
    modelCatalog?: RunnerModelCatalog | null;
    runtimeDefaultModels?: RuntimeDefaultModels | null;
    defaultPermissionMode?: string | null;
    planUsage?: PlanUsage | null;
  };
  engines?: {
    /** For a verification task: the engine the task it verifies last ran on, which the pick moves off when it can. */
    verifiedRunEngine?: string | null;
  };
  /** What the SubAgent router reads for the Agent's runner (runner-api/subagent-route.ts subagentRouteInput): the
   *  pool a tiered run is picked from. Absent: nothing was read, and the run keeps the agent's model. */
  pool?: SubagentRoutingInput | null;
}

export interface ModelRoutingDecision extends ModelRoutingSelection {
  policyVersion: typeof MODEL_ROUTING_POLICY_VERSION;
  level: ModelRoutingLevel | null;
  /** The engine the run starts on: the baseline's, or the one the route moved it to (§6). */
  engine: string;
  reasons: string[];
}

const FAILURE_WORDING = {
  FAILED: 'failed',
  ACCEPTANCE_FAILED: 'failed its acceptance command',
  VERIFICATION_FAILED: 'was failed by its verifier',
  SENT_BACK: 'was sent back by the owner',
} as const;

export function priorLevel(run: ModelRoutingRun, runtime: string): ModelRoutingLevel | null {
  if (run.level) return run.level;
  const model = run.model ?? '';
  if (model === 'opus' || model.startsWith('claude-opus-')) return 'L';
  if (model === 'sonnet' || model.startsWith('claude-sonnet-')) return 'M';
  if ((run.runtime ?? runtime) === AgentProvider.CODEX) {
    return MODEL_ROUTING_LEVELS.find((level) =>
      DEFAULT_MODEL_TIER_TABLE.codex[level].effort === run.effort,
    ) ?? null;
  }
  return null;
}

/** No I/O or writes to the task: every decision depends only on these value snapshots. */
export function routeTaskRun(input: ModelRoutingInput): ModelRoutingDecision {
  const { task, baseline, environment, history } = input;
  const { runtime } = environment;
  const own = baseline.engine ?? runtime;
  const provider = task.provider ?? baseline.provider;
  const unchanged = (reasons: string[]): ModelRoutingDecision => ({
    engine: own,
    provider,
    model: task.model ?? baseline.model,
    effort: baseline.effort,
    policyVersion: MODEL_ROUTING_POLICY_VERSION,
    level: null,
    reasons: reasons.map((reason) => reason.startsWith('[') ? reason : `[not-routed] ${reason}`),
  });
  if (task.model != null) return unchanged([`Task pin: ${task.model}`]);

  const skipped: string[] = [];
  let last: ModelRoutingRun | undefined;
  for (const run of history) {
    if (run.quotaFailure) {
      skipped.push(`Run ${run.ordinal} hit a usage limit — not counted`);
    } else if (run.capacityFailure) {
      skipped.push(`Run ${run.ordinal} found the model at capacity — not counted`);
    } else {
      last = run;
      break;
    }
  }
  const rule = task.modelHint ? null : inferRuleTier(input.features);
  let level = task.modelHint ?? rule?.level ?? null;
  const reasons: string[] = rule?.level ? [...rule.reasons] : [];
  const mode = input.optimizeFor ?? 'cost';
  const floor = mode === 'balance' ? 'M' : mode === 'intelligence' ? 'L' : null;
  if (!task.modelHint && floor && (!level || MODEL_ROUTING_LEVELS.indexOf(level) < MODEL_ROUTING_LEVELS.indexOf(floor))) {
    level = floor;
    reasons.push(`[default] Tier ${floor}: ${mode === 'balance' ? 'Balance' : 'Intelligence'} minimum for a task without a suggestion`);
  }
  const lastLevel = last ? priorLevel(last, runtime) : null;
  const failure = last?.outcome && last.outcome !== 'OK'
    ? last.outcome
    : last?.status === 'FAILED' ? 'FAILED' : null;
  if (last && lastLevel && failure) {
    const next = Math.min(MODEL_ROUTING_LEVELS.indexOf(lastLevel) + 1, 3);
    level = MODEL_ROUTING_LEVELS[Math.max(next, level ? MODEL_ROUTING_LEVELS.indexOf(level) : 0)];
    reasons.push(
      `[escalate] Tier ${level} — ${level === lastLevel ? 'already the highest tier after' : 'raised after'} ` +
      `run ${last.ordinal} (${lastLevel}) ${FAILURE_WORDING[failure]}`,
    );
    if (!last.level) {
      const label = runnerCatalogRow(last.runtime ?? runtime, last.model ?? '', environment.modelCatalog)?.label
        ?? last.model ?? runtime;
      reasons.push(
        `[escalate] Run ${last.ordinal} used ${label}` +
        `${last.effort ? ` · ${last.effort}` : ''}, which counts as tier ${lastLevel}`,
      );
    }
    if (task.modelHint && MODEL_ROUTING_LEVELS.indexOf(task.modelHint) > next) {
      reasons.push(`[coordinator] Coordinator suggested tier ${task.modelHint}${task.modelHintReason ? `: ${task.modelHintReason}` : ''}`);
    }
  } else if (task.modelHint) {
    reasons.push(`[coordinator] Tier ${level}: suggested by the coordinator${task.modelHintReason ? ` — ${task.modelHintReason}` : ''}`);
  } else if (!level) {
    reasons.push("[not-routed] No suggestion — keeps the agent's model, as today");
  }
  reasons.push(...skipped);
  if (!level) {
    reasons.push(`Engine ${own}: ${task.engine || task.provider ? 'pinned on the task' : "this agent's own engine"}`);
    return unchanged(reasons);
  }
  if (!input.pool) return unchanged([...reasons, "No providers were read — keeps the agent's model"]);
  // The pick is the SubAgent router's (§4.2), at this tier: every provider × engine × model the owner has.
  const pool = taskRunPool(input, input.pool, level, mode);
  const route = routeSubagent(pool);
  const candidates = fallbackOrder(route);
  const runnable = candidates.filter((c) => autoEligible(c, environment));
  if (runnable.length < candidates.length || pool.modelCatalog !== input.pool.modelCatalog) {
    reasons.push('Models without Auto permission support were excluded');
  }
  const verified = input.engines?.verifiedRunEngine ?? null;
  const fresh = verified ? runnable.find((c) => c.engine !== verified) : undefined;
  // The Agent's own engine and credential keep the run while they can take it at this tier (owner, 2026-11-20): the
  // router's ranking only decides where it goes when they cannot. A verification's fresh pair of eyes comes first.
  const credential = task.provider ?? baseline.provider;
  const ownPick = runnable.find((c) => c.engine === own && c.provider === credential && c.level === level);
  const pick = fresh ?? ownPick ?? runnable[0];
  // The router's own words, less what only a SubAgent says: the caller that set the tier, and its refusal.
  const lines = route.reasons.filter((r) =>
    !r.startsWith(`Tier ${level}, set by the caller`) && !r.startsWith('No provider can run a SubAgent'));
  if (!pick) {
    return unchanged([...reasons, ...lines, "No provider can run it at this tier — keeps the agent's model"]);
  }
  if (!fresh && ownPick && pick === ownPick) {
    reasons.push(`Engine ${own}: this agent's own engine, which can take the run at tier ${level}`);
  }
  if (verified) {
    reasons.push(fresh
      ? `Engine ${pick.engine}: the task it verifies last ran on ${verified}`
      : `Engine ${pick.engine}: no other engine it may use is available; the task it verifies last ran on ${verified}`);
  }
  if (pick !== candidates[0]) {
    // The router's "Picked …" names the candidate it ranked first, not this one.
    reasons.push(...lines.filter((r) => !r.startsWith('Picked ')));
    reasons.push(`Runs on ${pick.model}${pick.effort ? ` · ${pick.effort}` : ''} on ${pick.provider}${pick.note ? `, ${pick.note}` : ''}`);
  } else {
    reasons.push(...lines);
  }
  return {
    policyVersion: MODEL_ROUTING_POLICY_VERSION,
    level,
    engine: pick.engine,
    provider: pick.provider,
    model: pick.model,
    effort: pick.effort,
    reasons,
  };
}

/** The SubAgent router's input for one task run at `level`: the owner's providers as read for the Agent's runner,
 *  less what the task's engine or provider pin rules out, and in Auto mode less the runner's Claude models that
 *  cannot use Auto, so a tier's family is picked among the ones that can. */
function taskRunPool(
  input: ModelRoutingInput,
  pool: SubagentRoutingInput,
  level: ModelRoutingLevel,
  mode: ModelRoutingOptimizeFor,
): SubagentRoutingInput {
  const { engine, provider } = input.task;
  const providers = pool.providers
    .filter((p) => !provider || p.slug === provider)
    .map((p) => (engine ? { ...p, engines: p.engines.filter((spec) => spec.engine === engine) } : p))
    .filter((p) => p.engines.length > 0);
  const claude = pool.modelCatalog?.[AgentProvider.CLAUDE];
  const auto = claude?.filter((row) => autoEligible(
    { engine: AgentProvider.CLAUDE, provider: '', model: row.value, effort: null }, input.environment));
  const modelCatalog = claude && auto && auto.length < claude.length
    ? { ...pool.modelCatalog, [AgentProvider.CLAUDE]: auto }
    : pool.modelCatalog;
  return {
    ...pool,
    modelCatalog,
    type: 'task',
    definitionName: 'the task',
    caller: { size: level },
    definition: {},
    optimizeFor: mode,
    providers,
    smartSelection: true,
    strictNamedModel: false,
    runnerLabel: "this agent's runner",
  };
}

/** The pick and then its fallbacks, in the router's order. */
function fallbackOrder(route: SubagentRoutingDecision): SubagentFallback[] {
  const first = route.engine && route.provider && route.model
    ? [{
      engine: route.engine, provider: route.provider, model: route.model, effort: route.effort, level: route.pickLevel ?? null,
      ...(route.note ? { note: route.note } : {}),
    }]
    : [];
  return [...first, ...route.fallbacks];
}

/** A Claude model a run in Auto permission mode can use: Auto has to be available for it. */
function autoEligible(c: SubagentFallback, environment: ModelRoutingInput['environment']): boolean {
  return c.engine !== AgentProvider.CLAUDE
    || environment.defaultPermissionMode !== PermissionMode.AUTO
    || autoAvailable(c.engine, c.model, false, environment.modelCatalog);
}

// ─────────────────────────── SubAgent routing (docs/subagent-design.md §4.1, §4.2) ───────────────────────────

/** What a recorded SubAgent decision was made under: bump when a rule below changes what it picks. */
export const SUBAGENT_ROUTING_POLICY_VERSION = 'p6-subscriptions-first-1';

/** Which row of §4.1 set the tier — or, for the first two, the model; `not-routed`: smart model selection is off. */
export type SubagentTierSource =
  'not-routed' | 'named-model' | 'definition-model' | 'size' | 'definition-size' | 'type-default';

/** One row of the tier table: a model on one engine at one effort, its tier and its price (§4.2). */
export interface SubagentModelRow {
  model: string;
  effort: string | null;
  /** Null: the model has no tier; an engine with no tiers at all routes its default model, after every tiered one. */
  level: ModelRoutingLevel | null;
  /** USD per million output tokens, for a metered key; null when nobody knows it. */
  outputPricePerMTok?: number | null;
}

/** One engine a provider runs on, as the parent's runner sees it. */
export interface SubagentProviderEngine {
  engine: string;
  /** The rows of a model space of the provider's own. Absent: the engine's runner-reported catalogue,
   *  which only the built-in tier table (DEFAULT_MODEL_TIER_TABLE) describes. */
  models?: readonly SubagentModelRow[];
  /** For a key on that catalogue: USD per million output tokens by model id (models.dev). */
  prices?: Readonly<Record<string, number>>;
  /** The model it runs when none is named (the provider's own default): what an engine with no tiers routes onto. */
  defaultModel?: string | null;
}

/** One account of an account pool, as its quota and pause stand. */
export interface SubagentPoolMember {
  label: string;
  /** Its fullest live window; null when every window it reported has room again. */
  quota?: ModelRoutingEngineState['quota'];
  paused?: boolean;
  /** The endpoint refused its credential: no run can go to it. */
  refused?: boolean;
  /** Its quota could not be read: nothing was reported, or the endpoint will not report on it. */
  unreadable?: boolean;
  /** When its quota goes to waste (ms), null when unknown; and whether a window is nearly spent. */
  expiresAt?: number | null;
  nearLimit?: boolean;
  /** Its Opus weekly window, in percent; null when none is live. */
  opusUtilization?: number | null;
}

/** One provider the owner has, in the owner's order (provider_list). */
export interface SubagentProvider {
  slug: string;
  /** A sign-in that spends a subscription's quota, or a key that is billed per token. */
  billing: 'subscription' | 'key';
  /** Inside usableProviderScope: a shared provider is for admins only. */
  inScope: boolean;
  engines: readonly SubagentProviderEngine[];
  /** The credential it spends, as far as the Claude region check asks (credentialIsAnthropicBound, contract §8). */
  credential: AnthropicBoundCredential;
  /** A subscription's account on the parent's runner: its fullest window, and whether it is paused. */
  account?: {
    quota?: ModelRoutingEngineState['quota']; paused?: boolean; refused?: boolean; unreadable?: boolean;
    expiresAt?: number | null; nearLimit?: boolean; opusUtilization?: number | null;
  } | null;
  /** An account pool: a subscription on its members' own credentials, whose headroom is its best member's. */
  pool?: { members: readonly SubagentPoolMember[] };
}

/** The parent's runner's word on one engine. An engine absent from `SubagentRoutingInput.engines` was not reported. */
export interface SubagentEngineReport extends ModelRoutingEngineState {
  installed: boolean;
}

export interface SubagentRoutingInput {
  /** `explore`, `general` or a definition's name. */
  type: string;
  /** What reasons call the definition: its file name, or the built-in type. */
  definitionName: string;
  caller: { model?: string | null; size?: ModelRoutingLevel | null; sizeReason?: string | null };
  /** The definition's `model` (an id, `inherit` or `auto`) and its `size`. */
  definition: { model?: string | null; size?: ModelRoutingLevel | null };
  optimizeFor: ModelRoutingOptimizeFor;
  /** The parent session's own engine, credential, model and effort. */
  parent: { engine: string; provider: string; model: string; effort: string | null };
  providers: readonly SubagentProvider[];
  /** `UserPreferences.subagentBlockedProviders`. */
  blockedProviders: readonly string[];
  /** The parent's runner's report, by engine; null when that runner has reported none. */
  engines: Readonly<Record<string, SubagentEngineReport>> | null;
  modelCatalog?: RunnerModelCatalog | null;
  runtimeDefaultModels?: RuntimeDefaultModels | null;
  /** The runner `engines` reports on, as the reasons name it; `the parent's runner` when absent. A remote SubAgent
   *  is routed on its target workspace's runner (§10.3). */
  runnerLabel?: string;
  /** A named model only runs where a usable provider offers it (§10.3): every provider × engine that offers it and
   *  passes the §4.2 filters is a candidate, the rest are removed with their reason, and none left is no pick at
   *  all — never the parent's model. Absent: the first provider in the owner's order that lists it, else the parent's. */
  strictNamedModel?: boolean;
  /** The account's smart model selection switch (common/model-routing-switch.ts). False: no tier is routed —
   *  a named model is still used, anything else runs on the parent's. Absent: on. */
  smartSelection?: boolean;
}

/** A candidate taken out of the pool, and why. Null model: the whole provider or engine went. */
export interface SubagentRemovedCandidate {
  provider: string;
  engine: string | null;
  model: string | null;
  effort: string | null;
  reason: string;
}

export interface SubagentRoutingDecision {
  level: ModelRoutingLevel | null;
  tierSource: SubagentTierSource;
  optimizeFor: ModelRoutingOptimizeFor;
  /** Null when the pool was empty in the tier: a routed delegate would be refused NO_SUBAGENT_PROVIDER. */
  engine: string | null;
  provider: string | null;
  model: string | null;
  effort: string | null;
  reasons: string[];
  candidates: SubagentRemovedCandidate[];
  /** The rest of the pool after the pick, every tier, in the order it was ranked: where a SubAgent whose account
   *  hit its limit moves next (§4.3). Empty when the model was named rather than routed. */
  fallbacks: SubagentFallback[];
  /** SUBAGENT_ROUTING_POLICY_VERSION. */
  policyVersion: string;
  /** Where the tier or model came from, in a few words: the Why line's first clause. */
  tierNote: string;
  /** Why the pick, in a few words (its billing and headroom); absent for a model that was named. */
  note?: string;
  /** The pick's own tier, which may differ from `level` when none in that tier could run; null when untiered.
   *  Absent for a model that was named or not routed. */
  pickLevel?: ModelRoutingLevel | null;
}

/** One candidate a SubAgent may move to after a usage-limit or capacity failure (§4.3). */
export interface SubagentFallback {
  engine: string;
  provider: string;
  model: string;
  effort: string | null;
  /** Its billing and headroom in a few words, as the Why line says it once it runs there. */
  note?: string;
  /** Its own tier, null for an untiered default model: what says so when it runs instead of the asked tier. */
  level?: ModelRoutingLevel | null;
}

const levelIndex = (level: ModelRoutingLevel): number => MODEL_ROUTING_LEVELS.indexOf(level);
const OPTIMIZE_LABEL = { cost: 'Cost', balance: 'Balance', intelligence: 'Intelligence' } as const;

/**
 * The built-in tier table's rows for an engine's runner-reported catalogue: Claude's families at the
 * table's efforts, the family's first model by catalogue priority (as routeTaskRun picks it), and Codex's
 * runner default at each effort, and Kimi's first reported model of each tier. Every other engine's
 * catalogue has no tier, model by model.
 */
type SubagentCatalogInput = Pick<SubagentRoutingInput, 'modelCatalog' | 'runtimeDefaultModels'>;

function builtinTierRows(
  engine: string,
  input: SubagentCatalogInput,
  prices?: Readonly<Record<string, number>>,
): SubagentModelRow[] {
  return builtinRows(engine, input).map((row) => (prices ? { ...row, outputPricePerMTok: prices[row.model] ?? null } : row));
}

function builtinRows(engine: string, input: SubagentCatalogInput): SubagentModelRow[] {
  const catalog = input.modelCatalog?.[engine as AgentProvider] ?? [];
  if (engine === AgentProvider.CLAUDE) {
    const family = (prefix: string) => catalog
      .filter((row) => row.value.startsWith(prefix))
      .reduce<RunnerModelInfo | undefined>((best, row) =>
        !best || (row.priority ?? Infinity) < (best.priority ?? Infinity) ? row : best, undefined);
    return MODEL_ROUTING_LEVELS.flatMap((level) => {
      const tier = DEFAULT_MODEL_TIER_TABLE.claude[level];
      const model = family(tier.prefix);
      return model ? [{ model: model.value, effort: tier.effort, level }] : [];
    });
  }
  if (engine === AgentProvider.CODEX) {
    const named = input.runtimeDefaultModels?.codex;
    const model = catalog.find((row) => row.value === named) ?? catalog[0];
    return model
      ? MODEL_ROUTING_LEVELS.map((level) => ({ model: model.value, effort: DEFAULT_MODEL_TIER_TABLE.codex[level].effort, level }))
      : [];
  }
  if (engine === AgentProvider.KIMI) {
    return MODEL_ROUTING_LEVELS.flatMap((level) => {
      const tier = DEFAULT_MODEL_TIER_TABLE.kimi[level];
      const model = tier.models.find((value) => catalog.some((row) => row.value === value));
      return model ? [{ model, effort: tier.effort, level }] : [];
    });
  }
  return catalog.map((row) => ({ model: row.value, effort: null, level: null }));
}

/**
 * The tier rows routeSubagent reads for one engine of a provider: the provider's own model space, else the
 * engine's runner-reported catalogue through the built-in tier table. What the Providers page's Tier column
 * shows (GET /providers/subagent-tiers), so it cannot say a model is routed when the router would skip it.
 */
export function subagentEngineRows(engine: SubagentProviderEngine, input: SubagentCatalogInput): SubagentModelRow[] {
  return engine.models ? [...engine.models] : builtinTierRows(engine.engine, input, engine.prices);
}

interface SubagentCandidate extends SubagentModelRow {
  provider: SubagentProvider;
  providerIndex: number;
  engine: string;
  engineIndex: number;
  /** The highest tier any row of this model reaches on this provider and engine; the asked tier for an untiered one. */
  ceiling: ModelRoutingLevel;
  /** For a pool: the quota of its account with the most left, which is its headroom. */
  quota?: ModelRoutingEngineState['quota'];
  /** A subscription whose quota was not read: ranked after those whose headroom is known. */
  quotaUnknown: boolean;
  /** A subscription's: when what it has left goes to waste (null: no reset known), and whether it is nearly spent. */
  expiresAt: number | null;
  nearLimit: boolean;
  poolMember?: string;
  /** How it fits the asked tier (§4.2): the tier itself, a higher one, an untiered default model, a lower one. */
  fit: SubagentFit;
  /** For a higher or lower tier: how many tiers away. */
  distance: number;
}

/** The order the fits are tried in, best first. */
const SUBAGENT_FITS = ['exact', 'higher', 'untiered', 'lower'] as const;
type SubagentFit = (typeof SUBAGENT_FITS)[number];

/** Quota left on a subscription's account, in percent; a key has no quota to run out of. */
const headroom = (c: SubagentCandidate): number =>
  c.provider.billing === 'subscription' ? 100 - (c.quota?.utilization ?? 0) : 100;
/** What one more run costs at the margin: nothing on a subscription, the key's price otherwise. */
const marginalPrice = (c: SubagentCandidate): number =>
  c.provider.billing === 'subscription' ? 0 : c.outputPricePerMTok ?? Infinity;

/**
 * Quota that goes to waste first is spent first (owner, 2026-11-19), as account selection does (rankAccounts in
 * planUsage.ts): one nearly spent last, then the soonest expiry. A key, and a subscription with no reset known,
 * expire never.
 */
function expiryOrder(a: SubagentCandidate, b: SubagentCandidate): number {
  const near = Number(a.nearLimit) - Number(b.nearLimit);
  if (near) return near;
  const x = a.expiresAt ?? Infinity;
  const y = b.expiresAt ?? Infinity;
  return x === y ? 0 : x < y ? -1 : 1;
}

function compareCandidates(mode: ModelRoutingOptimizeFor, a: SubagentCandidate, b: SubagentCandidate): number {
  const fit = SUBAGENT_FITS.indexOf(a.fit) - SUBAGENT_FITS.indexOf(b.fit) || a.distance - b.distance;
  if (fit) return fit;
  const unknown = (c: SubagentCandidate) => (c.quotaUnknown ? 1 : 0);
  let order = 0;
  if (mode === 'cost' || mode === 'balance') {
    // Every usable subscription before any metered key, in Balance too (owner, 2026-11-19): free quota is spent
    // before money. Balance differs from Cost only in the tier it raises a SubAgent without a size to.
    const subscription = (c: SubagentCandidate) => (c.provider.billing === 'subscription' ? 0 : 1);
    order = subscription(a) - subscription(b)
      || (subscription(a) === 0
        ? unknown(a) - unknown(b) || expiryOrder(a, b) || headroom(b) - headroom(a)
        : marginalPrice(a) - marginalPrice(b));
  } else {
    order = levelIndex(b.ceiling) - levelIndex(a.ceiling) || unknown(a) - unknown(b) || expiryOrder(a, b)
      || marginalPrice(a) - marginalPrice(b);
  }
  // NaN only from Infinity - Infinity: two keys nobody knows the price of, which tie.
  return (Number.isNaN(order) ? 0 : order) || a.providerIndex - b.providerIndex || a.engineIndex - b.engineIndex;
}

/** A candidate's billing and headroom, in the few words the Why line gives it. */
function candidateNote(c: SubagentCandidate): string {
  if (c.poolMember) return `subscription pool, ${c.poolMember} with ${c.quotaUnknown ? 'quota unknown' : `${headroom(c)}% quota left`}`;
  if (c.provider.billing === 'subscription') return c.quotaUnknown ? 'subscription, quota unknown' : `subscription with ${headroom(c)}% quota left`;
  return c.outputPricePerMTok != null ? `key at $${c.outputPricePerMTok}/M output tokens` : 'key, price unknown';
}

function pickLine(mode: ModelRoutingOptimizeFor, c: SubagentCandidate): string {
  // The provider once, and the engine only when it is another name.
  const what = `${c.model}${c.effort ? ` · ${c.effort}` : ''} on ${c.provider.slug}${c.engine === c.provider.slug ? '' : ` (${c.engine})`}`;
  const price = c.outputPricePerMTok != null ? `$${c.outputPricePerMTok} per million output tokens` : 'an unknown price';
  const resets = c.expiresAt !== null ? ` until ${new Date(c.expiresAt).toISOString().slice(0, 16)}Z` : '';
  const why = c.poolMember
    ? `a subscription pool whose account ${c.poolMember} ${c.quotaUnknown ? 'has no quota reading' : `has ${headroom(c)}% of its quota left${resets}`}`
    : c.provider.billing === 'subscription'
      ? (c.quotaUnknown ? 'a subscription whose quota was not read' : `a subscription with ${headroom(c)}% of its quota left${resets}`)
      : `a metered key at ${price}`;
  const among = c.level ? `tier ${c.level}` : 'the untiered models';
  const lead = mode === 'intelligence' ? `the strongest model in ${among}${c.level ? ` (reaches ${c.ceiling})` : ''}, ${why}`
    : c.provider.billing === 'subscription' ? `${why}, used before any metered key`
      : `the cheapest in ${among}: ${why}`;
  return `Picked ${what} (${OPTIMIZE_LABEL[mode]}): ${lead}`;
}

/**
 * Why what runs is not in the asked tier, when it is not: for the router's pick, and for a candidate further down
 * that runs because the ones before it could not start (appliedDecision).
 */
export function subagentFitLine(
  asked: ModelRoutingLevel,
  c: { level: ModelRoutingLevel | null; model: string; provider: string; engine: string },
): string | null {
  if (c.level === null) {
    return `Nothing in tier ${asked} or above can run: ${c.model} is the default model of ${c.provider} (${c.engine}), which has no tiers`;
  }
  const away = levelIndex(c.level) - levelIndex(asked);
  if (away > 0) return `Nothing in tier ${asked} can run: the nearest tier above that can is ${c.level}`;
  if (away < 0) return `Nothing in tier ${asked} or above, and no untiered model, can run: the nearest tier below is ${c.level}`;
  return null;
}

/**
 * The account an account pool would run on: of the members that can run — not refused, not paused, under
 * ENGINE_QUOTA_LIMIT — the one with the most quota left, else one whose quota was not read. Otherwise why the
 * pool can't run, in words that name its accounts.
 */
function bestPoolMember(members: readonly SubagentPoolMember[]): { member: SubagentPoolMember } | { reason: string } {
  if (members.length === 0) return { reason: 'The pool has no account that can run' };
  const live = members.filter((m) => !m.refused && !m.paused);
  const expires = (m: SubagentPoolMember) => m.expiresAt ?? Infinity;
  const eligible = live
    .filter((m) => !m.unreadable && (m.quota?.utilization ?? 0) < ENGINE_QUOTA_LIMIT)
    .sort((a, b) => Number(a.nearLimit === true) - Number(b.nearLimit === true)
      || (expires(a) === expires(b) ? 0 : expires(a) < expires(b) ? -1 : 1)
      || (a.quota?.utilization ?? 0) - (b.quota?.utilization ?? 0));
  if (eligible.length > 0) return { member: eligible[0] };
  const unreadable = live.find((m) => m.unreadable);
  if (unreadable) return { member: unreadable };
  const each = members.map((m) => `${m.label} ${m.refused ? 'refused its key' : m.paused ? 'paused'
    : `at ${m.quota!.utilization}% of its ${m.quota!.window} quota`}`);
  return { reason: `No account in the pool can run: ${each.join('; ')}` };
}

/** Why a provider is out of every pool (§4.2 filters 1 and 2), or null. */
function providerRefusal(input: SubagentRoutingInput, provider: SubagentProvider): string | null {
  if (input.blockedProviders.includes(provider.slug)) return 'Blocked in the SubAgents settings';
  if (!provider.inScope) return 'A shared provider, which only admins may use';
  return null;
}

/**
 * One engine of a provider against §4.2 filters 3 and 4 on the runner `engines` reports: why it cannot run there,
 * or the quota (and, for a pool, the account) a run there would spend.
 */
function engineVerdict(
  input: SubagentRoutingInput,
  provider: SubagentProvider,
  engine: string,
): { reason: string } | {
  quota: ModelRoutingEngineState['quota']; quotaUnknown: boolean; expiresAt: number | null; nearLimit: boolean;
  opusUtilization: number | null; poolMember?: string;
} {
  const where = input.runnerLabel ?? "the parent's runner";
  const report = input.engines?.[engine];
  // A runner that reported nothing is not judged on it; one that reported others lacks this one.
  if (input.engines && !report?.installed) return { reason: `${engine} is not installed on ${where}` };
  // Only Claude Code is gated, and only on a credential that talks to Anthropic: a sign-in, a pool or a key (§8, ⑥).
  if (engine === AgentProvider.CLAUDE && report?.regionBlocked && credentialIsAnthropicBound(provider.credential)) {
    return { reason: `${engine} can’t use Anthropic on ${where}` };
  }
  if (provider.pool) {
    // A pool runs on its members' own credentials, not the runner's sign-in: its best member decides.
    const best = bestPoolMember(provider.pool.members);
    if ('reason' in best) return best;
    return {
      quota: best.member.quota, quotaUnknown: best.member.unreadable === true,
      expiresAt: best.member.expiresAt ?? null, nearLimit: best.member.nearLimit === true,
      opusUtilization: best.member.opusUtilization ?? null, poolMember: best.member.label,
    };
  }
  const quota = provider.account?.quota;
  if (provider.billing === 'subscription') {
    // The runner reports on its own sign-in: a subscription key runs on its own token, whatever that says.
    if (report?.signedOut && provider.credential.kind === 'login') return { reason: `${engine} is signed out on ${where}` };
    if (quota && quota.utilization >= ENGINE_QUOTA_LIMIT) {
      return { reason: `The account is at ${quota.utilization}% of its ${quota.window} quota` };
    }
    if (provider.account?.paused) return { reason: 'The account is paused' };
    if (provider.account?.refused) return { reason: "The endpoint refused the account's key" };
    // No reading of its quota (nothing reported for it, or none read at all): it runs, after those whose headroom is known.
    return {
      quota, quotaUnknown: !provider.account || provider.account.unreadable === true,
      expiresAt: provider.account?.expiresAt ?? null, nearLimit: provider.account?.nearLimit === true,
      opusUtilization: provider.account?.opusUtilization ?? null,
    };
  }
  return { quota, quotaUnknown: false, expiresAt: null, nearLimit: false, opusUtilization: null };
}

/**
 * Why a provider on one engine cannot run a SubAgent on the runner `engines` reports (§4.2 filters 1 to 4), or null
 * when it can — or when the owner has no such provider, which only building its run can tell. What a remote
 * SubAgent asks of its target workspace's default engine before running on it (§10.3).
 */
export function subagentCandidateRefusal(input: SubagentRoutingInput, providerSlug: string, engine: string): string | null {
  const provider = input.providers.find((entry) => entry.slug === providerSlug);
  if (!provider) return null;
  const refused = providerRefusal(input, provider);
  if (refused) return refused;
  const verdict = engineVerdict(input, provider, engine);
  return 'reason' in verdict ? verdict.reason : null;
}

/** Whether a provider's engine lists a model: its own model space, else the runner-reported catalogue. */
function offersModel(input: SubagentRoutingInput, engine: SubagentProviderEngine, model: string): boolean {
  return engine.models
    ? engine.models.some((entry) => entry.model === model)
    : (input.modelCatalog?.[engine.engine as AgentProvider] ?? []).some((entry) => entry.value === model);
}

/** One provider × engine as the runner `engines` reports on stands toward it (§4.2 filters 1 to 4). */
export interface SubagentPairVerdict {
  provider: string;
  engine: string;
  /** Why it cannot run there; absent when it can. */
  reason?: string;
  /** Every model it lists, tier or no tier: its own model space, else the runner-reported catalogue. */
  models: string[];
}

/**
 * Every provider × engine of `input`, in the owner's order, with why it cannot run on the runner `engines` reports
 * (§4.2 filters 1 to 4, through providerRefusal and engineVerdict) and the models it lists. What
 * subagentRunnableModels keeps the usable ones of, and what provider_list's workspace view shows whole.
 */
export function subagentPairVerdicts(input: SubagentRoutingInput): SubagentPairVerdict[] {
  const out: SubagentPairVerdict[] = [];
  for (const provider of input.providers) {
    const refused = providerRefusal(input, provider);
    for (const engine of provider.engines) {
      const verdict = refused ? { reason: refused } : engineVerdict(input, provider, engine.engine);
      const models = engine.models
        ? engine.models.map((entry) => entry.model)
        : (input.modelCatalog?.[engine.engine as AgentProvider] ?? []).map((entry) => entry.value);
      out.push({
        provider: provider.slug,
        engine: engine.engine,
        ...('reason' in verdict ? { reason: verdict.reason } : {}),
        models: [...new Set(models)],
      });
    }
  }
  return out;
}

/**
 * What the runner `engines` reports on can run, by provider and engine: every model each usable provider × engine
 * lists (§4.2 filters 1 to 4; tiers do not matter, since a named model needs none). What a refused named model on
 * a remote SubAgent lists (§10.3).
 */
export function subagentRunnableModels(input: SubagentRoutingInput): Array<{ provider: string; engine: string; models: string[] }> {
  return subagentPairVerdicts(input)
    .filter((pair) => pair.reason === undefined && pair.models.length > 0)
    .map(({ provider, engine, models }) => ({ provider, engine, models }));
}

/**
 * Route one SubAgent (docs/subagent-design.md §4.1, §4.2). Pure: no I/O, every decision depends only on
 * the snapshot passed in. The tier is the first of: the caller's model, the definition's model or
 * `inherit` (neither routed), the caller's size, the definition's size, the type's default — which alone
 * Optimize For raises. The pool is every provider × engine × tier row, less what the owner blocked, what is
 * out of scope, engines the parent's runner lacks or cannot sign in to, accounts at ENGINE_QUOTA_LIMIT or
 * paused, and models without a tier; each removal is recorded with its reason.
 */
export function routeSubagent(input: SubagentRoutingInput): SubagentRoutingDecision {
  const mode = input.optimizeFor;
  const base = {
    optimizeFor: mode, candidates: [] as SubagentRemovedCandidate[], fallbacks: [] as SubagentFallback[],
    policyVersion: SUBAGENT_ROUTING_POLICY_VERSION,
  };
  const parentPick = { engine: input.parent.engine, provider: input.parent.provider, model: input.parent.model, effort: input.parent.effort };

  // Rows 1 and 2: a named model is used as named, at its engine's default effort, on every provider × engine that
  // lists it and can run on this runner (§4.2 filters 1 to 4), in the owner's order: the first is the pick, the
  // rest its fallbacks; never another model.
  const offersOf = (model: string) => {
    const removed: SubagentRemovedCandidate[] = [];
    const offers: SubagentFallback[] = [];
    for (const provider of input.providers) {
      const listing = provider.engines.filter((engine) => offersModel(input, engine, model));
      if (listing.length === 0) continue;
      const refused = providerRefusal(input, provider);
      if (refused) {
        removed.push({ provider: provider.slug, engine: null, model, effort: null, reason: refused });
        continue;
      }
      for (const engine of listing) {
        const verdict = engineVerdict(input, provider, engine.engine);
        if ('reason' in verdict) removed.push({ provider: provider.slug, engine: engine.engine, model, effort: null, reason: verdict.reason });
        else offers.push({ engine: engine.engine, provider: provider.slug, model, effort: null });
      }
    }
    return { removed, offers };
  };
  const { caller, definition } = input;
  if (caller.model) {
    const model = caller.model;
    const { removed, offers } = offersOf(model);
    const [pick, ...rest] = offers;
    const where = input.runnerLabel ?? "the parent's runner";
    // Nobody lists it at all: off the remote path, the parent's own provider runs it as named, as it always has.
    if (!pick && removed.length === 0 && !input.strictNamedModel) {
      return {
        ...base, level: null, tierSource: 'named-model', tierNote: 'Model named by the caller', ...parentPick, model,
        reasons: [`Model named by the caller: ${model}`,
          `No enabled provider lists ${model} — kept on the parent's ${input.parent.provider} (${input.parent.engine})`],
      };
    }
    return {
      ...base, level: null, tierSource: 'named-model', tierNote: 'Model named by the caller', candidates: removed,
      ...(pick ?? { engine: null, provider: null, model: null, effort: null }),
      fallbacks: rest,
      reasons: [
        `Model named by the caller: ${model}`,
        ...(pick ? [] : [`No usable provider on ${where} offers ${model}`]),
      ],
    };
  }
  const definitionModel = definition.model?.trim() || null;
  const autoNotes: string[] = [];
  if (definitionModel === 'inherit') {
    return { ...base, level: null, tierSource: 'definition-model', tierNote: `Model set by ${input.definitionName}: inherit`, ...parentPick,
      reasons: [`Model set by ${input.definitionName}: inherit, the parent's ${input.parent.model}`] };
  }
  if (definitionModel && definitionModel !== 'auto') {
    const { removed, offers } = offersOf(definitionModel);
    const [found, ...rest] = offers;
    if (found) {
      return { ...base, level: null, tierSource: 'definition-model', tierNote: `Model set by ${input.definitionName}`, ...found,
        candidates: removed, fallbacks: rest, reasons: [`Model set by ${input.definitionName}: ${definitionModel}`] };
    }
    autoNotes.push(removed.length > 0
      ? `${input.definitionName} names ${definitionModel}, which no usable provider can run — routed as auto`
      : `${input.definitionName} names ${definitionModel}, which no enabled provider lists — routed as auto`);
  }
  if (input.smartSelection === false) {
    return { ...base, level: null, tierSource: 'not-routed', tierNote: 'Smart model selection is off', ...parentPick,
      reasons: [...autoNotes, `Smart model selection is off: runs on the parent's ${input.parent.model}`] };
  }

  // Rows 3 to 5: the tier.
  let level: ModelRoutingLevel;
  let tierSource: SubagentTierSource;
  let tierNote: string;
  const reasons: string[] = [...autoNotes];
  if (caller.size) {
    level = caller.size;
    tierSource = 'size';
    tierNote = `Tier ${level}, set by the caller`;
    reasons.push(`${tierNote}${caller.sizeReason ? `: ${caller.sizeReason}` : ''}`);
  } else if (definition.size) {
    level = definition.size;
    tierSource = 'definition-size';
    tierNote = `Tier ${level}, set by ${input.definitionName}`;
    reasons.push(tierNote);
  } else {
    level = input.type === 'explore' ? 'S' : 'M';
    tierSource = 'type-default';
    tierNote = `Tier ${level}: default for ${input.type}`;
    reasons.push(tierNote);
    const floor = mode === 'balance' ? 'M' : mode === 'intelligence' ? 'L' : null;
    if (floor && levelIndex(level) < levelIndex(floor)) {
      level = floor;
      tierNote = `Tier ${floor}: ${OPTIMIZE_LABEL[mode]} minimum`;
      reasons.push(`Tier ${floor}: ${OPTIMIZE_LABEL[mode]} minimum for a SubAgent without a size`);
    }
  }

  // The pool (§4.2): every provider × engine that can run, each removal with its reason. Every tier joins; the
  // asked one comes first, then the tiers above it, then each untiered engine's default model, then the tiers below.
  const removed: SubagentRemovedCandidate[] = [];
  const drop = (provider: string, engine: string | null, model: string | null, effort: string | null, reason: string) =>
    removed.push({ provider, engine, model, effort, reason });
  const pool: SubagentCandidate[] = [];
  input.providers.forEach((provider, providerIndex) => {
    const slug = provider.slug;
    const refused = providerRefusal(input, provider);
    if (refused) return drop(slug, null, null, null, refused);
    provider.engines.forEach((spec, engineIndex) => {
      const { engine } = spec;
      const verdict = engineVerdict(input, provider, engine);
      if ('reason' in verdict) return drop(slug, engine, null, null, verdict.reason);
      const { quota, quotaUnknown, expiresAt, nearLimit, opusUtilization, poolMember } = verdict;
      // Opus has a weekly window of its own on a Claude account: at the limit, Opus is not run there; Sonnet still is.
      const opusOut = (row: SubagentModelRow) => engine === AgentProvider.CLAUDE && row.model.startsWith('claude-opus-')
        && opusUtilization !== null && opusUtilization >= ENGINE_QUOTA_LIMIT;
      const opusReason = `Opus's weekly quota is at ${opusUtilization}% on this account`;
      const join = (row: SubagentModelRow, ceiling: ModelRoutingLevel, fit: SubagentFit, distance: number) => pool.push({
        ...row, provider, providerIndex, engine, engineIndex, ceiling, quota, quotaUnknown, expiresAt, nearLimit,
        ...(poolMember ? { poolMember } : {}), fit, distance,
      });
      const rows = subagentEngineRows(spec, input);
      if (!rows.some((row) => row.level)) {
        // No tiers at all: its default model runs, untiered; the rest of what it lists is reachable by name.
        // A list of the provider's own is its model space, even empty; only an engine on its catalogue reads the runner's.
        const listed = rows.length > 0 || spec.models ? rows : (input.modelCatalog?.[engine as AgentProvider] ?? [])
          .map((row) => ({ model: row.value, effort: null, level: null, outputPricePerMTok: spec.prices?.[row.value] ?? null }));
        if (listed.length === 0) return drop(slug, engine, null, null, `No models listed for ${engine}`);
        // The runner's default for the engine, else the provider's own, each only if it is listed; else the first listed.
        const listedAs = (model: string | null | undefined) => (model ? listed.find((row) => row.model === model) : undefined);
        const chosen = listedAs(input.runtimeDefaultModels?.[engine as AgentProvider]) ?? listedAs(spec.defaultModel) ?? listed[0];
        join(chosen, level, 'untiered', 0);
        for (const row of listed) if (row !== chosen) drop(slug, engine, row.model, row.effort, `The model has no tier; ${slug} runs ${chosen.model}`);
        return;
      }
      const ceilings = new Map<string, ModelRoutingLevel>();
      for (const row of rows) {
        if (!row.level) continue;
        const prior = ceilings.get(row.model);
        if (!prior || levelIndex(row.level) > levelIndex(prior)) ceilings.set(row.model, row.level);
      }
      for (const row of rows) {
        if (!row.level) {
          drop(slug, engine, row.model, row.effort, 'The model has no tier');
          continue;
        }
        if (opusOut(row)) {
          drop(slug, engine, row.model, row.effort, opusReason);
          continue;
        }
        const away = levelIndex(row.level) - levelIndex(level);
        join(row, ceilings.get(row.model)!, away === 0 ? 'exact' : away > 0 ? 'higher' : 'lower', Math.abs(away));
      }
    });
  });

  const decision = { ...base, level, tierSource, tierNote, candidates: removed };
  if (pool.length === 0) {
    return { ...decision, engine: null, provider: null, model: null, effort: null,
      reasons: [...reasons, 'No provider can run a SubAgent: the SubAgent is refused with NO_SUBAGENT_PROVIDER'] };
  }
  const [best, ...rest] = [...pool].sort((a, b) => compareCandidates(mode, a, b));
  const away = subagentFitLine(level, { level: best.level, model: best.model, provider: best.provider.slug, engine: best.engine });
  if (away) reasons.push(away);
  reasons.push(pickLine(mode, best));
  const priceless = new Set(pool
    .filter((c) => best.provider.billing === 'key' && c.fit === best.fit && c.provider.billing === 'key' && c.outputPricePerMTok == null)
    .map((c) => `No price known for ${c.model} on ${c.provider.slug}; ordered after priced keys`));
  reasons.push(...priceless);
  const exact = pool.filter((c) => c.fit === 'exact').length;
  if (pool.length > 1) {
    const others = pool.length - exact;
    reasons.push(`${exact} candidate${exact === 1 ? '' : 's'} in tier ${level}${others ? `, ${others} more in other tiers or untiered` : ''}; ties go by the owner's provider order`);
  }
  if (removed.length > 0) reasons.push(`${removed.length} candidate${removed.length === 1 ? '' : 's'} removed, each with its reason`);
  const fallbacks = rest.map((c) => ({
    engine: c.engine, provider: c.provider.slug, model: c.model, effort: c.effort, note: candidateNote(c), level: c.level,
  }));
  return {
    ...decision, engine: best.engine, provider: best.provider.slug, model: best.model, effort: best.effort,
    note: candidateNote(best), pickLevel: best.level, reasons, fallbacks,
  };
}
