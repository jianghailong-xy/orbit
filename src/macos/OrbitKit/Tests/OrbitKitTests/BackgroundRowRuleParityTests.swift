import Foundation
import XCTest
@testable import OrbitKit

/// The folded Background row draws exactly what `src/shared/src/background-row.fixture.json` says for
/// every case, as the web's and Android's tests of the same file do. A missing fixture is a failure,
/// never a skip.
final class BackgroundRowRuleParityTests: XCTestCase {
    private static let fixturePath = "src/shared/src/background-row.fixture.json"

    private struct Fixture: Decodable {
        struct Case: Decodable {
            let `case`: String
            let covers: [String]
            let list: [BackgroundRowRule.Input]
            let lastUserMessageAt: String?
            let lastAgentTurnStartedAt: String?
            let sessionLive: Bool
            let events: [RunEvent]?
        }
        let rules: [String: String]
        let rotation: [String: Int]
        let cases: [Case]
    }

    private func fixtureData() throws -> Data {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(Self.fixturePath)
            if FileManager.default.fileExists(atPath: candidate.path) { return try Data(contentsOf: candidate) }
            dir = dir.deletingLastPathComponent()
        }
        XCTFail("\(Self.fixturePath) was not found above this test file")
        throw CocoaError(.fileNoSuchFile)
    }

    /// The row in the fixture's own JSON shape, so it compares with `expect` key for key.
    private func json(_ row: BackgroundRowRule.Row?) -> NSDictionary {
        guard let row else { return ["hidden": true] }
        func item(_ i: BackgroundRowRule.Item) -> [String: Any] {
            ["id": i.id, "name": i.name, "truncate": i.truncate.rawValue, "mark": i.mark.rawValue]
        }
        let name: [String: Any]
        switch row.name {
        case .one(let i): name = ["mode": "one", "item": item(i)]
        case .rotate(let items, let per, let change):
            name = ["mode": "rotate", "items": items.map(item), "perNameMs": per, "changeMs": change]
        }
        return [
            "hidden": false, "label": row.label, "name": name,
            "countParts": row.countParts.map { ["kind": $0.kind, "text": $0.text] },
            "countLine": row.countLine as Any? ?? NSNull(),
            "accessibilityLabel": row.accessibilityLabel,
        ] as NSDictionary
    }

    private func cutOff(_ c: Fixture.Case) -> String? {
        BackgroundRowRule.clearedAt(lastUserMessageAt: c.lastUserMessageAt, lastAgentTurnStartedAt: c.lastAgentTurnStartedAt)
    }

    func testEveryCaseDrawsWhatTheFixtureSays() throws {
        let data = try fixtureData()
        let fixture = try JSONDecoder().decode(Fixture.self, from: data)
        let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let expects = try XCTUnwrap(raw["cases"] as? [[String: Any]]).map { $0["expect"] as! NSDictionary }
        XCTAssertGreaterThan(fixture.cases.count, 0)
        for (c, expect) in zip(fixture.cases, expects) {
            // A case that carries its transcript is read through the reader, as every client must.
            if let events = c.events {
                var reducer = TranscriptReducer()
                for ev in events { reducer.apply(ev) }
                XCTAssertEqual(BackgroundRowRule.lastUserMessageAt(reducer.state.items), c.lastUserMessageAt, c.case)
                XCTAssertEqual(reducer.state.agentTurnStartedAt, c.lastAgentTurnStartedAt, c.case)
            }
            let row = BackgroundRowRule.row(c.list, clearedAt: cutOff(c), sessionLive: c.sessionLive)
            XCTAssertEqual(json(row), expect, c.case)
        }
    }

    /// The folded pill's mark is there exactly when the row is (`FoldedBand.processes`), read from the
    /// tray's own processes in the native status words.
    func testTheFoldedMarkIsGoneExactlyWhenTheRowIs() throws {
        let data = try fixtureData()
        let fixture = try JSONDecoder().decode(Fixture.self, from: data)
        let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let expects = try XCTUnwrap(raw["cases"] as? [[String: Any]]).map { $0["expect"] as! [String: Any] }
        var hiddenCases = 0
        for (c, expect) in zip(fixture.cases, expects) {
            let procs = c.list.sorted { $0.startedSeq < $1.startedSeq }.map {
                BackgroundProc(id: $0.shellId, command: $0.command.isEmpty ? nil : $0.command,
                               description: $0.description, status: $0.status == "done" ? "completed" : $0.status,
                               outputTail: "", endedAt: $0.endedAt)
            }
            let hidden = expect["hidden"] as? Bool == true
            if hidden { hiddenCases += 1 }
            let mark = FoldedBand.processes(procs, clearedAt: cutOff(c), sessionLive: c.sessionLive)
            XCTAssertEqual(mark == nil, hidden, c.case)
            // The tray's own processes reach the same row as the fixture's list.
            let row = BackgroundRowRule.row(BackgroundRowRule.inputs(procs), clearedAt: cutOff(c),
                                            sessionLive: c.sessionLive)
            XCTAssertEqual(row == nil, hidden, c.case)
            XCTAssertEqual(row?.accessibilityLabel, expect["accessibilityLabel"] as? String, c.case)
        }
        XCTAssertGreaterThan(hiddenCases, 0, "the fixture no longer has a case that hides the row")
    }

    func testTheConstantsAreTheFixtures() throws {
        let fixture = try JSONDecoder().decode(Fixture.self, from: try fixtureData())
        XCTAssertEqual(fixture.rotation, ["perNameMs": BackgroundRowRule.rotatePerNameMs,
                                          "changeMs": BackgroundRowRule.rotateChangeMs])
        XCTAssertEqual(BackgroundRowRule.label, "Background")
        XCTAssertEqual(BackgroundRowRule.accessibilityPrefix, "Background processes, ")
        let covered = Set(fixture.cases.flatMap(\.covers))
        XCTAssertEqual(covered, Set(fixture.rules.keys))
    }

    /// The person's last message is the newest turn somebody typed: a wake Orbit opened clears nothing.
    func testTheLastUserMessageSkipsTurnsOrbitOpened() {
        func user(_ id: String, _ ts: String, orbit: Bool = false) -> TranscriptItem {
            var b = UserBubble(id: id, text: "hello", ts: ts, pending: false)
            b.authoredByOrbit = orbit
            return .user(b)
        }
        let items = [user("a", "2026-11-16T02:40:00.000Z"), user("b", "2026-11-16T02:50:00.000Z", orbit: true)]
        XCTAssertEqual(BackgroundRowRule.lastUserMessageAt(items), "2026-11-16T02:40:00.000Z")
        XCTAssertNil(BackgroundRowRule.lastUserMessageAt([]))
    }

    /// The cut-off is the later of the two; the agent's latest turn starts at its earliest event.
    func testTheCutOffIsTheLaterOfTheMessageAndTheTurn() {
        let a = "2026-11-16T02:40:00.000Z", b = "2026-11-16T02:46:00.000Z"
        XCTAssertEqual(BackgroundRowRule.clearedAt(lastUserMessageAt: a, lastAgentTurnStartedAt: b), b)
        XCTAssertEqual(BackgroundRowRule.clearedAt(lastUserMessageAt: b, lastAgentTurnStartedAt: a), b)
        XCTAssertEqual(BackgroundRowRule.clearedAt(lastUserMessageAt: a, lastAgentTurnStartedAt: nil), a)
        XCTAssertEqual(BackgroundRowRule.clearedAt(lastUserMessageAt: nil, lastAgentTurnStartedAt: b), b)
        XCTAssertNil(BackgroundRowRule.clearedAt(lastUserMessageAt: nil, lastAgentTurnStartedAt: nil))
        var reducer = TranscriptReducer()
        func ev(_ seq: Int, _ type: RunEventType, _ ts: String, _ turn: String) -> RunEvent {
            RunEvent(seq: seq, type: type, ts: ts, turnId: turn, payload: .object([:]))
        }
        reducer.apply(ev(1, .assistant, "2026-11-16T02:41:00.000Z", "t1"))
        reducer.apply(ev(2, .assistant, "2026-11-16T02:42:00.000Z", "t2"))
        reducer.apply(ev(3, .toolUse, "2026-11-16T02:43:00.000Z", "t2"))
        XCTAssertEqual(reducer.state.agentTurnStartedAt, "2026-11-16T02:42:00.000Z")
    }

    /// GET /sessions/:id/background's bg_run rows reach the tray as jobs, with when they ended.
    func testTheListDecodesTheJobKindAndItsEnd() throws {
        let body = """
        {"shellId":"bgj_1","toolUseId":"tu1","command":"npm test","status":"failed","kind":"job",
         "startedTs":"2026-11-16T02:30:00.000Z","endedAt":"2026-11-16T02:45:00.000Z"}
        """
        let proc = try JSONDecoder().decode(BgShellDTO.self, from: Data(body.utf8)).asBackgroundProc()
        XCTAssertEqual(proc.kind, "job")
        XCTAssertEqual(proc.endedAt, "2026-11-16T02:45:00.000Z")
        XCTAssertEqual(proc.status, "failed")
    }
}
