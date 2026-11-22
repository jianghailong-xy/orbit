import Foundation
import XCTest
@testable import OrbitKit

/// Pause / Resume on a project row (design §4.2, §4.3, §6): the line order and the actions per state.
final class SessionProjectPauseTests: XCTestCase {
    private let now = RelativeTime.parse("2026-11-19T10:00:00Z")!

    private func ago(_ minutes: Double) -> String {
        ISO8601DateFormatter().string(from: now.addingTimeInterval(-minutes * 60))
    }

    private func coordinator(approvals: Int = 0) -> Session {
        Session(id: "c", title: "c", status: .awaitingInput, runState: .awaitingInput, agentId: "w1",
                assignedRunnerId: nil, pendingApprovals: approvals, branch: nil, updatedAt: nil,
                projectId: "p1", projectTitle: "P", lastAssistantText: "Last reply",
                agent: nil, pinnedAt: nil, createdAt: "2026-11-19T09:00:00Z", lastTurnAt: "2026-11-19T09:40:00Z",
                projectMembership: SessionProjectMembership(projectId: "p1", projectTitle: "P",
                                                            projectStatus: .open, role: .coordinator))
    }

    private func row(status: ProjectStatus = .open, started: String? = "2026-11-18T10:00:00Z",
                     pausedAt: String? = nil, fuse: ProjectSidebarFuse = .notPaused, running: Int = 0,
                     held: ProjectListCoordinatorItems? = nil, approvals: Int = 0,
                     view: SessionView = .open) throws -> SessionProjectRow {
        let summary = ProjectSummary(id: "p1", title: "P", status: status,
                                     buckets: ProjectBuckets(running: running),
                                     attention: ProjectListAttention(coordinatorItems: held),
                                     taskCounts: ProjectSidebarTaskCounts(done: 1, failed: 0, total: 4),
                                     startedAt: started, startedAtRead: true,
                                     pausedAt: pausedAt, pausedReason: pausedAt == nil ? nil : "OWNER", fuse: fuse)
        let c = coordinator(approvals: approvals)
        return try XCTUnwrap(SessionProjectGrouping.listing(
            [c], folders: [], projects: [summary], view: view, byTag: false, now: now).projects.first)
    }

    private let fuseOpen = ProjectSidebarFuse(paused: true, episodeId: "e1", observed: 6, limit: 6)

    // MARK: actions per state

    func testNotStartedOffersOnlyPin() throws {
        let r = try row(started: nil)
        XCTAssertEqual(r.leadingActions(in: .open), [.pin])
    }

    func testRunningOffersPauseThenPin() throws {
        XCTAssertEqual(try row().leadingActions(in: .open), [.pause, .pin])
    }

    func testOwnerPausedOffersResumeThenPin() throws {
        let r = try row(pausedAt: ago(120))
        XCTAssertEqual(r.leadingActions(in: .open), [.resume, .pin])
        XCTAssertEqual(r.resumeCalls, [.owner])
    }

    func testFusePausedOffersResumeThenPinAndLiftsTheEpisode() throws {
        let r = try row(fuse: fuseOpen)
        XCTAssertEqual(r.leadingActions(in: .open), [.resume, .pin])
        XCTAssertEqual(r.resumeCalls, [.fuse(episodeId: "e1")])
    }

    func testBothPausesLiftBothLimitFirst() throws {
        let r = try row(pausedAt: ago(5), fuse: fuseOpen)
        XCTAssertEqual(r.resumeCalls, [.fuse(episodeId: "e1"), .owner])
    }

    func testFinishedInOpenOffersCompleteThenPin() throws {
        for status in [ProjectStatus.done, .cancelled] {
            XCTAssertEqual(try row(status: status).leadingActions(in: .open), [.complete, .pin])
        }
        XCTAssertEqual(try row(status: .done, view: .completed).leadingActions(in: .completed), [.pin])
    }

    func testTrailingStaysMoveAndNoStateAllowsAFullSwipe() throws {
        XCTAssertFalse(SessionProjectRow.allowsFullSwipe)
        for r in [try row(started: nil), try row(), try row(pausedAt: ago(1)), try row(fuse: fuseOpen),
                  try row(status: .done)] {
            XCTAssertEqual(r.trailingActions(), [.move])
        }
    }

    func testMenuGroupLeadsWithTheStateActionAndCompleteStaysOutOfIt() throws {
        XCTAssertEqual(try row().menuGroup(in: .open), [.pause, .pin, .move])
        XCTAssertEqual(try row(pausedAt: ago(1)).menuGroup(in: .open), [.resume, .pin, .move])
        XCTAssertEqual(try row(status: .done).menuGroup(in: .open), [.pin, .move])
        XCTAssertEqual(try row(started: nil).menuGroup(in: .open), [.pin, .move])
    }

    // MARK: the second line

    func testOwnerPausedLineIsGreyWithAGlyph() throws {
        let line = try row(pausedAt: ago(120)).line
        XCTAssertEqual(line.text, "Paused · 2h")
        XCTAssertEqual(line.tone, .preview)
        XCTAssertTrue(line.pauseGlyph)
    }

    func testOwnerPausedLineCountsRunsStillFinishing() throws {
        XCTAssertEqual(try row(pausedAt: ago(5), running: 2).line.text, "Paused · 2 runs finishing")
        XCTAssertEqual(try row(pausedAt: ago(5), running: 1).line.text, "Paused · 1 run finishing")
    }

    func testFuseLineIsAmberAndWinsOverAnOwnerPause() throws {
        let line = try row(pausedAt: ago(5), fuse: fuseOpen).line
        XCTAssertEqual(line.text, "Paused at the daily limit · 6/6 today")
        XCTAssertEqual(line.tone, .warning)
        XCTAssertTrue(line.pauseGlyph)
    }

    func testWaitingOnYouOutranksThePauseLines() throws {
        let line = try row(pausedAt: ago(5), fuse: fuseOpen, approvals: 1).line
        XCTAssertEqual(line.tone, .approval)
        XCTAssertFalse(line.pauseGlyph)
    }

    func testPauseLinesOutrankTheCoordinatorsException() throws {
        let held = ProjectListCoordinatorItems(count: 1, leadKind: .integrationError, oldestWaitingSince: ago(18))
        XCTAssertEqual(try row(pausedAt: ago(5), held: held).line.text, "Paused · 5m")
    }

    func testAnUnpausedRowHasNoPauseGlyph() throws {
        XCTAssertFalse(try row().line.pauseGlyph)
    }

    // MARK: toasts

    func testToastWords() {
        XCTAssertEqual(SessionProjectCopy.pausedStill(running: 2), "2 runs still going · nothing new starts or merges")
        XCTAssertEqual(SessionProjectCopy.pausedStill(running: 1), "1 run still going · nothing new starts or merges")
        XCTAssertEqual(SessionProjectCopy.pausedStill(running: 0), "Nothing new starts or merges")
        XCTAssertEqual(SessionProjectCopy.refusedReason(status: 403, body: nil, resuming: false),
                       "Only the project's owner can pause it")
        XCTAssertEqual(SessionProjectCopy.refusedReason(status: 403, body: nil, resuming: true),
                       "Only the project's owner can resume it")
        XCTAssertEqual(SessionProjectCopy.refusedReason(status: 409, body: "{\"code\":\"PROJECT_NOT_STARTED\"}", resuming: false),
                       "The project hasn't started yet")
        XCTAssertEqual(SessionProjectCopy.refusedReason(status: 500, body: "{\"message\":\"Try later\"}", resuming: false),
                       "Try later")
    }
}
