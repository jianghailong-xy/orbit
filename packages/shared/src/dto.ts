import { PermissionMode, RunnerStatus, RunStatus } from './enums';
import { ModelUsage, NormalizedRunEvent, TokenUsage } from './events';

/**
 * Everything a runner needs to drive Claude Code for one task. Mirrors the
 * relevant `@anthropic-ai/claude-agent-sdk` `query()` options.
 */
export interface AgentExecConfig {
  model: string;
  appendSystemPrompt?: string;
  systemPrompt?: string;
  allowedTools: string[];
  disallowedTools: string[];
  permissionMode: PermissionMode;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** MCP server config passed through to the SDK (`mcpServers`). */
  mcpConfig?: Record<string, unknown>;
}

// ─────────────────────────────── Runner ⇆ control plane ───────────────────────────────

export interface RunnerRegisterRequest {
  enrollmentToken: string;
  name: string;
  hostname?: string;
  labels?: string[];
  maxConcurrent?: number;
  version?: string;
}

export interface RunnerRegisterResponse {
  runnerId: string;
  /** Long-lived credential the runner stores locally and sends on every call. */
  runnerToken: string;
  name: string;
}

export interface RunnerHeartbeatRequest {
  status: RunnerStatus;
  /** How many more concurrent jobs the runner can accept right now. */
  idleCapacity: number;
  version?: string;
}

export interface RunnerHeartbeatResponse {
  /** Run IDs the control plane wants the runner to interrupt. */
  cancelRunIds: string[];
}

/** A task atomically claimed by a runner via long-poll. */
export interface ClaimedJob {
  runId: string;
  taskId: string;
  title: string;
  input: Record<string, unknown>;
  prompt: string;
  agent: AgentExecConfig;
  /** Resume an earlier Claude Code session for multi-turn tasks. */
  resumeSessionId?: string;
}

export interface RunEventBatch {
  events: NormalizedRunEvent[];
}

export interface RunCompleteRequest {
  status: RunStatus;
  /** Claude Code `result` text. */
  result?: string;
  /** Claude Code result `subtype` (success | error_max_turns | error_max_budget_usd | ...). */
  subtype?: string;
  error?: string;
  claudeSessionId?: string;
  numTurns?: number;
  durationMs?: number;
  costUsd?: number;
  usage?: TokenUsage;
  modelUsage?: Record<string, ModelUsage>;
}
