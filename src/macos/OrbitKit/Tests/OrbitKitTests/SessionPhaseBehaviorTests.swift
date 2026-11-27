import Foundation
import XCTest
@testable import OrbitKit

final class SessionPhaseBehaviorTests: XCTestCase {
    private func session(_ fields: String, id: String = "s") throws -> Session {
        try JSONDecoder().decode(Session.self, from: Data("{\"id\":\"\(id)\",\(fields)}".utf8))
    }

    func testComposerChoosesResumeFromReleaseAndFallsBackToStatus() throws {
        let resumable = SessionCapabilities(canSend: true, canResume: true, canComplete: true, canRestore: false)
        let blocked = SessionCapabilities(canSend: false, canResume: false, canComplete: false, canRestore: false)
        let samples: [(String, Bool)] = [
            (#""status":"AWAITING_INPUT","released":true"#, true),
            (#""status":"FAILED","released":false"#, false),
            (#""status":"AWAITING_INPUT","runStatus":"FAILED""#, true),
            (#""status":"FAILED","runStatus":"AWAITING_INPUT""#, false),
        ]
        for (json, resume) in samples {
            let row = try session(json)
            XCTAssertEqual(ComposerLogic.shouldResume(status: row.effectiveRunStatus, released: row.released,
                                                      capabilities: resumable), resume, json)
            XCTAssertFalse(ComposerLogic.shouldResume(status: row.effectiveRunStatus, released: row.released,
                                                      capabilities: blocked), json)
        }
    }

    func testEndAndMoveWaitsForReleaseAndFallsBackToTerminalStatus() async throws {
        let cases = [
            [#""status":"FAILED","released":false"#, #""status":"AWAITING_INPUT","released":true"#],
            [#""status":"AWAITING_INPUT""#, #""status":"FAILED""#],
        ]
        for samples in cases {
            var rows = try samples.map { try session($0) }
            var steps: [String] = []
            let outcome = await SessionWorkspaceMove.run(
                endingFirst: true,
                end: { steps.append("end") },
                session: {
                    steps.append("read")
                    return rows.removeFirst()
                },
                move: { steps.append("move") },
                sleep: { _ in steps.append("wait") })
            XCTAssertEqual(outcome, .moved)
            XCTAssertEqual(steps, ["end", "read", "wait", "read", "move"])
        }
    }

    func testFinishedAlertsUseReleaseAndOutcomeWithoutAnnouncingRequestedEnds() throws {
        let held = try session(#""status":"FAILED","released":false"#)
        let failed = try session(#""status":"AWAITING_INPUT","released":true,"lastTurnOutcome":"FAILED""#)
        let retrying = try session(#""status":"FAILED","released":true,"lastTurnOutcome":"FAILED","retryAt":"2099-01-01""#)
        let requested = try session(#""status":"FAILED","released":true,"lastTurnOutcome":"FAILED","endReason":"ended""#)
        let finished = try session(#""status":"FAILED","released":true,"workFinished":true"#)
        let plain = try session(#""status":"SUCCEEDED","released":true"#)
        let legacyHeld = try session(#""status":"RUNNING""#)
        let legacyEnded = try session(#""status":"CANCELLED","endReason":"ended""#)
        let failedEvent = NotificationEvent.finished(sessionID: "s", title: "Session", status: .failed)
        let finishedEvent = NotificationEvent.finished(sessionID: "s", title: "Session", status: .succeeded)
        XCTAssertEqual(SessionDelta.diff(previous: [held], current: [failed]), [failedEvent])
        XCTAssertEqual(Notifications.content(for: failedEvent).title, "Session failed")
        XCTAssertTrue(SessionDelta.diff(previous: [held], current: [retrying]).isEmpty)
        XCTAssertEqual(SessionDelta.diff(previous: [retrying], current: [failed]), [failedEvent])
        XCTAssertTrue(SessionDelta.diff(previous: [held], current: [requested]).isEmpty)
        XCTAssertTrue(SessionDelta.diff(previous: [held], current: [plain]).isEmpty)
        XCTAssertEqual(SessionDelta.diff(previous: [held], current: [finished]), [finishedEvent])
        XCTAssertEqual(Notifications.content(for: finishedEvent).title, "Session finished")
        XCTAssertTrue(SessionDelta.diff(previous: [held], current: []).isEmpty)
        XCTAssertEqual(SessionDelta.diff(previous: [held], current: [], finishedDepartures: ["s"]), [finishedEvent])
        XCTAssertEqual(SessionDelta.diff(previous: [legacyHeld], current: [legacyEnded]),
                       [.finished(sessionID: "s", title: "Session", status: .cancelled)])
        XCTAssertEqual(SessionDelta.diff(previous: [legacyHeld], current: []),
                       [.finished(sessionID: "s", title: "Session", status: nil)])
    }

    func testMenuBarCountsRunningPhaseIncludingBackgroundWorkAndKeepsLegacyCounts() throws {
        let job = try session(#""status":"AWAITING_INPUT","phase":"RUNNING","runningBgCount":1"#, id: "job")
        let idle = try session(#""status":"RUNNING","phase":"IDLE""#, id: "idle")
        let pending = try session(#""status":"RUNNING","phase":"PENDING""#, id: "pending")
        let before = try session(#""status":"AWAITING_INPUT","phase":"IDLE","pendingApprovals":1"#, id: "approval")
        let after = try session(#""status":"AWAITING_INPUT","phase":"RUNNING","pendingApprovals":1"#, id: "approval")
        let legacy = try session(#""status":"AWAITING_INPUT""#, id: "legacy")
        let initial = [job, idle, pending, before, legacy]
        let updated = [job, idle, pending, after, legacy]
        var derived = OpenListDerived(initial)
        XCTAssertEqual(derived.menu.running, 2)
        XCTAssertEqual(derived.menu.queued, 1)
        XCTAssertEqual(derived.menu.needsYou, 1)
        derived.replace(before, with: after, in: updated)
        XCTAssertEqual(derived.menu.running, 3)
        XCTAssertEqual(derived.menu, MenuBar.summary(from: updated))
        XCTAssertNotEqual(SessionStatusGlyph.make(for: job).shape, .spinner)
        XCTAssertEqual(SessionLine.make(for: job, live: true).tone, .background)
    }

    func testGuestPollingUsesPhaseAndReleaseAndKeepsTheLegacyCadence() throws {
        let cases: [(String, TimeInterval?)] = [
            (#""runStatus":"AWAITING_INPUT","phase":"RUNNING","released":false"#, 4),
            (#""runStatus":"AWAITING_INPUT","phase":"PENDING","released":false"#, 4),
            // An armed retry waiting on its wake, hours out on a spent quota: the waiting pace.
            (#""runStatus":"AWAITING_INPUT","phase":"PENDING","released":false,"waitingOn":"WAKE""#, 30),
            (#""runStatus":"RUNNING","phase":"IDLE","released":false"#, 30),
            (#""runStatus":"AWAITING_INPUT","phase":"IDLE","released":true"#, nil),
            (#""runStatus":"RUNNING""#, 4),
            (#""runStatus":"AWAITING_INPUT""#, 30),
            (#""runStatus":"FAILED""#, nil),
        ]
        for (json, delay) in cases {
            let data = Data("{\(json)}".utf8)
            let root = try JSONDecoder().decode(GuestSession.self, from: data)
            let following = try JSONDecoder().decode(GuestSessionNow.self, from: data)
            let head = try JSONDecoder().decode(GuestSessionHead.self, from: data)
            XCTAssertEqual(GuestFollow.delay(root.state, moved: false), delay, json)
            XCTAssertEqual(GuestFollow.delay(following.state, moved: false), delay, json)
            XCTAssertEqual(GuestFollow.delay(head.state, moved: false), delay, json)
            XCTAssertEqual(GuestFollow.delay(root.state, moved: true), 4, json)
        }
    }

    func testApprovedHeaderAndListWordsAndGlyphs() throws {
        let cases: [(String, String, String, SessionStatusGlyph.Tone)] = [
            (#""status":"SUCCEEDED","released":true,"endReason":"task_done""#,
             "Finished", "checkmark.circle.fill", .success),
            (#""status":"PENDING","phase":"PENDING","waitingOn":"HOLD""#,
             "On hold", "clock", .neutral),
            (#""status":"FAILED","released":true,"endReason":"ended","lastTurnOutcome":"FAILED""#,
             "Ended", "checkmark.circle", .neutral),
            (#""status":"SUCCEEDED","released":true"#,
             "Ended", "checkmark.circle", .neutral),
            (#""status":"AWAITING_INPUT","released":false,"endReason":"ended","lastTurnOutcome":"INTERRUPTED""#,
             "Interrupted", "minus.circle", .neutral),
            (#""status":"INTERRUPTED","released":true,"endReason":"ended","lastTurnOutcome":"INTERRUPTED""#,
             "Ended", "checkmark.circle", .neutral),
            (#""status":"FAILED","released":true,"workFinished":true"#,
             "Finished", "checkmark.circle.fill", .success),
            (#""status":"SUCCEEDED","released":true,"workFinished":false,"endReason":"task_done""#,
             "Ended", "checkmark.circle", .neutral),
            (#""status":"SUCCEEDED","endReason":"task_done""#,
             "Succeeded", "checkmark.circle.fill", .success),
            (#""status":"PENDING""#, "Queued", "clock", .neutral),
        ]
        for (json, word, symbol, tone) in cases {
            let row = try session(json)
            XCTAssertEqual(SessionHeader.statusWord(for: row), word, json)
            XCTAssertEqual(SessionLine.make(for: row, live: true).text, word, json)
            XCTAssertEqual(SessionStatusGlyph.make(for: row).shape, .symbol(symbol), json)
            XCTAssertEqual(SessionStatusGlyph.make(for: row).tone, tone, json)
        }
        let disk = try session(#""status":"PENDING","waitingOn":"HOLD","queuedReason":"disk_below_floor""#)
        XCTAssertEqual(SessionHeader.statusWord(for: disk), QueuedDiskLow.title)
        XCTAssertEqual(SessionLine.make(for: disk, live: true).text, QueuedDiskLow.title)
    }

    func testGuestTerminalWordingUsesNewFactsAsTheyBecomeAvailable() throws {
        let decoder = JSONDecoder()
        let old = #"{"runStatus":"FAILED","released":true,"lastTurnOutcome":"FAILED"}"#
        let ended = #"{"runStatus":"FAILED","released":true,"lastTurnOutcome":"FAILED","endReason":"ended"}"#
        let finished = #"{"runStatus":"FAILED","released":true,"workFinished":true}"#
        let failed = #"{"runStatus":"AWAITING_INPUT","released":true,"lastTurnOutcome":"FAILED","workFinished":false}"#
        for (json, word, tone) in [(old, "Failed", GuestTone.failed), (ended, "Ended", .cancelled),
                                   (finished, "Finished", .done), (failed, "Failed", .failed)] {
            let state = try decoder.decode(GuestSessionHead.self, from: Data(json.utf8)).state
            XCTAssertEqual(state.word, word, json)
            XCTAssertEqual(state.tone, tone, json)
        }
    }

    func testRealtimeSummaryUpdatesPhaseAndClearsAnExplicitEndReason() throws {
        let row = try session(#""status":"AWAITING_INPUT","endReason":"ended","waitingOn":"HOLD","lastTurnOutcome":"INTERRUPTED""#)
        let json = #"""
        {"id":"s","status":"AWAITING_INPUT","pendingApprovals":0,"phase":"RUNNING",
         "released":false,"workFinished":false,"endReason":null,"waitingOn":null,"lastTurnOutcome":null}
        """#
        let summary = try JSONDecoder().decode(ControlSessionSummary.self, from: Data(json.utf8))
        let refreshed = row.applying(summary)
        XCTAssertEqual(refreshed.phase, .running)
        XCTAssertEqual(refreshed.released, false)
        XCTAssertEqual(refreshed.workFinished, false)
        XCTAssertNil(refreshed.endReason)
        XCTAssertNil(refreshed.waitingOn)
        XCTAssertNil(refreshed.lastTurnOutcome)
        XCTAssertEqual(refreshed.settingTitle("Rename").phase, .running)
    }
}
