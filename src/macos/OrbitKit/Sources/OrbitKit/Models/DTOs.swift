import Foundation

// REST request/response models mirroring the apiserver. Fields are generously optional so a
// newer/older server shape decodes rather than throwing. Only what Phase 0 needs is modeled;
// extend as the app grows.

public struct User: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let email: String
    public let name: String?
    public let role: String?
    // `GET /users/me` also returns these; login's user payload omits them (→ nil).
    public let createdAt: String?
    public let preferences: UserPreferences?
}

public struct LoginRequest: Codable, Sendable {
    public let email: String
    public let password: String
    public init(email: String, password: String) {
        self.email = email
        self.password = password
    }
}

public struct LoginResponse: Codable, Sendable {
    public let accessToken: String
    public let user: User
}

public struct SetupStatus: Codable, Sendable {
    public let needsSetup: Bool
}

public struct Agent: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let provider: String?
    public let model: String?
    public let permissionMode: String?
    /// The agent's default reasoning effort ('' = model default, else low/medium/high/xhigh/max).
    /// A new session seeds its effort from this (like model/permissionMode) — see the composer.
    public let effort: String?
    public let workDir: String?
    // The rest back the detail / edit form; all optional so a list payload (which may omit
    // them) still decodes. Mirrors the columns in the Prisma Agent model / `UpdateAgentDto`.
    public let description: String?
    public let appendSystemPrompt: String?
    public let systemPrompt: String?
    public let allowedTools: [String]?
    public let disallowedTools: [String]?
    public let maxTurns: Int?
    public let maxBudgetUsd: Double?
    public let targetRunnerId: String?
    public let targetLabels: [String]?
    public let runnerId: String?
    public let env: [String: String]?
    public let enabled: Bool?
    public let autoInitGit: Bool?
}

public struct Runner: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let status: RunnerStatus?
    public let online: Bool?
    public let version: String?
    public let maxConcurrent: Int?
    public let displayName: String?
    // Reported on the GET /runners payload (renamed from availableSkills/availableCommands).
    public let skills: [SlashCommandInfo]?
    public let commands: [SlashCommandInfo]?
    // List-view extras: live slot usage, last heartbeat, and provider quota.
    public let activeSessions: Int?
    public let lastHeartbeatAt: String?
    public let planUsage: PlanUsage?
    public let modelCatalog: RunnerModelCatalog?
}

/// A session row (list + detail share this; detail carries the extra worktree/stat fields).
public struct Session: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String?
    public let status: RunStatus
    public let agentId: String?
    public let assignedRunnerId: String?
    public let provider: String?
    public let pendingApprovals: Int?
    public let branch: String?
    public let updatedAt: String?
    /// When the session was created / last had a turn (ISO-8601 strings). These drive the Agent
    /// console's ordering — most-recent activity first, falling back to `createdAt` for a
    /// never-run (queued) session — mirroring web's client-side sort. See `SessionFilter`.
    public let createdAt: String?
    public let lastTurnAt: String?
    /// When this session was pinned to the top of its list (ISO-8601 string), or nil if unpinned.
    /// The list payload already sorts pinned sessions first; the row draws a leading accent bar to
    /// mark the state at rest, mirroring web's `.session-row.pinned`.
    public let pinnedAt: String?
    /// The session's stored config. A LIVE session's composer shows these (the server's
    /// choice); before the session exists the pills reflect local picks instead.
    public let model: String?
    public let permissionMode: String?
    public let effort: String?
    /// How the session was created: "user" (default) or "system" (auto-created, e.g. a
    /// task-execution session). The Active query returns both; the Agent console hides system
    /// sessions from its Active tab and gives them a dedicated System tab — see `SessionFilter`.
    public let source: String?
    /// The list row's second-line preview, built by `SessionLine`: the (server-truncated) last
    /// assistant reply, the tool currently in flight, and the live background-shell count.
    public let lastAssistantText: String?
    public let lastToolUse: String?
    /// The message you just sent, surfaced while a turn is running but the agent hasn't replied
    /// yet — the server sets it while the user turn is the frontier and clears it once a reply or
    /// tool lands, so the row shows your pending message instead of the now-stale previous reply.
    public let lastUserText: String?
    public let runningBgCount: Int?
    /// Terminal-state detail the status glyph needs (mirrors web `StatusIcon`): `error` tells a
    /// runner-offline disconnect apart from a real crash; `endReason` tells a benign recycle
    /// (idle / task-done / user-ended — shown as dormant) apart from a hard cancel/orphan.
    public let error: String?
    public let endReason: String?
    /// The owning agent, nested by the list/detail payloads (the flat `agentId` is NOT sent
    /// there, so per-agent grouping reads `agent.id`).
    public let agent: SessionAgentRef?
    /// The personal colored tags applied to this session, server-ordered (system tags first, then
    /// by position). Empty/absent when untagged or from an older server. Drives the row's tag dots
    /// and the list's tag filter/grouping — see `SessionFilter` / `SessionTimeGrouping`.
    public let tags: [SessionTag]?

    public init(id: String, title: String?, status: RunStatus, agentId: String?,
                assignedRunnerId: String?, provider: String? = nil,
                pendingApprovals: Int?, branch: String?,
                updatedAt: String?, model: String? = nil, permissionMode: String? = nil,
                effort: String? = nil, source: String? = nil, lastAssistantText: String? = nil,
                lastToolUse: String? = nil, lastUserText: String? = nil, runningBgCount: Int? = nil,
                error: String? = nil, endReason: String? = nil, agent: SessionAgentRef? = nil,
                pinnedAt: String? = nil, createdAt: String? = nil, lastTurnAt: String? = nil,
                tags: [SessionTag]? = nil) {
        self.id = id
        self.title = title
        self.status = status
        self.agentId = agentId
        self.assignedRunnerId = assignedRunnerId
        self.provider = provider
        self.pendingApprovals = pendingApprovals
        self.branch = branch
        self.updatedAt = updatedAt
        self.model = model
        self.permissionMode = permissionMode
        self.effort = effort
        self.source = source
        self.lastAssistantText = lastAssistantText
        self.lastToolUse = lastToolUse
        self.lastUserText = lastUserText
        self.runningBgCount = runningBgCount
        self.error = error
        self.endReason = endReason
        self.agent = agent
        self.pinnedAt = pinnedAt
        self.createdAt = createdAt
        self.lastTurnAt = lastTurnAt
        self.tags = tags
    }
}

/// The agent nested on a session row (`{id, name, model}`).
public struct SessionAgentRef: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String?
    public let provider: String?
    public let model: String?
}

/// A personal colored label (Files.app-style tag) the owner applies to their sessions. The library
/// is fetched from `GET /session-tags` (system tags seeded + always present); each session carries
/// the subset applied to it. `color` is a #RRGGBB hex; `isSystem` marks the 7 preset-color tags,
/// which are selectable but can't be renamed, recolored, or deleted. `position` orders the picker
/// and the row dots (system first).
public struct SessionTag: Codable, Equatable, Sendable, Identifiable, Hashable {
    public let id: String
    public let name: String
    public let color: String
    public let isSystem: Bool
    public let position: Int
    public init(id: String, name: String, color: String, isSystem: Bool = false, position: Int = 0) {
        self.id = id
        self.name = name
        self.color = color
        self.isSystem = isSystem
        self.position = position
    }
}

/// POST /session-tags — create a custom tag (name + #RRGGBB palette color).
public struct CreateSessionTagRequest: Codable, Sendable {
    public let name: String
    public let color: String
    public init(name: String, color: String) { self.name = name; self.color = color }
}

/// PATCH /session-tags/:id — rename and/or recolor a custom tag (system tags are rejected server-side).
public struct UpdateSessionTagRequest: Codable, Sendable {
    public let name: String?
    public let color: String?
    public init(name: String? = nil, color: String? = nil) { self.name = name; self.color = color }
}

/// PUT /sessions/:id/tags — replace a session's full tag set (the picker sends the current selection).
public struct SetSessionTagsRequest: Codable, Sendable {
    public let tagIds: [String]
    public init(tagIds: [String]) { self.tagIds = tagIds }
}

/// POST /sessions/:id/turns — send a user message or raw shell command.
public struct SessionTurnRequest: Codable, Sendable {
    public let clientTurnId: String   // client UUID, idempotency key
    public let content: String
    public let kind: String           // "message" | "shell"
    public let attachmentIds: [String]?
    public init(clientTurnId: String, content: String, kind: String = "message", attachmentIds: [String]? = nil) {
        self.clientTurnId = clientTurnId
        self.content = content
        self.kind = kind
        self.attachmentIds = attachmentIds
    }
}

public struct TurnAccepted: Codable, Sendable {
    public let turnId: String?
    public let seq: Int?
    public let status: String?
}

/// POST /sessions — create a session with an initial prompt.
public struct CreateSessionRequest: Codable, Sendable {
    public let prompt: String
    public let title: String?
    public let agentId: String?
    public let assignedRunnerId: String?
    public let model: String?
    public let permissionMode: String?
    /// Claude effort level (low|medium|high|xhigh|max); nil omits the field (model default).
    public let effort: String?
    /// Seed the first turn as a `!cmd` shell turn (run on the runner, bypassing claude) instead
    /// of a normal message; nil/false → a normal prompt.
    public let shell: Bool?
    public let attachmentIds: [String]?
    public init(prompt: String, title: String? = nil, agentId: String? = nil, assignedRunnerId: String? = nil,
                model: String? = nil, permissionMode: String? = nil, effort: String? = nil,
                shell: Bool? = nil, attachmentIds: [String]? = nil) {
        self.prompt = prompt
        self.title = title
        self.agentId = agentId
        self.assignedRunnerId = assignedRunnerId
        self.model = model
        self.permissionMode = permissionMode
        self.effort = effort
        self.shell = shell
        self.attachmentIds = attachmentIds
    }
}

/// The durable approval record (GET /sessions/:id/approvals). Distinct from the live
/// `approval_request` SSE nudge; this is the source of truth on (re)connect.
public struct ApprovalInfo: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let toolName: String?
    public let status: String?
    public let input: JSONValue?
}

/// One background shell from GET /sessions/:id/background — the server's authoritative, complete
/// list of every Bash(run_in_background) the session launched, derived over ALL persisted events
/// with output recovered from the agent's Read polls of the `.output` file. Mirrors `BgShell` in
/// @orbit/shared; only the fields the tray needs are decoded. Seeds the reducer via `seedBackground`.
public struct BgShellDTO: Decodable, Sendable {
    public let shellId: String
    /// tool_use id of the launching Bash call — the key every live `background_*` event correlates
    /// on, so seeding under it lets live updates land on the same row.
    public let toolUseId: String
    public let command: String?
    public let description: String?
    /// Web status vocabulary: running | done | failed | killed | unknown.
    public let status: String
    public let latestOutput: String?
    public let startedTs: String?

    /// Map to the reducer's `BackgroundProc`: key by `toolUseId`, translate the web status vocab to
    /// the native one, and default a missing output to empty (the tray shows "No output captured yet").
    public func asBackgroundProc() -> BackgroundProc {
        BackgroundProc(id: toolUseId,
                       command: command,
                       description: description,
                       status: status == "done" ? "completed" : status,
                       outputTail: latestOutput ?? "",
                       startedAt: startedTs)
    }
}

public enum ApprovalBehavior: String, Codable, Sendable {
    case allow
    case deny
}

/// A session-scoped claude permission rule to add on "allow + remember same kind", so future
/// calls auto-allow without re-prompting. `toolName` is the gated tool ("Bash", "Edit"…);
/// `ruleContent` narrows it (Bash uses a command prefix like `git commit:*`) — omit to allow
/// every call to that tool. Mirrors `PermissionRule` in src/shared/src/dto.ts.
public struct PermissionRule: Codable, Equatable, Sendable {
    public let toolName: String
    public let ruleContent: String?
    public init(toolName: String, ruleContent: String? = nil) {
        self.toolName = toolName
        self.ruleContent = ruleContent
    }
}

/// POST /sessions/:id/approvals/:approvalId/decision
public struct ApprovalDecisionRequest: Codable, Sendable {
    public let behavior: ApprovalBehavior
    public let message: String?
    /// AskUserQuestion answers: question text → selected labels.
    public let answers: [String: [String]]?
    /// Optional "remember this kind" rule.
    public let rememberRule: PermissionRule?
    public init(behavior: ApprovalBehavior, message: String? = nil,
                answers: [String: [String]]? = nil, rememberRule: PermissionRule? = nil) {
        self.behavior = behavior
        self.message = message
        self.answers = answers
        self.rememberRule = rememberRule
    }
}

/// A single file's unified diff (GET /sessions/:id/diff → `{ patches: [FilePatch] }`).
/// Mirrors `FilePatch` in src/shared/src/dto.ts.
public struct FilePatch: Codable, Equatable, Sendable, Identifiable {
    public let path: String
    public let patch: String?
    public let truncated: Bool?
    public var id: String { path }
}

public struct SessionDiff: Codable, Equatable, Sendable {
    public let patches: [FilePatch]
}

/// One file changed by a worktree-isolated session — the compact diff summary the runner computes
/// (`git diff base..branch`). `status` is the git name-status letter (A/M/D/R/…); `additions` /
/// `deletions` are -1 for a binary file. Mirrors `ChangedFile` in src/shared/src/dto.ts (web's
/// `SessionChangedFile`) and rides on the `SessionDetail` payload, not the `/diff` side-table.
public struct SessionChangedFile: Codable, Equatable, Sendable, Identifiable {
    public let path: String
    public let additions: Int
    public let deletions: Int
    public let status: String
    public var id: String { path }
    public init(path: String, additions: Int, deletions: Int, status: String) {
        self.path = path
        self.additions = additions
        self.deletions = deletions
        self.status = status
    }
}

/// The agent nested on a session detail, as the worktree bar reads it: the id plus the agent's
/// remembered default merge target (set when the user last switched targets in the merge dropdown;
/// nil = the runner's auto-detected default). Distinct from `SessionAgentRef` (list rows), which
/// carries name/model instead of the merge target.
public struct SessionDetailAgent: Codable, Equatable, Sendable {
    public let id: String
    public let defaultMergeTarget: String?
    public init(id: String, defaultMergeTarget: String? = nil) {
        self.id = id
        self.defaultMergeTarget = defaultMergeTarget
    }
}

/// GET /sessions/:id — a single session's detail. Only the worktree-status-bar fields are typed
/// (Codable ignores the rest of the payload); they mirror the same-named fields on web's
/// `SessionDetail` and drive `WorktreeBarLogic`. The runner reports the live state each heartbeat
/// (mid-turn diff / `worktreeDirty`) and the settled state at completion; merge/commit outcomes
/// land on `mergeStatus` / `commitStatus` a heartbeat after the user acts. Optional throughout:
/// older runners omit fields, and they're all null before the first worktree report.
public struct SessionDetail: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    /// The isolated branch this session's work lives on (`orbit/<slug>-<hash>`), or nil pre-isolation.
    public let branch: String?
    /// What the runner did: "worktree" (isolated) | "shared-nogit" (no git → the shared workDir).
    public let isolationStatus: String?
    /// Per-file diff summary of the worktree vs its base; empty when nothing changed.
    public let changedFiles: [SessionChangedFile]?
    /// True while the worktree has uncommitted changes (drives Commit vs Merge). Nil = not reported.
    public let worktreeDirty: Bool?
    /// "Merge to main" outcome: pending | merged | conflict | error. Nil until the user merges.
    public let mergeStatus: String?
    public let mergeError: String?
    /// The branch the last merge targeted (nil = the runner's auto-detected default).
    public let mergeTarget: String?
    /// Candidate target branches for the "Merge to…" dropdown (empty/nil for older runners).
    public let mergeTargets: [String]?
    /// True when the branch tip already landed in the default target — the bar shows a "✓ In main"
    /// chip instead of a redundant Merge button.
    public let branchMerged: Bool?
    /// Commit outcome: pending | committed | nochange | error. Nil until the user commits.
    public let commitStatus: String?
    public let commitError: String?
    public let agent: SessionDetailAgent?
    /// The public read-only share token, or nil when the session isn't shared. The owner GET
    /// returns it (Prisma `include`, no `select`), so the Share sheet reads it to seed its
    /// create-vs-revoke state. The shared page lives at `<baseURL>/s/<shareToken>`.
    public let shareToken: String?

    public init(id: String, branch: String? = nil, isolationStatus: String? = nil,
                changedFiles: [SessionChangedFile]? = nil, worktreeDirty: Bool? = nil,
                mergeStatus: String? = nil, mergeError: String? = nil, mergeTarget: String? = nil,
                mergeTargets: [String]? = nil, branchMerged: Bool? = nil,
                commitStatus: String? = nil, commitError: String? = nil,
                agent: SessionDetailAgent? = nil, shareToken: String? = nil) {
        self.id = id
        self.branch = branch
        self.isolationStatus = isolationStatus
        self.changedFiles = changedFiles
        self.worktreeDirty = worktreeDirty
        self.mergeStatus = mergeStatus
        self.mergeError = mergeError
        self.mergeTarget = mergeTarget
        self.mergeTargets = mergeTargets
        self.branchMerged = branchMerged
        self.commitStatus = commitStatus
        self.commitError = commitError
        self.agent = agent
        self.shareToken = shareToken
    }
}

/// POST /sessions/:id/share response — the minted (or, idempotently, the already-existing) public
/// share token. The read-only page it unlocks lives at `<baseURL>/s/<shareToken>`.
public struct ShareInfo: Codable, Equatable, Sendable {
    public let shareToken: String
    public let sharedAt: String
    public init(shareToken: String, sharedAt: String) {
        self.shareToken = shareToken
        self.sharedAt = sharedAt
    }
}

public struct AttachmentRef: Codable, Sendable {
    public let id: String
}

/// POST /sessions/:id/resume — revive a terminal-but-resumable session with a new turn.
public struct ResumeRequest: Codable, Sendable {
    public let clientTurnId: String
    public let content: String
    public let kind: String?
    public let model: String?
    public let permissionMode: String?
    public let effort: String?
    /// Ids of pre-uploaded image attachments (already scoped to this session) to link to the
    /// reviving turn. nil omits the field (text-only resume). Without this a resume of a dormant
    /// session drops staged images — the durable `user` event then reconciles the optimistic
    /// bubble away, so the image vanishes and the runner never receives it.
    public let attachmentIds: [String]?
    public init(clientTurnId: String, content: String, kind: String? = nil,
                model: String? = nil, permissionMode: String? = nil, effort: String? = nil,
                attachmentIds: [String]? = nil) {
        self.clientTurnId = clientTurnId
        self.content = content
        self.kind = kind
        self.model = model
        self.permissionMode = permissionMode
        self.effort = effort
        self.attachmentIds = attachmentIds
    }
}

/// PATCH /sessions/:id/config — change model / permission-mode / effort mid-session.
public struct ConfigUpdateRequest: Codable, Sendable {
    public let model: String?
    public let permissionMode: String?
    public let effort: String?
    public init(model: String? = nil, permissionMode: String? = nil, effort: String? = nil) {
        self.model = model
        self.permissionMode = permissionMode
        self.effort = effort
    }
}

/// POST /sessions/:id/merge — merge the session branch into `targetBranch` (default when nil).
public struct MergeRequest: Codable, Sendable {
    public let targetBranch: String?
    public init(targetBranch: String? = nil) { self.targetBranch = targetBranch }
}
