import XCTest
@testable import OrbitKit

final class ScheduledRunsFolderTests: XCTestCase {
    private func session(_ id: String, workspace: String = "w1", source: String? = "SCHEDULE",
                         status: RunStatus = .awaitingInput, approvals: Int = 0,
                         waitingKind: SessionWaitingKind? = nil, folderID: String? = nil,
                         listedAt: String? = nil) -> Session {
        Session(id: id, title: id, status: status, agentId: workspace, assignedRunnerId: nil,
                pendingApprovals: approvals, waitingKind: waitingKind, branch: nil, updatedAt: nil,
                runSource: source, listedAt: listedAt, folderId: folderID)
    }

    func testWorkspaceAndScheduledListsKeepDisjointRows() {
        let rows = [
            session("old-server", source: nil, listedAt: "2026-10-02T00:00:00Z"),
            session("manual", source: "MANUAL", listedAt: "2026-10-01T00:00:00Z"),
            session("run", folderID: "f1"),
            session("other-run", workspace: "w2"),
        ]

        for view in SessionView.allCases {
            XCTAssertEqual(SessionFilter.forAgent(rows, agentID: "w1", view: view).map(\.id),
                           ["old-server", "manual"])
            XCTAssertEqual(SessionFilter.forAgent(rows, agentID: "w1", view: view, scheduled: true).map(\.id),
                           ["run"])
        }
    }

    /// A schedule's change conversation (runSource SCHEDULE_CHANGE, §8.2) is in no list — the server already
    /// excludes it, but a realtime upsert can bring a row in: both the workspace's and the scheduled runs'
    /// lists keep it out, as the web's `row.runSource !== 'SCHEDULE_CHANGE'` read does.
    func testChangeConversationsAreInNoList() {
        let rows = [
            session("manual", source: "MANUAL"),
            session("run", source: "SCHEDULE"),
            session("change", source: "SCHEDULE_CHANGE"),
        ]

        for view in SessionView.allCases {
            XCTAssertEqual(SessionFilter.forAgent(rows, agentID: "w1", view: view).map(\.id), ["manual"])
            XCTAssertEqual(SessionFilter.forAgent(rows, agentID: "w1", view: view, scheduled: true).map(\.id), ["run"])
        }
    }

    func testSummaryUsesFolderVisibilityAndKeepsBothAttentionMarks() {
        let runs = [
            session("running", status: .running),
            session("waiting", approvals: 2),
            session("ready-to-start", approvals: 1, waitingKind: .startRequest),
        ]
        XCTAssertNil(ScheduledRunsFolder.summary([], view: .open, byTag: false))
        XCTAssertNil(ScheduledRunsFolder.summary(runs, view: .trash, byTag: false))
        XCTAssertNil(ScheduledRunsFolder.summary(runs, view: .open, byTag: true))
        for view in [SessionView.open, .completed] {
            let summary = ScheduledRunsFolder.summary(runs, view: view, byTag: false)
            XCTAssertEqual(summary?.sessionCount, 3)
            XCTAssertEqual(summary?.needsYou, 1)
            XCTAssertEqual(summary?.running, true)
        }
        let idle = ScheduledRunsFolder.summary([session("idle")], view: .open, byTag: false)
        XCTAssertEqual(idle?.needsYou, 0)
        XCTAssertEqual(idle?.running, false)
    }

    func testRunLinkUsesItsWorkspaceAndLifecycleScope() throws {
        let json = #"{"id":"run","status":"SUCCEEDED","runSource":"SCHEDULE","agentId":"w1","agent":{"id":"w2","name":"Workspace"},"lifecycleState":"COMPLETED"}"#
        let run = try JSONDecoder().decode(Session.self, from: Data(json.utf8))
        XCTAssertEqual(SessionFolderAddress.scheduledRuns(for: run), .scheduledRuns(agentID: "w2", view: .completed))
        XCTAssertEqual(SessionFolderAddress.scheduledRuns(for: session("open")), .scheduledRuns(agentID: "w1", view: .open))
    }

    func testBackFromARunReturnsToItsFolderAndScope() {
        let folder = SessionFolderAddress.scheduledRuns(agentID: "w1", view: .completed)
        var nav = NavState(section: .agents)
        nav.enterFolder(folder)
        nav.push(.console(sessionID: "run", origin: .list))
        XCTAssertEqual(nav.folderColumn, folder)

        nav.pop()
        XCTAssertEqual(nav.folderPage, folder)
        nav.switchWorkspace(from: "w1", to: "w2", folders: [])
        XCTAssertTrue(nav.path.isEmpty)
        nav.switchWorkspace(from: "w2", to: "w1", folders: [])
        XCTAssertEqual(nav.folderPage, folder)
    }
}
