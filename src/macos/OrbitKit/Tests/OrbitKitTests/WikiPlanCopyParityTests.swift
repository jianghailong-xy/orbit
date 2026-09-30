import Foundation
import XCTest
@testable import OrbitKit

/// The plan page, a plan document's and section's pages, the changes proposed, Redraft… and Edit, and the
/// home's plan banner say the web's words, read every state the web reads, and send an edit in the web's
/// shape (criterion 10 revised 2026-09-28 and criterion 11, mocks 22 and 26).
///
/// Three halves, each a failure — never an `XCTSkip` — when its counterpart goes missing:
/// - the `plan` cases of `src/shared/src/wiki-docs.fixture.json`, which the web's `lib/wikiPlan.test.ts`
///   reads too: every state of the plan — no plan, queued, drafting, held (never for the daily limit), a draft
///   waiting or failed, changes, the documents being written, held or stopped — with its banner, job card,
///   head, gate report and documents; the version menu; a document's and a section's pages; the changes
///   proposed and what Accept will do; an edit's request in the draft's shape;
/// - every `WikiPlanCopy` constant looked up as a declaration in the web source it mirrors;
/// - the orders of the plan page, a document's page, a section's page and a change's card.
final class WikiPlanCopyParityTests: XCTestCase {

    private static let lib = "src/web/src/lib/wikiPlan.ts"
    private static let writes = "src/web/src/lib/wikiWrites.ts"
    private static let fixturePath = "src/shared/src/wiki-docs.fixture.json"

    private struct Missing: Error, CustomStringConvertible {
        let file: String
        var description: String {
            "\(file) was not found above this test file. The plan pages are one half of a pair; if the other half "
                + "moved, move this check with it rather than deleting it."
        }
    }

    private func find(_ relative: String) throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            dir = dir.deletingLastPathComponent()
        }
        throw Missing(file: relative)
    }

    private func web(_ relative: String) throws -> String {
        try String(contentsOf: find(relative), encoding: .utf8)
            .replacingOccurrences(of: "['`]\\s*\\+\\s*['`]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    }

    private func assertSays(_ text: String, _ literal: String, in file: String, line: UInt = #line) {
        XCTAssertTrue(text.contains(literal), "\(file) no longer says \(literal)", line: line)
    }

    private func assertDeclares(_ text: String, _ name: String, _ value: String, in file: String, line: UInt = #line) {
        let single = "\(name) = '\(value.replacingOccurrences(of: "'", with: "\\'"))'"
        XCTAssertTrue(text.contains(single), "\(name) drifted: \(file) no longer declares it as \(value.debugDescription)", line: line)
    }

    private func slice(_ text: String, from start: String, to end: String) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`")
        let upper = try XCTUnwrap(text.range(of: end, range: lower.upperBound..<text.endIndex), "no `\(end)` after `\(start)`")
        return String(text[lower.lowerBound..<upper.upperBound])
    }

    // MARK: the fixture

    private struct Fixture: Decodable {
        struct Plan: Decodable {
            struct Versions: Decodable {
                let v1: WikiPlanVersion
                let v2: WikiPlanVersion
            }

            struct State: Decodable {
                struct Spec: Decodable {
                    let confirmed: String?
                    let draft: String?
                    let proposals: Bool
                    let job: String?
                    let runnerOnline: Bool?
                }

                struct Banner: Decodable {
                    let text: String
                    let tone: String
                    let to: String
                }

                struct Shown: Decodable {
                    let version: Int
                    let status: String
                    let label: String
                    let statusLabel: String
                }

                struct JobCard: Decodable {
                    struct Link: Decodable {
                        let label: String
                        let to: String
                        let sessionId: String?
                    }

                    struct Progress: Decodable {
                        let done: Int
                        let total: Int
                        let now: String?
                    }

                    let look, title, text: String
                    let link: Link?
                    let progress: Progress?
                }

                struct Gate: Decodable {
                    struct Row: Decodable {
                        let check: String
                        let ok: Bool
                        let title: String
                        let text: String
                    }

                    struct Ref: Decodable {
                        let `where`, kind, ref, why: String
                    }

                    let passed: Bool
                    let title, line: String
                    let aside: String?
                    let rows: [Row]
                    let refKinds: [String]
                    let refs: [Ref]
                }

                struct Category: Decodable {
                    struct Doc: Decodable {
                        let slug, number, title: String
                        let protected: Bool
                        let errors: Int
                        let errorLabel: String?
                        let line: String
                    }

                    let key: String
                    let number: Int
                    let title: String
                    let line: String
                    let docs: [Doc]
                }

                let spec: Spec
                let look: String?
                let pending: Int
                let banner: Banner?
                let open, build, failed: String?
                let nextVersion: Int
                let shown: Shown?
                let head: String?
                let meta: [String]?
                let hint: String?
                let jobCard: JobCard?
                let gate: Gate?
                let categories: [Category]
                let acceptConfirms: Bool
            }

            struct VersionRows: Decodable {
                struct Failed: Decodable {
                    let version: Int
                    let at: String
                }

                struct Row: Decodable {
                    let version: Int
                    let status: String
                    let note: String
                }

                let versions: [WikiPlanVersionSummary]
                let failed: Failed
                let rows: [Row]
            }

            struct DocPage: Decodable {
                struct ScopeOut: Decodable {
                    let text: String
                    let see: [String]
                }

                struct Section: Decodable {
                    struct Sources: Decodable {
                        struct Doc: Decodable {
                            let path: String
                            let section: String?
                            let found: Bool?
                        }

                        struct Code: Decodable {
                            let path: String
                            let symbols: [String]
                            let found: Bool?
                        }

                        struct Contract: Decodable {
                            let path: String
                            let found: Bool?
                        }

                        struct Sessions: Decodable {
                            let projects: [String?]
                            let time: String
                            let keywords, anchorPaths: [String]
                            let entryKinds, topics, evidence: String
                        }

                        let docs: [Doc]
                        let code: [Code]
                        let contracts: [Contract]
                        let sessions: Sessions?
                    }

                    let n: Int
                    let title, line, meta: String
                    let sources: Sources
                }

                struct Lost: Decodable {
                    let number: Int
                    let label: String
                    let why: String
                }

                let version: Int
                let slug, title, number: String
                let protected: Bool
                let head: [String]
                let length, protectedNote, drawsOn: String
                let scopeOut: [ScopeOut]
                let sections: [Section]
                let lost: [Lost]
            }

            struct Change: Decodable {
                struct Row: Decodable {
                    let mark, n, title, note: String
                }

                let proposal, op, opLabel, target, title: String
                let rows: [Row]
                let renumber: String?
                let sources: [String]
                let facts: [String]
                let more: String?
                let acceptNote, acceptNoteWithDraft: String
            }

            struct Edit: Decodable {
                struct Form: Decodable {
                    struct Section: Decodable {
                        let key: String?
                        let title: String
                        let kind: WikiPlanSectionKind
                    }

                    let title, question: String
                    let audience, scopeIn: [String]
                    let length: WikiPlanRange
                    let protected: Bool
                    let sections: [Section]
                }

                struct Body: Decodable {
                    let baseVersion: Int
                    let docSlug: String
                    let doc: WikiPlanDocInput?
                    let sectionKey: String?
                    let section: WikiPlanSectionInput?
                }

                struct SectionEdit: Decodable {
                    struct Form: Decodable {
                        let title: String
                        let kind: WikiPlanSectionKind
                        let covers: String
                        let length: Int
                    }

                    let index: Int
                    let form: Form
                    let body: Body
                }

                let stored: WikiPlanDoc
                let input: WikiPlanDocInput
                let form: Form
                let body: Body
                let section: SectionEdit
            }

            let versions: Versions
            let proposals: [WikiPlanProposal]
            let jobs: [String: WikiPlanJob]
            let states: [String: State]
            let versionRows: VersionRows
            let docPages: [DocPage]
            let changes: [Change]
            let edit: Edit
        }

        struct Docs: Decodable {
            struct Directory: Decodable {
                let read: WikiDocsDirectory
            }

            let directory: Directory
        }

        let timeZone: String
        let now: String
        let docs: Docs
        let plan: Plan
    }

    private func fixture() throws -> Fixture {
        try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: find(Self.fixturePath)))
    }

    /// The fixture's raw `plan` half, for the cases that are plain lists of words.
    private func raw() throws -> [String: Any] {
        let root = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: find(Self.fixturePath))) as? [String: Any])
        return try XCTUnwrap(root["plan"] as? [String: Any])
    }

    private func state(_ spec: Fixture.Plan.State.Spec, _ plan: Fixture.Plan) -> WikiPlanState {
        WikiPlanState(spaceId: "sp1", confirmed: spec.confirmed == "v1" ? plan.versions.v1 : nil,
                      draft: spec.draft == "v2" ? plan.versions.v2 : nil,
                      proposals: spec.proposals ? plan.proposals : [], job: spec.job.flatMap { plan.jobs[$0] })
    }

    private func now(_ shared: Fixture) throws -> Date {
        try XCTUnwrap(RelativeTime.parse(shared.now))
    }

    // MARK: the words

    func testTheWordsAreTheFixtures() throws {
        let words = try XCTUnwrap(try raw()["words"] as? [String: Any])
        let pairs: [(String, String)] = [
            (WikiPlanCopy.title, "title"), (WikiPlanCopy.redraft, "redraft"), (WikiPlanCopy.confirm, "confirm"), (WikiPlanCopy.draft, "draft"),
            (WikiPlanCopy.open, "open"), (WikiPlanCopy.edit, "edit"), (WikiPlanCopy.accept, "accept"), (WikiPlanCopy.reject, "reject"),
            (WikiPlanCopy.cancel, "cancel"), (WikiPlanCopy.viewRun, "viewRun"), (WikiPlanCopy.setUp, "setUp"),
            (WikiPlanCopy.viewRunners, "viewRunners"), (WikiPlanCopy.none, "none"), (WikiPlanCopy.emptyTitle, "emptyTitle"),
            (WikiPlanCopy.documents, "documents"), (WikiPlanCopy.inForce, "inForce"), (WikiPlanCopy.queued, "queued"),
            (WikiPlanCopy.drafting, "drafting"), (WikiPlanCopy.held, "held"), (WikiPlanCopy.failed, "failed"), (WikiPlanCopy.passed, "passed"),
            (WikiPlanCopy.writing, "writing"), (WikiPlanCopy.writingNow, "writingNow"), (WikiPlanCopy.jobFailed, "jobFailed"),
            (WikiPlanCopy.buildFailed, "buildFailed"), (WikiPlanCopy.question, "question"), (WikiPlanCopy.writtenFor, "writtenFor"),
            (WikiPlanCopy.covers, "covers"), (WikiPlanCopy.notCovered, "notCovered"), (WikiPlanCopy.length, "length"),
            (WikiPlanCopy.protected, "protected"), (WikiPlanCopy.drawsOn, "drawsOn"), (WikiPlanCopy.sections, "sections"),
            (WikiPlanCopy.sourceDocs, "sourceDocs"), (WikiPlanCopy.sourceCode, "sourceCode"), (WikiPlanCopy.sourceContracts, "sourceContracts"),
            (WikiPlanCopy.sourceSessions, "sourceSessions"), (WikiPlanCopy.sessionProjects, "sessionProjects"),
            (WikiPlanCopy.sessionTime, "sessionTime"), (WikiPlanCopy.sessionKeywords, "sessionKeywords"),
            (WikiPlanCopy.sessionAnchors, "sessionAnchors"), (WikiPlanCopy.sessionKinds, "sessionKinds"),
            (WikiPlanCopy.sessionTopics, "sessionTopics"), (WikiPlanCopy.sessionEvidence, "sessionEvidence"), (WikiPlanCopy.found, "found"),
            (WikiPlanCopy.notFound, "notFound"), (WikiPlanCopy.changes, "changes"), (WikiPlanCopy.proposedBy, "proposedBy"),
            (WikiPlanCopy.why, "why"), (WikiPlanCopy.change, "change"), (WikiPlanCopy.sources, "sources"), (WikiPlanCopy.from, "from"),
            (WikiPlanCopy.check, "check"), (WikiPlanCopy.changeRejected, "changeRejected"), (WikiPlanCopy.redraftAsked, "redraftAsked"),
            (WikiPlanCopy.redraftAlready, "redraftAlready"), (WikiPlanCopy.acceptRefused, "acceptRefused"),
            (WikiPlanCopy.redraftTitle, "redraftTitle"), (WikiPlanCopy.redraftGo, "redraftGo"),
            (WikiPlanCopy.redraftPlaceholder, "redraftPlaceholder"), (WikiPlanCopy.editTitleField, "editTitleField"),
            (WikiPlanCopy.editKind, "editKind"), (WikiPlanCopy.protectedSwitch, "protectedSwitch"), (WikiPlanCopy.addSection, "addSection"),
            (WikiPlanCopy.saveDraft, "saveDraft"), (WikiPlanCopy.protectedNote, "protectedNote"),
            (WikiPlanCopy.notProtectedNote, "notProtectedNote"),
        ]
        for (ours, key) in pairs { XCTAssertEqual(ours, words[key] as? String, key) }
        XCTAssertEqual(WikiPlanCopy.refsShownPhone, words["refsShownPhone"] as? Int)
        XCTAssertEqual(WikiPlanCopy.factsShown, words["factsShown"] as? Int)
        XCTAssertEqual(WikiPlanCopy.newSectionLength, words["newSectionLength"] as? Int)
        let statuses = try XCTUnwrap(words["statusLabels"] as? [String: String])
        for status in [WikiPlanLogic.ShownStatus.draft, .confirmed, .superseded, .failed] {
            XCTAssertEqual(status.label, statuses[status.rawValue], status.rawValue)
        }
        let ops = try XCTUnwrap(words["opLabels"] as? [String: String])
        for op in [WikiPlanLogic.ChangeOp.addSection, .removeSection, .addDocument, .changeDocument] {
            XCTAssertEqual(op.label, ops[op.rawValue], op.rawValue)
        }
        let titles = try XCTUnwrap(words["gateTitles"] as? [String: String])
        for check in WikiPlanGateCheck.allCases where check != .unknown {
            XCTAssertEqual(WikiPlanLogic.gateTitle(check), titles[check.rawValue], check.rawValue)
        }
        XCTAssertEqual(WikiPlanLogic.gateOrder.map(\.rawValue), words["gateOrder"] as? [String])
        let held = try XCTUnwrap(words["heldText"] as? [String: String])
        let buildHeld = try XCTUnwrap(words["buildHeldText"] as? [String: String])
        XCTAssertEqual(Set(held.keys), Set(WikiPlanLogic.Held.allCases.map(\.rawValue)), "the reasons a job is held are the web's three")
        for reason in WikiPlanLogic.Held.allCases {
            XCTAssertEqual(WikiPlanLogic.heldText(reason), held[reason.rawValue], reason.rawValue)
            XCTAssertEqual(WikiPlanLogic.buildHeldText(reason), buildHeld[reason.rawValue], reason.rawValue)
        }
        // Owner's call 2026-09-29: a job is never held for the daily limit.
        let said = (Array(held.values) + Array(buildHeld.values)).joined(separator: " ").lowercased()
        XCTAssertFalse(said.contains("daily") || said.contains("limit"))
    }

    func testTheCountsAreTheFixtures() throws {
        let counts = try XCTUnwrap(try raw()["counts"] as? [String: [[String: Any]]])
        func rows(_ key: String) throws -> [[String: Any]] { try XCTUnwrap(counts[key], key) }
        for row in try rows("chars") {
            let length = try XCTUnwrap(row["length"] as? [String: Int])
            XCTAssertEqual(WikiPlanCopy.chars(WikiPlanRange(min: length["min"]!, max: length["max"]!)), row["says"] as? String)
        }
        for row in try rows("sectionChars") { XCTAssertEqual(WikiPlanCopy.sectionChars(row["n"] as! Int), row["says"] as? String) }
        for row in try rows("errors") { XCTAssertEqual(WikiPlanCopy.errorCount(row["n"] as! Int), row["says"] as? String) }
        for row in try rows("changesCount") { XCTAssertEqual(WikiPlanCopy.changeCount(row["n"] as! Int), row["says"] as? String) }
        for row in try rows("time") {
            XCTAssertEqual(WikiPlanCopy.time(since: row["since"] as? String, until: row["until"] as? String), row["says"] as? String)
        }
        for row in try rows("redraftNotes") {
            let from = (row["from"] as? [String: Any]).map { (version: $0["version"] as! Int, inForce: $0["inForce"] as! Bool) }
            XCTAssertEqual(WikiPlanCopy.redraftNote(provider: row["provider"] as? String, from: from), row["says"] as? String)
        }
        for row in try rows("protectedKept") { XCTAssertEqual(WikiPlanCopy.protectedKept(row["numbers"] as! [String]), row["says"] as? String) }
        for row in try rows("emptyText") { XCTAssertEqual(WikiPlanCopy.emptyText(provider: row["provider"] as? String), row["says"] as? String) }
        for row in try rows("emptyNote") {
            XCTAssertEqual(WikiPlanCopy.emptyNote(where: row["where"] as? String, provider: row["provider"] as? String), row["says"] as? String)
        }
        for row in try rows("saveNote") { XCTAssertEqual(WikiPlanCopy.saveNote(row["n"] as! Int), row["says"] as? String) }
        for row in try rows("editTitle") { XCTAssertEqual(WikiPlanCopy.editTitle(row["number"] as! String), row["says"] as? String) }
        for row in try rows("confirmed") { XCTAssertEqual(WikiPlanCopy.confirmed(row["n"] as! Int), row["says"] as? String) }
        for row in try rows("changeAdded") { XCTAssertEqual(WikiPlanCopy.changeAdded(row["n"] as! Int), row["says"] as? String) }
        for row in try rows("draftSaved") { XCTAssertEqual(WikiPlanCopy.draftSaved(row["n"] as! Int), row["says"] as? String) }
        for row in try rows("andMore") { XCTAssertEqual(WikiPlanCopy.andMore(row["n"] as! Int), row["says"] as? String) }
        for row in try rows("failedHint") { XCTAssertEqual(WikiPlanCopy.failedHint(inForce: row["inForce"] as? Int), row["says"] as? String) }
    }

    /// Every constant, as the web source declares it.
    func testEveryWordIsDeclaredOnTheWeb() throws {
        let lib = try web(Self.lib)
        let constants: [(String, String)] = [
            ("WIKI_PLAN_TITLE", WikiPlanCopy.title), ("WIKI_PLAN_REDRAFT", WikiPlanCopy.redraft), ("WIKI_PLAN_CONFIRM", WikiPlanCopy.confirm),
            ("WIKI_PLAN_DRAFT", WikiPlanCopy.draft), ("WIKI_PLAN_OPEN", WikiPlanCopy.open), ("WIKI_PLAN_EDIT", WikiPlanCopy.edit),
            ("WIKI_PLAN_ACCEPT", WikiPlanCopy.accept), ("WIKI_PLAN_REJECT", WikiPlanCopy.reject), ("WIKI_PLAN_CANCEL", WikiPlanCopy.cancel),
            ("WIKI_PLAN_VIEW_RUN", WikiPlanCopy.viewRun), ("WIKI_PLAN_SET_UP", WikiPlanCopy.setUp),
            ("WIKI_PLAN_VIEW_RUNNERS", WikiPlanCopy.viewRunners), ("WIKI_PLAN_NONE", WikiPlanCopy.none),
            ("WIKI_PLAN_EMPTY_TITLE", WikiPlanCopy.emptyTitle), ("WIKI_PLAN_DOCUMENTS", WikiPlanCopy.documents),
            ("WIKI_PLAN_IN_FORCE", WikiPlanCopy.inForce), ("WIKI_PLAN_QUEUED", WikiPlanCopy.queued), ("WIKI_PLAN_DRAFTING", WikiPlanCopy.drafting),
            ("WIKI_PLAN_HELD", WikiPlanCopy.held), ("WIKI_PLAN_FAILED", WikiPlanCopy.failed), ("WIKI_PLAN_PASSED", WikiPlanCopy.passed),
            ("WIKI_PLAN_WRITING", WikiPlanCopy.writing), ("WIKI_PLAN_WRITING_NOW", WikiPlanCopy.writingNow),
            ("WIKI_PLAN_JOB_FAILED", WikiPlanCopy.jobFailed), ("WIKI_PLAN_BUILD_FAILED", WikiPlanCopy.buildFailed),
            ("WIKI_PLAN_QUEUED_TEXT", WikiPlanCopy.queuedText), ("WIKI_PLAN_WRITING_SOON", WikiPlanCopy.writingSoon),
            ("WIKI_PLAN_QUESTION", WikiPlanCopy.question), ("WIKI_PLAN_WRITTEN_FOR", WikiPlanCopy.writtenFor),
            ("WIKI_PLAN_COVERS", WikiPlanCopy.covers), ("WIKI_PLAN_NOT_COVERED", WikiPlanCopy.notCovered),
            ("WIKI_PLAN_LENGTH", WikiPlanCopy.length), ("WIKI_PLAN_PROTECTED", WikiPlanCopy.protected),
            ("WIKI_PLAN_DRAWS_ON", WikiPlanCopy.drawsOn), ("WIKI_PLAN_SECTIONS", WikiPlanCopy.sections),
            ("WIKI_PLAN_PROTECTED_NOTE", WikiPlanCopy.protectedNote), ("WIKI_PLAN_NOT_PROTECTED_NOTE", WikiPlanCopy.notProtectedNote),
            ("WIKI_PLAN_SOURCE_DOCS", WikiPlanCopy.sourceDocs), ("WIKI_PLAN_SOURCE_CODE", WikiPlanCopy.sourceCode),
            ("WIKI_PLAN_SOURCE_CONTRACTS", WikiPlanCopy.sourceContracts), ("WIKI_PLAN_SOURCE_SESSIONS_SHORT", WikiPlanCopy.sourceSessions),
            ("WIKI_PLAN_SESSION_PROJECTS", WikiPlanCopy.sessionProjects), ("WIKI_PLAN_SESSION_TIME", WikiPlanCopy.sessionTime),
            ("WIKI_PLAN_SESSION_KEYWORDS", WikiPlanCopy.sessionKeywords), ("WIKI_PLAN_SESSION_ANCHORS", WikiPlanCopy.sessionAnchors),
            ("WIKI_PLAN_SESSION_KINDS", WikiPlanCopy.sessionKinds), ("WIKI_PLAN_SESSION_TOPICS", WikiPlanCopy.sessionTopics),
            ("WIKI_PLAN_SESSION_EVIDENCE", WikiPlanCopy.sessionEvidence), ("WIKI_PLAN_FOUND", WikiPlanCopy.found),
            ("WIKI_PLAN_NOT_FOUND", WikiPlanCopy.notFound), ("WIKI_PLAN_CHANGES", WikiPlanCopy.changes),
            ("WIKI_PLAN_PROPOSED_BY", WikiPlanCopy.proposedBy), ("WIKI_PLAN_WHY", WikiPlanCopy.why), ("WIKI_PLAN_CHANGE", WikiPlanCopy.change),
            ("WIKI_PLAN_SOURCES", WikiPlanCopy.sources), ("WIKI_PLAN_FROM", WikiPlanCopy.from), ("WIKI_PLAN_CHECK", WikiPlanCopy.check),
            ("WIKI_PLAN_CHANGE_REJECTED", WikiPlanCopy.changeRejected), ("WIKI_PLAN_REDRAFT_ASKED", WikiPlanCopy.redraftAsked),
            ("WIKI_PLAN_REDRAFT_ALREADY", WikiPlanCopy.redraftAlready), ("WIKI_PLAN_ACCEPT_REFUSED", WikiPlanCopy.acceptRefused),
            ("WIKI_PLAN_REDRAFT_TITLE", WikiPlanCopy.redraftTitle), ("WIKI_PLAN_REDRAFT_GO", WikiPlanCopy.redraftGo),
            ("WIKI_PLAN_REDRAFT_PLACEHOLDER", WikiPlanCopy.redraftPlaceholder), ("WIKI_PLAN_EDIT_TITLE_FIELD", WikiPlanCopy.editTitleField),
            ("WIKI_PLAN_EDIT_KIND", WikiPlanCopy.editKind), ("WIKI_PLAN_PROTECTED_SWITCH", WikiPlanCopy.protectedSwitch),
            ("WIKI_PLAN_ADD_SECTION", WikiPlanCopy.addSection), ("WIKI_PLAN_SAVE_DRAFT", WikiPlanCopy.saveDraft),
        ]
        for (name, value) in constants { assertDeclares(lib, name, value, in: Self.lib) }
        assertSays(lib, "WIKI_PLAN_REFS_SHOWN_PHONE = \(WikiPlanCopy.refsShownPhone);", in: Self.lib)
        assertSays(lib, "WIKI_PLAN_FACTS_SHOWN = \(WikiPlanCopy.factsShown);", in: Self.lib)
        assertSays(lib, "WIKI_PLAN_NEW_SECTION_LENGTH = \(WikiPlanCopy.newSectionLength);", in: Self.lib)
        // The held reasons' two tables, key by key: exactly the server's two and the runner offline.
        for (table, text) in [("WIKI_PLAN_HELD_TEXT", WikiPlanLogic.heldText as (WikiPlanLogic.Held) -> String),
                              ("WIKI_PLAN_BUILD_HELD_TEXT", WikiPlanLogic.buildHeldText)] {
            let body = try slice(lib, from: "export const \(table)", to: "};")
            for reason in WikiPlanLogic.Held.allCases { assertSays(body, "\(reason.rawValue): '\(text(reason))'", in: Self.lib) }
        }
        // The sentences built around a value.
        assertSays(lib, "wikiPlanSaveNote = (next: number): string => `Saving makes draft v${next}; it goes through the plan check again.`", in: Self.lib)
        assertSays(lib, "wikiPlanConfirmed = (version: number): string => `Plan v${version} confirmed`", in: Self.lib)
        assertSays(lib, "wikiPlanChangeAdded = (version: number): string => `Change added to draft v${version}`", in: Self.lib)
        assertSays(lib, "`Draft v${state.draft.version} is waiting for you — accepting adds this change to a new draft, v${next}, for you to confirm`",
                   in: Self.lib)
        assertSays(lib, "`Accepting confirms plan v${next} · Wiki maintenance writes the ${", in: Self.lib)
        // Accept with no other draft waiting: accept, then confirm the draft it made — two requests, the second
        // only once the gate passed the first. The native model does the same (`WikiModel.acceptPlanProposal`).
        let writes = try web(Self.writes)
        assertSays(writes, "const decided = await decideWikiPlanProposal(proposalId, 'accept');", in: Self.writes)
        assertSays(writes, "return { draft: decided.draft, confirmed: await confirmWikiPlan(spaceId, decided.draft.version) };", in: Self.writes)
        assertSays(lib, "wikiPlanAcceptConfirms = (state: Pick<WikiPlanState, 'draft'>): boolean => state.draft === null;", in: Self.lib)
    }

    // MARK: the readings

    /// Every state: the home's look and banner, the page's version and head, its job, its gate, its documents.
    func testEveryStateIsTheFixtures() throws {
        let shared = try fixture()
        let plan = shared.plan
        let tz = try XCTUnwrap(TimeZone(identifier: shared.timeZone))
        let now = try self.now(shared)
        XCTAssertEqual(plan.states.count, 13)
        for (name, expected) in plan.states.sorted(by: { $0.key < $1.key }) {
            let state = self.state(expected.spec, plan)
            let online = expected.spec.runnerOnline
            let look = WikiPlanLogic.look(state, runnerOnline: online)
            XCTAssertEqual(look?.rawValue, expected.look, name)
            XCTAssertEqual(WikiPlanLogic.pending(state, runnerOnline: online), expected.pending, name)
            XCTAssertEqual(WikiPlanLogic.openJob(state)?.id, expected.open, name)
            XCTAssertEqual(WikiPlanLogic.buildJob(state)?.id, expected.build, name)
            XCTAssertEqual(WikiPlanLogic.failedJob(state)?.id, expected.failed, name)
            XCTAssertEqual(WikiPlanLogic.nextVersion(state), expected.nextVersion, name)
            XCTAssertEqual(WikiPlanLogic.acceptConfirms(state), expected.acceptConfirms, name)

            let docs: (written: Int, total: Int)? = state.confirmed != nil ? (3, 5) : nil
            let banner = look.map { WikiPlanLogic.banner($0, state: state, now: now, docs: docs, runnerOnline: online) }
            XCTAssertEqual(banner.map { "\($0.text) | \($0.tone.rawValue) | \($0.to.rawValue)" },
                           expected.banner.map { "\($0.text) | \($0.tone) | \($0.to)" }, name)

            let shown = WikiPlanLogic.defaultShown(state)
            XCTAssertEqual(shown.map { "v\($0.version) \($0.status.rawValue) \(WikiPlanCopy.versionLabel($0.version)) \($0.status.label)" },
                           expected.shown.map { "v\($0.version) \($0.status) \($0.label) \($0.statusLabel)" }, name)
            let open = WikiPlanLogic.openJob(state)
            let failed = WikiPlanLogic.failedJob(state)
            let inForce = shown?.status == .confirmed && state.confirmed?.version == shown?.version
            XCTAssertEqual(shown == nil ? open.map { WikiPlanLogic.jobHead($0, timeZone: tz) } : nil, expected.head, name)
            XCTAssertEqual(shown.map { WikiPlanLogic.meta($0, job: $0.status == .failed ? failed : (open ?? state.job), docs: inForce ? docs : nil, timeZone: tz) },
                           expected.meta, name)
            XCTAssertEqual(shown?.status == .failed ? WikiPlanCopy.failedHint(inForce: state.confirmed?.version) : nil, expected.hint, name)

            let card = WikiPlanLogic.jobCard(state.job, now: now, runnerOnline: online, failed: shown?.status == .failed ? failed : nil,
                                             inForce: inForce, directory: state.confirmed != nil ? shared.docs.directory.read : nil)
            XCTAssertEqual(card.map { "\($0.look.rawValue) | \($0.title) | \($0.text)" }, expected.jobCard.map { "\($0.look) | \($0.title) | \($0.text)" }, name)
            XCTAssertEqual(card?.link.map { "\($0.label) \($0.to.rawValue) \($0.sessionId ?? "-")" },
                           expected.jobCard?.link.map { "\($0.label) \($0.to) \($0.sessionId ?? "-")" }, name)
            XCTAssertEqual(card?.progress.map { "\($0.done)/\($0.total) \($0.now ?? "-")" },
                           expected.jobCard?.progress.map { "\($0.done)/\($0.total) \($0.now ?? "-")" }, name)

            if let shown, shown.status == .draft || shown.status == .failed {
                let gate = WikiPlanLogic.gate(shown, base: WikiPlanLogic.base(of: shown, in: state), job: shown.status == .failed ? failed : state.job)
                let want = try XCTUnwrap(expected.gate, name)
                XCTAssertEqual([gate.passed ? "passed" : "failed", gate.title, gate.line, gate.aside ?? "-"],
                               [want.passed ? "passed" : "failed", want.title, want.line, want.aside ?? "-"], name)
                XCTAssertEqual(gate.rows.map { "\($0.check.rawValue) \($0.ok) \($0.title): \($0.text)" },
                               want.rows.map { "\($0.check) \($0.ok) \($0.title): \($0.text)" }, name)
                XCTAssertEqual(gate.refKinds, want.refKinds, name)
                XCTAssertEqual(gate.refs.map { "\($0.where_) | \($0.kind) | \($0.ref) | \($0.why)" },
                               want.refs.map { "\($0.where) | \($0.kind) | \($0.ref) | \($0.why)" }, name)
            } else {
                XCTAssertNil(expected.gate, name)
            }

            let categories = shown?.categories ?? []
            XCTAssertEqual(categories.map { "\($0.key) \($0.number) \($0.title) \(WikiPlanLogic.categoryLine($0))" },
                           expected.categories.map { "\($0.key) \($0.number) \($0.title) \($0.line)" }, name)
            for (category, want) in zip(categories, expected.categories) {
                XCTAssertEqual(category.docs.map { doc -> String in
                    let errors = WikiPlanLogic.docErrors(shown!, doc: doc).count
                    return "\(doc.slug) \(doc.number) \(doc.title) \(doc.protected) \(errors) \(errors > 0 ? WikiPlanCopy.errorCount(errors) : "-") \(WikiPlanLogic.docLine(doc))"
                }, want.docs.map { "\($0.slug) \($0.number) \($0.title) \($0.protected) \($0.errors) \($0.errorLabel ?? "-") \($0.line)" }, name)
            }
        }
    }

    func testTheVersionMenuIsTheFixtures() throws {
        let shared = try fixture()
        let rows = shared.plan.versionRows
        let ours = WikiPlanLogic.versionRows(rows.versions, failed: (rows.failed.version, rows.failed.at),
                                             timeZone: try XCTUnwrap(TimeZone(identifier: shared.timeZone)))
        XCTAssertEqual(ours.map { "v\($0.version) \($0.status.rawValue) \($0.note)" }, rows.rows.map { "v\($0.version) \($0.status) \($0.note)" })
    }

    /// A document's and a section's pages of the failed draft and of the version in force.
    func testADocumentsAndASectionsPagesAreTheFixtures() throws {
        let shared = try fixture()
        let plan = shared.plan
        for expected in plan.docPages {
            let state = self.state(expected.version == 1 ? try XCTUnwrap(plan.states["inForce"]).spec : try XCTUnwrap(plan.states["draftFailed"]).spec, plan)
            let shown = try XCTUnwrap(WikiPlanLogic.defaultShown(state))
            let base = WikiPlanLogic.base(of: shown, in: state)
            let doc = try XCTUnwrap(shown.docs.first { $0.slug == expected.slug })
            let at = "v\(expected.version) \(expected.slug)"
            let errors = WikiPlanLogic.docErrors(shown, doc: doc).count
            XCTAssertEqual([doc.title, doc.number, "\(doc.protected)"], [expected.title, expected.number, "\(expected.protected)"], at)
            XCTAssertEqual(["\(WikiPlanCopy.versionLabel(shown.version)) · \(shown.status.label)"] + (errors > 0 ? [WikiPlanCopy.errorCount(errors)] : [])
                            + [WikiPlanLogic.docLine(doc)], expected.head, at)
            XCTAssertEqual(WikiPlanCopy.chars(doc.length), expected.length, at)
            XCTAssertEqual(doc.protected ? WikiPlanCopy.protectedNote : WikiPlanCopy.notProtectedNote, expected.protectedNote, at)
            XCTAssertEqual(WikiPlanLogic.drawsOn(doc), expected.drawsOn, at)
            let numbers = Dictionary(shown.docs.map { ($0.slug, $0.number) }, uniquingKeysWith: { first, _ in first })
            XCTAssertEqual(doc.scopeOut.map { "\($0.text) \($0.docs.map { "→ \(numbers[$0] ?? $0)" })" },
                           expected.scopeOut.map { "\($0.text) \($0.see)" }, at)
            XCTAssertEqual(doc.sections.count, expected.sections.count, at)
            for (index, (section, want)) in zip(doc.sections, expected.sections).enumerated() {
                XCTAssertEqual([section.title, WikiPlanLogic.sectionLine(section), WikiPlanLogic.sectionMeta(shown, section: section)],
                               [want.title, want.line, want.meta], "\(at) §\(want.n)")
                XCTAssertEqual(section.sources.docs.enumerated().map { k, source in
                    "\(source.path) \(source.section ?? "-") \(WikiPlanLogic.sourceFound(shown, doc: doc, section: index, kind: "docs", at: k).map { "\($0)" } ?? "-")"
                }, want.sources.docs.map { "\($0.path) \($0.section ?? "-") \($0.found.map { "\($0)" } ?? "-")" }, "\(at) §\(want.n)")
                XCTAssertEqual(section.sources.code.enumerated().map { k, source in
                    "\(source.path) \(source.symbols) \(WikiPlanLogic.sourceFound(shown, doc: doc, section: index, kind: "code", at: k).map { "\($0)" } ?? "-")"
                }, want.sources.code.map { "\($0.path) \($0.symbols) \($0.found.map { "\($0)" } ?? "-")" }, "\(at) §\(want.n)")
                XCTAssertEqual(section.sources.contracts.enumerated().map { k, path in
                    "\(path) \(WikiPlanLogic.sourceFound(shown, doc: doc, section: index, kind: "contracts", at: k).map { "\($0)" } ?? "-")"
                }, want.sources.contracts.map { "\($0.path) \($0.found.map { "\($0)" } ?? "-")" }, "\(at) §\(want.n)")
                let sessions = section.sources.sessions
                XCTAssertEqual(sessions.map { [ $0.projects.map(\.title).joined(separator: ","),
                                                WikiPlanCopy.time(since: $0.since, until: $0.until), $0.keywords.joined(separator: ","),
                                                $0.anchorPaths.joined(separator: ","), $0.entryKinds.joined(separator: " · "),
                                                $0.topics.joined(separator: " · "), $0.evidence ] },
                               want.sources.sessions.map { [ $0.projects.map { $0 ?? "" }.joined(separator: ","), $0.time,
                                                             $0.keywords.joined(separator: ","), $0.anchorPaths.joined(separator: ","),
                                                             $0.entryKinds, $0.topics, $0.evidence ] }, "\(at) §\(want.n)")
            }
            XCTAssertEqual(WikiPlanLogic.lostSections(shown, base: base, slug: doc.slug).map {
                "\($0.number) \(WikiPlanCopy.lostLabel(base: base?.version ?? 0, number: $0.number, title: $0.title)) | \(WikiPlanCopy.protectedMovePhone(movedTo: $0.movedTo, number: doc.number))"
            }, expected.lost.map { "\($0.number) \($0.label) | \($0.why)" }, at)
        }
    }

    func testTheChangesProposedAreTheFixtures() throws {
        let shared = try fixture()
        let plan = shared.plan
        let base = WikiPlanLogic.fromVersion(plan.versions.v1)
        let titles = ["pr9": "Codex 账号代管"]
        for expected in plan.changes {
            let proposal = try XCTUnwrap(plan.proposals.first { $0.id == expected.proposal })
            let change = WikiPlanLogic.change(proposal, base: base)
            XCTAssertEqual([change.op.rawValue, change.op.label, change.target, change.title, change.renumber ?? "-"],
                           [expected.op, expected.opLabel, expected.target, expected.title, expected.renumber ?? "-"], expected.proposal)
            XCTAssertEqual(change.rows.map { "\($0.mark.rawValue) \($0.n) \($0.title) \($0.note)" },
                           expected.rows.map { "\($0.mark) \($0.n) \($0.title) \($0.note)" }, expected.proposal)
            XCTAssertEqual(change.added.flatMap { WikiPlanLogic.sourceLines($0.sources, projectTitle: { titles[$0] }) }, expected.sources, expected.proposal)
            let facts = proposal.facts ?? []
            XCTAssertEqual(facts.prefix(WikiPlanCopy.factsShown).map(\.id), expected.facts, expected.proposal)
            XCTAssertEqual(facts.count > WikiPlanCopy.factsShown ? WikiPlanCopy.andMore(facts.count - WikiPlanCopy.factsShown) : nil, expected.more)
            XCTAssertEqual(WikiPlanLogic.acceptNote(state(try XCTUnwrap(plan.states["changes"]).spec, plan), op: change.op), expected.acceptNote)
            XCTAssertEqual(WikiPlanLogic.acceptNote(state(try XCTUnwrap(plan.states["draftReady"]).spec, plan), op: change.op), expected.acceptNoteWithDraft)
        }
    }

    /// An edit goes in the draft's shape: no ids or positions, a session condition's projects by id — the
    /// same request the web sends for the same form.
    func testAnEditIsSentInTheDraftsShape() throws {
        let edit = try fixture().plan.edit
        XCTAssertEqual(WikiPlanLogic.docInput(edit.stored), edit.input)
        let form = WikiPlanLogic.DocForm(title: edit.form.title, question: edit.form.question, audience: edit.form.audience,
                                         scopeIn: edit.form.scopeIn, length: edit.form.length, protected: edit.form.protected,
                                         sections: edit.form.sections.map { .init(key: $0.key, title: $0.title, kind: $0.kind) })
        let body = WikiPlanEditRequest(baseVersion: 2, docSlug: edit.stored.slug, doc: WikiPlanLogic.docEdit(edit.stored, form: form))
        XCTAssertEqual(body.baseVersion, edit.body.baseVersion)
        XCTAssertEqual(body.docSlug, edit.body.docSlug)
        XCTAssertEqual(body.doc, edit.body.doc)
        let section = try XCTUnwrap(edit.stored.sections?[edit.section.index])
        let sectionBody = WikiPlanLogic.sectionEditBody(version: 2, slug: edit.stored.slug, section: section,
                                                        form: (edit.section.form.title, edit.section.form.kind, edit.section.form.covers, edit.section.form.length))
        XCTAssertEqual([sectionBody.docSlug, sectionBody.sectionKey ?? "-"], [edit.section.body.docSlug, edit.section.body.sectionKey ?? "-"])
        XCTAssertEqual(sectionBody.section, edit.section.body.section)
        // What goes over the wire carries no read-back ids, and names projects by id.
        let wire = String(decoding: try JSONEncoder().encode(body), as: UTF8.self)
        XCTAssertFalse(wire.contains("\"id\"") || wire.contains("\"position\""), wire)
        XCTAssertTrue(wire.contains("\"projects\":[\"pr3\"]"), wire)
    }

    /// A refusal of the gate reads as its errors; any other failure as none.
    func testTheGatesRefusalIsReadForItsErrors() throws {
        let body = #"{"code":"WIKI_PLAN_GATE","message":"1 error","errors":[{"check":"references","path":"plan.docs[0]","message":"no such file"}]}"#
        XCTAssertEqual(WikiPlanLogic.gateErrors(APIError.http(status: 422, body: body))?.map(\.message), ["no such file"])
        XCTAssertNil(WikiPlanLogic.gateErrors(APIError.http(status: 409, body: #"{"code":"WIKI_PLAN_STALE","message":"stale"}"#)))
        XCTAssertNil(WikiPlanLogic.gateErrors(APIError.invalidResponse))
    }

    /// A failed job's draft the model wrote in a shape this build cannot read is dropped, never the plan's read with it.
    func testAMalformedFailedDraftDoesNotFailTheRead() throws {
        let json = #"{"spaceId":"sp1","confirmed":null,"draft":null,"proposals":[],"job":{"id":"j","kind":"revise","state":"failed","draft":{"categories":"nope","docs":7}}}"#
        let state = try JSONDecoder().decode(WikiPlanState.self, from: Data(json.utf8))
        XCTAssertEqual(state.job?.state, .failed)
        XCTAssertNil(state.job?.draft)
        XCTAssertNil(WikiPlanLogic.defaultShown(state))
    }

    // MARK: the orders

    func testTheOrdersAreTheFixtures() throws {
        let orders = try XCTUnwrap(try raw()["orders"] as? [String: [String]])
        XCTAssertEqual(WikiPlanLogic.PageSection.allCases.map(\.rawValue), orders["page"])
        XCTAssertEqual(WikiPlanLogic.DocSection.allCases.map(\.rawValue), orders["doc"])
        XCTAssertEqual(WikiPlanLogic.SectionSection.allCases.map(\.rawValue), orders["section"])
        XCTAssertEqual(WikiPlanLogic.ChangePart.allCases.map(\.rawValue), orders["change"])
        XCTAssertEqual(WikiPlanLogic.Look.allCases.map(\.rawValue), orders["looks"])
        let lib = try web(Self.lib)
        assertSays(lib, "WIKI_PLAN_PAGE_SECTIONS = ['crumb', 'title', 'meta', 'actions', 'hint', 'job', 'gate', 'changes', 'documents'] as const",
                   in: Self.lib)
        assertSays(lib, "WIKI_PLAN_DOC_SECTIONS = ['crumb', 'title', 'meta', 'fields', 'sections'] as const", in: Self.lib)
        assertSays(lib, "WIKI_PLAN_SECTION_SECTIONS = ['crumb', 'title', 'meta', 'covers', 'sources'] as const", in: Self.lib)
        assertSays(lib, "WIKI_PLAN_CHANGE_PARTS = ['head', 'title', 'why', 'change', 'sources', 'from', 'check', 'actions'] as const",
                   in: Self.lib)
    }
}
