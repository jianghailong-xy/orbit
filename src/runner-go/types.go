package main

// Wire DTOs — JSON tags mirror @orbit/shared exactly (camelCase). The control
// plane's ValidationPipe passes these plain objects through unchanged.

type DeviceStartRequest struct {
	Name          string   `json:"name"` // the runner (machine) name; defaults to the hostname
	Hostname      string   `json:"hostname,omitempty"`
	Labels        []string `json:"labels"`
	MaxConcurrent int      `json:"maxConcurrent"`
	Version       string   `json:"version,omitempty"`
	// Default project directory; agents (registered separately) run their engine here.
	WorkDir string `json:"workDir,omitempty"`
}

type DeviceStartResponse struct {
	DeviceCode string `json:"deviceCode"`
	UserCode   string `json:"userCode"`
	Interval   int    `json:"interval"`
	ExpiresIn  int    `json:"expiresIn"`
}

type DevicePollResponse struct {
	Status      string `json:"status"`
	RunnerID    string `json:"runnerId"`
	RunnerToken string `json:"runnerToken"`
	Name        string `json:"name"` // the runner (machine) name
}

type RegisterRequest struct {
	EnrollmentToken string   `json:"enrollmentToken"`
	Name            string   `json:"name"` // the runner (machine) name; defaults to the hostname
	Hostname        string   `json:"hostname,omitempty"`
	Labels          []string `json:"labels"`
	MaxConcurrent   int      `json:"maxConcurrent"`
	Version         string   `json:"version,omitempty"`
	// Default project directory; agents (registered separately) run their engine here.
	WorkDir string `json:"workDir,omitempty"`
}

type RegisterResponse struct {
	RunnerID    string `json:"runnerId"`
	RunnerToken string `json:"runnerToken"`
	Name        string `json:"name"` // the runner (machine) name
}

type HeartbeatRequest struct {
	Status       string `json:"status"`
	IdleCapacity int    `json:"idleCapacity"`
	Version      string `json:"version,omitempty"`
	// LeaseOwner identifies this exact runner process. SupervisedSessionIDs lets
	// the control plane detach cold supervisors that no longer own their session;
	// older runners omit both fields and retain the legacy heartbeat behavior.
	LeaseOwner           string   `json:"leaseOwner,omitempty"`
	SupervisedSessionIDs []string `json:"supervisedSessionIds,omitempty"`
	// Draining marks a process that keeps heartbeating (so the reaper spares its
	// sessions) but no longer dispatches heartbeat-delivered git work. The control
	// plane stops claiming merge/commit requests for it; they wait for the successor.
	Draining bool `json:"draining,omitempty"`
	// Slash assets discovered on this machine, surfaced to the web composer for
	// `/` autocomplete. Empty slices are omitted so quiet heartbeats stay small.
	Commands []SlashCommandInfo `json:"commands,omitempty"`
	Skills   []SlashCommandInfo `json:"skills,omitempty"`
	// Provider quota for the accounts this runner uses (Claude `/usage` and/or Codex
	// app-server rate limits). Nil when unavailable — never blocks or fails heartbeat.
	PlanUsage *PlanUsage `json:"planUsage,omitempty"`
	// Runtime model catalog for picker UIs. Nil on old runners / unavailable runtimes.
	ModelCatalog *ModelCatalog `json:"modelCatalog,omitempty"`
	// Per-engine health on this machine (installed / version / signed in), so the web can show
	// and fix this runner's logins. Nil until the first probe completes — an omitted field
	// leaves the server's last snapshot alone rather than claiming three unknowns.
	Engines []EngineHealthReport `json:"engines,omitempty"`
	// Effective default selected by each runtime on this machine. A non-nil empty map is sent as
	// `{}` so the control plane can retire a previously reported default and fall back to the
	// runtime catalog; nil is used only before the first probe completes.
	RuntimeDefaultModels map[string]string `json:"runtimeDefaultModels"`
	// Sessions carries each running session's live worktree diff so the web status bar
	// appears mid-turn, not just at turn-complete. Empty when no isolated session runs.
	Sessions []SessionLiveState `json:"sessions,omitempty"`
	// AgentDirProbes answers the previous heartbeat's AgentDirs: what this machine actually
	// has at each agent working directory. Omitted until the first scan completes, so the
	// control plane keeps its last snapshot instead of hearing a false "missing".
	AgentDirProbes []AgentDirProbe `json:"agentDirProbes,omitempty"`
	// Repos is the state of the shared checkouts this machine's agents work in (see
	// RepoHealthReport). Nil until the first scan completes — an omitted field leaves the
	// server's last snapshot alone rather than claiming every checkout is clean.
	Repos []RepoHealthReport `json:"repos,omitempty"`
	// ReposRoot is the directory a clone of <owner>/<repo> lands under on this machine, as
	// <reposRoot>/<owner>-<repo>. Omitted when this account has no resolvable home, which the
	// control plane reads as "no root reported" and answers by not offering this machine as a
	// clone target — never by inventing a path to write a checkout to.
	ReposRoot string `json:"reposRoot,omitempty"`
	// RunsAsRoot reports whether this process is root, which costs the machine one permission
	// mode: claude refuses Bypass under root ("--dangerously-skip-permissions cannot be used with
	// root/sudo privileges") and exits before its first stream-json message, so a session asking
	// for it here can only ever fail. A pointer so `false` is still sent — the control plane's
	// NULL means "not reported", and a non-root runner has to be able to say so.
	RunsAsRoot *bool `json:"runsAsRoot,omitempty"`
}

// AgentDirProbe is what the runner found at one agent's working directory: whether the path is
// a directory on this machine, and whether it sits inside a git work tree (the precondition for
// per-session worktree isolation). Mirrors @orbit/shared AgentDirProbe.
type AgentDirProbe struct {
	AgentID   string `json:"agentId"`
	Exists    bool   `json:"exists"`
	IsGitRepo bool   `json:"isGitRepo"`
	// Free/total bytes of the filesystem holding WorkDir. Per directory, not per machine: one
	// runner's agents can sit on different mounts, and the only figure that can gate a run is
	// the one for the filesystem it will actually write to. Omitted when the path is missing or
	// the platform has no answer — the control plane reads absence as "unknown", never "full".
	FreeBytes  *uint64 `json:"freeBytes,omitempty"`
	TotalBytes *uint64 `json:"totalBytes,omitempty"`
}

// AgentDirTarget is one directory the control plane asked this runner to stat.
type AgentDirTarget struct {
	AgentID string `json:"agentId"`
	WorkDir string `json:"workDir"`
}

// EngineHealthReport mirrors @orbit/shared RunnerEngineHealth: one coding-engine CLI's state on
// this machine, from the same probe `orbit doctor` prints. Auth is a word, not a bool, because
// some CLIs won't answer — and an engine that won't say must never be shown as signed in.
type EngineHealthReport struct {
	Engine    string `json:"engine"`
	Installed bool   `json:"installed"`
	Version   string `json:"version,omitempty"`
	Auth      string `json:"auth"` // "yes" | "no" | "unknown"
	// What the updater last did to this engine. Nil until it has run once — which the UI shows
	// as "not reported yet", never as a problem.
	Update *EngineUpdateReport `json:"update,omitempty"`
}

// EngineUpdateReport is the updater's last word on one engine, carried alongside that engine's
// health so the Providers page can answer "is this being kept current?" without a button.
//
// Kept on the runner's own disk (see engineUpdateLog) rather than derived at report time: it
// survives a restart, and `orbit engine-update` — a different process from `orbit run` — writes
// the same record.
type EngineUpdateReport struct {
	// "updated" — a newer version actually landed on this machine.
	// "checked" — asked, and there was nothing to fetch.
	// "failed" — it ran and errored; Message is the machine's own words.
	// "skipped" — Orbit deliberately won't touch this install; Message says why.
	//
	// "updated" and "checked" used to be one word, "ok", on the reasoning that a no-op proves the
	// path works. It doesn't: finding nothing to fetch only proves the version check works, and a
	// machine that cannot download anything answers exactly that on every day no release happens
	// to ship. Workstation reported green for two days that way, and only turned red when 2.1.227
	// shipped and forced a real download — long after it had actually stopped being updatable.
	Status string `json:"status"`
	// RFC3339 time of the attempt this describes.
	At string `json:"at"`
	// RFC3339 time of the last attempt that succeeded, kept across later failures — the one
	// thing that separates "erroring right now" from "hasn't worked in weeks".
	OkAt string `json:"okAt,omitempty"`
	// RFC3339 time a newer version last actually landed. Unlike OkAt this cannot be set by a
	// pass that had nothing to do, so it is the honest answer to "does updating work here".
	UpdatedAt string `json:"updatedAt,omitempty"`
	// Newest published version this machine could see, from the release feed rather than from
	// the updater — a few kilobytes, asked before every update. Empty until one probe succeeds;
	// carried forward when a later one can't ask.
	Latest string `json:"latest,omitempty"`
	// RFC3339 time this machine was first seen behind Latest, cleared the moment it catches up.
	//
	// This is the measurement the alarm is built on, because it is the only one taken on the
	// binary itself: a machine drifts whether its updater errors nightly, is skipped for being
	// busy, or exits 0 while writing to a copy nothing execs. Exit codes tell those apart; none
	// of them tells you the CLI is three versions behind the models it is being handed.
	BehindSince string `json:"behindSince,omitempty"`
	Message     string `json:"message,omitempty"`
}

// SessionLiveState is one running session's live worktree state, reported each heartbeat
// while a turn is in flight (the uncommitted diff vs base, mirroring TurnCompleteRequest).
type SessionLiveState struct {
	SessionID       string        `json:"sessionId"`
	IsolationStatus string        `json:"isolationStatus"`
	ChangedFiles    []ChangedFile `json:"changedFiles"`
	// BaseSha is the healed fork point used for ChangedFiles. It is read only after the live
	// diff computation, which may advance a stale in-memory base after a rebase.
	BaseSha string `json:"baseSha,omitempty"`
	// BranchSha is the tip of the effective branch (the actual checked-out branch when one
	// exists, otherwise the session's recorded branch). The server uses it to distinguish a
	// branch that is unchanged since a successful merge from one that gained new commits.
	BranchSha string `json:"branchSha,omitempty"`
	// WorktreeDirty is the worktree's current `git status` (true → uncommitted changes). No
	// omitempty: a clean worktree must report false so the server flips the bar to Merge,
	// rather than dropping the field (which an older server reads as "not reported").
	WorktreeDirty bool `json:"worktreeDirty"`
	// MergeTargets is the repo's candidate merge-target branches (local heads minus orbit/*),
	// for the status bar's "Merge to…" dropdown. Omitted when none / not isolated.
	MergeTargets []string `json:"mergeTargets,omitempty"`
	// BranchMerged: the branch's work already landed in the default merge target (main, else
	// master) — either as an ancestor (fast-forward) or as patch-equivalent commits (a squash/rebase
	// merge under new SHAs). Drives the bar's "✓ In main" chip over a redundant Merge button. No
	// omitempty (false must be sent so the server can clear a stale true).
	BranchMerged bool `json:"branchMerged"`
	// WorktreeBranch is the worktree's ACTUAL current HEAD branch (git symbolic-ref). Normally
	// equals the session's tracked branch; it differs when the agent/user ran `git checkout -b`
	// inside the worktree, so the work now lives on a branch Orbit isn't tracking. The server
	// compares it to session.branch to flag divergence (and offer "Adopt"). Omitted when HEAD is
	// detached / the session isn't isolated → the server keeps its last value.
	WorktreeBranch string `json:"worktreeBranch,omitempty"`
}

// SlashCommandInfo mirrors @orbit/shared: one `/`-invocable asset (command or skill).
type SlashCommandInfo struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Type        string `json:"type,omitempty"` // "command" | "skill"
	// Provider scopes runtime-advertised commands. Empty is the historical
	// Claude/filesystem registry; Kimi ACP entries carry "kimi".
	Provider string `json:"provider,omitempty"`
	// AgentID scopes a project-level asset to the agent whose workDir it was found in;
	// empty means host-level (the runner's default dir or ~/.claude), shared by all agents.
	AgentID string `json:"agentId,omitempty"`
	// Builtin marks a name the Claude CLI registers itself (built-in skill, plugin skill,
	// namespaced command), learned from its init handshake rather than found on disk.
	// Composers list these after the user's own assets.
	Builtin bool `json:"builtin,omitempty"`
}

type ModelCatalog struct {
	Codex    []ModelInfo `json:"codex,omitempty"`
	Claude   []ModelInfo `json:"claude,omitempty"`
	Kimi     []ModelInfo `json:"kimi,omitempty"`
	OpenCode []ModelInfo `json:"opencode,omitempty"`
}

type ModelInfo struct {
	Value                 string   `json:"value"`
	Label                 string   `json:"label"`
	Priority              *int     `json:"priority,omitempty"`
	ContextWindow         int      `json:"contextWindow,omitempty"`
	ReasoningLevels       []string `json:"reasoningLevels,omitempty"`
	DefaultReasoningLevel string   `json:"defaultReasoningLevel,omitempty"`
	ServiceTiers          []string `json:"serviceTiers,omitempty"`
}

type HeartbeatResponse struct {
	CancelSessionIDs []string `json:"cancelSessionIds"`
	// LeaseLostSessionIDs is process-fence loss, not durable user cancellation.
	// The runner detaches the exact supervisor epoch advertised by this heartbeat;
	// a delayed response cannot cancel a replacement with the same session id.
	LeaseLostSessionIDs []string `json:"leaseLostSessionIds,omitempty"`
	// Server-authoritative max-concurrent (the editable DB value). 0 from an older
	// control plane that doesn't send it — the runner keeps its current value then.
	MaxConcurrent int `json:"maxConcurrent"`
	// Branch merges the user requested for sessions this runner ran: merge each one's
	// branch into the repo's main, then POST the outcome to /merge-result. Omitted by
	// older control planes (the field is simply absent → no merges).
	MergeRequests []MergeCommand `json:"mergeRequests,omitempty"`
	// Commits the user requested for live sessions: commit each one's uncommitted worktree
	// changes onto its branch, then POST the outcome to /commit-result. Omitted by older
	// control planes (absent → no commits).
	CommitRequests []CommitCommand `json:"commitRequests,omitempty"`
	// Legacy assistant artifacts to upload from this runner's per-session uploads dir.
	ArtifactRequests []ArtifactCommand `json:"artifactRequests,omitempty"`
	// An interactive `claude auth login` the user drove from the web: `start` to launch it (we
	// reply with the URL to approve), then `code` carrying what they pasted back. Nil on older
	// control planes, and whenever no sign-in is in flight for this runner.
	LoginRequest *LoginCommand `json:"loginRequest,omitempty"`
	// An engine CLI the user asked to install from the web. Nil on older control planes, and
	// whenever no install is in flight for this runner.
	InstallRequest *InstallCommand `json:"installRequest,omitempty"`
	// Agent working directories to stat before the next heartbeat; answered via
	// HeartbeatRequest.AgentDirProbes. Absent on older control planes → nothing to probe.
	AgentDirs []AgentDirTarget `json:"agentDirs,omitempty"`
	// A "clean up this checkout" the user asked for after seeing it reported wedged. Nil on older
	// control planes and whenever no repair is in flight. Redelivered until we report an outcome.
	RepoCleanupRequest *RepoCleanupCommand `json:"repoCleanupRequest,omitempty"`
	// Repositories to clone for workspaces the user created from a git URL, one per workspace
	// still waiting for its checkout. Redelivered every heartbeat until we report an outcome
	// (see CloneCommand). Absent on older control planes → nothing to clone.
	CloneRequests []CloneCommand `json:"cloneRequests,omitempty"`
}

// CloneCommand mirrors @orbit/shared: clone RepoURL onto this machine for WorkspaceID. The target
// path is not sent — it is <reposRoot>/<owner>-<repo>, derived here from the URL, because the
// repos root is this machine's fact. No credential travels with it either: the clone runs with
// whatever git credentials the machine already has, and Orbit stores no token to send.
//
// Redelivered every heartbeat until the control plane records an outcome, so acting on it must be
// idempotent — which it is: a second delivery lands on a directory that is already a checkout of
// this same remote, and is reported as reusable rather than cloned again.
type CloneCommand struct {
	WorkspaceID string `json:"workspaceId"`
	RepoURL     string `json:"repoUrl"`
	// RequestedAt is when the user asked, echoed back so a redelivery is recognizable in logs.
	RequestedAt string `json:"requestedAt,omitempty"`
}

// CloneResultRequest mirrors @orbit/shared RunnerCloneResult: how the clone went. Path and
// DefaultBranch are what the workspace is configured from; Stderr is git's own output, verbatim.
type CloneResultRequest struct {
	WorkspaceID string `json:"workspaceId"`
	Status      string `json:"status"` // "done" | "failed"
	// Path is where the checkout actually is — reported rather than assumed, since the control
	// plane never chose it.
	Path string `json:"path,omitempty"`
	// DefaultBranch is the remote's own default, which the workspace merges into. Empty for a
	// repository with no commits yet.
	DefaultBranch string `json:"defaultBranch,omitempty"`
	// Reused: the checkout was already on the disk, so nothing was cloned.
	Reused bool `json:"reused,omitempty"`
	// Stderr is git's message byte for byte, never parsed or rewritten. Empty for a failure git
	// never saw (an unusable URL, an unwritable repos root) — Message carries those.
	Stderr  string `json:"stderr,omitempty"`
	Message string `json:"message,omitempty"`
}

// RepoCleanupCommand mirrors @orbit/shared: repair the shared checkout at Root — rescue whatever
// it holds onto a branch, then return it to HEAD (see cleanupRepoRoot). Root is named by the
// control plane from what this runner itself reported, and re-validated here against the agents'
// workDirs before anything is rewritten.
type RepoCleanupCommand struct {
	Root string `json:"root"`
	// RequestedAt is the moment the user clicked, echoed back so a repeat of the same request is
	// recognizable in logs.
	RequestedAt string `json:"requestedAt,omitempty"`
}

// RepoCleanupResultRequest mirrors @orbit/shared RunnerRepoCleanupResult: the outcome of a
// RepoCleanupCommand, POSTed back so the UI can drop the warning and point at the rescue branch.
type RepoCleanupResultRequest struct {
	Root   string `json:"root"`
	Status string `json:"status"` // "done" | "failed"
	// State is the checkout's state afterwards (a repoState* value), so the stored health snapshot
	// can be corrected immediately instead of waiting for the next scan.
	State        string `json:"state,omitempty"`
	RescueBranch string `json:"rescueBranch,omitempty"`
	Message      string `json:"message,omitempty"`
}

// InstallCommand mirrors @orbit/shared: install one engine's CLI on this machine. Redelivered
// every heartbeat until our first status report moves the server on, so acting on it must be
// idempotent.
type InstallCommand struct {
	Engine string `json:"engine"`
	// Identifies this install, so a redelivered request can be told from a new one.
	Attempt string `json:"attempt,omitempty"`
	// "install" (or empty, from a control plane that only ever installed) or "update": the same
	// one-slot relay drives both, because both run a package manager against this machine's one
	// global prefix and must never overlap. An update names no engine — it does every installed
	// one, like the daily loop.
	Mode string `json:"mode,omitempty"`
}

// InstallResultRequest is the runner's progress report for an install: the command it is running,
// then whether it worked. `Message` carries the machine's own error, which is the only thing that
// makes a failed install actionable from a browser.
type InstallResultRequest struct {
	Status  string `json:"status"` // "installing" | "done" | "failed"
	Command string `json:"command,omitempty"`
	Message string `json:"message,omitempty"`
}

// LoginCommand mirrors @orbit/shared: one step of the browser-less sign-in relay. Redelivered
// every heartbeat until the runner reports a status that moves the server on, so both actions
// must be idempotent.
type LoginCommand struct {
	Action string `json:"action"` // "start" | "code"
	// Which CLI to sign in: "claude" | "codex" | "kimi". Empty from an older control plane, which only
	// ever drove claude.
	Engine string `json:"engine,omitempty"`
	// The authorization code the user pasted, for action "code".
	Code string `json:"code,omitempty"`
	// Identifies this sign-in (the server's login_at). Lets the runner tell a redelivered start
	// from a new one the user asked for after cancelling. Empty from an older control plane,
	// which the relay treats as "same attempt" — the pre-existing no-op behaviour.
	Attempt string `json:"attempt,omitempty"`
}

// LoginResultRequest is the runner's progress report for a sign-in, POSTed back so the web card
// can show the URL to approve and then the outcome. `URL` is set with "awaiting_code" and
// "awaiting_approval"; `UserCode` only with the latter (the device flow's one-time code, which
// the user types on that page); `Message` carries the reason for "failed".
type LoginResultRequest struct {
	Status   string `json:"status"`
	URL      string `json:"url,omitempty"`
	UserCode string `json:"userCode,omitempty"`
	Message  string `json:"message,omitempty"`
}

// MergeCommand mirrors @orbit/shared: a request to merge one session's worktree branch into
// a target branch on this runner's local repo. WorkDir is the session agent's dir; the
// runner resolves the repo root from it.
type MergeCommand struct {
	SessionID   string `json:"sessionId"`
	OperationID string `json:"operationId"`
	LeaseOwner  string `json:"leaseOwner"`
	Branch      string `json:"branch"`
	WorkDir     string `json:"workDir"`
	// TargetBranch is the branch to merge INTO. Empty → auto-detect main, else master (the
	// original behavior); set when the user picked a target from the status bar's dropdown.
	TargetBranch string `json:"targetBranch,omitempty"`
	// BaseSha is the commit the session's branch forked from, as the control plane recorded it
	// at /complete. The merge replays from here so it carries only the session's own commits
	// (see replayAnchor); the local base ref is gone by then for a torn-down checkout. Empty on
	// an older control plane → replay everything ahead of the target, as before.
	BaseSha string `json:"baseSha,omitempty"`
	// RequiredSourceSha is the commit the control plane's §7 checkpoint verified. When set, the
	// runner refuses to merge a branch whose tip is anything else: the commits after a verified one
	// carry no test evidence, and merging them is what `[K6]`'s gate exists to stop. Empty on an
	// older control plane, or for work that is not under convergence management — then the tip is
	// whatever the branch says, exactly as before.
	RequiredSourceSha string `json:"requiredSourceSha,omitempty"`
}

// MergeResultRequest mirrors @orbit/shared SessionMergeResultRequest: the outcome of a
// MergeCommand, POSTed back so the UI status bar can show merged ✓ / conflict / error.
type MergeResultRequest struct {
	OperationID string `json:"operationId,omitempty"`
	LeaseOwner  string `json:"leaseOwner,omitempty"`
	// "released" is not an outcome: this process drained before touching the repo, so the
	// request goes back to unclaimed and the successor performs it.
	Status    string `json:"status"` // "merged" | "conflict" | "error" | "released"
	MergedSha string `json:"mergedSha,omitempty"`
	// SourceSha is the immutable source-branch tip captured before the rebase. A successful
	// merge records exactly which version of the session branch landed in the target.
	SourceSha string `json:"sourceSha,omitempty"`
	// AlreadyMerged says the target already contained SourceSha, so this "merged" moved nothing.
	// A separate flag rather than a fifth Status value: an older control plane validates Status
	// against a closed set and would reject an unknown one, leaving the runner reporting a
	// completed merge forever. It ignores this field and records a plain MERGED, which is true;
	// a control plane that knows it records §13.7's ALREADY_MERGED, which is truer.
	AlreadyMerged bool `json:"alreadyMerged,omitempty"`
	// The branch this merge advanced, the tip it had before, and the base the source was replayed
	// onto — the fields the control plane's merge receipt (§13.7) is checked against afterwards.
	// Omitted by an older runner; the receipt is still written, naming what it knows.
	TargetBranch    string   `json:"targetBranch,omitempty"`
	TargetShaBefore string   `json:"targetShaBefore,omitempty"`
	RebaseBaseSha   string   `json:"rebaseBaseSha,omitempty"`
	Conflicts       []string `json:"conflicts,omitempty"`
	Message         string   `json:"message,omitempty"`
}

// CommitCommand mirrors @orbit/shared: a request to commit a live session's uncommitted
// worktree changes onto its branch. The runner locates the checkout from SessionID (its
// per-session worktree dir); Branch is for logging.
type CommitCommand struct {
	SessionID   string `json:"sessionId"`
	OperationID string `json:"operationId"`
	LeaseOwner  string `json:"leaseOwner"`
	Branch      string `json:"branch"`
}

type ArtifactCommand struct {
	RequestID string `json:"requestId"`
	SessionID string `json:"sessionId"`
	Path      string `json:"path"`
}

type ArtifactResultRequest struct {
	RequestID    string `json:"requestId"`
	Status       string `json:"status"` // "uploaded" | "missing" | "error"
	AttachmentID string `json:"attachmentId,omitempty"`
	Message      string `json:"message,omitempty"`
}

// CommitResultRequest mirrors @orbit/shared SessionCommitResultRequest: the outcome of a
// CommitCommand, POSTed back so the UI status bar can flip from Commit to Merge.
type CommitResultRequest struct {
	OperationID string `json:"operationId,omitempty"`
	LeaseOwner  string `json:"leaseOwner,omitempty"`
	// "released" is not an outcome: this process drained before touching the repo, so the
	// request goes back to unclaimed and the successor performs it.
	Status  string `json:"status"` // "committed" | "nochange" | "error" | "released"
	Message string `json:"message,omitempty"`
}

// DiffResultRequest mirrors @orbit/shared SessionDiffResultRequest: a freshly recomputed live
// worktree diff, POSTed back in response to a 'diff' inbox control turn so the web's diff
// drawer reflects the current worktree even when the stored snapshot lagged.
type DiffResultRequest struct {
	ChangedFiles  []ChangedFile `json:"changedFiles,omitempty"`
	ChangedDiff   []FilePatch   `json:"changedDiff,omitempty"`
	WorktreeDirty bool          `json:"worktreeDirty"`
	// BaseSha is the healed fork point used for this exact diff snapshot.
	BaseSha string `json:"baseSha,omitempty"`
	// BranchSha is the tip of the effective branch (see SessionLiveState.BranchSha).
	BranchSha string `json:"branchSha,omitempty"`
	// BranchMerged: the branch already landed in the default merge target (see SessionLiveState).
	// Recomputed with the diff, so opening the drawer refreshes it for an idle session.
	BranchMerged bool `json:"branchMerged"`
	// WorktreeBranch: the worktree's actual current HEAD branch (see SessionLiveState.WorktreeBranch).
	WorktreeBranch string `json:"worktreeBranch,omitempty"`
}

type MeResponse struct {
	ID              string        `json:"id"`
	Name            string        `json:"name"`
	Status          string        `json:"status"`
	Online          bool          `json:"online"`
	LastHeartbeatAt *string       `json:"lastHeartbeatAt"`
	Version         *string       `json:"version"`
	Labels          []string      `json:"labels"`
	MaxConcurrent   int           `json:"maxConcurrent"`
	Agents          []RunnerAgent `json:"agents"`
}

// RunnerAgent is one agent registered under this machine's runner, as reported by
// `GET /runner/me` and shown by `orbit status`.
type RunnerAgent struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Provider string `json:"provider,omitempty"`
	AgentKey string `json:"agentKey,omitempty"`
	WorkDir  string `json:"workDir,omitempty"`
}

type AgentExecConfig struct {
	Provider           string                 `json:"provider,omitempty"`
	Model              string                 `json:"model"`
	AppendSystemPrompt string                 `json:"appendSystemPrompt"`
	SystemPrompt       string                 `json:"systemPrompt"`
	AllowedTools       []string               `json:"allowedTools"`
	DisallowedTools    []string               `json:"disallowedTools"`
	PermissionMode     string                 `json:"permissionMode"`
	Effort             string                 `json:"effort"`
	MaxTurns           *int                   `json:"maxTurns"`
	MaxBudgetUsd       *float64               `json:"maxBudgetUsd"`
	McpConfig          map[string]interface{} `json:"mcpConfig"`
	// Custom env vars injected into the coding-engine process.
	Env map[string]string `json:"env"`
}

// ClaimedSession is one interactive session a runner has claimed (or reclaimed).
type ClaimedSession struct {
	SessionID string          `json:"sessionId"`
	Title     string          `json:"title"`
	Provider  string          `json:"provider,omitempty"`
	Prompt    string          `json:"prompt"`
	Agent     AgentExecConfig `json:"agent"`
	// WorkDir is the coding engine's cwd for this session, from the session's agent.
	WorkDir          string `json:"workDir,omitempty"`
	SessionUUID      string `json:"sessionUuid"`
	RuntimeSessionID string `json:"runtimeSessionId,omitempty"`
	// LeaseOwner is the runner process identity observed when the server built this claim.
	// A fresh process CAS-takes it over before it may activate an inbox generation.
	LeaseOwner string `json:"leaseOwner,omitempty"`
	MaxSeq     int    `json:"maxSeq"`
	// Resume marks a session revived from an ended state: like a reclaim, claude's
	// session already exists, so even the first spawn must --resume. Server-set.
	Resume bool `json:"resume"`
	// AgentID/TaskID are injected into the claude process (ORBIT_AGENT_ID/ORBIT_TASK_ID)
	// so the `orbit mcp` server can attribute task work and resolve the current task.
	AgentID string `json:"agentId,omitempty"`
	TaskID  string `json:"taskId,omitempty"`
	// AllowOrchestration mirrors the agent's enableOrchestration; injected as
	// ORBIT_ALLOW_ORCHESTRATION so `orbit mcp` conditionally exposes the session_* tools.
	AllowOrchestration bool `json:"allowOrchestration,omitempty"`
	// SpawnDepth is how many spawn links sit above this session (a root is 0), injected as
	// ORBIT_SPAWN_DEPTH. `orbit mcp` halves its session_create(wait) budget per level so a
	// nested wait always settles inside the wait that is waiting on it.
	SpawnDepth int `json:"spawnDepth,omitempty"`
	// OrchestrationToken proves this runtime is the calling session. The runner writes
	// it to a private per-session file before spawning the provider; it is never exposed
	// through the provider environment or CLI capability output.
	OrchestrationToken string `json:"orchestrationToken,omitempty"`
	// Reclaimed marks a session re-attached after a runner restart: the claude
	// session already exists, so the first spawn must --resume, not --session-id.
	// Runner-internal (never sent by the server).
	Reclaimed bool `json:"-"`
	// Branch is the per-session git worktree branch (server-set). When non-empty and
	// WorkDir is a git repo, the runner isolates the session in its own checkout on it.
	Branch string `json:"branch,omitempty"`
	// AutoInitGit: agent opted in to auto-`git init` a non-git workDir so it can be isolated.
	AutoInitGit bool `json:"autoInitGit,omitempty"`
	// MergeTarget is the branch this session's work merges INTO (its recorded target, else its
	// agent's default) — the same branch the UI's Merge button names. Seeds branchMergedInto so
	// the "already merged" chip judges that branch instead of main. Empty → auto-detect.
	MergeTarget string `json:"mergeTarget,omitempty"`
	// Source is which commit this run must start from (docs/project-source-contract.md §6.3).
	// Nil for every Legacy session — which is every session that is not a code task of a Project
	// with a codebase binding — and those keep the pre-0231 behaviour byte for byte: setupWorktree
	// forks from the workDir's HEAD (SR45/SR46).
	//
	// Non-nil means the opposite, and the server only sends it to a process that declared
	// source-pin/v1 (SR35), because a runner that ignored the field would fork from that same HEAD.
	// The engine may not be spawned until State is PINNED and the worktree stands on BaseSha
	// (SR33).
	Source *SessionSource `json:"source,omitempty"`
	// WT and IsolationStatus are runner-internal, resolved by setupWorktree at start: WT
	// is the live worktree (nil when running shared), IsolationStatus what was done.
	WT              *Worktree `json:"-"`
	IsolationStatus string    `json:"-"`
}

// SessionSource is the frozen SOURCE snapshot: the INTENT (which repository, which line), frozen
// when the session was created, plus the FACT (which commit) once a first claim froze it.
//
// Branch states intent and commit SHA states what happened, and both are on the record: a run with
// only a selector cannot be reproduced, and one with only a pin cannot be explained (SR4).
type SessionSource struct {
	// UNBOUND | SELECTED | PINNED | REFUSED. UNBOUND never travels — it is sent as an absent field.
	State string `json:"state"`
	// Which row of the priority table produced this selector (§4.1).
	Kind string `json:"kind"`
	// The binding this resolved against, as it was AT resolution.
	CodebaseID string `json:"codebaseId"`
	// Repository identity (§7.1), frozen: editing the binding's URL cannot reach an in-flight run.
	RepoURL       string `json:"repoUrl"`
	RootCommitSha string `json:"rootCommitSha,omitempty"`
	// Exactly one of Ref / RevisionSha is set. A ref-valued selector has to be resolved against the
	// authority at claim time; a SHA-valued one is already the answer.
	Ref         string `json:"ref,omitempty"`
	RevisionSha string `json:"revisionSha,omitempty"`
	// The binding's CONFIGURATION version at resolution — a counter, never a git object.
	ConfigRevision string `json:"configRevision,omitempty"`
	// REMOTE (ask the remote) | RUNNER_LOCAL (one named machine's checkout is authoritative).
	RefAuthority string `json:"refAuthority"`
	// How to ask, as opposed to what is being asked: not part of the frozen selector.
	RemoteName        string `json:"remoteName,omitempty"`
	AuthorityRunnerID string `json:"authorityRunnerId,omitempty"`
	// Commits the baseline must contain (gate G5).
	RequiredContains []string `json:"requiredContains,omitempty"`
	// The pin. Set exactly when State is PINNED; from then on it is read and never re-derived.
	BaseSha            string `json:"baseSha,omitempty"`
	ResolvedAt         string `json:"resolvedAt,omitempty"`
	ResolvedByRunnerID string `json:"resolvedByRunnerId,omitempty"`
	RefusalCode        string `json:"refusalCode,omitempty"`
}

// SourcePinRequest reports what the machine that owns the repository concluded (§6.3 step 3).
// Exactly one half is sent: a resolved commit to freeze, or the gate's refusal code.
type SourcePinRequest struct {
	BaseSha string            `json:"baseSha,omitempty"`
	Refusal *SourcePinRefusal `json:"refusal,omitempty"`
}

type SourcePinRefusal struct {
	Code   string                 `json:"code"`
	Detail map[string]interface{} `json:"detail,omitempty"`
}

// SourcePinResponse is what is frozen NOW, which is not always what this runner asked for: a loser
// of the compare-and-set is handed the WINNER's pin with WonRace false (SR30). A worktree already
// exists on that commit, so adopting it is the only answer that keeps one session to one baseline.
type SourcePinResponse struct {
	State              string `json:"state"`
	BaseSha            string `json:"baseSha,omitempty"`
	ResolvedAt         string `json:"resolvedAt,omitempty"`
	ResolvedByRunnerID string `json:"resolvedByRunnerId,omitempty"`
	RefusalCode        string `json:"refusalCode,omitempty"`
	WonRace            bool   `json:"wonRace"`
}

// Interactive sessions (Route B) — wire DTOs mirroring @orbit/shared.

// TurnAttachment references one attachment to fetch for a user turn: its id, MIME type,
// and original filename. The bytes come from the runner-scoped
// GET /runner/sessions/:id/attachments/:attId; the type decides how it's fed to claude
// (image/PDF inlined as a content block, anything else written to the worktree).
type TurnAttachment struct {
	ID       string `json:"id"`
	MimeType string `json:"mimeType"`
	FileName string `json:"fileName,omitempty"`
}

type AttachmentCreateResponse struct {
	ID string `json:"id"`
}

// RunInboxResponse is the next user turn to feed the live runtime.
// TurnID == "" means nothing is available (mirrors the empty-runId claim convention).
type RunInboxResponse struct {
	TurnID       string `json:"turnId"`
	TargetTurnID string `json:"targetTurnId,omitempty"`
	Seq          int    `json:"seq"`
	Kind         string `json:"kind"`
	Content      string `json:"content,omitempty"`
	// Attachments for this (message) turn; the runner fetches each blob and dispatches on
	// its type (image/PDF → content block, else → written to the worktree). Nil if none.
	Attachments []TurnAttachment `json:"attachments,omitempty"`
	// Env is the process environment to re-spawn the engine with, sent only on a `reload` that
	// moved the session to another provider on the same runtime (a second account with the same
	// vendor, say). It REPLACES job.Agent.Env, so the previous provider's variables go with it —
	// an empty (non-nil) map is how a move onto a self-authenticating built-in engine arrives.
	// Nil on every other reload, meaning the environment did not change.
	Env map[string]string `json:"env,omitempty"`
	// SteerRequeue: only on a `steer`, and only from a control plane that understands
	// `steer_requeue` — that a steer which provably never reached the engine may be filed back
	// as the ordinary message it would have been had it arrived a moment later.
	//
	// Absent is false, which is exactly right for an older control plane: its turn-complete
	// does not read `subtype` at all, so a `steer_requeue` sent to it acks the row and the
	// message is gone. False here means a provably-undelivered steer is reported as a visible
	// failure instead — worse for the person, but nothing is lost.
	SteerRequeue bool `json:"steerRequeue,omitempty"`
	// TaskAcceptance marks the server-generated EXECUTABLE command. It always runs synchronously so the
	// control plane receives one definitive exit code, even if its text ends in `&`.
	TaskAcceptance bool `json:"taskAcceptance,omitempty"`
}

// AbandonedSteer is a mid-turn message a dead runner process left leased, handed to the process
// taking the session over so it can be answered for. Whether it reached the engine is unknowable
// from either side, so it is never re-delivered — it is reported as undelivered and settled.
type AbandonedSteer struct {
	TurnID  string `json:"turnId"`
	Content string `json:"content"`
	// Announced: this steer already has a `user` event in the transcript, so the report only has
	// to amend that bubble. False means the dead process never got that far and the report has to
	// open one too — emitting a second for a turn that already has one shows the message twice.
	Announced bool `json:"announced"`
}

// ActivateTurnLeasesResponse answers the activation that makes one engine generation a session's
// sole inbox consumer.
type ActivateTurnLeasesResponse struct {
	AbandonedSteers []AbandonedSteer `json:"abandonedSteers,omitempty"`
}

type ReclaimSession struct {
	SessionID string `json:"sessionId"`
	Title     string `json:"title"`
	// Status lets the runner rebuild every still-open session supervisor while
	// consuming an active-turn permit only for work that was actually RUNNING.
	// Empty is retained for compatibility with older servers whose reclaim list
	// contained RUNNING sessions only.
	Status           string          `json:"status,omitempty"`
	Provider         string          `json:"provider,omitempty"`
	SessionUUID      string          `json:"sessionUuid"`
	RuntimeSessionID string          `json:"runtimeSessionId,omitempty"`
	LeaseOwner       string          `json:"leaseOwner,omitempty"`
	MaxSeq           int             `json:"maxSeq"`
	Agent            AgentExecConfig `json:"agent"`
	// WorkDir is claude's cwd for this session, from the session's agent.
	WorkDir string `json:"workDir,omitempty"`
	// Injected into the claude process, cf. ClaimedSession.AgentID/TaskID.
	AgentID string `json:"agentId,omitempty"`
	TaskID  string `json:"taskId,omitempty"`
	// AllowOrchestration, cf. ClaimedSession.AllowOrchestration.
	AllowOrchestration bool `json:"allowOrchestration,omitempty"`
	// OrchestrationToken is freshly persisted for the reclaimed runtime, cf. ClaimedSession.
	OrchestrationToken string `json:"orchestrationToken,omitempty"`
	// Branch is the session's worktree branch, cf. ClaimedSession.Branch.
	Branch string `json:"branch,omitempty"`
	// AutoInitGit, cf. ClaimedSession.AutoInitGit.
	AutoInitGit bool `json:"autoInitGit,omitempty"`
	// MergeTarget, cf. ClaimedSession.MergeTarget.
	MergeTarget string `json:"mergeTarget,omitempty"`
	// Source, cf. ClaimedSession.Source. On reclaim it is read, never re-derived (SR29): a session
	// already PINNED comes back on the SHA its first claim froze.
	Source *SessionSource `json:"source,omitempty"`
}

type ReclaimResponse struct {
	Sessions []ReclaimSession `json:"sessions"`
}

type TurnCompleteRequest struct {
	LeaseOwner string `json:"leaseOwner,omitempty"`
	TurnID     string `json:"turnId"`
	Status     string `json:"status"`
	Result     string `json:"result,omitempty"`
	// ShellExitCode/ShellOutput are populated for synchronous shell turns. Pointers preserve
	// the difference between a real zero/empty result and an older runner that sent neither.
	ShellExitCode *int                   `json:"shellExitCode,omitempty"`
	ShellOutput   *string                `json:"shellOutput,omitempty"`
	Subtype       string                 `json:"subtype,omitempty"`
	NumTurns      int                    `json:"numTurns"`
	CostUsd       float64                `json:"costUsd"`
	Usage         *TokenUsage            `json:"usage,omitempty"`
	ModelUsage    map[string]interface{} `json:"modelUsage,omitempty"`
	// Provider-neutral runtime session/thread id discovered during this turn.
	RuntimeSessionID string `json:"runtimeSessionId,omitempty"`
	// Worktree isolation, reported each turn so the web can show a LIVE status bar (branch +
	// running diff) while the session is still going — not just at terminal /complete.
	IsolationStatus string        `json:"isolationStatus,omitempty"`
	ChangedFiles    []ChangedFile `json:"changedFiles,omitempty"`
	// BaseSha is the healed fork point used for ChangedFiles/ChangedDiff.
	BaseSha string `json:"baseSha,omitempty"`
	// BranchSha is the tip of the effective branch (see SessionLiveState.BranchSha).
	BranchSha string `json:"branchSha,omitempty"`
	// Per-file unified diffs (capped) for the same uncommitted worktree state, so the web
	// can open a file's diff on demand without a round-trip back to this runner.
	ChangedDiff []FilePatch `json:"changedDiff,omitempty"`
	// Whether the worktree has uncommitted changes (drives Commit vs Merge). No omitempty
	// (false must be sent so a just-committed tree flips the bar to Merge).
	WorktreeDirty bool `json:"worktreeDirty"`
	// BranchMerged: the branch already landed in the default merge target (see SessionLiveState).
	// The turn-end snapshot an idle session shows, so an out-of-band merge is reflected here too.
	// No omitempty (false must be sent so the server can clear a stale true).
	BranchMerged bool `json:"branchMerged"`
	// WorktreeBranch: the worktree's actual current HEAD branch (see SessionLiveState.WorktreeBranch).
	WorktreeBranch string `json:"worktreeBranch,omitempty"`
}

// TurnCompleteResponse carries the control-plane status after the ack. Newer
// servers keep RUNNING when a queued follow-up is ready, and return
// AWAITING_INPUT only when this runner may release its active-turn permit. Older
// servers returned only {ok:true}; transport.go treats an omitted status as the
// historical AWAITING_INPUT behavior.
type TurnCompleteResponse struct {
	OK            bool   `json:"ok"`
	Status        string `json:"status,omitempty"`
	SessionStatus string `json:"sessionStatus,omitempty"`
}

type RunEvent struct {
	Seq     int                    `json:"seq"`
	Type    string                 `json:"type"`
	TS      string                 `json:"ts"`
	TurnID  string                 `json:"turnId,omitempty"`
	Payload map[string]interface{} `json:"payload"`
}

type RunEventBatch struct {
	LeaseOwner string     `json:"leaseOwner,omitempty"`
	Events     []RunEvent `json:"events"`
}

type TokenUsage struct {
	InputTokens              int `json:"input_tokens"`
	OutputTokens             int `json:"output_tokens"`
	CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     int `json:"cache_read_input_tokens"`
}

// ChangedFile is one file a worktree-isolated session changed, computed by the runner
// (git diff baseSha..branch) at completion. Additions/Deletions are -1 for binary files.
type ChangedFile struct {
	Path      string `json:"path"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Status    string `json:"status"`
}

// FilePatch carries one changed file's full unified-diff text (git diff vs base), reported
// alongside the ChangedFile stats so the web can show a file's diff on demand. Patch is
// empty for binary/omitted files; Truncated marks a diff dropped for exceeding the size cap.
type FilePatch struct {
	Path      string `json:"path"`
	Patch     string `json:"patch,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
}

// RunFinalizeRequest reports the terminal outcome of the runner process. It is not the
// user-facing Complete action, which changes a Session's lifecycleState to COMPLETED.
type RunFinalizeRequest struct {
	LeaseOwner       string                 `json:"leaseOwner,omitempty"`
	Status           string                 `json:"status"`
	Result           string                 `json:"result,omitempty"`
	Subtype          string                 `json:"subtype,omitempty"`
	Error            string                 `json:"error,omitempty"`
	ClaudeSessionID  string                 `json:"claudeSessionId,omitempty"`
	RuntimeSessionID string                 `json:"runtimeSessionId,omitempty"`
	NumTurns         int                    `json:"numTurns"`
	DurationMs       int                    `json:"durationMs"`
	CostUsd          float64                `json:"costUsd"`
	Usage            *TokenUsage            `json:"usage,omitempty"`
	ModelUsage       map[string]interface{} `json:"modelUsage,omitempty"`
	// Worktree isolation outcome (see worktree.go): the branch the work was committed to,
	// the base it forked from, what the runner did, and the per-file diff summary.
	Branch          string        `json:"branch,omitempty"`
	BaseSha         string        `json:"baseSha,omitempty"`
	IsolationStatus string        `json:"isolationStatus,omitempty"`
	ChangedFiles    []ChangedFile `json:"changedFiles,omitempty"`
	// Per-file unified diffs (capped) of the committed branch vs base, for on-demand viewing.
	ChangedDiff []FilePatch `json:"changedDiff,omitempty"`
	// MergeTargets is the repo's candidate merge-target branches at completion (see
	// SessionLiveState.MergeTargets), populating the ended session's "Merge to…" dropdown.
	MergeTargets []string `json:"mergeTargets,omitempty"`
	// WorktreeBranch: the worktree's actual HEAD branch at completion (see SessionLiveState); lets
	// the server flag / offer "Adopt" for a session that finished on an in-worktree checkout -b branch.
	WorktreeBranch string `json:"worktreeBranch,omitempty"`
}

// RunFinalizeResponse is the control plane's reply when the runner finalizes a run through
// /runner/sessions/:id/finalize. KeepCheckout is false only when the Session is Completed or
// in Trash; for any resumable end it is true, so the
// runner preserves the isolated worktree checkout.
type RunFinalizeResponse struct {
	Ok           bool `json:"ok"`
	KeepCheckout bool `json:"keepCheckout"`
}

// WorktreesRemovableResponse lists which of the queried session ids have a removable
// checkout (Completed / in Trash / no longer a session); any id absent must be kept.
type WorktreesRemovableResponse struct {
	Removable []string `json:"removable"`
}

type Manifest struct {
	Version                   string `json:"version"`
	CapabilityRevision        int    `json:"capabilityRevision,omitempty"`
	SchemaRevision            int    `json:"schemaRevision,omitempty"`
	MinimumCapabilityRevision int    `json:"minimumCapabilityRevision,omitempty"`
	MinimumSchemaRevision     int    `json:"minimumSchemaRevision,omitempty"`
	ContractDigest            string `json:"contractDigest,omitempty"`
}

// PermissionRule mirrors @orbit/shared: a claude permission rule to add for the rest of
// the session so future "same kind" calls are auto-allowed. ToolName is the gated tool;
// RuleContent narrows it (Bash uses a command prefix like "git commit:*") — empty means
// allow every call to that tool.
type PermissionRule struct {
	ToolName    string `json:"toolName"`
	RuleContent string `json:"ruleContent,omitempty"`
}

// ApprovalDecisionResponse mirrors @orbit/shared: the resolved decision returned by
// the approval long-poll. Status "PENDING" means the window elapsed undecided.
type ApprovalDecisionResponse struct {
	ID       string `json:"id"`
	Status   string `json:"status"`
	Behavior string `json:"behavior,omitempty"`
	Message  string `json:"message,omitempty"`
	// AskUserQuestion only: the human's picks, keyed by question text -> selected
	// option labels. Fed back to claude as the tool's updatedInput.answers.
	Answers map[string][]string `json:"answers,omitempty"`
	// Set when the human chose "allow + remember same kind": fed back to claude as
	// updatedPermissions so its engine auto-allows matching calls for the session. A
	// compound Bash line yields one rule per distinct sub-command.
	RememberRules []PermissionRule `json:"rememberRules,omitempty"`
	// Deprecated: the primary (first) rule, kept for forward-compat with control planes
	// that don't send the array yet. Prefer RememberRules.
	RememberRule *PermissionRule `json:"rememberRule,omitempty"`
}

// resolveRememberRules prefers the array form, falling back to the deprecated singular
// RememberRule so a control plane that hasn't adopted the array yet still works.
func (d ApprovalDecisionResponse) resolveRememberRules() []PermissionRule {
	if len(d.RememberRules) > 0 {
		return d.RememberRules
	}
	if d.RememberRule != nil {
		return []PermissionRule{*d.RememberRule}
	}
	return nil
}

// Run-event type strings — mirror RunEventType in @orbit/shared.
const (
	evSystem        = "system"
	evAssistant     = "assistant"
	evTextDelta     = "text_delta"
	evThinking      = "thinking"
	evThinkingDelta = "thinking_delta"
	evToolUse       = "tool_use"
	evToolOutput    = "tool_output"
	evToolResult    = "tool_result"
	evError         = "error"
	// Interactive sessions (Route B)
	evUser    = "user"
	evTurnEnd = "turn_end"
	// How far a user message got on its way into the engine's conversation: enqueued ->
	// written -> acknowledged, or failed with a reason (claude_delivery.go). The `user`
	// event that opens a turn carries its own first state; this reports every one after.
	evUserDelivery = "user_delivery"
	evInterrupt    = "interrupt"
	// Background shells (Bash run_in_background): durable lifecycle signal parsed from
	// Claude's <task-notification> user message, and the live tail of the output file.
	evBackgroundTask   = "background_task"
	evBackgroundOutput = "background_output"
)

// Run statuses — mirror RunStatus in @orbit/shared.
const (
	stPending       = "PENDING"
	stRunning       = "RUNNING"
	stSucceeded     = "SUCCEEDED"
	stFailed        = "FAILED"
	stCancelled     = "CANCELLED"
	stAwaitingInput = "AWAITING_INPUT"
	stInterrupted   = "INTERRUPTED"
)
