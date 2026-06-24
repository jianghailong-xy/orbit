export interface CreateSessionDto {
  /** Optional display title; defaults to a slice of the prompt. */
  title?: string;
  /** First user message — seeds the session's first turn. */
  prompt: string;
  /** Compose the session from a `!cmd` draft: seed the first turn as a 'shell' turn
   *  (run `prompt` on the runner, bypassing claude) instead of a normal message. claude
   *  still spawns and idles; the command's output becomes context for the next message. */
  shell?: boolean;
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
  /** Ids of pre-uploaded image attachments (`POST /api/attachments` with no sessionId) to
   *  send with the seeded first turn. Each must be the caller's and not yet scoped to a
   *  session/turn — they're scoped to this session on create, then linked to the initial
   *  turn when the runner seeds it. Omitted/empty keeps the first turn text-only. */
  attachmentIds?: string[];
}

export interface SessionTurnDto {
  /** Client-supplied idempotency key (UUID); dedups double-clicks / cross-tab sends. */
  clientTurnId: string;
  content: string;
  /** 'shell' runs `content` as a raw shell command on the runner (bypassing claude) and
   *  echoes the output to the transcript; defaults to 'message' (a normal user prompt). */
  kind?: 'message' | 'shell';
  /** Ids of pre-uploaded image attachments (`POST /api/attachments`) to attach to this
   *  turn. Only ids travel here — the bytes already live in the control plane. Each id
   *  must be the caller's and scoped to this session. Omitted/empty keeps it text-only. */
  attachmentIds?: string[];
}

export interface SessionResumeDto extends SessionTurnDto {
  /** Per-session overrides re-applied on resume (the runner re-spawns claude, so a
   *  new mode/model/effort takes effect). Omitted fields keep the session's prior value. */
  model?: string;
  permissionMode?: string;
  effort?: string;
}

export interface SessionConfigDto {
  /** Change the model, permission mode and/or effort of an already-started session.
   *  The runner re-spawns claude with --resume so the change takes effect on the next
   *  turn. Only allowed between turns (AWAITING_INPUT); omitted fields are untouched.
   *  effort: '' clears it back to the model default; omitted keeps the running value. */
  model?: string;
  permissionMode?: string;
  effort?: string;
}
