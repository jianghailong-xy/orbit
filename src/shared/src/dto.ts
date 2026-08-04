import {
  AgentProvider,
  PermissionMode,
  RunnerStatus,
  RunStatus,
  SessionFilingState,
  SessionLifecycleState,
  SessionRunState,
  SessionState,
} from './enums';
import { ModelUsage, NormalizedRunEvent, TokenUsage } from './events';

/** Why an ended session cannot currently be resumed on its original runner. */
export type SessionResumeBlockedReason =
  'TRASHED' | 'ENDING' | 'NOT_TERMINAL' | 'NOT_STARTED' | 'MISSING_CONTEXT' | 'NO_RUNNER' | 'RUNNER_OFFLINE';

/**
 * Server-derived actions currently available for a session. Optional on containing
 * wire payloads so older/rolling servers and clients remain compatible.
 */
export interface SessionCapabilities {
  canSend: boolean;
  canResume: boolean;
  resumeBlockedReason: SessionResumeBlockedReason | null;
  /** Canonical capability for moving an Open session to Completed. */
  canComplete: boolean;
  /** @deprecated Compatibility alias of `canComplete`. */
  canArchive: boolean;
  canRestore: boolean;
}

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
  /** Provider reasoning effort/variant. Claude supports max; Codex maps max to xhigh. */
  effort?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** MCP server config passed through to the SDK (`mcpServers`). */
  mcpConfig?: Record<string, unknown>;
  /** Custom environment variables injected into the coding-engine process. */
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
  /** 'command' or 'skill' in the owning runtime's slash registry. */
  type?: 'command' | 'skill';
  /** Runtime that owns this asset. Absent means Claude for compatibility with old runners. */
  provider?: AgentProvider;
  /** The agent whose workDir this project-level asset was found in. Empty/undefined
   *  means host-level (the runtime's home config or the runner's default dir), shared by all agents;
   *  the web composer scopes `/` autocomplete to host assets + the session's agent. */
  agentId?: string;
  /** True for a name the runtime registers itself — a built-in skill (`/loop`), a
   *  plugin skill, or a namespaced command — learned from its protocol handshake instead
   *  of found on disk. Composers list these after the user's own commands and skills. */
  builtin?: boolean;
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

/** Effective default model reported by each built-in runtime on one runner heartbeat. This is
 *  read-only capability state; user selections are persisted on Session instead. */
export type RuntimeDefaultModels = Partial<Record<AgentProvider, string>>;

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
 *  flat Claude snapshot; newer runners may nest per-provider snapshots so one
 *  runner can surface several runtimes. */
export interface PlanUsage extends PlanUsageSnapshot {
  claude?: PlanUsageSnapshot;
  codex?: PlanUsageSnapshot;
  kimi?: PlanUsageSnapshot;
}

export interface RunnerHeartbeatRequest {
  status: RunnerStatus;
  /** How many more active turns the runner can accept right now. Warm idle
   *  runtime processes do not consume this logical scheduling capacity. */
  idleCapacity: number;
  version?: string;
  /** Stable identity of this runner process. Together with supervisedSessionIds,
   *  fences cold supervisors left behind by an overlapping old process. */
  leaseOwner?: string;
  /** Every session currently registered in this process's local supervisor pool,
   *  including cold sessions that do not poll an inbox. */
  supervisedSessionIds?: string[];
  /** Runtime slash commands discovered by the runner, optionally scoped by provider/agent. */
  commands?: SlashCommandInfo[];
  /** Runtime skills discovered by the runner, optionally scoped by provider/agent. */
  skills?: SlashCommandInfo[];
  /** Provider quota for the account(s) this runner uses. Absent when unavailable
   *  or when the runner is too old to report it. */
  planUsage?: PlanUsage;
  /** Runtime model catalog reported by this runner. Absent on older runners. */
  modelCatalog?: RunnerModelCatalog;
  /** Per-engine health on this machine (installed / version / signed in). Absent on older
   *  runners, which leaves the stored snapshot alone rather than claiming three unknowns. */
  engines?: RunnerEngineHealth[];
  /** Effective defaults reported by local runtimes. Absent on older runners; an explicit empty
   *  object means no runtime currently exposes a default and replaces the previous snapshot. */
  runtimeDefaultModels?: RuntimeDefaultModels;
  /** Live worktree state for each session supervised by this runner, including an
   *  AWAITING_INPUT session whose runtime is warm or has gone cold. Absent from older
   *  runners (the bar then waits for the first turn-complete as before). */
  sessions?: SessionLiveState[];
}

/** One supervised session's live worktree diff (cf. TurnCompleteRequest, which carries
 *  the same snapshot at turn boundaries). */
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
  /** Exact tip SHA of the effective worktree branch. Lets the server distinguish a conservative
   *  branchMerged=false from an actual post-merge commit. Absent from older runners. */
  branchSha?: string;
  /** The worktree's ACTUAL current HEAD branch (git symbolic-ref). Normally equals the session's
   *  tracked `branch`; it differs when the agent ran `git checkout -b` inside the worktree, moving
   *  the work onto a branch Orbit isn't tracking. The server compares it to `session.branch` to
   *  flag divergence (and offer "Adopt"). Absent when HEAD is detached / older runners → keep last. */
  worktreeBranch?: string;
}

export interface RunnerHeartbeatResponse {
  /** Session IDs the control plane wants the runner to interrupt / end. */
  cancelSessionIds: string[];
  /** Supervised sessions that no longer belong to this exact runner process.
   *  Kept separate from durable user cancellation: a cold supervisor detaches
   *  without finalizing, while active/warm engines observe their endpoint fence. */
  leaseLostSessionIds?: string[];
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
  /** One step of a browser-less runtime login the user started from the web. Absent on
   *  older control planes, and whenever no sign-in is in flight for this runner. */
  loginRequest?: LoginCommand;
  /** An engine install the user started from the web. Absent on older control planes, and
   *  whenever no install is in flight for this runner. */
  installRequest?: InstallCommand;
}

/** Engines a runner signs in with on its own machine, rather than using a configured API key. */
export type LoginEngine = 'claude' | 'codex' | 'kimi';

/**
 * Control plane → runner: drive the interactive sign-in on the runner's own machine.
 *
 * `start` launches the engine's sign-in; the runner reports back what the user needs. The
 * engines differ in kind: `claude auth login` prints a URL whose redirect_uri is Anthropic-hosted
 * and then waits for the code that page gives the user (`code` carries it back), while
 * `codex login --device-auth` prints a URL *and* a one-time code to enter there, then polls for
 * the approval itself. Kimi has its own runtime-managed sign-in flow. Either way the user's
 * browser never has to reach the runner — which plain
 * `codex login` would require, since it serves its callback on localhost on that machine.
 *
 * Redelivered every heartbeat until the runner's status report moves the server on, so both
 * actions must be idempotent on the runner.
 */
export interface LoginCommand {
  action: 'start' | 'code';
  /** Which CLI to sign in. Absent from an older control plane, which only ever drove claude. */
  engine?: LoginEngine;
  /** The authorization code the user pasted, for `code`. */
  code?: string;
  /** Identifies this sign-in, so the runner can tell a redelivered `start` from one the user
   *  asked for again after cancelling — the latter must preempt whatever is still running. */
  attempt?: string;
}

/** Runner → control plane: progress of a sign-in relay. */
export interface LoginResult {
  /** `awaiting_code` (paste-back flow) and `awaiting_approval` (device flow) carry `url`; only
   *  the latter carries `userCode`; `failed` carries `message`. */
  status: 'awaiting_code' | 'awaiting_approval' | 'done' | 'failed';
  url?: string;
  /** The one-time code the user types on the sign-in page, for the device flow. */
  userCode?: string;
  message?: string;
}

/**
 * One coding-engine CLI's health on a runner, reported each heartbeat.
 *
 * This is the same probe `orbit doctor` prints (the runner's checkEngine), which is why `auth`
 * has three states rather than two: a CLI that won't answer must not be shown as signed in.
 */
export interface RunnerEngineHealth {
  engine: LoginEngine;
  installed: boolean;
  /** Whatever `<engine> --version` printed. Absent when not installed or the CLI wouldn't say. */
  version?: string;
  /** The CLI's own answer to "am I signed in", with `unknown` for anything ambiguous. */
  auth: 'yes' | 'no' | 'unknown';
  /** What the runner's updater last did to this engine. Absent from an older runner, and until
   *  the first daily pass — shown as "not reported yet", never as a problem. */
  update?: RunnerEngineUpdate;
}

/**
 * The updater's last word on one engine, reported alongside its health.
 *
 * Orbit updates these CLIs itself, daily. That is invisible without this: a version string alone
 * can't say whether it is the newest one, so the useful question is not "which version is this"
 * but "is this machine still being kept current" — which only the updater can answer.
 */
export interface RunnerEngineUpdate {
  /** `ok` — the update ran clean (finding nothing to do counts: the path works).
   *  `failed` — it ran and errored; `message` is the machine's own words.
   *  `skipped` — Orbit deliberately won't touch this install; `message` says why. */
  status: 'ok' | 'failed' | 'skipped';
  /** ISO time of the attempt this describes. */
  at: string;
  /** ISO time of the last attempt that succeeded, kept across later failures. Absent if one
   *  never has — which is a louder fact than a recent failure, not a quieter one. */
  okAt?: string;
  message?: string;
}

/**
 * Control plane → runner: install one engine CLI on the runner's own machine.
 *
 * Same shape as the sign-in relay: parked on the runner row, redelivered every heartbeat until
 * the runner's status report moves the server on, so acting on it must be idempotent.
 *
 * Distinct from the runner's on-demand install (ensureEngine), which only ever runs for a machine
 * that consented at register time. Pressing Install in the browser IS that consent, for one
 * engine on one machine, so this path does not consult that flag.
 */
export interface InstallCommand {
  /** Absent only for `mode: 'update'`, which is about every engine on the machine. */
  engine?: LoginEngine;
  /** Identifies this install, so the runner can tell a redelivered request from a new one. */
  attempt?: string;
  /** `update` reuses this one relay slot to update every engine already on the machine instead
   *  of installing one. Both drive a package manager against that machine's single global
   *  prefix, so they share a slot rather than racing. Absent → `install`, which is what an
   *  older runner reads it as. */
  mode?: RelayMode;
}

/** What the engine relay is doing with its one slot: installing a named CLI, or updating them all. */
export type RelayMode = 'install' | 'update';

/** Runner → control plane: progress of an engine install. */
export interface InstallResult {
  status: 'installing' | 'done' | 'failed';
  /** The installer being run, so the UI can show it and offer it as a manual fallback. */
  command?: string;
  /** For `failed`: what the machine said, plus the alternative command to try by hand. */
  message?: string;
}

/** Browser-facing view of a runner's engine relay, for the row or card that drives it. */
export interface RunnerInstallState {
  status: 'pending' | 'installing' | 'done' | 'failed' | null;
  /** Which engine is being installed; null when nothing is in flight, and for `update`, which
   *  is the whole machine's business rather than one row's. */
  engine: LoginEngine | null;
  command: string | null;
  message: string | null;
  /** Which of the two jobs the slot is running. Null when nothing is in flight; `install` on a
   *  row written before updates shared this relay. */
  mode: RelayMode | null;
}

/** Browser-facing view of a runner's sign-in relay, for the card that drives it. */
export interface RunnerLoginState {
  status: 'pending' | 'awaiting_code' | 'awaiting_approval' | 'done' | 'failed' | null;
  /** Which engine this relay is signing in; null when nothing is in flight. */
  engine: LoginEngine | null;
  url: string | null;
  /** Set with `awaiting_approval`: the code to enter on the page at `url`. */
  userCode: string | null;
  message: string | null;
}

/** Control plane → runner: merge one session's worktree branch into a target branch. */
export interface MergeCommand {
  sessionId: string;
  /** Unique queued attempt; echoed by the runner result to prevent ABA. */
  operationId: string;
  /** Runner-process owner authorized to execute this attempt. */
  leaseOwner: string;
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
  /** Unique queued attempt; echoed by the runner result to prevent ABA. */
  operationId: string;
  /** Runner-process owner authorized to execute this attempt. */
  leaseOwner: string;
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
  /** Runner-process identity currently authorized to activate inbox generations. */
  leaseOwner?: string;
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
  /** Signed, runner/session-bound proof persisted in the runner's private per-session
   *  credential store. Required alongside ORBIT_SESSION_ID for orchestration calls. */
  orchestrationToken?: string;
}

export interface RunEventBatch {
  events: NormalizedRunEvent[];
  /** Stable UUID for the runner process that produced this batch. Omitted only by legacy runners. */
  leaseOwner?: string;
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

/** Runner → control plane: expire only leases owned by one dead engine process.
 * Optional during rolling upgrades; an omitted generation matches legacy NULL leases only. */
export interface ReleaseTurnLeasesRequest {
  leaseGeneration?: string;
  /** Stable for one runner process. Lets the server distinguish a retry from a later process. */
  leaseOwner?: string;
}

/** Runner → control plane: make one freshly reserved engine generation the sole inbox consumer.
 * Idempotent for the same generation; rejected while a different generation remains active. */
export interface ActivateTurnLeasesRequest {
  leaseGeneration: string;
  /** Stable UUID for this runner process, shared by reclaim and all of its engines. */
  leaseOwner: string;
}

/** Runner process → control plane: atomically supersede the process identity observed in a
 * reclaim/claim response and retire that predecessor's current inbox consumer. */
export interface TakeoverTurnLeasesRequest {
  leaseOwner: string;
  expectedLeaseOwner?: string | null;
}

/** Authoritative Session state read while takeover holds the Session row lock. */
export interface TakeoverTurnLeasesResponse {
  ok: true;
  status: RunStatus;
}

/** One open interactive session a restarted runner must retain. Only RUNNING is
 *  re-attached as an active turn; queued/idle sessions are registered cold so their
 *  worktree survives and a later claim can resume them without spawning eagerly. */
export interface ReclaimSession {
  sessionId: string;
  /** Omitted by older servers, which runners conservatively treat as RUNNING. */
  status?: RunStatus;
  title: string;
  provider?: AgentProvider;
  sessionUuid: string;
  runtimeSessionId?: string;
  /** Runner-process identity that owned inbox activation when this snapshot was read. */
  leaseOwner?: string;
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
  /** Fresh runner/session-bound proof for the runner's private credential store. */
  orchestrationToken?: string;
}

/** Control plane → runner response for GET /runner/sessions/reclaim. */
export interface ReclaimResponse {
  sessions: ReclaimSession[];
}

/** Runner-authenticated response for refreshing a live session's orchestration proof. */
export interface OrchestrationCredentialResponse {
  orchestrationToken: string;
}

/**
 * Runner → control plane: a single interactive turn finished (the per-turn `result`),
 * distinct from /complete which finalizes the whole session. Carries per-turn billing.
 */
export interface TurnCompleteRequest {
  turnId: string;
  /** Stable UUID for the runner process completing this turn. Omitted only by legacy runners. */
  leaseOwner?: string;
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
  /** Exact tip SHA of the effective worktree branch (see SessionLiveState.branchSha). */
  branchSha?: string;
  /** The worktree's actual current HEAD branch (see SessionLiveState.worktreeBranch). */
  worktreeBranch?: string;
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
export interface RunFinalizeRequest {
  status: RunStatus;
  /** Stable UUID for the runner process finalizing this run. Omitted only by legacy runners. */
  leaseOwner?: string;
  /** Claude Code `result` text. */
  result?: string;
  /** Claude Code result `subtype`. */
  subtype?: string;
  error?: string;
  /** @deprecated Legacy alias for runtimeSessionId, still sent by older runners. Accepted only
   *  as a fallback when runtimeSessionId is absent; never stored separately. */
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
  /** The worktree's actual HEAD branch at completion (see SessionLiveState.worktreeBranch); lets
   *  the server flag / offer "Adopt" for a session that finished on an in-worktree checkout -b branch. */
  worktreeBranch?: string;
}

/**
 * Control plane → runner response for POST /runner/sessions/:id/finalize. `keepCheckout`
 * tells the runner whether to preserve the session's isolated worktree checkout: kept for
 * Open resumable ends (idle-park / user-end / cancel), dropped when the session was completed
 * (including task-done) or deleted. A reopened Completed session can create a fresh checkout.
 */
export interface RunFinalizeResponse {
  ok: boolean;
  keepCheckout: boolean;
}

/** @deprecated Compatibility type alias; use {@link RunFinalizeRequest}. */
export type SessionCompleteRequest = RunFinalizeRequest;
/** @deprecated Compatibility type alias; use {@link RunFinalizeResponse}. */
export type SessionCompleteResponse = RunFinalizeResponse;

/** Runner → control plane: given the session ids of leftover worktree checkouts, ask which
 *  are safe to garbage-collect. Sent by the runner's startup worktree GC. */
export interface WorktreesRemovableRequest {
  ids: string[];
}

/** Control plane → runner: the subset of the queried ids whose checkout may be removed —
 *  a session that was completed or deleted, or is no longer a session at all.
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
  /** Absent only for an in-flight command issued by a pre-fence control plane. */
  operationId?: string;
  leaseOwner?: string;
  status: 'merged' | 'conflict' | 'error';
  mergedSha?: string;
  /** Exact source-branch tip replayed by this merge. Persisted so later worktree reports can
   *  detect new commits without relying on ancestry or patch-id equivalence. */
  sourceSha?: string;
  message?: string;
}

/**
 * Runner → control plane: the outcome of a {@link CommitCommand}. `committed` advanced the
 * branch (the worktree is now clean); `nochange` means there was nothing to commit; `error`
 * means the commit failed (no worktree, git error). `message` carries git's stderr.
 */
export interface SessionCommitResultRequest {
  /** Absent only for an in-flight command issued by a pre-fence control plane. */
  operationId?: string;
  leaseOwner?: string;
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
  /** Exact tip SHA of the effective worktree branch (see SessionLiveState.branchSha). */
  branchSha?: string;
  /** The worktree's actual current HEAD branch (see SessionLiveState.worktreeBranch). */
  worktreeBranch?: string;
}

export interface ArtifactResultRequest {
  requestId: string;
  status: 'uploaded' | 'missing' | 'error';
  attachmentId?: string;
  message?: string;
}

/**
 * Which field a session-search hit matched on. Ordered by how strong a signal it is when the
 * user is trying to re-find a session, which is exactly the order the server ranks by:
 * a title hit is almost always the one you meant; a hit buried in one message is the weakest.
 * `recent` is not a match at all — it tags the rows returned for an empty query, where the
 * palette doubles as a session switcher.
 */
export type SessionSearchMatchField =
  'id' | 'title' | 'prompt' | 'reply' | 'message' | 'branch' | 'agent' | 'task' | 'recent';

/** One row of GET /sessions/search. Deliberately thinner than a session-list row — the palette
 *  renders a title, a status glyph, an agent name and a snippet, and nothing else. */
export interface SessionSearchHit {
  id: string;
  title: string;
  /** @deprecated Raw runner status; retained as a wire-compatible alias of `runStatus`. */
  status: string;
  /** Raw runner/process status. */
  runStatus: string;
  /** @deprecated Combined lifecycle state; use `runState` + `lifecycleState`. */
  sessionState: SessionState;
  /** Execution outcome, independent of where the session is filed. */
  runState: SessionRunState;
  /** Canonical list membership, independent of the execution outcome. */
  lifecycleState: SessionLifecycleState;
  /** @deprecated Compatibility representation; use `lifecycleState`. */
  filingState: SessionFilingState;
  agent: { id: string; name: string } | null;
  runnerId: string | null;
  taskId: string | null;
  taskTitle: string | null;
  lastTurnAt: string | Date | null;
  createdAt: string | Date;
  /** Set when the session has been moved to Completed. */
  completedAt: string | Date | null;
  /** @deprecated Compatibility alias of `completedAt`. */
  archivedAt: string | Date | null;
  deletedAt: string | Date | null;
  /** Why the session ended. Not a run outcome — every deliberate end resolves to
   *  `runState=ENDED` — but carried so a result row can explain itself the same way the session
   *  list does, and so `deriveSessionRunState` can tell a stopped turn from an ended session. */
  endReason: string | null;
  matchField: SessionSearchMatchField;
  /** A whitespace-collapsed window around the match, or null for a `recent` row. Clients
   *  highlight by locating the query inside it — no offset is carried, since collapsing the
   *  whitespace would invalidate one anyway. */
  snippet: string | null;
}

/** GET /sessions/search. `contentSearched` is false when the query was too short to search
 *  conversation text (see CONTENT_MIN_CHARS), so the UI can say so rather than quietly
 *  returning metadata-only results. */
export interface SessionSearchResponse {
  q: string;
  contentSearched: boolean;
  hits: SessionSearchHit[];
}

/** One matching event from GET /sessions/:id/events/search — a place in the open transcript,
 *  which the client reaches by loading back to `seq`. */
export interface EventSearchHit {
  seq: number;
  /** The run_event type ('user' | 'assistant' | 'thinking' | 'tool_use' | 'tool_result' | …),
   *  so the row can show what kind of thing matched without re-deriving it from the snippet. */
  type: string;
  /** The tool's name for a tool_use/tool_result hit, null otherwise. */
  toolName: string | null;
  ts: string | Date;
  /** A whitespace-collapsed window around the match. Located by the client the same way the ⌘K
   *  palette does — by finding the query inside the finished snippet, not by a carried offset. */
  snippet: string;
}

/** GET /sessions/:id/events/search — find within one session, over its whole history rather
 *  than the tail the client happens to have loaded. */
export interface EventSearchResponse {
  q: string;
  /** Every match in the session, even when `hits` was capped — so the UI can say "showing 100
   *  of 240" instead of implying the list is everything. */
  total: number;
  /** Newest first: the matches nearest what the user is reading come first, and the tail of a
   *  long list is the part that gets cut. */
  hits: EventSearchHit[];
}
