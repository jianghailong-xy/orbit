import Foundation
import XCTest
@testable import OrbitKit

/// The Watching card and the Tasks card split a session's watches between them: a wait on tasks is an
/// eye on those tasks' rows, and only a wait on something else (a session) keeps a Watching card. The
/// merge itself is held to the browser's by `SessionCreatedTasksCopyParityTests`' card cases.
final class SessionTaskCardTests: XCTestCase {
    private typealias F = WatchFixture
    private let now = WatchFixture.now

    private func summary(_ watches: [Watch]) throws -> WatchSessionSummary {
        try XCTUnwrap(WatchSessionSummary(sessionID: "S1", watches: watches))
    }

    func testAWaitOnTasksLeavesTheWatchingCardToWaitsOnSessions() throws {
        let tasks = F.watch(id: "W1", targets: F.tasks(2))
        let sessions = F.watch(id: "W2", predicate: F.all("SESSION_TURN_SETTLED"),
                               targets: [F.target("S9", kind: "SESSION")])
        XCTAssertNil(try summary([tasks]).beyondTasks, "only tasks: no Watching card")
        XCTAssertEqual(try summary([tasks, sessions]).beyondTasks?.watches.map(\.id), ["W2"])
        // A wait on a task and a session together is the Watching card's: the session is only there.
        let mixed = F.watch(id: "W3", targets: [F.target("T1"), F.target("S9", kind: "SESSION")])
        XCTAssertEqual(try summary([mixed]).beyondTasks?.watches.map(\.id), ["W3"])
    }

    func testEveryLiveTaskTargetIsWatchedNamedAndStaleWithItsWatch() throws {
        let fresh = F.watch(id: "W1", targets: [F.target("T1"), F.target("T2", state: "GONE"),
                                                F.target("S9", kind: "SESSION")])
        let unchecked = F.watch(id: "W2", targets: [F.target("T3")], lastEvaluatedAt: F.ago(12 * 60))
        let watched = try summary([fresh, unchecked]).watchedTasks(now: now) { $0.targetResourceId == "T1" ? "First" : nil }
        XCTAssertEqual(watched.map(\.id), ["T1", "T3"], "a deleted target and a session are not task rows")
        XCTAssertEqual(watched.map(\.title), ["First", "Task T3"])
        XCTAssertEqual(watched.map(\.stale), [false, true])
    }

    func testTheTasksCardSaysWhenATaskOnlyWaitGoesUnchecked() throws {
        let unchecked = F.watch(id: "W1", targets: [F.target("T1")], lastEvaluatedAt: F.ago(12 * 60))
        let sessions = F.watch(id: "W2", predicate: F.all("SESSION_TURN_SETTLED"),
                               targets: [F.target("S9", kind: "SESSION")], lastEvaluatedAt: F.ago(12 * 60))
        // The session wait's reminder is the Watching card's to say.
        XCTAssertEqual(try summary([unchecked, sessions]).taskStaleLines(now: now),
                       ["Not checked for 12m — the resume may be late."])
        let fresh = F.watch(id: "W3", targets: [F.target("T1")])
        XCTAssertEqual(try summary([fresh]).taskStaleLines(now: now), [])
    }

    /// A watch the Watching card keeps for a session that runs no task lists a task's run session in
    /// it as that task, once — by the task's title and pill, opening the task — as its line counts it.
    func testAWatchingCardListsARunSessionAsItsTask() throws {
        var child = F.target("S9", kind: "SESSION")
        child["targetTitle"] = "Deploy main"
        child["targetTask"] = NSNull()
        var run = F.target("S1", kind: "SESSION")
        run["targetTitle"] = "Task: Ship it"
        run["targetStatus"] = ["status": "AWAITING_INPUT", "running": false, "queued": false]
        run["targetTask"] = ["id": "T1", "title": "Ship it",
                             "status": ["status": "IN_PROGRESS", "running": false, "queued": false]]
        var task = F.target("T1")
        task["targetTitle"] = "Ship it"
        let mixed = F.watch(id: "W1", predicate: ["kind": "ANY_OF", "operands": [F.all("SESSION_TURN_SETTLED"),
                                                                                   F.all("TASK_TERMINAL")]],
                            targets: [child, run, task])
        let watching = try XCTUnwrap(try summary([mixed]).beyondTasks, "the child keeps the Watching card")
        let listed = WatchProjection.stripTargets(of: watching.watches[0])
        XCTAssertEqual(listed.map(\.targetResourceId), ["S9", "T1"])
        XCTAssertEqual(listed.map(\.targetKind), [.session, .task])
        XCTAssertEqual(listed[1].targetTitle, "Ship it")
        XCTAssertNotNil(WatchProjection.stripPill(listed[1]), "the task's own pill")
        XCTAssertNil(WatchProjection.stripGlyph(listed[1]), "not its run session's glyph")
        // The line counts the same two: a session, and a task that is not done while its run waits.
        XCTAssertEqual(watching.lineTargetWord, "all 2 targets")
        XCTAssertEqual(watching.lineParts.map(\.text), ["0/2 done"])
    }

    func testOneTaskIsNamedAndTheEyeCountsTheWatchedRows() throws {
        let row = SessionCreatedTaskRow(id: "T1", title: "Only", status: "OPEN", running: true, queued: false,
                                        createdAt: "2026-09-14T09:00:00Z", projectId: nil, replaces: nil)
        let created = SessionCreatedTasks(total: 1, running: 1, failed: 0, done: 0, items: [row], projects: [])
        let watched = [SessionWatchedTask(id: "T1", title: "Only", standing: nil, stale: false)]
        let card = try XCTUnwrap(SessionTaskCard(created: created, watched: watched))
        XCTAssertEqual(card.single?.id, "T1")
        XCTAssertEqual(card.single?.watched, true)
        XCTAssertEqual(card.single?.pill, row.pill, "the created row's own pill, not the watch's reading")
        XCTAssertEqual(card.watching, 1)
        XCTAssertNil(SessionTaskCard(created: nil, watched: []), "nothing created or watched: no card")
    }
}
