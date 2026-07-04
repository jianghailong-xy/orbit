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
    public let runningBgCount: Int?
    /// Terminal-state detail the status glyph needs (mirrors web `StatusIcon`): `error` tells a
    /// runner-offline disconnect apart from a real crash; `endReason` tells a benign recycle
    /// (idle / task-done / user-ended — shown as dormant) apart from a hard cancel/orphan.
    public let error: String?
    public let endReason: String?
    /// The owning agent, nested by the list/detail payloads (the flat `agentId` is NOT sent
    /// there, so per-agent grouping reads `agent.id`).
    public let agent: SessionAgentRef?

    public init(id: String, title: String?, status: RunStatus, agentId: String?,
                assignedRunnerId: String?, provider: String? = nil,
                pendingApprovals: Int?, branch: String?,
                updatedAt: String?, model: String? = nil, permissionMode: String? = nil,
                effort: String? = nil, source: String? = nil, lastAssistantText: String? = nil,
                lastToolUse: String? = nil, runningBgCount: Int? = nil,
                error: String? = nil, endReason: String? = nil, agent: SessionAgentRef? = nil,
                pinnedAt: String? = nil, createdAt: String? = nil, lastTurnAt: String? = nil) {
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
        self.runningBgCount = runningBgCount
        self.error = error
        self.endReason = endReason
        self.agent = agent
        self.pinnedAt = pinnedAt
        self.createdAt = createdAt
        self.lastTurnAt = lastTurnAt
    }
}

/// The agent nested on a session row (`{id, name, model}`).
public struct SessionAgentRef: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String?
    public let provider: String?
    public let model: String?
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
    public init(clientTurnId: String, content: String, kind: String? = nil,
                model: String? = nil, permissionMode: String? = nil, effort: String? = nil) {
        self.clientTurnId = clientTurnId
        self.content = content
        self.kind = kind
        self.model = model
        self.permissionMode = permissionMode
        self.effort = effort
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
