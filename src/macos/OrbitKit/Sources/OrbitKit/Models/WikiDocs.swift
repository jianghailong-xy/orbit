import Foundation

// Orbit Wiki's documents — the Swift mirror of `@orbit/shared`'s `wikiDocs.ts`, which transcribes
// `contracts/wiki.contract.json` `docs` (criterion 9). `WikiDocsContractTests` holds the closed sets below
// to that file.
//
// A document is what a person reads: written section by section from the plan its owner confirmed, every
// footnote pointing at a first-hand original — a design document, code or a contract at a commit, or one of
// Orbit's own records — with its verbatim quote, and the entry it was found through beside it. As in
// `Wiki.swift`, a closed set decodes a value it has never heard of as `.unknown`, and the fields a page draws
// are optional, so a server one release apart fills fewer rows instead of failing the read.

// MARK: - closed sets

/// `needsReview`: more than 5% of its sentences are unsourced or unverified.
public enum WikiDocStatus: String, Codable, Sendable, CaseIterable {
    case ok
    case needsReview = "needs_review"
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiDocStatus(rawValue: raw) ?? .unknown
    }
}

/// What one sentence is (contract `docs.sentenceStatuses`).
public enum WikiDocSentenceStatus: String, Codable, Sendable, CaseIterable {
    case sourced, transition, unsourced, unverified, withdrawn
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiDocSentenceStatus(rawValue: raw) ?? .unknown
    }
}

/// Where a footnote points (contract `docs.footnoteKinds`): an original in the repository, or a record.
public enum WikiDocFootnoteKind: String, Codable, Sendable, CaseIterable {
    case designDoc = "design_doc"
    case code, contract
    case turn, event
    case toolCall = "tool_call"
    case task
    case taskComment = "task_comment"
    case approval
    case ownerDecision = "owner_decision"
    case mergeReceipt = "merge_receipt"
    case note
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiDocFootnoteKind(rawValue: raw) ?? .unknown
    }

    /// A record a session's transcript opens at (contract `docs.links.sessionRecord`): a turn, an event or a
    /// tool call — the three `GET /api/sessions/:id/events/page?around=` places.
    public var opensAtASessionRecord: Bool {
        self == .turn || self == .event || self == .toolCall
    }
}

/// A footnote's check (contract `docs.verdicts`).
public enum WikiDocVerdict: String, Codable, Sendable, CaseIterable {
    case verified
    case notFound = "not_found"
    case noQuote = "no_quote"
    case unresolved
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiDocVerdict(rawValue: raw) ?? .unknown
    }
}

/// Who checked a footnote: the server, which read the record again, or the runner, at the commit.
public enum WikiDocChecker: String, Codable, Sendable, CaseIterable {
    case server, runner
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiDocChecker(rawValue: raw) ?? .unknown
    }
}

/// Why a sentence was withdrawn: what happened to the entry it came through.
public enum WikiDocWithdrawReason: String, Codable, Sendable, CaseIterable {
    case rejected, retired, superseded
    case anchorChanged = "anchor_changed"
    case anchorMissing = "anchor_missing"
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiDocWithdrawReason(rawValue: raw) ?? .unknown
    }
}

/// A section's blocks: paragraphs and list items hold sentences; a heading or a code block its text.
public enum WikiDocBlockKind: String, Codable, Sendable, CaseIterable {
    case paragraph, item, heading, code
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiDocBlockKind(rawValue: raw) ?? .unknown
    }
}

// MARK: - the directory: `GET /api/wiki/spaces/:id/docs`

public struct WikiDocsPlanRef: Codable, Equatable, Sendable {
    public let version: Int
    public let confirmedAt: String?
}

/// The confirmed plan's categories and documents, as written so far.
public struct WikiDocsDirectory: Codable, Equatable, Sendable {
    public struct Section: Codable, Equatable, Sendable {
        public let key: String
        public let number: Int?
        public let title: String
        public let kind: WikiPlanSectionKind?
        public let written: Bool?
        /// A sentence of it was withdrawn: the next maintenance run writes it again.
        public let stale: Bool?
    }

    public struct Doc: Codable, Equatable, Sendable {
        public let slug: String
        /// `<category number>.<its place>`: `3.1`.
        public let number: String?
        public let title: String
        public let question: String?
        public let written: Bool?
        /// Nil until it is written.
        public let status: WikiDocStatus?
        public let updatedAt: String?
        public let planVersion: Int?
        /// Its two lines on the home (contract `docs.lead`): the first two sentences of its first section,
        /// withdrawn ones skipped, cut with an ellipsis. Nil until it is written, while its first section has
        /// no sentence to give, and from a server older than it.
        public let lead: String?
        public let sections: [Section]?
    }

    public struct Category: Codable, Equatable, Sendable {
        public let key: String
        public let number: Int?
        public let title: String
        public let question: String?
        public let forAgents: Bool?
        public let docs: [Doc]?
    }

    public struct Counts: Codable, Equatable, Sendable {
        public let total: Int
        public let written: Int
    }

    public let spaceId: String?
    /// Nil while the space has no confirmed plan.
    public let plan: WikiDocsPlanRef?
    public let docs: Counts?
    public let categories: [Category]
}

// MARK: - a document: `GET /api/wiki/spaces/:id/docs/:slug`

public struct WikiDocCounts: Codable, Equatable, Sendable {
    public let sentences: Int
    public let sourced: Int?
    public let transition: Int?
    public let unsourced: Int?
    public let unverified: Int?
    public let withdrawn: Int?
}

public struct WikiDocSentence: Codable, Equatable, Sendable {
    public struct Withdrawn: Codable, Equatable, Sendable {
        public let reason: WikiDocWithdrawReason
        /// The entry it came through — or nil, when a repository file it cites was deleted or renamed on origin/main.
        public let entryId: String?
        /// The repository file gone from origin/main that withdrew it (anchor_missing), when no entry did.
        public let path: String?
        public let at: String?
    }

    public let text: String
    public let status: WikiDocSentenceStatus
    /// The document's footnote numbers it carries.
    public let notes: [Int]?
    /// An unsourced sentence's fact tokens that nothing sourced carries.
    public let newTokens: [String]?
    public let withdrawn: Withdrawn?
}

public struct WikiDocBlock: Codable, Equatable, Sendable {
    public let kind: WikiDocBlockKind
    /// A heading's or a code block's text.
    public let text: String?
    public let sentences: [WikiDocSentence]?
}

public struct WikiDocSection: Codable, Equatable, Sendable {
    public let key: String
    public let number: Int?
    public let title: String
    public let kind: WikiPlanSectionKind?
    public let written: Bool?
    public let stale: Bool?
    public let staleAt: String?
    public let generatedAt: String?
    /// The origin/main commit it was generated at.
    public let repoSha: String?
    public let model: String?
    public let blocks: [WikiDocBlock]?
}

/// One footnote of the document, numbered by first appearance.
public struct WikiDocFootnote: Codable, Equatable, Sendable {
    public let n: Int
    public let kind: WikiDocFootnoteKind
    public let verdict: WikiDocVerdict
    public let checkedBy: WikiDocChecker?
    public let quote: String?
    /// `path@sha#L12-20`, or `<kind>:<record id>#c40-96`.
    public let location: String?
    // A repository original.
    public let path: String?
    public let sha: String?
    public let lineStart: Int?
    public let lineEnd: Int?
    public let section: String?
    public let symbol: String?
    public let excerpt: String?
    // A record, and what the page links it to.
    public let recordId: String?
    public let charStart: Int?
    public let charEnd: Int?
    public let sessionId: String?
    public let sessionTitle: String?
    public let seq: Int?
    public let at: String?
    public let label: String?
    public let taskId: String?
    public let taskTitle: String?
    public let projectId: String?
    public let projectTitle: String?
    public let notePath: String?
    public let viaEntryId: String?

    /// The session and the record a turn's, an event's or a tool call's footnote opens at (contract
    /// `docs.links.sessionRecord`): a source keeps a record's id alone, so the server reads the session
    /// back beside it. Nil for any other original, or when either is missing.
    public var sessionRecord: (session: String, record: String)? {
        guard kind.opensAtASessionRecord, let session = sessionId, let record = recordId,
              !session.isEmpty, !record.isEmpty else { return nil }
        return (session, record)
    }

    /// `orbit://session/<id>?at=<record>`: the transcript opened at the quoted record.
    public var sessionRecordURL: URL? {
        sessionRecord.map { SessionRecordLink.url(session: $0.session, record: $0.record) }
    }
}

/// An entry the document's quotes came through, as it stands now, with the footnotes it carried.
public struct WikiDocViaEntry: Codable, Equatable, Sendable {
    public let id: String
    public let kind: WikiEntryKind?
    public let title: String
    public let status: WikiEntryStatus?
    public let trust: WikiTrust?
    public let anchorState: WikiAnchorState?
    public let notes: [Int]?
}

public struct WikiDoc: Codable, Equatable, Sendable {
    public struct Category: Codable, Equatable, Sendable {
        public let key: String
        public let number: Int?
        public let title: String?
    }

    public struct ScopeOut: Codable, Equatable, Sendable {
        public struct Target: Codable, Equatable, Sendable {
            public let slug: String
            public let number: String?
            public let title: String?
        }

        public let text: String
        public let docs: [Target]?
    }

    public let spaceId: String?
    public let slug: String
    public let number: String?
    public let title: String
    public let question: String?
    public let audience: [String]?
    public let scopeIn: [String]?
    public let scopeOut: [ScopeOut]?
    public let category: Category?
    public let length: WikiPlanRange?
    /// The confirmed plan's version.
    public let planVersion: Int?
    public let written: Bool
    /// Nil until it is written.
    public let status: WikiDocStatus?
    public let writtenFromPlanVersion: Int?
    /// The origin/main commit its last write read the repository at.
    public let repoSha: String?
    public let updatedAt: String?
    public let counts: WikiDocCounts?
    /// The unsourced and unverified sentences' share of all.
    public let unsourcedShare: Double?
    public let sections: [WikiDocSection]?
    public let footnotes: [WikiDocFootnote]?
    public let entries: [WikiDocViaEntry]?
}

// MARK: - the index: `GET /api/wiki/spaces/:id/doc-index`

public struct WikiDocsIndex: Codable, Equatable, Sendable {
    public struct Item: Codable, Equatable, Sendable {
        public struct Category: Codable, Equatable, Sendable {
            public let key: String
            public let title: String?
        }

        /// `doc` or `section`.
        public let kind: String
        public let title: String
        public let docSlug: String
        public let docNumber: String?
        public let docTitle: String?
        public let sectionKey: String?
        public let sectionNumber: Int?
        public let category: Category?
        public let written: Bool?
    }

    public let spaceId: String?
    public let plan: WikiDocsPlanRef?
    public let items: [Item]
}
