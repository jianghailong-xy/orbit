package main

// Wire DTOs — JSON tags mirror @orbit/shared exactly (camelCase). The control
// plane's ValidationPipe passes these plain objects through unchanged.

type DeviceStartRequest struct {
	Name          string   `json:"name"` // the runner (machine) name; defaults to the hostname
	Hostname      string   `json:"hostname,omitempty"`
	Labels        []string `json:"labels"`
	MaxConcurrent int      `json:"maxConcurrent"`
	Version       string   `json:"version,omitempty"`
	// Default project directory; agents (registered separately) run claude here.
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
	// Default project directory; agents (registered separately) run claude here.
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
	// Slash assets discovered on this machine, surfaced to the web composer for
	// `/` autocomplete. Empty slices are omitted so quiet heartbeats stay small.
	Commands []SlashCommandInfo `json:"commands,omitempty"`
	Skills   []SlashCommandInfo `json:"skills,omitempty"`
	// Provider quota for the accounts this runner uses (Claude `/usage` and/or Codex
	// app-server rate limits). Nil when unavailable — never blocks or fails heartbeat.
	PlanUsage *PlanUsage `json:"planUsage,omitempty"`
	// Runtime model catalog for picker UIs. Nil on old runners / unavailable runtimes.
	ModelCatalog *ModelCatalog `json:"modelCatalog,omitempty"`
	// Sessions carries each running session's live worktree diff so the web status bar
	// appears mid-turn, not just at turn-complete. Empty when no isolated session runs.
	Sessions []SessionLiveState `json:"sessions,omitempty"`
}

// SessionLiveState is one running session's live worktree state, reported each heartbeat
// while a turn is in flight (the uncommitted diff vs base, mirroring TurnCompleteRequest).
type SessionLiveState struct {
	SessionID       string        `json:"sessionId"`
	IsolationStatus string        `json:"isolationStatus"`
	ChangedFiles    []ChangedFile `json:"changedFiles"`
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
	// AgentID scopes a project-level asset to the agent whose workDir it was found in;
	// empty means host-level (the runner's default dir or ~/.claude), shared by all agents.
	AgentID string `json:"agentId,omitempty"`
	// Builtin marks a name the Claude CLI registers itself (built-in skill, plugin skill,
	// namespaced command), learned from its init handshake rather than found on disk.
	// Composers list these after the user's own assets.
	Builtin bool `json:"builtin,omitempty"`
}

type ModelCatalog struct {
	Codex  []ModelInfo `json:"codex,omitempty"`
	Claude []ModelInfo `json:"claude,omitempty"`
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
}

// LoginCommand mirrors @orbit/shared: one step of the browser-less sign-in relay. Redelivered
// every heartbeat until the runner reports a status that moves the server on, so both actions
// must be idempotent.
type LoginCommand struct {
	Action string `json:"action"` // "start" | "code"
	// Which CLI to sign in: "claude" | "codex". Empty from an older control plane, which only
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
	SessionID string `json:"sessionId"`
	Branch    string `json:"branch"`
	WorkDir   string `json:"workDir"`
	// TargetBranch is the branch to merge INTO. Empty → auto-detect main, else master (the
	// original behavior); set when the user picked a target from the status bar's dropdown.
	TargetBranch string `json:"targetBranch,omitempty"`
}

// MergeResultRequest mirrors @orbit/shared SessionMergeResultRequest: the outcome of a
// MergeCommand, POSTed back so the UI status bar can show merged ✓ / conflict / error.
type MergeResultRequest struct {
	Status    string `json:"status"` // "merged" | "conflict" | "error"
	MergedSha string `json:"mergedSha,omitempty"`
	Message   string `json:"message,omitempty"`
}

// CommitCommand mirrors @orbit/shared: a request to commit a live session's uncommitted
// worktree changes onto its branch. The runner locates the checkout from SessionID (its
// per-session worktree dir); Branch is for logging.
type CommitCommand struct {
	SessionID string `json:"sessionId"`
	Branch    string `json:"branch"`
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
	Status  string `json:"status"` // "committed" | "nochange" | "error"
	Message string `json:"message,omitempty"`
}

// DiffResultRequest mirrors @orbit/shared SessionDiffResultRequest: a freshly recomputed live
// worktree diff, POSTed back in response to a 'diff' inbox control turn so the web's diff
// drawer reflects the current worktree even when the stored snapshot lagged.
type DiffResultRequest struct {
	ChangedFiles  []ChangedFile `json:"changedFiles,omitempty"`
	ChangedDiff   []FilePatch   `json:"changedDiff,omitempty"`
	WorktreeDirty bool          `json:"worktreeDirty"`
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
	// Custom env vars injected into the claude process (cf. session.go cmd.Env).
	Env map[string]string `json:"env"`
}

// ClaimedSession is one interactive session a runner has claimed (or reclaimed).
type ClaimedSession struct {
	SessionID string          `json:"sessionId"`
	Title     string          `json:"title"`
	Provider  string          `json:"provider,omitempty"`
	Prompt    string          `json:"prompt"`
	Agent     AgentExecConfig `json:"agent"`
	// WorkDir is claude's cwd for this session, from the session's agent.
	WorkDir          string `json:"workDir,omitempty"`
	SessionUUID      string `json:"sessionUuid"`
	RuntimeSessionID string `json:"runtimeSessionId,omitempty"`
	MaxSeq           int    `json:"maxSeq"`
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
	// WT and IsolationStatus are runner-internal, resolved by setupWorktree at start: WT
	// is the live worktree (nil when running shared), IsolationStatus what was done.
	WT              *Worktree `json:"-"`
	IsolationStatus string    `json:"-"`
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

// RunInboxResponse is the next user turn to feed the live claude process.
// TurnID == "" means nothing is available (mirrors the empty-runId claim convention).
type RunInboxResponse struct {
	TurnID  string `json:"turnId"`
	Seq     int    `json:"seq"`
	Kind    string `json:"kind"`
	Content string `json:"content,omitempty"`
	// Attachments for this (message) turn; the runner fetches each blob and dispatches on
	// its type (image/PDF → content block, else → written to the worktree). Nil if none.
	Attachments []TurnAttachment `json:"attachments,omitempty"`
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
}

type ReclaimResponse struct {
	Sessions []ReclaimSession `json:"sessions"`
}

type TurnCompleteRequest struct {
	TurnID     string                 `json:"turnId"`
	Status     string                 `json:"status"`
	Result     string                 `json:"result,omitempty"`
	Subtype    string                 `json:"subtype,omitempty"`
	NumTurns   int                    `json:"numTurns"`
	CostUsd    float64                `json:"costUsd"`
	Usage      *TokenUsage            `json:"usage,omitempty"`
	ModelUsage map[string]interface{} `json:"modelUsage,omitempty"`
	// Provider-neutral runtime session/thread id discovered during this turn.
	RuntimeSessionID string `json:"runtimeSessionId,omitempty"`
	// Worktree isolation, reported each turn so the web can show a LIVE status bar (branch +
	// running diff) while the session is still going — not just at terminal /complete.
	IsolationStatus string        `json:"isolationStatus,omitempty"`
	ChangedFiles    []ChangedFile `json:"changedFiles,omitempty"`
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
	Events []RunEvent `json:"events"`
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
	Version string `json:"version"`
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
	evToolResult    = "tool_result"
	evError         = "error"
	// Interactive sessions (Route B)
	evUser      = "user"
	evTurnEnd   = "turn_end"
	evInterrupt = "interrupt"
	// Background shells (Bash run_in_background): durable lifecycle signal parsed from
	// Claude's <task-notification> user message, and the live tail of the output file.
	evBackgroundTask   = "background_task"
	evBackgroundOutput = "background_output"
)

// Run statuses — mirror RunStatus in @orbit/shared.
const (
	stRunning       = "RUNNING"
	stSucceeded     = "SUCCEEDED"
	stFailed        = "FAILED"
	stCancelled     = "CANCELLED"
	stAwaitingInput = "AWAITING_INPUT"
	stInterrupted   = "INTERRUPTED"
)
