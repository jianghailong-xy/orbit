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
        for cell in cells {
            assertSays(web, "label: '\(cell.label)'", in: Self.panorama)
            assertSays(web, "'\(cell.footnote)'", in: Self.panorama)
        }
        assertSays(web, "'waiting on dependencies'", in: Self.panorama)
        assertSays(web, "% complete`", in: Self.panorama)
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
        let hint = ProjectPage.openItemsHint(needsYou: 23, withCoordinator: 29)
            .replacingOccurrences(of: "23", with: "${needsYou.length}")
            .replacingOccurrences(of: "29", with: "${withCoordinator.length}")
        assertSays(web, "`\(hint)`", in: Self.progress)
        for phrase in ["`waiting ${waited}`", "`${waited} · goes to you in ${formatSpan(left)}`",
                       "`${waited} · due to come to you`", "`escalated ${ago(row.escalatedAt, now)}`",
                       "OWNER: 'You', COORDINATOR: 'Coordinator'",
                       "DELIVERED: 'delivered'", "QUEUED: 'queued'", "RETURNED: 'returned'", "NONE: 'none yet'",
                       "`last ${ago(wakeups.at, now)}`", "`${fuse.selfStartedToday} · no limit`",
                       "`${fuse.selfStartedToday} of ${fuse.limit}`", "' · paused'"] {
            assertSays(web, phrase, in: Self.progress)
        }
    }

    func testIntegrationLineWords() throws {
        let web = try source(Self.integration)
        for phrase in ["PASSING: { text: '✓ passing'", "FAILING: { text: '✕ failing'", "UNKNOWN: { text: 'not run yet'",
                       "ahead of main", "synced with main", "' on the branch tip'", "Merge check"] {
            assertSays(web, phrase, in: Self.integration)
        }
    }

    func testTaskBandAndTagWords() throws {
        let web = try source(Self.page)
        for heading in ["Running", "Integrating · checks run on the combined tree", "Ready · can start now",
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
                       "`Integrating · checks ${formatSpan(integration.checksRunningForMs)}`",
                       "`On ${branches.ref ?? 'the project branch'}`", "`On ${branches.upstreamRef ?? 'main'}`",
                       "`Waits for ${n} task${n === 1 ? '' : 's'} to land`"] {
            assertSays(web, phrase, in: Self.page)
        }
    }
}
