import Foundation

// Public links (docs/share-links-design.md §4–§5): a `share_link` row of its own, rooted at exactly
// one session, task or project, with the layers it includes, an expiry, and how often it was
// opened. The public address is `<baseURL>/s/<token>`. Mirrors `src/web/src/api.ts` (`ShareLink`
// and its neighbours) and the owner view `share-links.service.ts` answers.

/// What a link is rooted at. Each kind's owner endpoints hang off the root's own path:
/// `GET | PUT | DELETE /{sessions|tasks|projects}/:id/share`.
public enum ShareRootKind: String, Codable, Sendable, CaseIterable {
    case session = "SESSION"
    case task = "TASK"
    case project = "PROJECT"

    /// The path segment the root's `…/:id/share` endpoints live under.
    public var pathSegment: String {
        switch self {
        case .session: return "sessions"
        case .task: return "tasks"
        case .project: return "projects"
        }
    }
}

/// A layer a link can turn on or off. Which of them a link has depends on its root. The root's own
/// content — a session's Messages, a task's or a project's Overview — is not one of them: every link
/// includes it.
public enum ShareLayer: String, Codable, Sendable, CaseIterable {
    case taskPages, commentsAndFiles, conversations, toolOutput
}

/// The layers a link includes. The owner read answers every layer its root has, resolved over the
/// defaults, and leaves out the ones it does not have. As a `PUT` body a field left nil is left as
/// it is, so a switch sends only its own layer.
public struct ShareInclude: Codable, Equatable, Sendable {
    public var taskPages: Bool?
    public var commentsAndFiles: Bool?
    public var conversations: Bool?
    public var toolOutput: Bool?

    public init(taskPages: Bool? = nil, commentsAndFiles: Bool? = nil, conversations: Bool? = nil,
                toolOutput: Bool? = nil) {
        self.taskPages = taskPages
        self.commentsAndFiles = commentsAndFiles
        self.conversations = conversations
        self.toolOutput = toolOutput
    }

    public subscript(layer: ShareLayer) -> Bool? {
        get {
            switch layer {
            case .taskPages: return taskPages
            case .commentsAndFiles: return commentsAndFiles
            case .conversations: return conversations
            case .toolOutput: return toolOutput
            }
        }
        set {
            switch layer {
            case .taskPages: taskPages = newValue
            case .commentsAndFiles: commentsAndFiles = newValue
            case .conversations: conversations = newValue
            case .toolOutput: toolOutput = newValue
            }
        }
    }
}

/// ACTIVE opens; PAUSED is a session in the Trash (it opens again once restored); ENDED is turned
/// off or expired, for good. A state this build does not know reads as `unknown` rather than
/// failing the read that carried it.
public enum ShareLinkState: String, Codable, Sendable {
    case active = "ACTIVE"
    case paused = "PAUSED"
    case ended = "ENDED"
    case unknown = "UNKNOWN"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ShareLinkState(rawValue: raw) ?? .unknown
    }
}

/// The root a link is for, named and placed: a session root also says where it is filed and when
/// it completed.
public struct ShareRootSummary: Codable, Equatable, Sendable {
    public let id: String
    public let title: String?
    public let status: String?
    public let lifecycleState: String?
    public let completedAt: String?

    public init(id: String, title: String? = nil, status: String? = nil, lifecycleState: String? = nil,
                completedAt: String? = nil) {
        self.id = id
        self.title = title
        self.status = status
        self.lifecycleState = lifecycleState
        self.completedAt = completedAt
    }
}

/// One link as its owner sees it.
public struct ShareLink: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let kind: ShareRootKind
    public let token: String
    public let include: ShareInclude
    /// Nil is Never.
    public let expiresAt: String?
    public let revokedAt: String?
    /// How many times its root page was opened — Preview, paging and sub-pages do not count.
    public let viewCount: Int
    public let lastViewedAt: String?
    public let createdAt: String
    public let updatedAt: String
    public let state: ShareLinkState
    /// `TURNED_OFF`, `EXPIRED` or `IN_TRASH`; nil while the link is ACTIVE.
    public let stateReason: String?
    public let root: ShareRootSummary

    public init(id: String, kind: ShareRootKind, token: String, include: ShareInclude = ShareInclude(),
                expiresAt: String? = nil, revokedAt: String? = nil, viewCount: Int = 0,
                lastViewedAt: String? = nil, createdAt: String = "", updatedAt: String = "",
                state: ShareLinkState = .active, stateReason: String? = nil, root: ShareRootSummary) {
        self.id = id
        self.kind = kind
        self.token = token
        self.include = include
        self.expiresAt = expiresAt
        self.revokedAt = revokedAt
        self.viewCount = viewCount
        self.lastViewedAt = lastViewedAt
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.state = state
        self.stateReason = stateReason
        self.root = root
    }
}

/// How much each of a root's layers holds, so the panel can say what a link exposes before anyone
/// opens it: a session's messages and tool calls; a task's comments, input files and transcripts; a
/// project's tasks, their comments and files, their runs, and the transcripts (the runs plus the
/// coordinator's conversation when it has one). A count the root does not have is absent.
public struct ShareCounts: Codable, Equatable, Sendable {
    public let messages: Int?
    public let toolCalls: Int?
    public let tasks: Int?
    public let comments: Int?
    public let files: Int?
    public let runs: Int?
    public let transcripts: Int?

    public init(messages: Int? = nil, toolCalls: Int? = nil, tasks: Int? = nil, comments: Int? = nil,
                files: Int? = nil, runs: Int? = nil, transcripts: Int? = nil) {
        self.messages = messages
        self.toolCalls = toolCalls
        self.tasks = tasks
        self.comments = comments
        self.files = files
        self.runs = runs
        self.transcripts = transcripts
    }
}

/// `GET /{sessions|tasks|projects}/:id/share`: the root's link that has not ended — nil when it has
/// none — with its layers' counts.
public struct ShareLinkRead: Codable, Equatable, Sendable {
    public let link: ShareLink?
    public let counts: ShareCounts?

    public init(link: ShareLink?, counts: ShareCounts? = nil) {
        self.link = link
        self.counts = counts
    }
}

/// `PUT /{sessions|tasks|projects}/:id/share`: open the root's link, or change the open one. A field
/// left out is left as it is; `expiresAt: .clear` is Never. Idempotent server-side.
public struct PutShareLinkRequest: Encodable, Equatable, Sendable {
    public var include: ShareInclude?
    public var expiresAt: FieldUpdate<String>

    public init(include: ShareInclude? = nil, expiresAt: FieldUpdate<String> = .keep) {
        self.include = include
        self.expiresAt = expiresAt
    }

    enum CodingKeys: String, CodingKey { case include, expiresAt }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(include, forKey: .include)
        try expiresAt.encode(into: &c, forKey: .expiresAt)
    }
}
