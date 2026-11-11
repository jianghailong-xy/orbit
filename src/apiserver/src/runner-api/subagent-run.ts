import {
  isUsageLimitErrorText,
  PermissionMode,
  SUBAGENT_RUN_STATUSES,
  type SubagentAttempt,
  type SubagentAttemptOutcome,
  type SubagentCandidateTarget,
  type SubagentFallbackRequest,
  type RunnerModelCatalog,
  type SubagentDecision,
  type SubagentRunStatus,
  type SubagentRunView,
  type SubagentRunCreateRequest,
  type SubagentRunUpdateRequest,
  type SubagentSize,
} from '@orbit/shared';
import {
  ArrayMaxSize,
  IsBoolean,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { MODEL_AT_CAPACITY_ERROR_MARKER, type SubagentRoutingDecision } from '../tasks/model-routing';
import { stripNul } from './strip-nul';

/**
 * SubAgent runs (docs/subagent-design.md §5.1, §6.1): what the runner reports when a parent session's
 * `mcp__orbit__delegate` call opens one and when it ends, validated.
 */

const SIZES: SubagentSize[] = ['S', 'M', 'L', 'XL'];

export class SubagentRunCreateDto implements SubagentRunCreateRequest {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  toolUseId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  type!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4_096)
  definitionSource!: string;

  @IsOptional()
  @IsBoolean()
  background?: boolean;

  @IsOptional()
  @IsIn(SIZES)
  size?: SubagentSize;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  sizeReason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  model?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  definitionModel?: string;

  @IsOptional()
  @IsIn(SIZES)
  definitionSize?: SubagentSize;

  @IsOptional()
  @IsBoolean()
  readonly?: boolean;

  @IsOptional()
  @IsIn(Object.values(PermissionMode))
  permissionMode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1_000)
  description?: string;
}

export class SubagentRunUpdateDto implements SubagentRunUpdateRequest {
  /** `RUNNING` only with `wake: true` (the controller refuses it otherwise): the call stopped waiting. */
  @IsIn([...SUBAGENT_RUN_STATUSES])
  status!: SubagentRunUpdateRequest['status'];

  @IsOptional()
  @IsBoolean()
  wake?: boolean;

  /** Truncated to SUBAGENT_RESULT_SUMMARY_MAX on write, so a long result is not refused. */
  @IsOptional()
  @IsString()
  resultSummary?: string;

  @IsOptional()
  @IsString({ each: true })
  @MaxLength(4_096, { each: true })
  @ArrayMaxSize(10_000)
  changedFiles?: string[];

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  costUsd?: number;

  @IsOptional()
  @IsObject()
  usage?: Record<string, unknown>;
}

export class SubagentFallbackDto implements SubagentFallbackRequest {
  @IsString()
  @MinLength(1)
  @MaxLength(20_000)
  error!: string;

  @IsOptional()
  @IsBoolean()
  readonly?: boolean;

  @IsOptional()
  @IsIn(Object.values(PermissionMode))
  permissionMode?: string;
}

/** How many times one delegate call may move to another candidate after a usage limit or capacity (§4.3). */
export const SUBAGENT_MAX_MOVES = 2;

/** How much of a failed attempt's error `subagent_run.attempts` keeps. */
export const SUBAGENT_ATTEMPT_ERROR_MAX = 500;

/**
 * A child's failure as §4.3 moves it: a spent quota (USAGE_LIMIT_ERROR_MARKERS, opening the text) or a model at
 * capacity (MODEL_AT_CAPACITY_ERROR_MARKER). Null for every other failure, which goes back to the parent as is.
 */
export function limitFailure(error: string): Extract<SubagentAttemptOutcome, 'USAGE_LIMIT' | 'AT_CAPACITY'> | null {
  if (isUsageLimitErrorText(error)) return 'USAGE_LIMIT';
  return error.toLowerCase().includes(MODEL_AT_CAPACITY_ERROR_MARKER) ? 'AT_CAPACITY' : null;
}

/** The first entry of a run's attempts: where it was opened to run. */
export function firstAttempt(target: SubagentCandidateTarget, at = new Date()): SubagentAttempt {
  return { ...target, attempt: 1, outcome: 'RUNNING', startedAt: at.toISOString() };
}

/** `subagent_run.attempts` as written; [] on a row from before attempts were kept. */
export function attemptsOf(value: unknown): SubagentAttempt[] {
  return Array.isArray(value) ? (value as SubagentAttempt[]).map((a) => ({ ...a })) : [];
}

/** The candidates a run may move to, in rank order, from the decision it opened with: the pick, then the rest of its tier. */
export function fallbackCandidates(decision: Pick<SubagentDecision, 'engine' | 'provider' | 'model' | 'effort' | 'fallbacks'>): SubagentCandidateTarget[] {
  const pick = decision.engine && decision.provider && decision.model
    ? [{ engine: decision.engine, provider: decision.provider, model: decision.model, effort: decision.effort }]
    : [];
  return [...pick, ...(decision.fallbacks ?? [])];
}

/**
 * NO_SUBAGENT_PROVIDER's message: no candidate left to move to, with each provider's reason — the ones whose
 * account hit its limit on an attempt, the ones the router removed, and the ones that could not be started.
 */
export function noProviderMessage(
  decision: Pick<SubagentDecision, 'level' | 'candidates'>,
  attempts: readonly SubagentAttempt[],
  skipped: readonly string[] = [],
): string {
  const tier = decision.level ? ` in tier ${decision.level}` : '';
  const lines = [
    ...attempts.filter((a) => a.outcome === 'USAGE_LIMIT' || a.outcome === 'AT_CAPACITY').map((a) =>
      `${a.provider} (${a.engine}), ${a.model}: ${a.outcome === 'AT_CAPACITY' ? 'the model was at capacity' : 'the account hit its limit'}`),
    ...(decision.candidates ?? []).map((c) =>
      `${c.provider}${c.engine ? ` (${c.engine})` : ''}${c.model ? `, ${c.model}${c.effort ? ` · ${c.effort}` : ''}` : ''}: ${c.reason}`),
    ...skipped,
  ];
  return `No provider is left to run this SubAgent${tier}.` + (lines.length ? ` Each provider's reason:\n- ${lines.join('\n- ')}` : '');
}

/** How much of a SubAgent's result `subagent_run.result_summary` keeps. */
export const SUBAGENT_RESULT_SUMMARY_MAX = 20_000;

/**
 * The router's decision as `subagent_run.decision` stores it while routing is in shadow (§8 P2): what it
 * would pick, `applied: false`, and a last reason naming the parent's model, which the SubAgent runs on.
 */
export function shadowDecision(
  route: SubagentRoutingDecision,
  parentModel: string,
  parentEffort: string | null = null,
): SubagentDecision {
  return {
    ...route,
    reasons: [...route.reasons, `Shadow decision: this SubAgent runs on the parent's model, ${parentModel}`],
    applied: false,
    runModel: parentModel,
    runEffort: parentEffort,
  };
}

/**
 * How the owner's tables name each model id: the provider rows' tables as the API serves them (`withPreset`), then
 * the runner's catalogue. The first name found for an id wins.
 */
export function modelLabels(
  providers: Array<{ models?: unknown }>,
  catalog?: RunnerModelCatalog | null,
): Map<string, string> {
  const labels = new Map<string, string>();
  const add = (rows: unknown) => {
    for (const row of Array.isArray(rows) ? rows : []) {
      const { value, label } = (row ?? {}) as { value?: unknown; label?: unknown };
      if (typeof value === 'string' && typeof label === 'string' && label && !labels.has(value)) labels.set(value, label);
    }
  };
  for (const provider of providers) add(provider.models);
  for (const rows of Object.values(catalog ?? {})) add(rows);
  return labels;
}

/**
 * A `subagent_run` row as `GET /sessions/:id/subagents` answers it. The model is the one the SubAgent runs
 * on: the router's pick once applied, the parent's while the decision is a shadow, named by `modelLabels`.
 */
export function subagentRunView(
  row: {
    toolUseId: string;
    type: string;
    background: boolean;
    status: string;
    decision: unknown;
    costUsd: number;
    resultSummary: string | null;
    createdAt: Date;
    endedAt: Date | null;
  },
  labels?: ReadonlyMap<string, string>,
): SubagentRunView {
  const decision = (row.decision ?? {}) as Partial<SubagentDecision>;
  const shadow = decision.applied === false && decision.runModel !== undefined;
  const model = (shadow ? decision.runModel : decision.model) ?? null;
  const effort = (shadow ? decision.runEffort : decision.effort) ?? null;
  return {
    toolUseId: row.toolUseId,
    type: row.type,
    background: row.background,
    status: row.status as SubagentRunStatus,
    level: decision.level ?? null,
    model,
    modelLabel: model ? labels?.get(model) ?? model : null,
    effort,
    reasons: Array.isArray(decision.reasons) ? decision.reasons.filter((r) => typeof r === 'string') : [],
    costUsd: row.costUsd,
    resultSummary: row.resultSummary,
    createdAt: row.createdAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
  };
}

export function truncateResultSummary(summary: string | undefined): string | undefined {
  if (summary === undefined) return undefined;
  const clean = stripNul(summary);
  return clean.length > SUBAGENT_RESULT_SUMMARY_MAX ? clean.slice(0, SUBAGENT_RESULT_SUMMARY_MAX) : clean;
}
