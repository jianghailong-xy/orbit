// The wire contract shared by the control plane, the Go runner, the web app and the native
// clients.
//
// NOTE ON `agent*` NAMES. The entity formerly called Agent is now a Workspace (migration 0094):
// it names a machine and a checkout, and holds no prompt, tools or permission posture — the
// actor is the Session and the word `agent` belongs to it. Everything on the server, in the
// database and in the web app was renamed. THIS FILE WAS NOT, deliberately: these are the field
// names already baked into shipped iOS/macOS builds, browser tabs nobody reloaded and runners
// that have not self-updated. Renaming them here renames them on the wire, which is a hard break
// for every one of those. So `agentId`, `agent`, `agentName`, `agentIds` and `AgentExecConfig`
// stay, and the server serves both spellings (WorkspaceAliasInterceptor) until the field has
// rolled over. Read `agent*` here as "workspace, under its shipped name".
//
// `AgentProvider` is unrelated to either — it is the runtime (claude | codex | kimi | opencode).
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

/** What actually happens to an action the session's policy has not pre-approved. */
export type UnapprovedAction = 'ask' | 'deny' | 'allow';

/** Whether a runtime can put a human in the loop at all. */
export type ApprovalSupport = 'full' | 'partial' | 'none';

/**
 * What a session's permission mode MEANS on the runtime that actually runs it.
 *
 * A permission mode is the user's intent ("ask me before you act"), but only some runtimes can
 * honor it: Claude and Kimi can block on a human, OpenCode runs non-interactive, and Codex is
 * currently started with approvals off. Left underived, the same mode silently meant three
 * different things depending on the engine — including "you will be asked" resolving to "nothing
 * is ever asked, everything is allowed". This is the server's single answer to "what will this
 * session actually do", so clients can show it instead of implying the mode is universal.
 *
 * Optional on wire payloads: rolling servers/clients, and sessions on a custom (BYOK) provider
 * slug whose borrowed runtime cannot be resolved from the session row alone, simply omit it.
 */
export interface PermissionSemantics {
  /** The session's configured mode, echoed so a client can show intent vs. reality together. */
  mode: string;
  unapproved: UnapprovedAction;
  approvalSupport: ApprovalSupport;
  /** False when the runtime cannot deliver what the mode asks for. */
  honored: boolean;
  /** Why, whenever the guarantee is not the plain reading of the mode. */
  note?: string;
  /**
   * `note` compressed to a clause that fits on a picker row, e.g. "not enforced here, everything
   * is allowed". Present exactly when `honored` is false. Carried here rather than rebuilt from
   * `honored`/`unapproved` at each render site: a caller that re-derives the wording is a caller
   * that can disagree with this table, which is how a Codex session came to be told it needed a
   * newer Claude model.
   */
  shortNote?: string;
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
  /** Provider reasoning effort/variant. Valid levels depend on the runtime model. */
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
  /** Version-bound process capability used only for EXECUTABLE v2 admission. Omission is the
   *  deployed N-1 runner and can execute legacy plans, but must be rejected for a v2 plan. */
  executableAcceptance?: ExecutableAcceptanceCapability;
  /** Stable identity of this runner process. Together with supervisedSessionIds,
   *  fences cold supervisors left behind by an overlapping old process. */
  leaseOwner?: string;
  /** Every session currently registered in this process's local supervisor pool,
   *  including cold sessions that do not poll an inbox. */
  supervisedSessionIds?: string[];
  /** This process has begun draining (self-update or shutdown) and will not execute
   *  heartbeat-delivered Git operations any more. The control plane must not claim
   *  merge/commit requests for it: a claim it cannot run would fence the session
   *  until the staleness backstop expires. Absent on older runners. */
  draining?: boolean;
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
  /** What the runner found at each agent working directory it was asked about last heartbeat
   *  (see RunnerHeartbeatResponse.agentDirs). Absent on older runners, which leaves the stored
   *  snapshot alone — "never probed" and "probed, missing" have to stay distinguishable. */
  agentDirProbes?: AgentDirProbe[];
  /** State of the shared checkouts this machine's agents work in. Absent on older runners,
   *  which leaves the stored snapshot alone rather than claiming every checkout is clean. */
  repos?: RunnerRepoHealth[];
  /** Whether this runner process is running as root. Reported because it removes a permission
   *  mode: Claude Code refuses Bypass under root and exits before its first message (see
   *  ROOT_REFUSED_PERMISSION_MODES). Absent on older runners, which are left unrestricted —
   *  an unknown must not withdraw a mode that works. */
  runsAsRoot?: boolean;
  /** Root directory this machine clones repositories into: a clone of `<owner>/<repo>` lands at
   *  `<reposRoot>/<owner>-<repo>`. Absent on older runners, which leaves the stored value NULL —
   *  and a machine with no reported root is not offered as a clone target at all, rather than
   *  having one guessed for it. */
  reposRoot?: string;
}

export interface ExecutableAcceptanceCapability {
  schemaRevision: number;
  capabilityRevision: number;
  hardMaxSeconds: number;
  /** Exact release/source identity of the process advertising the hard maximum. */
  runnerSha: string;
}

/** What the runner saw at one agent's working directory. Reported from the runner's own disk,
 *  so it answers the question the config form asks: does this path exist on that machine, and
 *  can it be worktree-isolated as-is? */
export interface AgentDirProbe {
  agentId: string;
  /** The path resolves to a directory on the runner. */
  exists: boolean;
  /** That directory is inside a git work tree — the precondition for worktree isolation.
   *  Only meaningful when `exists`. */
  isGitRepo: boolean;
  /** Free bytes on the filesystem holding this directory, as available to an unprivileged
   *  writer. Reported per working directory rather than per machine because one runner's
   *  agents can sit on different mounts, and the only number that can gate a run is the one
   *  for the filesystem that run will actually write to.
   *
   *  Absent when the runner is too old to report it, the path is missing, or the platform has
   *  no answer (Windows). Absent means "unknown", never "full": a gate must not fire on a
   *  runner that simply cannot say. */
  freeBytes?: number;
  /** Total bytes of that same filesystem, for rendering a used-percentage. Same absence rules. */
  totalBytes?: number;
}

/** Control plane → runner: the agent working directories to stat before the next heartbeat.
 *  Sent every heartbeat (the set changes whenever an agent is added or its path edited), so
 *  the runner never has to track the agent list itself. */
export interface AgentDirTarget {
  agentId: string;
  workDir: string;
}

/** One shared checkout's working-tree state on a runner. Session worktrees are isolated; the
 *  checkout they all fork from and merge back into is not — agents step into it for builds, and
 *  `git stash` is repo-global — so a half-finished merge left there blocks every merge on the
 *  machine. Reported each heartbeat so the UI can say that once, instead of letting every session
 *  fail separately with what looks like its own problem. */
export interface RunnerRepoHealth {
  /** Absolute path of the repo root (`git rev-parse --show-toplevel`). */
  root: string;
  /** The checkout's current branch; absent when HEAD is detached (normal mid-rebase). */
  branch?: string;
  /** 'clean' | 'dirty' | 'unmerged' | 'merge' | 'rebase' | 'cherry-pick' | 'revert'. Anything
   *  past 'dirty' is a half-finished operation that blocks merges into this checkout — a merely
   *  dirty checkout still fast-forwards fine (git refuses only the files it would overwrite). */
  state: string;
  /** The tracked files in the way, conflicted ones first (capped by the runner). */
  paths?: string[];
  /** Agents whose workDir sits in this checkout, so the UI can attach the warning to the agent
   *  on screen without re-deriving repo roots from paths. */
  agentIds?: string[];
}

/** Control plane → runner: repair the shared checkout at `root` — save whatever it is holding to
 *  an `orbit/rescue-*` branch, then return it to HEAD. Redelivered every heartbeat until the
 *  runner reports an outcome. The runner re-validates `root` against its own agents' workDirs. */
export interface RepoCleanupCommand {
  root: string;
  /** When the user asked, echoed back for log correlation. */
  requestedAt?: string;
}

/** Runner → control plane: how the repair went, and where the checkout's old content lives now. */
export interface RunnerRepoCleanupResult {
  root: string;
  status: 'done' | 'failed';
  /** The checkout's state afterwards (same vocabulary as RunnerRepoHealth.state), so the stored
   *  snapshot is corrected immediately instead of waiting for the runner's next scan. */
  state?: string;
  /** Branch holding the working tree exactly as it was before the repair; absent when there was
   *  nothing to keep. Orbit never deletes it. */
  rescueBranch?: string;
  message?: string;
}

/** Control plane → runner: clone `repoUrl` onto this machine for the workspace waiting on it.
 *
 *  No path travels with it: the checkout lands at `<reposRoot>/<owner>-<repo>`, derived by the
 *  runner from the URL, because the repos root is that machine's own fact. No credential travels
 *  with it either — the clone runs with whatever git credentials the machine already has (ssh key,
 *  credential helper, gh auth), and Orbit stores no token to send.
 *
 *  Redelivered every heartbeat until the control plane records an outcome. Acting on it twice is
 *  safe: the second run finds a checkout of this same remote where it would have cloned, and
 *  reports it reused. */
export interface CloneCommand {
  workspaceId: string;
  repoUrl: string;
  /** When the user asked, echoed back for log correlation. */
  requestedAt?: string;
}

/** Runner → control plane: how the clone went (POST /runner/clone-result).
 *
 *  `path` and `defaultBranch` are what the workspace is then configured from — reported rather
 *  than assumed, since the control plane chose neither. */
export interface RunnerCloneResult {
  workspaceId: string;
  status: 'done' | 'failed';
  /** Where the checkout actually is. */
  path?: string;
  /** The remote's own default branch, read from what the clone recorded for it. Absent for a
   *  repository with no commits yet, which has no default branch to report. */
  defaultBranch?: string;
  /** The directory already held a checkout of this same remote, so nothing was cloned. */
  reused?: boolean;
  /** Git's own stderr, byte for byte. Never parsed, summarized or rewritten anywhere between the
   *  machine and the screen: the runner is the only thing that can see this machine's credentials
   *  and network, and a translation of git's message is the layer that eventually explains the
   *  wrong problem. Absent for a failure git never saw (an unusable URL, an unwritable repos
   *  root) — `message` carries those, plus what is in the way when the directory is occupied. */
  stderr?: string;
  message?: string;
}

/** One supervised session's live worktree diff (cf. TurnCompleteRequest, which carries
 *  the same snapshot at turn boundaries). */
export interface SessionLiveState {
  sessionId: string;
  /** What the runner did: 'worktree' | 'shared-nogit'. */
  isolationStatus: string;
  /** The healed base commit used to compute `changedFiles`. Persisted with that snapshot so the
   *  control plane never pairs a post-rebase diff with the session's stale fork point. Absent
   *  from older runners. */
  baseSha?: string;
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
  /** Agent working directories to stat before the next heartbeat, answered via
   *  RunnerHeartbeatRequest.agentDirProbes. Absent on older control planes (the runner then
   *  probes nothing and the form simply shows no path status). */
  agentDirs?: AgentDirTarget[];
  /** A checkout repair the user started after seeing it reported wedged. Absent on older control
   *  planes, and whenever no repair is in flight for this runner. */
  repoCleanupRequest?: RepoCleanupCommand;
  /** Repositories to clone on this machine, one per workspace created from a git URL that is
   *  still waiting for its checkout. Absent on older control planes (an older runner ignores the
   *  field → the workspace stays CLONING until its runner is upgraded). */
  cloneRequests?: CloneCommand[];
}

/** Engines a runner signs in with on its own machine, rather than using a configured API key. */
export type LoginEngine = 'claude' | 'codex' | 'kimi';

/**
 * Every engine CLI a runner reports on, which is a wider set than the ones it can sign into:
 * OpenCode authenticates per-provider with no relayable flow, so it is never a sign-in row — but
 * it is installed on the machine, it is updated by the same daily pass, and its version drifts
 * like any other. Which of these a given page offers to sign in is that page's question.
 */
export type ReportedEngine = LoginEngine | 'opencode';

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
  engine: ReportedEngine;
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
 * but "is this machine still being kept current" — which the runner answers by asking each
 * engine's release feed what is published and comparing it against the binary on disk.
 */
export interface RunnerEngineUpdate {
  /** `updated` — a newer version actually landed on this machine.
   *  `checked` — Orbit asked and there was nothing to fetch.
   *  `failed` — it ran and errored; `message` is the machine's own words.
   *  `skipped` — Orbit deliberately won't touch this install; `message` says why.
   *  `ok` is the pre-split value, still sent by runners that haven't self-updated yet.
   *
   *  `updated` and `checked` were one word until finding nothing to do was taken as proof the
   *  update path works. It isn't: a machine that can no longer download anything answers
   *  "nothing to fetch" on every day no release ships, and reads healthy right up until one does. */
  status: 'updated' | 'checked' | 'failed' | 'skipped' | 'ok';
  /** ISO time of the attempt this describes. */
  at: string;
  /** ISO time of the last attempt that succeeded, kept across later failures. Absent if one
   *  never has — which is a louder fact than a recent failure, not a quieter one. */
  okAt?: string;
  /** ISO time a newer version last actually landed. Unlike `okAt`, a pass that found nothing to
   *  do cannot set it. */
  updatedAt?: string;
  /** Newest version the runner could see published. Absent until one probe succeeds. */
  latest?: string;
  /** ISO time this machine was first seen behind `latest`, cleared the moment it catches up.
   *
   *  The alarm is built on this rather than on `okAt`, because it is the only reading taken on
   *  the binary itself: an engine drifts whether its updater errors nightly, is skipped every
   *  pass for being busy, or exits 0 while writing to a copy nothing execs. */
  behindSince?: string;
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
  /** The commit the session's branch forked from (`session.baseSha`), so the runner replays
   *  only the session's own commits onto the target instead of everything the branch carries
   *  ahead of it. The runner keeps this in a local ref while the checkout is alive, but drops
   *  it when the checkout is torn down — which is exactly when most merges are requested, so
   *  the record has to come from here. Absent → the runner replays `<target>..<branch>` as
   *  before. */
  baseSha?: string;
  /** `[K6]` §7: the commit the task's accepted checkpoint verified. When set, the runner refuses to
   *  merge a branch whose tip is anything else (`BRANCH_TIP_MISMATCH`) — the commits after a
   *  verified one carry no test evidence. Absent for work that is not under convergence
   *  management, which is almost every merge; the tip is then whatever the branch says. */
  requiredSourceSha?: string;
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
  /** How many spawn links sit above this session (a root is 0), injected as
   *  ORBIT_SPAWN_DEPTH. `orbit mcp` halves its session_create(wait) budget per level so a
   *  nested wait always finishes inside the wait that is waiting on it. */
  spawnDepth?: number;
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

/** A claude permission rule for "same kind" calls, so future ones are auto-allowed by
 *  claude's own engine without re-prompting. `toolName` is the gated tool (e.g. "Bash",
 *  "Edit"); `ruleContent` narrows it (Bash uses a command prefix like "git commit:*") —
 *  omit it to allow every call to that tool. The runner wraps this into claude's
 *  updatedPermissions for the running session, and the control plane stores it on the
 *  session's workspace so its other sessions start with it too. */
export interface PermissionRule {
  toolName: string;
  ruleContent?: string;
}

/** A standing "always allow" grant on a workspace: a rule someone approved once, now
 *  applied to every session of that workspace instead of dying with the one it was
 *  granted in. Listed and revoked through /workspaces/:id/permission-rules. */
export interface WorkspacePermissionRuleInfo {
  id: string;
  toolName: string;
  /** '' means every call to that tool (never null — see the stored column). */
  ruleContent: string;
  createdAt: string;
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
// permission-mode / effort / provider changed, so it should re-spawn claude with --resume
// + the new flags (full context preserved). The new config rides in the turn's `content`
// JSON. It is reserved for the SPAWN-ONLY half of a config change — a provider is a
// process-construction fact (its environment), so the only way to apply one is to build a
// new process.
// 'setconfig' is the other half: model, permission mode and reasoning effort are things a
// resident engine can be told, so this asks the runner to say them over the live session
// instead of tearing it down. Same payload shape, minus the spawn-only fields — and its
// `effort` is present only when the PATCH moved it, because a session with none of its own
// runs on its workspace's, so the committed value is not what the engine was built with.
// It is deliverable mid-turn for the same reason interrupt is — nothing about it needs the
// engine to be idle — and like reload it occupies no in-flight slot. When one PATCH moves
// both halves the server queues both, setconfig first, so the re-spawn that follows carries
// every new flag rather than re-doing what the control frame just did. Filed for the claude
// runtime alone: the other runtimes' session loops have no arm for the kind (codex and
// kimi are driven over ACP/JSON-RPC, opencode runs one process per turn), so one sent
// there would be acked on delivery and applied by nobody. They keep the reload, effort
// included.
// 'diff' is a fire-and-forget control turn (no text, no claude): it asks the runner to
// recompute the live worktree diff and push it back, so an opened file's diff reflects
// the current worktree even when the stored snapshot lagged (the heartbeat refreshes the
// file list but not the patch text — see SessionDiffResultRequest).
// 'steer' is a user message written into the turn that is ALREADY running, instead of
// queued behind its result. The kind is derived by the server, never sent by a client:
// createTurn files a message as a steer exactly when an executable turn is in flight, so
// every entry point (web, native, MCP, CLI) gets the behaviour without deciding anything.
// It is deliberately its own kind rather than a relaxation of the message gate — a steer
// neither occupies the single in-flight slot nor waits for it, and it settles its own turn
// on the engine's echo rather than on a `result`, which belongs to the turn it joined.
export type ConversationTurnKind =
  | 'message'
  | 'interrupt'
  | 'end'
  | 'reload'
  | 'setconfig'
  | 'shell'
  | 'diff'
  | 'steer';

/** What a routing-v1 sender wants a message to do. Omission retains the installed N-1
 * server-side auto-steer/queue protocol; new clients always send one explicit value. */
export type SessionTurnIntent = 'CURRENT_WORK' | 'NEXT_TURN';
export type SessionTurnPlacement = 'accepted' | 'steer' | 'queued';

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
  /** CURRENT_WORK may only join a live, steerable message turn. NEXT_TURN is independently
   * executable. Omission retains N-1 auto-routing. */
  intent?: SessionTurnIntent;
  /** Ids of pre-uploaded image attachments (`POST /api/attachments`) to send with this
   *  turn. Only the ids travel here — the bytes already live in the control plane.
   *  Omitted/empty keeps the turn text-only. */
  attachmentIds?: string[];
}

/**
 * Browser → control plane: stop the turn a live session is running, and — when a
 * follow-up is included — queue what to do instead, in the same transaction.
 *
 * The two halves are one request because they are one decision. Interrupting drops the
 * follow-ups queued behind the running turn (stopping means stop), so a client that
 * interrupted and then sent would be racing its own delete: whether the redirection
 * survived would depend on which request the server saw first. Sent together, the message
 * is filed after that delete and cannot be its casualty.
 *
 * It is filed as an ordinary message, never a steer. A steer is written INTO the turn that
 * is running — the opposite of what someone who just pressed stop is asking for — so the
 * follow-up waits behind the interrupted turn's result and is delivered as the next turn.
 * That ordering is also what happens if the interrupt does not take: the message is never
 * folded into the turn it was meant to replace, it simply waits for that turn to end.
 */
export interface RunInterruptRequest {
  /** Client-supplied idempotency key (UUID) for the follow-up message; also keys the
   *  interrupt itself, so a retried request re-files neither. Required with `content`. */
  clientTurnId?: string;
  /** What to send once the current turn has stopped. Omitted → a plain interrupt. */
  content?: string;
  /** Ids of pre-uploaded attachments (`POST /api/attachments`) for the follow-up. */
  attachmentIds?: string[];
}

/** Control plane → browser: the interrupt was accepted, and the turn the follow-up (if
 *  any) was queued as. The runner reports whether the engine actually stopped, as an
 *  `interrupt` transcript event — accepting the request is not the same as the turn
 *  having stopped, and only the engine's own answer settles that. */
export interface RunInterruptResponse {
  ok: true;
  /** Present only when the request carried a follow-up. */
  turnId?: string;
  seq?: number;
}

/**
 * Control plane → runner: the next turn to feed the live `claude` process, returned
 * by the per-session inbox long-poll. `turnId === ''` means "nothing available"
 * (mirrors the empty-id convention of the session claim poll).
 */
export interface RunInboxResponse {
  turnId: string;
  /** Exact executable turn this steer is allowed to join. Present for CURRENT_WORK only. */
  targetTurnId?: string;
  seq: number;
  kind: ConversationTurnKind;
  content?: string;
  /** Image attachments for this (message) turn. The runner fetches each blob via the
   *  runner-scoped `GET /runner/sessions/:id/attachments/:attId`, base64-encodes it, and
   *  adds an `image` content block alongside the text. Omitted for text-only/control turns. */
  attachments?: TurnAttachment[];
  /** The process environment to re-spawn the engine with, present only on a `reload` that moved
   *  the session to another provider on the same runtime. It carries the new provider's decrypted
   *  key, so it is resolved here at delivery — the queued turn stores the provider's slug and
   *  nothing else, keeping the credential out of `conversation_turn`. */
  env?: Record<string, string>;
  /** Only on a `steer`: this control plane understands `steer_requeue`, so a steer the runner
   *  can PROVE never reached the engine may be filed back as the ordinary message it would have
   *  been had it arrived a moment later (see TURN_COMPLETE_STEER_REQUEUE).
   *
   *  Carried on the delivery itself rather than asked for separately: the answer is needed
   *  exactly once, at the moment a steer is being answered for, and a runner that stored it
   *  globally would have to decide what a mixed fleet of control planes means. Absent — an
   *  older control plane — is `false` in every language here, and a runner that reads false
   *  must fail the steer visibly instead: that control plane's turn-complete does not read
   *  `subtype`, so a `steer_requeue` sent to it would ack the row and lose the message. */
  steerRequeue?: boolean;
  /** True only for the server-generated shell turn that runs this task's one L0 acceptance
   *  command. The runner must execute it synchronously even when the command ends in `&`, because
   *  only a completed process has an exit code the control plane can compare. */
  taskAcceptance?: boolean;
  /** Present only after a v2 plan has been ADMITTED. A rejected plan is never delivered. */
  acceptancePlan?: ExecutableAcceptanceDispatchPlan;
}

export interface ExecutableAcceptanceDispatchPlan {
  admissionId: string;
  evaluationPlanDigest: string;
  commandDigest: string;
  expectedExitCode: number;
  requestedTimeoutSeconds: number;
  effectiveTimeoutSeconds: number;
  effectiveDeadline: string;
  requiredSchemaRevision: number;
  requiredCapabilityRevision: number;
}

export type ExecutableAttemptTerminationKind =
  | 'EXITED'
  | 'TIMED_OUT'
  | 'CANCELLED'
  | 'SIGNALED'
  | 'START_FAILED'
  | 'INFRASTRUCTURE_LOST';

export interface ExecutableAttemptStartResponse {
  attemptId: string;
  deadlineAt: string;
  attemptNumber: number;
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
  /** Present for a completed shell turn. The control plane consults it only for a
   *  server-generated taskAcceptance delivery. */
  shellExitCode?: number;
  /** The shell's combined stdout/stderr, untrimmed. An empty string is a real raw output and is
   *  therefore distinct from omission by older runners. */
  shellOutput?: string;
  /** Typed v2 result. All fields are bound to the admission/start handshake; shellExitCode is
   *  retained only for legacy/N-1 turns. */
  acceptanceAdmissionId?: string;
  acceptanceAttemptId?: string;
  acceptanceTerminationKind?: ExecutableAttemptTerminationKind;
  acceptanceActualExitCode?: number;
  acceptanceSignal?: string;
  acceptanceOutputTruncated?: boolean;
  /** The engine's own result subtype, except for the two the runner uses to say what KIND of
   *  completion this is: `steer` settles one mid-turn message, and TURN_COMPLETE_STEER_REQUEUE
   *  un-files one. */
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
  /** The healed base commit used for this live diff snapshot. If a legacy Go encoder omits an
   *  empty `changedFiles` slice, its presence still denotes a newly computed clean snapshot. */
  baseSha?: string;
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

/**
 * `TurnCompleteRequest.subtype` for a steer the runner PROVED never reached the engine: Codex
 * refused it before reading the input (no turn to steer, a turn id that had already moved on, a
 * build with no `turn/steer` at all), or it was never sent. The row goes back to being the
 * ordinary `message` it would have been had it arrived a moment later — same row, same seq, same
 * clientTurnId; the kind is the only thing that was ever about timing — and runs when the turn it
 * missed ends.
 *
 * Reserved for PROVABLY undelivered. An unknown outcome (a timeout, an unrecognised refusal, an
 * accepted steer that was never echoed back) must be reported as a failure instead: Codex does not
 * de-duplicate, so re-filing a message it may already have taken is how one prompt gets executed
 * twice. See docs/codex-turn-steer-contract.md §4.3.
 */
export const TURN_COMPLETE_STEER_REQUEUE = 'steer_requeue';

/**
 * One mid-turn message that was leased by a runner process which then died holding it.
 *
 * Whether it reached the engine is not knowable from here, and re-delivering it could execute
 * it twice, so it is not re-filed — it is handed to the process taking the session over, which
 * reports it as undelivered on the session's own event stream (the one place a person reads) and
 * then settles the row.
 */
export interface AbandonedSteer {
  turnId: string;
  /** The message text, so the reporter can render a bubble for one that never got as far as
   *  producing its own `user` event. */
  content: string;
  /** Whether this steer already has a `user` event in the transcript. False means the dead
   *  process never got to announce it, so the report has to open the bubble as well as settle
   *  it; true means the bubble is already there and only needs amending, and emitting a second
   *  one would show the same message twice. */
  announced: boolean;
}

/** Control plane → runner response for POST /runner/sessions/:id/activate-leases. */
export interface ActivateTurnLeasesResponse {
  ok: true;
  /** Steers stranded by the process this activation replaces. Reported, not settled, here: the
   *  activation is retried on transport errors, so a response nobody received must leave the
   *  rows exactly as they were for the next attempt to hand over again. The taking-over runner
   *  settles each one with `subtype: 'steer'` once it has said so on the event stream. */
  abandonedSteers?: AbandonedSteer[];
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
 * carries git's stderr / the precondition for the UI. `released` is the one status that is
 * not an outcome: the runner drained before touching the repo, so the request goes back to
 * unclaimed and the successor process performs it.
 */
export interface SessionMergeResultRequest {
  /** Absent only for an in-flight command issued by a pre-fence control plane. */
  operationId?: string;
  leaseOwner?: string;
  status: 'merged' | 'conflict' | 'error' | 'released';
  mergedSha?: string;
  /** Exact source-branch tip replayed by this merge. Persisted so later worktree reports can
   *  detect new commits without relying on ancestry or patch-id equivalence. */
  sourceSha?: string;
  /** `[K6]` §7: the target already contained `sourceSha`, so this merge moved nothing —
   *  `targetShaBefore` and `mergedSha` are the same commit and no rebase ran. A flag rather than a
   *  fifth `status` value on purpose: `status` is validated against a closed set, so a new value
   *  would be rejected by an older control plane and the runner would report a completed merge
   *  forever. An older control plane ignores this and records `MERGED`, which is true; a current
   *  one records §13.7 MR2's `ALREADY_MERGED`, which keeps "the target moved" and "it was already
   *  there" different facts. */
  alreadyMerged?: boolean;
  /** The branch this merge advanced, the tip it had before, and the base the source was replayed
   *  onto. Together with `sourceSha`/`mergedSha` they are what makes the merge RECEIPT the control
   *  plane records (§13.5) checkable against the repository afterwards. Omitted by older runners:
   *  the receipt is still written, naming what it knows. */
  targetBranch?: string;
  targetShaBefore?: string;
  rebaseBaseSha?: string;
  /** Paths git reported as conflicting, for `status: 'conflict'`. */
  conflicts?: string[];
  message?: string;
}

/**
 * Runner → control plane: the outcome of a {@link CommitCommand}. `committed` advanced the
 * branch (the worktree is now clean); `nochange` means there was nothing to commit; `error`
 * means the commit failed (no worktree, git error). `message` carries git's stderr.
 * `released` is the one status that is not an outcome: the runner drained before touching
 * the repo, so the request goes back to unclaimed and the successor process performs it.
 */
export interface SessionCommitResultRequest {
  /** Absent only for an in-flight command issued by a pre-fence control plane. */
  operationId?: string;
  leaseOwner?: string;
  status: 'committed' | 'nochange' | 'error' | 'released';
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
  /** The healed base commit used for this recomputed diff snapshot. If a legacy Go encoder omits
   *  an empty `changedFiles` slice, its presence still denotes a newly computed clean snapshot. */
  baseSha?: string;
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
  /** Every session the query matched, even when `hits` was capped — the palette has no paging, so
   *  without this a query whose matches overflow one page is indistinguishable from one that found
   *  exactly a page's worth. On an empty query (recents) it is simply `hits.length`. */
  total: number;
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
  /** A whitespace-collapsed window around the match — around the whole phrase where the event
   *  contains it, and around the query's longest word otherwise, since a hit only has to mention
   *  every word. What to mark is found by the client inside the finished snippet, the same way the
   *  ⌘K palette does: collapsing shifts every position, so no offset can be carried. */
  snippet: string;
}

/** GET /sessions/:id/events/search — find within one session, over its whole history rather
 *  than the tail the client happens to have loaded. */
export interface EventSearchResponse {
  q: string;
  /** Every match in the session, even when `hits` was capped — so the UI can say "showing 100
   *  of 240" instead of implying the list is everything. Exact unless `totalCapped`. */
  total: number;
  /** Set when counting stopped at its ceiling rather than reaching the end: `total` is then a
   *  floor, to be shown as "1000+". Counting the rest cannot stop early and costs a full scan of
   *  the session — 9s on the largest one here — for a label that says the same thing either way. */
  totalCapped?: boolean;
  /** Newest first: the matches nearest what the user is reading come first, and the tail of a
   *  long list is the part that gets cut. */
  hits: EventSearchHit[];
}
