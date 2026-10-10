import Foundation
import XCTest
@testable import OrbitKit

/// The project page says the same words on both clients. `ProjectPage.swift` is a port of six web
/// files and nothing in either build notices a label re-worded at one end only, so each word the
/// native page draws is looked up in the web source it came from.
///
/// A missing counterpart is a FAILURE, never an `XCTSkip`: a check that quietly opts out reports
/// green on exactly the day the thing it watches goes missing.
final class ProjectPageCopyParityTests: XCTestCase {

    private static let panorama = "src/web/src/components/ProjectPanoramaHeader.tsx"
    private static let acceptance = "src/web/src/components/ProjectAcceptanceCard.tsx"
    private static let coordinator = "src/web/src/components/ProjectCoordinatorCard.tsx"
    private static let progress = "src/web/src/components/ProjectProgressStatus.tsx"
    private static let integration = "src/web/src/components/ProjectIntegrationLine.tsx"
    private static let page = "src/web/src/pages/ProjectsPage.tsx"

    private enum ParityError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let file):
                return "\(file) was not found above this test file. OrbitKit's ProjectPage is one half "
                    + "of a pair; if the web half moved, move this check with it rather than deleting it."
            }
        }
    }

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
                    .replacingOccurrences(of: "['`]\\s*\\+\\s*['`]", with: "", options: .regularExpression)
                    .replacingOccurrences(of: "([=:])\\s*\\n\\s*(['`])", with: "$1 $2",
                                          options: .regularExpression)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw ParityError.missing(relative)
    }

    private func assertSays(_ web: String, _ literal: String, in file: String,
                            line: UInt = #line) {
        XCTAssertTrue(web.contains(literal), "\(file) no longer says \(literal)", line: line)
    }

    func testWorkOverviewWords() throws {
        let web = try source(Self.panorama)
        let integrating = ProjectPanoramaBuckets(running: 1, ready: 1, blocked: 1, awaitingVerification: 1,
                                                 done: 4, failed: 1, cancelled: 1, integrating: 1,
                                                 onIntegrationLine: 1, onUpstream: 1, doneNotIntegrated: 1,
                                                 waitingForLanding: 1)
        let cells = ProjectPage.overviewCells(integrating, taskCount: 9, line: .projectBranch)
            + ProjectPage.overviewCells(ProjectPanoramaBuckets(), taskCount: 0, line: nil)
            + ProjectPage.overviewCells(integrating, taskCount: 9, line: .projectBranch, started: false)
            + ProjectPage.overviewCells(ProjectPanoramaBuckets(), taskCount: 0, line: nil, started: false)
        for cell in cells {
            assertSays(web, "label: '\(cell.label)'", in: Self.panorama)
            if cell.key == "blocked", cell.footnote.hasPrefix("1 waiting") {
                assertSays(web, "`${buckets.waitingForLanding} waiting for a prerequisite to land`", in: Self.panorama)
            } else {
                assertSays(web, "'\(cell.footnote)'", in: Self.panorama)
            }
        }
        assertSays(web, "'waiting on dependencies'", in: Self.panorama)
        assertSays(web, "% complete`", in: Self.panorama)
        // Ready on a project nobody has started (mock board3 ②), in both shapes of the card.
        assertSays(web, "export const READY_UNTIL_STARTED = '\(ProjectPage.readyUntilStarted)';", in: Self.panorama)
        assertSays(web, "const readyFootnote = notStarted ? READY_UNTIL_STARTED : paused ? READY_WHILE_PAUSED", in: Self.panorama)
        assertSays(web, "export const READY_WHILE_PAUSED = '\(ProjectPage.readyWhilePaused)';", in: Self.panorama)
        assertSays(web, "ready: readyFootnote,", in: Self.panorama)
        assertSays(web, "lane.key === 'ready' ? { ...lane, footnote: readyFootnote } : lane)", in: Self.panorama)
    }

    /// An open project nobody has started is "Not started" (mock board3 ②), and grey — not the
    /// tag of one that runs.
    func testAProjectNobodyStartedIsTaggedNotStarted() throws {
        let web = try source(Self.page)
        assertSays(web, "{p.status === 'OPEN' && started === false ? (", in: Self.page)
        assertSays(web, "<Badge>{NOT_STARTED}</Badge>", in: Self.page)
        let words = try source("src/web/src/lib/projectStart.ts")
        assertSays(words, "export const NOT_STARTED = '\(StartProject.notStarted)';", in: "src/web/src/lib/projectStart.ts")
    }

    func testCriteriaWords() throws {
        let web = try source(Self.acceptance)
        assertSays(web, "const MET = '\(ProjectPage.metByItsWork)';", in: Self.acceptance)
        assertSays(web, "const NOT_MET = '\(ProjectPage.notMetByItsWork)';", in: Self.acceptance)
        let clauses = ["NO_WORK_SERVES_IT", "SERVING_WORK_UNSETTLED", "DECLARATION_STALE"]
        for clause in clauses {
            let c = ProjectCriterion(id: "c", ordinal: 1, text: "t", satisfied: false,
                                     unmet: [ProjectCriterionUnmet(clause: clause)])
            let sentence = try XCTUnwrap(ProjectPage.criterionWork(c, integrationRef: nil)?.reasons.first?.sentence)
            assertSays(web, "\(clause): '\(sentence)'", in: Self.acceptance)
        }
        let actions = ["RUN_ACCEPTANCE_COMMAND", "OBTAIN_INDEPENDENT_VERIFICATION_PASS",
                       "RECORD_VERIFICATION_VERDICT", "SUBMIT_EVIDENCE_AND_AWAIT_INDEPENDENT_DECISION"]
        for action in actions {
            let c = ProjectCriterion(id: "c", ordinal: 1, text: "t", satisfied: false, unmet: [
                ProjectCriterionUnmet(clause: "X", heldUpBy: [.init(taskId: "t", title: "t", requiredAction: action)]),
            ])
            let words = try XCTUnwrap(ProjectPage.criterionWork(c, integrationRef: nil)?.reasons.first?.heldUpBy.first?.action)
            assertSays(web, "\(action): '\(words)'", in: Self.acceptance)
        }
        for (landing, words) in [("LANDED", "on main"), ("UNKNOWN", "no merge receipt either way")] {
            let c = ProjectCriterion(id: "c", ordinal: 1, text: "t", satisfied: true, landing: landing)
            XCTAssertEqual(ProjectPage.criterionWork(c, integrationRef: nil)?.landing, words)
            assertSays(web, "\(landing): '\(words)'", in: Self.acceptance)
        }
        assertSays(web, "tail: 'not on main yet'", in: Self.acceptance)
        assertSays(web, "'the project branch'", in: Self.acceptance)
    }

    func testCoordinatorWords() throws {
        let web = try source(Self.coordinator)
        for label in ["Needs you", "Working", "Idle", "Completed", "Not started", "Deleted", "Cannot be opened"] {
            assertSays(web, "label: '\(label)'", in: Self.coordinator)
        }
        assertSays(web, "coordinator of this project`", in: Self.coordinator)
        for phrase in ["'last active just now'", "`last active ${Math.floor(diff / min)}m ago`",
                       "`last active ${Math.floor(diff / hour)}h ago`", "`last active ${Math.floor(diff / day)}d ago`"] {
            assertSays(web, phrase, in: Self.coordinator)
        }
    }

    func testOpenItemsAndCoordinatorProgressWords() throws {
        let web = try source(Self.progress)
        assertSays(web, "OPEN_ITEMS_HEADING = '\(ProjectPage.openItemsHeading)'", in: Self.progress)
        assertSays(web, "NEEDS_YOU_GROUP = '\(ProjectPage.needsYouGroup)'", in: Self.progress)
        assertSays(web, "WITH_COORDINATOR_GROUP = '\(ProjectPage.withCoordinatorGroup)'", in: Self.progress)
        for (action, key) in [(ProjectOpenItemAction.review, "REVIEW"), (.answer, "ANSWER"), (.resume, "RESUME"),
                              (.openCoordinator, "OPEN_COORDINATOR"), (.openTaskSession, "OPEN_TASK_SESSION")] {
            assertSays(web, "\(key): '\(ProjectPage.actionLabel(action)!)'", in: Self.progress)
        }
        // The coordinator's request to start leads Needs you, and is counted there; the owner's own
        // Start… is counted in nothing.
        assertSays(web, "...(startRequest ? [startRequest] : []),", in: Self.progress)
        assertSays(web, "{ownStart ? <OwnStartRowView onStart={ownStart} /> : null}", in: Self.progress)
        for phrase in ["`waiting ${waited}`", "`${waited} · goes to you in ${formatSpan(left)}`",
                       "`${waited} · due to come to you`", "`escalated ${ago(row.escalatedAt, now)}`",
                       "OWNER: 'You', COORDINATOR: 'Coordinator'",
                       "DELIVERED: 'delivered'", "QUEUED: 'queued'", "RETURNED: 'returned'", "NONE: 'none yet'",
                       "`last ${ago(wakeups.at, now)}`", "`${fuse.selfStartedToday} · no limit`",
                       "`${fuse.selfStartedToday} of ${fuse.limit}`", "' · paused'"] {
            assertSays(web, phrase, in: Self.progress)
        }
    }

    /// The closing row in Open items: the coordinator's request leads Needs you beside the start
    /// request — Ready to close over the card's question, who asked and how many gaps it could not
    /// prove, and Review — and with nobody asking, the owner's own Record as done…, quiet.
    func testTheClosingRowsInOpenItemsAreTheWebs() throws {
        let web = try source(Self.progress)
        assertSays(web, "...(doneRequest ? [doneRequest] : []),", in: Self.progress)
        assertSays(web, "row.kind !== 'DONE_REQUEST'", in: Self.progress)
        assertSays(web, "{ownDone ? <OwnDoneRowView onRecord={ownDone} /> : null}", in: Self.progress)
        assertSays(web, "<div className=\"project-open-item-state is-ready-to-close\">{PROJECT_DONE_COPY.readyToClose}</div>",
                   in: Self.progress)
        assertSays(web, "title={PROJECT_DONE_COPY.heading}>{PROJECT_DONE_COPY.heading}</div>", in: Self.progress)
        assertSays(web, "`${PROJECT_DONE_COPY.openItemsDoneRequest} · ${row.doneRequest.gaps.length} ${PROJECT_DONE_COPY.gapsItCouldntProve}`",
                   in: Self.progress)
        assertSays(web, "{PROJECT_DONE_COPY.recordAsDoneRow}", in: Self.progress)
        assertSays(web, "<div className=\"project-open-item-line\">{PROJECT_DONE_COPY.notAskedYet}</div>", in: Self.progress)
        let row = ProjectOpenItemRow(itemId: "d", kind: .unknown, title: ProjectDone.heading, waitingSince: "",
                                     doneRequest: DoneRequest(criteriaDigest: "c", judgment: "j", gaps: [
                                         AcceptedGap(criterionKey: "a"), AcceptedGap(criterionKey: "b"),
                                     ]))
        XCTAssertEqual(ProjectDone.requestRowDetail(row), "The coordinator asked · 2 gaps it couldn’t prove")
        XCTAssertEqual(ProjectPage.needsYouRows(ProjectOpenItemsView(needsYou: [row])), [],
                       "the request is drawn once, in its own row, as the browser filters it")
        // The owner's own Record as done… is a grey hint the Open items count leaves out (the browser
        // since 1f85c0afe): only the request counts as needing the owner.
        assertSays(web, "is-owner is-own-start is-hint project-open-item-done-own", in: Self.progress)
        assertSays(web, "`${needsYou.length} need you · ${withCoordinator.length} with the coordinator · oldest first`",
                   in: Self.progress)
        XCTAssertEqual(ProjectPage.openItemsSummary(status: .open, started: true, items: ProjectOpenItemsView())?.needsYou, 0,
                       "nobody asked: the owner's own row needs nobody")
        XCTAssertEqual(ProjectPage.openItemsSummary(status: .open, started: true,
                                                    items: ProjectOpenItemsView(doneRequest: row))?.needsYou, 1,
                       "the coordinator's request is the one thing that needs the owner")
    }

    /// The page's header: Ready to close beside the status while the coordinator asks, and once the
    /// project is done, who recorded it — in `doneProvenance`'s words.
    func testTheHeaderSaysReadyToCloseAndWhoRecordedItDone() throws {
        let web = try source(Self.page)
        assertSays(web, "<Badge tone=\"gold\">{PROJECT_DONE_COPY.readyToClose}</Badge>", in: Self.page)
        // …only while the coordinator's request stands, not for every OPEN project (the browser since
        // 1f85c0afe; this client's `ProjectDone.readyToClose`).
        assertSays(web, "{p.status === 'OPEN' && doneRequest ? (", in: Self.page)
        assertSays(web, "const doneRequest = useOpenDoneRequest(id);", in: Self.page)
        assertSays(web, "<span className=\"project-done-provenance\">{doneProvenance(p)}</span>", in: Self.page)
        assertSays(web, "DONE: 'Completed',", in: Self.page)
        XCTAssertEqual(ProjectDone.readyToClose, "Ready to close")
        XCTAssertEqual(ProjectDone.provenance(doneBy: .owner, acceptedGaps: 2), "recorded by you · 2 gaps accepted")
        XCTAssertEqual(ProjectDone.provenance(doneBy: .derived, acceptedGaps: 0), "recorded by Orbit")
        // Record as done opens the owner's door on a current server, the old status door on an older.
        assertSays(web, "const hasDoneGate = project.derivedDone != null && 'counts' in project.derivedDone;", in: Self.page)
    }

    func testIntegrationLineWords() throws {
        let web = try source(Self.integration)
        // How far ahead of the project's main branch, and when it last synced with it: `{main}` is
        // that branch by name, main on a project on main.
        for phrase in ["PASSING: { text: '✓ passing'", "FAILING: { text: '✕ failing'", "UNKNOWN: { text: 'not checked'",
                       "ahead of {main}", "synced with {main}", "const main = mainBranchName(view.upstreamRef);",
                       "at last measurement", "Last landing check", "Running jobs"] {
            assertSays(web, phrase, in: Self.integration)
        }
    }

    func testTaskBandAndTagWords() throws {
        let web = try source(Self.page)
        for heading in ["Running", "Pending landing", "Ready · can start now",
                        "Awaiting verification · subject work must not be started",
                        "Failed · coordinated continuation", "Waiting · for a prerequisite to land",
                        "Landed", "Done / Cancelled"] {
            assertSays(web, "heading: '\(heading)'", in: Self.page)
        }
        // The level bands are one ternary on the web: level 0, then every other level.
        assertSays(web, "'Blocked · no executable work at this level' : `Blocked · topology level ${level}`",
                   in: Self.page)
        for phrase in ["'Ready · automatic dispatch'", "'Ready · can start now'", "'Verification failed'",
                       "'Missing verifier'", "'Awaiting verification · verifier running'",
                       "'Awaiting verification · verifier blocked'", "'Awaiting verification · applying result'",
                       "'Awaiting verification'", "text: 'Failed'", "text: 'Blocked'",
                       "'Queued for integration'", "`Conflict · ${who}`", "`Checks failed · ${who}`",
                       "`Integration error · ${who}`", "'Awaiting your approval'",
                       "'Integrating · checking'",
                       "`On ${branches.ref ?? 'the project branch'}`", "`On ${branches.upstreamRef ?? 'main'}`",
                       "`Waits for ${n} task${n === 1 ? '' : 's'} to land`"] {
            assertSays(web, phrase, in: Self.page)
        }
    }
}
