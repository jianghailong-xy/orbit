import { PermissionMode, RunnerStatus, RunStatus } from './enums';
import { ModelUsage, NormalizedRunEvent, TokenUsage } from './events';

/**
 * Everything a runner needs to drive Claude Code for one session. Mirrors the
 * relevant `@anthropic-ai/claude-agent-sdk` `query()` options.
 */
export interface AgentExecConfig {
  model: string;
  appendSystemPrompt?: string;
  systemPrompt?: string;
  allowedTools: string[];
  disallowedTools: string[];
  permissionMode: PermissionMode;
  /** Claude effort level (low|medium|high|xhigh|max). Omitted → model default. */
  effort?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** MCP server config passed through to the SDK (`mcpServers`). */
  mcpConfig?: Record<string, unknown>;
}

// ─────────────────────────────── Runner ⇆ control plane ───────────────────────────────

export interface RunnerRegisterRequest {
  enrollmentToken: string;
  /** The runner (machine) name; defaults to the hostname. */
  name: string;
  /** The machine identity — recorded on the Runner (one Runner per machine). */
  hostname?: string;
  labels?: string[];
  maxConcurrent?: number;
  version?: string;
  /** Default project directory; agents (registered separately) run claude here. */
  workDir?: string;
}

export interface RunnerRegisterResponse {
  runnerId: string;
  /** Long-lived credential the runner stores locally and sends on every call. */
  runnerToken: string;
  /** The runner (machine) name. */
  name: string;
}

// ── Device-login flow (`orbit register` with no token, approved in the browser) ──

export interface DeviceStartRequest {
  /** The runner (machine) name; defaults to the hostname. */
  name: string;
  /** The machine identity — recorded on the Runner (one Runner per machine). */
  hostname?: string;
  labels?: string[];
  maxConcurrent?: number;
  version?: string;
  /** Default project directory; agents (registered separately) run claude here. */
  workDir?: string;
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
  | {
      status: 'approved';
      /** The machine runner credential the CLI stores and runs the loop with. */
      runnerId: string;
      runnerToken: string;
      /** The runner (machine) name. */
      name: string;
    };

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
  /** The agents registered under this machine runner. */
  agents: RunnerAgentSummary[];
}

/** One agent registered under a runner, as shown by `orbit status`. */
export interface RunnerAgentSummary {
  id: string;
  name: string;
  agentKey?: string;
  workDir?: string;
}

export interface RunnerHeartbeatRequest {
  status: RunnerStatus;
  /** How many more concurrent sessions the runner can accept right now. */
  idleCapacity: number;
  version?: string;
}

export interface RunnerHeartbeatResponse {
  /** Session IDs the control plane wants the runner to interrupt / end. */
  cancelSessionIds: string[];
}

// ─────────────────────────── Interactive sessions (Route B) ───────────────────────────

/** An interactive session atomically claimed by its assigned runner via long-poll. */
export interface ClaimedSession {
  sessionId: string;
  title: string;
  /** First-turn seed (the prompt the session was created with). */
  prompt: string;
  agent: AgentExecConfig;
  /** Project directory to run claude in (claude's cwd), from the session's agent. */
  workDir?: string;
  /** Pre-generated Claude session id to pass via --session-id (and --resume on respawn). */
  sessionUuid: string;
  /** Highest RunEvent.seq already persisted, so a respawned runner continues the
   *  monotonic counter instead of colliding (events use skipDuplicates). */
  maxSeq: number;
  /** True when reviving an ended session: claude's session already exists, so the
   *  runner must --resume (not --session-id) even on its first spawn. */
  resume?: boolean;
  /** DB id of the session's agent, injected into the claude process (ORBIT_AGENT_ID)
   *  so the `orbit mcp` server can attribute task work to it. Omitted if no agent. */
  agentId?: string;
  /** DB id of the parent Task this session runs under, if any (ORBIT_TASK_ID). */
  taskId?: string;
}

export interface RunEventBatch {
  events: NormalizedRunEvent[];
}

export type ApprovalStatus = 'PENDING' | 'ALLOWED' | 'DENIED';

/** A tool-permission request awaiting a human allow/deny (from claude's
 *  --permission-prompt-tool, served by the orbit MCP server). */
export interface ApprovalInfo {
  id: string;
  sessionId: string;
  toolName: string;
  input: unknown;
  toolUseId?: string;
  status: ApprovalStatus;
  message?: string;
  createdAt: string;
  decidedAt?: string;
}

/** Runner (orbit MCP permission tool) → control plane: register a pending tool
 *  approval. Idempotent on (sessionId, toolUseId). */
export interface ApprovalCreateRequest {
  toolName: string;
  input: unknown;
  toolUseId?: string;
}

/** Browser → control plane: a human's allow/deny on a pending approval. */
export interface ApprovalDecisionRequest {
  behavior: 'allow' | 'deny';
  message?: string;
}

/** Control plane → runner: the resolved decision (returned by the approval
 *  long-poll). status === 'PENDING' means the long-poll window elapsed undecided. */
export interface ApprovalDecisionResponse {
  id: string;
  status: ApprovalStatus;
  behavior?: 'allow' | 'deny';
  message?: string;
}

export type ConversationTurnKind = 'message' | 'interrupt' | 'end';

/** Browser → control plane: enqueue a user turn for a live interactive session. */
export interface RunTurnRequest {
  /** Client-supplied idempotency key (UUID); dedups double-clicks / cross-tab sends. */
  clientTurnId: string;
  content: string;
}

/**
 * Control plane → runner: the next turn to feed the live `claude` process, returned
 * by the per-session inbox long-poll. `turnId === ''` means "nothing available"
 * (mirrors the empty-id convention of the session claim poll).
 */
export interface RunInboxResponse {
  turnId: string;
  seq: number;
  kind: ConversationTurnKind;
  content?: string;
}

/** One interactive session a restarted runner can re-attach to and --resume. */
export interface ReclaimSession {
  sessionId: string;
  title: string;
  sessionUuid: string;
  /** Highest persisted RunEvent.seq, so the runner continues the seq counter. */
  maxSeq: number;
  /** How to re-drive `claude` — same shape a fresh claim hands the runner, so the
   *  resumed process keeps the session's model/permission-mode/tools. */
  agent: AgentExecConfig;
  /** Project directory to run claude in (claude's cwd), from the session's agent. */
  workDir?: string;
  /** DB id of the session's agent (ORBIT_AGENT_ID), cf. ClaimedSession.agentId. */
  agentId?: string;
  /** DB id of the parent Task this session runs under, if any (ORBIT_TASK_ID). */
  taskId?: string;
}

/** Control plane → runner response for GET /runner/sessions/reclaim. */
export interface ReclaimResponse {
  sessions: ReclaimSession[];
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

/**
 * Runner → control plane: finalize the whole session to a terminal status,
 * distinct from per-turn /turn-complete.
 */
export interface SessionCompleteRequest {
  status: RunStatus;
  /** Claude Code `result` text. */
  result?: string;
  /** Claude Code result `subtype`. */
  subtype?: string;
  error?: string;
  claudeSessionId?: string;
  numTurns?: number;
  durationMs?: number;
  costUsd?: number;
  usage?: TokenUsage;
  modelUsage?: Record<string, ModelUsage>;
}
