import XCTest
@testable import OrbitKit

/// The same cases the web module is held to (`src/web/src/lib/deliveredMessage.test.ts`), because
/// the two render the same echoed text and a rule that holds on one client and not the other is
/// worse than no rule.
final class DeliveredMessageTests: XCTestCase {

    // The exact shapes the server appends (ReferenceExpansionService, ListEventsService).
    private let conditions = """
        <list-conditions list="6ba7b810-9dad-11d1-80b4-00c04fd430c8" title="FineWeb">
          配额挡住派发｜12 个就绪任务被配额挡住｜累计 47 次
          以上是控制面在你上次收到消息之后观察到的，不是用户说的。
        </list-conditions>
        """
    private let refList = """
        <referenced-list id="6ba7b810-9dad-11d1-80b4-00c04fd430c8">
          标题   FineWeb CC-MAIN-2025-26
        </referenced-list>
        """
    private let refTask = """
        <referenced-task id="550e8400-e29b-41d4-a716-446655440000">
          标题   [W 009/250] → WARC
        </referenced-task>
        """
    private let coordinator = """
        <orbit_project_coordinator_context>
          你是项目（id: 4gfFCpGvM8ZoqYTZwH3cCB）的协调会话。
          这里用来协调任务，不是替任务干活。
        </orbit_project_coordinator_context>
        """

    func testTakesTheConditionBoardOutOfTheBubble() {
        let out = splitDeliveredMessage("这个列表现在什么情况？\n\n\(conditions)")

        XCTAssertEqual(out.text, "这个列表现在什么情况？")
        XCTAssertEqual(out.injected.count, 1)
        // Verbatim: the reveal is the only remaining way to see what the model actually read.
        XCTAssertEqual(out.injected.first, conditions)
    }

    func testPeelsSeveralBlocksInAppendOrder() {
        let out = splitDeliveredMessage(
            "看下 #FineWeb\n\n\(refList)\n\n\(refTask)\n\n\(conditions)\n\n\(coordinator)"
        )

        XCTAssertEqual(out.text, "看下 #FineWeb")
        XCTAssertEqual(out.injected.count, 4)
        XCTAssertEqual(out.injected.last, coordinator)
        XCTAssertEqual(
            describeInjected(out.injected),
            "referenced list, referenced task, list conditions, project coordinator context"
        )
    }

    func testTwoIdenticalAdjacentBlocksComeOutAsTwo() {
        // A message naming two tasks produces exactly this. The web version got it wrong first:
        // one pattern with a backreference and an end anchor swallows both into one.
        let out = splitDeliveredMessage("q\n\n\(refTask)\n\n\(refTask)")

        XCTAssertEqual(out.injected.count, 2)
        XCTAssertEqual(describeInjected(out.injected), "referenced task ×2")
    }

    func testLeavesAnOrdinaryMessageAlone() {
        // Overwhelmingly the common case.
        let plain = "把 WARC 转换拆开并行跑，它不依赖去重完成。"

        let out = splitDeliveredMessage(plain)

        XCTAssertEqual(out.text, plain)
        XCTAssertTrue(out.injected.isEmpty)
    }

    func testDoesNotEatATagTheUserTypedMidSentence() {
        // Why the match is anchored to the end: someone asking about this very feature must not
        // have their question silently rewritten.
        let asking = "为什么 <list-conditions> 这个块会出现在我自己的气泡里？\n\n它是谁加的？"

        XCTAssertEqual(splitDeliveredMessage(asking).text, asking)
    }

    func testDoesNotStripAnUnclosedBlock() {
        let broken = "问题\n\n<list-conditions list=\"x\">\n  一半就断了"

        XCTAssertTrue(splitDeliveredMessage(broken).injected.isEmpty)
    }

    func testDoesNotStripSomebodyElsesTag() {
        let code = "帮我看下这段\n\n<my-component id=\"x\">\n  <div/>\n</my-component>"

        XCTAssertTrue(splitDeliveredMessage(code).injected.isEmpty)
    }

    func testHandlesAMessageThatIsNothingButInjectedContext() {
        // A server-seeded turn with no text of its own.
        let out = splitDeliveredMessage("\n\n\(conditions)")

        XCTAssertEqual(out.text, "")
        XCTAssertEqual(out.injected.count, 1)
    }
}
