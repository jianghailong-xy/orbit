import Foundation
import XCTest
@testable import OrbitKit

/// A session list regroups when, and only when, something it is grouped from changed.
final class SessionListingMemoTests: XCTestCase {
    private let now = RelativeTime.parse("2026-10-04T10:00:30Z")!

    private func session(_ id: String, title: String? = nil) -> Session {
        Session(id: id, title: title ?? id, status: .awaitingInput, agentId: "w1", assignedRunnerId: nil,
                pendingApprovals: nil, branch: nil, updatedAt: nil, pinnedAt: nil,
                createdAt: "2026-10-04T09:00:00Z", lastTurnAt: "2026-10-04T09:40:00Z")
    }

    private var base: SessionListInputs {
        SessionListInputs(workspaceID: "w1", sessions: [session("a"), session("b")], accountSessions: [session("a")],
                          allSessions: [session("a"), session("b"), session("c")],
                          folders: [SessionFolder(id: "f1", workspaceId: "w1", name: "Folder")],
                          projects: [ProjectSummary(id: "p1", title: "Project", buckets: ProjectBuckets(running: 0),
                                                    lastActivityAt: nil, attention: nil, taskCounts: nil)],
                          watches: [:], view: .open, searching: false, runnerOffline: false, now: now)
    }

    /// Runs `inputs` through a memo that has just computed `base`, and returns how many times it
    /// computed in all.
    private func computations(after inputs: SessionListInputs) -> Int {
        let memo = SessionListingMemo<Int>()
        _ = memo.value(for: base) { _, _ in 1 }
        _ = memo.value(for: inputs) { _, _ in 2 }
        return memo.computations
    }

    private func changed(_ change: (inout SessionListInputs) -> Void) -> SessionListInputs {
        var inputs = base
        change(&inputs)
        return inputs
    }

    func testNothingChangedHandsTheLastGroupingBack() {
        let memo = SessionListingMemo<String>()
        XCTAssertEqual(memo.value(for: base) { _, _ in "first" }, "first")
        XCTAssertEqual(memo.value(for: base) { _, _ in "second" }, "first")
        XCTAssertEqual(memo.value(for: base) { _, _ in "third" }, "first")
        XCTAssertEqual(memo.computations, 1)
    }

    /// A model that reassigned an equal list (a refetch that brought nothing new) moves no row.
    func testAnEqualCopyOfEveryInputIsNoChange() {
        XCTAssertEqual(computations(after: base), 1)
        XCTAssertEqual(computations(after: changed { $0.sessions = [session("a"), session("b")] }), 1)
        XCTAssertEqual(computations(after: SessionListInputs(
            workspaceID: "w1", sessions: [session("a"), session("b")], accountSessions: [session("a")],
            allSessions: [session("a"), session("b"), session("c")],
            folders: [SessionFolder(id: "f1", workspaceId: "w1", name: "Folder")],
            projects: base.projects, watches: [:], view: .open, searching: false, runnerOffline: false,
            now: now.addingTimeInterval(20))), 1, "the same minute")
    }

    func testEveryInputInvalidates() throws {
        let watch = try XCTUnwrap(WatchSessionSummary(sessionID: "S1",
                                                      watches: [WatchFixture.watch(id: "W1", state: "ACTIVE")]))
        let changes: [(String, SessionListInputs)] = [
            ("the list", changed { $0.sessions = [session("a"), session("b", title: "renamed")] }),
            ("a session leaving the list", changed { $0.sessions = [session("a")] }),
            ("the account's sessions", changed { $0.accountSessions = [session("a"), session("d")] }),
            ("every workspace's sessions", changed { $0.allSessions = [session("a")] }),
            ("the folders", changed { $0.folders = [SessionFolder(id: "f1", workspaceId: "w1", name: "Renamed")] }),
            ("the projects", changed { $0.projects = [] }),
            ("the watches", changed { $0.watches = ["S1": watch] }),
            ("the tag filter", changed { $0.tagFilter = "t1" }),
            ("the scope", changed { $0.view = .completed }),
            ("Group by Tag", changed { $0.groupByTag = true }),
            ("searching", changed { $0.searching = true }),
            ("the Runner going offline", changed { $0.runnerOffline = true }),
            ("the workspace", changed { $0.workspaceID = "w2" }),
            ("the folder", changed { $0.folderID = "f1" }),
            ("the next minute", changed { $0.minute += 1 }),
        ]
        for (what, inputs) in changes {
            XCTAssertEqual(computations(after: inputs), 2, "\(what) changed, and the list kept its old grouping")
        }
    }

    /// After regrouping, the new grouping is what it holds on to — not the first.
    func testItKeepsTheLatestGrouping() {
        let memo = SessionListingMemo<Int>()
        let other = changed { $0.searching = true }
        XCTAssertEqual(memo.value(for: base) { _, _ in 1 }, 1)
        XCTAssertEqual(memo.value(for: other) { _, _ in 2 }, 2)
        XCTAssertEqual(memo.value(for: other) { _, _ in 3 }, 2)
        XCTAssertEqual(memo.value(for: base) { _, _ in 4 }, 4)
        XCTAssertEqual(memo.computations, 3)
    }

    /// The grouping reads its inputs through these, so they have to be the views' old readings.
    func testTheDerivedReadings() throws {
        var inputs = base
        inputs.folders.append(SessionFolder(id: "f2", workspaceId: "w2", name: "Elsewhere"))
        XCTAssertEqual(inputs.workspaceFolders.map(\.id), ["f1"])
        XCTAssertFalse(inputs.byTag)
        inputs.groupByTag = true
        XCTAssertTrue(inputs.byTag)
        inputs.groupByTag = false
        inputs.tagFilter = "t1"
        XCTAssertTrue(inputs.byTag)
        XCTAssertEqual(inputs.shownSessions, SessionFilter.withTag(inputs.sessions, tagID: "t1"))
        inputs.tagFilter = nil
        XCTAssertEqual(inputs.shownSessions, inputs.sessions)

        let watch = try XCTUnwrap(WatchSessionSummary(sessionID: "S1",
                                                      watches: [WatchFixture.watch(id: "W1", state: "ACTIVE")]))
        inputs.watches = [PublicID.storageKey("S1"): watch]
        XCTAssertEqual(inputs.watch(for: "S1"), watch)
        XCTAssertNil(inputs.watch(for: "S2"))
    }

    // MARK: the rows' lines

    private func running(_ id: String, reply: String) -> Session {
        Session(id: id, title: id, status: .running, runState: .running, agentId: "w1", assignedRunnerId: nil,
                pendingApprovals: nil, branch: nil, updatedAt: nil, lastAssistantText: reply,
                createdAt: "2026-10-04T09:00:00Z", lastTurnAt: "2026-10-04T09:40:00Z")
    }

    /// A line is `SessionLine.make`'s, and is made again only for a session (or watch) that moved.
    func testALineIsMadeAgainOnlyForASessionThatChanged() throws {
        let cache = SessionLineCache()
        let a = running("a", reply: "first **reply**"), b = running("b", reply: "other")
        XCTAssertEqual(cache.line(for: a, watching: nil), SessionLine.make(for: a, live: true))
        XCTAssertEqual(cache.line(for: b, watching: nil), SessionLine.make(for: b, live: true))
        cache.endPass()
        XCTAssertEqual(cache.made, 2)

        _ = cache.line(for: a, watching: nil)
        _ = cache.line(for: b, watching: nil)
        cache.endPass()
        XCTAssertEqual(cache.made, 2, "nothing changed")

        let moved = running("a", reply: "second reply")
        XCTAssertEqual(cache.line(for: moved, watching: nil), SessionLine.make(for: moved, live: true))
        XCTAssertEqual(cache.made, 3, "a's preview moved")

        let watch = try XCTUnwrap(WatchSessionSummary(sessionID: "b",
                                                      watches: [WatchFixture.watch(id: "W1", observer: "b")]))
        XCTAssertEqual(cache.line(for: b, watching: watch), SessionLine.make(for: b, live: true, watching: watch))
        XCTAssertEqual(cache.made, 4, "b's watch moved")

        // The account's Session recaps switch is part of what a line is made of: flipping it makes
        // the lines again, or a list left on screen would keep drawing the lines the old answer asked
        // for (Settings writes a switch mid-list).
        _ = cache.line(for: a, watching: nil, recaps: false)
        XCTAssertEqual(cache.made, 5, "the switch moved")
        _ = cache.line(for: a, watching: nil, recaps: false)
        _ = cache.line(for: b, watching: watch, recaps: false)
        cache.endPass()
        XCTAssertEqual(cache.made, 6, "only the line the switch was not yet told about")
    }

    /// A session no pass asked for any more is let go of, and made afresh if it comes back.
    func testAPassForgetsTheSessionsItDidNotAskFor() {
        let cache = SessionLineCache()
        let a = running("a", reply: "x"), b = running("b", reply: "y")
        _ = cache.line(for: a, watching: nil)
        _ = cache.line(for: b, watching: nil)
        cache.endPass()
        _ = cache.line(for: a, watching: nil)
        cache.endPass()
        _ = cache.line(for: b, watching: nil)
        XCTAssertEqual(cache.made, 3)
    }

    /// The memo hands its compute the one cache it keeps, regrouping after regrouping.
    func testTheMemoKeepsItsLinesAcrossRegroupings() {
        let memo = SessionListingMemo<SessionLine>()
        let a = running("a", reply: "x")
        _ = memo.value(for: base) { _, lines in lines.line(for: a, watching: nil) }
        _ = memo.value(for: changed { $0.searching = true }) { _, lines in lines.line(for: a, watching: nil) }
        XCTAssertEqual(memo.computations, 2)
        XCTAssertEqual(memo.lines.made, 1)
    }
}
