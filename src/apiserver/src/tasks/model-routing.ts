import {
  AgentProvider,
  PermissionMode,
  autoAvailable,
  runnerCatalogRow,
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
  /** Cross-engine routing (§6). Absent, or no other engine allowed: the run stays on its own engine. */
  engines?: {
    /** `workspace.modelRoutingProviders`: the other engines the owner lets this Agent's task runs use. */
    allowed?: readonly string[];
    /** The target runner's report on each engine, by slug; an engine absent here is not ruled out. */
    states?: Readonly<Record<string, ModelRoutingEngineState>>;
    /** For a verification task: the engine the task it verifies last ran on. */
    verifiedRunEngine?: string | null;
  };
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
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

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

/**
 * The engine a routed run starts on (§6), with a reason for each step. The candidates are this
 * Agent's own engine and the ones the owner allowed, and an engine or provider pin is the only
 * candidate there is. An engine signed out on the target runner or at ENGINE_QUOTA_LIMIT of a window is
 * not picked, nor one whose models that runner has not reported. A verification task looks first for an
 * engine other than the one the task it verifies last ran on; any other run stays on this Agent's
 * engine and moves only when that engine is ruled out.
 *
 * A run moved to another engine keeps the baseline's credential when that engine can run it, and
 * otherwise spends that engine's own sign-in on the runner (docs/provider-engine-contract.md §4.4).
 * Which is also what the runner's report is about: it rules out an engine only for a run that would
 * spend the runner's sign-in to it, never for one on a key or an account pool.
 */
function chooseEngine(
  input: ModelRoutingInput,
  own: string,
  provider: string,
): { engine: string; provider: string; reasons: string[] } {
  const { task, engines, environment, baseline } = input;
  if (task.engine || task.provider) return { engine: own, provider, reasons: [`Engine ${own}: pinned on the task`] };
  const ownLine = `Engine ${own}: this agent's own engine`;
  const others = MODEL_ROUTING_ENGINES.filter((engine) =>
    engine !== own && (engines?.allowed ?? []).includes(engine));
  if (others.length === 0) return { engine: own, provider, reasons: [ownLine] };

  // The credential a run on `engine` spends: the baseline's where it runs, else that engine's sign-in.
  const runsOn = baseline.engines ?? [own];
  const credentialOn = (engine: string) => (engine === own || runsOn.includes(engine) ? provider : engine);
  const ruledOut = (engine: string): string | null => {
    if (credentialOn(engine) !== engine) return null;
    const state = engines?.states?.[engine];
    if (state?.signedOut) return `${engine} is signed out on this runner`;
    if (state?.regionBlocked) return `${engine} can’t use Anthropic on this runner`;
    if (state?.quota && state.quota.utilization >= ENGINE_QUOTA_LIMIT) {
      return `${engine} is at ${state.quota.utilization}% of its ${state.quota.window} quota`;
    }
    return null;
  };
  const ownOut = ruledOut(own);
  const notes = ownOut ? [ownOut] : [];
  const usable: string[] = [];
  for (const engine of others) {
    const out = ruledOut(engine)
      ?? (environment.modelCatalog?.[engine as AgentProvider]?.length ? null : `${engine} has not reported its models on this runner`);
    if (out) notes.push(out);
    else usable.push(engine);
  }
  const move = (engine: string, why: string) => ({
    engine,
    provider: credentialOn(engine),
    reasons: [`Engine ${engine}: ${why}`, ...notes.filter((note) => note !== why)],
  });
  const stay = (line: string, explained: boolean) => ({ engine: own, provider, reasons: explained ? [line, ...notes] : [line] });
  const verified = engines?.verifiedRunEngine ?? null;
  if (verified) {
    if (own !== verified && !ownOut) return stay(`${ownLine} — the task it verifies last ran on ${verified}`, false);
    const fresh = usable.find((engine) => engine !== verified);
    if (fresh) return move(fresh, `the task it verifies last ran on ${verified}`);
  }
  if (!ownOut) return verified ? stay(`${ownLine} — no other engine it may use is available`, true) : stay(ownLine, false);
  return usable.length > 0
    ? move(usable[0], ownOut)
    : stay(`${ownLine} — no other engine it may use is available`, true);
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
  if (
    environment.hasOwnModelSpace ||
    (runtime !== AgentProvider.CLAUDE && runtime !== AgentProvider.CODEX)
  ) {
    return unchanged([`No tier table for ${provider} — keeps the agent's model`]);
  }

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
  // The tier stays what it is wherever the run goes: it maps onto the chosen engine's tier table.
  const engine = chooseEngine(input, own, provider);
  reasons.push(...engine.reasons);
  const { engine: chosen } = engine;

  const catalog = environment.modelCatalog?.[chosen as AgentProvider] ?? [];
  if (catalog.length === 0) {
    return unchanged([...reasons, "This runner has not reported its models — keeps the agent's model"]);
  }
  let model: RunnerModelInfo | undefined;
  let effort: string | null;
  if (chosen === AgentProvider.CODEX) {
    const defaultModel = environment.runtimeDefaultModels?.codex;
    model = catalog.find((row) => row.value === defaultModel) ?? catalog[0];
    effort = DEFAULT_MODEL_TIER_TABLE.codex[level].effort;
    if (defaultModel && model.value !== defaultModel) {
      reasons.push(`Runner default ${defaultModel} is not in its model catalog — using ${model.label}`);
    }
  } else {
    const eligible = catalog.filter((row) =>
      environment.defaultPermissionMode !== PermissionMode.AUTO ||
      autoAvailable(chosen, row.value, false, environment.modelCatalog),
    );
    if (eligible.length < catalog.length) {
      reasons.push('Models without Auto permission support were excluded');
    }
    const utilization = environment.planUsage?.claude?.sevenDayOpus?.utilization;
    const opusBlocked = utilization != null && utilization >= 90;
    const family = (prefix: string): RunnerModelInfo | undefined => eligible
      .filter((row) => row.value.startsWith(prefix) && !(opusBlocked && prefix === 'claude-opus-'))
      .reduce<RunnerModelInfo | undefined>((best, row) =>
        !best || (row.priority ?? Infinity) < (best.priority ?? Infinity) ? row : best,
      undefined);
    const tier = DEFAULT_MODEL_TIER_TABLE.claude[level];
    effort = tier.effort;
    model = family(tier.prefix);
    if (opusBlocked) {
      reasons.push(`Opus weekly quota at ${utilization}% — Opus is unavailable for this run`);
    } else if (tier.prefix === 'claude-opus-' && utilization != null) {
      reasons.push(`Opus weekly quota at ${utilization}% — no quota step-down needed`);
    }
    if (!model) {
      const wantedOpus = tier.prefix === 'claude-opus-';
      model = family(wantedOpus ? 'claude-sonnet-' : 'claude-opus-');
      if (wantedOpus) effort = 'xhigh';
      if (!model) {
        return unchanged([...reasons, "Neither Sonnet nor Opus is available — keeps the agent's model"]);
      }
      reasons.push(`${wantedOpus ? 'Opus' : 'Sonnet'} is unavailable — using ${model.label} · ${effort} at tier ${level}`);
    }
  }

  if (model.reasoningLevels && !model.reasoningLevels.includes(effort)) {
    const requested = effort;
    const accepted = EFFORT_ORDER.filter((entry) => model.reasoningLevels!.includes(entry));
    const distance = (entry: string) => Math.abs(EFFORT_ORDER.indexOf(entry) - EFFORT_ORDER.indexOf(requested));
    // Lowest first; <= selects the higher effort when two accepted levels are equally close.
    effort = accepted.length ? accepted.reduce((best, entry) =>
      distance(entry) <= distance(best) ? entry : best,
    ) : null;
    reasons.push(`${model.label} does not support ${requested} effort — ${effort ? `using ${effort}` : 'no effort will be sent'}`);
  }
  return {
    policyVersion: MODEL_ROUTING_POLICY_VERSION,
    level,
    engine: chosen,
    provider: engine.provider,
    model: model.value,
    effort,
    reasons,
  };
}

// ─────────────────────────── SubAgent routing (docs/subagent-design.md §4.1, §4.2) ───────────────────────────

/** What a recorded SubAgent decision was made under: bump when a rule below changes what it picks. */
export const SUBAGENT_ROUTING_POLICY_VERSION = 'p2-shadow-1';

/** Which row of §4.1 set the tier — or, for the first two, the model. */
export type SubagentTierSource = 'named-model' | 'definition-model' | 'size' | 'definition-size' | 'type-default';

/** One row of the tier table: a model on one engine at one effort, its tier and its price (§4.2). */
export interface SubagentModelRow {
  model: string;
  effort: string | null;
  /** Null: the model has no tier, so routing never picks it. */
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
}

/** One provider the owner has, in the owner's order (provider_list). */
export interface SubagentProvider {
  slug: string;
  /** A sign-in that spends a subscription's quota, or a key that is billed per token. */
  billing: 'subscription' | 'key';
  /** Inside usableProviderScope: a shared provider is for admins only. */
  inScope: boolean;
  engines: readonly SubagentProviderEngine[];
  /** A subscription's account on the parent's runner: its fullest window, and whether it is paused. */
  account?: { quota?: ModelRoutingEngineState['quota']; paused?: boolean; refused?: boolean; unreadable?: boolean } | null;
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
  /** The rest of the tier's pool after the pick, in the order it was ranked: where a SubAgent whose account
   *  hit its limit moves next (§4.3). Empty when the model was named rather than routed. */
  fallbacks: SubagentFallback[];
  /** SUBAGENT_ROUTING_POLICY_VERSION. */
  policyVersion: string;
}

/** One candidate a SubAgent may move to after a usage-limit or capacity failure (§4.3). */
export interface SubagentFallback {
  engine: string;
  provider: string;
  model: string;
  effort: string | null;
}

const levelIndex = (level: ModelRoutingLevel): number => MODEL_ROUTING_LEVELS.indexOf(level);
const OPTIMIZE_LABEL = { cost: 'Cost', balance: 'Balance', intelligence: 'Intelligence' } as const;

/**
 * The built-in tier table's rows for an engine's runner-reported catalogue: Claude's families at the
 * table's efforts, the family's first model by catalogue priority (as routeTaskRun picks it), and Codex's
 * runner default at each effort. Every other engine's catalogue has no tier, model by model.
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
  /** The highest tier any row of this model reaches on this provider and engine. */
  ceiling: ModelRoutingLevel;
  /** For a pool: the quota of its account with the most left, which is its headroom. */
  quota?: ModelRoutingEngineState['quota'];
  poolMember?: string;
}

/** Quota left on a subscription's account, in percent; a key has no quota to run out of. */
const headroom = (c: SubagentCandidate): number =>
  c.provider.billing === 'subscription' ? 100 - (c.quota?.utilization ?? 0) : 100;
/** What one more run costs at the margin: nothing on a subscription, the key's price otherwise. */
const marginalPrice = (c: SubagentCandidate): number =>
  c.provider.billing === 'subscription' ? 0 : c.outputPricePerMTok ?? Infinity;

function compareCandidates(mode: ModelRoutingOptimizeFor, a: SubagentCandidate, b: SubagentCandidate): number {
  let order = 0;
  if (mode === 'cost') {
    const subscription = (c: SubagentCandidate) => (c.provider.billing === 'subscription' ? 0 : 1);
    order = subscription(a) - subscription(b)
      || (subscription(a) === 0 ? headroom(b) - headroom(a) : marginalPrice(a) - marginalPrice(b));
  } else if (mode === 'balance') {
    order = headroom(b) - headroom(a) || marginalPrice(a) - marginalPrice(b);
  } else {
    order = levelIndex(b.ceiling) - levelIndex(a.ceiling) || marginalPrice(a) - marginalPrice(b);
  }
  // NaN only from Infinity - Infinity: two keys nobody knows the price of, which tie.
  return (Number.isNaN(order) ? 0 : order) || a.providerIndex - b.providerIndex || a.engineIndex - b.engineIndex;
}

function pickLine(mode: ModelRoutingOptimizeFor, c: SubagentCandidate, level: ModelRoutingLevel): string {
  const what = `${c.model}${c.effort ? ` · ${c.effort}` : ''} on ${c.provider.slug} (${c.engine})`;
  const price = c.outputPricePerMTok != null ? `$${c.outputPricePerMTok} per million output tokens` : 'an unknown price';
  const why = c.poolMember
    ? `a subscription pool whose account ${c.poolMember} has ${headroom(c)}% of its quota left`
    : c.provider.billing === 'subscription'
      ? `a subscription with ${headroom(c)}% of its quota left`
      : `a metered key at ${price}`;
  const lead = mode === 'intelligence' ? `the strongest model in tier ${level} (reaches ${c.ceiling}), ${why}`
    : mode === 'balance' ? `the most quota headroom in tier ${level}, ${why}`
      : c.provider.billing === 'subscription' ? `${why}, used before any metered key`
        : `the cheapest in tier ${level}: ${why}`;
  return `Picked ${what} (${OPTIMIZE_LABEL[mode]}): ${lead}`;
}

/**
 * The account an account pool would run on: of the members that can run — not refused, not paused, quota
 * read and under ENGINE_QUOTA_LIMIT — the one with the most quota left. Otherwise why the pool can't run,
 * in words that name its accounts.
 */
function bestPoolMember(members: readonly SubagentPoolMember[]): { member: SubagentPoolMember } | { reason: string } {
  if (members.length === 0) return { reason: 'The pool has no account that can run' };
  const live = members.filter((m) => !m.refused && !m.paused);
  const eligible = live
    .filter((m) => !m.unreadable && (m.quota?.utilization ?? 0) < ENGINE_QUOTA_LIMIT)
    .sort((a, b) => (a.quota?.utilization ?? 0) - (b.quota?.utilization ?? 0));
  if (eligible.length > 0) return { member: eligible[0] };
  const unreadable = live.filter((m) => m.unreadable).map((m) => m.label);
  if (unreadable.length > 0) {
    return { reason: `The pool's quota cannot be read for ${unreadable.join(', ')}, and no other account in it can run` };
  }
  const each = members.map((m) => `${m.label} ${m.refused ? 'refused its key' : m.paused ? 'paused'
    : `at ${m.quota!.utilization}% of its ${m.quota!.window} quota`}`);
  return { reason: `Every account in the pool is at or above ${ENGINE_QUOTA_LIMIT}% of its quota or paused: ${each.join('; ')}` };
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

  // Rows 1 and 2: a named model is used as named, at its engine's default effort, on the first provider in
  // the owner's order that offers it — tier or no tier (§4.2 item 5).
  const named = (model: string) => {
    for (const provider of input.providers) {
      if (!provider.inScope || input.blockedProviders.includes(provider.slug)) continue;
      for (const { engine, models } of provider.engines) {
        const offered = models
          ? models.some((entry) => entry.model === model)
          : (input.modelCatalog?.[engine as AgentProvider] ?? []).some((entry) => entry.value === model);
        if (offered) return { engine, provider: provider.slug, model, effort: null };
      }
    }
    return null;
  };
  const { caller, definition } = input;
  if (caller.model) {
    const found = named(caller.model);
    return {
      ...base, level: null, tierSource: 'named-model',
      ...(found ?? { ...parentPick, model: caller.model }),
      reasons: [
        `Model named by the caller: ${caller.model}`,
        ...(found ? [] : [`No enabled provider lists ${caller.model} — kept on the parent's ${input.parent.provider} (${input.parent.engine})`]),
      ],
    };
  }
  const definitionModel = definition.model?.trim() || null;
  const autoNotes: string[] = [];
  if (definitionModel === 'inherit') {
    return { ...base, level: null, tierSource: 'definition-model', ...parentPick,
      reasons: [`Model set by ${input.definitionName}: inherit, the parent's ${input.parent.model}`] };
  }
  if (definitionModel && definitionModel !== 'auto') {
    const found = named(definitionModel);
    if (found) {
      return { ...base, level: null, tierSource: 'definition-model', ...found,
        reasons: [`Model set by ${input.definitionName}: ${definitionModel}`] };
    }
    autoNotes.push(`${input.definitionName} names ${definitionModel}, which no enabled provider lists — routed as auto`);
  }

  // Rows 3 to 5: the tier.
  let level: ModelRoutingLevel;
  let tierSource: SubagentTierSource;
  const reasons: string[] = [...autoNotes];
  if (caller.size) {
    level = caller.size;
    tierSource = 'size';
    reasons.push(`Tier ${level}, set by the caller${caller.sizeReason ? `: ${caller.sizeReason}` : ''}`);
  } else if (definition.size) {
    level = definition.size;
    tierSource = 'definition-size';
    reasons.push(`Tier ${level}, set by ${input.definitionName}`);
  } else {
    level = input.type === 'explore' ? 'S' : 'M';
    tierSource = 'type-default';
    reasons.push(`Tier ${level}: default for ${input.type}`);
    const floor = mode === 'balance' ? 'M' : mode === 'intelligence' ? 'L' : null;
    if (floor && levelIndex(level) < levelIndex(floor)) {
      level = floor;
      reasons.push(`Tier ${floor}: ${OPTIMIZE_LABEL[mode]} minimum for a SubAgent without a size`);
    }
  }

  // The pool (§4.2), each removal with its reason.
  const removed: SubagentRemovedCandidate[] = [];
  const drop = (provider: string, engine: string | null, model: string | null, effort: string | null, reason: string) =>
    removed.push({ provider, engine, model, effort, reason });
  const pool: SubagentCandidate[] = [];
  input.providers.forEach((provider, providerIndex) => {
    const slug = provider.slug;
    if (input.blockedProviders.includes(slug)) return drop(slug, null, null, null, 'Blocked in the SubAgents settings');
    if (!provider.inScope) return drop(slug, null, null, null, 'A shared provider, which only admins may use');
    provider.engines.forEach(({ engine }, engineIndex) => {
      const report = input.engines?.[engine];
      // A runner that reported nothing is not judged on it; one that reported others lacks this one.
      if (input.engines && !report?.installed) return drop(slug, engine, null, null, `${engine} is not installed on the parent's runner`);
      let quota = provider.account?.quota;
      let poolMember: string | undefined;
      if (provider.pool) {
        // A pool runs on its members' own credentials, not the runner's sign-in: its best member decides.
        const best = bestPoolMember(provider.pool.members);
        if ('reason' in best) return drop(slug, engine, null, null, best.reason);
        quota = best.member.quota;
        poolMember = best.member.label;
      } else if (provider.billing === 'subscription') {
        if (report?.signedOut) return drop(slug, engine, null, null, `${engine} is signed out on the parent's runner`);
        if (report?.regionBlocked) return drop(slug, engine, null, null, `${engine} can’t use Anthropic on the parent's runner`);
        if (quota && quota.utilization >= ENGINE_QUOTA_LIMIT) {
          return drop(slug, engine, null, null, `The account is at ${quota.utilization}% of its ${quota.window} quota`);
        }
        if (provider.account?.paused) return drop(slug, engine, null, null, 'The account is paused');
        if (provider.account?.refused) return drop(slug, engine, null, null, "The endpoint refused the account's key");
        if (provider.account?.unreadable) return drop(slug, engine, null, null, "The account's quota cannot be read");
      }
      const rows = subagentEngineRows(provider.engines[engineIndex], input);
      if (rows.length === 0) return drop(slug, engine, null, null, `No models with a tier on ${engine}`);
      const ceilings = new Map<string, ModelRoutingLevel>();
      for (const row of rows) {
        if (!row.level) continue;
        const prior = ceilings.get(row.model);
        if (!prior || levelIndex(row.level) > levelIndex(prior)) ceilings.set(row.model, row.level);
      }
      for (const row of rows) {
        if (!row.level) {
          drop(slug, engine, row.model, row.effort, 'The model has no tier');
        } else if (row.level === level) {
          pool.push({
            ...row, provider, providerIndex, engine, engineIndex, ceiling: ceilings.get(row.model)!,
            quota, ...(poolMember ? { poolMember } : {}),
          });
        }
      }
    });
  });

  const decision = { ...base, level, tierSource, candidates: removed };
  if (pool.length === 0) {
    return { ...decision, engine: null, provider: null, model: null, effort: null,
      reasons: [...reasons, `No provider can run tier ${level}: a routed SubAgent would be refused with NO_SUBAGENT_PROVIDER`] };
  }
  const [best, ...rest] = [...pool].sort((a, b) => compareCandidates(mode, a, b));
  reasons.push(pickLine(mode, best, level));
  const priceless = new Set(pool
    .filter((c) => c.provider.billing === 'key' && c.outputPricePerMTok == null)
    .map((c) => `No price known for ${c.model} on ${c.provider.slug}; ordered after priced keys`));
  reasons.push(...priceless);
  if (pool.length > 1) reasons.push(`${pool.length} candidates in tier ${level}; ties go by the owner's provider order`);
  if (removed.length > 0) reasons.push(`${removed.length} candidate${removed.length === 1 ? '' : 's'} removed, each with its reason`);
  const fallbacks = rest.map((c) => ({ engine: c.engine, provider: c.provider.slug, model: c.model, effort: c.effort }));
  return { ...decision, engine: best.engine, provider: best.provider.slug, model: best.model, effort: best.effort, reasons, fallbacks };
}
