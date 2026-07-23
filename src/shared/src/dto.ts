import { AgentProvider, PermissionMode, RunnerStatus, RunStatus } from './enums';
import { ModelUsage, NormalizedRunEvent, TokenUsage } from './events';

/**
 * Everything a runner needs to drive Claude Code for one session. Mirrors the
 * relevant `@anthropic-ai/claude-agent-sdk` `query()` options.
 */
export interface AgentExecConfig {
  provider?: AgentProvider;
  model: string;
  appendSystemPrompt?: string;
  systemPrompt?: string;
  allowedTools: string[];
  disallowedTools: string[];
  permissionMode: PermissionMode;
  /** Provider reasoning effort. Claude supports max; Codex maps max to xhigh. */
  effort?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** MCP server config passed through to the SDK (`mcpServers`). */
  mcpConfig?: Record<string, unknown>;
  /** Custom environment variables injected into the claude process. */
  env?: Record<string, string>;
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
  provider?: AgentProvider;
  agentKey?: string;
  workDir?: string;
}

/** One `/`-invocable asset (slash command or skill) discovered on a runner's
 *  filesystem, surfaced to the web composer for `/` autocomplete. */
export interface SlashCommandInfo {
  /** Invocation name without the leading slash, e.g. "commit". */
  name: string;
  description?: string;
  /** 'command' (.claude/commands/*.md) or 'skill' (.claude/skills/<name>/SKILL.md). */
  type?: 'command' | 'skill';
  /** The agent whose workDir this project-level asset was found in. Empty/undefined
   *  means host-level (~/.claude or the runner's default dir), shared by all agents;
   *  the web composer scopes `/` autocomplete to host assets + the session's agent. */
  agentId?: string;
}

/** One model option reported by a runner runtime. For Codex this is derived from
 *  `codex debug models`, so newly shipped model slugs do not require a web release. */
export interface RunnerModelInfo {
  /** Runtime model id / slug, e.g. `gpt-5.6`. */
  value: string;
  /** Human display name shown in pickers. */
  label: string;
  /** Provider catalog order; lower sorts first. */
  priority?: number;
  /** Max input/context window reported by the runtime, when available. */
  contextWindow?: number;
  /** Provider reasoning efforts accepted by this model. */
  reasoningLevels?: string[];
  defaultReasoningLevel?: string;
  /** Extra service tiers supported by this model, e.g. `priority`. */
  serviceTiers?: string[];
}

/** Models a runner says its local runtimes can use. Keys are provider ids. */
export type RunnerModelCatalog = Partial<Record<AgentProvider, RunnerModelInfo[]>>;

/** One rate-limit window from a provider quota snapshot. Claude reports named
 *  5-hour / weekly windows; Codex reports primary / secondary windows. */
export interface PlanUsageWindow {
  /** Percent of the window consumed, 0..100. */
  utilization: number;
  /** ISO-8601 timestamp when the window resets, if the endpoint reported one. */
  resetsAt?: string;
  /** Provider-supplied/display label for dynamic windows, when known. */
  label?: string;
  /** Rolling window duration in minutes, when known. */
  windowDurationMins?: number;
}

export interface PlanUsageCredits {
  hasCredits: boolean;
  unlimited: boolean;
  balance?: string;
}

/** One Codex rate-limit bucket. The backend may provide additional
 *  model/product buckets alongside the canonical `codex` bucket. */
export interface PlanUsageRateLimit {
  limitId?: string;
  limitName?: string;
  primary?: PlanUsageWindow;
  secondary?: PlanUsageWindow;
  credits?: PlanUsageCredits;
}

export interface PlanUsageSnapshot {
  provider?: AgentProvider;
  /** Rolling 5-hour session limit. */
  fiveHour?: PlanUsageWindow;
  /** 7-day all-models limit. */
  sevenDay?: PlanUsageWindow;
  /** 7-day Opus-scoped limit (Max plans). */
  sevenDayOpus?: PlanUsageWindow;
  /** 7-day Sonnet-scoped limit. */
  sevenDaySonnet?: PlanUsageWindow;
  /** Codex primary rolling limit. */
  primary?: PlanUsageWindow;
  /** Codex secondary rolling limit. */
  secondary?: PlanUsageWindow;
  limitId?: string;
  limitName?: string;
  planType?: string;
  rateLimitReachedType?: string;
  credits?: PlanUsageCredits;
  /** All Codex limit buckets, in display order. */
  rateLimits?: PlanUsageRateLimit[];
  /** ISO-8601 when the runner fetched this. */
  fetchedAt?: string;
}

/** Provider quota for the account a runner is logged into. Old runners report a
 *  flat Claude snapshot; newer runners may nest per-provider snapshots under
 *  `claude` / `codex` so one runner can surface both. */
export interface PlanUsage extends PlanUsageSnapshot {
  claude?: PlanUsageSnapshot;
  codex?: PlanUsageSnapshot;
}

export interface RunnerHeartbeatRequest {
  status: RunnerStatus;
  /** How many more concurrent sessions the runner can accept right now. */
  idleCapacity: number;
  version?: string;
  /** Custom slash commands the runner found under ~/.claude + its workDirs. */
  commands?: SlashCommandInfo[];
  /** Skills the runner found under ~/.claude + its workDirs. */
  skills?: SlashCommandInfo[];
  /** Provider quota for the account(s) this runner uses. Absent when unavailable
   *  or when the runner is too old to report it. */
  planUsage?: PlanUsage;
  /** Runtime model catalog reported by this runner. Absent on older runners. */
  modelCatalog?: RunnerModelCatalog;
  /** Live worktree state for each session this runner is currently running, so the
   *  composer's status bar appears mid-turn — not just after a turn completes. Absent
   *  from older runners (the bar then waits for the first turn-complete as before). */
  sessions?: SessionLiveState[];
}

/** One running session's live worktree diff, reported on the heartbeat while a turn is
 *  still in flight (cf. TurnCompleteRequest, which carries the same at turn boundaries). */
export interface SessionLiveState {
  sessionId: string;
  /** What the runner did: 'worktree' | 'shared-nogit'. */
  isolationStatus: string;
  /** The worktree's current uncommitted diff vs base; empty when nothing changed yet. */
  changedFiles: ChangedFile[];
  /** Whether the worktree has uncommitted changes right now (`git status` non-empty). Drives
   *  the status bar's primary action: dirty → Commit, clean-but-ahead → Merge. Absent from
   *  older runners (the bar then falls back to the session lifecycle). */
  worktreeDirty?: boolean;
  /** The repo's candidate merge-target branches (local refs/heads minus Orbit's own orbit/*
   *  session branches), so the status bar's "Merge to…" dropdown can offer targets besides
   *  main. Absent from older runners (the dropdown then offers only the auto-detected default). */
  mergeTargets?: string[];
  /** Whether the branch tip is already an ancestor of the repo's default merge target (main,
   *  else master) — i.e. the work already landed there. Drives the bar's "✓ In main" chip in
   *  place of a redundant Merge button. Always sent (false when not), so the server can clear a
   *  stale true; absent only from older runners (the bar keeps its mergeStatus behavior). */
  branchMerged?: boolean;
}

export interface RunnerHeartbeatResponse {
  /** Session IDs the control plane wants the runner to interrupt / end. */
  cancelSessionIds: string[];
  /** The runner's authoritative max-concurrent (the editable DB value). The runner
   *  adopts this live on each heartbeat, so a UI/API change to it takes effect within
   *  one heartbeat without restarting the runner. */
  maxConcurrent: number;
  /** Branch merges the user requested from the UI for sessions this runner ran. The
   *  runner merges each session's branch into main on its local repo and reports the
   *  outcome back via POST /runner/sessions/:id/merge-result. Absent on older control
   *  planes (older runners ignore the field → the merge stays pending). */
  mergeRequests?: MergeCommand[];
  /** Commits the user requested for live sessions this runner is running: commit the
   *  worktree's uncommitted changes onto its branch, then POST the outcome via
   *  /runner/sessions/:id/commit-result. Absent on older control planes. */
  commitRequests?: CommitCommand[];
  /** Legacy assistant artifacts that were written as runner-local /root/.orbit/uploads paths
   *  before they were persisted as attachments. The runner uploads them back to the control
   *  plane so historical transcript links can download. */
  artifactRequests?: ArtifactCommand[];
}

/** Control plane → runner: merge one session's worktree branch into a target branch. */
export interface MergeCommand {
  sessionId: string;
  /** The session's worktree branch, e.g. orbit/<slug>-<hash>. */
  branch: string;
  /** The session agent's workDir; the runner resolves the repo root from it. */
  workDir: string;
  /** The branch to merge INTO. Absent/empty → the runner auto-detects main, else master
   *  (the original behavior). Set when the user picked a non-default target from the
   *  status bar's branch dropdown. */
  targetBranch?: string;
}

/** Control plane → runner: commit a live session's uncommitted worktree changes onto its
 *  branch. The runner locates the checkout from the session id (its per-session worktree
 *  dir); `branch` is for logging only. */
export interface CommitCommand {
  sessionId: string;
  /** The session's worktree branch, e.g. orbit/<slug>-<hash>. */
  branch: string;
}

export interface ArtifactCommand {
  requestId: string;
  sessionId: string;
  path: string;
}

// ─────────────────────────── Interactive sessions (Route B) ───────────────────────────

/** An interactive session atomically claimed by its assigned runner via long-poll. */
export interface ClaimedSession {
  sessionId: string;
  title: string;
  /** Local runtime that should drive this session. Omitted by old servers => Claude. */
  provider?: AgentProvider;
  /** First-turn seed (the prompt the session was created with). */
  prompt: string;
  agent: AgentExecConfig;
  /** Project directory to run claude in (claude's cwd), from the session's agent. */
  workDir?: string;
  /** Git branch for this session's worktree (e.g. "orbit/fix-login-500-a1b2c3"). When set
   *  and workDir is a git repo, the runner runs claude in a per-session `git worktree` on
   *  this branch instead of the shared workDir. Generated server-side at session creation. */
  branch?: string;
  /** Agent opt-in: if workDir isn't a git repo, the runner `git init`s it (default
   *  .gitignore + baseline commit) so the session can still be worktree-isolated. */
  autoInitGit?: boolean;
  /** The branch this session's work merges INTO (its recorded mergeTarget, else its agent's
   *  defaultMergeTarget) — the same branch the status bar's Merge button names. The runner
   *  judges "already merged" against it, so work landed in e.g. `develop` isn't reported
   *  unmerged just because it isn't in main. Omitted → the runner auto-detects main/master. */
  mergeTarget?: string;
  /** Pre-generated Claude session id to pass via --session-id (and --resume on respawn). */
  sessionUuid: string;
  /** Provider-neutral runtime session/thread id. For Claude this mirrors sessionUuid. */
  runtimeSessionId?: string;
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
  /** Whether this session's agent may orchestrate other sessions (Agent.enableOrchestration).
   *  Injected as ORBIT_ALLOW_ORCHESTRATION so `orbit mcp` conditionally exposes session_* tools. */
  allowOrchestration?: boolean;
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

/** A human's answers to an AskUserQuestion, keyed by question text → the selected
 *  option labels (one entry per question; a single-select question has one label).
 *  The runner feeds this to claude as the tool's `updatedInput.answers`. */
export type QuestionAnswers = Record<string, string[]>;

/** A claude permission rule to add for the rest of the session, so future "same kind"
 *  calls are auto-allowed by claude's own engine without re-prompting. `toolName` is the
 *  gated tool (e.g. "Bash", "Edit"); `ruleContent` narrows it (Bash uses a command
 *  prefix like "git commit:*") — omit it to allow every call to that tool. The runner
 *  wraps this into claude's updatedPermissions (addRules / allow / session). */
export interface PermissionRule {
  toolName: string;
  ruleContent?: string;
}

/** Browser → control plane: a human's allow/deny on a pending approval. For an
 *  AskUserQuestion an `allow` carries the picked `answers`. An `allow` may also carry
 *  `rememberRules` to auto-allow the same kinds of call for the rest of the session —
 *  one rule per distinct sub-command of a compound Bash line, so `cd x && git add …`
 *  remembers both `cd` and `git add`, not just the leading `cd`. */
export interface ApprovalDecisionRequest {
  behavior: 'allow' | 'deny';
  message?: string;
  answers?: QuestionAnswers;
  rememberRules?: PermissionRule[];
}

/** Control plane → runner: the resolved decision (returned by the approval
 *  long-poll). status === 'PENDING' means the long-poll window elapsed undecided. */
export interface ApprovalDecisionResponse {
  id: string;
  status: ApprovalStatus;
  behavior?: 'allow' | 'deny';
  message?: string;
  answers?: QuestionAnswers;
  rememberRules?: PermissionRule[];
  /** Deprecated: the first of `rememberRules`, kept so runners that predate the array
   *  form still remember at least the primary rule until they restart and self-update. */
  rememberRule?: PermissionRule;
}

// 'reload' carries no user text: it tells the runner the session's model /
// permission-mode changed, so it should re-spawn claude with --resume + the new
// flags (full context preserved). The new config rides in the turn's `content` JSON.
// 'diff' is a fire-and-forget control turn (no text, no claude): it asks the runner to
// recompute the live worktree diff and push it back, so an opened file's diff reflects
// the current worktree even when the stored snapshot lagged (the heartbeat refreshes the
// file list but not the patch text — see SessionDiffResultRequest).
export type ConversationTurnKind = 'message' | 'interrupt' | 'end' | 'reload' | 'shell' | 'diff';

/** An attachment as handed to the runner on the inbox: the id to fetch its bytes with
 *  (runner-scoped `GET /runner/sessions/:id/attachments/:attId`), its MIME type, and the
 *  original filename. The runner dispatches on the type — `image/*` → image block,
 *  `application/pdf` → document block, anything else → written to the worktree under
 *  `fileName`. The bytes themselves never travel inline — only this ref does. */
export interface TurnAttachment {
  id: string;
  mimeType: string;
  /** Original upload filename; the runner names a written-to-disk upload with it. Absent
   *  for pasted images (inlined as image blocks, never written). */
  fileName?: string;
}

/** Browser → control plane: enqueue a user turn for a live interactive session. */
export interface RunTurnRequest {
  /** Client-supplied idempotency key (UUID); dedups double-clicks / cross-tab sends. */
  clientTurnId: string;
  content: string;
  /** Ids of pre-uploaded image attachments (`POST /api/attachments`) to send with this
   *  turn. Only the ids travel here — the bytes already live in the control plane.
   *  Omitted/empty keeps the turn text-only. */
  attachmentIds?: string[];
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
  /** Image attachments for this (message) turn. The runner fetches each blob via the
   *  runner-scoped `GET /runner/sessions/:id/attachments/:attId`, base64-encodes it, and
   *  adds an `image` content block alongside the text. Omitted for text-only/control turns. */
  attachments?: TurnAttachment[];
}

/** One interactive session a restarted runner can re-attach to and --resume. */
export interface ReclaimSession {
  sessionId: string;
  title: string;
  provider?: AgentProvider;
  sessionUuid: string;
  runtimeSessionId?: string;
  /** Highest persisted RunEvent.seq, so the runner continues the seq counter. */
  maxSeq: number;
  /** How to re-drive `claude` — same shape a fresh claim hands the runner, so the
   *  resumed process keeps the session's model/permission-mode/tools. */
  agent: AgentExecConfig;
  /** Project directory to run claude in (claude's cwd), from the session's agent. */
  workDir?: string;
  /** Git branch for this session's worktree, cf. ClaimedSession.branch. On reclaim the
   *  runner re-attaches to (or re-creates from this branch) the same worktree. */
  branch?: string;
  /** Agent opt-in to auto-`git init` a non-git workDir, cf. ClaimedSession.autoInitGit. */
  autoInitGit?: boolean;
  /** Branch this session merges into, cf. ClaimedSession.mergeTarget. */
  mergeTarget?: string;
  /** DB id of the session's agent (ORBIT_AGENT_ID), cf. ClaimedSession.agentId. */
  agentId?: string;
  /** DB id of the parent Task this session runs under, if any (ORBIT_TASK_ID). */
  taskId?: string;
  /** Orchestration opt-in, cf. ClaimedSession.allowOrchestration. */
  allowOrchestration?: boolean;
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
  /** Provider-neutral runtime session/thread id discovered during this turn. */
  runtimeSessionId?: string;
  // ── Live worktree state (so the composer's status bar updates each turn) ──
  /** What the runner did: 'worktree' | 'shared-nogit'. */
  isolationStatus?: string;
  /** The worktree's current diff vs base (uncommitted), refreshed each turn. */
  changedFiles?: ChangedFile[];
  /** Per-file unified diffs (capped) for the same uncommitted state, for on-demand viewing. */
  changedDiff?: FilePatch[];
  /** Whether the worktree has uncommitted changes (drives Commit vs Merge in the bar). */
  worktreeDirty?: boolean;
  /** Whether the branch already landed in the default merge target (see SessionLiveState). The
   *  turn-end snapshot an idle session shows until its next turn, so a branch merged out-of-band
   *  is reflected here. Always sent (false when not); absent only from older runners. */
  branchMerged?: boolean;
}

/** One file changed by a worktree-isolated session, as a compact diff summary the runner
 *  computes (git diff baseSha..branch) at terminal completion. `status` is the git
 *  name-status letter (A/M/D/R/...); `additions`/`deletions` are -1 for binary files. */
export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
  status: string;
}

/** One changed file's full unified-diff text (git diff vs base), reported by the runner
 *  alongside the ChangedFile stats so the web can show a file's diff on demand. `patch` is
 *  absent for binary/omitted files; `truncated` marks a diff dropped for exceeding the size
 *  cap (the web shows a "too large to preview" placeholder). Stored server-side in a side
 *  table (SessionDiff) and fetched only when a file is opened — never on the session payload. */
export interface FilePatch {
  path: string;
  patch?: string;
  truncated?: boolean;
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
  runtimeSessionId?: string;
  numTurns?: number;
  durationMs?: number;
  costUsd?: number;
  usage?: TokenUsage;
  modelUsage?: Record<string, ModelUsage>;
  // ── Worktree isolation outcome (see Session.branch/baseSha/changedFiles) ──
  /** The session's worktree branch, echoed back so the server persists it. */
  branch?: string;
  /** Commit the branch forked from (workDir HEAD at claim). */
  baseSha?: string;
  /** Per-file diff summary of the branch vs its base; empty when nothing changed. */
  changedFiles?: ChangedFile[];
  /** Per-file unified diffs (capped) of the committed branch vs base, for on-demand viewing. */
  changedDiff?: FilePatch[];
  /** What the runner did: 'worktree' (isolated) | 'shared-nogit' (no git → shared dir). */
  isolationStatus?: string;
  /** The repo's candidate merge-target branches at completion (see SessionLiveState.mergeTargets),
   *  so the ended session's "Merge to…" dropdown is populated. */
  mergeTargets?: string[];
}

/**
 * Control plane → runner response for POST /runner/sessions/:id/complete. `keepCheckout`
 * tells the runner whether to preserve the session's isolated worktree checkout: kept for
 * any resumable end (idle-park / user-end / task-done / cancel — the session can be
 * reopened), dropped only when the user archived (completed) or deleted the session.
 */
export interface SessionCompleteResponse {
  ok: boolean;
  keepCheckout: boolean;
}

/** Runner → control plane: given the session ids of leftover worktree checkouts, ask which
 *  are safe to garbage-collect. Sent by the runner's startup worktree GC. */
export interface WorktreesRemovableRequest {
  ids: string[];
}

/** Control plane → runner: the subset of the queried ids whose checkout may be removed —
 *  a session that was archived (completed) or deleted, or is no longer a session at all.
 *  Any id absent from this list belongs to a still-resumable session and must be kept. */
export interface WorktreesRemovableResponse {
  removable: string[];
}

/**
 * Runner → control plane: the outcome of a {@link MergeCommand}. `merged` advanced main
 * (mergedSha is the new HEAD); `conflict` means the merge was aborted cleanly; `error`
 * means a precondition failed (workDir not on a clean main, branch missing, …). `message`
 * carries git's stderr / the precondition for the UI.
 */
export interface SessionMergeResultRequest {
  status: 'merged' | 'conflict' | 'error';
  mergedSha?: string;
  message?: string;
}

/**
 * Runner → control plane: the outcome of a {@link CommitCommand}. `committed` advanced the
 * branch (the worktree is now clean); `nochange` means there was nothing to commit; `error`
 * means the commit failed (no worktree, git error). `message` carries git's stderr.
 */
export interface SessionCommitResultRequest {
  status: 'committed' | 'nochange' | 'error';
  message?: string;
}

/**
 * Runner → control plane: a freshly recomputed live worktree diff, pushed in response to a
 * 'diff' inbox control turn (the web opened a file whose stored patch lagged the worktree).
 * Mirrors the live fields of {@link TurnCompleteRequest}: the server overwrites the session's
 * `changedFiles` and the SessionDiff side-table `patches` so list and diff are consistent
 * again, fixing the "No diff to preview" gap for files added/changed since the last turn end.
 */
export interface SessionDiffResultRequest {
  changedFiles?: ChangedFile[];
  changedDiff?: FilePatch[];
  worktreeDirty?: boolean;
  /** Whether the branch already landed in the default merge target (see SessionLiveState).
   *  Recomputed with the diff, so opening the diff drawer refreshes it for an idle session. */
  branchMerged?: boolean;
}

export interface ArtifactResultRequest {
  requestId: string;
  status: 'uploaded' | 'missing' | 'error';
  attachmentId?: string;
  message?: string;
}
