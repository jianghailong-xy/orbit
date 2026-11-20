import { SUBAGENT_RUN_STATUSES, toolResultText, type SubagentRunStatus, type WorkflowRunView } from '@orbit/shared';
import {
  Allow, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsPositive, IsString, Matches, Max, MaxLength, Min, MinLength,
} from 'class-validator';

export const WORKFLOW_SCRIPT_MAX_BYTES = 512 * 1024;

/** The Agent switches a workflow needs: its own, and SubAgents, since every call of a workflow is a SubAgent. */
export interface WorkflowSwitches {
  subagentsEnabled: boolean;
  workflowsEnabled: boolean;
}

/** Whether an Agent's sessions may start a workflow (docs/subagent-workflow-design.md §9 D2). */
export function workflowsOn(workspace: WorkflowSwitches): boolean {
  return workspace.subagentsEnabled && workspace.workflowsEnabled;
}

/**
 * What a claim and a reclaim say of it: nothing while the session's Agent may start workflows, the payload runners
 * have always had, and `workflowsDisabled` otherwise, so the runner spawns the session without the `workflow` tool. A
 * session with no Agent is told nothing, as the workflow door lets it open one.
 */
export function workflowClaimFields(workspace: WorkflowSwitches | null | undefined): { workflowsDisabled?: true } {
  return workspace && !workflowsOn(workspace) ? { workflowsDisabled: true } : {};
}

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

/** What a client's view of a workflow reads of its row: never the script, its args or its result, which can be large. */
export const WORKFLOW_RUN_VIEW_SELECT = {
  id: true, toolUseId: true, name: true, description: true, phases: true, status: true, callsDone: true,
  callsFailed: true, costUsd: true, maxCostUsd: true, error: true, createdAt: true, endedAt: true,
} as const;

/**
 * A `subagent_workflow_run` row as `GET /sessions/:id/workflows` answers it. The runner reports a workflow's counts
 * and spend only with its end (PATCH …/workflows/:id), so while it runs they are counted from `calls`, its calls'
 * runs: one DONE is done, one that ended any other way failed, and the spend is what the ended ones reported.
 */
export function workflowRunView(
  row: {
    id: string;
    toolUseId: string;
    name: string;
    description: string | null;
    phases: string[];
    status: string;
    callsDone: number;
    callsFailed: number;
    costUsd: number;
    maxCostUsd: number | null;
    error: string | null;
    createdAt: Date;
    endedAt: Date | null;
  },
  calls: ReadonlyArray<{ status: string; costUsd: number }>,
): WorkflowRunView {
  const running = row.status === 'RUNNING';
  const ended = calls.filter((call) => call.status !== 'RUNNING');
  return {
    id: row.id,
    toolUseId: row.toolUseId,
    name: row.name,
    // The runner sends the call's description, else the script's, "" when neither has one.
    description: row.description || null,
    phases: row.phases,
    status: row.status as SubagentRunStatus,
    callsDone: running ? ended.filter((call) => call.status === 'DONE').length : row.callsDone,
    callsFailed: running ? ended.filter((call) => call.status !== 'DONE').length : row.callsFailed,
    costUsd: running ? ended.reduce((sum, call) => sum + call.costUsd, 0) : row.costUsd,
    maxCostUsd: row.maxCostUsd,
    // The runner reports a workflow that finished with an empty error.
    error: row.error || null,
    createdAt: row.createdAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
  };
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
