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
    private func parkedCoordinator(pending: Int,
                                  waitingKind: SessionWaitingKind? = nil,
                                  ownerItems: [SessionOwnerItem]? = nil) -> Session {
        Session(id: "coordinator", title: "Criteria seal & decision", status: .awaitingInput,
                agentId: "orbit", assignedRunnerId: "runner",
                pendingApprovals: pending, waitingKind: waitingKind, ownerItems: ownerItems,
                branch: nil, updatedAt: nil,
                projectId: "proj_1", projectTitle: "Criteria seal & decision",
                lastAssistantText: "Filed the proposal.",
                engineTurnActive: false,
                agent: SessionAgentRef(id: "orbit", name: "orbit", provider: nil,
                                       model: nil, effort: nil),
                lastTurnAt: "2026-09-09T15:14:57Z")
    }

    private func item(_ id: String, _ kind: OwnerItemKind, since: String) -> SessionOwnerItem {
        SessionOwnerItem(itemId: id, kind: kind, title: "\(kind.rawValue) item", since: since)
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

    /// One of the four says which it is, in the bar's own words — and this is the row that matters
    /// most on a project whose coordinator is switched off, because the item is the owner's exactly
    /// when nobody else will take it. "Waiting for approval" described the one act that was
    /// certainly not happening (the account owner's report, 2026-09-22: a project confirmed but
    /// never started, three escalations drawn in its coordinator conversation, the row saying
    /// nothing).
    func testTheRowNamesWhichOfTheFourIsWaiting() {
        let escalated = item("i1", .escalated, since: "2026-09-22T00:19:41Z")
        let paused = item("i2", .fusePaused, since: "2026-09-22T02:00:00Z")
        let unknown = item("i3", .unknown, since: "2026-09-22T00:00:00Z")

        XCTAssertEqual(
            SessionLine.make(for: parkedCoordinator(pending: 1, waitingKind: .ownerItem,
                                                    ownerItems: [escalated]), live: true),
            SessionLine(text: "Escalated to you", tone: .approval),
            "the row says the item's own word, not the approval one")
        // The same words the bar says about the same item, so a person who pressed either arrives
        // at a card saying what they read.
        XCTAssertEqual(NeedsYouLogic.ownerItemText(escalated, project: "FineWeb"),
                       "Escalated to you · FineWeb")
        XCTAssertEqual(NeedsYouLogic.kindWord(.fusePaused), "Paused")
        XCTAssertNil(NeedsYouLogic.kindWord(.unknown),
                     "a kind this build cannot name is not named")
        // The OLDEST item is the one named — the same FIFO the bar picks its target by — and the
        // order the row holds them in is not what decides it.
        XCTAssertEqual(NeedsYouLogic.oldestItemWord([paused, escalated]), "Escalated to you")
        XCTAssertEqual(NeedsYouLogic.oldestItemWord([unknown, paused]), "Paused",
                       "an unnameable item is skipped rather than sorting last")

        // And nothing to name keeps the generic words: a row that lost its items (an older control
        // plane, or a summary that carried none) reads as it always did rather than going silent.
        XCTAssertEqual(
            SessionLine.make(for: parkedCoordinator(pending: 1, waitingKind: .ownerItem), live: true),
            SessionLine(text: "Waiting for approval", tone: .approval))
        XCTAssertEqual(
            SessionLine.make(for: parkedCoordinator(pending: 1, waitingKind: .ownerItem,
                                                    ownerItems: [unknown]), live: true),
            SessionLine(text: "Waiting for approval", tone: .approval))
    }

    /// A project ready to start is not one of the sessions that need you (the account owner's
    /// report, 2026-10-02: "2 sessions need you" over two coordinators whose rows both said Ready to
    /// start). The row keeps its words; the bar, the badge and the drawer's count leave it out.
    func testAProjectReadyToStartIsNotASessionThatNeedsYou() {
        let ready = parkedCoordinator(pending: 1, waitingKind: .startRequest)
        let groups = SessionGrouping.group([ready])
        XCTAssertTrue(groups.needsYou.isEmpty, "the start is the owner's to make when they choose")
        XCTAssertEqual(groups.running.map(\.id), ["coordinator"],
                       "it is grouped as the parked conversation it is")
        XCTAssertNil(NeedsYouLogic.banner(waiting: groups.needsYou), "no bar")
        XCTAssertEqual(NeedsYouLogic.byAgent([ready]), [:], "no count on its workspace in the drawer")
        XCTAssertNil(MenuBar.summary(from: [ready]).badge, "and no badge")
        XCTAssertEqual(SessionLine.make(for: ready, live: true),
                       SessionLine(text: "Ready to start", tone: .approval),
                       "while the row itself still says what the card in it asks")

        // Anything counted beside the start is still somebody waiting. The server names no kind for
        // a row counting two things, so a blocked tool call next to the start lights the bar as before.
        let alsoBlocked = parkedCoordinator(pending: 2)
        XCTAssertEqual(SessionGrouping.group([alsoBlocked]).needsYou.map(\.id), ["coordinator"])
        XCTAssertEqual(NeedsYouLogic.byAgent([alsoBlocked]), ["orbit": 1])
        // And one of the four on the row is the evidence on its own, whatever the kind arrived as.
        let alsoAnItem = parkedCoordinator(pending: 1, waitingKind: .startRequest,
                                           ownerItems: [item("i1", .escalated, since: "2026-10-02T00:00:00Z")])
        XCTAssertEqual(SessionGrouping.group([alsoAnItem]).needsYou.map(\.id), ["coordinator"])
    }

    /// A run whose report is still with its reviewer is NOT waiting on you
    /// (docs/owner-confirmation-review-contract.md §5 N1): the server leaves it out of
    /// `pendingApprovals`, so nothing here may put it back — not the grouping, not the bar, not the
    /// drawer's badge, and not the bar inside the conversation that counts the cards below. The row
    /// and the header say "Under review" in the quiet tone instead, with the reviewer's name.
    func testARunUnderReviewIsDrawnButNotCounted() {
        let review = ConfirmationUnderReview(requestId: "req-1", taskId: "task-1",
                                             reviewerSessionId: "coordinator",
                                             reviewerTitle: "会话间消息参数与回复设计",
                                             since: "2026-10-02T14:55:00Z", dueAt: "2026-10-02T15:25:00Z")
        let run = Session(id: "run", title: "执行任务：会话间请求与回复", status: .awaitingInput,
                          agentId: "orbit", assignedRunnerId: "runner", pendingApprovals: 0,
                          taskId: "task-1", branch: nil, updatedAt: nil,
                          lastAssistantText: "All six P1 review findings are fixed.",
                          agent: SessionAgentRef(id: "orbit", name: "orbit", provider: nil,
                                                 model: nil, effort: nil),
                          lastTurnAt: "2026-10-02T14:55:00Z", confirmationUnderReview: review)

        let groups = SessionGrouping.group([run])
        XCTAssertTrue(groups.needsYou.isEmpty, "a report under review is not something that needs you")
        XCTAssertNil(NeedsYouLogic.banner(waiting: groups.needsYou), "no bar")
        XCTAssertEqual(NeedsYouLogic.byAgent([run]), [:], "no count on its workspace")
        XCTAssertNil(MenuBar.summary(from: [run]).badge, "and no badge")

        XCTAssertEqual(SessionLine.make(for: run, live: true),
                       SessionLine(text: "Under review · 会话间消息参数与回复设计", tone: .review))
        XCTAssertEqual(SessionHeader.statusWord(for: run), OwnerConfirmations.underReview)
        XCTAssertEqual(SessionHeader.subtitle(for: run, now: Date(timeIntervalSince1970: 1_791_000_000))?
                        .hasPrefix("Under review · Open · "), true,
                       "the header's subtitle: `Under review · Open · 2m ago`")
        let glyph = SessionStatusGlyph.make(for: run)
        XCTAssertEqual(glyph.shape, .symbol("clock"))
        XCTAssertEqual(glyph.tone, .neutral, "never the amber of a row waiting on you")
        XCTAssertEqual(glyph.label, OwnerConfirmations.underReview)

        // Something else waiting on the owner in the same conversation still lights it.
        let alsoBlocked = Session(id: "run", title: nil, status: .awaitingInput, agentId: "orbit",
                                  assignedRunnerId: "runner", pendingApprovals: 1, branch: nil,
                                  updatedAt: nil, confirmationUnderReview: review)
        XCTAssertEqual(SessionLine.make(for: alsoBlocked, live: true).tone, .approval)

        // A summary saying the review is over clears the row; one from an older server leaves it.
        let cleared = run.applying(try! JSONDecoder().decode(ControlSessionSummary.self, from: Data(
            #"{"id":"run","status":"AWAITING_INPUT","pendingApprovals":1,"waitingKind":"OWNER_CONFIRMATION","confirmationUnderReview":null}"#.utf8)))
        XCTAssertNil(cleared.confirmationUnderReview)
        XCTAssertEqual(SessionLine.make(for: cleared, live: true),
                       SessionLine(text: OwnerConfirmations.waitingForConfirmation, tone: .approval))
        let older = run.applying(try! JSONDecoder().decode(ControlSessionSummary.self, from: Data(
            #"{"id":"run","status":"AWAITING_INPUT","pendingApprovals":0}"#.utf8)))
        XCTAssertEqual(older.confirmationUnderReview, review)
    }

    /// The bar inside the conversation ("1 open question below") counts the cards still asking the
    /// owner, and a card whose report is with its reviewer is not one of them — while the card
    /// itself stays open, drawn and pressable (§5 N1, §0.2 G2).
    func testTheBarBelowLeavesOutACardStillUnderReview() {
        func standing(_ state: OwnerConfirmationReviewState?) -> OwnerConfirmationStanding {
            let review = state.map {
                OwnerConfirmationReviewView(reviewId: "rv1", state: $0,
                                            reviewer: .init(kind: "TASK_CREATOR", sessionId: "s", title: "R"),
                                            since: "2026-10-02T14:55:00Z", dueAt: "2026-10-02T15:25:00Z",
                                            windowSeconds: 1800)
            }
            let waiting = OwnerConfirmationWaiting(requestId: "req-1", sessionId: "run",
                                                   requestedAt: "2026-10-02T14:55:00Z", review: review)
            let view = OwnerConfirmationView(taskId: "task-1", title: "T", status: "OPEN",
                                             completionCriterion: "OWNER_CONFIRMED", waiting: waiting)
            return OwnerConfirmations.standing(view, sessionID: "run", requestID: "req-1")
        }
        XCTAssertTrue(OwnerConfirmations.isOpen(standing(.underReview)), "still a question on screen")
        XCTAssertTrue(standing(.underReview).answerable, "and the door still takes an answer")
        XCTAssertFalse(OwnerConfirmations.asksNow(standing(.underReview)), "but not counted below")
        for counted: OwnerConfirmationReviewState? in [nil, .reviewed, .notReviewed, .outdated] {
            XCTAssertTrue(OwnerConfirmations.asksNow(standing(counted)), "\(String(describing: counted))")
        }
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
