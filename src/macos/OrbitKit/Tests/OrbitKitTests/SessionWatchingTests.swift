import Foundation
import XCTest
@testable import OrbitKit

/// The screenshot this work started from: a session monitoring other sessions and tasks read
/// "Background process running · 3m ago" — a polling shell, stamped with its last turn. Waiting on a
/// watch instead, the same parked session reads as Watching, with the progress and the evaluator's
/// last look, and the Background process wording stays with real shells.
final class SessionWatchingTests: XCTestCase {
    private typealias F = WatchFixture
    private let now = WatchFixture.now

    private func session(_ runState: SessionRunState, id: String = "S1", pendingApprovals: Int? = nil,
                         runningBgCount: Int? = nil, engineTurnActive: Bool? = nil,
                         lastTurnAt: String? = nil) -> Session {
        Session(id: id, title: "Coordinator", status: .awaitingInput, runState: runState,
                agentId: nil, assignedRunnerId: nil, pendingApprovals: pendingApprovals, branch: nil,
                updatedAt: nil, runningBgCount: runningBgCount, engineTurnActive: engineTurnActive,
                lastTurnAt: lastTurnAt)
    }

    /// Seven tasks, three of them finished, looked at 20 seconds ago, resuming S1.
    private var sevenTasks: [Watch] {
        [F.watch(observer: "S1", targets: F.tasks(7, met: 3), lastEvaluatedAt: F.ago(20))]
    }

    private func summary(_ watches: [Watch], for id: String = "S1") -> WatchSessionSummary? {
        WatchSessionSummary(sessionID: id, watches: watches)
    }

    func testTheScreenshotSessionReadsAsWatchingNotAsABackgroundProcess() throws {
        // It still has a shell up and last had a turn three minutes ago: what the old header stamped.
        let s = session(.awaitingInput, runningBgCount: 1, lastTurnAt: F.ago(180))
        XCTAssertEqual(SessionHeader.subtitle(for: s, now: now), "Background process running · Open · 3m ago")

        let watching = try XCTUnwrap(summary(sevenTasks))
        XCTAssertEqual(SessionHeader.statusWord(for: s, watching: watching, now: now), "Watching 7 targets")
        XCTAssertEqual(SessionHeader.subtitle(for: s, watching: watching, now: now),
                       "Watching 7 targets · Open · 3 of 7 finished · Last evaluated just now")
        XCTAssertEqual(SessionLine.make(for: s, live: true, watching: watching),
                       SessionLine(text: "Watching 7 targets · 3 of 7 finished", tone: .watching))
        XCTAssertEqual(SessionStatusGlyph.make(for: s, watching: watching, now: now),
                       SessionStatusGlyph(shape: .symbol("eye"), tone: .neutral, label: "Watching 7 targets"))
    }

    func testWorkAndAnyoneWaitingOnYouOutrankTheWatch() throws {
        let watching = try XCTUnwrap(summary(sevenTasks))
        XCTAssertEqual(SessionHeader.statusWord(for: session(.running), watching: watching), "Running")
        XCTAssertEqual(SessionHeader.statusWord(for: session(.queued), watching: watching), "Queued")
        // The wake a watch queued is running on the parked session: that's the agent working.
        XCTAssertEqual(SessionHeader.statusWord(for: session(.awaitingInput, engineTurnActive: true),
                                                watching: watching), "Running")
        // Parked with a question for you: the watch doesn't hide it.
        let asking = session(.awaitingInput, pendingApprovals: 1)
        XCTAssertEqual(SessionHeader.statusWord(for: asking, watching: watching), "Waiting for your reply")
        XCTAssertEqual(SessionLine.make(for: asking, live: true, watching: watching).tone, .approval)
        XCTAssertNotEqual(SessionStatusGlyph.make(for: asking, watching: watching).label, "Watching 7 targets")
        // A Trash row is static.
        XCTAssertNotEqual(SessionLine.make(for: session(.awaitingInput), live: false, watching: watching).tone,
                          .watching)
    }

    func testAPausedWatchSaysSoAndHasNoLookToReport() throws {
        let watching = try XCTUnwrap(summary([F.watch(state: "PAUSED", targets: F.tasks(7, met: 3))]))
        let s = session(.awaitingInput)
        XCTAssertEqual(SessionHeader.statusWord(for: s, watching: watching), "Watch paused")
        XCTAssertEqual(SessionHeader.subtitle(for: s, watching: watching, now: now),
                       "Watch paused · Open · 3 of 7 finished")
    }

    func testSeveralWatchesCountEachTargetOnceAndReportTheStalestLook() throws {
        let first = F.watch(id: "W1", targets: [F.target("T1"), F.target("T2"), F.target("G", state: "GONE")],
                            lastEvaluatedAt: F.ago(20))
        let second = F.watch(id: "W2", targets: [F.target("T2"), F.target("T3")], lastEvaluatedAt: F.ago(600))
        let watching = try XCTUnwrap(summary([first, second]))
        XCTAssertEqual(watching.word, "Watching 3 targets")
        XCTAssertEqual(watching.progress, "2 watches")
        XCTAssertEqual(watching.lastEvaluated(now: now), "Last evaluated 10m ago")
        XCTAssertEqual(summary([F.watch(id: "W4", state: "PAUSED"), F.watch(id: "W5", state: "PAUSED")])?.word,
                       "2 watches paused")
    }

    func testTheStripsOneLineProjectsTheLoneTargetOrTheCount() throws {
        // One watch over one target that still exists names it, and its own deadline needs no qualifier.
        let lone = try XCTUnwrap(summary([
            F.watch(id: "W1", targets: [F.target("T0")], expiresAt: F.ago(-3 * 3600)),
        ]))
        XCTAssertEqual(lone.lineTarget?.targetResourceId, "T0")
        XCTAssertEqual(lone.lineTargetCount, 1)
        XCTAssertEqual(lone.lineTime(now: now), "3h")
        // A deleted target is out of the set, in the single branch too.
        let gone = try XCTUnwrap(summary([
            F.watch(id: "W1", targets: [F.target("T0"), F.target("G", state: "GONE")]),
        ]))
        XCTAssertEqual(gone.lineTarget?.targetResourceId, "T0")
        // Anything else counts the distinct targets and prefixes the soonest deadline: T2 appears on
        // both watches and is counted once, G is gone, and 4h is W1's deadline, not W2's 6h.
        let several = try XCTUnwrap(summary([
            F.watch(id: "W1", targets: [F.target("T1"), F.target("T2")], expiresAt: F.ago(-4 * 3600)),
            F.watch(id: "W2", targets: [F.target("T2"), F.target("G", state: "GONE")],
                    expiresAt: F.ago(-6 * 3600)),
        ]))
        XCTAssertNil(several.lineTarget)
        XCTAssertEqual(several.lineTargetCount, 2)
        XCTAssertEqual(several.lineTime(now: now), "earliest 4h")
        // A deadline already reached reads "now", as the web's `left <= 0 ? 'now' : …` does.
        XCTAssertEqual(summary([F.watch(id: "W1", targets: [F.target("T0")], expiresAt: F.ago(5))])?
            .lineTime(now: now), "now")
        // Two watches over the same single target still read as a count: "one" is about the strip.
        XCTAssertNil(summary([
            F.watch(id: "W1", targets: [F.target("T1")]),
            F.watch(id: "W2", targets: [F.target("T1")]),
        ])?.lineTarget)
    }

    func testOnlyLiveWatchesThatResumeTheSessionCount() throws {
        let sessionID = PublicID.newToken()
        let watches = [
            F.watch(id: "ended", state: "MATCHED", observer: sessionID),
            F.watch(id: "notify", action: "NOTIFY_USER", observer: nil),
            F.watch(id: "other", observer: PublicID.newToken()),
            // The same session, spelled as its UUID.
            F.watch(id: "mine", observer: try XCTUnwrap(PublicID.toUUID(sessionID))),
        ]
        XCTAssertEqual(WatchIndex.observing(sessionID: sessionID, in: watches).map(\.id), ["mine"])
        XCTAssertNil(summary(Array(watches.prefix(2)), for: sessionID))
        let index = WatchIndex.summariesByObserver(watches)
        XCTAssertEqual(index[PublicID.storageKey(sessionID)]?.watches.map(\.id), ["mine"])
        XCTAssertEqual(index.count, 2)   // "mine" and "other"
    }
}
