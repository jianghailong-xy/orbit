import { SUBAGENT_RUN_STATUSES, toolResultText, type SubagentRunStatus } from '@orbit/shared';
import {
  Allow, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsPositive, IsString, Matches, Max, MaxLength, Min, MinLength,
} from 'class-validator';

export const WORKFLOW_SCRIPT_MAX_BYTES = 512 * 1024;

export class WorkflowRunCreateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @Matches(/^[^\0]+$/, { message: 'toolUseId must not contain a null character' })
  toolUseId!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  phases?: string[];

  @IsString()
  script!: string;

  @Allow()
  args?: unknown;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  maxCostUsd?: number;
}

export class WorkflowRunUpdateDto {
  @IsIn(SUBAGENT_RUN_STATUSES.filter((status) => status !== 'RUNNING'))
  status!: Exclude<SubagentRunStatus, 'RUNNING'>;

  @IsOptional()
  @IsString()
  result?: string;

  @IsOptional()
  @IsString()
  error?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  costUsd?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  callsDone?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  callsFailed?: number;

  @IsOptional()
  @IsBoolean()
  wake?: boolean;
}

/** The workflow continues after its MCP tool result, until its terminal background_task event. */
export function orbitWorkflowLaunchReceipt(content: unknown): boolean {
  try {
    const receipt = JSON.parse(toolResultText(content));
    return receipt?.status === 'running' && typeof receipt.workflowRunId === 'string' && receipt.workflowRunId !== '';
  } catch {
    return false;
  }
}
