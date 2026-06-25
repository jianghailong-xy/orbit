import Foundation

// REST request/response models mirroring the apiserver. Fields are generously optional so a
// newer/older server shape decodes rather than throwing. Only what Phase 0 needs is modeled;
// extend as the app grows.

public struct User: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let email: String
    public let name: String?
    public let role: String?
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
    public let model: String?
    public let permissionMode: String?
    public let workDir: String?
}

public struct Runner: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let status: RunnerStatus?
    public let online: Bool?
    public let version: String?
    public let maxConcurrent: Int?
}

/// A session row (list + detail share this; detail carries the extra worktree/stat fields).
public struct Session: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String?
    public let status: RunStatus
    public let agentId: String?
    public let assignedRunnerId: String?
    public let pendingApprovals: Int?
    public let branch: String?
    public let updatedAt: String?
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
    public let attachmentIds: [String]?
    public init(prompt: String, title: String? = nil, agentId: String? = nil, assignedRunnerId: String? = nil,
                model: String? = nil, permissionMode: String? = nil, attachmentIds: [String]? = nil) {
        self.prompt = prompt
        self.title = title
        self.agentId = agentId
        self.assignedRunnerId = assignedRunnerId
        self.model = model
        self.permissionMode = permissionMode
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
    public init(clientTurnId: String, content: String, kind: String? = nil,
                model: String? = nil, permissionMode: String? = nil) {
        self.clientTurnId = clientTurnId
        self.content = content
        self.kind = kind
        self.model = model
        self.permissionMode = permissionMode
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
