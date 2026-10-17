import Foundation
import XCTest
@testable import OrbitKit

/// A control event changing one Open row now updates the derived surfaces one row at a time
/// (`OpenListDerived.replace`) and diffs only that row. Each case holds it to what the full-snapshot
/// path derives from the whole list after the same change: the alerts, the badge, the needs-you
/// rows and per-workspace counts, the running / jobs workspace sets and the coordinator pulses.
final class OpenListRowUpdateTests: XCTestCase {

    private func row(_ id: String, _ status: String = "RUNNING", agent: String? = "w1",
                     approvals: Int = 0, waiting: String? = nil, title: String? = nil,
                     bg: Int? = nil, bgJobs: Int? = nil, project: String? = nil,
                     lastTurnAt: String? = nil, retryAt: String? = nil,
                     engineTurn: Bool? = nil, ownerItem: Bool = false) -> Session {
        var fields: [String: Any] = ["id": id, "title": title ?? id, "status": status,
                                     "pendingApprovals": approvals]
        fields["agentId"] = agent
        fields["waitingKind"] = waiting
        fields["runningBgCount"] = bg
        fields["runningBgJobCount"] = bgJobs
        fields["projectId"] = project
        fields["lastTurnAt"] = lastTurnAt
        fields["retryAt"] = retryAt
        fields["engineTurnActive"] = engineTurn
        if ownerItem {
            fields["ownerItems"] = [["itemId": "oi-\(id)", "kind": "ESCALATED", "title": "Escalated",
                                    "since": "2026-10-01T00:00:00Z"]]
        }
        let data = try! JSONSerialization.data(withJSONObject: fields)
        return try! JSONDecoder().decode(Session.self, from: data)
    }

    private func summary(_ json: String) -> ControlSessionSummary {
        try! JSONDecoder().decode(ControlSessionSummary.self, from: Data(json.utf8))
    }

    /// The one-row path against the full one, for `list` with row `index` replaced by `new`.
    /// Returns the one-row alerts and derivation so a case can say what they should be.
    @discardableResult
    private func assertMatchesSnapshot(_ list: [Session], replacing index: Int, with new: Session,
                                       focused: String? = nil, filed: Set<String> = [],
                                       file: StaticString = #filePath, line: UInt = #line)
        -> (events: [NotificationEvent], derived: OpenListDerived) {
        let old = list[index]
        var next = list
        next[index] = new
        let events = SessionDelta.diff(previous: [old], current: [new],
                                       focusedSessionID: focused, filed: filed)
        XCTAssertEqual(events, SessionDelta.diff(previous: list, current: next,
                                                 focusedSessionID: focused, filed: filed),
                       "alerts", file: file, line: line)
        var derived = OpenListDerived(list)
        derived.replace(old, with: new, in: next)
        XCTAssertEqual(derived, OpenListDerived(next), "derived state", file: file, line: line)
        var narrow = OpenListDerived(list, tracksActivity: false)
        narrow.replace(old, with: new, in: next)
        XCTAssertEqual(narrow, OpenListDerived(next, tracksActivity: false), file: file, line: line)
        return (events, derived)
    }

    private var busy: [Session] {
        [row("a", agent: "w1"), row("b", agent: "w1"), row("c", "AWAITING_INPUT", agent: "w2"),
         row("d", "PENDING", agent: "w2"), row("e", agent: "w3", approvals: 1),
         row("f", "AWAITING_INPUT", agent: "w3", bg: 1, bgJobs: 1),
         row("g", agent: "w4", project: "p1", lastTurnAt: "2026-10-05T10:00:00Z")]
    }

    func testBecomingNeedsYouAlertsAndRaisesTheBadge() {
        let list = busy
        let (events, derived) = assertMatchesSnapshot(list, replacing: 0,
                                                      with: row("a", agent: "w1", approvals: 2, title: "Fix"))
        XCTAssertEqual(events, [.needsApproval(sessionID: "a", title: "Fix", count: 2)])
        XCTAssertEqual(derived.menu.badge, "2")
        XCTAssertEqual(Set(derived.needsYou.map(\.id)), ["a", "e"])
        XCTAssertEqual(derived.agentNeedsYou, ["w1": 1, "w3": 1])
        // b still spins in w1, so the workspace keeps its mark.
        XCTAssertEqual(derived.activity?.runningWorkspaceIDs, ["w1", "w4"])
    }

    func testApprovalAnsweredDropsTheBadge() {
        let (events, derived) = assertMatchesSnapshot(busy, replacing: 4, with: row("e", agent: "w3"))
        XCTAssertEqual(events, [])
        XCTAssertNil(derived.menu.badge)
        XCTAssertEqual(derived.needsYou, [])
        XCTAssertEqual(derived.agentNeedsYou, [:])
        XCTAssertEqual(derived.activity?.runningWorkspaceIDs, ["w1", "w3", "w4"])
    }

    func testRunEndingClearsTheWorkspaceSpinnerOnlyWithItsLastRunningRow() {
        var list = busy
        var derived = assertMatchesSnapshot(list, replacing: 0, with: row("a", "AWAITING_INPUT")).derived
        XCTAssertEqual(derived.activity?.runningWorkspaceIDs, ["w1", "w4"])
        list[0] = row("a", "AWAITING_INPUT")
        derived = assertMatchesSnapshot(list, replacing: 1, with: row("b", "AWAITING_INPUT")).derived
        XCTAssertEqual(derived.activity?.runningWorkspaceIDs, ["w4"])
        // A run settling for good is announced; one the server is about to retry is not.
        let settled = assertMatchesSnapshot(busy, replacing: 0, with: row("a", "SUCCEEDED"))
        XCTAssertEqual(settled.events, [.finished(sessionID: "a", title: "a", status: .succeeded)])
        XCTAssertEqual(settled.derived.menu.running, 4)
        let retrying = assertMatchesSnapshot(busy, replacing: 0,
                                             with: row("a", "FAILED", retryAt: "2026-10-06T00:00:00Z"))
        XCTAssertEqual(retrying.events, [])
        assertMatchesSnapshot(busy, replacing: 5, with: row("f", "AWAITING_INPUT", agent: "w3", bg: 1, bgJobs: 0))
    }

    func testQuietAndFiledRowsStayQuiet() {
        let raised = row("a", agent: "w1", approvals: 1)
        XCTAssertEqual(assertMatchesSnapshot(busy, replacing: 0, with: raised, focused: "a").events, [])
        XCTAssertEqual(assertMatchesSnapshot(busy, replacing: 0, with: row("a", "SUCCEEDED"),
                                             filed: ["a"]).events, [])
        // A project ready to start is not something waiting on you.
        let start = assertMatchesSnapshot(busy, replacing: 0,
                                          with: row("a", "AWAITING_INPUT", approvals: 1, waiting: "START_REQUEST"))
        XCTAssertEqual(start.events, [])
        XCTAssertEqual(start.derived.menu.badge, "1")
    }

    func testRowStayingInItsBucketUpdatesItsOwnCopy() {
        let renamed = assertMatchesSnapshot(busy, replacing: 4,
                                            with: row("e", agent: "w3", approvals: 3, title: "Renamed"))
        XCTAssertEqual(renamed.derived.needsYou.first?.title, "Renamed")
        XCTAssertEqual(renamed.derived.menu.items.first?.subtitle, "3 pending approvals")
        let coordinator = assertMatchesSnapshot(busy, replacing: 6,
                                                with: row("g", "AWAITING_INPUT", agent: "w4", project: "p1",
                                                          lastTurnAt: "2026-10-05T11:00:00Z"))
        XCTAssertEqual(coordinator.derived.activity?.coordinatorPulses[PublicID.storageKey("p1")],
                       ProjectCoordinatorPulse(working: false, lastTurnAt: "2026-10-05T11:00:00Z"))
        assertMatchesSnapshot(busy, replacing: 3, with: row("d", "RUNNING", agent: "w2"))
        assertMatchesSnapshot(busy, replacing: 0, with: row("a", agent: "w1", ownerItem: true))
        assertMatchesSnapshot(busy, replacing: 0, with: row("a", "AWAITING_INPUT", engineTurn: true))
    }

    func testMovingWorkspaceMovesItsCounts() {
        let moved = assertMatchesSnapshot(busy, replacing: 4, with: row("e", agent: "w9", approvals: 1))
        XCTAssertEqual(moved.derived.agentNeedsYou, ["w9": 1])
        assertMatchesSnapshot(busy, replacing: 1, with: row("b", agent: "w9"))
        assertMatchesSnapshot(busy, replacing: 5, with: row("f", "AWAITING_INPUT", agent: nil, bg: 1, bgJobs: 1))
    }

    /// Every pair of row shapes, at every position of a list that has the others beside it.
    func testSeededSweepMatchesTheFullSnapshot() {
        let shapes: [(String) -> Session] = [
            { self.row($0) },
            { self.row($0, "AWAITING_INPUT") },
            { self.row($0, "PENDING", agent: "w2") },
            { self.row($0, approvals: 1) },
            { self.row($0, "AWAITING_INPUT", approvals: 1, waiting: "START_REQUEST") },
            { self.row($0, "AWAITING_INPUT", agent: "w2", bg: 2, bgJobs: 1) },
            { self.row($0, "AWAITING_INPUT", bg: 1, bgJobs: 0) },
            { self.row($0, "SUCCEEDED") },
            { self.row($0, "FAILED", retryAt: "2026-10-06T00:00:00Z") },
            { self.row($0, "FAILED") },
            { self.row($0, agent: "w3", project: "p1", lastTurnAt: "2026-10-05T09:00:00Z") },
            { self.row($0, "AWAITING_INPUT", agent: "w3", project: "p1", lastTurnAt: "2026-10-05T12:00:00Z") },
            { self.row($0, "AWAITING_INPUT", agent: nil, ownerItem: true) },
        ]
        var seed: UInt64 = 0x5eed
        func next(_ n: Int) -> Int {
            seed = seed &* 6364136223846793005 &+ 1442695040888963407
            return Int((seed >> 33) % UInt64(n))
        }
        for _ in 0..<40 {
            let list = (0..<12).map { shapes[next(shapes.count)]("s\($0)") }
            for index in list.indices {
                for shape in shapes {
                    assertMatchesSnapshot(list, replacing: index, with: shape("s\(index)"),
                                          focused: next(4) == 0 ? "s\(index)" : nil)
                }
            }
        }
    }

    /// A poll that changed several rows in place, applied as one row after another in list order,
    /// leaves what the whole new list derives, and alerts as the whole-list diff does.
    func testSeveralRowsInPlaceMatchTheFullSnapshot() {
        let list = busy
        var next = list
        next[0] = row("a", "SUCCEEDED")
        next[2] = row("c", agent: "w2", approvals: 1, title: "Ask")
        next[4] = row("e", agent: "w3")
        next[5] = row("f", "AWAITING_INPUT", agent: "w3")
        guard let changes = OpenRowChange.replacements(of: ["a", "c", "e", "f", "g"], in: next, over: list)
        else { return XCTFail("rows changed in place") }
        XCTAssertFalse(changes.reordered)
        XCTAssertEqual(changes.changes.map(\.index), [0, 2, 4, 5], "g reads the same and is left out")
        var held = list
        var derived = OpenListDerived(list)
        var events: [NotificationEvent] = []
        for change in changes.changes {
            let old = held[change.index]
            held[change.index] = change.row
            events += SessionDelta.diff(previous: [old], current: [change.row])
            derived.replace(old, with: change.row, in: held)
        }
        XCTAssertEqual(held, next)
        XCTAssertEqual(derived, OpenListDerived(next))
        XCTAssertEqual(events, SessionDelta.diff(previous: list, current: next))
        XCTAssertEqual(events.count, 2)
    }

    /// The server's order moves whenever a session takes a turn: the rows that changed are applied
    /// where they were, then the order is taken, and the result is the new list's in every respect.
    func testChangedRowsInANewOrderMatchTheFullSnapshot() {
        let list = busy
        var next = list
        next[1] = row("b", agent: "w1", approvals: 1)
        next[3] = row("d", agent: "w2")
        next[6] = row("g", agent: "w4", project: "p1", lastTurnAt: "2026-10-05T12:00:00Z")
        next = [next[6], next[3], next[1], next[0], next[2], next[4], next[5]]
        guard let poll = OpenRowChange.replacements(of: ["b", "d", "g"], in: next, over: list)
        else { return XCTFail("the same sessions in another order") }
        XCTAssertTrue(poll.reordered)
        XCTAssertEqual(poll.changes.map(\.index), [6, 3, 1], "where the held list has them, in the new order")
        var held = list
        var derived = OpenListDerived(list)
        var events: [NotificationEvent] = []
        for change in poll.changes {
            let old = held[change.index]
            held[change.index] = change.row
            events += SessionDelta.diff(previous: [old], current: [change.row])
            derived.replace(old, with: change.row, in: held)
        }
        derived.reorder(next)
        XCTAssertEqual(Set(held.map(\.id)), Set(next.map(\.id)))
        XCTAssertEqual(held.sorted { $0.id < $1.id }, next.sorted { $0.id < $1.id })
        XCTAssertEqual(derived, OpenListDerived(next))
        XCTAssertEqual(events, SessionDelta.diff(previous: list, current: next))
        XCTAssertEqual(derived.menu.items.first?.id, "b", "the menu follows the new order")
    }

    func testAListOfOtherSessionsIsAdoptedWhole() {
        let list = busy
        XCTAssertNil(OpenRowChange.replacements(of: ["a"], in: Array(list.dropFirst()), over: list))
        XCTAssertNil(OpenRowChange.replacements(of: [], in: Array(list.dropFirst()) + [row("new")], over: list))
        XCTAssertNil(OpenRowChange.replacements(of: [], in: [list[1]] + list.dropFirst(), over: list),
                     "a session twice")
        XCTAssertNil(OpenRowChange.replacements(of: ["zz"], in: list, over: list))
        XCTAssertEqual(OpenRowChange.replacements(of: [], in: list, over: list)?.changes.count, 0)
        XCTAssertEqual(OpenRowChange.replacements(of: [], in: list.reversed(), over: list)?.reordered, true)
    }

    // MARK: which events take the one-row path

    func testSummaryLeavingOpenOrEndingTheRunNeedsTheSnapshot() {
        let list = busy
        XCTAssertEqual(OpenRowChange.merging(summary(
            #"{"id":"a","status":"AWAITING_INPUT","pendingApprovals":0,"lifecycleState":"COMPLETED"}"#),
            into: list), .needsSnapshot)
        XCTAssertEqual(OpenRowChange.merging(summary(
            #"{"id":"a","status":"SUCCEEDED","pendingApprovals":0}"#), into: list), .needsSnapshot)
        XCTAssertEqual(OpenRowChange.merging(summary(
            #"{"id":"new","status":"RUNNING","pendingApprovals":0}"#), into: list), .needsSnapshot)
        // Leaving Open is then the fetched list without the row, which the full diff announces.
        XCTAssertEqual(SessionDelta.diff(previous: list, current: Array(list.dropFirst())),
                       [.finished(sessionID: "a", title: "a", status: nil)])
    }

    func testSummaryAndApprovalEventsReplaceOneRow() {
        let list = busy
        // A summary that says only what the row already shows changes nothing.
        let same = summary(#"{"id":"a","title":"a","status":"RUNNING","pendingApprovals":0,"agentId":"w1"}"#)
        var settled = list
        if case .replace(let i, let row) = OpenRowChange.merging(same, into: list) { settled[i] = row }
        XCTAssertEqual(OpenRowChange.merging(same, into: settled), .unchanged)
        guard case .replace(let index, let merged) = OpenRowChange.merging(summary(
            #"{"id":"c","title":"c","status":"RUNNING","pendingApprovals":0,"agentId":"w2"}"#),
            into: list) else { return XCTFail("a status change replaces the row") }
        XCTAssertEqual(index, 2)
        XCTAssertEqual(merged.effectiveRunStatus, .running)
        assertMatchesSnapshot(list, replacing: index, with: merged)

        XCTAssertEqual(OpenRowChange.settingPendingApprovals(sessionID: "e", pending: 1, waitingKind: nil,
                                                             in: list), .unchanged)
        XCTAssertEqual(OpenRowChange.settingPendingApprovals(sessionID: "zz", pending: 1, waitingKind: nil,
                                                             in: list), .needsSnapshot)
        guard case .replace(let i, let raised) = OpenRowChange.settingPendingApprovals(
            sessionID: "b", pending: 1, waitingKind: nil, in: list)
        else { return XCTFail("a new count replaces the row") }
        XCTAssertEqual(assertMatchesSnapshot(list, replacing: i, with: raised).events,
                       [.needsApproval(sessionID: "b", title: "b", count: 1)])
    }
}
