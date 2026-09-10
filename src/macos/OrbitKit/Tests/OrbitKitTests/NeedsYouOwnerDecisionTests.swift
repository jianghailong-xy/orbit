import XCTest
@testable import OrbitKit

/// THE AMBER "NEEDS YOU" BAR HAS TO LIGHT FOR A DECISION, NOT ONLY FOR A BLOCKED TOOL CALL.
///
/// The server's `pendingApprovals` is no longer only `approval.count(status: 'PENDING')`: it also
/// counts the decisions only the account owner can take that are waiting on that conversation
/// (apiserver `owner-decision-signal.ts`). Every "needs you" surface on this client is derived from
/// that one number, so the count arriving is most of the work — but only if nothing on this side
/// filters it back out again.
///
/// Two things could, and both are asserted here:
///
///   * `SessionGrouping.group` and `NeedsYouLogic.banner` take the count at face value with no
///     state gate, which is what makes a PARKED conversation eligible for the bar at all. A
///     criteria decision is held open by nobody — the card is delivered and the turn ends
///     underneath it — so the conversation carrying it is at AWAITING_INPUT, not running.
///   * `SessionLine.make` used to read the count only inside `isGenerating`, so the row itself said
///     "Filed the proposal." while the bar above it said somebody was waiting. That check now sits
///     outside the gate, exactly as the web port's `sessionLine` does.
///
/// Every case pairs with the same fixture at zero, so what is being witnessed is the count and not
/// the fixture.
final class NeedsYouOwnerDecisionTests: XCTestCase {

    /// A project's coordinator conversation between turns: parked, with a decision card delivered
    /// into it and nothing running. The shape the badge was dark on.
    private func parkedCoordinator(pending: Int) -> Session {
        Session(id: "coordinator", title: "Criteria seal & decision", status: .awaitingInput,
                agentId: "orbit", assignedRunnerId: "runner",
                pendingApprovals: pending, branch: nil, updatedAt: nil,
                projectId: "proj_1", projectTitle: "Criteria seal & decision",
                lastAssistantText: "Filed the proposal.",
                engineTurnActive: false,
                agent: SessionAgentRef(id: "orbit", name: "orbit", provider: nil,
                                       model: nil, effort: nil),
                lastTurnAt: "2026-09-09T15:14:57Z")
    }

    func testParkedConversationWithAnOwnerDecisionIsGroupedAsNeedsYou() {
        let waiting = SessionGrouping.group([parkedCoordinator(pending: 1)])
        XCTAssertEqual(waiting.needsYou.map(\.id), ["coordinator"],
                       "a decision waiting on a parked conversation is still something that needs you")
        XCTAssertTrue(waiting.running.isEmpty, "and it is not filed as work in progress")

        let nothing = SessionGrouping.group([parkedCoordinator(pending: 0)])
        XCTAssertTrue(nothing.needsYou.isEmpty,
                      "the same parked conversation with nothing waiting is not in the bucket")
        XCTAssertEqual(nothing.running.map(\.id), ["coordinator"])
    }

    func testTheAmberBarNamesTheWorkspaceToGoAnswerItIn() {
        let waiting = SessionGrouping.group([parkedCoordinator(pending: 1)]).needsYou
        let banner = NeedsYouLogic.banner(waiting: waiting)
        XCTAssertEqual(banner?.count, 1)
        XCTAssertEqual(banner?.text, "orbit needs you")
        XCTAssertEqual(banner?.target.id, "coordinator",
                       "and a tap lands in the conversation the card was delivered to")

        XCTAssertNil(NeedsYouLogic.banner(waiting: SessionGrouping.group([parkedCoordinator(pending: 0)]).needsYou),
                     "no bar when nothing is waiting — the bar is absent, not present at zero")
    }

    func testTheRowItselfSaysSoRatherThanShowingTheLastReply() {
        XCTAssertEqual(SessionLine.make(for: parkedCoordinator(pending: 1), live: true),
                       SessionLine(text: "Waiting for approval", tone: .approval),
                       "outside the isGenerating gate: nothing is generating, and somebody is waiting")
        XCTAssertEqual(SessionLine.make(for: parkedCoordinator(pending: 0), live: true),
                       SessionLine(text: "Filed the proposal.", tone: .preview),
                       "and with nothing waiting the row is an ordinary reply preview again")
    }

    /// A blocked tool call is unchanged by the hoist: it holds the turn open, so it was already
    /// inside the gate and is now simply ahead of it.
    func testABlockedToolCallStillReadsTheSameWay() {
        let running = Session(id: "s1", title: nil, status: .running, agentId: "orbit",
                              assignedRunnerId: "runner", pendingApprovals: 1, branch: nil,
                              updatedAt: nil, lastToolUse: "Bash", engineTurnActive: true)
        XCTAssertEqual(SessionLine.make(for: running, live: true),
                       SessionLine(text: "Waiting for approval", tone: .approval))
    }
}
