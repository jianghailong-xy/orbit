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
    public let docCount: Int?
    public let createdAt: String?
    public let confirmedAt: String?
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
            }

            public let category: String?
            public let slug: String
            public let title: String?
            public let question: String?
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

        public let categories: Int?
        public let docs: Int?
        public let sections: Int?
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
            case categories, docs, sections, attempts, tokens, seconds, model, planVersion, repoSha
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            categories = try? c.decode(Int.self, forKey: .categories)
            docs = try? c.decode(Int.self, forKey: .docs)
            sections = try? c.decode(Int.self, forKey: .sections)
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
