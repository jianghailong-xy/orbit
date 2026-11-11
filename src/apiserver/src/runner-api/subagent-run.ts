import {
  AgentProvider,
  SUBAGENT_RUN_STATUSES,
  type SubagentDecision,
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
}

export class SubagentRunUpdateDto implements SubagentRunUpdateRequest {
  @IsIn(SUBAGENT_RUN_STATUSES.filter((s) => s !== 'RUNNING'))
  status!: SubagentRunUpdateRequest['status'];

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

/** How much of a SubAgent's result `subagent_run.result_summary` keeps. */
export const SUBAGENT_RESULT_SUMMARY_MAX = 20_000;

export const SUBAGENT_POLICY_VERSION = 'p1-not-routed';

export const SUBAGENT_NOT_ROUTED_REASON = "Routing not enabled yet: runs on the parent session's model";

/**
 * The decision recorded before routing exists (§8 P1): the parent session's own engine, credential, model
 * and effort, with the level the parent or the definition asked for kept for the later report.
 */
export function notRoutedDecision(args: {
  dto: SubagentRunCreateRequest;
  engine: AgentProvider;
  provider: string | null;
  model: string;
  effort: string | null;
}): SubagentDecision {
  return {
    level: args.dto.size ?? args.dto.definitionSize ?? null,
    tierSource: 'not-routed',
    optimizeFor: null,
    engine: args.engine,
    provider: args.provider,
    model: args.model,
    effort: args.effort,
    reasons: [SUBAGENT_NOT_ROUTED_REASON],
    candidates: [],
    policyVersion: SUBAGENT_POLICY_VERSION,
  };
}

export function truncateResultSummary(summary: string | undefined): string | undefined {
  if (summary === undefined) return undefined;
  const clean = stripNul(summary);
  return clean.length > SUBAGENT_RESULT_SUMMARY_MAX ? clean.slice(0, SUBAGENT_RESULT_SUMMARY_MAX) : clean;
}
