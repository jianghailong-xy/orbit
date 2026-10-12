import Foundation
import XCTest
@testable import OrbitKit

/// A queued turn carries every card its row in the queue list carries — each kind, on a row first
/// seen in a listing and on a row reconciled in place — and they are the cards its echo will carry.
///
/// The console draws a queued turn and a delivered one through the same dispatch (`UserTurnRow`), so
/// what decides whether a waiting turn is drawn as its card or as the owner's bubble is only whether
/// the card reached the `UserBubble`. Each card used to be copied onto the queued row by hand, in two
/// places, and `taskStart` never was. These run the JSON the server lists (sessions/turn-cards.ts
/// `TurnCards`, under the same keys) through `reconcileQueuedTurns`, and the census at the top fails
/// for a card field `UserBubble` grows that no fixture here covers.
final class QueuedTurnCardsTests: XCTestCase {

    /// One card of each kind, under the key the queue list and the echo carry it by, named for the
    /// `UserBubble` field it is drawn from.
    private static let fixtures: [(field: String, key: String, card: String)] = [
        ("itemCard", "openItemDelivery", """
            {"itemId": "item-1", "kind": "INTEGRATION_CONFLICT", "title": "Merge conflict on project/34Y7",
             "files": ["src/web/src/components/WorkspaceView.tsx"]}
            """),
        ("taskStart", "taskStart", """
            {"taskId": "01a0cca7-8609-70ed-a0e2-d4b55b832b60", "title": "runner + web：配额按账户归属",
             "completionCriterion": "EVIDENCE_JUDGMENT", "auto": true,
             "project": {"id": "01a0cca0-aeaa-7618-bd5a-caccc089108c", "title": "Codex 多账户"}}
            """),
        ("startedCard", "projectStarted", """
            {"by": "CONFIRMATION", "projectId": "01a0cca0-aeaa-7618-bd5a-caccc089108c",
             "projectTitle": "统一排队与已投递消息的卡片渲染", "criteriaCount": 4}
            """),
        ("sessionMessage", "sessionMessage", """
            {"fromSessionId": "s-sender", "fromTitle": "统一排队与已投递消息的卡片渲染", "fromAgentName": "orbit-develop"}
            """),
        ("sessionReplies", "sessionReplies", """
            [{"requestId": "req1", "outcome": "REPLIED", "fromSessionId": "s-asked",
              "fromTitle": "分析 session 列表页性能", "requestPreview": "再跑一组只读探针", "replyText": "全部只读执行"}]
            """),
        ("reviewRequest", "confirmationReviewRequest", """
            {"requestId": "cr-1", "reviewId": "rv-1", "taskId": "task-1", "title": "Review the run's report",
             "runSessionId": "s-run", "dueAt": "2026-10-06T12:00:00.000Z"}
            """),
        ("reviewReturn", "confirmationReturn", """
            {"requestId": "cr-1", "recordId": "rec-1", "reviewerTitle": "Reviewer",
             "reason": "The evidence cites no run", "problems": [{"key": "p1", "text": "No TOOL_CALL resolves"}]}
            """),
    ]

    /// Everything on a `UserBubble` that is not a card: the turn's words and inputs, and how far it got.
    private static let notCards: Set<String> = [
        "id", "text", "attachments", "ts", "clientTurnId", "turnId", "pending", "queued", "undelivered",
        "note", "authoredByOrbit", "steer", "delivery",
    ]

    /// What the agent reads on such a turn: words written for it, which no card is read out of.
    private static let content = "Words the control plane wrote for the agent."

    private func row(_ turnId: String, cards: [(key: String, card: String)]) -> String {
        let extra = cards.map { ", \"\($0.key)\": \($0.card)" }.joined()
        return """
            {"turnId": "\(turnId)", "kind": "message", "content": "\(Self.content)",
             "attachments": []\(extra), "authoredByOrbit": true}
            """
    }

    private func listing(_ rows: String...) throws -> [QueuedTurnInfo] {
        try JSONDecoder().decode([QueuedTurnInfo].self, from: Data("[\(rows.joined(separator: ","))]".utf8))
    }

    /// The card fields that hold a card, by name.
    private func filled(_ cards: TurnCards) -> Set<String> {
        Set(Mirror(reflecting: cards).children.compactMap { child -> String? in
            let value = Mirror(reflecting: child.value)
            return value.displayStyle == .optional && value.children.isEmpty ? nil : child.label
        })
    }

    private func onlyQueued(_ reducer: TranscriptReducer) throws -> UserBubble {
        XCTAssertEqual(reducer.state.queued.count, 1)
        return try XCTUnwrap(reducer.state.queued.first)
    }

    // MARK: - the census

    /// Every card a turn can be drawn as is carried by `TurnCards`, the value the queue sets as a whole,
    /// and has a fixture below. A card field added to `UserBubble` and to the echo alone fails here —
    /// which is how a queued turn would go back to being drawn as the owner's bubble.
    func testEveryCardABubbleCanCarryIsCarriedOffTheQueueAndCoveredHere() {
        let carried = Set(Mirror(reflecting: TurnCards()).children.compactMap(\.label))
        let bubble = Set(Mirror(reflecting: UserBubble(id: "u", text: "", pending: false)).children.compactMap(\.label))
        XCTAssertEqual(bubble.subtracting(Self.notCards), carried,
                       "UserBubble has a field that is neither one of TurnCards nor listed in notCards: a card "
                           + "belongs on TurnCards, QueuedTurnInfo.cards and a fixture here; anything else in notCards")
        XCTAssertEqual(Set(Self.fixtures.map(\.field)), carried, "a card with no fixture is a card nobody checked")
        XCTAssertEqual(Self.fixtures.count, carried.count, "one fixture per card")
    }

    // MARK: - each card, through both branches

    /// A row first seen in a listing is created holding its card, and only that one.
    func testEachCardIsOnARowFirstSeenInAListing() throws {
        for fixture in Self.fixtures {
            var reducer = TranscriptReducer()
            reducer.reconcileQueuedTurns(try listing(row("t-\(fixture.key)", cards: [(fixture.key, fixture.card)])),
                                         knownBefore: [])
            let bubble = try onlyQueued(reducer)
            XCTAssertEqual(filled(bubble.cards), [fixture.field], "\(fixture.key) did not reach the new row")
            XCTAssertEqual(bubble.text, Self.content)
            XCTAssertTrue(bubble.queued && bubble.pending && bubble.authoredByOrbit)
        }
    }

    /// A row already on screen takes the card a later listing carries — the same row, not a second
    /// one — and lets go of it when a listing no longer does, because the cards are set as a whole.
    func testEachCardIsOnARowReconciledInPlace() throws {
        for fixture in Self.fixtures {
            let turnId = "t-\(fixture.key)"
            var reducer = TranscriptReducer()
            reducer.reconcileQueuedTurns(try listing(row(turnId, cards: [])), knownBefore: [])
            let before = try onlyQueued(reducer)
            XCTAssertEqual(before.cards, TurnCards(), "an ordinary row carries no card")

            reducer.reconcileQueuedTurns(try listing(row(turnId, cards: [(fixture.key, fixture.card)])),
                                         knownBefore: [turnId])
            let after = try onlyQueued(reducer)
            XCTAssertEqual(after.id, before.id, "the row was replaced rather than reconciled")
            XCTAssertEqual(filled(after.cards), [fixture.field], "\(fixture.key) did not reach the row in place")

            reducer.reconcileQueuedTurns(try listing(row(turnId, cards: [])), knownBefore: [turnId])
            XCTAssertEqual(try onlyQueued(reducer).cards, TurnCards(), "\(fixture.key) outlived its listing")
        }
    }

    /// One row carrying every card at once fills every field, with the values the server listed —
    /// on a new row and on a row reconciled in place alike.
    func testARowCarryingEveryCardFillsEveryField() throws {
        let all = Self.fixtures.map { (key: $0.key, card: $0.card) }
        var created = TranscriptReducer()
        created.reconcileQueuedTurns(try listing(row("t-all", cards: all)), knownBefore: [])
        var inPlace = TranscriptReducer()
        inPlace.reconcileQueuedTurns(try listing(row("t-all", cards: [])), knownBefore: [])
        inPlace.reconcileQueuedTurns(try listing(row("t-all", cards: all)), knownBefore: ["t-all"])

        for reducer in [created, inPlace] {
            let b = try onlyQueued(reducer)
            XCTAssertEqual(filled(b.cards), Set(Self.fixtures.map(\.field)))
            XCTAssertEqual(b.itemCard?.kind, .integrationConflict)
            XCTAssertEqual(b.itemCard?.files, ["src/web/src/components/WorkspaceView.tsx"])
            XCTAssertEqual(b.taskStart?.taskId, "01a0cca7-8609-70ed-a0e2-d4b55b832b60")
            XCTAssertEqual(b.taskStart?.title, "runner + web：配额按账户归属")
            XCTAssertEqual(b.taskStart?.completionCriterion, .evidenceJudgment)
            XCTAssertEqual(b.taskStart?.project?.title, "Codex 多账户")
            XCTAssertEqual(b.taskStart?.auto, true)
            XCTAssertEqual(b.startedCard?.projectTitle, "统一排队与已投递消息的卡片渲染")
            XCTAssertEqual(b.startedCard?.criteriaCount, 4)
            XCTAssertEqual(b.sessionMessage?.fromSessionId, "s-sender")
            XCTAssertEqual(b.sessionReplies?.map(\.requestId), ["req1"])
            XCTAssertEqual(b.sessionReplies?.first?.replyText, "全部只读执行")
            XCTAssertEqual(b.reviewRequest?.runSessionId, "s-run")
            XCTAssertEqual(b.reviewReturn?.problems.map(\.text), ["No TOOL_CALL resolves"])
        }
    }

    // MARK: - the same cards as the echo

    /// While it waits and once a runner echoes it, a turn carries the same cards: the same JSON, under
    /// the same key, read off the queue list and off the `user` event's payload.
    func testAQueuedRowCarriesTheCardsItsEchoWillCarry() throws {
        for fixture in Self.fixtures {
            var queue = TranscriptReducer()
            queue.reconcileQueuedTurns(try listing(row("t-1", cards: [(fixture.key, fixture.card)])), knownBefore: [])

            let event = """
                {"seq": 1, "type": "user", "turnId": "t-1", "ts": "2026-10-06T05:41:10.000Z",
                 "payload": {"text": "\(Self.content)", "\(fixture.key)": \(fixture.card)}}
                """
            var echo = TranscriptReducer()
            echo.apply(try JSONDecoder().decode(RunEvent.self, from: Data(event.utf8)))
            let delivered = try XCTUnwrap(echo.state.items.compactMap { item -> UserBubble? in
                guard case .user(let b) = item else { return nil }
                return b
            }.first)

            XCTAssertEqual(try onlyQueued(queue).cards, delivered.cards, "\(fixture.key) reads differently on the queue")
            XCTAssertEqual(filled(delivered.cards), [fixture.field])
        }
    }
}
