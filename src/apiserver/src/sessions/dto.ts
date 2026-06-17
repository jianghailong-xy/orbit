export interface CreateSessionDto {
  /** Optional display title; defaults to a slice of the prompt. */
  title?: string;
  /** First user message — seeds the session's first turn. */
  prompt: string;
  /** The runner this session is pinned to. Optional when `agentId` is given —
   *  the runner is then derived from the agent's machine. */
  assignedRunnerId?: string;
  agentId?: string;
  /** Per-session overrides; null falls back to the agent, then a server default. */
  model?: string;
  permissionMode?: string;
}

export interface SessionTurnDto {
  /** Client-supplied idempotency key (UUID); dedups double-clicks / cross-tab sends. */
  clientTurnId: string;
  content: string;
}
