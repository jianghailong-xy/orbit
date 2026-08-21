import { IsArray, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { MERGE_RECEIPT_RESULTS, type MergeReceiptResult } from './merge-receipt';

const MERGE_RECEIPT_RESULT_VALUES = [...MERGE_RECEIPT_RESULTS];

export interface CreateSessionDto {
  /** Optional display title; defaults to a slice of the prompt. */
  title?: string;
  /** First user message — seeds the session's first turn. */
  prompt: string;
  /** Compose the session from a `!cmd` draft: seed the first turn as a 'shell' turn
   *  (run `prompt` on the runner, bypassing the workspace runtime) instead of a normal message. The
   *  runtime still spawns and idles; the command's output becomes context for the next message. */
  shell?: boolean;
  /** The runner this session is pinned to. Optional when `workspaceId` is given —
   *  the runner is then derived from the workspace's machine. */
  assignedRunnerId?: string;
  workspaceId?: string;
  /** @deprecated The same field under its pre-rename name, still sent by every shipped client.
   *  `workspaceId` wins when both are present; the controller collapses them. */
  agentId?: string;
  /** Optional parent work item this session runs under. */
  taskId?: string;
  /** Per-session provider override, picked on the New Session screen: a built-in engine
   *  ("claude"/"codex"/"kimi"/"opencode") or one of the caller's configured ModelProvider
   *  slugs. Omitted keeps the historical behaviour — the session inherits its workspace's
   *  provider. An unknown or foreign slug is rejected rather than silently falling back,
   *  so a session never dispatches with an identity the caller can't use. */
  provider?: string;
  /** Per-session override; omitted falls back to the Runner Runtime or ModelProvider default. */
  model?: string;
  permissionMode?: string;
  /** Provider reasoning effort; '' / omitted → model default. */
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

/** Stop the running turn, and — when a follow-up rides along — queue what to do instead,
 *  in the same transaction. See RunInterruptRequest for why the two travel together. */
export interface SessionInterruptDto {
  /** Idempotency key (UUID) for the follow-up; required whenever one is present. */
  clientTurnId?: string;
  /** What to send once the current turn has stopped. Omitted → a plain interrupt. */
  content?: string;
  attachmentIds?: string[];
}

export interface SessionResumeDto extends SessionTurnDto {
  /** Per-session overrides re-applied on resume (the runner re-spawns the runtime, so a
   *  new mode/model/effort takes effect). Omitted fields keep the session's prior value. */
  model?: string;
  permissionMode?: string;
  effort?: string;
  /** Revive on another provider identity that runs on the SAME built-in runtime — same rule and
   *  same rejection as SessionConfigDto.provider. No reload turn is needed here: the revived
   *  session is claimed afresh, and the claim resolves the environment from the row. */
  provider?: string;
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

/**
 * Record one merge of this session's branch (contract §13.7).
 *
 * A class rather than an interface, unlike everything above it: this body carries object names that
 * are checked against a repository later, and a SHA that arrives malformed and is stored anyway is
 * evidence that cannot be verified — which is the one thing a receipt may not be. `recordedBy` is
 * deliberately NOT here; it is decided by which door the request came through.
 */
export class RecordMergeReceiptDto {
  @IsIn(MERGE_RECEIPT_RESULT_VALUES) result!: MergeReceiptResult;
  /** Omitted falls back to the session's own recorded branch. */
  @IsOptional() @IsString() @MaxLength(400) sourceBranch?: string;
  @IsString() @MaxLength(64) sourceSha!: string;
  @IsString() @MinLength(1) @MaxLength(400) targetBranch!: string;
  @IsOptional() @IsString() @MaxLength(64) targetShaBefore?: string;
  @IsOptional() @IsString() @MaxLength(64) targetShaAfter?: string;
  /** The base the source had been rebased onto when this merge was computed. Omitted means it was
   *  not rebased — the distinction decides whether the tests that passed were about this tree. */
  @IsOptional() @IsString() @MaxLength(64) rebaseBaseSha?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(1024, { each: true })
  conflicts?: string[];
  /** The raw observation: the command, its output, the refs read. */
  @IsOptional() detail?: Record<string, unknown>;
  /** Supply one when the caller has a natural key; omitted derives MR4's from the merge itself. */
  @IsOptional() @IsString() @MaxLength(200) idempotencyKey?: string;
}
