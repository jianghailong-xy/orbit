import Foundation

// The Drive chat's reads and writes (src/shared/src/driveChat.ts; apiserver drive/drive-chat.controller.ts and
// drive/drive-chat-changes.controller.ts): `GET`/`POST /drive/chats`, a chat's change groups with Undo and Apply, and the
// overwrite questions it asks. Every field an older server may leave out decodes to its empty value.

// MARK: - the chats: `GET /drive/chats`

/// The workspace a Drive chat runs in, as the list names it.
public struct DriveChatWorkspace: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    /// Its machine's name; nil when it has none.
    public let runner: String?
    public let online: Bool

    public init(id: String, name: String, runner: String? = nil, online: Bool = true) {
        self.id = id
        self.name = name
        self.runner = runner
        self.online = online
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        runner = try c.decodeIfPresent(String.self, forKey: .runner)
        online = try c.decodeIfPresent(Bool.self, forKey: .online) ?? true
    }
}

/// One Drive chat, as the list names it.
public struct DriveChatRow: Codable, Equatable, Sendable {
    public let sessionId: String
    public let title: String
    public let status: String
    /// Not ended and not in Trash: it takes messages.
    public let open: Bool
    public let completed: Bool
    /// A turn of it is queued or running.
    public let working: Bool
    /// Its approvals and questions waiting on the owner.
    public let needsYou: Int
    public let workspaceId: String?
    public let createdAt: String?
    public let updatedAt: String?
    public let lastActiveAt: String?

    public init(sessionId: String, title: String = "", status: String = "", open: Bool = true, completed: Bool = false,
                working: Bool = false, needsYou: Int = 0, workspaceId: String? = nil, createdAt: String? = nil,
                updatedAt: String? = nil, lastActiveAt: String? = nil) {
        self.sessionId = sessionId
        self.title = title
        self.status = status
        self.open = open
        self.completed = completed
        self.working = working
        self.needsYou = needsYou
        self.workspaceId = workspaceId
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.lastActiveAt = lastActiveAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? ""
        open = try c.decodeIfPresent(Bool.self, forKey: .open) ?? true
        completed = try c.decodeIfPresent(Bool.self, forKey: .completed) ?? false
        working = try c.decodeIfPresent(Bool.self, forKey: .working) ?? false
        needsYou = try c.decodeIfPresent(Int.self, forKey: .needsYou) ?? 0
        workspaceId = try c.decodeIfPresent(String.self, forKey: .workspaceId)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt)
        lastActiveAt = try c.decodeIfPresent(String.self, forKey: .lastActiveAt)
    }
}

/// `GET /drive/chats`.
public struct DriveChatList: Codable, Equatable, Sendable {
    public struct Fab: Codable, Equatable, Sendable {
        public let needsYou: Int
        public let working: Bool

        public init(needsYou: Int = 0, working: Bool = false) {
            self.needsYou = needsYou
            self.working = working
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            needsYou = try c.decodeIfPresent(Int.self, forKey: .needsYou) ?? 0
            working = try c.decodeIfPresent(Bool.self, forKey: .working) ?? false
        }
    }

    /// The workspace a new chat runs in when it names none ("Runs in"), or nil when there is none.
    public let workspace: DriveChatWorkspace?
    /// `LAST_CHAT` or `ORBIT_CLOUD`; nil with no workspace.
    public let workspaceFrom: String?
    public let fab: Fab
    public let chats: [DriveChatRow]
    public let more: Bool

    public init(workspace: DriveChatWorkspace? = nil, workspaceFrom: String? = nil, fab: Fab = Fab(),
                chats: [DriveChatRow] = [], more: Bool = false) {
        self.workspace = workspace
        self.workspaceFrom = workspaceFrom
        self.fab = fab
        self.chats = chats
        self.more = more
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        workspace = try c.decodeIfPresent(DriveChatWorkspace.self, forKey: .workspace)
        workspaceFrom = try c.decodeIfPresent(String.self, forKey: .workspaceFrom)
        fab = try c.decodeIfPresent(Fab.self, forKey: .fab) ?? Fab()
        chats = try c.decodeIfPresent([DriveChatRow].self, forKey: .chats) ?? []
        more = try c.decodeIfPresent(Bool.self, forKey: .more) ?? false
    }
}

// MARK: - what a message carries, and a new chat

/// The folder the owner has open (nil for the drive's top level) and the items they selected, as ids: what a Drive
/// chat's later messages carry beside the words (`driveContext` on the session's turn and resume doors).
public struct DriveChatContext: Codable, Equatable, Sendable {
    public var folderId: String?
    public var entryIds: [String]

    public init(folderId: String?, entryIds: [String] = []) {
        self.folderId = folderId
        self.entryIds = entryIds
    }

    private enum CodingKeys: String, CodingKey { case folderId, entryIds }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        folderId = try c.decodeIfPresent(String.self, forKey: .folderId)
        entryIds = try c.decodeIfPresent([String].self, forKey: .entryIds) ?? []
    }

    /// `{ folderId, entryIds? }`: the folder always named, null at the top level; no selection, no `entryIds`.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        if let folderId { try c.encode(folderId, forKey: .folderId) } else { try c.encodeNil(forKey: .folderId) }
        if !entryIds.isEmpty { try c.encode(entryIds, forKey: .entryIds) }
    }
}

/// `POST /drive/chats`: the owner's first words and what the composer shows. The folder chip shown goes as `folderId`
/// (null at the top level); none shown goes as `noFolder`, so the agent is told of no folder rather than of the top
/// level.
public struct DriveChatCreateRequest: Encodable, Equatable, Sendable {
    public let text: String
    public let clientTurnId: String
    public let workspaceId: String?
    /// Nil sends `noFolder: true`.
    public let context: DriveChatContext?
    public let attachmentIds: [String]?
    public let model: String?
    public let permissionMode: String?
    public let effort: String?
    public let fastMode: Bool?

    public init(text: String, clientTurnId: String, workspaceId: String?, context: DriveChatContext?,
                attachmentIds: [String]? = nil, model: String? = nil, permissionMode: String? = nil,
                effort: String? = nil, fastMode: Bool? = nil) {
        self.text = text
        self.clientTurnId = clientTurnId
        self.workspaceId = workspaceId
        self.context = context
        self.attachmentIds = attachmentIds
        self.model = model
        self.permissionMode = permissionMode
        self.effort = effort
        self.fastMode = fastMode
    }

    private enum CodingKeys: String, CodingKey {
        case text, clientTurnId, workspaceId, folderId, noFolder, entryIds, attachmentIds, model, permissionMode, effort,
             fastMode
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(text, forKey: .text)
        try c.encode(clientTurnId, forKey: .clientTurnId)
        try c.encodeIfPresent(workspaceId, forKey: .workspaceId)
        if let context {
            if let folder = context.folderId { try c.encode(folder, forKey: .folderId) } else { try c.encodeNil(forKey: .folderId) }
            if !context.entryIds.isEmpty { try c.encode(context.entryIds, forKey: .entryIds) }
        } else {
            try c.encode(true, forKey: .noFolder)
        }
        try c.encodeIfPresent(attachmentIds, forKey: .attachmentIds)
        try c.encodeIfPresent(model, forKey: .model)
        try c.encodeIfPresent(permissionMode, forKey: .permissionMode)
        try c.encodeIfPresent(effort, forKey: .effort)
        try c.encodeIfPresent(fastMode, forKey: .fastMode)
    }
}

/// What making a Drive chat answers.
public struct DriveChatCreateAnswer: Decodable, Equatable, Sendable {
    public let sessionId: String
    public let chat: DriveChatRow?
    public let workspace: DriveChatWorkspace?
}

// MARK: - a chat's changes: `GET /drive/chats/:id/groups`

/// Where an entry was or went: its folder (id and path when known) and its name.
public struct DriveChatPlace: Codable, Equatable, Sendable {
    public let parentId: String?
    public let parentPath: String?
    public let name: String?

    public init(parentId: String? = nil, parentPath: String? = nil, name: String? = nil) {
        self.parentId = parentId
        self.parentPath = parentPath
        self.name = name
    }
}

/// One change of a group. `state` SKIPPED carries why Undo left it as it is.
public struct DriveChatChangeItem: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    /// `NEW_FOLDER`, `NEW_FILE`, `MOVE`, `RENAME`, `TRASH` or `EDIT`.
    public let kind: String
    public let entryId: String
    public let entryKind: String
    public let before: DriveChatPlace
    public let after: DriveChatPlace
    /// `DONE`, `UNDONE` or `SKIPPED`.
    public let state: String
    public let reason: String?

    public init(id: String, kind: String, entryId: String, entryKind: String = "FILE", before: DriveChatPlace = DriveChatPlace(),
                after: DriveChatPlace = DriveChatPlace(), state: String = "DONE", reason: String? = nil) {
        self.id = id
        self.kind = kind
        self.entryId = entryId
        self.entryKind = entryKind
        self.before = before
        self.after = after
        self.state = state
        self.reason = reason
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decode(String.self, forKey: .kind)
        entryId = try c.decodeIfPresent(String.self, forKey: .entryId) ?? ""
        entryKind = try c.decodeIfPresent(String.self, forKey: .entryKind) ?? ""
        before = try c.decodeIfPresent(DriveChatPlace.self, forKey: .before) ?? DriveChatPlace()
        after = try c.decodeIfPresent(DriveChatPlace.self, forKey: .after) ?? DriveChatPlace()
        state = try c.decodeIfPresent(String.self, forKey: .state) ?? "DONE"
        reason = try c.decodeIfPresent(String.self, forKey: .reason)
    }
}

/// One write held for Apply, as the agent asked for it.
public struct DriveChatHeldItem: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let kind: String
    public let entryId: String?
    public let name: String
    public let fromPath: String?
    public let toPath: String?
    /// `PENDING`, `APPLIED` or `SKIPPED`.
    public let state: String
    public let reason: String?

    public init(id: String, kind: String, entryId: String? = nil, name: String, fromPath: String? = nil,
                toPath: String? = nil, state: String = "PENDING", reason: String? = nil) {
        self.id = id
        self.kind = kind
        self.entryId = entryId
        self.name = name
        self.fromPath = fromPath
        self.toPath = toPath
        self.state = state
        self.reason = reason
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decode(String.self, forKey: .kind)
        entryId = try c.decodeIfPresent(String.self, forKey: .entryId)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        fromPath = try c.decodeIfPresent(String.self, forKey: .fromPath)
        toPath = try c.decodeIfPresent(String.self, forKey: .toPath)
        state = try c.decodeIfPresent(String.self, forKey: .state) ?? "PENDING"
        reason = try c.decodeIfPresent(String.self, forKey: .reason)
    }
}

/// What one turn of a Drive chat changed in Drive: one card with Undo, or Apply when it was held.
public struct DriveChatChangeGroup: Codable, Equatable, Sendable, Identifiable {
    /// `DONE`, `PENDING`, `APPLYING`, `UNDOING` or `UNDONE`.
    public enum Status: String, Codable, Equatable, Sendable {
        case done = "DONE", pending = "PENDING", applying = "APPLYING", undoing = "UNDOING", undone = "UNDONE"
    }

    public let id: String
    public let sessionId: String
    public let turnId: String
    public let status: Status
    public let held: Bool
    public let createdAt: String
    public let appliedAt: String?
    public let undoneAt: String?
    public let total: Int
    public let skipped: Int
    public let items: [DriveChatChangeItem]
    public let heldItems: [DriveChatHeldItem]

    public init(id: String, sessionId: String, turnId: String, status: Status, held: Bool = false, createdAt: String,
                appliedAt: String? = nil, undoneAt: String? = nil, total: Int, skipped: Int = 0,
                items: [DriveChatChangeItem] = [], heldItems: [DriveChatHeldItem] = []) {
        self.id = id
        self.sessionId = sessionId
        self.turnId = turnId
        self.status = status
        self.held = held
        self.createdAt = createdAt
        self.appliedAt = appliedAt
        self.undoneAt = undoneAt
        self.total = total
        self.skipped = skipped
        self.items = items
        self.heldItems = heldItems
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId) ?? ""
        turnId = try c.decodeIfPresent(String.self, forKey: .turnId) ?? ""
        status = try c.decode(Status.self, forKey: .status)
        held = try c.decodeIfPresent(Bool.self, forKey: .held) ?? false
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
        appliedAt = try c.decodeIfPresent(String.self, forKey: .appliedAt)
        undoneAt = try c.decodeIfPresent(String.self, forKey: .undoneAt)
        total = try c.decodeIfPresent(Int.self, forKey: .total) ?? 0
        skipped = try c.decodeIfPresent(Int.self, forKey: .skipped) ?? 0
        items = try c.decodeIfPresent([DriveChatChangeItem].self, forKey: .items) ?? []
        heldItems = try c.decodeIfPresent([DriveChatHeldItem].self, forKey: .heldItems) ?? []
    }
}

public struct DriveChatGroups: Decodable, Equatable, Sendable {
    public let groups: [DriveChatChangeGroup]
}

// MARK: - the overwrite questions: `GET /drive/chats/:id/questions`

/// One side of an overwrite question: a file as it was when the chat asked.
public struct DriveChatQuestionFile: Codable, Equatable, Sendable {
    public struct Writer: Codable, Equatable, Sendable {
        /// `OWNER`, `AGENT` or another kind.
        public let kind: String
        public let sessionId: String?
        public let sessionTitle: String?

        public init(kind: String, sessionId: String? = nil, sessionTitle: String? = nil) {
            self.kind = kind
            self.sessionId = sessionId
            self.sessionTitle = sessionTitle
        }
    }

    public let entryId: String
    public let path: String
    public let sizeBytes: Int
    public let modifiedAt: String
    public let lastWriter: Writer

    public init(entryId: String, path: String, sizeBytes: Int, modifiedAt: String, lastWriter: Writer) {
        self.entryId = entryId
        self.path = path
        self.sizeBytes = sizeBytes
        self.modifiedAt = modifiedAt
        self.lastWriter = lastWriter
    }
}

/// A move or rename a Drive chat asked for onto a live file, asked of the owner: Keep both or Replace.
public struct DriveChatQuestion: Codable, Equatable, Sendable, Identifiable {
    /// `OPEN`, `ANSWERING`, `ANSWERED` or `STALE`.
    public enum Status: String, Codable, Equatable, Sendable {
        case open = "OPEN", answering = "ANSWERING", answered = "ANSWERED", stale = "STALE"
    }

    public enum Choice: String, Codable, Equatable, Sendable {
        case keepBoth = "KEEP_BOTH", replace = "REPLACE"
    }

    public struct Outcome: Codable, Equatable, Sendable {
        public let entryId: String
        public let path: String
        public let name: String

        public init(entryId: String, path: String, name: String) {
            self.entryId = entryId
            self.path = path
            self.name = name
        }
    }

    public let id: String
    public let sessionId: String
    public let turnId: String
    public let status: Status
    public let choice: Choice?
    public let moving: DriveChatQuestionFile
    public let existing: DriveChatQuestionFile
    public let outcome: Outcome?
    public let reason: String?
    public let createdAt: String
    public let answeredAt: String?

    public init(id: String, sessionId: String, turnId: String, status: Status, choice: Choice? = nil,
                moving: DriveChatQuestionFile, existing: DriveChatQuestionFile, outcome: Outcome? = nil,
                reason: String? = nil, createdAt: String, answeredAt: String? = nil) {
        self.id = id
        self.sessionId = sessionId
        self.turnId = turnId
        self.status = status
        self.choice = choice
        self.moving = moving
        self.existing = existing
        self.outcome = outcome
        self.reason = reason
        self.createdAt = createdAt
        self.answeredAt = answeredAt
    }
}

public struct DriveChatQuestions: Decodable, Equatable, Sendable {
    public let questions: [DriveChatQuestion]
}

/// `POST /drive/chats/:id/questions/:questionId`.
public struct DriveChatAnswerRequest: Encodable, Equatable, Sendable {
    public let choice: DriveChatQuestion.Choice

    public init(choice: DriveChatQuestion.Choice) {
        self.choice = choice
    }
}
