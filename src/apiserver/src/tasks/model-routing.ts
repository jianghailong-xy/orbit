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

export const MODEL_ROUTING_POLICY_VERSION = 1;
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
  /** The fullest of that account's windows that cap the whole engine, not one model family. */
  quota?: { utilization: number; window: string } | null;
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

export interface ModelRoutingRun {
  ordinal: number;
  status: string;
  quotaFailure: boolean;
  /** The prior decision's tier, including a shadow decision; null falls back to the actual model. */
  level?: ModelRoutingLevel | null;
  model?: string | null;
  effort?: string | null;
  runtime?: string;
  /** Includes a verifier FAIL or owner SEND_BACK after this work run. */
  outcome?: ModelRoutingOutcome;
}

export interface ModelRoutingInput {
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
    reasons,
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
    } else {
      last = run;
      break;
    }
  }
  let level = task.modelHint ?? null;
  const reasons: string[] = [];
  const lastLevel = last ? priorLevel(last, runtime) : null;
  const failure = last?.outcome && last.outcome !== 'OK'
    ? last.outcome
    : last?.status === 'FAILED' ? 'FAILED' : null;
  if (last && lastLevel && failure) {
    const next = Math.min(MODEL_ROUTING_LEVELS.indexOf(lastLevel) + 1, 3);
    level = MODEL_ROUTING_LEVELS[Math.max(next, level ? MODEL_ROUTING_LEVELS.indexOf(level) : 0)];
    reasons.push(
      `Tier ${level} — ${level === lastLevel ? 'already the highest tier after' : 'raised after'} ` +
      `run ${last.ordinal} (${lastLevel}) ${FAILURE_WORDING[failure]}`,
    );
    if (!last.level) {
      const label = runnerCatalogRow(last.runtime ?? runtime, last.model ?? '', environment.modelCatalog)?.label
        ?? last.model ?? runtime;
      reasons.push(
        `Run ${last.ordinal} used ${label}` +
        `${last.effort ? ` · ${last.effort}` : ''}, which counts as tier ${lastLevel}`,
      );
    }
    if (task.modelHint && MODEL_ROUTING_LEVELS.indexOf(task.modelHint) > next) {
      reasons.push(`Coordinator suggested tier ${task.modelHint}${task.modelHintReason ? `: ${task.modelHintReason}` : ''}`);
    }
  } else if (level) {
    reasons.push(`Tier ${level}: suggested by the coordinator${task.modelHintReason ? ` — ${task.modelHintReason}` : ''}`);
  } else {
    reasons.push("No suggestion — keeps the agent's model, as today");
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
