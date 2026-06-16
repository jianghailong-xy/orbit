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

// ── Device-login flow (`orbit register` with no token, approved in the browser) ──

export interface DeviceStartRequest {
  name: string;
  hostname?: string;
  labels?: string[];
  maxConcurrent?: number;
  version?: string;
}

export interface DeviceStartResponse {
  /** Secret the CLI polls with — never shown to the user. */
  deviceCode: string;
  /** Short, human-typable code the user confirms in the browser. */
  userCode: string;
  /** Seconds the CLI should wait between polls. */
  interval: number;
  /** Seconds until the session expires. */
  expiresIn: number;
}

export interface DevicePollRequest {
  deviceCode: string;
}

export type DevicePollResponse =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'approved'; runnerId: string; runnerToken: string; name: string };

/** A runner's own status, returned by `GET /api/runner/me` (used by `orbit status`). */
export interface RunnerMeResponse {
  id: string;
  name: string;
  status: RunnerStatus;
  online: boolean;
  lastHeartbeatAt: string | null;
  version: string | null;
  labels: string[];
  maxConcurrent: number;
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
  // ── Interactive sessions (Route B) ──
  /** When true the runner keeps a long-lived `claude` process and pulls turns
   *  from GET /runner/runs/:id/inbox instead of running one-shot. */
  interactive?: boolean;
  /** Pre-generated Claude session id to pass via --session-id (and --resume on respawn). */
  sessionUuid?: string;
  /** Highest RunEvent.seq already persisted, so a respawned runner continues the
   *  monotonic counter instead of colliding (events use skipDuplicates). */
  maxSeq?: number;
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

// ─────────────────────────── Interactive sessions (Route B) ───────────────────────────

export type ConversationTurnKind = 'message' | 'interrupt' | 'end';

/** Browser → control plane: enqueue a user turn for a live interactive run. */
export interface RunTurnRequest {
  /** Client-supplied idempotency key (UUID); dedups double-clicks / cross-tab sends. */
  clientTurnId: string;
  content: string;
}

/**
 * Control plane → runner: the next turn to feed the live `claude` process, returned
 * by the per-run inbox long-poll. `turnId === ''` means "nothing available" (mirrors
 * the empty-runId convention of the jobs claim poll).
 */
export interface RunInboxResponse {
  turnId: string;
  seq: number;
  kind: ConversationTurnKind;
  content?: string;
}

/** One interactive run a restarted runner can re-attach to and --resume. */
export interface ReclaimRun {
  runId: string;
  taskId: string;
  title: string;
  sessionUuid: string;
  /** Highest persisted RunEvent.seq, so the runner continues the seq counter. */
  maxSeq: number;
  /** How to re-drive `claude` — same shape a fresh claim hands the runner, so the
   *  resumed process keeps the session's model/permission-mode/tools. */
  agent: AgentExecConfig;
}

/** Control plane → runner response for GET /runner/runs/reclaim. */
export interface ReclaimResponse {
  runs: ReclaimRun[];
}

/**
 * Runner → control plane: a single interactive turn finished (the per-turn `result`),
 * distinct from /complete which finalizes the whole session. Carries per-turn billing.
 */
export interface TurnCompleteRequest {
  turnId: string;
  /** Turn outcome: SUCCEEDED | INTERRUPTED | FAILED. */
  status: RunStatus;
  result?: string;
  subtype?: string;
  numTurns?: number;
  costUsd?: number;
  usage?: TokenUsage;
  modelUsage?: Record<string, ModelUsage>;
}
