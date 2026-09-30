import Foundation

// Orbit Wiki's plan — the Swift mirror of `@orbit/shared`'s `wikiPlan.ts`, which transcribes
// `contracts/wiki.contract.json` `plan` (criterion 11). `WikiPlanContractTests` holds the closed sets
// below to that file.
//
// A plan is what a wiki's documents are written from: categories, documents, every document's reader,
// scope and outline, and where each section's material comes from. The local model drafts it, the
// server's gate checks it, and the owner confirms it — on the user door, and only there. As in
// `Wiki.swift`, a closed set decodes a value it has never heard of as `.unknown`, and the fields a page
// draws are optional, so a server one release apart fills fewer rows instead of failing the read.

// MARK: - closed sets

/// A version is a `draft` until the owner confirms it; a newer draft or a confirmation supersedes it.
public enum WikiPlanStatus: String, Codable, Sendable, CaseIterable {
    case draft, confirmed, superseded
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiPlanStatus(rawValue: raw) ?? .unknown
    }
}

/// Who made a version: a maintenance run's drafting job, or the owner (an edit, an accepted proposal).
public enum WikiPlanOrigin: String, Codable, Sendable, CaseIterable {
    case maintenance, owner
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiPlanOrigin(rawValue: raw) ?? .unknown
    }
}

/// What a section is (contract `plan.sectionKinds`).
public enum WikiPlanSectionKind: String, Codable, Sendable, CaseIterable {
    case overview, concepts, flow, interface, data, ops, pitfalls, decisions, conventions, other
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiPlanSectionKind(rawValue: raw) ?? .unknown
    }
}

/// A proposed change waits for the owner, who accepts or rejects it.
public enum WikiPlanProposalStatus: String, Codable, Sendable, CaseIterable {
    case pending, accepted, rejected
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiPlanProposalStatus(rawValue: raw) ?? .unknown
    }
}

/// The gate's four checks, in the order it runs them (contract `plan.gate.checks`).
public enum WikiPlanGateCheck: String, Codable, Sendable, CaseIterable {
    case schema, docCount, protected, references
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiPlanGateCheck(rawValue: raw) ?? .unknown
    }
}

// MARK: - a version

public struct WikiPlanCategory: Codable, Equatable, Sendable {
    public let key: String
    public let title: String?
    /// What the category answers.
    public let question: String?
    /// The agents' development conventions: a category of their own (criterion 11).
    public let forAgents: Bool?
}

public struct WikiPlanRange: Codable, Equatable, Sendable {
    public let min: Int
    public let max: Int
}

/// A section's session condition: where its original words are looked for.
public struct WikiPlanSessionCondition: Codable, Equatable, Sendable {
    public struct Project: Codable, Equatable, Sendable {
        public let id: String
        /// As it stands now; nil for a project since deleted.
        public let title: String?
    }

    public let projects: [Project]?
    public let since: String?
    public let until: String?
    public let keywords: [String]?
    public let anchorPaths: [String]?
    public let entryKinds: [WikiEntryKind]?
    public let topics: [String]?
    /// What original words to look for.
    public let evidence: String?
}

/// Where a section's material comes from: design-document sections, code, contracts, and sessions.
public struct WikiPlanSources: Codable, Equatable, Sendable {
    public struct DocSource: Codable, Equatable, Sendable {
        public let path: String
        public let section: String?
    }

    public struct CodeSource: Codable, Equatable, Sendable {
        public let path: String
        public let symbols: [String]?
    }

    public struct ContractSource: Codable, Equatable, Sendable {
        public let path: String
    }

    public let docs: [DocSource]?
    public let code: [CodeSource]?
    public let contracts: [ContractSource]?
    public let sessions: WikiPlanSessionCondition?
}

public struct WikiPlanSection: Codable, Equatable, Sendable {
    public let id: String
    /// Stable within its document from version to version.
    public let key: String
    public let position: Int?
    public let title: String
    public let kind: WikiPlanSectionKind
    public let covers: String?
    /// The characters it is written to.
    public let length: Int?
    public let sources: WikiPlanSources?
    /// The values of fields the plan declared as needing adding, by name: carried back as they are by an edit.
    public let extra: [String: JSONValue]?
}

public struct WikiPlanDoc: Codable, Equatable, Sendable {
    public struct ScopeOut: Codable, Equatable, Sendable {
        public let text: String
        /// The documents (slugs of the plan) it is left to.
        public let docs: [String]?
    }

    public let id: String
    public let position: Int?
    /// The key of one of the version's categories.
    public let category: String
    public let slug: String
    public let title: String
    /// The question the reader comes with.
    public let question: String?
    /// Who it is written for, and what each can do after reading it.
    public let audience: [String]?
    public let scopeIn: [String]?
    public let scopeOut: [ScopeOut]?
    public let length: WikiPlanRange?
    public let protected: Bool?
    public let sections: [WikiPlanSection]?
    /// The values of fields the plan declared as needing adding, by name: carried back as they are by an edit.
    public let extra: [String: JSONValue]?
}

/// A field the draft declared as needing adding to the schema, and how many values it carried.
public struct WikiPlanNewField: Codable, Equatable, Sendable {
    public let at: String
    public let name: String
    public let why: String?
    public let values: Int?
}

/// What the gate checked of a version it let through (contract `plan.gate.report`).
public struct WikiPlanGateReport: Codable, Equatable, Sendable {
    public let checkedAt: String?
    /// Each check, `passed`, or `skipped` for protection on the owner's own edit.
    public let checks: [String: String]?
    public let docs: Int?
    public let target: WikiPlanRange?
    public let needsNewFields: [WikiPlanNewField]?
}

/// What the drafting job found when it checked the repository references on the runner, at `sha`.
public struct WikiPlanRepoCheck: Codable, Equatable, Sendable {
    public struct Miss: Codable, Equatable, Sendable {
        public let kind: String
        public let ref: String
        public let at: String?
    }

    public let sha: String
    public let checked: Int?
    public let missing: [Miss]?
}

/// One version, whole: `GET /api/wiki/spaces/:id/plan/versions/:version`.
public struct WikiPlanVersion: Codable, Equatable, Sendable {
    public let id: String
    public let spaceId: String?
    public let version: Int
    public let status: WikiPlanStatus
    public let origin: WikiPlanOrigin?
    public let baseVersion: Int?
    public let proposalId: String?
    public let categories: [WikiPlanCategory]?
    public let target: WikiPlanRange?
    public let gate: WikiPlanGateReport?
    /// Nil for a version the owner made: no runner checked it.
    public let repoCheck: WikiPlanRepoCheck?
    public let model: String?
    public let confirmedAt: String?
    public let supersededAt: String?
    public let createdAt: String?
    public let docs: [WikiPlanDoc]?
}

/// One version as `GET /api/wiki/spaces/:id/plan/versions` lists it, newest first.
public struct WikiPlanVersionSummary: Codable, Equatable, Sendable {
    public let id: String
    public let version: Int
    public let status: WikiPlanStatus
    public let origin: WikiPlanOrigin?
    public let baseVersion: Int?
    /// An owner's version made by accepting a proposal names it: the menu says «Accepted change».
    public let proposalId: String?
    public let docCount: Int?
    public let createdAt: String?
    public let confirmedAt: String?
    public let supersededAt: String?
}

public struct WikiPlanVersions: Codable, Equatable, Sendable {
    public let spaceId: String?
    public let versions: [WikiPlanVersionSummary]
}

// MARK: - proposals

/// A change a maintenance run proposed: why, the document as it should read, and what led to it.
public struct WikiPlanProposal: Codable, Equatable, Sendable {
    public struct Change: Codable, Equatable, Sendable {
        /// The document as a draft writes one: sections by key, projects by id.
        public struct Doc: Codable, Equatable, Sendable {
            public struct Section: Codable, Equatable, Sendable {
                public let key: String?
                public let title: String
                public let kind: WikiPlanSectionKind
                public let covers: String?
                /// The characters it is to be written to.
                public let length: Int?
                /// Where its material comes from, as a draft names it: a session condition's projects by id.
                public let sources: WikiPlanSourcesInput?
            }

            public let category: String?
            public let slug: String
            public let title: String?
            public let question: String?
            public let audience: [String]?
            public let scopeIn: [String]?
            public let length: WikiPlanRange?
            public let protected: Bool?
            public let sections: [Section]?
        }

        public let doc: Doc
        /// The category it opens, when it needs one the plan does not have.
        public let category: WikiPlanCategory?
    }

    public struct Fact: Codable, Equatable, Sendable {
        public let kind: String
        public let id: String
    }

    public let id: String
    public let status: WikiPlanProposalStatus
    public let baseVersion: Int?
    public let reason: String?
    public let change: Change?
    public let facts: [Fact]?
    public let decidedAt: String?
    public let decisionNote: String?
    /// The draft accepting it made.
    public let resultVersion: Int?
    public let createdAt: String?
}

/// `GET /api/wiki/spaces/:id/plan`: the version in force, the draft waiting for the owner, the pending
/// proposals, and the space's plan job.
public struct WikiPlanState: Codable, Equatable, Sendable {
    public let spaceId: String?
    public let confirmed: WikiPlanVersion?
    public let draft: WikiPlanVersion?
    public let proposals: [WikiPlanProposal]?
    /// The space's job that has not ended, else the one that ended last; nil when it never had one.
    public let job: WikiPlanJob?
}

// MARK: - jobs

/// What a plan job does (contract `plan.jobs.kinds`): draft a plan, revise it with the owner's words, or
/// build the documents from a confirmed version.
public enum WikiPlanJobKind: String, Codable, Sendable, CaseIterable {
    case draft, revise, build
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiPlanJobKind(rawValue: raw) ?? .unknown
    }
}

/// The fact that asked for a job (contract `plan.jobs.triggers`): the space was created, or its owner asked.
public enum WikiPlanJobTrigger: String, Codable, Sendable, CaseIterable {
    case spaceCreated = "space_created"
    case owner
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiPlanJobTrigger(rawValue: raw) ?? .unknown
    }
}

/// Where a job stands (contract `plan.jobs.states`): the plan page's status card.
public enum WikiPlanJobState: String, Codable, Sendable, CaseIterable {
    case queued, held, running, succeeded, failed
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiPlanJobState(rawValue: raw) ?? .unknown
    }
}

/// Why a job was not made (contract `plan.jobs.held.reasons`).
public enum WikiPlanJobHeldReason: String, Codable, Sendable, CaseIterable {
    case noMaintenanceWorkspace = "no_maintenance_workspace"
    case maintenanceProviderUnusable = "maintenance_provider_unusable"
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiPlanJobHeldReason(rawValue: raw) ?? .unknown
    }
}

/// A space's plan job, as the plan's read gives it (contract `plan.jobs.read`).
public struct WikiPlanJob: Codable, Equatable, Sendable {
    public struct Held: Codable, Equatable, Sendable {
        public let reason: WikiPlanJobHeldReason
        public let at: String?
    }

    /// A queued job's: the unfinished task of the maintenance list it waits for, and that task's run.
    public struct WaitingFor: Codable, Equatable, Sendable {
        public let taskId: String
        public let title: String?
        public let sessionId: String?
        public let startedAt: String?
    }

    /// What the run reported: a draft's or a revision's (contract `plan.jobs.report`), or a build's
    /// (`plan.jobs.buildReport`), whose `docs` and `sections` are counts by outcome rather than totals.
    public struct Report: Codable, Equatable, Sendable {
        public struct Attempt: Codable, Equatable, Sendable {
            public let attempt: Int
            public let local: Int?
            public let server: Int?
            public let checks: [String: Int]?
        }

        public struct Tokens: Codable, Equatable, Sendable {
            public let input: Int?
            public let output: Int?
            public let calls: Int?
        }

        /// A build's documents: how many the version has, and how many it wrote whole.
        public struct BuiltDocs: Codable, Equatable, Sendable {
            public let total: Int?
            public let written: Int?
        }

        /// A build's sections by what became of them.
        public struct BuiltSections: Codable, Equatable, Sendable {
            public let written: Int?
            public let unchanged: Int?
            public let failed: Int?
        }

        /// What the runner found of the repository references it checked, at `sha`.
        public struct Repo: Codable, Equatable, Sendable {
            public let sha: String
            public let checked: Int?
            public let missing: Int?
        }

        public let categories: Int?
        public let docs: Int?
        public let sections: Int?
        /// A draft's: the document count it was held to, and the references checked.
        public let target: WikiPlanRange?
        public let repo: Repo?
        public let attempts: [Attempt]?
        public let tokens: Tokens?
        public let seconds: Int?
        public let model: String?
        /// A build's: the confirmed version it wrote, at which origin/main commit, and what became of it.
        public let planVersion: Int?
        public let repoSha: String?
        public let builtDocs: BuiltDocs?
        public let builtSections: BuiltSections?

        private enum CodingKeys: String, CodingKey {
            case categories, docs, sections, target, repo, attempts, tokens, seconds, model, planVersion, repoSha
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            categories = try? c.decode(Int.self, forKey: .categories)
            docs = try? c.decode(Int.self, forKey: .docs)
            sections = try? c.decode(Int.self, forKey: .sections)
            target = try? c.decode(WikiPlanRange.self, forKey: .target)
            repo = try? c.decode(Repo.self, forKey: .repo)
            attempts = try? c.decode([Attempt].self, forKey: .attempts)
            tokens = try? c.decode(Tokens.self, forKey: .tokens)
            seconds = try? c.decode(Int.self, forKey: .seconds)
            model = try? c.decode(String.self, forKey: .model)
            planVersion = try? c.decode(Int.self, forKey: .planVersion)
            repoSha = try? c.decode(String.self, forKey: .repoSha)
            builtDocs = try? c.decode(BuiltDocs.self, forKey: .docs)
            builtSections = try? c.decode(BuiltSections.self, forKey: .sections)
        }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encodeIfPresent(categories, forKey: .categories)
            if let builtDocs { try c.encode(builtDocs, forKey: .docs) } else { try c.encodeIfPresent(docs, forKey: .docs) }
            if let builtSections { try c.encode(builtSections, forKey: .sections) } else { try c.encodeIfPresent(sections, forKey: .sections) }
            try c.encodeIfPresent(target, forKey: .target)
            try c.encodeIfPresent(repo, forKey: .repo)
            try c.encodeIfPresent(attempts, forKey: .attempts)
            try c.encodeIfPresent(tokens, forKey: .tokens)
            try c.encodeIfPresent(seconds, forKey: .seconds)
            try c.encodeIfPresent(model, forKey: .model)
            try c.encodeIfPresent(planVersion, forKey: .planVersion)
            try c.encodeIfPresent(repoSha, forKey: .repoSha)
        }
    }

    /// A build's progress while it runs (contract `plan.jobs.progress`): the plan page's «Writing documents».
    public struct Progress: Codable, Equatable, Sendable {
        public struct Docs: Codable, Equatable, Sendable {
            public let done: Int
            public let total: Int
        }

        public struct Current: Codable, Equatable, Sendable {
            public let slug: String
            public let title: String
        }

        public let docs: Docs
        /// The document being written now; nil at the end.
        public let current: Current?
    }

    public let id: String
    public let spaceId: String?
    public let kind: WikiPlanJobKind
    public let trigger: WikiPlanJobTrigger?
    public let state: WikiPlanJobState
    /// A revision's: the owner's words, as they were given.
    public let instructions: String?
    public let requestedAt: String?
    public let held: Held?
    public let waitingFor: WaitingFor?
    public let taskId: String?
    public let provider: String?
    public let sessionId: String?
    public let madeAt: String?
    public let startedAt: String?
    public let endedAt: String?
    /// The gate round the run is on, or ended on, of `attemptsMax`.
    public let attempt: Int?
    public let attemptsMax: Int?
    /// A build's, while it runs: the documents written of how many, and the one being written.
    public let progress: Progress?
    /// A job that succeeded: the version it stored. A build's, from the start: the confirmed version it writes.
    public let version: Int?
    /// A job that failed: the gate's errors on its last round, and what went wrong in words.
    public let errors: [WikiPlanGateError]?
    public let error: String?
    public let report: Report?
    /// A job that failed: the last draft it had, as it was sent to the gate — what the plan page shows in
    /// its place, since the server stores nothing the gate refused. The model wrote it and the gate may
    /// have refused its very shape, so a draft this build cannot read is dropped, never the job with it.
    public var draft: WikiPlanDraftInput? { lossyDraft?.value }
    private let lossyDraft: LossyDecodable<WikiPlanDraftInput>?

    private enum CodingKeys: String, CodingKey {
        case id, spaceId, kind, trigger, state, instructions, requestedAt, held, waitingFor, taskId, provider, sessionId, madeAt,
             startedAt, endedAt, attempt, attemptsMax, progress, version, errors, error, report
        case lossyDraft = "draft"
    }
}

extension LossyDecodable: Equatable where Value: Equatable {
    static func == (a: LossyDecodable, b: LossyDecodable) -> Bool { a.value == b.value }
}

extension LossyDecodable: Encodable where Value: Encodable {
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        if let value { try c.encode(value) } else { try c.encodeNil() }
    }
}

extension LossyDecodable: @unchecked Sendable where Value: Sendable {}

// MARK: - what a draft is written as (the draft's shape, which an edit is sent in)

/// A session condition as a draft writes it: projects by id or exact title, dates as `YYYY-MM-DD`.
public struct WikiPlanSessionConditionInput: Codable, Equatable, Sendable {
    public var projects: [String]?
    public var since: String?
    public var until: String?
    public var keywords: [String]?
    public var anchorPaths: [String]?
    public var entryKinds: [String]?
    public var topics: [String]?
    public var evidence: String?

    public init(projects: [String]? = nil, since: String? = nil, until: String? = nil, keywords: [String]? = nil,
                anchorPaths: [String]? = nil, entryKinds: [String]? = nil, topics: [String]? = nil, evidence: String? = nil) {
        self.projects = projects
        self.since = since
        self.until = until
        self.keywords = keywords
        self.anchorPaths = anchorPaths
        self.entryKinds = entryKinds
        self.topics = topics
        self.evidence = evidence
    }

    /// Lenient: a field of a shape this build does not expect reads as absent, as the web's `??` reads it.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        projects = try? c.decode([String].self, forKey: .projects)
        since = try? c.decode(String.self, forKey: .since)
        until = try? c.decode(String.self, forKey: .until)
        keywords = try? c.decode([String].self, forKey: .keywords)
        anchorPaths = try? c.decode([String].self, forKey: .anchorPaths)
        entryKinds = try? c.decode([String].self, forKey: .entryKinds)
        topics = try? c.decode([String].self, forKey: .topics)
        evidence = try? c.decode(String.self, forKey: .evidence)
    }
}

/// Where a section's material comes from, as a draft writes it.
public struct WikiPlanSourcesInput: Codable, Equatable, Sendable {
    public struct DocSource: Codable, Equatable, Sendable {
        public var path: String
        public var section: String?

        public init(path: String, section: String? = nil) {
            self.path = path
            self.section = section
        }
    }

    public struct CodeSource: Codable, Equatable, Sendable {
        public var path: String
        public var symbols: [String]?

        public init(path: String, symbols: [String]? = nil) {
            self.path = path
            self.symbols = symbols
        }
    }

    public struct ContractSource: Codable, Equatable, Sendable {
        public var path: String

        public init(path: String) { self.path = path }
    }

    public var docs: [DocSource]?
    public var code: [CodeSource]?
    public var contracts: [ContractSource]?
    public var sessions: WikiPlanSessionConditionInput?

    public init(docs: [DocSource]? = nil, code: [CodeSource]? = nil, contracts: [ContractSource]? = nil,
                sessions: WikiPlanSessionConditionInput? = nil) {
        self.docs = docs
        self.code = code
        self.contracts = contracts
        self.sessions = sessions
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        docs = try? c.decode([DocSource].self, forKey: .docs)
        code = try? c.decode([CodeSource].self, forKey: .code)
        contracts = try? c.decode([ContractSource].self, forKey: .contracts)
        sessions = try? c.decode(WikiPlanSessionConditionInput.self, forKey: .sessions)
    }
}

/// A section as a draft writes it: its key when the document had it, none for a section added.
public struct WikiPlanSectionInput: Codable, Equatable, Sendable {
    public var key: String?
    public var title: String
    public var kind: WikiPlanSectionKind
    public var covers: String
    public var length: Int
    public var sources: WikiPlanSourcesInput
    public var extra: [String: JSONValue]?

    private enum CodingKeys: String, CodingKey { case key, title, kind, covers, length, sources, extra }

    public init(key: String? = nil, title: String, kind: WikiPlanSectionKind, covers: String, length: Int,
                sources: WikiPlanSourcesInput = WikiPlanSourcesInput(), extra: [String: JSONValue]? = nil) {
        self.key = key
        self.title = title
        self.kind = kind
        self.covers = covers
        self.length = length
        self.sources = sources
        self.extra = extra
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try? c.decode(String.self, forKey: .key)
        title = (try? c.decode(String.self, forKey: .title)) ?? ""
        kind = (try? c.decode(WikiPlanSectionKind.self, forKey: .kind)) ?? .unknown
        covers = (try? c.decode(String.self, forKey: .covers)) ?? ""
        length = (try? c.decode(Int.self, forKey: .length)) ?? 0
        sources = (try? c.decode(WikiPlanSourcesInput.self, forKey: .sources)) ?? WikiPlanSourcesInput()
        extra = try? c.decode([String: JSONValue].self, forKey: .extra)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(key, forKey: .key)
        try c.encode(title, forKey: .title)
        try c.encode(kind, forKey: .kind)
        try c.encode(covers, forKey: .covers)
        try c.encode(length, forKey: .length)
        try c.encode(sources, forKey: .sources)
        if let extra, !extra.isEmpty { try c.encode(extra, forKey: .extra) }
    }
}

/// A document as a draft writes it — what an owner's edit is sent as (`POST …/plan/edits`), never the read.
public struct WikiPlanDocInput: Codable, Equatable, Sendable {
    public struct ScopeOut: Codable, Equatable, Sendable {
        public var text: String
        public var docs: [String]?

        public init(text: String, docs: [String]? = nil) {
            self.text = text
            self.docs = docs
        }
    }

    public var category: String
    public var slug: String
    public var title: String
    public var question: String
    public var audience: [String]
    public var scopeIn: [String]
    public var scopeOut: [ScopeOut]
    public var length: WikiPlanRange
    public var protected: Bool?
    public var sections: [WikiPlanSectionInput]
    public var extra: [String: JSONValue]?

    private enum CodingKeys: String, CodingKey {
        case category, slug, title, question, audience, scopeIn, scopeOut, length, protected, sections, extra
    }

    public init(category: String, slug: String, title: String, question: String, audience: [String], scopeIn: [String],
                scopeOut: [ScopeOut], length: WikiPlanRange, protected: Bool? = nil, sections: [WikiPlanSectionInput],
                extra: [String: JSONValue]? = nil) {
        self.category = category
        self.slug = slug
        self.title = title
        self.question = question
        self.audience = audience
        self.scopeIn = scopeIn
        self.scopeOut = scopeOut
        self.length = length
        self.protected = protected
        self.sections = sections
        self.extra = extra
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        category = (try? c.decode(String.self, forKey: .category)) ?? ""
        slug = (try? c.decode(String.self, forKey: .slug)) ?? ""
        title = (try? c.decode(String.self, forKey: .title)) ?? ""
        question = (try? c.decode(String.self, forKey: .question)) ?? ""
        audience = (try? c.decode([String].self, forKey: .audience)) ?? []
        scopeIn = (try? c.decode([String].self, forKey: .scopeIn)) ?? []
        scopeOut = (try? c.decode([ScopeOut].self, forKey: .scopeOut)) ?? []
        length = (try? c.decode(WikiPlanRange.self, forKey: .length)) ?? WikiPlanRange(min: 0, max: 0)
        protected = try? c.decode(Bool.self, forKey: .protected)
        sections = (try? c.decode([WikiPlanSectionInput].self, forKey: .sections)) ?? []
        extra = try? c.decode([String: JSONValue].self, forKey: .extra)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(category, forKey: .category)
        try c.encode(slug, forKey: .slug)
        try c.encode(title, forKey: .title)
        try c.encode(question, forKey: .question)
        try c.encode(audience, forKey: .audience)
        try c.encode(scopeIn, forKey: .scopeIn)
        try c.encode(scopeOut, forKey: .scopeOut)
        try c.encode(length, forKey: .length)
        try c.encodeIfPresent(protected, forKey: .protected)
        try c.encode(sections, forKey: .sections)
        if let extra, !extra.isEmpty { try c.encode(extra, forKey: .extra) }
    }
}

/// A category as a draft writes it.
public struct WikiPlanCategoryInput: Codable, Equatable, Sendable {
    public var key: String
    public var title: String?
    public var question: String?
    public var forAgents: Bool?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = (try? c.decode(String.self, forKey: .key)) ?? ""
        title = try? c.decode(String.self, forKey: .title)
        question = try? c.decode(String.self, forKey: .question)
        forAgents = try? c.decode(Bool.self, forKey: .forAgents)
    }
}

/// A whole draft as it was sent to the gate: what a failed job keeps.
public struct WikiPlanDraftInput: Codable, Equatable, Sendable {
    public let categories: [WikiPlanCategoryInput]
    public let docs: [WikiPlanDocInput]
}

/// `POST /api/wiki/spaces/:id/plan/edits`: one document, or one section of one, as the owner rewrote it,
/// over `baseVersion` — the space's newest draft or confirmed version.
public struct WikiPlanEditRequest: Codable, Equatable, Sendable {
    public let baseVersion: Int
    public let docSlug: String
    public let doc: WikiPlanDocInput?
    public let sectionKey: String?
    public let section: WikiPlanSectionInput?

    public init(baseVersion: Int, docSlug: String, doc: WikiPlanDocInput) {
        self.baseVersion = baseVersion
        self.docSlug = docSlug
        self.doc = doc
        sectionKey = nil
        section = nil
    }

    public init(baseVersion: Int, docSlug: String, sectionKey: String, section: WikiPlanSectionInput) {
        self.baseVersion = baseVersion
        self.docSlug = docSlug
        doc = nil
        self.sectionKey = sectionKey
        self.section = section
    }
}

/// `POST /api/wiki/spaces/:id/plan/redraft`: with instructions a revision of the newest version, without a draft.
public struct WikiPlanRedraftRequest: Codable, Equatable, Sendable {
    public let instructions: String?

    public init(instructions: String?) {
        let words = instructions?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.instructions = words.isEmpty ? nil : words
    }
}

/// `POST /api/wiki/plan-proposals/:id/decide`.
public struct WikiPlanDecideRequest: Codable, Equatable, Sendable {
    public enum Action: String, Codable, Sendable { case accept, reject }
    public let action: Action
    public let note: String?

    public init(action: Action, note: String? = nil) {
        self.action = action
        self.note = note
    }
}

/// Its answer: the proposal as decided, and the draft an acceptance made.
public struct WikiPlanDecisionResult: Codable, Equatable, Sendable {
    public let proposal: WikiPlanProposal
    public let draft: WikiPlanVersion?
}

/// `POST /api/wiki/spaces/:id/plan/redraft`'s answer: the job made, or the space's draft that had not ended.
public struct WikiPlanRedraftResult: Codable, Equatable, Sendable {
    public let created: Bool
    public let job: WikiPlanJob
}

/// One thing the gate found: which check, where, and why (contract `plan.gate.errors`).
public struct WikiPlanGateError: Codable, Equatable, Sendable {
    public let check: WikiPlanGateCheck
    public let path: String
    public let message: String
}
