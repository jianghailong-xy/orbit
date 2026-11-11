import Foundation
import XCTest
@testable import OrbitKit

/// Turns Orbit opened fold, with the agent's answer, into one row each, and a run of them into one
/// group row that opens by task (web parity: `Transcript.orbitFold.test.tsx`,
/// `lib/orbitExchangeFold.test.ts`). What the reader said, the newest turn, and anything that went
/// wrong or asks the reader stay drawn as before.
final class OrbitExchangeFoldTests: XCTestCase {
    private static let b1 = "0195c0de-0000-7000-8000-000000000011"
    private static let b4 = "0195c0de-0000-7000-8000-000000000014"
    private static let b4b = "0195c0de-0000-7000-8000-000000000015"
    private static let b5 = "0195c0de-0000-7000-8000-000000000016"
    private static let watch = "0195c0de-0000-7000-8000-0000000000c3"
    private static let runOfB1 = "0195c0de-0000-7000-8000-0000000000a1"

    private var seq = 0
    private var turn = 0
    private var events: [String] = []

    private static func json(_ value: Any) -> String {
        String(decoding: try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }

    private func at(_ minute: Int) -> String {
        let date = Date(timeIntervalSince1970: 1_794_394_800 + Double(minute) * 60)
        return ISO8601DateFormatter().string(from: date)
    }

    private func event(_ type: String, _ turnId: String, _ minute: Int, _ payload: [String: Any]) {
        seq += 1
        events.append(Self.json(["seq": seq, "type": type, "turnId": turnId, "ts": at(minute), "payload": payload]))
    }

    /// One turn: its opening message, the calls it made, the reply, the end.
    private func exchange(_ minute: Int, _ payload: [String: Any], reply: String,
                          tools: [String] = ["mcp__orbit__task_get"]) {
        turn += 1
        let id = "turn-\(turn)"
        event("user", id, minute, payload)
        for name in tools {
            let call = "tool-\(seq)"
            event("tool_use", id, minute, ["id": call, "name": name, "input": [String: Any]()])
            event("tool_result", id, minute, ["toolUseId": call, "content": "ok"])
        }
        event("assistant", id, minute + 1, ["text": reply])
        event("turn_end", id, minute + 1, [:])
    }

    private func delivery(_ minute: Int, _ kind: String, _ task: String, _ title: String,
                          revision: Int? = nil) -> [String: Any] {
        var card: [String: Any] = ["kind": kind, "task": ["id": task, "title": title], "deliveredAt": at(minute),
                                   "toCoordinator": true]
        if let revision { card["revision"] = revision }
        return ["text": "From Orbit · project “Link” has news about \(title)", "coordinatorDelivery": card]
    }

    private func watchText(kind: String, id: String, status: String? = nil) -> String {
        var target: [String: Any] = ["kind": kind, "id": id, "state": "IDLE"]
        if let status { target["observed"] = ["status": status] }
        return [
            "Orbit Watch \(Self.watch) matched at generation 1: SESSION_IDLE 1/1",
            "",
            "This turn was queued by the watch, not typed by a person. What the watch recorded when its condition held:",
            "",
            "```json",
            Self.json(["watchId": Self.watch, "generation": 1, "reason": "SESSION_IDLE 1/1", "changedTargets": [target]]),
            "```",
        ].joined(separator: "\n")
    }

    private func conversation() {
        exchange(0, ["text": "Which tasks are waiting on me?"], reply: "None right now.", tools: [])
        exchange(10, delivery(10, "EVIDENCE_SUBMITTED", Self.b1, "B1 Targeted hints", revision: 2),
                 reply: "我确认了 B1（[定向提示](orbit-task:x)），它正在落地。\n\n**依据**")
        exchange(20, ["text": watchText(kind: "SESSION", id: Self.runOfB1)], reply: "这是之前设的提醒，不用再做什么。")
        exchange(30, delivery(30, "DEPENDENT_READY", Self.b4, "B4 Link gateway"), reply: "B4 已经开工。")
        exchange(40, ["text": "Why was B4b sent back?"], reply: "It conflicts with B5.", tools: [])
        exchange(50, delivery(50, "EVIDENCE_SUBMITTED", Self.b4, "B4 Link gateway", revision: 1), reply: "I confirmed B4.")
    }

    private func rows(fold: Bool = true) throws -> [TranscriptRow] {
        var reducer = TranscriptReducer()
        for line in events { reducer.apply(try JSONDecoder().decode(RunEvent.self, from: Data(line.utf8))) }
        return TranscriptRows.build(state: reducer.state, statusCards: [], canPageOlder: false,
                                    showWorkingIndicator: false, foldExchanges: fold)
    }

    private func groups(_ rows: [TranscriptRow]) -> [[OrbitExchange]] {
        rows.compactMap { if case .exchanges(let turns) = $0 { return turns } else { return nil } }
    }

    private func texts(_ rows: [TranscriptRow]) -> [String] {
        rows.compactMap {
            switch $0 {
            case .item(.assistant(let b)): return b.text
            case .item(.user(let b)): return b.text
            default: return nil
            }
        }
    }

    func testARunOfOrbitTurnsIsOneGroupAndTheReaderAndTheNewestTurnStay() throws {
        conversation()
        let built = try rows()
        let found = groups(built)
        XCTAssertEqual(found.count, 1)
        let group = try XCTUnwrap(found.first)
        XCTAssertEqual(OrbitExchangeFold.groupCount(group.count), "3 Orbit updates handled")
        XCTAssertEqual(OrbitExchangeFold.kinds(group), "1 evidence, 1 can start, 1 watch")
        XCTAssertEqual(group.map(\.what), [
            "Evidence revision 2 submitted: B1 Targeted hints", "Watch triggered", "Can start now: B4 Link gateway",
        ])
        XCTAssertEqual(group.first?.reply, "我确认了 B1（定向提示），它正在落地。")
        let drawn = texts(built)
        XCTAssertTrue(drawn.contains("Which tasks are waiting on me?"))
        XCTAssertTrue(drawn.contains("It conflicts with B5."))
        XCTAssertTrue(drawn.contains("I confirmed B4."), "the newest turn is never folded")
        XCTAssertFalse(drawn.contains { $0.hasPrefix("我确认了 B1") })
        // The group stands in for its first turn's bubble, under that bubble's id.
        XCTAssertEqual(built.first { if case .exchanges = $0 { return true } else { return false } }?.id, group.first?.id)
        // Opened, an exchange is exactly the rows drawn before.
        XCTAssertEqual(group.first?.rows, Array(try rows(fold: false).drop { row in
            if case .item(.user(let b)) = row { return b.id != group.first?.id } else { return true }
        }.prefix(while: { row in
            if case .item(.user(let b)) = row { return b.id == group.first?.id } else { return true }
        })))
    }

    func testOneTurnBetweenTwoThingsTheReaderSaidIsARowOfItsOwn() throws {
        exchange(0, ["text": "hi"], reply: "hello", tools: [])
        exchange(10, delivery(10, "EVIDENCE_SUBMITTED", Self.b1, "B1 Targeted hints", revision: 2), reply: "Confirmed.")
        exchange(20, ["text": "ok"], reply: "Done.", tools: [])
        let found = groups(try rows())
        XCTAssertEqual(found.map(\.count), [1])
        XCTAssertEqual(found.first?.first?.whatInTask, "Evidence revision 2 submitted")
    }

    func testWhatWentWrongOrAsksTheReaderStaysInView() throws {
        exchange(0, delivery(0, "TASK_RUN_STOPPED", Self.b1, "B1"), reply: "B1 stopped; restarting it.")
        exchange(5, ["text": watchText(kind: "TASK", id: Self.b4, status: "FAILED")], reply: "B4 failed.")
        exchange(10, delivery(10, "EVIDENCE_SUBMITTED", Self.b4, "B4", revision: 1), reply: "Need your call on B4.",
                 tools: ["mcp__orbit__ask_owner"])
        exchange(15, delivery(15, "EVIDENCE_SUBMITTED", Self.b1, "B1", revision: 3), reply: "I confirmed B1.", tools: [])
        exchange(20, ["text": "ok"], reply: "Done.", tools: [])
        let built = try rows()
        let drawn = texts(built)
        XCTAssertTrue(drawn.contains("B1 stopped; restarting it."))
        XCTAssertTrue(drawn.contains("B4 failed."))
        XCTAssertTrue(drawn.contains("Need your call on B4."))
        XCTAssertFalse(drawn.contains("I confirmed B1."))
        XCTAssertEqual(groups(built).map { $0.map(\.reply) }, [["I confirmed B1."]])
    }

    func testATurnTheAgentHasNotAnsweredStaysTheLineItsCardDraws() throws {
        conversation()
        events.removeAll { $0.contains("\"turnId\":\"turn-2\"") && $0.contains("\"type\":\"assistant\"") }
        XCTAssertEqual(groups(try rows()).map(\.count), [2])
    }

    func testNothingFoldsWhenTheCallerDrawsEveryRow() throws {
        conversation()
        XCTAssertTrue(groups(try rows(fold: false)).isEmpty)
    }

    func testARecordLinkLandsOnTheFoldHoldingItsItem() throws {
        conversation()
        let built = try rows()
        let group = try XCTUnwrap(groups(built).first)
        let inner = try XCTUnwrap(group[1].rows.compactMap { row -> String? in
            if case .item(.assistant(let b)) = row { return b.id } else { return nil }
        }.first)
        XCTAssertEqual(TranscriptRecordAnchor.rowID(containing: inner, in: built), group.first?.id)
    }

    // MARK: The tree

    private func ex(_ ts: String, _ target: ExchangeTarget?) -> OrbitExchange {
        OrbitExchange(id: ts, ts: ts, what: "w", reply: "r\(ts)", category: .evidence, target: target)
    }

    private var lookup: ExchangeTreeLookup {
        let b1 = Self.b1, b4 = Self.b4, b4b = Self.b4b, b5 = Self.b5, run = Self.runOfB1
        return ExchangeTreeLookup(
            taskOfSession: { $0 == run ? (b1, nil) : nil },
            upstreamOf: { [b4: [b1], b4b: [b4], b5: [b4, b1]][$0] ?? [] },
            taskTitle: { [b1: "B1", b4: "B4", b4b: "B4b", b5: "B5"][$0] })
    }

    func testTheTreePutsATaskUnderThePrerequisiteInTheSameGroup() throws {
        let tree = try XCTUnwrap(OrbitExchangeFold.tree([
            ex("10", .task(id: Self.b1, title: "B1 Targeted hints")),
            ex("20", .session(id: Self.runOfB1, title: "B1 run")),
            ex("30", .task(id: Self.b4, title: nil)),
            ex("35", nil),
            ex("40", .task(id: Self.b4b, title: nil)),
            ex("50", .task(id: Self.b5, title: nil)),
        ], lookup: lookup))
        XCTAssertEqual(tree.map(\.title), ["B1 Targeted hints", OrbitExchangeFold.otherBranchTitle])
        let b1 = tree[0]
        XCTAssertEqual(b1.exchanges.map(\.id), ["10", "20"])
        // B5 waits on both B4 and B1: under the one that came first in the group, once.
        XCTAssertEqual(b1.children.map(\.title), ["B4", "B5"])
        XCTAssertEqual(b1.children[0].children.map(\.title), ["B4b"])
        XCTAssertEqual(OrbitExchangeFold.downstreamCount(b1), 3)
        XCTAssertEqual(OrbitExchangeFold.branchExchanges(b1).map(\.id), ["10", "20", "30", "40", "50"])
        XCTAssertEqual(OrbitExchangeFold.branchSummary(b1), "5 updates · 3 downstream · last: r50")
        XCTAssertTrue(tree[1].isOther)
    }

    func testASessionNoTaskIsKnownToRunIsABranchOfItsOwn() throws {
        let run = "0195c0de-0000-7000-8000-0000000000ff"
        let tree = try XCTUnwrap(OrbitExchangeFold.tree([
            ex("1", .session(id: run, title: "Probe the gateway")), ex("2", .task(id: Self.b1, title: nil)),
            ex("3", .session(id: run, title: nil)),
        ], lookup: lookup))
        XCTAssertEqual(tree.map(\.title), ["Probe the gateway", "B1"])
        XCTAssertEqual(tree[0].exchanges.map(\.id), ["1", "3"])
        XCTAssertNil(tree[0].taskId)
    }

    func testNoTreeForAGroupAboutOneThing() {
        XCTAssertNil(OrbitExchangeFold.tree([ex("1", .task(id: Self.b1, title: nil)), ex("2", .task(id: Self.b1, title: nil))],
                                            lookup: lookup))
        XCTAssertNil(OrbitExchangeFold.tree([ex("1", nil), ex("2", nil)], lookup: lookup))
    }

    func testATaskThisClientKnowsNothingAboutIsNamedByTheEndOfItsId() throws {
        let tree = try XCTUnwrap(OrbitExchangeFold.tree([ex("1", .task(id: Self.b1, title: nil)), ex("2", nil)],
                                                        lookup: .empty))
        XCTAssertTrue(tree[0].title.hasPrefix("Task "))
        XCTAssertEqual(tree[0].title.count, "Task ".count + 8)
    }

    func testUpstreamIsReadOffTheGraphsMarks() throws {
        let json = """
        {"marks": [
          {"kind": "TASK", "id": "m1", "taskId": "\(Self.b1)", "title": "B1", "status": "DONE"},
          {"kind": "RUN", "id": "m2", "title": "run", "taskCount": 2, "members": [
            {"taskId": "\(Self.b4)", "title": "B4", "status": "DONE"},
            {"taskId": "\(Self.b4b)", "title": "B4b", "status": "OPEN"}]},
          {"kind": "TASK", "id": "m3", "taskId": "\(Self.b5)", "title": "B5", "status": "OPEN"}],
         "edges": [{"sourceMarkId": "m1", "targetMarkId": "m2"}, {"sourceMarkId": "m2", "targetMarkId": "m3"}],
         "taskCount": 4, "truncated": false}
        """
        let graph = try JSONDecoder().decode(ProjectDependencyGraph.self, from: Data(json.utf8))
        let read = OrbitExchangeFold.upstream(from: graph)
        XCTAssertEqual(read.upstreamOf(Self.b4), [Self.b1])
        XCTAssertEqual(read.upstreamOf(Self.b4b), [Self.b4])
        XCTAssertEqual(read.upstreamOf(Self.b5), [Self.b4b])
        XCTAssertEqual(read.upstreamOf(Self.b1), [])
        XCTAssertEqual(read.taskTitle(Self.b4b), "B4b")
        XCTAssertEqual(OrbitExchangeFold.upstream(from: nil).upstreamOf(Self.b4), [])
    }

    // MARK: Words

    func testReplyGistReadsTheFirstLineAsPlainText() {
        XCTAssertEqual(OrbitExchangeFold.replyGist("我确认了 B1（[定向提示与 NATS](orbit-task:x)），它正在落地。\n\n**确认依据**"),
                       "我确认了 B1（定向提示与 NATS），它正在落地。")
        XCTAssertEqual(OrbitExchangeFold.replyGist("\n## **Verdict:** confirmed `B5`\nmore"), "Verdict: confirmed B5")
        XCTAssertEqual(OrbitExchangeFold.replyGist("- first point\n- second"), "first point")
        XCTAssertEqual(OrbitExchangeFold.replyGist("```\ncode\n```"), "code")
        XCTAssertEqual(OrbitExchangeFold.replyGist(""), "")
    }

    func testKindsCountAGroupInAFixedOrder() {
        let cats: [ExchangeCategory] = [.watch, .evidence, .evidence, .job, .ready, .watch, .evidence]
        XCTAssertEqual(OrbitExchangeFold.kinds(cats.map { OrbitExchange(id: UUID().uuidString, ts: nil, what: "", reply: "",
                                                                          category: $0, target: nil) }),
                       "3 evidence, 1 can start, 2 watches, 1 background job")
    }

    func testAsksOwnerMatchesEveryEngineSpelling() {
        XCTAssertTrue(OrbitExchangeFold.asksOwner("mcp__orbit__ask_owner"))
        XCTAssertTrue(OrbitExchangeFold.asksOwner("orbit.request_owner_action"))
        XCTAssertTrue(OrbitExchangeFold.asksOwner("ask_owner"))
        XCTAssertFalse(OrbitExchangeFold.asksOwner("mcp__orbit__task_ask_ownership"))
    }
}
