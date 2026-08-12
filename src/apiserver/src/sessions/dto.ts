export interface CreateSessionDto {
  /** Optional display title; defaults to a slice of the prompt. */
  title?: string;
  /** First user message — seeds the session's first turn. */
  prompt: string;
  /** Compose the session from a `!cmd` draft: seed the first turn as a 'shell' turn
   *  (run `prompt` on the runner, bypassing the agent runtime) instead of a normal message. The
   *  runtime still spawns and idles; the command's output becomes context for the next message. */
  shell?: boolean;
  /** The runner this session is pinned to. Optional when `agentId` is given —
   *  the runner is then derived from the agent's machine. */
  assignedRunnerId?: string;
  agentId?: string;
  /** Optional parent work item this session runs under. */
  taskId?: string;
  /** Per-session provider override, picked on the New Session screen: a built-in engine
   *  ("claude"/"codex"/"kimi"/"opencode") or one of the caller's configured ModelProvider
   *  slugs. Omitted keeps the historical behaviour — the session inherits its agent's
   *  provider. An unknown or foreign slug is rejected rather than silently falling back,
   *  so a session never dispatches with an identity the caller can't use. */
  provider?: string;
  /** Per-session override; omitted falls back to the Runner Runtime or ModelProvider default. */
  model?: string;
  permissionMode?: string;
  /** Provider reasoning effort; '' / omitted → model default. Codex maps max to xhigh. */
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
  /** Per-session overrides re-applied on resume (the runner re-spawns the runtime, so a
   *  new mode/model/effort takes effect). Omitted fields keep the session's prior value. */
  model?: string;
  permissionMode?: string;
  effort?: string;
}

export interface MergeToMainDto {
  /** The branch to merge this session's worktree branch INTO, picked from the status bar's
   *  branch dropdown. Omitted → the default: the runner auto-detects main, else master. */
  targetBranch?: string;
}

export interface SessionArmRetryDto {
  /** When the re-send should fire (ISO). Supplied by the caller because disarming cleared the
   *  only copy the server had; the client re-derives it from the failing reply with the same
   *  `parseQuotaResetAt` the ingestion path used. Must be in the future and inside
   *  MAX_ARM_AHEAD_MS — see sessions.service.armAutoRetry for why a caller-chosen instant is
   *  not a privilege escalation. */
  retryAt: string;
}

export interface SessionRenameDto {
  /** New display title for the session. Trimmed; must be non-empty. Renaming works on any
   *  session regardless of status and never touches the runner. */
  title: string;
}

export interface SessionConfigDto {
  /** Change the model, permission mode and/or effort of an already-started session.
   *  The runner re-spawns the runtime so the change takes effect on the next
   *  turn. Only allowed between turns (AWAITING_INPUT); omitted fields are untouched.
   *  effort: '' clears it back to the model default; omitted keeps the running value. */
  model?: string;
  permissionMode?: string;
  effort?: string;
  /** Re-point the session at another provider identity — a second account with the same vendor,
   *  or another endpoint — that runs on the SAME built-in runtime. Cross-runtime is rejected:
   *  the transcript, the resume id and the wire protocol belong to the CLI that started the
   *  session. Omitted keeps the current provider. */
  provider?: string;
}
