import Foundation

// The wiki chat — the Swift mirror of the client half of `@orbit/shared`'s `wikiChat.ts` (contract `chat`, the
// copy `docs.follow` and `docs.versions` name; docs/wiki-chat-design.md §3–§9, board 42 ⑤). A chat is a session
// docked beside a wiki page: its agent only drafts cards, the owner presses them, and the sections a press
// touched are rewritten. `WikiChatContractTests` holds the closed sets below to contracts/wiki.contract.json and
// the derivations in `WikiChatLogic` to `src/shared/src/wiki-chat.fixture.json`, which the shared spec reads too.
//
// As in `Wiki.swift`, a closed set decodes a value it has never heard of as `.unknown`, and a read's fields
// decode leniently, so a server one release apart draws fewer rows instead of failing the read.

// MARK: - closed sets

/// What a card drafts (contract `chat.drafts.kinds`).
public enum WikiChatDraftKind: String, Codable, Sendable, CaseIterable {
    case entry, rewrite, plan
    case unknown

    public init(from decoder: Decoder) throws {
        self = WikiChatDraftKind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
    }
}

/// Where a card stands (contract `chat.drafts.states`, design §7.3), derived on the server's read.
public enum WikiChatDraftState: String, Codable, Sendable, CaseIterable {
    case draft, replaced, changed, applied, discarded
    case notApplied = "not_applied"
    case undone
    case unknown

    public init(from decoder: Decoder) throws {
        self = WikiChatDraftState(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
    }
}

/// How a card's rewrite stands (contract `chat.drafts.results`, design §8.3).
public enum WikiChatRewriteResult: String, Codable, Sendable, CaseIterable {
    case rewriting, waiting, updated, same, failed, gone
    case unknown

    public init(from decoder: Decoder) throws {
        self = WikiChatRewriteResult(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
    }
}

/// The owner's presses (contract `chat.presses`): each a door of its own, `POST /wiki/chat-drafts/:id/<press>`.
public enum WikiChatPress: String, Codable, Sendable, CaseIterable {
    case apply, edit, discard, undo, retry, seen
}

/// What a card offers (contract `chat.drafts.actions`), each drawn with `WikiChatCopy.action`.
public enum WikiChatAction: String, Codable, Sendable, CaseIterable {
    case apply, edit, discard, rewrite
    case applyRebuild = "apply_rebuild"
    case openInPlan = "open_in_plan"
    case redo, undo
    case openEntry = "open_entry"
    case tryAgain = "try_again"
    case seeChanges = "see_changes"
    case settings
}

/// The round button's four looks (contract `chat.fab.states`, design §3).
public enum WikiChatFabState: String, Codable, Sendable, CaseIterable {
    case idle, working
    case needsYou = "needs_you"
    case updated
}

/// Why a rewrite waits (contract `docs.follow.waiting`), in the order the server looks for them.
public enum WikiDocsFollowWaiting: String, Codable, Sendable, CaseIterable {
    case maintenanceRunning = "maintenance_running"
    case buildRunning = "build_running"
    case planRunning = "plan_running"
    case rewriteRunning = "rewrite_running"
    case workerNotRunning = "worker_not_running"
    case modelUnconfigured = "model_unconfigured"
    case modelAuthFailed = "model_auth_failed"
    case modelDown = "model_down"
    case noWorkspace = "no_workspace"
    case runnerMissing = "runner_missing"
    case runnerOffline = "runner_offline"
    case runnerUpgrade = "runner_upgrade"
    case unknown

    public init(from decoder: Decoder) throws {
        self = WikiDocsFollowWaiting(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
    }
}

/// One op of an entry card (contract `chat.drafts.kinds.entry`): wiki_propose's ops.
public enum WikiChatOpKind: String, Codable, Sendable, CaseIterable {
    case add, reinforce, amend, supersede, retire, challenge
    case unknown

    public init(from decoder: Decoder) throws {
        self = WikiChatOpKind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
    }
}

/// Why a section was written again (contract `docs.versions.reasons`).
public enum WikiDocVersionReasonKind: String, Codable, Sendable, CaseIterable {
    case maintenance, build, merge, landing, chat, restore
    case unknown

    public init(from decoder: Decoder) throws {
        self = WikiDocVersionReasonKind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
    }
}

/// The owner's press a card's state is read from (contract `chat.drafts.derivation`).
public enum WikiChatDecision: String, Codable, Sendable, CaseIterable {
    case applied, edited, discarded
    case unknown

    public init(from decoder: Decoder) throws {
        self = WikiChatDecision(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
    }
}

// MARK: - what the derivations read (the fixture's shapes, and what a card read is cut down to)

/// What a card's state is read from (contract `chat.drafts.derivation`).
public struct WikiChatDraftFacts: Codable, Equatable, Sendable {
    public var decision: WikiChatDecision?
    public var undone: Bool
    public var replaced: Bool
    public var chatOpen: Bool
    public var baseMoved: Bool

    public init(decision: WikiChatDecision? = nil, undone: Bool = false, replaced: Bool = false,
                chatOpen: Bool = true, baseMoved: Bool = false) {
        self.decision = decision
        self.undone = undone
        self.replaced = replaced
        self.chatOpen = chatOpen
        self.baseMoved = baseMoved
    }
}

/// One op of an entry card, as much of it as its label needs.
public struct WikiChatDraftOp: Codable, Equatable, Sendable {
    public var op: WikiChatOpKind
    /// The new entry's kind, for an add.
    public var kind: String?
    /// Once pressed: its decision in the changeset the press recorded (`pending` for a challenge Review answers).
    public var decision: String?

    public init(op: WikiChatOpKind, kind: String? = nil, decision: String? = nil) {
        self.op = op
        self.kind = kind
        self.decision = decision
    }
}

/// One section a card rewrites, and how it came out once its rewrite settled.
public struct WikiChatSectionResult: Codable, Equatable, Sendable {
    /// "3.1 §3" (`WikiChatLogic.place`).
    public var place: String
    /// Nil until the rewrite settled; then updated, same, failed or gone.
    public var result: WikiChatRewriteResult?
    /// Sentences changed, for an updated section.
    public var changed: Int?

    public init(place: String, result: WikiChatRewriteResult? = nil, changed: Int? = nil) {
        self.place = place
        self.result = result
        self.changed = changed
    }

    private enum CodingKeys: String, CodingKey {
        case place = "where", result, changed
    }
}

/// A card's rewrite, as much of it as its line and its buttons read.
public struct WikiChatCardRewrite: Codable, Equatable, Sendable {
    public var result: WikiChatRewriteResult
    public var reason: WikiDocsFollowWaiting?
    /// origin/main's commit the job writes from, once its snapshot named one.
    public var sha: String?
    public var sections: [WikiChatSectionResult]
    /// The owner opened the settled result (the seen press).
    public var seen: Bool

    public init(result: WikiChatRewriteResult, reason: WikiDocsFollowWaiting? = nil, sha: String? = nil,
                sections: [WikiChatSectionResult] = [], seen: Bool = false) {
        self.result = result
        self.reason = reason
        self.sha = sha
        self.sections = sections
        self.seen = seen
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        result = try c.decodeIfPresent(WikiChatRewriteResult.self, forKey: .result) ?? .unknown
        reason = try c.decodeIfPresent(WikiDocsFollowWaiting.self, forKey: .reason)
        sha = try c.decodeIfPresent(String.self, forKey: .sha)
        sections = try c.decodeIfPresent([WikiChatSectionResult].self, forKey: .sections) ?? []
        seen = try c.decodeIfPresent(Bool.self, forKey: .seen) ?? false
    }
}

/// As much of a card as what it offers and whether it waits on the owner are read from.
public struct WikiChatCard: Codable, Equatable, Sendable {
    public var kind: WikiChatDraftKind
    public var state: WikiChatDraftState
    /// Every op is one the Undo can take back (contract `chat.presses.undo`), as the card read serves it.
    public var undoable: Bool
    public var rewrite: WikiChatCardRewrite?

    public init(kind: WikiChatDraftKind, state: WikiChatDraftState, undoable: Bool = false,
                rewrite: WikiChatCardRewrite? = nil) {
        self.kind = kind
        self.state = state
        self.undoable = undoable
        self.rewrite = rewrite
    }
}

/// One chat of a space, as the button counts it.
public struct WikiChatFabChat: Codable, Equatable, Sendable {
    /// One of the open session statuses, not in Trash.
    public var open: Bool
    /// A turn is queued or running.
    public var turnActive: Bool
    /// Approvals and questions the session waits on the owner for.
    public var approvals: Int
    public var cards: [WikiChatCard]

    public init(open: Bool, turnActive: Bool = false, approvals: Int = 0, cards: [WikiChatCard] = []) {
        self.open = open
        self.turnActive = turnActive
        self.approvals = approvals
        self.cards = cards
    }
}

/// The three counts the chats read serves for a space (contract `chat.fab.counts`).
public struct WikiChatFabCounts: Codable, Equatable, Sendable {
    public var needsYou: Int
    public var working: Bool
    public var updated: Int

    public init(needsYou: Int = 0, working: Bool = false, updated: Int = 0) {
        self.needsYou = needsYou
        self.working = working
        self.updated = updated
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        needsYou = try c.decodeIfPresent(Int.self, forKey: .needsYou) ?? 0
        working = try c.decodeIfPresent(Bool.self, forKey: .working) ?? false
        updated = try c.decodeIfPresent(Int.self, forKey: .updated) ?? 0
    }
}

// MARK: - the chats of a space: `GET /wiki/spaces/:id/chats`

/// A workspace the space's chats may run in (contract `chat.list.choices`), or the remembered one
/// (`chat.list.workspace`, which adds `eligible`).
public struct WikiChatWorkspace: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    /// Its machine, as Wiki settings' Workspaces card names it; nil when it has none.
    public let runner: String?
    public let online: Bool
    /// The remembered one's: whether it still qualifies (worktrees on, still the space's). Nil on a choice.
    public let eligible: Bool?

    public init(id: String, name: String, runner: String? = nil, online: Bool = true, eligible: Bool? = nil) {
        self.id = id
        self.name = name
        self.runner = runner
        self.online = online
        self.eligible = eligible
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        runner = try c.decodeIfPresent(String.self, forKey: .runner)
        online = try c.decodeIfPresent(Bool.self, forKey: .online) ?? true
        eligible = try c.decodeIfPresent(Bool.self, forKey: .eligible)
    }
}

/// One chat of a space (contract `chat.list.chats`), newest first.
public struct WikiChatRow: Codable, Equatable, Sendable, Identifiable {
    public let sessionId: String
    public let title: String
    public let status: String
    /// One of the open session statuses and not in Trash.
    public let open: Bool
    public let createdAt: String?
    public let updatedAt: String?
    /// How many cards it holds.
    public let drafts: Int
    /// How many of the button's `needsYou` are this chat's.
    public let needsYou: Int

    public var id: String { sessionId }

    public init(sessionId: String, title: String = "", status: String = "", open: Bool = true,
                createdAt: String? = nil, updatedAt: String? = nil, drafts: Int = 0, needsYou: Int = 0) {
        self.sessionId = sessionId
        self.title = title
        self.status = status
        self.open = open
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.drafts = drafts
        self.needsYou = needsYou
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? ""
        open = try c.decodeIfPresent(Bool.self, forKey: .open) ?? true
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt)
        drafts = try c.decodeIfPresent(Int.self, forKey: .drafts) ?? 0
        needsYou = try c.decodeIfPresent(Int.self, forKey: .needsYou) ?? 0
    }
}

/// `GET /wiki/spaces/:id/chats` (contract `chat.list`).
public struct WikiChatList: Codable, Equatable, Sendable {
    public let spaceId: String
    /// The remembered workspace as it stands now, or nil when none is remembered.
    public let workspace: WikiChatWorkspace?
    public let choices: [WikiChatWorkspace]
    public let fab: WikiChatFabCounts
    public let chats: [WikiChatRow]

    public init(spaceId: String, workspace: WikiChatWorkspace? = nil, choices: [WikiChatWorkspace] = [],
                fab: WikiChatFabCounts = WikiChatFabCounts(), chats: [WikiChatRow] = []) {
        self.spaceId = spaceId
        self.workspace = workspace
        self.choices = choices
        self.fab = fab
        self.chats = chats
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        spaceId = try c.decodeIfPresent(String.self, forKey: .spaceId) ?? ""
        workspace = try c.decodeIfPresent(WikiChatWorkspace.self, forKey: .workspace)
        choices = try c.decodeIfPresent([WikiChatWorkspace].self, forKey: .choices) ?? []
        fab = try c.decodeIfPresent(WikiChatFabCounts.self, forKey: .fab) ?? WikiChatFabCounts()
        chats = try c.decodeIfPresent([WikiChatRow].self, forKey: .chats) ?? []
    }
}

// MARK: - what a message attaches (contract `chat.notes.wikiContext`)

/// The page and the selection a chat message carries: ids only — the server reads the sentences again at delivery.
public struct WikiChatContext: Codable, Equatable, Sendable {
    public enum Page: Equatable, Sendable {
        case doc(docSlug: String, sectionKey: String)
        case entry(entryId: String)
        /// A plan page, at one of its document's sections when it shows one (C12).
        case plan(docSlug: String, sectionKey: String? = nil)
    }

    public struct Selection: Codable, Equatable, Sendable {
        public let docSlug: String
        public let sectionKey: String
        public let sentenceIds: [String]

        public init(docSlug: String, sectionKey: String, sentenceIds: [String]) {
            self.docSlug = docSlug
            self.sectionKey = sectionKey
            self.sentenceIds = sentenceIds
        }
    }

    public var page: Page?
    public var selection: Selection?

    public init(page: Page? = nil, selection: Selection? = nil) {
        self.page = page
        self.selection = selection
    }

    private enum CodingKeys: String, CodingKey { case page, selection }
    private enum PageKeys: String, CodingKey { case kind, docSlug, sectionKey, entryId }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        selection = try c.decodeIfPresent(Selection.self, forKey: .selection)
        if c.contains(.page) {
            let p = try c.nestedContainer(keyedBy: PageKeys.self, forKey: .page)
            switch try p.decode(String.self, forKey: .kind) {
            case "doc":   page = .doc(docSlug: try p.decode(String.self, forKey: .docSlug),
                                      sectionKey: try p.decode(String.self, forKey: .sectionKey))
            case "entry": page = .entry(entryId: try p.decode(String.self, forKey: .entryId))
            case "plan":  page = .plan(docSlug: try p.decode(String.self, forKey: .docSlug),
                                       sectionKey: try p.decodeIfPresent(String.self, forKey: .sectionKey))
            default:      page = nil
            }
        } else {
            page = nil
        }
    }

    /// `{ page?, selection? }`, in the keys the contract names and no others.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        if let page {
            var p = c.nestedContainer(keyedBy: PageKeys.self, forKey: .page)
            switch page {
            case .doc(let slug, let key):
                try p.encode("doc", forKey: .kind)
                try p.encode(slug, forKey: .docSlug)
                try p.encode(key, forKey: .sectionKey)
            case .entry(let id):
                try p.encode("entry", forKey: .kind)
                try p.encode(id, forKey: .entryId)
            case .plan(let slug, let key):
                try p.encode("plan", forKey: .kind)
                try p.encode(slug, forKey: .docSlug)
                try p.encodeIfPresent(key, forKey: .sectionKey)
            }
        }
        try c.encodeIfPresent(selection, forKey: .selection)
    }
}

/// `POST /wiki/spaces/:id/chats` (contract `chat.create.body`): the owner's first words, word for word.
public struct WikiChatCreateRequest: Encodable, Equatable, Sendable {
    public let workspaceId: String?
    public let content: String
    public let clientTurnId: String
    public let wikiContext: WikiChatContext?
    public let model: String?
    public let permissionMode: String?

    public init(workspaceId: String?, content: String, clientTurnId: String, wikiContext: WikiChatContext? = nil,
                model: String? = nil, permissionMode: String? = nil) {
        self.workspaceId = workspaceId
        self.content = content
        self.clientTurnId = clientTurnId
        self.wikiContext = wikiContext
        self.model = model
        self.permissionMode = permissionMode
    }
}

/// What making a chat answers (contract `chat.create.answer`).
public struct WikiChatCreateAnswer: Decodable, Equatable, Sendable {
    public let sessionId: String
    public let chat: WikiChatRow?
}

// MARK: - a card: `GET /wiki/chat-drafts/:id`, `GET /wiki/chats/:id/drafts`

/// A section a card names (contract `chat.drafts.read`, rewrites and sections).
public struct WikiChatDraftSection: Codable, Equatable, Sendable, Hashable {
    public let doc: String
    public let key: String
    /// "3.1 §3", or `slug §key` for a section the confirmed plan no longer numbers.
    public let place: String
    public let title: String?

    public init(doc: String, key: String, place: String, title: String? = nil) {
        self.doc = doc
        self.key = key
        self.place = place
        self.title = title
    }

    private enum CodingKeys: String, CodingKey {
        case doc, key, place = "where", title
    }
}

/// One op of an entry card (contract `chat.drafts.read`, ops): as checked, with its entry as it stands now.
public struct WikiChatDraftOpView: Codable, Equatable, Sendable, Identifiable {
    public let seq: Int
    public let op: WikiChatOpKind
    public let entryId: String?
    public let baseRevision: Int?
    /// The op as checked and redacted: what Apply records.
    public let payload: JSONValue?
    public let similar: [WikiSimilar]?
    public let tainted: Bool?
    /// The entry it is about as it stands now, or nil.
    public let entry: JSONValue?
    /// Once pressed: accepted, edited, or pending for a challenge Review answers.
    public let decision: String?

    public var id: Int { seq }
}

/// An applied card's rewrite (contract `chat.drafts.read`, rewrite).
public struct WikiChatDraftRewrite: Codable, Equatable, Sendable {
    public struct Section: Codable, Equatable, Sendable {
        public let doc: String?
        public let key: String?
        public let place: String
        public let result: WikiChatRewriteResult?
        public let changed: Int?
        public let versionId: String?

        private enum CodingKeys: String, CodingKey {
            case doc, key, place = "where", result, changed, versionId
        }
    }

    public let jobId: String?
    public let result: WikiChatRewriteResult
    public let reason: WikiDocsFollowWaiting?
    public let sha: String?
    public let sections: [Section]
    public let seen: Bool
    public let settledAt: String?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        jobId = try c.decodeIfPresent(String.self, forKey: .jobId)
        result = try c.decodeIfPresent(WikiChatRewriteResult.self, forKey: .result) ?? .unknown
        reason = try c.decodeIfPresent(WikiDocsFollowWaiting.self, forKey: .reason)
        sha = try c.decodeIfPresent(String.self, forKey: .sha)
        sections = try c.decodeIfPresent([Section].self, forKey: .sections) ?? []
        seen = try c.decodeIfPresent(Bool.self, forKey: .seen) ?? false
        settledAt = try c.decodeIfPresent(String.self, forKey: .settledAt)
    }

    /// As the line under the card and its buttons read it.
    public var card: WikiChatCardRewrite {
        WikiChatCardRewrite(result: result, reason: reason, sha: sha,
                            sections: sections.map { WikiChatSectionResult(place: $0.place, result: $0.result, changed: $0.changed) },
                            seen: seen)
    }
}

/// A plan card's change (contract `chat.drafts.read`, change; C12, C17): the documents it puts into the plan — each one
/// of the plan's by its slug, or a new one — in the plan's new order, and the sections it moves between them, against
/// the confirmed version it was drafted on, with the version its press made.
public struct WikiChatPlanChange: Codable, Equatable, Sendable {
    public struct Category: Codable, Equatable, Sendable {
        public let key: String
        public let title: String
        /// The change opens it: the plan had no such category.
        public let opens: Bool
    }

    /// One section a plan card adds, changes or removes in one of its documents.
    public struct Section: Codable, Equatable, Sendable {
        public let key: String
        public let title: String
        /// Its place in the document: 2 for `§2`.
        public let number: Int
        /// `added`, `changed` or `removed`.
        public let edit: String
        /// A changed one's fields that change (`chat.copy.planFields`'s keys).
        public let fields: [String]
        /// What it covers as the change has it, when it is added or its covers change.
        public let covers: String?
    }

    /// One document the card puts into the plan.
    public struct Doc: Codable, Equatable, Sendable {
        public let slug: String
        public let title: String
        /// "3.1": where the version the card was drafted on numbers it — a new one's, where the change puts it.
        public let number: String
        /// A document the plan did not have.
        public let added: Bool
        /// The category it is filed under, and whether the change opens it.
        public let category: Category
        /// Its own fields that change, in the schema's order (none for a new one).
        public let fields: [String]
        /// The sections it adds or changes, in its new order, then the ones it removes; a section moved in or out is a
        /// move, not here.
        public let sections: [Section]

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            slug = try c.decode(String.self, forKey: .slug)
            title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
            number = try c.decodeIfPresent(String.self, forKey: .number) ?? ""
            added = try c.decodeIfPresent(Bool.self, forKey: .added) ?? false
            category = try c.decode(Category.self, forKey: .category)
            fields = try c.decodeIfPresent([String].self, forKey: .fields) ?? []
            sections = try c.decodeIfPresent([Section].self, forKey: .sections) ?? []
        }
    }

    /// Where a moved section was, or where the change puts it: its document, that document's number, its key and its
    /// place (3 for `§3`).
    public struct Place: Codable, Equatable, Sendable {
        public let doc: String
        public let number: String
        public let key: String
        public let section: Int
    }

    /// A section a plan card moves from one of its documents to another.
    public struct Move: Codable, Equatable, Sendable {
        public let title: String
        public let from: Place
        public let to: Place
        /// Its fields that change besides its place, in the schema's order.
        public let fields: [String]
        /// Its covers as the change has them, when the move changes them.
        public let covers: String?

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
            from = try c.decode(Place.self, forKey: .from)
            to = try c.decode(Place.self, forKey: .to)
            fields = try c.decodeIfPresent([String].self, forKey: .fields) ?? []
            covers = try c.decodeIfPresent(String.self, forKey: .covers)
        }
    }

    /// The confirmed version the card was drafted on.
    public let baseVersion: Int
    /// The version its press made and confirmed; nil until it is pressed.
    public let version: Int?
    public let docs: [Doc]
    public let moves: [Move]

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        baseVersion = try c.decodeIfPresent(Int.self, forKey: .baseVersion) ?? 0
        version = try c.decodeIfPresent(Int.self, forKey: .version)
        docs = try c.decodeIfPresent([Doc].self, forKey: .docs) ?? []
        moves = try c.decodeIfPresent([Move].self, forKey: .moves) ?? []
    }
}

/// A card as the owner's door serves it (contract `chat.drafts.read`).
public struct WikiChatDraftView: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let sessionId: String
    public let kind: WikiChatDraftKind
    public let state: WikiChatDraftState
    /// "Add decision", "Rewrite from main" …: the card's name after `Draft · `.
    public let label: String
    /// The agent's own sentence for it.
    public let rationale: String?
    public let ops: [WikiChatDraftOpView]
    /// A rewrite card's own sections.
    public let sections: [WikiChatDraftSection]
    /// The sections its press rewrites, at most five (design §8.2).
    public let rewrites: [WikiChatDraftSection]
    public let similar: [WikiSimilar]
    /// The chat had read the web when it was drafted.
    public let tainted: Bool
    public let replaces: String?
    public let replacedBy: String?
    public let decision: WikiChatDecision?
    public let decidedAt: String?
    public let undoneAt: String?
    public let undoable: Bool
    public let changesetId: String?
    public let rewrite: WikiChatDraftRewrite?
    /// A plan card's change (contract `chat.drafts.read`, change; C12); nil on every other card, and on an older server.
    public let change: WikiChatPlanChange?
    public let createdAt: String?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId) ?? ""
        kind = try c.decodeIfPresent(WikiChatDraftKind.self, forKey: .kind) ?? .unknown
        state = try c.decodeIfPresent(WikiChatDraftState.self, forKey: .state) ?? .unknown
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
        rationale = try c.decodeIfPresent(String.self, forKey: .rationale)
        ops = try c.decodeIfPresent([WikiChatDraftOpView].self, forKey: .ops) ?? []
        sections = try c.decodeIfPresent([WikiChatDraftSection].self, forKey: .sections) ?? []
        rewrites = try c.decodeIfPresent([WikiChatDraftSection].self, forKey: .rewrites) ?? []
        similar = try c.decodeIfPresent([WikiSimilar].self, forKey: .similar) ?? []
        tainted = try c.decodeIfPresent(Bool.self, forKey: .tainted) ?? false
        replaces = try c.decodeIfPresent(String.self, forKey: .replaces)
        replacedBy = try c.decodeIfPresent(String.self, forKey: .replacedBy)
        decision = try c.decodeIfPresent(WikiChatDecision.self, forKey: .decision)
        decidedAt = try c.decodeIfPresent(String.self, forKey: .decidedAt)
        undoneAt = try c.decodeIfPresent(String.self, forKey: .undoneAt)
        undoable = try c.decodeIfPresent(Bool.self, forKey: .undoable) ?? false
        changesetId = try c.decodeIfPresent(String.self, forKey: .changesetId)
        rewrite = try c.decodeIfPresent(WikiChatDraftRewrite.self, forKey: .rewrite)
        change = try c.decodeIfPresent(WikiChatPlanChange.self, forKey: .change)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
    }

    /// As much of it as what it offers and whether it waits are read from.
    public var card: WikiChatCard {
        WikiChatCard(kind: kind, state: state, undoable: undoable, rewrite: rewrite?.card)
    }
}

/// `GET /wiki/chats/:id/drafts`: every card of a chat, oldest first.
public struct WikiChatDrafts: Codable, Equatable, Sendable {
    public let sessionId: String
    public let drafts: [WikiChatDraftView]

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId) ?? ""
        drafts = try c.decodeIfPresent([WikiChatDraftView].self, forKey: .drafts) ?? []
    }
}

/// What a press answers (contract `chat.presses`): the card as it now stands; `replayed` for the same press twice.
public struct WikiChatPressAnswer: Decodable, Equatable, Sendable {
    public let replayed: Bool
    public let draft: WikiChatDraftView

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        replayed = try c.decodeIfPresent(Bool.self, forKey: .replayed) ?? false
        draft = try c.decode(WikiChatDraftView.self, forKey: .draft)
    }

    private enum CodingKeys: String, CodingKey { case replayed, draft }
}

/// Edit's body (contract `chat.presses.edit`): the owner's version laid over the card's ops, shaped as an amend's changes.
public struct WikiChatEditRequest: Encodable, Equatable, Sendable {
    public struct Op: Encodable, Equatable, Sendable {
        public let seq: Int
        public let changes: WikiEntryChanges

        public init(seq: Int, changes: WikiEntryChanges) {
            self.seq = seq
            self.changes = changes
        }
    }

    public let ops: [Op]

    public init(ops: [Op]) {
        self.ops = ops
    }
}

// MARK: - a section's versions (contract `docs.versions`)

/// Why a section was written again, as a version keeps it.
public struct WikiDocVersionReason: Codable, Equatable, Sendable {
    public var kind: WikiDocVersionReasonKind
    /// The session's, task's, project's or chat's title, for merge, landing and chat.
    public var title: String?
    /// The commit a merge or landing put on main.
    public var sha: String?
    /// The plan version a build wrote.
    public var planVersion: Int?

    public init(kind: WikiDocVersionReasonKind, title: String? = nil, sha: String? = nil, planVersion: Int? = nil) {
        self.kind = kind
        self.title = title
        self.sha = sha
        self.planVersion = planVersion
    }
}

/// A section's latest change, as the document read gives it (contract `docs.versions.reads.doc`): the page marks
/// `Updated` beside a section written since the reader last looked.
public struct WikiDocSectionChange: Codable, Equatable, Sendable {
    public let versionId: String
    public let reason: WikiDocVersionReason?
    public let at: String
    public let changed: Int?
}

/// One sentence of the comparison See changes draws (contract `docs.versions.compare`).
public struct WikiDocSentenceRow: Codable, Equatable, Sendable {
    public enum Op: String, Codable, Sendable {
        case same, removed, added
        case unknown

        public init(from decoder: Decoder) throws {
            self = Op(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
        }
    }

    public let op: Op
    public let text: String

    public init(op: Op, text: String) {
        self.op = op
        self.text = text
    }
}

/// One version a section kept, compared sentence by sentence with the text that replaced it.
public struct WikiDocSectionVersion: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let reason: WikiDocVersionReason?
    /// When it was replaced.
    public let at: String?
    public let changed: Int
    public let rows: [WikiDocSentenceRow]

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        reason = try c.decodeIfPresent(WikiDocVersionReason.self, forKey: .reason)
        at = try c.decodeIfPresent(String.self, forKey: .at)
        changed = try c.decodeIfPresent(Int.self, forKey: .changed) ?? 0
        rows = try c.decodeIfPresent([WikiDocSentenceRow].self, forKey: .rows) ?? []
    }
}

/// `GET /wiki/spaces/:id/docs/:slug/sections/:key/versions`: newest first, at most five.
public struct WikiDocSectionVersions: Codable, Equatable, Sendable {
    public let spaceId: String?
    public let slug: String?
    public let key: String?
    public let versions: [WikiDocSectionVersion]

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        spaceId = try c.decodeIfPresent(String.self, forKey: .spaceId)
        slug = try c.decodeIfPresent(String.self, forKey: .slug)
        key = try c.decodeIfPresent(String.self, forKey: .key)
        versions = try c.decodeIfPresent([WikiDocSectionVersion].self, forKey: .versions) ?? []
    }
}
