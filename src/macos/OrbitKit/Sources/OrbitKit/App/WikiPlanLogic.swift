import Foundation

// The Wiki's plan on the native pages (criterion 10 revised 2026-09-28 and criterion 11, mocks 22 and 26) —
// the Swift half of the web's `src/web/src/lib/wikiPlan.ts`: the plan page — the version shown and its
// history, the job that drafts it or writes its documents, the gate's report, the categories and documents
// with every section's material, the changes a maintenance run proposed, Redraft… and Edit — and the plan's
// banner on the home.
//
// Every sentence is a constant or a function here, because `WikiPlanCopyParityTests` looks each one up in
// the web source; every reading is proved against the `plan` cases of `src/shared/src/wiki-docs.fixture.json`,
// which the web's `lib/wikiPlan.test.ts` reads too.
//
// TWO SHAPES OF A PLAN, ONE PAGE, as on the web: a stored version is read back with ids, positions and its
// projects resolved; the draft a job that failed the gate last had is kept as it was sent to the gate. Both
// are read into `Shown` first. An owner's edit goes the other way, in the DRAFT's shape (no ids or
// positions, a session condition's projects by id) — never as it was read back.

/// Every sentence the plan pages say. The web's constant each one mirrors is named beside it.
public enum WikiPlanCopy {
    public static let title = "Plan"                                        // WIKI_PLAN_TITLE
    public static let redraft = "Redraft…"                                  // WIKI_PLAN_REDRAFT
    public static let confirm = "Confirm plan"                              // WIKI_PLAN_CONFIRM
    public static let draft = "Draft plan"                                  // WIKI_PLAN_DRAFT
    public static let open = "Open plan"                                    // WIKI_PLAN_OPEN
    public static let edit = "Edit"                                         // WIKI_PLAN_EDIT
    public static let accept = "Accept"                                     // WIKI_PLAN_ACCEPT
    public static let reject = "Reject"                                     // WIKI_PLAN_REJECT
    public static let cancel = "Cancel"                                     // WIKI_PLAN_CANCEL
    public static let viewRun = "View run"                                  // WIKI_PLAN_VIEW_RUN
    public static let setUp = "Set up maintenance"                          // WIKI_PLAN_SET_UP
    public static let viewRunners = "View runners"                          // WIKI_PLAN_VIEW_RUNNERS
    /// The empty page (mock 22 ①).
    public static let none = "This space has no plan yet"                   // WIKI_PLAN_NONE
    public static let emptyTitle = "No plan yet"                            // WIKI_PLAN_EMPTY_TITLE
    public static let documents = "Documents"                               // WIKI_PLAN_DOCUMENTS
    public static let inForce = "the plan in force"                         // WIKI_PLAN_IN_FORCE
    /// The job's card (mock 22 ⑩).
    public static let queued = "Queued"                                     // WIKI_PLAN_QUEUED
    public static let drafting = "Drafting"                                 // WIKI_PLAN_DRAFTING
    public static let held = "Held"                                         // WIKI_PLAN_HELD
    public static let failed = "Didn’t pass the plan check"                 // WIKI_PLAN_FAILED
    public static let passed = "Passed the plan check"                      // WIKI_PLAN_PASSED
    public static let writing = "Writing documents"                         // WIKI_PLAN_WRITING
    public static let writingNow = "Writing now:"                           // WIKI_PLAN_WRITING_NOW
    public static let jobFailed = "The draft didn’t finish"                 // WIKI_PLAN_JOB_FAILED
    public static let buildFailed = "Writing documents didn’t finish"       // WIKI_PLAN_BUILD_FAILED
    public static let queuedText = "starts after the Wiki maintenance run that’s going now"   // WIKI_PLAN_QUEUED_TEXT
    public static let writingSoon = "waiting for its run to start"         // WIKI_PLAN_WRITING_SOON
    /// A document's fields (mock 22 ③).
    public static let question = "Question"                                 // WIKI_PLAN_QUESTION
    public static let writtenFor = "Written for"                            // WIKI_PLAN_WRITTEN_FOR
    public static let covers = "Covers"                                     // WIKI_PLAN_COVERS
    public static let notCovered = "Not covered"                            // WIKI_PLAN_NOT_COVERED
    public static let length = "Length"                                     // WIKI_PLAN_LENGTH
    public static let protected = "Protected"                               // WIKI_PLAN_PROTECTED
    public static let drawsOn = "Draws on"                                  // WIKI_PLAN_DRAWS_ON
    public static let sections = "Sections"                                 // WIKI_PLAN_SECTIONS
    public static let protectedNote = "Protected — a redraft keeps it as it is; only you can change it"   // WIKI_PLAN_PROTECTED_NOTE
    public static let notProtectedNote = "Not protected — a redraft may change it"                        // WIKI_PLAN_NOT_PROTECTED_NOTE
    /// A section's sources (mock 22 ④⑤).
    public static let sourceDocs = "Design docs"                            // WIKI_PLAN_SOURCE_DOCS
    public static let sourceCode = "Code"                                   // WIKI_PLAN_SOURCE_CODE
    public static let sourceContracts = "Contracts"                         // WIKI_PLAN_SOURCE_CONTRACTS
    public static let sourceSessions = "Where to look for the words"        // WIKI_PLAN_SOURCE_SESSIONS_SHORT
    public static let sessionProjects = "Projects"                          // WIKI_PLAN_SESSION_PROJECTS
    public static let sessionTime = "Time"                                  // WIKI_PLAN_SESSION_TIME
    public static let sessionKeywords = "Keywords"                          // WIKI_PLAN_SESSION_KEYWORDS
    public static let sessionAnchors = "Anchor paths"                       // WIKI_PLAN_SESSION_ANCHORS
    public static let sessionKinds = "Entry kinds"                          // WIKI_PLAN_SESSION_KINDS
    public static let sessionTopics = "Topics"                              // WIKI_PLAN_SESSION_TOPICS
    public static let sessionEvidence = "Looking for"                       // WIKI_PLAN_SESSION_EVIDENCE
    public static let found = "✓ found"                                     // WIKI_PLAN_FOUND
    public static let notFound = "✗ not found"                              // WIKI_PLAN_NOT_FOUND
    /// The changes proposed (mock 22 ⑥⑦).
    public static let changes = "Changes to review"                         // WIKI_PLAN_CHANGES
    public static let proposedBy = "Proposed by"                            // WIKI_PLAN_PROPOSED_BY
    public static let why = "Why"                                           // WIKI_PLAN_WHY
    public static let change = "Change"                                     // WIKI_PLAN_CHANGE
    public static let sources = "Sources"                                   // WIKI_PLAN_SOURCES
    public static let from = "From"                                         // WIKI_PLAN_FROM
    public static let check = "Check"                                       // WIKI_PLAN_CHECK
    public static let changeRejected = "Change rejected"                    // WIKI_PLAN_CHANGE_REJECTED
    public static let redraftAsked = "Redraft asked for — it runs as a Wiki maintenance task"   // WIKI_PLAN_REDRAFT_ASKED
    public static let redraftAlready = "A draft is already on its way"      // WIKI_PLAN_REDRAFT_ALREADY
    public static let acceptRefused = "This change no longer passes the plan check, so nothing was confirmed:"   // WIKI_PLAN_ACCEPT_REFUSED
    /// Redraft… (mock 22 ⑧).
    public static let redraftTitle = "Redraft the plan"                     // WIKI_PLAN_REDRAFT_TITLE
    public static let redraftGo = "Redraft"                                 // WIKI_PLAN_REDRAFT_GO
    public static let redraftPlaceholder = "What should change: what to merge, split, move or leave out"   // WIKI_PLAN_REDRAFT_PLACEHOLDER
    /// Edit (mock 22 ⑨).
    public static let editTitleField = "Title"                              // WIKI_PLAN_EDIT_TITLE_FIELD
    public static let editKind = "Kind"                                     // WIKI_PLAN_EDIT_KIND
    public static let protectedSwitch = "A redraft keeps it as it is"       // WIKI_PLAN_PROTECTED_SWITCH
    public static let addSection = "Add section"                            // WIKI_PLAN_ADD_SECTION
    public static let saveDraft = "Save draft"                              // WIKI_PLAN_SAVE_DRAFT

    /// The references a failed draft's report lists on a phone before `Show N more` (`WIKI_PLAN_REFS_SHOWN_PHONE`).
    public static let refsShownPhone = 3
    /// The facts a change's From lists before `and N more` (`WIKI_PLAN_FACTS_SHOWN`).
    public static let factsShown = 2
    /// The length a section added in Edit is written to until the owner says otherwise (`WIKI_PLAN_NEW_SECTION_LENGTH`).
    public static let newSectionLength = 500

    private static func plural(_ n: Int, _ one: String, _ many: String) -> String {
        "\(WikiArticleCopy.count(n)) \(n == 1 ? one : many)"
    }

    /// A version as the head and the version menu name it: `v2` (`wikiPlanVersionLabel`).
    public static func versionLabel(_ version: Int) -> String { "v\(version)" }

    /// The empty page's sentence (`wikiPlanEmptyText`).
    public static func emptyText(provider: String?) -> String {
        "A plan lays out this wiki’s documents: the categories, the documents in each, who each one is for and what it covers, "
            + "and where each section’s material comes from. \(provider ?? WikiCopy.historyMaintenance) drafts it; nothing is written until you confirm it."
    }

    /// Where a draft runs and how long it takes, under Draft plan (`wikiPlanEmptyNote`).
    public static func emptyNote(where place: String?, provider: String?) -> String {
        let on = place.map { ", on \($0)" } ?? ""
        let with = provider.map { " with \($0)" } ?? ""
        return "Runs as a task in the Wiki maintenance list\(on)\(with) — usually 1–2 hours. Until you confirm a plan, the Wiki shows its topic articles."
    }

    /// The sentence under the head of a draft that failed the gate (`wikiPlanFailedHint`).
    public static func failedHint(inForce: Int?) -> String {
        "Confirm needs a passing check. Redraft with what to change — "
            + (inForce.map { "v\($0) stays in force until you confirm" } ?? "until you confirm a plan, the Wiki shows its topic articles") + "."
    }

    public static func chars(_ length: WikiPlanRange) -> String {                                  // wikiPlanChars
        length.min == length.max ? "\(WikiArticleCopy.count(length.min)) chars"
            : "\(WikiArticleCopy.count(length.min))–\(WikiArticleCopy.count(length.max)) chars"
    }
    public static func sectionChars(_ n: Int) -> String { "~\(WikiArticleCopy.count(n)) chars" }        // wikiPlanSectionChars
    public static func errorCount(_ n: Int) -> String { plural(n, "error", "errors") }                  // wikiPlanErrorCount
    public static func changeCount(_ n: Int) -> String { plural(n, "change", "changes") }               // wikiPlanChangeCount
    public static func andMore(_ n: Int) -> String { "and \(WikiArticleCopy.count(n)) more" }           // wikiPlanAndMore
    public static func saveNote(_ next: Int) -> String { "Saving makes draft v\(next); it goes through the plan check again." }   // wikiPlanSaveNote
    public static func editTitle(_ number: String) -> String { "Edit \(number)" }                       // wikiPlanEditTitle
    public static func confirmed(_ version: Int) -> String { "Plan v\(version) confirmed" }              // wikiPlanConfirmed
    public static func changeAdded(_ version: Int) -> String { "Change added to draft v\(version)" }     // wikiPlanChangeAdded
    public static func draftSaved(_ version: Int) -> String { "Draft v\(version) saved" }                // wikiPlanDraftSaved
    public static func protectedKept(_ numbers: [String]) -> String { "Protected, kept as they are: \(numbers.joined(separator: " · "))" }   // wikiPlanProtectedKept

    /// A session condition's window: `2026-08-19 → now` (`wikiPlanTime`).
    public static func time(since: String?, until: String?) -> String {
        if since == nil && until == nil { return "any time" }
        return "\(since ?? "the start") → \(until ?? "now")"
    }

    /// The dialog's sentence (`wikiPlanRedraftNote`): what drafts it again, from which version, how often it retries.
    public static func redraftNote(provider: String?, from: (version: Int, inForce: Bool)?) -> String {
        let base = from.map { $0.inForce ? " from v\($0.version), the plan in force," : " from draft v\($0.version)," } ?? ""
        return "\(provider ?? WikiCopy.historyMaintenance) drafts it again\(base) with what you write here. A draft that doesn’t pass the plan check is "
            + "redrafted with its errors, up to 3 times."
    }

    /// A section lost from a protected document, in the draft's own rows: `v1 §7 已知的坑` (`wikiPlanLostLabel`).
    public static func lostLabel(base: Int, number: Int, title: String) -> String { "v\(base) §\(number) \(title)" }
    /// The same, on a phone, in one line: `Moved to 11.3 — 3.1 is protected` (`wikiPlanProtectedMovePhone`).
    public static func protectedMovePhone(movedTo: String?, number: String) -> String {
        "\(movedTo.map { "Moved to \($0)" } ?? "Moved out") — \(number) is protected"
    }
}

public enum WikiPlanLogic {
    // MARK: orders

    /// The plan page's blocks, top to bottom — the web phone's order (`WIKI_PLAN_PAGE_SECTIONS`).
    public enum PageSection: String, CaseIterable, Sendable {
        case crumb, title, meta, actions, hint, job, gate, changes, documents
    }

    /// A document's own page (`WIKI_PLAN_DOC_SECTIONS`).
    public enum DocSection: String, CaseIterable, Sendable {
        case crumb, title, meta, fields, sections
    }

    /// A section's own page (`WIKI_PLAN_SECTION_SECTIONS`).
    public enum SectionSection: String, CaseIterable, Sendable {
        case crumb, title, meta, covers, sources
    }

    /// A change's card, top to bottom (`WIKI_PLAN_CHANGE_PARTS`).
    public enum ChangePart: String, CaseIterable, Sendable {
        case head, title, why, change, sources, from, check, actions
    }

    private static func plural(_ n: Int, _ one: String, _ many: String) -> String {
        "\(WikiArticleCopy.count(n)) \(n == 1 ? one : many)"
    }

    // MARK: a plan, as the page draws it

    public struct ShownSessions: Equatable, Sendable {
        public let projects: [(id: String?, title: String)]
        public let since: String?
        public let until: String?
        public let keywords: [String]
        public let anchorPaths: [String]
        public let entryKinds: [String]
        public let topics: [String]
        public let evidence: String

        public static func == (a: ShownSessions, b: ShownSessions) -> Bool {
            a.projects.map(\.id) == b.projects.map(\.id) && a.projects.map(\.title) == b.projects.map(\.title)
                && a.since == b.since && a.until == b.until && a.keywords == b.keywords && a.anchorPaths == b.anchorPaths
                && a.entryKinds == b.entryKinds && a.topics == b.topics && a.evidence == b.evidence
        }
    }

    public struct ShownSources: Equatable, Sendable {
        public let docs: [(path: String, section: String?)]
        public let code: [(path: String, symbols: [String])]
        public let contracts: [String]
        public let sessions: ShownSessions?

        public static func == (a: ShownSources, b: ShownSources) -> Bool {
            a.docs.map(\.path) == b.docs.map(\.path) && a.docs.map(\.section) == b.docs.map(\.section)
                && a.code.map(\.path) == b.code.map(\.path) && a.code.map(\.symbols) == b.code.map(\.symbols)
                && a.contracts == b.contracts && a.sessions == b.sessions
        }
    }

    public struct ShownSection: Equatable, Sendable {
        public let key: String?
        public let title: String
        public let kind: WikiPlanSectionKind
        public let covers: String
        public let length: Int
        public let sources: ShownSources
    }

    public struct ShownDoc: Equatable, Sendable, Identifiable {
        /// Its place in the plan's `docs`: what a gate error's path names it by (`plan.docs[12]`).
        public let index: Int
        public let number: String
        public let slug: String
        public let category: String
        public let title: String
        public let question: String
        public let audience: [String]
        public let scopeIn: [String]
        public let scopeOut: [(text: String, docs: [String])]
        public let length: WikiPlanRange
        public let protected: Bool
        public let sections: [ShownSection]
        /// The stored document, when the version is stored: what an edit starts from.
        public let stored: WikiPlanDoc?
        public var id: String { slug }

        public static func == (a: ShownDoc, b: ShownDoc) -> Bool {
            a.index == b.index && a.number == b.number && a.slug == b.slug && a.category == b.category && a.title == b.title
                && a.question == b.question && a.audience == b.audience && a.scopeIn == b.scopeIn
                && a.scopeOut.map(\.text) == b.scopeOut.map(\.text) && a.scopeOut.map(\.docs) == b.scopeOut.map(\.docs)
                && a.length == b.length && a.protected == b.protected && a.sections == b.sections && a.stored == b.stored
        }
    }

    public struct ShownCategory: Equatable, Sendable, Identifiable {
        public let key: String
        public let number: Int
        public let title: String
        public let question: String
        public let forAgents: Bool
        public let docs: [ShownDoc]
        public var id: String { key }
    }

    /// What the page shows: a stored version's status, or a failed draft's.
    public enum ShownStatus: String, Equatable, Sendable {
        case draft, confirmed, superseded, failed

        /// The version menu's and the head's word (`WIKI_PLAN_STATUS_LABELS`): a failed draft is a Draft.
        public var label: String {
            switch self {
            case .draft, .failed: return "Draft"
            case .confirmed: return "Confirmed"
            case .superseded: return "Superseded"
            }
        }
    }

    /// A version, or the draft a failed job last had, read into one shape (`WikiPlanShown`).
    public struct Shown: Equatable, Sendable {
        public let version: Int
        public let status: ShownStatus
        public let origin: WikiPlanOrigin
        public let baseVersion: Int?
        public let proposalId: String?
        public let categories: [ShownCategory]
        /// In the plan's order.
        public let docs: [ShownDoc]
        public let target: WikiPlanRange
        public let gate: WikiPlanGateReport?
        public let repoCheck: WikiPlanRepoCheck?
        public let model: String?
        public let createdAt: String?
        public let confirmedAt: String?
        /// A failed draft's: the gate's errors on its last round.
        public let errors: [WikiPlanGateError]
    }

    private struct DocRow {
        let index: Int, slug: String, category: String, title: String, question: String, audience: [String], scopeIn: [String]
        let scopeOut: [(text: String, docs: [String])], length: WikiPlanRange, protected: Bool, sections: [ShownSection], stored: WikiPlanDoc?
    }

    /// Number the documents the way the directory does: `<category number>.<place in the category>`.
    private static func numbered(_ categories: [(key: String, title: String, question: String, forAgents: Bool)],
                                 _ rows: [DocRow]) -> (categories: [ShownCategory], docs: [ShownDoc]) {
        var numberOf: [String: Int] = [:]
        for (i, category) in categories.enumerated() where numberOf[category.key] == nil { numberOf[category.key] = i + 1 }
        var placed: [String: Int] = [:]
        var docs: [ShownDoc] = []
        for row in rows {
            var number = "—"
            if let n = numberOf[row.category] {
                placed[row.category, default: 0] += 1
                number = "\(n).\(placed[row.category]!)"
            }
            docs.append(ShownDoc(index: row.index, number: number, slug: row.slug, category: row.category, title: row.title,
                                 question: row.question, audience: row.audience, scopeIn: row.scopeIn, scopeOut: row.scopeOut,
                                 length: row.length, protected: row.protected, sections: row.sections, stored: row.stored))
        }
        let shownCategories = categories.enumerated().map { i, category in
            ShownCategory(key: category.key, number: i + 1, title: category.title.isEmpty ? category.key : category.title,
                          question: category.question, forAgents: category.forAgents,
                          docs: docs.filter { $0.category == category.key && numberOf[category.key] == i + 1 })
        }
        return (shownCategories, docs)
    }

    private static func sessionsOf(_ sessions: WikiPlanSessionCondition?) -> ShownSessions? {
        guard let sessions else { return nil }
        return ShownSessions(projects: (sessions.projects ?? []).map { ($0.id, $0.title ?? $0.id) },
                             since: sessions.since, until: sessions.until, keywords: sessions.keywords ?? [],
                             anchorPaths: sessions.anchorPaths ?? [],
                             entryKinds: (sessions.entryKinds ?? []).map(\.rawValue), topics: sessions.topics ?? [],
                             evidence: sessions.evidence ?? "")
    }

    private static func shownStatus(_ status: WikiPlanStatus) -> ShownStatus {
        switch status {
        case .confirmed: return .confirmed
        case .superseded: return .superseded
        default: return .draft
        }
    }

    /// A stored version, as the page draws it (`wikiPlanFromVersion`).
    public static func fromVersion(_ version: WikiPlanVersion) -> Shown {
        let rows = (version.docs ?? []).enumerated().map { index, doc in
            DocRow(index: index, slug: doc.slug, category: doc.category, title: doc.title, question: doc.question ?? "",
                   audience: doc.audience ?? [], scopeIn: doc.scopeIn ?? [],
                   scopeOut: (doc.scopeOut ?? []).map { ($0.text, $0.docs ?? []) },
                   length: doc.length ?? WikiPlanRange(min: 0, max: 0), protected: doc.protected ?? false,
                   sections: (doc.sections ?? []).map { section in
                       ShownSection(key: section.key, title: section.title, kind: section.kind, covers: section.covers ?? "",
                                    length: section.length ?? 0,
                                    sources: ShownSources(docs: (section.sources?.docs ?? []).map { ($0.path, $0.section) },
                                                          code: (section.sources?.code ?? []).map { ($0.path, $0.symbols ?? []) },
                                                          contracts: (section.sources?.contracts ?? []).map(\.path),
                                                          sessions: sessionsOf(section.sources?.sessions)))
                   },
                   stored: doc)
        }
        let categories = (version.categories ?? []).map { ($0.key, $0.title ?? $0.key, $0.question ?? "", $0.forAgents ?? false) }
        let (shownCategories, docs) = numbered(categories.map { (key: $0.0, title: $0.1, question: $0.2, forAgents: $0.3) }, rows)
        return Shown(version: version.version, status: shownStatus(version.status), origin: version.origin ?? .maintenance,
                     baseVersion: version.baseVersion, proposalId: version.proposalId, categories: shownCategories, docs: docs,
                     target: version.target ?? WikiPlanRange(min: 20, max: 35), gate: version.gate, repoCheck: version.repoCheck,
                     model: version.model, createdAt: version.createdAt, confirmedAt: version.confirmedAt, errors: [])
    }

    /// The draft a failed job last had, as the page draws it — numbered as the version it would have been
    /// (`wikiPlanFromFailedJob`).
    public static func fromFailedJob(_ job: WikiPlanJob, number: Int, baseVersion: Int?) -> Shown? {
        guard let draft = job.draft else { return nil }
        let report = job.kind != .build ? job.report : nil
        let rows = draft.docs.enumerated().map { index, doc in
            DocRow(index: index, slug: doc.slug, category: doc.category, title: doc.title, question: doc.question,
                   audience: doc.audience, scopeIn: doc.scopeIn, scopeOut: doc.scopeOut.map { ($0.text, $0.docs ?? []) },
                   length: doc.length, protected: doc.protected ?? false,
                   sections: doc.sections.map { section in
                       ShownSection(key: section.key, title: section.title, kind: section.kind, covers: section.covers,
                                    length: section.length,
                                    sources: ShownSources(
                                        docs: (section.sources.docs ?? []).map { ($0.path, $0.section) },
                                        code: (section.sources.code ?? []).map { ($0.path, $0.symbols ?? []) },
                                        contracts: (section.sources.contracts ?? []).map(\.path),
                                        sessions: section.sources.sessions.map { sessions in
                                            ShownSessions(projects: (sessions.projects ?? []).map { (nil, $0) }, since: sessions.since,
                                                          until: sessions.until, keywords: sessions.keywords ?? [],
                                                          anchorPaths: sessions.anchorPaths ?? [], entryKinds: sessions.entryKinds ?? [],
                                                          topics: sessions.topics ?? [], evidence: sessions.evidence ?? "")
                                        }))
                   },
                   stored: nil)
        }
        let categories = draft.categories.map { (key: $0.key, title: $0.title ?? $0.key, question: $0.question ?? "", forAgents: $0.forAgents ?? false) }
        let (shownCategories, docs) = numbered(categories, rows)
        let target = report?.target ?? WikiPlanRange(min: 20, max: 35)
        let repo = report?.repo.map { WikiPlanRepoCheck(sha: $0.sha, checked: $0.checked, missing: []) }
        return Shown(version: number, status: .failed, origin: .maintenance, baseVersion: baseVersion, proposalId: nil,
                     categories: shownCategories, docs: docs, target: target, gate: nil, repoCheck: repo,
                     model: report?.model ?? job.provider, createdAt: job.endedAt, confirmedAt: nil, errors: job.errors ?? [])
    }

    /// The newest version the space has stored, draft or confirmed (`wikiPlanNewest`).
    public static func newest(_ state: WikiPlanState) -> WikiPlanVersion? { state.draft ?? state.confirmed }

    /// The job whose failure the page and the home still show (`wikiPlanFailedJob`): a draft or a revision
    /// that ended failed with no version stored since it was asked for.
    public static func failedJob(_ state: WikiPlanState) -> WikiPlanJob? {
        guard let job = state.job, job.state == .failed, job.kind != .build else { return nil }
        if let newest = newest(state), let made = newest.createdAt.flatMap(RelativeTime.parse),
           let asked = job.requestedAt.flatMap(RelativeTime.parse), made > asked { return nil }
        return job
    }

    /// The draft or revision still on its way: queued, held or running (`wikiPlanOpenJob`).
    public static func openJob(_ state: WikiPlanState) -> WikiPlanJob? {
        guard let job = state.job, job.kind != .build, [.queued, .held, .running].contains(job.state) else { return nil }
        return job
    }

    /// The number the next version gets (`wikiPlanNextVersion`).
    public static func nextVersion(_ state: WikiPlanState) -> Int {
        max(state.confirmed?.version ?? 0, state.draft?.version ?? 0) + 1
    }

    /// What the page shows with no version asked for (`wikiPlanDefault`): the failed draft, the draft waiting,
    /// the version in force — or nothing, the empty page.
    public static func defaultShown(_ state: WikiPlanState) -> Shown? {
        if let failed = failedJob(state), let shown = fromFailedJob(failed, number: nextVersion(state), baseVersion: newest(state)?.version) {
            return shown
        }
        if let draft = state.draft { return fromVersion(draft) }
        if let confirmed = state.confirmed { return fromVersion(confirmed) }
        return nil
    }

    /// What the shown version is held against (the plan page's `base`): a failed draft against the newest
    /// version, a draft against the version in force.
    public static func base(of shown: Shown, in state: WikiPlanState) -> Shown? {
        switch shown.status {
        case .failed: return newest(state).map(fromVersion)
        case .draft: return state.confirmed.map(fromVersion)
        default: return nil
        }
    }

    // MARK: the head

    private static func counts(_ shown: Shown) -> String {
        let sections = shown.docs.reduce(0) { $0 + $1.sections.count }
        return "\(plural(shown.categories.count, "category", "categories")) · \(plural(shown.docs.count, "document", "documents")) · "
            + plural(sections, "section", "sections")
    }

    /// The line under the head (`wikiPlanMeta`): where the version came from, the model and when, what it
    /// holds — and on the version in force, how far its documents are written.
    public static func meta(_ shown: Shown, job: WikiPlanJob?, docs: (written: Int, total: Int)?, timeZone: TimeZone = .current) -> [String] {
        switch shown.status {
        case .confirmed:
            var parts = ["Confirmed \(shown.confirmedAt.flatMap { WikiModeLogic.monthDay($0, timeZone: timeZone) } ?? "") by you"
                .replacingOccurrences(of: "  ", with: " "), counts(shown)]
            if let docs, docs.written < docs.total {
                parts.append("\(WikiArticleCopy.count(docs.written)) written, \(WikiArticleCopy.count(docs.total - docs.written)) to write")
            }
            return parts
        case .superseded:
            return ["Superseded · made \(WikiDocCopy.monthDayTime(shown.createdAt, timeZone: timeZone) ?? "")", counts(shown)]
        case .draft, .failed:
            var parts: [String] = []
            let asked = job?.trigger == .owner
            if shown.origin == .owner {
                parts.append(shown.proposalId != nil ? "v\(shown.baseVersion ?? 0) with the change you accepted" : "v\(shown.baseVersion ?? 0) with your edit")
            } else if let base = shown.baseVersion {
                parts.append("Redrafted from v\(base)\(asked ? " at your request" : "")")
            } else {
                parts.append(asked ? "First draft · at your request" : "First draft")
            }
            let made = [shown.model, WikiDocCopy.monthDayTime(shown.createdAt, timeZone: timeZone)].compactMap { $0 }.joined(separator: " · ")
            if !made.isEmpty { parts.append(made) }
            parts.append(counts(shown))
            return parts
        }
    }

    /// A row of the version menu (`WikiPlanVersionRow`).
    public struct VersionRow: Equatable, Sendable, Identifiable {
        public let version: Int
        public let status: ShownStatus
        public let note: String
        public var id: Int { version }
    }

    /// Every stored version, and a failed draft over them, newest first (`wikiPlanVersionRows`).
    public static func versionRows(_ versions: [WikiPlanVersionSummary], failed: (version: Int, at: String?)?,
                                   timeZone: TimeZone = .current) -> [VersionRow] {
        var rows = versions.map { row -> VersionRow in
            let at = WikiDocCopy.monthDayTime(row.confirmedAt ?? row.createdAt, timeZone: timeZone) ?? ""
            let made = row.origin == .owner ? (row.proposalId != nil ? "Accepted change" : "Your edit") : row.baseVersion != nil ? "Redraft" : "First draft"
            let status = shownStatus(row.status)
            let note = status == .confirmed ? "\(at) · confirmed by you" : status == .draft ? "\(made) · \(at) · waiting for you" : "\(made) · \(at)"
            return VersionRow(version: row.version, status: status, note: note)
        }
        if let failed {
            rows.insert(VersionRow(version: failed.version, status: .failed,
                                   note: "Redraft · \(WikiDocCopy.monthDayTime(failed.at, timeZone: timeZone) ?? "") · didn’t pass the check"), at: 0)
        }
        return rows.sorted { $0.version > $1.version }
    }

    /// The head of a job that has no version to show yet (`wikiPlanJobHead`).
    public static func jobHead(_ job: WikiPlanJob, timeZone: TimeZone = .current) -> String {
        let what = job.kind == .revise ? "Redraft" : "First draft"
        if job.trigger == .spaceCreated { return "\(what) · asked when the space was made" }
        return "\(what) · you asked \(WikiDocCopy.monthDayTime(job.requestedAt, timeZone: timeZone) ?? "")"
    }

    // MARK: the job

    /// Why a job cannot go on (`WikiPlanHeld`): the server's two held reasons, and the runner that is offline.
    public enum Held: String, CaseIterable, Sendable {
        case noMaintenanceWorkspace = "no_maintenance_workspace"
        case maintenanceProviderUnusable = "maintenance_provider_unusable"
        case runnerOffline = "runner_offline"
    }

    /// Why a draft or a revision is held (`WIKI_PLAN_HELD_TEXT`).
    public static func heldText(_ held: Held) -> String {
        switch held {
        case .noMaintenanceWorkspace: return "No maintenance workspace is set up — a draft runs where maintenance runs."
        case .maintenanceProviderUnusable: return "No usable maintenance provider is set up — a draft runs on the provider maintenance uses."
        case .runnerOffline: return "The maintenance runner is offline — the draft starts once it’s back."
        }
    }

    /// Why the documents of a confirmed version are held (`WIKI_PLAN_BUILD_HELD_TEXT`).
    public static func buildHeldText(_ held: Held) -> String {
        switch held {
        case .noMaintenanceWorkspace: return "No maintenance workspace is set up — documents are written where maintenance runs."
        case .maintenanceProviderUnusable: return "No usable maintenance provider is set up — documents are written on the provider maintenance uses."
        case .runnerOffline: return "The maintenance runner is offline — writing starts once it’s back."
        }
    }

    /// A held job's sentence, by what it does (`wikiPlanHeldText`).
    public static func heldText(_ job: WikiPlanJob, _ held: Held) -> String {
        job.kind == .build ? buildHeldText(held) : heldText(held)
    }

    /// Why a job is held, if it is (`wikiPlanHeld`): what the server stored, or a job whose run has not
    /// started while the maintenance runner is offline. Never the daily limit (owner's call 2026-09-29).
    public static func held(_ job: WikiPlanJob?, runnerOnline: Bool?) -> Held? {
        guard let job else { return nil }
        if job.state == .held {
            switch job.held?.reason {
            case .maintenanceProviderUnusable?: return .maintenanceProviderUnusable
            default: return .noMaintenanceWorkspace
            }
        }
        if (job.state == .running || job.state == .queued) && job.startedAt == nil && runnerOnline == false { return .runnerOffline }
        return nil
    }

    /// The space's build while it has not ended (`wikiPlanBuildJob`).
    public static func buildJob(_ state: WikiPlanState) -> WikiPlanJob? {
        guard let job = state.job, job.kind == .build, [.queued, .held, .running].contains(job.state) else { return nil }
        return job
    }

    /// How far the writing has got (`wikiPlanBuildCounts`): the build's own count, else the directory's.
    public static func buildCounts(_ build: WikiPlanJob?, docs: (written: Int, total: Int)?) -> (done: Int, total: Int)? {
        if let progress = build?.progress { return (progress.docs.done, progress.docs.total) }
        return docs.map { ($0.written, $0.total) }
    }

    /// The document a build is writing now, as the plan numbers it (`wikiPlanWritingDoc`).
    public static func writingDoc(_ build: WikiPlanJob?, directory: WikiDocsDirectory?) -> String? {
        guard let current = build?.progress?.current else { return nil }
        for category in directory?.categories ?? [] {
            if let doc = (category.docs ?? []).first(where: { $0.slug == current.slug }) {
                return "\(doc.number ?? "") \(current.title.isEmpty ? doc.title : current.title)"
            }
        }
        return current.title.isEmpty ? current.slug : current.title
    }

    /// The job card's look (`WikiPlanJobLook`): grey queued, blue drafting and writing, amber held, red failed.
    public enum JobLook: String, Sendable {
        case queued, drafting, held, failed, writing
    }

    /// The job's card under the head (`WikiPlanJobCard`).
    public struct JobCard: Equatable, Sendable {
        public enum LinkTo: String, Sendable { case run, settings, runners }

        public struct Link: Equatable, Sendable {
            public let label: String
            public let to: LinkTo
            public let sessionId: String?
        }

        public struct Progress: Equatable, Sendable {
            public let done: Int
            public let total: Int
            /// The document being written now.
            public let now: String?
        }

        public let look: JobLook
        public let title: String
        public let text: String
        public let link: Link?
        public let progress: Progress?
    }

    /// How many of the gate's four checks a failed draft's errors fall under (`wikiPlanFailedChecks`).
    public static func failedChecks(_ errors: [WikiPlanGateError]) -> Int { Set(errors.map(\.check)).count }

    private static func attempts(_ job: WikiPlanJob) -> Int {
        job.attempt ?? (job.kind != .build ? job.report?.attempts?.count : nil) ?? job.attemptsMax ?? 3
    }

    private static func runLink(_ sessionId: String?) -> JobCard.Link? {
        sessionId.map { JobCard.Link(label: WikiPlanCopy.viewRun, to: .run, sessionId: $0) }
    }

    /// The job's card (`wikiPlanJobCard`): queued, drafting with its round, held with why, failed with how —
    /// and, on the version in force, its documents being written, or that the writing stopped short.
    public static func jobCard(_ job: WikiPlanJob?, now: Date, runnerOnline: Bool?, failed: WikiPlanJob?, inForce: Bool,
                               directory: WikiDocsDirectory?) -> JobCard? {
        let open: [WikiPlanJobState] = [.queued, .held, .running]
        let draft = job.flatMap { $0.kind != .build && open.contains($0.state) ? $0 : nil }
        let build = inForce ? job.flatMap { $0.kind == .build && open.contains($0.state) ? $0 : nil } : nil
        let going = draft ?? build
        if let going, let why = held(going, runnerOnline: runnerOnline) {
            let link = why == .runnerOffline ? JobCard.Link(label: WikiPlanCopy.viewRunners, to: .runners, sessionId: nil)
                : JobCard.Link(label: WikiPlanCopy.setUp, to: .settings, sessionId: nil)
            return JobCard(look: .held, title: WikiPlanCopy.held, text: heldText(going, why), link: link, progress: nil)
        }
        if let going, going.state == .queued {
            let started = going.waitingFor?.startedAt.map { " (started \(WikiHealthLogic.ago($0, now: now)))" } ?? ""
            return JobCard(look: .queued, title: WikiPlanCopy.queued, text: "\(WikiPlanCopy.queuedText)\(started)",
                           link: runLink(going.waitingFor?.sessionId), progress: nil)
        }
        if let draft, draft.state == .running {
            let who = draft.provider ?? WikiCopy.historyMaintenance
            let text = draft.startedAt.map { "\(who) · attempt \(draft.attempt ?? 1) of \(draft.attemptsMax ?? 3) · started \(WikiHealthLogic.ago($0, now: now))" }
                ?? "\(who) · waiting for its run to start"
            return JobCard(look: .drafting, title: WikiPlanCopy.drafting, text: text, link: runLink(draft.sessionId), progress: nil)
        }
        if let build, build.state == .running {
            var docs: (written: Int, total: Int)?
            if let directory, directory.plan != nil, let written = directory.docs { docs = (written.written, written.total) }
            let counts = buildCounts(build, docs: docs)
            let written = counts.map { "\(WikiArticleCopy.count($0.done)) of \(WikiArticleCopy.count($0.total)) written" } ?? WikiPlanCopy.writingSoon
            let text = build.startedAt.map { "\(written) · started \(WikiHealthLogic.ago($0, now: now))" } ?? written
            return JobCard(look: .writing, title: WikiPlanCopy.writing, text: text, link: runLink(build.sessionId),
                           progress: counts.map { JobCard.Progress(done: $0.done, total: $0.total, now: writingDoc(build, directory: directory)) })
        }
        if let failed {
            let errors = failed.errors ?? []
            if errors.isEmpty {
                return JobCard(look: .failed, title: WikiPlanCopy.jobFailed, text: failed.error ?? "Its run ended without a draft.",
                               link: runLink(failed.sessionId), progress: nil)
            }
            return JobCard(look: .failed, title: WikiPlanCopy.failed,
                           text: "\(failedChecks(errors)) of 4 checks failed · after \(plural(attempts(failed), "attempt", "attempts")) · "
                               + "\(plural(errors.count, "error", "errors")) listed below",
                           link: nil, progress: nil)
        }
        if inForce, let stopped = job, stopped.kind == .build, stopped.state == .failed {
            return JobCard(look: .failed, title: WikiPlanCopy.buildFailed, text: buildFailedText(stopped), link: runLink(stopped.sessionId), progress: nil)
        }
        return nil
    }

    /// Why the writing stopped short, and what writes the rest (`wikiPlanBuildFailedText`).
    public static func buildFailedText(_ job: WikiPlanJob) -> String {
        "\(job.error.map { "\($0) · " } ?? "")Wiki maintenance writes what’s left on its next run"
    }

    // MARK: the gate's report

    /// The report's rows in the order the page lists them (`WIKI_PLAN_GATE_ORDER`).
    public static let gateOrder: [WikiPlanGateCheck] = [.docCount, .protected, .references, .schema]

    /// A check's title (`WIKI_PLAN_GATE_TITLES`).
    public static func gateTitle(_ check: WikiPlanGateCheck) -> String {
        switch check {
        case .docCount: return "Documents"
        case .protected: return "Protected documents"
        case .references: return "References"
        case .schema, .unknown: return "Fields"
        }
    }

    public struct GateRow: Equatable, Sendable, Identifiable {
        public let check: WikiPlanGateCheck
        public let ok: Bool
        public let title: String
        public let text: String
        public var id: String { check.rawValue }
    }

    /// One reference the gate could not find: where, what kind, what, and why.
    public struct RefRow: Equatable, Sendable {
        public let where_: String
        public let kind: String
        public let ref: String
        public let why: String
    }

    public struct Gate: Equatable, Sendable {
        public let passed: Bool
        public let title: String
        public let line: String
        public let aside: String?
        public let rows: [GateRow]
        public let refKinds: [String]
        public let refs: [RefRow]
    }

    private static func firstMatch(_ pattern: String, in text: String) -> [String]? {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return nil }
        return (0..<match.numberOfRanges).map { i in Range(match.range(at: i), in: text).map { String(text[$0]) } ?? "" }
    }

    /// A kind's plural made one, as the web makes it: `categories` → `category`, `symbols` → `symbol`.
    private static func singular(_ many: String) -> String {
        many.replacingOccurrences(of: "ies$", with: "y", options: .regularExpression)
            .replacingOccurrences(of: "s$", with: "", options: .regularExpression)
    }

    /// The kind of reference a gate error's path points at, singular and plural.
    private static func refKind(_ path: String) -> (one: String, many: String) {
        let kinds: [(String, String, String)] = [
            (#"\.sources\.code\[\d+\]\.symbols\[\d+\]$"#, "Symbol", "symbols"),
            (#"\.sources\.code\[\d+\](\.path)?$"#, "Code path", "code paths"),
            (#"\.sources\.docs\[\d+\]\.section$"#, "Doc section", "doc sections"),
            (#"\.sources\.docs\[\d+\](\.path)?$"#, "Doc path", "doc paths"),
            (#"\.sources\.contracts\[\d+\]"#, "Contract", "contracts"),
            (#"\.sessions\.projects\[\d+\]$"#, "Project", "projects"),
            (#"\.sessions\.topics\[\d+\]$"#, "Topic", "topics"),
            (#"\.sessions\.anchorPaths\[\d+\]$"#, "Anchor path", "anchor paths"),
            (#"\.sessions\.entryKinds\[\d+\]$"#, "Entry kind", "entry kinds"),
            (#"\.scopeOut\[\d+\]"#, "Document", "documents"),
            (#"\.category$"#, "Category", "categories"),
        ]
        for (pattern, one, many) in kinds where firstMatch(pattern, in: path) != nil { return (one, many) }
        return ("Reference", "references")
    }

    /// The document and section a gate error's path names (`wikiPlanErrorWhere`): `plan.docs[12].sections[2]…` is `7.2 §3`.
    public static func errorWhere(_ shown: Shown, path: String) -> (doc: ShownDoc?, where_: String) {
        guard let doc = firstMatch(#"(?:^|\.)docs\[(\d+)\]"#, in: path).flatMap({ Int($0[1]) }), doc < shown.docs.count else { return (nil, "—") }
        let row = shown.docs[doc]
        if let section = firstMatch(#"\.sections\[(\d+)\]"#, in: path).flatMap({ Int($0[1]) }) { return (row, "\(row.number) §\(section + 1)") }
        return (row, row.number)
    }

    /// The value at a gate error's path in the shown plan: the reference it could not find.
    private static func valueAt(_ shown: Shown, path: String) -> String? {
        guard let d = firstMatch(#"(?:^|\.)docs\[(\d+)\]"#, in: path).flatMap({ Int($0[1]) }), d < shown.docs.count,
              let s = firstMatch(#"\.sections\[(\d+)\]"#, in: path).flatMap({ Int($0[1]) }), s < shown.docs[d].sections.count
        else { return nil }
        let section = shown.docs[d].sections[s]
        func at(_ pattern: String) -> [Int]? { firstMatch(pattern, in: path).map { $0.dropFirst().compactMap { Int($0) } } }
        if let m = at(#"\.sources\.code\[(\d+)\]\.symbols\[(\d+)\]$"#), m.count == 2 {
            guard m[0] < section.sources.code.count else { return nil }
            let code = section.sources.code[m[0]]
            return "\(m[1] < code.symbols.count ? code.symbols[m[1]] : "") in \(code.path)"
        }
        if let m = at(#"\.sources\.code\[(\d+)\]"#), let i = m.first { return i < section.sources.code.count ? section.sources.code[i].path : nil }
        if let m = at(#"\.sources\.docs\[(\d+)\]\.section$"#), let i = m.first {
            guard i < section.sources.docs.count else { return nil }
            return "\(section.sources.docs[i].path) § \(section.sources.docs[i].section ?? "")"
        }
        if let m = at(#"\.sources\.docs\[(\d+)\]"#), let i = m.first { return i < section.sources.docs.count ? section.sources.docs[i].path : nil }
        if let m = at(#"\.sources\.contracts\[(\d+)\]"#), let i = m.first { return i < section.sources.contracts.count ? section.sources.contracts[i] : nil }
        guard let sessions = section.sources.sessions else { return nil }
        func pick(_ list: [String], _ pattern: String) -> String?? {
            guard let i = at(pattern)?.first else { return .none }
            return .some(i < list.count ? list[i] : nil)
        }
        if let v = pick(sessions.projects.map(\.title), #"\.projects\[(\d+)\]$"#) { return v }
        if let v = pick(sessions.topics, #"\.topics\[(\d+)\]$"#) { return v }
        if let v = pick(sessions.anchorPaths, #"\.anchorPaths\[(\d+)\]$"#) { return v }
        if let v = pick(sessions.entryKinds, #"\.entryKinds\[(\d+)\]$"#) { return v }
        return nil
    }

    /// The sections a protected document of the base lost in the shown draft, and where each went (`wikiPlanLostSections`).
    public static func lostSections(_ shown: Shown, base: Shown?, slug: String) -> [(number: Int, title: String, movedTo: String?)] {
        guard let before = base?.docs.first(where: { $0.slug == slug }), let now = shown.docs.first(where: { $0.slug == slug }),
              before.protected else { return [] }
        let kept = Set(now.sections.map(\.title))
        return before.sections.enumerated().compactMap { i, section in
            if kept.contains(section.title) { return nil }
            let into = shown.docs.first { $0.slug != slug && $0.sections.contains { $0.title == section.title } }
            return (i + 1, section.title, into?.number)
        }
    }

    private static func sameDoc(_ a: ShownDoc, _ b: ShownDoc) -> Bool {
        a.title == b.title && a.question == b.question && a.audience == b.audience && a.scopeIn == b.scopeIn
            && a.scopeOut.map(\.text) == b.scopeOut.map(\.text) && a.scopeOut.map(\.docs) == b.scopeOut.map(\.docs) && a.length == b.length
            && a.sections.map { "\($0.title)|\($0.kind.rawValue)|\($0.covers)|\($0.length)" } == b.sections.map { "\($0.title)|\($0.kind.rawValue)|\($0.covers)|\($0.length)" }
    }

    /// `3.1, 4.2 and 7.1`.
    private static func joinAnd(_ items: [String]) -> String {
        guard items.count > 1 else { return items.first ?? "" }
        return "\(items.dropLast().joined(separator: ", ")) and \(items[items.count - 1])"
    }

    /// The protection row's sentence (`wikiPlanProtectedText`).
    public static func protectedText(_ shown: Shown, base: Shown?) -> String {
        let kept = (base?.docs ?? []).filter(\.protected)
        if kept.isEmpty { return "No document is protected" }
        var changed: [String] = []
        var unchanged: [String] = []
        for doc in kept {
            let now = shown.docs.first { $0.slug == doc.slug }
            let number = now?.number ?? doc.number
            let lost = lostSections(shown, base: base, slug: doc.slug)
            if now == nil { changed.append("\(number) is left out") }
            else if !lost.isEmpty {
                changed.append("\(number) lost " + lost.map { "§\($0.number) \($0.title)\($0.movedTo.map { " (moved to \($0))" } ?? "")" }.joined(separator: ", "))
            } else if let now, !sameDoc(doc, now) { changed.append("\(number) is changed") }
            else { unchanged.append(number) }
        }
        if changed.isEmpty { return "\(joinAnd(unchanged)) unchanged" }
        let rest = unchanged.isEmpty ? "" : " \(joinAnd(unchanged)) \(unchanged.count == 1 ? "is" : "are") unchanged."
        return "\(changed.joined(separator: "; ")).\(rest)"
    }

    /// The gate's report for what the page shows (`wikiPlanGate`).
    public static func gate(_ shown: Shown, base: Shown?, job: WikiPlanJob?) -> Gate {
        let sha = shown.repoCheck.map { WikiLogic.shortSha($0.sha) }
        let at = sha.map { " · references checked at \($0)" } ?? ""
        if shown.status != .failed {
            let gate = shown.gate
            let docs = gate?.docs ?? shown.docs.count
            let target = gate?.target ?? shown.target
            let skipped = gate?.checks?["protected"] == "skipped"
            let newFields = gate?.needsNewFields ?? []
            let attempt = job?.version == shown.version ? job?.attempt.map { "attempt \($0)" } : nil
            let rows = gateOrder.map { check -> GateRow in
                let text: String
                switch check {
                case .docCount: text = "\(plural(docs, "document", "documents")) — within \(target.min)–\(target.max)"
                case .protected: text = skipped ? "Not checked — the version is your own edit" : protectedText(shown, base: base)
                case .references:
                    if let check = shown.repoCheck { text = "All \(WikiArticleCopy.count(check.checked ?? 0)) found at \(sha ?? "")" }
                    else { text = "Every project and topic is this space’s" }
                default:
                    text = newFields.isEmpty ? "Every field is one the plan has"
                        : "\(plural(newFields.count, "field", "fields")) to add: \(newFields.map { "\($0.name) (\($0.at))" }.joined(separator: ", "))"
                }
                return GateRow(check: check, ok: true, title: gateTitle(check), text: text)
            }
            return Gate(passed: true, title: WikiPlanCopy.passed, line: "4 checks\(at)", aside: attempt, rows: rows, refKinds: [], refs: [])
        }

        var byCheck: [WikiPlanGateCheck: [WikiPlanGateError]] = [:]
        for error in shown.errors { byCheck[error.check, default: []].append(error) }
        var kinds: [(many: String, one: String, count: Int)] = []
        let refs = (byCheck[.references] ?? []).map { error -> RefRow in
            let kind = refKind(error.path)
            if let i = kinds.firstIndex(where: { $0.many == kind.many }) { kinds[i].count += 1 } else { kinds.append((kind.many, kind.one, 1)) }
            return RefRow(where_: errorWhere(shown, path: error.path).where_, kind: kind.one, ref: valueAt(shown, path: error.path) ?? error.path,
                          why: error.message)
        }
        let checked: Int? = job?.kind != .build ? job?.report?.repo?.checked : nil
        let rows = gateOrder.map { check -> GateRow in
            let errors = byCheck[check] ?? []
            let ok = errors.isEmpty
            let text: String
            switch check {
            case .docCount:
                text = "\(plural(shown.docs.count, "document", "documents")) — \(ok ? "within" : "the plan asks for") \(shown.target.min)–\(shown.target.max)"
            case .protected:
                text = ok || base != nil ? protectedText(shown, base: base) : errors.map(\.message).joined(separator: " ")
            case .references:
                if ok {
                    text = checked != nil && sha != nil ? "All \(WikiArticleCopy.count(checked ?? 0)) found at \(sha ?? "")" : "Every reference was found"
                } else {
                    text = "\(WikiArticleCopy.count(errors.count))\(checked.map { " of \(WikiArticleCopy.count($0))" } ?? "") not found"
                        + "\(sha.map { " at \($0)" } ?? "") — files, symbols and headings on origin/main; projects and topics in this space"
                }
            default:
                text = ok ? "Every field is one the plan has"
                    : "\(plural(errors.count, "field isn’t", "fields aren’t")) the plan’s: \(errors.prefix(3).map { "\($0.path) \($0.message)" }.joined(separator: "; "))"
            }
            return GateRow(check: check, ok: ok, title: gateTitle(check), text: text)
        }
        let order = kinds.enumerated().sorted { a, b in a.element.count != b.element.count ? a.element.count > b.element.count : a.offset < b.offset }
        return Gate(passed: false, title: WikiPlanCopy.failed, line: "\(failedChecks(shown.errors)) of 4 checks failed\(at)",
                    aside: job.map { "\(shown.model ?? $0.provider ?? WikiCopy.historyMaintenance) tried \(plural(attempts($0), "time", "times"))" },
                    rows: rows,
                    refKinds: order.map { "\(WikiArticleCopy.count($0.element.count)) \($0.element.count == 1 ? singular($0.element.many) : $0.element.many)" },
                    refs: refs)
    }

    // MARK: categories, documents and sections

    /// A category's line beside its title: `3 documents` (`wikiPlanCategoryLine`).
    public static func categoryLine(_ category: ShownCategory) -> String { plural(category.docs.count, "document", "documents") }

    /// A document's line: `5 sections · 1,200–2,000 chars` (`wikiPlanDocLine`).
    public static func docLine(_ doc: ShownDoc) -> String {
        "\(plural(doc.sections.count, "section", "sections")) · \(WikiPlanCopy.chars(doc.length))"
    }

    /// The failed draft's errors that fall in one document (`wikiPlanDocErrors`).
    public static func docErrors(_ shown: Shown, doc: ShownDoc) -> [WikiPlanGateError] {
        shown.errors.filter { firstMatch("(?:^|\\.)docs\\[\(doc.index)\\](?:\\.|$)", in: $0.path) != nil }
    }

    /// What a document's sections draw on, together (`wikiPlanDrawsOn`).
    public static func drawsOn(_ doc: ShownDoc) -> String {
        var docs: [String] = [], code: [String] = [], contracts: [String] = [], topics: [String] = [], projects: [String] = []
        func add(_ value: String, to list: inout [String]) { if !list.contains(value) { list.append(value) } }
        var sessions = false
        for section in doc.sections {
            section.sources.docs.forEach { add($0.path, to: &docs) }
            section.sources.code.forEach { add($0.path, to: &code) }
            section.sources.contracts.forEach { add($0, to: &contracts) }
            if let condition = section.sources.sessions {
                sessions = true
                condition.topics.forEach { add($0, to: &topics) }
                condition.projects.forEach { add($0.id ?? $0.title, to: &projects) }
            }
        }
        var parts: [String] = []
        if !docs.isEmpty { parts.append(plural(docs.count, "design doc", "design docs")) }
        if !code.isEmpty { parts.append(plural(code.count, "code path", "code paths")) }
        if !contracts.isEmpty { parts.append(plural(contracts.count, "contract", "contracts")) }
        if !topics.isEmpty { parts.append("topics \(topics.joined(separator: ", "))") } else if sessions { parts.append("sessions") }
        if !projects.isEmpty { parts.append(plural(projects.count, "project", "projects")) }
        return parts.isEmpty ? "Nothing yet" : parts.joined(separator: " · ")
    }

    /// A section's sources in one line (`wikiPlanSourcesSummary`).
    public static func sourcesSummary(_ section: ShownSection) -> String {
        var parts: [String] = []
        if !section.sources.docs.isEmpty { parts.append(plural(section.sources.docs.count, "doc section", "doc sections")) }
        if !section.sources.code.isEmpty { parts.append(plural(section.sources.code.count, "code file", "code files")) }
        if !section.sources.contracts.isEmpty { parts.append(plural(section.sources.contracts.count, "contract", "contracts")) }
        if section.sources.sessions != nil { parts.append("sessions") }
        if !parts.isEmpty { return parts.joined(separator: " · ") }
        return section.kind == .overview ? "Sums up the sections after it" : "No sources yet"
    }

    /// A section's second line on a phone (`wikiPlanSectionLine`): `Flow · ~800 chars · 3 doc sections · 3 code files`.
    public static func sectionLine(_ section: ShownSection) -> String {
        [WikiDocCopy.sectionKind(section.kind), WikiPlanCopy.sectionChars(section.length), sourcesSummary(section)].joined(separator: " · ")
    }

    /// A section page's line under its title (`wikiPlanSectionMeta`).
    public static func sectionMeta(_ shown: Shown, section: ShownSection) -> String {
        var parts = [WikiDocCopy.sectionKind(section.kind), WikiPlanCopy.sectionChars(section.length)]
        if section.sources.sessions != nil && section.sources.docs.isEmpty && section.sources.code.isEmpty && section.sources.contracts.isEmpty {
            parts.append("sessions")
        } else if let check = shown.repoCheck {
            parts.append("references checked at \(WikiLogic.shortSha(check.sha))")
        }
        return parts.joined(separator: " · ")
    }

    /// Whether a section's repository source was found (`wikiPlanSourceFound`); nil for a version no runner checked.
    public static func sourceFound(_ shown: Shown, doc: ShownDoc, section: Int, kind: String, at: Int) -> Bool? {
        let tail = "docs[\(doc.index)].sections[\(section)].sources.\(kind)[\(at)]"
        let plain = "docs[\(doc.index)].sections[\(section)].\(kind)[\(at)]"
        let missed = shown.errors.contains { $0.check == .references && ($0.path.contains(tail) || $0.path.contains(plain)) }
            || (shown.repoCheck?.missing ?? []).contains { miss in miss.at.map { $0.contains(tail) || $0.contains(plain) } ?? false }
        if missed { return false }
        return shown.repoCheck != nil ? true : nil
    }

    // MARK: the changes proposed

    public enum ChangeOp: String, Sendable {
        case addSection, removeSection, addDocument, changeDocument

        /// The card's chip (`WIKI_PLAN_OP_LABELS`).
        public var label: String {
            switch self {
            case .addSection: return "ADD SECTION"
            case .removeSection: return "REMOVE SECTION"
            case .addDocument: return "ADD DOCUMENT"
            case .changeDocument: return "CHANGE DOCUMENT"
            }
        }
    }

    /// One row of a change's section list: kept (for context), added or taken out (`WikiPlanChangeRow`).
    public struct ChangeRow: Equatable, Sendable {
        public enum Mark: String, Sendable { case same, add, remove }
        public let mark: Mark
        /// `5`, `+6`, `−3`.
        public let n: String
        public let title: String
        public let note: String
    }

    public typealias ProposedSection = WikiPlanProposal.Change.Doc.Section

    /// What a proposal does to the plan it was proposed against (`WikiPlanChange`).
    public struct Change: Equatable, Sendable {
        public let op: ChangeOp
        public let target: String
        public let title: String
        public let rows: [ChangeRow]
        public let renumber: String?
        /// The sections it adds: whose sources the card lists.
        public let added: [ProposedSection]
    }

    private static func sectionMatch(_ a: (key: String?, title: String), _ b: (key: String?, title: String)) -> Bool {
        if let ak = a.key, let bk = b.key { return ak == bk }
        return a.title == b.title
    }

    private static func renumbered(_ text: String?) -> String? {
        guard let text, let m = firstMatch(#"^§(\d+)–(\d+) become §(\d+)–(\d+)$"#, in: text), m[1] == m[2], m[3] == m[4] else { return text }
        return "§\(m[1]) becomes §\(m[3])"
    }

    /// What a proposal does to the version in force (`wikiPlanChange`).
    public static func change(_ proposal: WikiPlanProposal, base: Shown?) -> Change {
        let doc = proposal.change?.doc
        let slug = doc?.slug ?? ""
        let title = doc?.title ?? slug
        let sections = doc?.sections ?? []
        func note(_ section: ProposedSection) -> String {
            "\(WikiDocCopy.sectionKind(section.kind)) · \(WikiPlanCopy.sectionChars(section.length ?? 0))"
        }
        guard let before = base?.docs.first(where: { $0.slug == slug }) else {
            return Change(op: .addDocument, target: title, title: "Add document “\(title)”",
                          rows: sections.enumerated().map { ChangeRow(mark: .add, n: "+\($0.offset + 1)", title: $0.element.title, note: note($0.element)) },
                          renumber: nil, added: sections)
        }
        let target = "\(before.number) \(before.title)"
        let added = sections.enumerated().filter { item in !before.sections.contains { sectionMatch((item.element.key, item.element.title), ($0.key, $0.title)) } }
        let removed = before.sections.enumerated().filter { item in !sections.contains { sectionMatch(($0.key, $0.title), (item.element.key, item.element.title)) } }
        let count = before.sections.count
        if let first = added.first, removed.isEmpty {
            var rows: [ChangeRow] = []
            if first.offset > 0 {
                let prev = sections[first.offset - 1]
                rows.append(ChangeRow(mark: .same, n: "\(first.offset)", title: prev.title, note: WikiDocCopy.sectionKind(prev.kind)))
            }
            rows += added.map { ChangeRow(mark: .add, n: "+\($0.offset + 1)", title: $0.element.title, note: note($0.element)) }
            let from = first.offset + 1
            let renumber = from <= count ? "§\(from)–\(count) become §\(from + added.count)–\(count + added.count)" : nil
            return Change(op: .addSection, target: target,
                          title: added.count == 1 ? "Add §\(from) “\(first.element.title)”" : "Add \(added.count) sections",
                          rows: rows, renumber: renumbered(renumber), added: added.map(\.element))
        }
        if let first = removed.first, added.isEmpty {
            let rows = removed.map { ChangeRow(mark: .remove, n: "−\($0.offset + 1)", title: $0.element.title, note: WikiDocCopy.sectionKind($0.element.kind)) }
            let from = first.offset + 2
            let renumber = from <= count ? "§\(from)–\(count) become §\(from - removed.count)–\(count - removed.count)" : nil
            return Change(op: .removeSection, target: target,
                          title: removed.count == 1 ? "Remove §\(first.offset + 1) “\(first.element.title)”" : "Remove \(removed.count) sections",
                          rows: rows, renumber: renumbered(renumber), added: [])
        }
        return Change(op: .changeDocument, target: target, title: "Change “\(before.title)”",
                      rows: added.map { ChangeRow(mark: .add, n: "+\($0.offset + 1)", title: $0.element.title, note: note($0.element)) }
                          + removed.map { ChangeRow(mark: .remove, n: "−\($0.offset + 1)", title: $0.element.title, note: WikiDocCopy.sectionKind($0.element.kind)) },
                      renumber: nil, added: added.map(\.element))
    }

    /// A section's sources as a change's card lists them (`wikiPlanSourceLines`); a proposal names projects by id.
    public static func sourceLines(_ sources: WikiPlanSourcesInput?, projectTitle: (String) -> String? = { _ in nil }) -> [String] {
        guard let sources else { return [] }
        var lines: [String] = []
        for source in sources.docs ?? [] { lines.append("Design doc \(source.path)\(source.section.map { " § \($0)" } ?? "")") }
        for source in sources.code ?? [] {
            let symbols = source.symbols ?? []
            lines.append("Code \(source.path)\(symbols.isEmpty ? "" : " · \(symbols.joined(separator: " · "))")")
        }
        for source in sources.contracts ?? [] { lines.append("Contract \(source.path)") }
        if let sessions = sources.sessions {
            let projects = (sessions.projects ?? []).map { "「\(projectTitle($0) ?? $0)」" }
            let words = sessions.keywords ?? []
            lines.append("Sessions\(projects.isEmpty ? "" : " in \(projects.joined(separator: ", "))")\(sessions.since.map { " since \($0)" } ?? "")"
                + (words.isEmpty ? "" : " · \(words.joined(separator: " · "))"))
        }
        return lines
    }

    /// What pressing Accept will do, under the buttons (`wikiPlanAcceptNote`).
    public static func acceptNote(_ state: WikiPlanState, op: ChangeOp) -> String {
        let next = nextVersion(state)
        if let draft = state.draft {
            return "Draft v\(draft.version) is waiting for you — accepting adds this change to a new draft, v\(next), for you to confirm"
        }
        return "Accepting confirms plan v\(next) · Wiki maintenance writes the \(op == .addDocument || op == .changeDocument ? "document" : "section") next"
    }

    /// Whether Accept confirms too: only with no other unconfirmed draft (`wikiPlanAcceptConfirms`).
    public static func acceptConfirms(_ state: WikiPlanState) -> Bool { state.draft == nil }

    /// The gate's errors a refusal carries (422 `WIKI_PLAN_GATE`), or nil for a failure of any other kind.
    public static func gateErrors(_ error: Error) -> [WikiPlanGateError]? {
        guard APIClient.refusalCode(error) == "WIKI_PLAN_GATE", case APIError.http(_, let body) = error,
              let data = body?.data(using: .utf8) else { return nil }
        struct Refusal: Decodable { let errors: [WikiPlanGateError]? }
        return (try? JSONDecoder().decode(Refusal.self, from: data))?.errors ?? []
    }

    // MARK: Edit — in the draft's shape

    /// A section of the read, in the draft's shape: no id or position, projects by id (`wikiPlanSectionInput`).
    public static func sectionInput(_ section: WikiPlanSection) -> WikiPlanSectionInput {
        let sources = section.sources
        let sessions = sources?.sessions.map { condition in
            WikiPlanSessionConditionInput(projects: (condition.projects ?? []).map(\.id), since: condition.since, until: condition.until,
                                          keywords: condition.keywords ?? [], anchorPaths: condition.anchorPaths ?? [],
                                          entryKinds: (condition.entryKinds ?? []).map(\.rawValue), topics: condition.topics ?? [],
                                          evidence: condition.evidence ?? "")
        }
        return WikiPlanSectionInput(
            key: section.key, title: section.title, kind: section.kind, covers: section.covers ?? "", length: section.length ?? 0,
            sources: WikiPlanSourcesInput(docs: (sources?.docs ?? []).map { .init(path: $0.path, section: $0.section) },
                                          code: (sources?.code ?? []).map { .init(path: $0.path, symbols: $0.symbols ?? []) },
                                          contracts: (sources?.contracts ?? []).map { .init(path: $0.path) },
                                          sessions: sessions),
            extra: (section.extra ?? [:]).isEmpty ? nil : section.extra)
    }

    /// A document of the read, in the draft's shape (`wikiPlanDocInput`).
    public static func docInput(_ doc: WikiPlanDoc) -> WikiPlanDocInput {
        WikiPlanDocInput(category: doc.category, slug: doc.slug, title: doc.title, question: doc.question ?? "",
                         audience: doc.audience ?? [], scopeIn: doc.scopeIn ?? [],
                         scopeOut: (doc.scopeOut ?? []).map { .init(text: $0.text, docs: $0.docs ?? []) },
                         length: doc.length ?? WikiPlanRange(min: 0, max: 0), protected: doc.protected ?? false,
                         sections: (doc.sections ?? []).map(sectionInput), extra: (doc.extra ?? [:]).isEmpty ? nil : doc.extra)
    }

    /// What the Edit sheet holds of a document (`WikiPlanDocForm`).
    public struct DocForm: Equatable, Sendable {
        public struct Section: Equatable, Sendable, Identifiable {
            /// Nil for a section added in the sheet.
            public var key: String?
            public var title: String
            public var kind: WikiPlanSectionKind
            /// A row's identity while the sheet is open: its key, or a fresh one for an added row.
            public let id: String

            public init(key: String?, title: String, kind: WikiPlanSectionKind, id: String? = nil) {
                self.key = key
                self.title = title
                self.kind = kind
                self.id = id ?? key ?? UUID().uuidString
            }

            public static func == (a: Section, b: Section) -> Bool { a.key == b.key && a.title == b.title && a.kind == b.kind }
        }

        public var title: String
        public var question: String
        public var audience: [String]
        public var scopeIn: [String]
        public var length: WikiPlanRange
        public var protected: Bool
        /// In their new order.
        public var sections: [Section]

        public init(title: String, question: String, audience: [String], scopeIn: [String], length: WikiPlanRange, protected: Bool,
                    sections: [Section]) {
            self.title = title
            self.question = question
            self.audience = audience
            self.scopeIn = scopeIn
            self.length = length
            self.protected = protected
            self.sections = sections
        }
    }

    public static func docForm(_ doc: WikiPlanDoc) -> DocForm {
        DocForm(title: doc.title, question: doc.question ?? "", audience: doc.audience ?? [], scopeIn: doc.scopeIn ?? [],
                length: doc.length ?? WikiPlanRange(min: 0, max: 0), protected: doc.protected ?? false,
                sections: (doc.sections ?? []).map { DocForm.Section(key: $0.key, title: $0.title, kind: $0.kind) })
    }

    /// The document the sheet sends (`wikiPlanDocEdit`): the form's fields over the document as it was — every
    /// section it kept with its covers, length and sources, every section added covering what its title says.
    public static func docEdit(_ doc: WikiPlanDoc, form: DocForm) -> WikiPlanDocInput {
        var input = docInput(doc)
        let byKey = Dictionary(input.sections.compactMap { section in section.key.map { ($0, section) } }, uniquingKeysWith: { first, _ in first })
        let lines = { (items: [String]) in items.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty } }
        input.title = form.title.trimmingCharacters(in: .whitespacesAndNewlines)
        input.question = form.question.trimmingCharacters(in: .whitespacesAndNewlines)
        input.audience = lines(form.audience)
        input.scopeIn = lines(form.scopeIn)
        input.length = form.length
        input.protected = form.protected
        input.sections = form.sections.map { row in
            let title = row.title.trimmingCharacters(in: .whitespacesAndNewlines)
            if let key = row.key, var kept = byKey[key] {
                kept.title = title
                kept.kind = row.kind
                return kept
            }
            return WikiPlanSectionInput(title: title, kind: row.kind, covers: title, length: WikiPlanCopy.newSectionLength)
        }
        return input
    }

    /// One section, as its own page edits it (`wikiPlanSectionEditBody`).
    public static func sectionEditBody(version: Int, slug: String, section: WikiPlanSection,
                                       form: (title: String, kind: WikiPlanSectionKind, covers: String, length: Int)) -> WikiPlanEditRequest {
        var input = sectionInput(section)
        input.title = form.title.trimmingCharacters(in: .whitespacesAndNewlines)
        input.kind = form.kind
        input.covers = form.covers.trimmingCharacters(in: .whitespacesAndNewlines)
        input.length = form.length
        return WikiPlanEditRequest(baseVersion: version, docSlug: slug, sectionKey: section.key, section: input)
    }

    // MARK: the plan on the home

    /// What the home says of the plan, in the order the looks win (`WikiPlanLook`).
    public enum Look: String, CaseIterable, Sendable {
        case held, draftFailed, draftReady, changes, drafting, queued, writing, noPlan
    }

    /// The plan's look on the home (`wikiPlanLook`; owner's call 2026-09-29: the phone's second banner).
    public static func look(_ state: WikiPlanState, runnerOnline: Bool?) -> Look? {
        let open = openJob(state)
        let build = buildJob(state)
        if held(open ?? build, runnerOnline: runnerOnline) != nil { return .held }
        if failedJob(state) != nil { return .draftFailed }
        if state.draft != nil { return .draftReady }
        if !(state.proposals ?? []).isEmpty { return .changes }
        if open?.state == .running { return .drafting }
        if open?.state == .queued { return .queued }
        if build != nil && state.confirmed != nil { return .writing }
        if state.confirmed == nil && open == nil { return .noPlan }
        return nil
    }

    /// How many things of the plan wait on the owner: the Contents sheet's count beside Plan (`wikiPlanPending`).
    public static func pending(_ state: WikiPlanState, runnerOnline: Bool?) -> Int {
        (held(openJob(state) ?? buildJob(state), runnerOnline: runnerOnline) != nil ? 1 : 0) + (failedJob(state) != nil ? 1 : 0)
            + (state.draft != nil ? 1 : 0) + (state.proposals ?? []).count
    }

    /// A phone's banner (`WikiPlanBanner`): one line in the look's colour.
    public struct Banner: Equatable, Sendable {
        public enum Tone: String, Sendable { case amber, blue }
        public enum To: String, Sendable { case plan, settings }
        public let text: String
        public let tone: Tone
        public let to: To
    }

    /// The banner (`wikiPlanBanner`), pressed into the plan — or, held for want of a setting, into Maintenance.
    public static func banner(_ look: Look, state: WikiPlanState, now: Date, docs: (written: Int, total: Int)?, runnerOnline: Bool?) -> Banner {
        let job = openJob(state)
        switch look {
        case .held:
            let why = held(job ?? buildJob(state), runnerOnline: runnerOnline)
            let what = job != nil ? "Plan draft held" : "Writing documents held"
            return why == .runnerOffline ? Banner(text: "\(what) — the runner is offline", tone: .amber, to: .plan)
                : Banner(text: "\(what) — set up maintenance", tone: .amber, to: .settings)
        case .draftFailed: return Banner(text: "Plan draft didn’t pass the check", tone: .amber, to: .plan)
        case .draftReady: return Banner(text: "Plan draft ready to confirm", tone: .amber, to: .plan)
        case .changes:
            return Banner(text: "\(plural((state.proposals ?? []).count, "plan change", "plan changes")) to review", tone: .amber, to: .plan)
        case .drafting:
            return Banner(text: "Drafting the plan\(job?.startedAt.map { " · started \(WikiHealthLogic.ago($0, now: now))" } ?? "")", tone: .blue, to: .plan)
        case .queued: return Banner(text: "Plan draft queued", tone: .blue, to: .plan)
        case .writing:
            let counts = buildCounts(buildJob(state), docs: docs) ?? (0, 0)
            return Banner(text: "Writing documents · \(WikiArticleCopy.count(counts.done)) of \(WikiArticleCopy.count(counts.total))", tone: .blue, to: .plan)
        case .noPlan: return Banner(text: "No plan yet — draft one", tone: .blue, to: .plan)
        }
    }

    /// One of Activity's amber plan banners: the home's banner for one kind of thing that waits, and how
    /// many of `pending` it is.
    public struct WaitingBanner: Equatable, Sendable {
        public let banner: Banner
        public let look: Look
        public let count: Int
    }

    /// Activity's amber plan banners (`wikiPlanWaitingBanners`, design §12.3.3): the home's banner for each
    /// kind of thing of the plan that waits on the owner, in the order the looks win — held, the draft that
    /// failed, the draft to confirm, the changes — each with how many of `pending` it is, so a page's amber
    /// banners add up to the number on the bar's Activity badge. Empty when nothing waits.
    public static func waitingBanners(_ state: WikiPlanState, now: Date, docs: (written: Int, total: Int)?,
                                      runnerOnline: Bool?) -> [WaitingBanner] {
        let held = held(openJob(state) ?? buildJob(state), runnerOnline: runnerOnline) != nil ? 1 : 0
        let waiting: [(Look, Int)] = [
            (.held, held),
            (.draftFailed, failedJob(state) != nil ? 1 : 0),
            (.draftReady, state.draft != nil ? 1 : 0),
            (.changes, (state.proposals ?? []).count),
        ]
        return waiting.filter { $0.1 > 0 }.map { look, count in
            WaitingBanner(banner: banner(look, state: state, now: now, docs: docs, runnerOnline: runnerOnline),
                          look: look, count: count)
        }
    }
}
