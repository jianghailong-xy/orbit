import Foundation

// Orbit Wiki's wire types — the Swift mirror of `@orbit/shared`'s `wiki.ts`, which transcribes
// `contracts/wiki.contract.json`. `WikiContractTests` holds every closed set below to that file, so a
// value the contract adds and this file does not is a red test rather than a quiet `.unknown`.
//
// Every closed set decodes a value it has never heard of as `.unknown`: a server one release ahead
// may add a kind, a state or an op, and one entry this build can't name must not blank the page it
// is on. The fields a page draws are optional for the same reason, so a control plane that is one
// release behind fills fewer rows instead of failing the whole read.

// MARK: - closed sets

/// What an entry is (contract `kinds`). `assumption` is phase 3's: storage admits the word, so a
/// stored one is drawn under its own name, but no phase-1 door writes it.
public enum WikiEntryKind: String, Codable, Sendable, CaseIterable {
    case principle, convention, decision, pitfall, recipe, concept, assumption
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiEntryKind(rawValue: raw) ?? .unknown
    }
}

/// proposed → active → superseded | retired; proposed → rejected (contract `states.entry`).
public enum WikiEntryStatus: String, Codable, Sendable, CaseIterable {
    case proposed, active, superseded, retired, rejected
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiEntryStatus(rawValue: raw) ?? .unknown
    }
}

/// Who stands behind an entry (contract `trust`). Only `owner` and `confirmed` are handed to agents.
public enum WikiTrust: String, Codable, Sendable, CaseIterable {
    case owner, confirmed, proposed, external
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiTrust(rawValue: raw) ?? .unknown
    }
}

/// What an anchor names (contract `anchorTypes`).
public enum WikiAnchorType: String, Codable, Sendable, CaseIterable {
    case path, symbol, commit, criterion
    case mergeEvidence = "merge_evidence"
    case command, record
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiAnchorType(rawValue: raw) ?? .unknown
    }
}

/// An anchor's last check (contract `anchorStates`). `unchecked` is every new anchor's state, and
/// says nothing either way.
public enum WikiAnchorState: String, Codable, Sendable, CaseIterable {
    case unchecked, verified, changed, missing
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiAnchorState(rawValue: raw) ?? .unknown
    }
}

/// The first-hand records a source can cite (contract `sourceKinds`).
public enum WikiSourceKind: String, Codable, Sendable, CaseIterable {
    case turn, event
    case toolCall = "tool_call"
    case task
    case taskComment = "task_comment"
    case approval, evidence
    case ownerDecision = "owner_decision"
    case mergeReceipt = "merge_receipt"
    case criterion, commit, note, url
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiSourceKind(rawValue: raw) ?? .unknown
    }
}

/// live → trashed → live | deleted (contract `sourceStates`). A deleted source has lost its quote.
public enum WikiSourceState: String, Codable, Sendable, CaseIterable {
    case live, trashed, deleted
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiSourceState(rawValue: raw) ?? .unknown
    }
}

/// What one op of a changeset does (contract `ops`).
public enum WikiOpKind: String, Codable, Sendable, CaseIterable {
    case add, reinforce, amend, supersede, retire, challenge
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiOpKind(rawValue: raw) ?? .unknown
    }
}

/// What became of one op (contract `states.op`). `pending` is the one Review answers.
public enum WikiOpDecision: String, Codable, Sendable, CaseIterable {
    case pending, accepted, edited, rejected
    case autoApplied = "auto_applied"
    case conflict, expired, withdrawn
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiOpDecision(rawValue: raw) ?? .unknown
    }
}

/// A changeset waits while any of its ops does (contract `states.changeset`).
public enum WikiChangesetStatus: String, Codable, Sendable, CaseIterable {
    case pending, settled
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiChangesetStatus(rawValue: raw) ?? .unknown
    }
}

/// Who submitted a changeset (contract `changesetOrigins`).
public enum WikiChangesetOrigin: String, Codable, Sendable, CaseIterable {
    case owner, agent, maintenance
    case `import`
    case watch
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiChangesetOrigin(rawValue: raw) ?? .unknown
    }
}

/// Who wrote a revision (contract `authorKinds`).
public enum WikiAuthorKind: String, Codable, Sendable, CaseIterable {
    case owner, agent, maintenance, system
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiAuthorKind(rawValue: raw) ?? .unknown
    }
}

/// How a session was shown an entry (contract `exposureChannels`).
public enum WikiExposureChannel: String, Codable, Sendable, CaseIterable {
    case push, search, get
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiExposureChannel(rawValue: raw) ?? .unknown
    }
}

/// What the owner does with one pending op in Review (contract `effectPolicy.decide.actions`).
public enum WikiDecideAction: String, Codable, Sendable, CaseIterable {
    case accept, edit, reject
}

/// Why a proposal was rejected, in the order Review's menu lists them (contract `rejectReasons`).
/// Sent by this client, never read from an older server's guess, so it has no `.unknown`.
public enum WikiRejectReason: String, Codable, Sendable, CaseIterable {
    case notTrue = "not_true"
    case notUseful = "not_useful"
    case duplicate
    case tooSpecific = "too_specific"
}

// MARK: - an anchor

/// An anchor as the server keeps it: what was proposed, and its last check. One flat record rather
/// than a union: the wire is a flat object with a `type` discriminator, and which field a type
/// carries is the contract's (`anchorTypes.<type>.fields`) — `WikiLogic.anchorLabel` reads them.
public struct WikiAnchor: Codable, Equatable, Sendable {
    public struct Check: Codable, Equatable, Sendable {
        public let state: WikiAnchorState?
        /// The ref it was checked on — a commit sha for a git check.
        public let ref: String?
        public let at: String?

        public init(state: WikiAnchorState?, ref: String? = nil, at: String? = nil) {
            self.state = state
            self.ref = ref
            self.at = at
        }
    }

    public let type: WikiAnchorType?
    public let path: String?
    public let symbol: String?
    public let regionSha256: String?
    public let sha: String?
    public let criterionId: String?
    public let semanticHash: String?
    public let contentHash: String?
    public let command: String?
    public let expectedExit: Int?
    public let ref: String?
    public let check: Check?

    public init(type: WikiAnchorType?, path: String? = nil, symbol: String? = nil,
                regionSha256: String? = nil, sha: String? = nil, criterionId: String? = nil,
                semanticHash: String? = nil, contentHash: String? = nil, command: String? = nil,
                expectedExit: Int? = nil, ref: String? = nil, check: Check? = nil) {
        self.type = type
        self.path = path
        self.symbol = symbol
        self.regionSha256 = regionSha256
        self.sha = sha
        self.criterionId = criterionId
        self.semanticHash = semanticHash
        self.contentHash = contentHash
        self.command = command
        self.expectedExit = expectedExit
        self.ref = ref
        self.check = check
    }
}

// MARK: - a space

/// A space's settings, merged by the server over its defaults (push on, reinforce auto-accepted).
public struct WikiSpaceSettings: Codable, Equatable, Sendable {
    public let push: Bool?
    public let autoAcceptReinforce: Bool?
}

/// One owner's wiki for one codebase. `GET /wiki/spaces` answers these with `pendingOps` — the
/// proposals waiting in it, which the drawer's amber number sums — and `GET /wiki/spaces/:id` with
/// `usage` when asked for it.
public struct WikiSpace: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let slug: String
    public let title: String?
    /// The repository without its scheme or `.git`: `github.com/a/b`. Nil for a space no repository
    /// stands behind.
    public let repoUrlNorm: String?
    public let rootCommitSha: String?
    public let settings: WikiSpaceSettings?
    public let createdAt: String?
    public let updatedAt: String?
    /// Only on the list read.
    public let pendingOps: Int?
    /// Only on the one-space read, with `include=usage`.
    public let usage: WikiUsage?

    public init(id: String, slug: String, title: String? = nil, repoUrlNorm: String? = nil,
                rootCommitSha: String? = nil, settings: WikiSpaceSettings? = nil,
                createdAt: String? = nil, updatedAt: String? = nil, pendingOps: Int? = nil,
                usage: WikiUsage? = nil) {
        self.id = id
        self.slug = slug
        self.title = title
        self.repoUrlNorm = repoUrlNorm
        self.rootCommitSha = rootCommitSha
        self.settings = settings
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.pendingOps = pendingOps
        self.usage = usage
    }
}

/// The rolling window the home page's usage band reads.
public struct WikiUsage: Codable, Equatable, Sendable {
    public let days: Int?
    /// Distinct sessions an entry was pushed to: a session shown five entries is still one session.
    public let sessionsPushed: Int?
    public let searches: Int?
    public let gets: Int?
    /// The most used entries, most first.
    public let entries: [WikiUsageEntry]?
}

public struct WikiUsageEntry: Codable, Equatable, Sendable, Identifiable {
    public let entryId: String
    public let title: String?
    public let total: Int?
    public let pushed: Int?
    public let searched: Int?
    public let fetched: Int?

    public var id: String { entryId }
}

// MARK: - an entry

/// One entry: the lineage row, carrying its current revision's content. `id` is the same across
/// revisions, and is what `orbit-wiki:<id>` names.
public struct WikiEntry: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let spaceId: String?
    public let kind: WikiEntryKind?
    public let status: WikiEntryStatus?
    public let trust: WikiTrust?
    public let currentRevision: Int?
    public let title: String?
    public let summary: String?
    /// The kind's own fields (`KIND_SPECS`), kept as the JSON they are: `WikiLogic.fieldRows` reads
    /// them in the registry's order.
    public let fields: JSONValue?
    public let topics: [String]?
    public let aliases: [String]?
    public let anchors: [WikiAnchor]?
    public let anchorState: WikiAnchorState?
    public let anchorCheckedRef: String?
    public let anchorCheckedAt: String?
    public let tainted: Bool?
    public let challenged: Bool?
    public let unsupported: Bool?
    public let pinned: Bool?
    public let supersedesId: String?
    public let supersededById: String?
    /// When what the entry says became true — what "newest" orders by.
    public let validFrom: String?
    public let validTo: String?
    public let recordedAt: String?
    public let retiredAt: String?

    public init(id: String, spaceId: String? = nil, kind: WikiEntryKind? = nil,
                status: WikiEntryStatus? = nil, trust: WikiTrust? = nil, currentRevision: Int? = nil,
                title: String? = nil, summary: String? = nil, fields: JSONValue? = nil,
                topics: [String]? = nil, aliases: [String]? = nil, anchors: [WikiAnchor]? = nil,
                anchorState: WikiAnchorState? = nil, anchorCheckedRef: String? = nil,
                anchorCheckedAt: String? = nil, tainted: Bool? = nil, challenged: Bool? = nil,
                unsupported: Bool? = nil, pinned: Bool? = nil, supersedesId: String? = nil,
                supersededById: String? = nil, validFrom: String? = nil, validTo: String? = nil,
                recordedAt: String? = nil, retiredAt: String? = nil) {
        self.id = id
        self.spaceId = spaceId
        self.kind = kind
        self.status = status
        self.trust = trust
        self.currentRevision = currentRevision
        self.title = title
        self.summary = summary
        self.fields = fields
        self.topics = topics
        self.aliases = aliases
        self.anchors = anchors
        self.anchorState = anchorState
        self.anchorCheckedRef = anchorCheckedRef
        self.anchorCheckedAt = anchorCheckedAt
        self.tainted = tainted
        self.challenged = challenged
        self.unsupported = unsupported
        self.pinned = pinned
        self.supersedesId = supersedesId
        self.supersededById = supersededById
        self.validFrom = validFrom
        self.validTo = validTo
        self.recordedAt = recordedAt
        self.retiredAt = retiredAt
    }

    /// The title, or the id when the server sent none: a blank row reads as broken.
    public var displayTitle: String {
        guard let title, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return id }
        return title
    }

    /// Whether agents are still handed it. A retired, superseded or rejected entry still reads.
    public var isEnded: Bool {
        status == .retired || status == .superseded || status == .rejected
    }
}

/// A source as the server keeps it: the record it cites, and the quote it was cited for.
public struct WikiSource: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let kind: WikiSourceKind?
    /// The cited record's id, or a commit's sha — raw, not a public id.
    public let ref: String?
    public let locator: JSONValue?
    public let quote: String?
    public let quoteVerified: Bool?
    public let state: WikiSourceState?
    public let tainted: Bool?
    public let createdAt: String?
}

/// One revision of an entry, newest first in `history`.
public struct WikiRevision: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let revision: Int?
    public let title: String?
    public let summary: String?
    public let authorKind: WikiAuthorKind?
    public let authorSessionId: String?
    public let changesetOpId: String?
    public let createdAt: String?
}

/// A session an entry was shown to: pushed at its start, or fetched by it.
public struct WikiExposure: Codable, Equatable, Sendable {
    public let sessionId: String?
    public let entryId: String?
    public let revision: Int?
    public let channel: WikiExposureChannel?
    public let at: String?
}

/// `GET /wiki/entries/:id?include=sources,history,exposure`: the entry, with what its page draws
/// beneath it. The entry's own fields sit at the top level of the same object, so it is read once
/// as a `WikiEntry` and once for the three lists.
public struct WikiEntryDetail: Decodable, Equatable, Sendable {
    public let entry: WikiEntry
    public let sources: [WikiSource]
    public let history: [WikiRevision]
    public let exposure: [WikiExposure]

    private enum CodingKeys: String, CodingKey { case sources, history, exposure }

    public init(entry: WikiEntry, sources: [WikiSource] = [], history: [WikiRevision] = [],
                exposure: [WikiExposure] = []) {
        self.entry = entry
        self.sources = sources
        self.history = history
        self.exposure = exposure
    }

    public init(from decoder: Decoder) throws {
        entry = try WikiEntry(from: decoder)
        let values = try decoder.container(keyedBy: CodingKeys.self)
        sources = try values.decodeIfPresent([WikiSource].self, forKey: .sources) ?? []
        history = try values.decodeIfPresent([WikiRevision].self, forKey: .history) ?? []
        exposure = try values.decodeIfPresent([WikiExposure].self, forKey: .exposure) ?? []
    }
}

// MARK: - changesets, and Review

/// An existing entry a proposal resembles, as the server's near-neighbour read found it. One the
/// owner rejected before says why, so Review can say "this was turned down as a Duplicate".
public struct WikiSimilar: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let kind: WikiEntryKind?
    public let title: String?
    public let status: WikiEntryStatus?
    public let trust: WikiTrust?
    public let score: Double?
    public let rejectedReason: String?
}

/// One op of a changeset. `payload` is the op as it was submitted (redacted), which is where a
/// proposal's content lives until it is accepted.
public struct WikiChangesetOp: Codable, Equatable, Sendable, Identifiable {
    /// What `decide` names the op by.
    public let id: String
    public let changesetId: String?
    public let seq: Int?
    public let op: WikiOpKind?
    /// The entry the op is about; nil for an add, the replaced one for a supersede.
    public let entryId: String?
    public let baseRevision: Int?
    public let payload: JSONValue?
    public let similar: [WikiSimilar]?
    /// The session read the web before proposing it: never auto-accepted, and warned about.
    public let tainted: Bool?
    public let decision: WikiOpDecision?
    public let decisionReason: String?
    public let decisionNote: String?
    /// For an add or a supersede, the entry the proposal made (in `proposed` until accepted).
    public let resultEntryId: String?
    public let resultRevision: Int?
    public let decidedAt: String?

    public init(id: String, changesetId: String? = nil, seq: Int? = nil, op: WikiOpKind? = nil,
                entryId: String? = nil, baseRevision: Int? = nil, payload: JSONValue? = nil,
                similar: [WikiSimilar]? = nil, tainted: Bool? = nil, decision: WikiOpDecision? = nil,
                decisionReason: String? = nil, decisionNote: String? = nil,
                resultEntryId: String? = nil, resultRevision: Int? = nil, decidedAt: String? = nil) {
        self.id = id
        self.changesetId = changesetId
        self.seq = seq
        self.op = op
        self.entryId = entryId
        self.baseRevision = baseRevision
        self.payload = payload
        self.similar = similar
        self.tainted = tainted
        self.decision = decision
        self.decisionReason = decisionReason
        self.decisionNote = decisionNote
        self.resultEntryId = resultEntryId
        self.resultRevision = resultRevision
        self.decidedAt = decidedAt
    }
}

/// What one submission recorded: its origin, the session behind it and why, and its ops.
public struct WikiChangeset: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let spaceId: String?
    public let origin: WikiChangesetOrigin?
    public let sessionId: String?
    public let toolCallId: String?
    /// The proposer's own sentence for why — what Review's "Proposed by" line shows.
    public let rationale: String?
    public let status: WikiChangesetStatus?
    public let createdAt: String?
    public let decidedAt: String?
    public let expiresAt: String?
    public let ops: [WikiChangesetOp]?

    public init(id: String, spaceId: String? = nil, origin: WikiChangesetOrigin? = nil,
                sessionId: String? = nil, toolCallId: String? = nil, rationale: String? = nil,
                status: WikiChangesetStatus? = nil, createdAt: String? = nil,
                decidedAt: String? = nil, expiresAt: String? = nil, ops: [WikiChangesetOp]? = nil) {
        self.id = id
        self.spaceId = spaceId
        self.origin = origin
        self.sessionId = sessionId
        self.toolCallId = toolCallId
        self.rationale = rationale
        self.status = status
        self.createdAt = createdAt
        self.decidedAt = decidedAt
        self.expiresAt = expiresAt
        self.ops = ops
    }
}

/// `GET /wiki/spaces/:id/timeline`: what changed, newest first.
public struct WikiTimeline: Codable, Equatable, Sendable {
    public let items: [WikiTimelineItem]?
}

/// One change in a space's timeline. `op` and `decision` are the contract's own words.
public struct WikiTimelineItem: Codable, Equatable, Sendable, Identifiable {
    public let opId: String
    public let op: WikiOpKind?
    public let decision: WikiOpDecision?
    public let origin: WikiChangesetOrigin?
    public let at: String?
    public let entryId: String?
    public let title: String?
    public let kind: WikiEntryKind?
    public let status: WikiEntryStatus?
    public let trust: WikiTrust?
    public let supersededById: String?
    public let supersededByTitle: String?
    public let reason: String?

    public var id: String { opId }

    public init(opId: String, op: WikiOpKind? = nil, decision: WikiOpDecision? = nil,
                origin: WikiChangesetOrigin? = nil, at: String? = nil, entryId: String? = nil,
                title: String? = nil, kind: WikiEntryKind? = nil, status: WikiEntryStatus? = nil,
                trust: WikiTrust? = nil, supersededById: String? = nil,
                supersededByTitle: String? = nil, reason: String? = nil) {
        self.opId = opId
        self.op = op
        self.decision = decision
        self.origin = origin
        self.at = at
        self.entryId = entryId
        self.title = title
        self.kind = kind
        self.status = status
        self.trust = trust
        self.supersededById = supersededById
        self.supersededByTitle = supersededByTitle
        self.reason = reason
    }
}

/// `GET /wiki/search`: the entries a query found, each with why it matched.
public struct WikiSearchResponse: Codable, Equatable, Sendable {
    public let q: String?
    public let hits: [WikiSearchHit]?
}

public struct WikiSearchHit: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let kind: WikiEntryKind?
    public let title: String?
    public let summary: String?
    public let trust: WikiTrust?
    public let anchorState: WikiAnchorState?
    /// `keyword` / `path` (and `semantic`, phase 2), kept as the words they are.
    public let match: [String]?
    public let topics: [String]?
}

// MARK: - writes

/// What the owner's edit changes: each key given replaces that key whole, each key left out carries
/// over. The kind never changes.
public struct WikiEntryChanges: Encodable, Equatable, Sendable {
    public var title: String?
    public var summary: String?
    public var fields: JSONValue?
    public var topics: [String]?
    public var aliases: [String]?
    public var anchors: [JSONValue]?

    public init(title: String? = nil, summary: String? = nil, fields: JSONValue? = nil,
                topics: [String]? = nil, aliases: [String]? = nil, anchors: [JSONValue]? = nil) {
        self.title = title
        self.summary = summary
        self.fields = fields
        self.topics = topics
        self.aliases = aliases
        self.anchors = anchors
    }
}

/// One owner decision on one pending op (`POST /wiki/changesets/:id/decide`).
public struct WikiDecision: Encodable, Equatable, Sendable {
    public let opId: String
    public let action: WikiDecideAction
    /// The owner's version, with `edit`.
    public let edited: WikiEntryChanges?
    /// Required with `reject`.
    public let reason: WikiRejectReason?
    public let note: String?

    public init(opId: String, action: WikiDecideAction, edited: WikiEntryChanges? = nil,
                reason: WikiRejectReason? = nil, note: String? = nil) {
        self.opId = opId
        self.action = action
        self.edited = edited
        self.reason = reason
        self.note = note
    }
}

public struct WikiDecideRequest: Encodable, Equatable, Sendable {
    public let decisions: [WikiDecision]

    public init(decisions: [WikiDecision]) { self.decisions = decisions }
}

/// One op of the owner's own write (`POST /wiki/spaces/:id/changesets`), which applies at once. The
/// three the entry page offers: an edit (an amend), a supersede, and a retire.
public enum WikiOwnerOp: Encodable, Equatable, Sendable {
    case amend(entryId: String, baseRevision: Int, changes: WikiEntryChanges)
    /// `entry` is the whole replacement draft: kind, title, summary, fields and the rest.
    case supersede(entryId: String, baseRevision: Int, entry: JSONValue)
    case retire(entryId: String, baseRevision: Int, reason: String)

    private enum CodingKeys: String, CodingKey { case op, entryId, baseRevision, changes, entry, reason }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .amend(entryId, baseRevision, changes):
            try values.encode(WikiOpKind.amend.rawValue, forKey: .op)
            try values.encode(entryId, forKey: .entryId)
            try values.encode(baseRevision, forKey: .baseRevision)
            try values.encode(changes, forKey: .changes)
        case let .supersede(entryId, baseRevision, entry):
            try values.encode(WikiOpKind.supersede.rawValue, forKey: .op)
            try values.encode(entryId, forKey: .entryId)
            try values.encode(baseRevision, forKey: .baseRevision)
            try values.encode(entry, forKey: .entry)
        case let .retire(entryId, baseRevision, reason):
            try values.encode(WikiOpKind.retire.rawValue, forKey: .op)
            try values.encode(entryId, forKey: .entryId)
            try values.encode(baseRevision, forKey: .baseRevision)
            try values.encode(reason, forKey: .reason)
        }
    }
}

public struct WikiChangesetRequest: Encodable, Equatable, Sendable {
    public let ops: [WikiOwnerOp]
    /// Required and not blank: why, in the owner's words (the entry page writes one for them).
    public let rationale: String
    public let idempotencyKey: String?

    public init(ops: [WikiOwnerOp], rationale: String, idempotencyKey: String? = nil) {
        self.ops = ops
        self.rationale = rationale
        self.idempotencyKey = idempotencyKey
    }
}

/// What the owner's write recorded, op by op.
public struct WikiChangeResult: Decodable, Equatable, Sendable {
    public struct Outcome: Decodable, Equatable, Sendable {
        public struct Reason: Decodable, Equatable, Sendable {
            public let code: String?
            public let message: String?
        }
        public let seq: Int?
        /// `applied`, `pending`, `conflict` or `refused`, kept as the word it is.
        public let status: String?
        public let entryId: String?
        public let revision: Int?
        public let reasons: [Reason]?
    }

    public let changesetId: String?
    public let replayed: Bool?
    public let ops: [Outcome]?
}
