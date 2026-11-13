import Foundation

// Main checkout Git (docs/main-checkout-git-contract.md): the wire shapes macOS and iOS read and send.
// Mirrors src/shared/src/mainCheckoutGit.ts; MainCheckoutTests holds both to
// src/shared/src/main-checkout-git.fixture.json.

/// The runner capability that unlocks the actions. Without it the clients draw the text and no buttons.
public let mainCheckoutGitCapability = "main-checkout-git/v1"

/// One changed path in the main checkout (`MainCheckoutFile`). Ignored files never appear; untracked ones do.
public struct MainCheckoutFile: Codable, Equatable, Sendable, Identifiable {
    public let path: String
    /// "M", "A" or "D" against HEAD, working tree included.
    public let status: String
    /// The working-tree blob id, or "-" when deleted. Absent from the changed card's file list.
    public var contentHash: String? = nil
    public var untracked: Bool? = nil
    public var binary: Bool? = nil
    public var additions: Int? = nil
    public var deletions: Int? = nil

    public var id: String { path }

    public init(path: String, status: String, contentHash: String? = nil, untracked: Bool? = nil,
                binary: Bool? = nil, additions: Int? = nil, deletions: Int? = nil) {
        self.path = path
        self.status = status
        self.contentHash = contentHash
        self.untracked = untracked
        self.binary = binary
        self.additions = additions
        self.deletions = deletions
    }
}

/// `GET /workspaces/:id/main-checkout` → `snapshot`.
public struct MainCheckoutSnapshot: Codable, Equatable, Sendable {
    public let root: String
    public var branch: String? = nil
    public var head: String? = nil
    public let state: String
    public var upstream: String? = nil
    public var ahead: Int? = nil
    public var behind: Int? = nil
    public let files: [MainCheckoutFile]
    public let fileCount: Int
    public let truncated: Bool
    public let fingerprint: String
    public let checkedAt: String

    public init(root: String, branch: String? = nil, head: String? = nil, state: String,
                upstream: String? = nil, ahead: Int? = nil, behind: Int? = nil,
                files: [MainCheckoutFile], fileCount: Int, truncated: Bool,
                fingerprint: String, checkedAt: String) {
        self.root = root
        self.branch = branch
        self.head = head
        self.state = state
        self.upstream = upstream
        self.ahead = ahead
        self.behind = behind
        self.files = files
        self.fileCount = fileCount
        self.truncated = truncated
        self.fingerprint = fingerprint
        self.checkedAt = checkedAt
    }
}

/// One file's patch, read on demand (`?diff=<path>`).
public struct MainCheckoutFileDiff: Codable, Equatable, Sendable {
    public let path: String
    public let binary: Bool
    public var patch: String? = nil
    public var patchTruncated: Bool? = nil

    public init(path: String, binary: Bool, patch: String? = nil, patchTruncated: Bool? = nil) {
        self.path = path
        self.binary = binary
        self.patch = patch
        self.patchTruncated = patchTruncated
    }
}

/// The branch is one a project lands on: Commit and Push say so first (§5), and never block.
public struct MainCheckoutManagedBranch: Codable, Equatable, Sendable {
    public let projectId: String
    public let projectTitle: String
    /// "integration-line" or "landing-target".
    public let role: String

    public init(projectId: String, projectTitle: String, role: String) {
        self.projectId = projectId
        self.projectTitle = projectTitle
        self.role = role
    }
}

public struct MainCheckoutInFlight: Codable, Equatable, Sendable {
    public let requestId: String
    public let kind: String
}

/// `GET /workspaces/:id/main-checkout` (the shared `MainCheckoutView`).
public struct MainCheckoutRead: Codable, Equatable, Sendable {
    public let snapshot: MainCheckoutSnapshot
    public var diffs: [MainCheckoutFileDiff]? = nil
    /// The runner declared the capability: draw the action buttons.
    public let actionsSupported: Bool
    public var managedBranch: MainCheckoutManagedBranch? = nil
    public var inFlight: MainCheckoutInFlight? = nil

    public init(snapshot: MainCheckoutSnapshot, diffs: [MainCheckoutFileDiff]? = nil, actionsSupported: Bool,
                managedBranch: MainCheckoutManagedBranch? = nil, inFlight: MainCheckoutInFlight? = nil) {
        self.snapshot = snapshot
        self.diffs = diffs
        self.actionsSupported = actionsSupported
        self.managedBranch = managedBranch
        self.inFlight = inFlight
    }
}

/// The four actions (§5).
public enum MainCheckoutActionKind: String, Codable, Equatable, Sendable, CaseIterable {
    case move, commit, push, rescue
}

/// `POST /workspaces/:id/main-checkout/actions` (`MainCheckoutActionPost`). Build it with the per-kind
/// factories, which leave out the fields a kind must not carry (the server answers 400 to a stray one).
public struct MainCheckoutActionPost: Encodable, Equatable, Sendable {
    public let kind: MainCheckoutActionKind
    public let root: String
    public let fingerprint: String
    public let files: [String]?
    public let message: String?
    public let targetSessionId: String?
    public let requestId: String
    /// The session the person pressed it in: the result line is written there.
    public let initiatedFromSessionId: String?

    private init(kind: MainCheckoutActionKind, root: String, fingerprint: String, files: [String]? = nil,
                 message: String? = nil, targetSessionId: String? = nil, requestId: String,
                 initiatedFromSessionId: String?) {
        self.kind = kind
        self.root = root
        self.fingerprint = fingerprint
        self.files = files
        self.message = message
        self.targetSessionId = targetSessionId
        self.requestId = requestId
        self.initiatedFromSessionId = initiatedFromSessionId
    }

    public static func move(root: String, fingerprint: String, files: [String], targetSessionId: String,
                            requestId: String, from sessionId: String?) -> Self {
        Self(kind: .move, root: root, fingerprint: fingerprint, files: files, targetSessionId: targetSessionId,
             requestId: requestId, initiatedFromSessionId: sessionId)
    }

    public static func commit(root: String, fingerprint: String, files: [String], message: String,
                              requestId: String, from sessionId: String?) -> Self {
        Self(kind: .commit, root: root, fingerprint: fingerprint, files: files,
             message: message.trimmingCharacters(in: .whitespacesAndNewlines),
             requestId: requestId, initiatedFromSessionId: sessionId)
    }

    public static func push(root: String, fingerprint: String, requestId: String, from sessionId: String?) -> Self {
        Self(kind: .push, root: root, fingerprint: fingerprint, requestId: requestId, initiatedFromSessionId: sessionId)
    }

    public static func rescue(root: String, fingerprint: String, requestId: String, from sessionId: String?) -> Self {
        Self(kind: .rescue, root: root, fingerprint: fingerprint, requestId: requestId, initiatedFromSessionId: sessionId)
    }
}

/// One action's outcome (`MainCheckoutActionResult`).
public struct MainCheckoutActionResult: Codable, Equatable, Sendable {
    public let requestId: String
    public let kind: MainCheckoutActionKind
    public let root: String
    /// "done", "partial", "refused" or "waiting".
    public let status: String
    public var code: String? = nil
    public var branch: String? = nil
    public var fileCount: Int? = nil
    public var remaining: Int? = nil
    public var rescueBranch: String? = nil
    public var head: String? = nil
    public var subject: String? = nil
    public var upstream: String? = nil
    public var remoteBefore: String? = nil
    public var remoteAfter: String? = nil
    public var targetSessionId: String? = nil
    public var targetBranch: String? = nil
    public var paths: [String]? = nil
    public var state: String? = nil
    public var ahead: Int? = nil
    public var behind: Int? = nil
    public var gitMessage: String? = nil
    public var runnerName: String? = nil
    public var minutes: Int? = nil
    public let finishedAt: String

    public init(requestId: String, kind: MainCheckoutActionKind, root: String, status: String,
                code: String? = nil, finishedAt: String) {
        self.requestId = requestId
        self.kind = kind
        self.root = root
        self.status = status
        self.code = code
        self.finishedAt = finishedAt
    }
}

/// `POST …/actions` and `…/cancel`: pending until the runner answers.
public struct MainCheckoutActionAnswer: Codable, Equatable, Sendable {
    public let requestId: String
    /// "pending" or "finished".
    public let status: String
    public var result: MainCheckoutActionResult? = nil
}

/// The `main-checkout-changed` system event's payload: the card (board 01).
public struct MainCheckoutChangedNotice: Codable, Equatable, Sendable {
    public let notice: String
    public let root: String
    public var branch: String? = nil
    public let files: [MainCheckoutFile]
    public let fileCount: Int
    public let truncated: Bool
    public let fingerprint: String

    public init(notice: String, root: String, branch: String? = nil, files: [MainCheckoutFile],
                fileCount: Int, truncated: Bool, fingerprint: String) {
        self.notice = notice
        self.root = root
        self.branch = branch
        self.files = files
        self.fileCount = fileCount
        self.truncated = truncated
        self.fingerprint = fingerprint
    }
}
