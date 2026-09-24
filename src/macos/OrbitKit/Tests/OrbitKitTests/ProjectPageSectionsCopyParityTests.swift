import Foundation
import XCTest
@testable import OrbitKit

/// The project page's plan sections say the web's words. Each sentence the native page draws from
/// `ProjectPageSections.swift` and `ProjectGraphLayout.swift` is looked up in the web source it was
/// ported from, with runs of whitespace read as one space (JSX wraps its text across lines).
///
/// A missing counterpart is a FAILURE, never an `XCTSkip`.
final class ProjectPageSectionsCopyParityTests: XCTestCase {

    private static let panorama = "src/web/src/components/ProjectPanoramaHeader.tsx"
    private static let coordinator = "src/web/src/components/ProjectCoordinatorCard.tsx"
    private static let blockers = "src/web/src/components/ProjectBlockers.tsx"
    private static let queue = "src/web/src/components/ProjectReadyToRun.tsx"
    private static let acceptance = "src/web/src/components/ProjectAcceptanceCard.tsx"
    private static let graph = "src/web/src/components/ProjectDependencyGraph.tsx"
    private static let graphLib = "src/web/src/lib/projectDependencyGraph.ts"
    private static let page = "src/web/src/pages/ProjectsPage.tsx"

    private struct Missing: Error, CustomStringConvertible {
        let file: String
        var description: String {
            "\(file) was not found above this test file. The native page is one half of a pair; if the web "
                + "half moved, move this check with it rather than deleting it."
        }
    }

    /// The source with string concatenations joined, JSX's escaped apostrophe read as one, and every
    /// run of whitespace as a single space.
    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
                    .replacingOccurrences(of: "['`]\\s*\\+\\s*['`]", with: "", options: .regularExpression)
                    .replacingOccurrences(of: "&apos;", with: "'")
                    .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw Missing(file: relative)
    }

    private func assertSays(_ web: String, _ literal: String, in file: String, line: UInt = #line) {
        XCTAssertTrue(web.contains(literal), "\(file) no longer says \(literal)", line: line)
    }

    func testTheOverviewBannersWords() throws {
        let web = try source(Self.panorama)
        assertSays(web, ProjectPage.stalledTitle, in: Self.panorama)
        let stalled = ProjectPage.stalledSentence(ready: 7)
        assertSays(web, "ready, but nothing is running.", in: Self.panorama)
        assertSays(web, String(stalled.drop { $0 != "C" }), in: Self.panorama)
        assertSays(web, ProjectPage.wrapUpTitle, in: Self.panorama)
        assertSays(web, "settled. The project stays open until its outcome is confirmed.", in: Self.panorama)
    }

    func testTheCoordinatorCardsWords() throws {
        let web = try source(Self.coordinator)
        assertSays(web, "'Open coordinator' : 'Reply to coordinator'", in: Self.coordinator)
        assertSays(web, "'Open work' : 'Manual dispatch'", in: Self.coordinator)
        for text in ["Open tasks are coordinated from this conversation.", "No open tasks remain.",
                     "A completed conversation is told nothing new, and this project still points at it.",
                     "A completed conversation is told nothing new. No open tasks remain."] {
            assertSays(web, "'\(text)'", in: Self.coordinator)
        }
        assertSays(web, " coordinated from this conversation.`", in: Self.coordinator)
        assertSays(web, "A completed conversation is told nothing new — and ${openTaskCount} open task${",
                   in: Self.coordinator)
        assertSays(web, "stays completed and readable, and stops being the one this project is coordinated from.",
                   in: Self.coordinator)
        assertSays(web, ">\(ProjectPage.startNewCoordinator)<", in: Self.coordinator)
        for finished in [true, false] {
            assertSays(web, "'\(ProjectPage.startNewCoordinatorDetail(finished: finished))'", in: Self.coordinator)
        }
        let page = try source(Self.page)
        assertSays(page, "title: '\(ProjectPage.replaceCoordinatorQuestion)'", in: Self.page)
        assertSays(page, "'\(ProjectPage.replaceCoordinatorDetail)'", in: Self.page)
        assertSays(page, "okText: '\(ProjectPage.replaceCoordinatorConfirm)'", in: Self.page)
        assertSays(page, "cancelText: '\(ProjectPage.replaceCoordinatorKeep)'", in: Self.page)
    }

    func testTheBlockersWords() throws {
        let web = try source(Self.blockers)
        for reason in ["OUTSIDE_DECLARED_SCOPE", "ACCEPTANCE_STANDARD_MOVED", "CRITERION_EXEMPTION_ARGUED",
                       "MERGE_REFUSED_BY_GIT"] {
            let headline = ProjectPage.blockerHeadline(ProjectBlocker(id: "b", kind: "K", detail: .init(reason: reason)))
            assertSays(web, "tag: '\(headline.tag)'", in: Self.blockers)
            assertSays(web, "title: '\(headline.title)'", in: Self.blockers)
        }
        for owner in ["USER", "COORDINATOR", "SYSTEM"] {
            let tag = ProjectPage.blockerHeadline(ProjectBlocker(id: "b", kind: "K", owner: owner)).tag
            assertSays(web, "\(owner): { tag: '\(tag)'", in: Self.blockers)
        }
        assertSays(web, "`criterion ${blocker.criterionOrdinal} is now revision ${blocker.criterionRevision}`",
                   in: Self.blockers)
        assertSays(web, "'since just now'", in: Self.blockers)
        assertSays(web, "`since ${Math.floor(elapsed / DAY)}d`", in: Self.blockers)
        assertSays(web, "`Auto-resolved — ${note || 'its condition no longer holds'}${when}`", in: Self.blockers)
        assertSays(web, "`Resolved by you — ${note || 'no reason was recorded'}${when}`", in: Self.blockers)
        assertSays(web, "`Resolved by the coordinator${note ? ` — ${note}` : ''}${when}`", in: Self.blockers)
        assertSays(web, "title=\"\(ProjectPage.resolveBlockerTitle)\"", in: Self.blockers)
        assertSays(web, ProjectPage.resolveBlockerQuestion, in: Self.blockers)
        assertSays(web, ProjectPage.resolveBlockerNote, in: Self.blockers)
        assertSays(web, "> \(ProjectPage.resolveBlockerPress) <", in: Self.blockers)
        assertSays(web, "`${open.length} open`", in: Self.blockers)
        assertSays(web, "`${blockers.resolvedCount} resolved · latest: `", in: Self.blockers)
    }

    func testTheRunQueueWords() throws {
        let web = try source(Self.queue)
        let busy = ProjectReadyToRun(readyCount: 2, queuedCount: 1, runningCount: 3, pausedCount: 1)
        for help in ProjectPage.queueHelp(busy).split(separator: ".").map({ $0.trimmingCharacters(in: .whitespaces) }) {
            assertSays(web, "'\(help).'", in: Self.queue)
        }
        for ranking in ["active first · remaining tasks in stable order", "stable order",
                        "ready tasks sorted by work unblocked", "sorted by work unblocked"] {
            assertSays(web, "'\(ranking)'", in: Self.queue)
        }
        assertSays(web, "`${pausedCount} ready in paused lists`", in: Self.queue)
        assertSays(web, ProjectPage.queueEmpty, in: Self.queue)
        let truncated = ProjectPage.queueImpactTruncated(maxTasks: 9)
        assertSays(web, "message=\"\(truncated.title)\"", in: Self.queue)
        assertSays(web, "unfinished tasks, so tasks are shown without downstream impact ranking.", in: Self.queue)
        for state in ["Work in progress", "Waiting for runner", "List paused", "Prerequisites complete"] {
            assertSays(web, state, in: Self.queue)
        }
        for impact in ["'Ready now'", "'Ready after resume'", "'Impact not ranked'", "`Unblocks ${item.downstreamBlocked} "] {
            assertSays(web, impact, in: Self.queue)
        }
        assertSays(web, "'\(ProjectPage.runPressStarting)' : '\(ProjectPage.runPress)'", in: Self.queue)
        assertSays(web, "> \(ProjectPage.resumeListPress) <", in: Self.queue)
        assertSays(web, "> \(ProjectPage.openRunSession) <", in: Self.queue)
        assertSays(web, "'Running' : runState === 'PAUSED' ? 'Paused' : 'Queued'", in: Self.queue)
        assertSays(web, "note: '\(ProjectPage.resumeListNote)'", in: Self.queue)
        assertSays(web, "title={`Resume “${item.pausedList.title}”?`}", in: Self.queue)
        assertSays(web, "`This removes the pause from the entire list. ${eligible} will become eligible.${immediate} Other automatic or scheduled work in the list can also dispatch once resumed.`",
                   in: Self.queue)
        assertSays(web, "configured to auto-run and may start immediately.", in: Self.queue)
    }

    func testTheCriteriaCardsFramingWords() throws {
        let web = try source(Self.acceptance)
        assertSays(web, "export const MOBILE_CRITERIA_PREVIEW = \(ProjectPage.criteriaPreviewCompact);", in: Self.acceptance)
        assertSays(web, "export const CRITERIA_PREVIEW = \(ProjectPage.criteriaPreviewRegular);", in: Self.acceptance)
        assertSays(web, "stated. Whether one is met is read off the work filed under it; nothing in Orbit judges the criteria themselves.",
                   in: Self.acceptance)
        assertSays(web, ProjectPage.noCriteria, in: Self.acceptance)
        for text in ["`View all ${criteria.length} criteria`", "`Show all ${criteria.length} criteria`",
                     "`Show first ${previewLimit} criteria`", "`Showing all ${criteria.length} criteria`",
                     "more not shown`"] {
            assertSays(web, text, in: Self.acceptance)
        }
        assertSays(web, ProjectPage.criteriaOutcomeNote, in: Self.acceptance)
        assertSays(web, "{\"\(ProjectPage.howItsChecked)\"}", in: Self.acceptance)
    }

    func testTheInstructionsField() throws {
        let web = try source(Self.page)
        assertSays(web, "<Field label=\"\(ProjectPage.instructionsHeading)\" text={p.instructions} empty=\"\(ProjectPage.noInstructions)\" />",
                   in: Self.page)
    }

    func testTheGraphsWords() throws {
        let web = try source(Self.graph)
        for meta in ["'Ready to run'", "`Waiting on ${data.waitingOn}`", "'Blocked'", "'Verification failed'",
                     "'Missing verifier'", "'Awaiting verification · verifier running'",
                     "'Awaiting verification · verifier blocked'", "'Awaiting verification · applying result'"] {
            assertSays(web, meta, in: Self.graph)
        }
        assertSays(web, "`${graph.data.taskCount.toLocaleString()} tasks`", in: Self.graph)
        assertSays(web, "ready to run` : null", in: Self.graph)
        assertSays(web, "done` : null", in: Self.graph)
        assertSays(web, "'dashed marks are folded'", in: Self.graph)
        assertSays(web, "Finished · ", in: Self.graph)
        for word in ["done", "running", "failed", "cancelled", "open"] {
            assertSays(web, "label: '\(word)'", in: Self.graph)
        }
        assertSays(web, "This project is larger than one graph request reads (", in: Self.graph)
        assertSays(web, "description=\"\(ProjectGraph.truncatedNotice(maxTasks: 1).detail)\"", in: Self.graph)
        let lib = try source(Self.graphLib)
        assertSays(lib, "title: `${members.length} done`", in: Self.graphLib)
        assertSays(lib, "const SETTLED_MIN_MEMBERS = 2;", in: Self.graphLib)
    }

    /// The native page draws the web's sections in the web's order.
    func testTheWebPageStillOrdersItsSectionsTheWayTheNativePageDoes() throws {
        let web = try source(Self.page)
        let order = ["<ProjectPanoramaHeader", "<ProjectCoordinatorSection", "<ProjectGoalCard",
                     "<ProjectTasksGraph", "<ProjectBlockersCard", "<ProjectReadyToRun",
                     "<ProjectAcceptanceCard", "<Field label=\"Instructions\"", "<ProjectTasks projectId"]
        let positions = order.map { web.range(of: $0)?.lowerBound }
        XCTAssertFalse(positions.contains(nil), "the web page lost one of \(order)")
        XCTAssertEqual(positions.compactMap { $0 }, positions.compactMap { $0 }.sorted())
    }
}
