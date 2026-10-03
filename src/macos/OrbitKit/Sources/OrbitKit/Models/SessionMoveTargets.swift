import Foundation

// `GET /sessions/:id/move-targets` (docs/session-folders-move-design.md §5.4): everything the Move
// panel's Move to Another Workspace group and its confirmation need. Whether a session can move, and
// where to, is judged on the server — only it has the runners' capabilities, liveness and engines —
// and its reasons are English sentences the panel shows as they are. Mirrors `SessionMoveTargets` in
// `src/shared/src/dto.ts`. Every field past the ids is read with `decodeIfPresent`, so a payload
// missing one still decodes.

/// A folder as the Move panel lists it: one of the session's own workspace's, or one of a workspace
/// it can move to, with how many sessions are filed in it.
public struct SessionMoveFolder: Codable, Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    public let name: String
    /// Sessions filed in it, those in Trash aside.
    public let sessionCount: Int

    public init(id: String, name: String, sessionCount: Int = 0) {
        self.id = id
        self.name = name
        self.sessionCount = sessionCount
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        name = try values.decode(String.self, forKey: .name)
        sessionCount = try values.decodeIfPresent(Int.self, forKey: .sessionCount) ?? 0
    }
}

/// How the agent's memory of the conversation comes along to a workspace (§5.2).
public enum SessionMoveConversation: String, Codable, Sendable {
    /// The same runner carries it over to the new directory as it is.
    case continues
    /// Another runner rebuilds it from Orbit's record, the earlier part summarized.
    case rebuilt
}

/// Another of the owner's workspaces, as a place to move a session to (§5.2).
public struct SessionMoveTarget: Codable, Equatable, Hashable, Sendable, Identifiable {
    public let workspaceId: String
    public let name: String
    /// What the workspace's next session would start on — the slug its brand mark is drawn for.
    public let provider: String
    public let runnerId: String?
    public let runnerName: String?
    /// An offline runner does not stop the move; the session's next message waits for it.
    public let runnerOnline: Bool
    public let workDir: String?
    /// Nil when the session can move here; otherwise why not, shown as it is.
    public let reason: String?
    /// How the conversation carries over; nil when the server named a way this client doesn't know.
    public let conversation: SessionMoveConversation?
    /// The folders the session can be filed in there.
    public let folders: [SessionMoveFolder]

    public var id: String { workspaceId }

    public init(workspaceId: String, name: String, provider: String = "claude", runnerId: String? = nil,
                runnerName: String? = nil, runnerOnline: Bool = true, workDir: String? = nil,
                reason: String? = nil, conversation: SessionMoveConversation? = .continues,
                folders: [SessionMoveFolder] = []) {
        self.workspaceId = workspaceId
        self.name = name
        self.provider = provider
        self.runnerId = runnerId
        self.runnerName = runnerName
        self.runnerOnline = runnerOnline
        self.workDir = workDir
        self.reason = reason
        self.conversation = conversation
        self.folders = folders
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        workspaceId = try values.decode(String.self, forKey: .workspaceId)
        name = try values.decode(String.self, forKey: .name)
        provider = try values.decodeIfPresent(String.self, forKey: .provider) ?? "claude"
        runnerId = try values.decodeIfPresent(String.self, forKey: .runnerId)
        runnerName = try values.decodeIfPresent(String.self, forKey: .runnerName)
        // Absent is not "offline": only the server's own false says the runner is away.
        runnerOnline = try values.decodeIfPresent(Bool.self, forKey: .runnerOnline) ?? true
        workDir = try values.decodeIfPresent(String.self, forKey: .workDir)
        reason = try values.decodeIfPresent(String.self, forKey: .reason)
        conversation = (try? values.decodeIfPresent(String.self, forKey: .conversation))
            .flatMap(SessionMoveConversation.init(rawValue:))
        folders = try values.decodeIfPresent([SessionMoveFolder].self, forKey: .folders) ?? []
    }
}

/// `GET /sessions/:id/move-targets`.
public struct SessionMoveTargets: Codable, Equatable, Sendable {
    public let workspaceId: String?
    public let folderId: String?
    /// The folders of the session's own workspace.
    public let folders: [SessionMoveFolder]
    /// Why the session cannot move to another workspace at all; nil when it can.
    public let reason: String?
    /// Idle but not ended: it has to be ended before it moves — the confirmation's End and Move.
    public let needsEnd: Bool
    /// The branch its changes stay on in the old workspace's repository.
    public let branch: String?
    /// Files the branch changed, and how many of those are not in `mergeTarget` yet.
    public let changedFiles: Int
    public let unmergedFiles: Int
    public let mergeTarget: String?
    public let targets: [SessionMoveTarget]

    public init(workspaceId: String? = nil, folderId: String? = nil, folders: [SessionMoveFolder] = [],
                reason: String? = nil, needsEnd: Bool = false, branch: String? = nil,
                changedFiles: Int = 0, unmergedFiles: Int = 0, mergeTarget: String? = nil,
                targets: [SessionMoveTarget] = []) {
        self.workspaceId = workspaceId
        self.folderId = folderId
        self.folders = folders
        self.reason = reason
        self.needsEnd = needsEnd
        self.branch = branch
        self.changedFiles = changedFiles
        self.unmergedFiles = unmergedFiles
        self.mergeTarget = mergeTarget
        self.targets = targets
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        workspaceId = try values.decodeIfPresent(String.self, forKey: .workspaceId)
        folderId = try values.decodeIfPresent(String.self, forKey: .folderId)
        folders = try values.decodeIfPresent([SessionMoveFolder].self, forKey: .folders) ?? []
        reason = try values.decodeIfPresent(String.self, forKey: .reason)
        needsEnd = try values.decodeIfPresent(Bool.self, forKey: .needsEnd) ?? false
        branch = try values.decodeIfPresent(String.self, forKey: .branch)
        changedFiles = try values.decodeIfPresent(Int.self, forKey: .changedFiles) ?? 0
        unmergedFiles = try values.decodeIfPresent(Int.self, forKey: .unmergedFiles) ?? 0
        mergeTarget = try values.decodeIfPresent(String.self, forKey: .mergeTarget)
        targets = try values.decodeIfPresent([SessionMoveTarget].self, forKey: .targets) ?? []
    }
}
