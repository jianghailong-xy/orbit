export interface CreateSessionDto {
  /** Optional display title; defaults to a slice of the prompt. */
  title?: string;
  /** First user message — seeds the session's first turn. */
  prompt: string;
  /** The runner this session is pinned to. Optional when `agentId` is given —
   *  the runner is then derived from the agent's machine. */
  assignedRunnerId?: string;
  agentId?: string;
  /** Optional parent work item this session runs under. */
  taskId?: string;
  /** Per-session overrides; null falls back to the agent, then a server default. */
  model?: string;
  permissionMode?: string;
  /** Claude effort level (low|medium|high|xhigh|max); '' / omitted → model default. */
  effort?: string;
}

export interface SessionTurnDto {
  /** Client-supplied idempotency key (UUID); dedups double-clicks / cross-tab sends. */
  clientTurnId: string;
  content: string;
}

export interface SessionResumeDto extends SessionTurnDto {
  /** Per-session overrides re-applied on resume (the runner re-spawns claude, so a
   *  new mode/model/effort takes effect). Omitted fields keep the session's prior value. */
  model?: string;
  permissionMode?: string;
  effort?: string;
}

export interface SessionConfigDto {
  /** Change the model and/or permission mode of an already-started session. The
   *  runner re-spawns claude with --resume so the change takes effect on the next
   *  turn. Only allowed between turns (AWAITING_INPUT); omitted fields are untouched. */
  model?: string;
  permissionMode?: string;
}
