import {
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
import type { SubagentRoutingDecision } from '../tasks/model-routing';
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

/**
 * The router's decision as `subagent_run.decision` stores it while routing is in shadow (§8 P2): what it
 * would pick, `applied: false`, and a last reason naming the parent's model, which the SubAgent runs on.
 */
export function shadowDecision(route: SubagentRoutingDecision, parentModel: string): SubagentDecision {
  return {
    ...route,
    reasons: [...route.reasons, `Shadow decision: this SubAgent runs on the parent's model, ${parentModel}`],
    applied: false,
  };
}

export function truncateResultSummary(summary: string | undefined): string | undefined {
  if (summary === undefined) return undefined;
  const clean = stripNul(summary);
  return clean.length > SUBAGENT_RESULT_SUMMARY_MAX ? clean.slice(0, SUBAGENT_RESULT_SUMMARY_MAX) : clean;
}
