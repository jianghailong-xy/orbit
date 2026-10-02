import XCTest
@testable import OrbitKit

/// A workspace's session list split by folder (docs/session-folders-move-design.md §3.3): which
/// folder rows show in which scope, what is left for the time sections, the state a folder row
/// reports for the sessions it hides, and what a folder's own page lists.
final class SessionFolderGroupingTests: XCTestCase {
    /// UTC so the time sections' day boundaries don't move with the test host's timezone.
    private var utc: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }
    private let now = ISO8601DateFormatter().date(from: "2026-10-02T12:00:00Z")!

    private func folder(_ id: String, _ name: String) -> SessionFolder {
        SessionFolder(id: id, workspaceId: "w1", name: name)
    }

    private func session(_ id: String, folder: String? = nil, state: SessionRunState = .awaitingInput,
                         lifecycle: SessionLifecycleState? = nil, approvals: Int = 0,
                         waitingKind: SessionWaitingKind? = nil, bg: Int = 0, jobs: Int = 0,
                         pinnedAt: String? = nil, lastTurnAt: String? = nil) -> Session {
        Session(id: id, title: id, status: .awaitingInput, runState: state, lifecycleState: lifecycle,
                agentId: "w1", assignedRunnerId: nil, pendingApprovals: approvals,
                waitingKind: waitingKind, branch: nil, updatedAt: nil,
                runningBgCount: bg, runningBgJobCount: jobs,
                pinnedAt: pinnedAt, lastTurnAt: lastTurnAt, folderId: folder)
    }

    private func listing(_ sessions: [Session], folders: [SessionFolder],
                         view: SessionView = .open, byTag: Bool = false,
                         runnerOffline: Bool = false) -> SessionFolderListing {
        SessionFolderGrouping.listing(sessions, folders: folders, view: view, byTag: byTag,
                                      runnerOffline: runnerOffline)
    }

    // MARK: what the list draws

    /// The sessions in a folder are drawn behind its row and nowhere else: the time sections are
    /// built from what is left, so neither a recent session nor a pinned one shows outside.
    func testASessionInAFolderIsNotInTheTimeSections() {
        let list = [
            session("loose-pinned", pinnedAt: "2026-09-01T00:00:00Z", lastTurnAt: "2026-09-01T09:00:00Z"),
            session("filed-pinned", folder: "f1", pinnedAt: "2026-09-02T00:00:00Z",
                    lastTurnAt: "2026-09-02T09:00:00Z"),
            session("filed-today", folder: "f1", lastTurnAt: "2026-10-02T11:00:00Z"),
            session("loose-today", lastTurnAt: "2026-10-02T10:00:00Z"),
            session("loose-older", lastTurnAt: "2026-07-01T09:00:00Z"),
        ]
        let split = listing(list, folders: [folder("f1", "Notes")])
        XCTAssertEqual(split.sessions.map(\.id), ["loose-pinned", "loose-today", "loose-older"])

        let sections = SessionTimeGrouping.sections(split.sessions, pinnedFirst: true, now: now, calendar: utc)
        XCTAssertEqual(sections.map(\.title), ["Pinned", "Today", "Older"])
        XCTAssertEqual(sections.flatMap { $0.sessions.map(\.id) },
                       ["loose-pinned", "loose-today", "loose-older"])
        XCTAssertEqual(split.folders.map(\.sessionCount), [2])
    }

    /// Open lists every folder of the workspace, the empty ones included — an empty folder is
    /// still somewhere a session can be moved to.
    func testOpenShowsEveryFolderEvenAnEmptyOne() {
        let split = listing([session("a", folder: "f1"), session("b")],
                            folders: [folder("f1", "Notes"), folder("f2", "Drafts")])
        XCTAssertEqual(split.folders.map(\.id), ["f2", "f1"])
        XCTAssertEqual(split.folders.map(\.sessionCount), [0, 1])
        XCTAssertEqual(split.folders.first?.status, .idle)
        XCTAssertEqual(split.sessions.map(\.id), ["b"])

        // A workspace with no sessions at all still shows its folders in Open.
        XCTAssertEqual(listing([], folders: [folder("f1", "Notes")]).folders.map(\.sessionCount), [0])
    }

    /// Completed lists a folder only when a completed session is in it.
    func testCompletedShowsOnlyTheFoldersWithACompletedSession() {
        let completed = [
            session("done", folder: "f1", state: .succeeded, lifecycle: .completed),
            session("done-loose", state: .ended, lifecycle: .completed),
        ]
        let split = listing(completed, folders: [folder("f1", "Notes"), folder("f2", "Drafts")],
                            view: .completed)
        XCTAssertEqual(split.folders.map(\.id), ["f1"])
        XCTAssertEqual(split.folders.map(\.sessionCount), [1])
        XCTAssertEqual(split.sessions.map(\.id), ["done-loose"])

        XCTAssertEqual(listing([session("done-loose", lifecycle: .completed)],
                               folders: [folder("f1", "Notes")], view: .completed).folders, [])
    }

    /// Trash is flat: no folder row, and every session in the list — the filed ones too, which
    /// keep their folder so Move to Open puts them back in it.
    func testTrashIsFlat() {
        let trash = [session("gone", folder: "f1", lifecycle: .trash), session("gone-loose", lifecycle: .trash)]
        let split = listing(trash, folders: [folder("f1", "Notes"), folder("f2", "Drafts")], view: .trash)
        XCTAssertEqual(split.folders, [])
        XCTAssertEqual(split.sessions.map(\.id), ["gone", "gone-loose"])
    }

    /// Narrowed to a tag or grouped by tag, the list is flat in every scope: a second grouping
    /// stacked on the tag one would give a session two places to be.
    func testATagFilterOrGroupByTagIsFlat() {
        let list = [session("filed", folder: "f1"), session("loose")]
        for view in [SessionView.open, .completed] {
            let split = listing(list, folders: [folder("f1", "Notes"), folder("f2", "Drafts")],
                                view: view, byTag: true)
            XCTAssertEqual(split.folders, [], "\(view)")
            XCTAssertEqual(split.sessions.map(\.id), ["filed", "loose"], "\(view)")
        }
    }

    /// Folders sort by name as Finder sorts names: case doesn't decide, and numbers read as numbers.
    /// A plain `<` would put "Gamma" before "beta" and "Sprint 10" before "Sprint 2".
    func testFoldersSortByNameAsFinderDoes() {
        let folders = [folder("f1", "Sprint 10"), folder("f2", "beta"), folder("f3", "Gamma"),
                       folder("f4", "Sprint 2"), folder("f5", "Alpha")]
        XCTAssertEqual(listing([], folders: folders).folders.map(\.folder.name),
                       ["Alpha", "beta", "Gamma", "Sprint 2", "Sprint 10"])
        // The order the folders arrive in decides nothing.
        XCTAssertEqual(listing([], folders: folders.reversed()).folders.map(\.folder.name),
                       ["Alpha", "beta", "Gamma", "Sprint 2", "Sprint 10"])
    }

    /// A session whose folder isn't among the workspace's folders — deleted since the list was
    /// fetched, or the folders not loaded yet — stays in the list instead of disappearing.
    func testASessionInAnUnknownFolderStaysInTheList() {
        let list = [session("orphan", folder: "gone"), session("filed", folder: "f1")]
        let split = listing(list, folders: [folder("f1", "Notes")])
        XCTAssertEqual(split.sessions.map(\.id), ["orphan"])
        XCTAssertEqual(split.folders.map(\.sessionCount), [1])

        // No folders at all (an older server, or the read failed): the list is the list.
        XCTAssertEqual(listing(list, folders: []).sessions.map(\.id), ["orphan", "filed"])
    }

    // MARK: the folder row's state

    /// Something waiting on you outranks a running session: the row shows how many wait, counted
    /// in sessions as the Workspace row counts them.
    func testWaitingOutranksRunningOnAFolderRow() {
        let list = [
            session("running", folder: "f1", state: .running),
            session("asks", folder: "f1", state: .running, approvals: 1),
            session("asks-twice", folder: "f1", approvals: 2),
        ]
        XCTAssertEqual(listing(list, folders: [folder("f1", "Notes")]).folders.first?.status, .needsYou(2))
        // The Workspace row over the same sessions says the same.
        XCTAssertEqual(WorkspaceNavigationStatusLogic.resolve(
            waiting: NeedsYouLogic.byAgent(list)["w1"] ?? 0,
            running: WorkspaceActivityLogic.runningWorkspaceIDs(list).contains("w1"),
            jobs: WorkspaceActivityLogic.jobWorkspaceIDs(list).contains("w1"),
            runnerOffline: false), .needsYou(2))
    }

    /// Nothing waiting: a running session spins the row, else a background job makes it breathe,
    /// else it is idle — and an explicitly offline Runner stops a stale spinner as it does on the
    /// Workspace row, without hiding what waits on you.
    func testAFolderRowRunsThenBreathesThenRests() {
        let notes = [folder("f1", "Notes")]
        func status(_ list: [Session], offline: Bool = false) -> WorkspaceNavigationStatus? {
            listing(list, folders: notes, runnerOffline: offline).folders.first?.status
        }
        let running = session("running", folder: "f1", state: .running)
        let job = session("job", folder: "f1", bg: 2, jobs: 1)
        let service = session("service", folder: "f1", bg: 1)
        XCTAssertEqual(status([job, running]), .running)
        XCTAssertEqual(status([job, service]), .jobs)
        XCTAssertEqual(status([service]), .idle)
        XCTAssertEqual(status([running], offline: true), .idle)
        XCTAssertEqual(status([running, session("asks", folder: "f1", approvals: 1)], offline: true),
                       .needsYou(1))
        // Only the sessions in the folder count: one running outside it leaves the row idle.
        XCTAssertEqual(status([session("outside", state: .running)]), .idle)
    }

    /// A project that is only ready to start is not counted as waiting on you — not by the
    /// Workspace row, and so not by a folder row either.
    func testAFolderRowCountsWhatTheWorkspaceRowCounts() {
        let list = [
            session("asks", folder: "f1", approvals: 1),
            session("ready-to-start", folder: "f1", approvals: 1, waitingKind: .startRequest),
        ]
        XCTAssertEqual(listing(list, folders: [folder("f1", "Notes")]).folders.first?.status, .needsYou(1))
        XCTAssertEqual(NeedsYouLogic.byAgent(list), ["w1": 1])
    }

    // MARK: a folder's page

    /// The page lists the folder's sessions in the order the list orders that scope — pinned first,
    /// then latest activity, whatever order they arrive in — so its time sections are the list's.
    func testAFolderPageListsItsSessionsInTheListsOrder() {
        let open = [
            session("older", folder: "f1", lastTurnAt: "2026-09-20T09:00:00Z"),
            session("elsewhere", folder: "f2", lastTurnAt: "2026-10-02T10:00:00Z"),
            session("newer", folder: "f1", lastTurnAt: "2026-10-02T09:00:00Z"),
            session("pinned", folder: "f1", pinnedAt: "2026-09-01T00:00:00Z", lastTurnAt: "2026-07-01T09:00:00Z"),
            session("loose", lastTurnAt: "2026-10-02T11:00:00Z"),
        ]
        let page = SessionFolderGrouping.sessions(open, inFolder: "f1", view: .open)
        XCTAssertEqual(page.map(\.id), ["pinned", "newer", "older"])
        XCTAssertEqual(page.map(\.id), SessionFilter.forAgent(open, agentID: "w1", view: .open)
            .filter { $0.folderId == "f1" }.map(\.id))
        XCTAssertEqual(SessionTimeGrouping.sections(page, pinnedFirst: true, now: now, calendar: utc).map(\.title),
                       ["Pinned", "Today", "Previous 30 Days"])

        // Completed keeps the server's order (completion time), as the Completed list does.
        let completed = [session("first", folder: "f1", lifecycle: .completed, lastTurnAt: "2026-09-01T09:00:00Z"),
                         session("second", folder: "f1", lifecycle: .completed, lastTurnAt: "2026-10-01T09:00:00Z")]
        XCTAssertEqual(SessionFolderGrouping.sessions(completed, inFolder: "f1", view: .completed).map(\.id),
                       ["first", "second"])
    }

    /// The number on a folder's row is the number of sessions its page lists, in either scope.
    func testAFolderRowCountsWhatItsPageLists() {
        let list = [session("a", folder: "f1"), session("b", folder: "f1"), session("c", folder: "f2"),
                    session("d")]
        let folders = [folder("f1", "Notes"), folder("f2", "Drafts")]
        for view in [SessionView.open, .completed] {
            for row in listing(list, folders: folders, view: view).folders {
                XCTAssertEqual(row.sessionCount,
                               SessionFolderGrouping.sessions(list, inFolder: row.id, view: view).count,
                               "\(view) \(row.folder.name)")
            }
        }
    }
}
