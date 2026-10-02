import Foundation

/// A folder the owner files sessions in (docs/session-folders-move-design.md §3). It belongs to
/// one workspace, a session is in at most one, and it is filing only: nothing that runs a session
/// reads it. `GET /session-folders` returns every folder the owner has, in every workspace — the
/// list for one workspace is the ones whose `workspaceId` is that workspace's id.
public struct SessionFolder: Codable, Equatable, Sendable, Identifiable, Hashable {
    public let id: String
    public let workspaceId: String
    public let name: String

    public init(id: String, workspaceId: String, name: String) {
        self.id = id
        self.workspaceId = workspaceId
        self.name = name
    }
}

/// POST /session-folders — a folder in one of the owner's workspaces. The server trims the name
/// and holds it to 1–60 characters; a name that workspace already has is a 409.
public struct CreateSessionFolderRequest: Codable, Sendable {
    public let workspaceId: String
    public let name: String
    public init(workspaceId: String, name: String) {
        self.workspaceId = workspaceId
        self.name = name
    }
}

/// PATCH /session-folders/:id — rename a folder, under the same rules as creating one.
public struct RenameSessionFolderRequest: Codable, Sendable {
    public let name: String
    public init(name: String) { self.name = name }
}

/// POST /sessions/:id/move — file a session in one of its workspace's folders, or in none.
public struct MoveSessionRequest: Encodable, Sendable {
    public let folderId: String?
    public init(folderId: String?) { self.folderId = folderId }

    private enum CodingKeys: String, CodingKey { case folderId }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        // An explicit null rather than an omitted key: "in no folder" is what the request asks for.
        try c.encode(folderId, forKey: .folderId)
    }
}
