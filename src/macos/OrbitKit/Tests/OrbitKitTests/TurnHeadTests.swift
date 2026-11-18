import Foundation
import XCTest
@testable import OrbitKit

/// The head row over each turn's output — "Worked for …" once it ended, "Working for …" while it
/// runs (web parity: `TurnHead` in Transcript.tsx).
final class TurnHeadTests: XCTestCase {
    private func user(_ seq: Int, _ ts: String, turn: String, text: String = "hi", steer: Bool = false,
                      parent: String? = nil) -> RunEvent {
        var payload: [String: JSONValue] = ["text": .string(text)]
        if steer { payload["steer"] = .bool(true) }
        if let parent { payload["parentToolUseId"] = .string(parent) }
        return RunEvent(seq: seq, type: .user, ts: ts, turnId: turn, payload: .object(payload))
    }

    private func reply(_ seq: Int, _ ts: String, _ text: String = "ok") -> RunEvent {
        RunEvent(seq: seq, type: .assistant, ts: ts, payload: .object(["text": .string(text)]))
    }

    private func end(_ seq: Int, _ ts: String, subtype: String = "success") -> RunEvent {
        RunEvent(seq: seq, type: .turnEnd, ts: ts, payload: .object(["subtype": .string(subtype)]))
    }

    private func heads(_ r: TranscriptReducer, running: Bool = false, now: Date = Date()) -> [String] {
        TranscriptRows.build(state: r.state, statusCards: [], canPageOlder: false,
                             showWorkingIndicator: false, running: running)
            .compactMap { row -> String? in
                guard case .turnHead(let line) = row else { return nil }
                return TurnHead.label(line, running: running, now: now)
            }
    }

    func testEndedTurnSaysHowLongItWorkedUnderItsMessage() {
        var r = TranscriptReducer()
        r.apply(user(1, "2026-11-11T10:00:00Z", turn: "t1"))
        r.apply(reply(2, "2026-11-11T10:00:30Z"))
        r.apply(end(3, "2026-11-11T10:01:04Z"))
        let rows = TranscriptRows.build(state: r.state, statusCards: [], canPageOlder: false,
                                        showWorkingIndicator: false)
        guard rows.count >= 2, case .item(.user) = rows[0], case .turnHead(let line) = rows[1] else {
            return XCTFail("head row is not under the message: \(rows.map(\.id))")
        }
        XCTAssertEqual(TurnHead.label(line, running: false), "Worked for 1m 4s")
    }

    func testRunningTurnCountsUpAndNeverSaysZero() {
        var r = TranscriptReducer()
        r.apply(user(1, "2026-11-11T10:00:00Z", turn: "t1"))
        let start = ThinkingSummary.date("2026-11-11T10:00:00Z")!
        XCTAssertEqual(heads(r, running: true, now: start.addingTimeInterval(14)), ["Working for 14s"])
        XCTAssertEqual(heads(r, running: true, now: start), ["Working for 1s"])
        // Not running, and not ended: nothing to say.
        XCTAssertEqual(heads(r, running: false), [])
    }

    func testOnlyTheNewestOpenTurnTicks() {
        var r = TranscriptReducer()
        r.apply(user(1, "2026-11-11T10:00:00Z", turn: "t1"))     // its end never loaded
        r.apply(user(2, "2026-11-11T10:05:00Z", turn: "t2"))
        let now = ThinkingSummary.date("2026-11-11T10:05:09Z")!
        XCTAssertEqual(heads(r, running: true, now: now), ["Working for 9s"])
    }

    func testFailedTurnStillEnds() {
        var r = TranscriptReducer()
        r.apply(user(1, "2026-11-11T10:00:00Z", turn: "t1"))
        r.apply(end(2, "2026-11-11T10:00:00.400Z", subtype: "error_during_execution"))
        XCTAssertEqual(heads(r), ["Worked for 1s"])
    }

    func testSteerAndSubagentMessagesOpenNoTurn() {
        var r = TranscriptReducer()
        r.apply(user(1, "2026-11-11T10:00:00Z", turn: "t1"))
        r.apply(RunEvent(seq: 2, type: .toolUse, ts: "2026-11-11T10:00:01Z",
                         payload: .object(["id": .string("tu1"), "name": .string("Agent"),
                                           "input": .object([:])])))
        r.apply(user(3, "2026-11-11T10:00:02Z", turn: "t1", text: "sub", parent: "tu1"))
        r.apply(user(4, "2026-11-11T10:00:03Z", turn: "t2", text: "also", steer: true))
        r.apply(end(5, "2026-11-11T10:00:20Z"))
        XCTAssertEqual(heads(r), ["Worked for 20s"])
    }

    func testOptimisticSendTakesItsHeadFromTheEcho() {
        var r = TranscriptReducer()
        r.addOptimisticUser(clientTurnId: "c1", text: "hi")
        XCTAssertEqual(heads(r, running: true), [])
        r.setOptimisticTurnId(clientTurnId: "c1", turnId: "t1")
        r.apply(user(1, "2026-11-11T10:00:00Z", turn: "t1"))
        r.apply(end(2, "2026-11-11T10:00:07Z"))
        XCTAssertEqual(heads(r), ["Worked for 7s"])
    }

    func testOlderPageMeetsTheEndTheWindowAlreadyHas() {
        var r = TranscriptReducer()
        // The window opens mid-turn: the turn's end is loaded, its message is not.
        r.applyTailPage(EventPage(events: [
            reply(3, "2026-11-11T10:00:40Z"),
            end(4, "2026-11-11T10:00:45Z"),
            user(5, "2026-11-11T10:01:00Z", turn: "t2"),
            end(6, "2026-11-11T10:01:02Z"),
        ], hasMore: true))
        XCTAssertEqual(heads(r), ["Worked for 2s"])
        r.prependOlder(EventPage(events: [
            user(1, "2026-11-11T10:00:00Z", turn: "t1"),
            reply(2, "2026-11-11T10:00:10Z"),
        ], hasMore: false))
        XCTAssertEqual(heads(r), ["Worked for 45s", "Worked for 2s"])
    }

    func testSnapshotKeepsTheHead() throws {
        var r = TranscriptReducer()
        r.apply(user(1, "2026-11-11T10:00:00Z", turn: "t1"))
        r.apply(end(2, "2026-11-11T10:00:03Z"))
        let back = try JSONDecoder().decode(TranscriptReducer.self, from: JSONEncoder().encode(r))
        XCTAssertEqual(heads(back), ["Worked for 3s"])
    }
}
