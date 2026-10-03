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

export interface ModelRoutingSelection {
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
    provider?: string | null;
    model?: string | null;
    modelHint?: ModelRoutingLevel | null;
    modelHintReason?: string | null;
  };
  baseline: ModelRoutingSelection;
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
}

export interface ModelRoutingDecision extends ModelRoutingSelection {
  policyVersion: typeof MODEL_ROUTING_POLICY_VERSION;
  level: ModelRoutingLevel | null;
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

/** No I/O or writes to the task: every decision depends only on these value snapshots. */
export function routeTaskRun(input: ModelRoutingInput): ModelRoutingDecision {
  const { task, baseline, environment, history } = input;
  const { runtime } = environment;
  const provider = task.provider ?? baseline.provider;
  const unchanged = (reasons: string[]): ModelRoutingDecision => ({
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
  reasons.push(`Engine ${provider}: ${task.provider ? 'pinned on the task' : "this agent's own engine"}`);
  if (!level) return unchanged(reasons);

  const catalog = environment.modelCatalog?.[runtime] ?? [];
  if (catalog.length === 0) {
    return unchanged([...reasons, "This runner has not reported its models — keeps the agent's model"]);
  }
  let model: RunnerModelInfo | undefined;
  let effort: string | null;
  if (runtime === AgentProvider.CODEX) {
    const defaultModel = environment.runtimeDefaultModels?.codex;
    model = catalog.find((row) => row.value === defaultModel) ?? catalog[0];
    effort = DEFAULT_MODEL_TIER_TABLE.codex[level].effort;
    if (defaultModel && model.value !== defaultModel) {
      reasons.push(`Runner default ${defaultModel} is not in its model catalog — using ${model.label}`);
    }
  } else {
    const eligible = catalog.filter((row) =>
      environment.defaultPermissionMode !== PermissionMode.AUTO ||
      autoAvailable(runtime, row.value, false, environment.modelCatalog),
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
    provider,
    model: model.value,
    effort,
    reasons,
  };
}
