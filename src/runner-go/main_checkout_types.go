package main

// Main checkout Git: the wire shapes the runner shares with the control plane (mirrors
// src/shared/src/mainCheckoutGit.ts; contract in docs/main-checkout-git-contract.md). Types and
// names only — the snapshot, the fingerprint and the four actions are built on top of these.
// main_checkout_types_test.go holds both sides to src/shared/src/main-checkout-git.fixture.json.

// mainCheckoutGitCapabilityV1 is declared in X-Orbit-Runner-Capabilities by a runner that can
// snapshot a main checkout and run move/commit/push/rescue. Without it the clients show no buttons.
const mainCheckoutGitCapabilityV1 = "main-checkout-git/v1"

// mainCheckoutFileLimit is the most files a snapshot lists and counts; past it Truncated is set.
const mainCheckoutFileLimit = 200

// mainCheckoutPatchMaxBytes caps one file's patch in the on-demand diff read.
const mainCheckoutPatchMaxBytes = 256 * 1024

// Action kinds.
const (
	mainCheckoutMove   = "move"
	mainCheckoutCommit = "commit"
	mainCheckoutPush   = "push"
	mainCheckoutRescue = "rescue"
)

// Result statuses: done; partial (MOVE_SOURCE_CHANGED only: copied, not cleared); refused
// (nothing changed); waiting (RUNNER_OFFLINE only, written by the control plane).
const (
	mainCheckoutDone    = "done"
	mainCheckoutPartial = "partial"
	mainCheckoutRefused = "refused"
	mainCheckoutWaiting = "waiting"
)

// Refusal codes. The last four are the control plane's; a runner never reports them.
const (
	mainCheckoutFingerprintStale  = "FINGERPRINT_STALE"
	mainCheckoutHeadMoved         = "HEAD_MOVED"
	mainCheckoutMoveConflict      = "MOVE_CONFLICT"
	mainCheckoutMoveSourceChanged = "MOVE_SOURCE_CHANGED"
	mainCheckoutTargetBusy        = "TARGET_BUSY"
	mainCheckoutCheckoutBlocked   = "CHECKOUT_BLOCKED"
	mainCheckoutDetached          = "DETACHED"
	mainCheckoutNoHead            = "NO_HEAD"
	mainCheckoutNothingToPush     = "NOTHING_TO_PUSH"
	mainCheckoutNoRemote          = "NO_REMOTE"
	mainCheckoutPushRejected      = "PUSH_REJECTED"
	mainCheckoutPushAuthFailed    = "PUSH_AUTH_FAILED"
	mainCheckoutPushFailed        = "PUSH_FAILED"
	mainCheckoutRescueFailed      = "RESCUE_FAILED"
	mainCheckoutActionInFlight    = "ACTION_IN_FLIGHT"
	mainCheckoutRunnerOffline     = "RUNNER_OFFLINE"
	mainCheckoutTimeout           = "TIMEOUT"
	mainCheckoutCancelled         = "CANCELLED"
)

// mainCheckoutRefusalCodes lists every code in the shared module's order.
var mainCheckoutRefusalCodes = []string{
	mainCheckoutFingerprintStale, mainCheckoutHeadMoved, mainCheckoutMoveConflict, mainCheckoutMoveSourceChanged,
	mainCheckoutTargetBusy, mainCheckoutCheckoutBlocked, mainCheckoutDetached, mainCheckoutNoHead,
	mainCheckoutNothingToPush, mainCheckoutNoRemote, mainCheckoutPushRejected, mainCheckoutPushAuthFailed,
	mainCheckoutPushFailed, mainCheckoutRescueFailed, mainCheckoutActionInFlight, mainCheckoutRunnerOffline,
	mainCheckoutTimeout, mainCheckoutCancelled,
}

// System-event noticeKinds. noticeMainCheckoutChanged replaces "shared-checkout-dirty".
const (
	noticeMainCheckoutChanged      = "main-checkout-changed"
	noticeMainCheckoutActionResult = "main-checkout-action-result"
)

// MainCheckoutFile is one changed path against HEAD (working tree included). Status is M, A or D
// (no rename detection). ContentHash is the working-tree blob id, "-" when deleted.
type MainCheckoutFile struct {
	Path        string `json:"path"`
	Status      string `json:"status"`
	ContentHash string `json:"contentHash"`
	Untracked   bool   `json:"untracked,omitempty"`
	Binary      bool   `json:"binary,omitempty"`
	Additions   *int   `json:"additions,omitempty"`
	Deletions   *int   `json:"deletions,omitempty"`
}

// MainCheckoutSnapshot is what the runner sees in a main checkout. Files are sorted by path bytes
// and capped at mainCheckoutFileLimit; Fingerprint covers every changed file.
type MainCheckoutSnapshot struct {
	Root        string             `json:"root"`
	Branch      string             `json:"branch,omitempty"`
	Head        string             `json:"head,omitempty"`
	State       string             `json:"state"`
	Upstream    string             `json:"upstream,omitempty"`
	Ahead       *int               `json:"ahead,omitempty"`
	Behind      *int               `json:"behind,omitempty"`
	Files       []MainCheckoutFile `json:"files"`
	FileCount   int                `json:"fileCount"`
	Truncated   bool               `json:"truncated"`
	Fingerprint string             `json:"fingerprint"`
	CheckedAt   string             `json:"checkedAt"`
}

// MainCheckoutFileDiff is one file's patch, read on demand and never sent on the heartbeat.
type MainCheckoutFileDiff struct {
	Path           string `json:"path"`
	Binary         bool   `json:"binary"`
	Patch          string `json:"patch,omitempty"`
	PatchTruncated bool   `json:"patchTruncated,omitempty"`
}

// MainCheckoutHeartbeatFields are added to each heartbeat repos[] entry (RepoHealthReport) once
// the runner declares the capability: counts and the fingerprint, never contents or patches.
type MainCheckoutHeartbeatFields struct {
	Head        string `json:"head,omitempty"`
	Upstream    string `json:"upstream,omitempty"`
	Ahead       *int   `json:"ahead,omitempty"`
	Behind      *int   `json:"behind,omitempty"`
	FileCount   *int   `json:"fileCount,omitempty"`
	Truncated   *bool  `json:"truncated,omitempty"`
	Fingerprint string `json:"fingerprint,omitempty"`
}

// MainCheckoutActionRequest is POST /workspaces/:id/main-checkout/actions.
type MainCheckoutActionRequest struct {
	Kind            string   `json:"kind"`
	Root            string   `json:"root"`
	Fingerprint     string   `json:"fingerprint"`
	Files           []string `json:"files,omitempty"`
	Message         string   `json:"message,omitempty"`
	TargetSessionID string   `json:"targetSessionId,omitempty"`
	RequestID       string   `json:"requestId"`
}

// MainCheckoutActionCommand is the request as relayed to the runner, which must not start it
// after ExpiresAt.
type MainCheckoutActionCommand struct {
	MainCheckoutActionRequest
	TargetBranch string `json:"targetBranch,omitempty"`
	RequestedAt  string `json:"requestedAt"`
	ExpiresAt    string `json:"expiresAt"`
}

// MainCheckoutActionResult is an action's outcome; the control plane writes it into the
// initiating session as one line (mainCheckoutResultLine in the shared module).
type MainCheckoutActionResult struct {
	RequestID       string   `json:"requestId"`
	Kind            string   `json:"kind"`
	Root            string   `json:"root"`
	Status          string   `json:"status"`
	Code            string   `json:"code,omitempty"`
	Branch          string   `json:"branch,omitempty"`
	FileCount       *int     `json:"fileCount,omitempty"`
	Remaining       *int     `json:"remaining,omitempty"`
	RescueBranch    string   `json:"rescueBranch,omitempty"`
	Head            string   `json:"head,omitempty"`
	Subject         string   `json:"subject,omitempty"`
	Upstream        string   `json:"upstream,omitempty"`
	RemoteBefore    string   `json:"remoteBefore,omitempty"`
	RemoteAfter     string   `json:"remoteAfter,omitempty"`
	TargetSessionID string   `json:"targetSessionId,omitempty"`
	TargetBranch    string   `json:"targetBranch,omitempty"`
	Paths           []string `json:"paths,omitempty"`
	State           string   `json:"state,omitempty"`
	Behind          *int     `json:"behind,omitempty"`
	GitMessage      string   `json:"gitMessage,omitempty"`
	RunnerName      string   `json:"runnerName,omitempty"`
	Minutes         *int     `json:"minutes,omitempty"`
	FinishedAt      string   `json:"finishedAt"`
}

// MainCheckoutChangedFile is a file as the changed notice lists it.
type MainCheckoutChangedFile struct {
	Path      string `json:"path"`
	Status    string `json:"status"`
	Binary    bool   `json:"binary,omitempty"`
	Additions *int   `json:"additions,omitempty"`
	Deletions *int   `json:"deletions,omitempty"`
}

// MainCheckoutChangedNotice is the payload of a noticeMainCheckoutChanged system event.
type MainCheckoutChangedNotice struct {
	NoticeKind  string                    `json:"noticeKind"`
	Notice      string                    `json:"notice"`
	Root        string                    `json:"root"`
	Branch      string                    `json:"branch,omitempty"`
	Files       []MainCheckoutChangedFile `json:"files"`
	FileCount   int                       `json:"fileCount"`
	Truncated   bool                      `json:"truncated"`
	Fingerprint string                    `json:"fingerprint"`
}
