import { IsArray, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { IsPublicId } from '../common/public-id';
import type { SessionTurnIntent } from '@orbit/shared';
import { MERGE_RECEIPT_RESULTS, type MergeReceiptResult } from './merge-receipt';

const MERGE_RECEIPT_RESULT_VALUES = [...MERGE_RECEIPT_RESULTS];

export interface CreateSessionDto {
  /** Optional display title; defaults to a slice of the prompt. */
  title?: string;
  /** First user message — seeds the session's first turn. May be '' when `attachmentIds` carry
   *  the message on their own (never for `shell`). */
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
   *  ("claude"/"codex"/"kimi"/"opencode"/"antigravity") or one of the caller's configured
   *  ModelProvider slugs. Omitted keeps the historical behaviour — the session inherits its
   *  workspace's provider. An unknown or foreign slug is rejected rather than silently falling
   *  back, so a session never dispatches with an identity the caller can't use. */
  provider?: string;
  /** Per-session override; omitted falls back to the Runner Runtime or ModelProvider default. */
  model?: string;
  permissionMode?: string;
  /** Provider reasoning effort; '' / omitted → model default. */
  effort?: string;
  /** Run the session in its runtime's fast lane (Claude Code's `/fast`, Codex's "Fast" service
   *  tier). Omitted → off, which is both engines' own default. Stored as asked and policed at
   *  dispatch (`fastModeAvailable`), because which model this session ends up on is not settled
   *  here: a request that names none inherits the runner's Runtime default, which only the claim
   *  knows. A session whose effective model has no fast lane simply dispatches without one. */
  fastMode?: boolean;
  /** Which of the runner's Codex accounts this session runs on, picked on the New Session screen:
   *  `default` or a slot id (RunnerEngineAccount.id). Omitted follows the workspace's choice
   *  (Workspace.codexAccount). Only a session on the built-in Codex engine reads it, and an id the
   *  runner does not report runs on Default, as the workspace's does. */
  codexAccount?: string;
  /** The Claude Code account, the sibling of `codexAccount` for a session on the built-in Claude engine:
   *  `default` or one of the runner's slots. Omitted is Automatic where the workspace leaves the account
   *  to Orbit (the one whose quota resets soonest), else the workspace's. */
  claudeAccount?: string;
  /** The Antigravity Google account, the same again for a session on the built-in Antigravity engine. */
  antigravityAccount?: string;
  /** The Kimi Code account, the same again for a session on the built-in Kimi engine. */
  kimiAccount?: string;
  /** Ids of pre-uploaded image attachments (`POST /api/attachments` with no sessionId) to
   *  send with the seeded first turn. Each must be the caller's and not yet scoped to a
   *  session/turn — they're scoped to this session on create, then linked to the initial
   *  turn when the runner seeds it. Omitted/empty keeps the first turn text-only. */
  attachmentIds?: string[];
  /** The folder the new session is filed in — one opened from a folder's page lands in that folder
   *  (docs/session-folders-move-design.md §3.2). It has to be one of the caller's folders in this
   *  session's own `workspaceId`, else 400. Omitted files it in none. */
  folderId?: string;
}

export interface SessionTurnDto {
  /** Client-supplied idempotency key (UUID); dedups double-clicks / cross-tab sends. */
  clientTurnId: string;
  content: string;
  /** Omitted by installed clients: preserve the N-1 server-side auto-steer/queue decision. */
  intent?: SessionTurnIntent;
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
   *  new mode/model/effort/fast mode takes effect). Omitted fields keep the session's prior
   *  value. */
  model?: string;
  permissionMode?: string;
  effort?: string;
  fastMode?: boolean;
  /** Revive on another provider identity that runs on the SAME built-in runtime — same rule and
   *  same rejection as SessionConfigDto.provider. No reload turn is needed here: the revived
   *  session is claimed afresh, and the claim resolves the environment from the row. */
  provider?: string;
  /** With `provider` naming the built-in Codex or Claude engine: which of the runner's accounts of
   *  it — `automatic`, `default` or a slot id — as SessionConfigDto.account. */
  account?: string;
  /** The run this message authorises STOPPING, named by its public id.
   *
   *  Only read when this session's task is being worked by another run and `provider` names a
   *  different one than that run is on: the platform then answers
   *  `TASK_RUN_PROVIDER_SWITCH_CONFIRMATION_REQUIRED` and this field is what confirms it. It names
   *  the session rather than being a bare flag because stopping a run is destructive and the
   *  authorisation is for the run the person was SHOWN — a holder that changed hands in between is
   *  a different run, and asks again rather than being stopped on a confirmation about another. */
  stopSessionId?: string;
}

/** What `switchAccount` takes to put a session back on Automatic. */
export const AUTOMATIC_ACCOUNT = 'automatic';

/** Move a session on the built-in Codex or Claude engine to another of its runner's accounts —
 *  `default` or a slot id, which pins it there — or back onto `automatic`. */
export interface SessionAccountDto {
  account: string;
}

export interface MergeToMainDto {
  recoveryAction?: import('@orbit/shared').MergeRecoveryAction;
  previewId?: string;
  /** The branch to merge this session's worktree branch INTO, picked from the status bar's
   *  branch dropdown. Omitted → the default: the runner auto-detects main, else master. */
  targetBranch?: string;
  /** Hold the response until the merge has an outcome, and return that outcome inline instead of
   *  `{ ok: true }` (which only ever meant "queued"). 1..300 seconds. Omitted → the asynchronous
   *  behaviour the Merge button uses, unchanged. The runner is woken to read the command at once,
   *  but a lost wake leaves it to its next 30s tick, so a wait under that can time out even for a
   *  merge that succeeds. */
  waitSeconds?: number;
}

/** Start the dedicated repair conversation for a merge recovery. */
export interface MergeRepairDto {
  /** Prepare a reviewable PR candidate instead of resolving the recovery in place. */
  preparePR?: boolean;
}

export interface SessionArmRetryDto {
  /** When the re-send should fire (ISO). Supplied by the caller because disarming cleared the
   *  only copy the server had; the client re-derives it from the failing reply with the same
   *  `parseQuotaResetAt` the ingestion path used. Must be in the future and inside
   *  MAX_ARM_AHEAD_MS — see sessions.service.armAutoRetry for why a caller-chosen instant is
   *  not a privilege escalation. */
  retryAt: string;
}

/** Which provider identity the re-send behind `POST /sessions/:id/retry-message` runs on, when the
 *  caller has a pick pending in its composer — the pair `SessionResumeDto` carries, under the same
 *  rule and with the same rejection. Omitted, the re-send runs on the identity the session already
 *  has, which is what a Retry pressed with nothing chosen must do.
 *
 *  Without this the button could not do what the person asking for it meant: the composer's pick is
 *  a client-side choice that only travels on a message you SEND, while Retry re-sends the last one —
 *  so choosing a provider and then pressing Retry ran on the provider the session was already on. */
export interface RetryIdentityDto {
  provider?: string;
  /** With `provider` naming the built-in Codex or Claude engine: which of the runner's accounts of
   *  it, as SessionResumeDto.account. Ignored without a provider, as it is there. */
  account?: string;
}

export interface SessionRenameDto {
  /** New display title for the session. Trimmed; must be non-empty. Renaming works on any
   *  session regardless of status and never touches the runner. */
  title: string;
}

export interface SessionConfigDto {
  /** Change the model, permission mode and/or effort of an already-started session.
   *  Allowed in any non-terminal status, mid-turn included, and omitted fields are untouched.
   *  On the claude runtime all three are said to the engine that is already running, so they
   *  take effect from that point in the turn; on the others the runner re-spawns the runtime and
   *  the change lands on the next turn.
   *  effort: '' clears it back to the model default; omitted keeps the running value. */
  model?: string;
  permissionMode?: string;
  effort?: string;
  /** Turn the runtime's fast lane on or off. Always a `reload`, never mid-turn: Claude reads it
   *  once, out of the settings file its process was built with, so there the runner re-spawns
   *  with --resume; Codex takes it as a per-request service tier, so there the next turn/start
   *  carries it. Either way it takes effect on the next turn. Forced off when the effective
   *  runtime/model (for Codex, the runner catalogue's row) do not have it. */
  fastMode?: boolean;
  /** Re-point the session at another provider identity — a second account with the same vendor,
   *  or another endpoint — that runs on the SAME built-in runtime. Cross-runtime is rejected:
   *  the transcript, the resume id and the wire protocol belong to the CLI that started the
   *  session. Omitted keeps the current provider. */
  provider?: string;
  /** With `provider` moving the session onto the built-in Codex or Claude engine: which of the
   *  runner's accounts of it the session runs on — `automatic` (Orbit's pick, unpinned), `default`
   *  or a slot id (pinned). Omitted is Automatic's pick unless the session is pinned there. A
   *  session already on that engine moves with PATCH /sessions/:id/account instead. */
  account?: string;
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

/**
 * `POST /sessions/:id/move` (docs/session-folders-move-design.md §5.4). A class, so the global
 * ValidationPipe decodes both ids from whichever spelling a client sends (`IsPublicId`).
 *
 * `workspaceId` omitted, or naming the session's own workspace, files it: `folderId` names a folder
 * of that workspace — or, null or omitted, none, which is how a session leaves its folder. Naming
 * another workspace moves the session there, into `folderId` (a folder of that workspace) or none.
 */
export class MoveSessionDto {
  @IsOptional() @IsPublicId() workspaceId?: string;
  @IsOptional() @IsPublicId() folderId?: string | null;
}
