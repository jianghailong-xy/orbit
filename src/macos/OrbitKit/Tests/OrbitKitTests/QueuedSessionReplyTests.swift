import XCTest
@testable import OrbitKit

/// A reply turn waiting on the queue is drawn as the reply cards its echo will be, off the cards the
/// queue list carries (`sessionReplies`) — never as the blocks it is delivered with, in the reader's bubble.
final class QueuedSessionReplyTests: XCTestCase {
    private let card: JSONValue = .object([
        "requestId": .string("req1"),
        "outcome": .string("REPLIED"),
        "fromSessionId": .string("s-asked"),
        "fromTitle": .string("分析 session 列表页性能"),
        "requestPreview": .string("再跑一组只读探针"),
        "replyText": .string("全部只读执行"),
    ])

    func testAQueuedReplyTurnCarriesItsCards() throws {
        let json = """
        [{"turnId":"t1","kind":"message","content":"<orbit-session-reply request-id=\\"req1\\">\\n…\\n</orbit-session-reply>",
          "sessionReplies":[{"requestId":"req1","outcome":"REPLIED","fromSessionId":"s-asked","fromTitle":"分析","requestPreview":"再跑","replyText":"全部只读执行"}],
          "authoredByOrbit":true}]
        """
        let turns = try JSONDecoder().decode([QueuedTurnInfo].self, from: Data(json.utf8))
        var r = TranscriptReducer()
        r.reconcileQueuedTurns(turns, knownBefore: [])
        XCTAssertEqual(r.state.queued.count, 1)
        XCTAssertEqual(r.state.queued[0].sessionReplies?.map(\.requestId), ["req1"])
        XCTAssertEqual(r.state.queued[0].sessionReplies?.first?.replyText, "全部只读执行")
    }

    func testARefreshedRowPicksUpItsCards() {
        var r = TranscriptReducer()
        r.reconcileQueuedTurns([QueuedTurnInfo(turnId: "t1", content: "block")], knownBefore: [])
        XCTAssertNil(r.state.queued[0].sessionReplies)
        r.reconcileQueuedTurns([QueuedTurnInfo(turnId: "t1", content: "block", sessionReplies: .array([card]))],
                               knownBefore: ["t1"])
        XCTAssertEqual(r.state.queued[0].sessionReplies?.first?.fromTitle, "分析 session 列表页性能")
    }

    func testAnOrdinaryQueuedMessageHasNone() {
        var r = TranscriptReducer()
        r.reconcileQueuedTurns([QueuedTurnInfo(turnId: "t1", content: "and then deploy")], knownBefore: [])
        XCTAssertNil(r.state.queued[0].sessionReplies)
    }
}
