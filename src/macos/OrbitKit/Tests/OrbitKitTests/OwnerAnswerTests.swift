import Foundation
import XCTest
@testable import OrbitKit

/// The owner's answer handed to the coordinator is drawn from the card the control plane recorded
/// beside the turn's echo (`ownerAnswer`) — one line, "Sent to the coordinator · 08:29" — and never
/// from the words the coordinator was sent, which stay behind the line verbatim.
///
/// The client half of the pair the web is held to (`OwnerAnswerLine.test.tsx`): with the payload the
/// turn is the line, and without one it is exactly the bubble it was before any of this existed.
/// `OwnerAnswerCopyParityTests` holds the words and the field names to the browser's.
final class OwnerAnswerTests: XCTestCase {

    /// What `ownerAnswerMessage` writes — the agent's reading, never read here, only kept.
    static let told = "From Orbit · owner answer: you asked \"灰度回退之后的收尾都做完了：请批准重开灰度。\". "
        + "The owner answered: 现在重开，接受这个代价（推荐） (2026-10-09T00:29:36.828Z)."

    /// The card as the apiserver writes it (project-open-item.ts `readOwnerAnswerCard`) — the web
    /// suite's `CARD`, field for field.
    private let card = """
        {"itemId": "01a0d6a9-d763-70e1-b4cf-8793e971b511", "kind": "COORDINATOR_QUESTION",
         "sessionId": "01a0d6a9-d763-70e1-b4cf-8793e971b512", "deliveredAt": "2026-10-09T00:29:37.104Z"}
        """

    private let expected = OwnerAnswer(itemId: "01a0d6a9-d763-70e1-b4cf-8793e971b511", kind: .coordinatorQuestion,
                                       sessionId: "01a0d6a9-d763-70e1-b4cf-8793e971b512",
                                       deliveredAt: "2026-10-09T00:29:37.104Z")

    /// One `user` event exactly as the server stores it, decoded through `RunEvent`: the wire path a
    /// client actually gets.
    private func echo(_ card: String?, text: String = OwnerAnswerTests.told) throws -> RunEvent {
        let field = card.map { ", \"ownerAnswer\": \($0)" } ?? ""
        let json = """
            {"seq": 9, "type": "user", "turnId": "turn-answer", "ts": "2026-10-09T00:29:38.000Z",
             "payload": {"text": \(Self.jsonString(text))\(field)}}
            """
        return try JSONDecoder().decode(RunEvent.self, from: Data(json.utf8))
    }

    private static func jsonString(_ text: String) -> String {
        String(decoding: try! JSONEncoder().encode(text), as: UTF8.self)
    }

    private func onlyUser(_ reducer: TranscriptReducer) throws -> UserBubble {
        let users = reducer.state.items.compactMap { item -> UserBubble? in
            guard case .user(let b) = item else { return nil }
            return b
        }
        XCTAssertEqual(users.count, 1)
        return try XCTUnwrap(users.first)
    }

    // MARK: - the payload

    func testReadsEveryFieldOfTheCard() throws {
        XCTAssertEqual(OwnerAnswer.parse(try echo(card).payload), expected)
        let declined = card.replacingOccurrences(of: "COORDINATOR_QUESTION", with: "DONE_REQUEST")
        XCTAssertEqual(OwnerAnswer.parse(try echo(declined).payload)?.kind, .doneRequest,
                       "the owner's Not yet… to a request to record the project done is the same card")
    }

    /// A payload missing what makes it a card — or one of a kind this end does not know, or a moment
    /// that is not one — is no card at all, never half of one: the turn keeps its old reading.
    func testAPayloadThatIsNotACardIsNone() throws {
        let broken = [
            card.replacingOccurrences(of: "\"01a0d6a9-d763-70e1-b4cf-8793e971b511\"", with: "\"\""),
            card.replacingOccurrences(of: "COORDINATOR_QUESTION", with: "TASK_FAILED"),
            card.replacingOccurrences(of: "\"01a0d6a9-d763-70e1-b4cf-8793e971b512\"", with: "42"),
            card.replacingOccurrences(of: "2026-10-09T00:29:37.104Z", with: "yesterday"),
            "{\"itemId\": \"i\", \"kind\": \"COORDINATOR_QUESTION\", \"sessionId\": \"s\"}",
            "\"Sent to the coordinator\"",
            "null",
        ]
        for payload in broken {
            XCTAssertNil(OwnerAnswer.parse(try echo(payload).payload), payload)
        }
        XCTAssertNil(OwnerAnswer.parse(try echo(nil).payload), "an ordinary message is no answer")
    }

    // MARK: - the transcript

    /// The echo becomes a row carrying the card, with the words kept whole for the sheet behind it.
    func testTheEchoCarriesTheCardAndKeepsItsWords() throws {
        var reducer = TranscriptReducer()
        reducer.apply(try echo(card))
        let b = try onlyUser(reducer)
        XCTAssertEqual(b.ownerAnswer, expected)
        XCTAssertEqual(b.text, Self.told)
        XCTAssertEqual(b.cards, TurnCards(ownerAnswer: expected))

        var plain = TranscriptReducer()
        plain.apply(try echo(nil))
        XCTAssertNil(try onlyUser(plain).ownerAnswer, "the same words with no card stay the bubble they were")
    }

    /// A transcript cached to disk keeps the card, and one cached before it existed keeps the bubble.
    func testASnapshotKeepsTheCard() throws {
        let bubble = UserBubble(id: "u1", text: Self.told, pending: false, ownerAnswer: expected)
        let stored = try JSONEncoder().encode(bubble)
        XCTAssertEqual(try JSONDecoder().decode(UserBubble.self, from: stored).ownerAnswer, expected)
        let older = Data("{\"id\": \"u1\", \"text\": \"hi\", \"pending\": false}".utf8)
        XCTAssertNil(try JSONDecoder().decode(UserBubble.self, from: older).ownerAnswer)
    }

    // MARK: - the line

    /// The line says what a version handed to its coordinator says, on the same clock.
    func testTheLineSaysWhatAVersionHandedToTheCoordinatorSays() throws {
        let sameDay = try XCTUnwrap(ThinkingSummary.date("2026-10-09T00:45:00.000Z"))
        let line = OwnerAnswerCard.line(expected, now: sameDay)
        XCTAssertEqual(line, EvidenceDecisions.sentLine(expected.deliveredAt, now: sameDay))
        XCTAssertEqual(line, "\(EvidenceDecisions.sentToCoordinator) · \(EvidenceDecisions.receiptTime(expected.deliveredAt, now: sameDay))")
        XCTAssertTrue(line.hasPrefix("Sent to the coordinator · "))
        let later = try XCTUnwrap(ThinkingSummary.date("2026-10-12T09:00:00.000Z"))
        XCTAssertNotEqual(OwnerAnswerCard.line(expected, now: later), line, "another day says the date as well")
    }

    /// A line inside the coordinator's work, not the head of a round: the sticky bar keeps naming the
    /// question above it, as the web's line carries no `data-sticky-label`.
    func testTheStickyBarDoesNotPointAtTheLine() {
        XCTAssertFalse(StickySummary.isAnchor(text: Self.told, ownerAnswer: expected))
        XCTAssertTrue(StickySummary.isAnchor(text: Self.told), "with no card it is the reader's message, as before")
    }

    // MARK: - the question's own card (docs/mocks/owner-answer-sent-card/merged.html)
    //
    // The web suite's half is `OwnerAnswerLine.test.tsx` ("the question's own card"); the rule is held to
    // the browser's by `OwnerAnswerCopyParityTests`.

    private static let answeredAt = "2026-10-09T00:29:36.828Z"

    /// The record the open-items read publishes for the answered question.
    private func record(_ itemId: String = "01a0d6a9-d763-70e1-b4cf-8793e971b511",
                        at resolved: String = OwnerAnswerTests.answeredAt) -> ProjectClosedQuestion {
        ProjectClosedQuestion(itemId: itemId, question: CoordinatorQuestion(question: "请批准重开灰度。",
                                                                            options: [.init(label: "现在重开")]),
                              askedAt: "2026-10-09T00:10:00.000Z", resolvedAt: resolved,
                              answer: .init(option: 0), delivery: .init(sessionId: "C1", at: resolved))
    }

    private func answer(_ kind: OwnerAnswer.Kind = .coordinatorQuestion,
                        item: String = "01a0d6a9-d763-70e1-b4cf-8793e971b511") -> OwnerAnswer {
        OwnerAnswer(itemId: item, kind: kind, sessionId: "01a0d6a9-d763-70e1-b4cf-8793e971b512",
                    deliveredAt: "2026-10-09T00:29:37.104Z")
    }

    /// The turn that hands the answer over, echoed.
    private func turn(_ card: OwnerAnswer?, id: String = "told") -> UserBubble {
        UserBubble(id: id, text: Self.told, ts: "2026-10-09T00:29:38.000Z", pending: false, ownerAnswer: card)
    }

    /// The same turn still on the queue behind the coordinator's running turn, as the server lists it:
    /// written by the control plane, so it waits in the transcript's tail and not in the tray.
    private func waiting(_ card: OwnerAnswer?, authoredByOrbit: Bool = true) -> UserBubble {
        UserBubble(id: "queued-told", text: Self.told, turnId: "tq1", pending: true, queued: true,
                   ownerAnswer: card, authoredByOrbit: authoredByOrbit)
    }

    private func assistant(_ id: String, _ ts: String) -> TranscriptItem {
        .assistant(AssistantBubble(id: id, text: "…", streamingText: "", seq: 1, turnId: "t", ts: ts))
    }

    private func rows(_ state: TranscriptState, records: [ProjectClosedQuestion]) -> [String] {
        let cards = records.map {
            DeliveredDecisionCard(kind: .coordinatorQuestionRecord(record: $0), placement: .at($0.resolvedAt))
        }
        return TranscriptRows.build(state: state, statusCards: [], canPageOlder: false,
                                    showWorkingIndicator: false, decisionCards: cards).map(\.id)
    }

    /// The open-items read and the turn's card each name the item, and either may have been served in
    /// the other spelling.
    func testTheItemKeyIsOneSpellingWhicheverTheReadUsed() {
        let uuid = "01a0d6a9-d763-70e1-b4cf-8793e971b511"
        let base62 = PublicID.toPublic(uuid)
        XCTAssertNotEqual(base62, uuid)
        XCTAssertEqual(OwnerAnswer.itemKey(base62), OwnerAnswer.itemKey(uuid))
        XCTAssertEqual(OwnerAnswer.itemKey(uuid.uppercased()), OwnerAnswer.itemKey(uuid))
        XCTAssertEqual(OwnerAnswer.itemKey("Q1"), OwnerAnswer.itemKey("Q1"), "an id that is neither is still a key")
        XCTAssertNotEqual(OwnerAnswer.itemKey("Q1"), OwnerAnswer.itemKey("Q2"))
    }

    /// The turn is the question's card where the conversation holds the question's record — by the item
    /// in one spelling — and the line everywhere else: a Not yet… to a done request has no card, and a
    /// question the conversation does not hold cannot be drawn.
    func testATurnHandingAQuestionsAnswerOverIsThatQuestionsCard() {
        let held = CoordinatorQuestions.held(drawn: [], read: ProjectOpenItemsView(closedQuestions: [record()]))
        XCTAssertEqual(OwnerAnswer.record(of: answer(), in: held), record())
        XCTAssertEqual(OwnerAnswer.record(of: answer(item: PublicID.toPublic(answer().itemId)), in: held), record(),
                       "the card served in the other spelling is the same question")
        XCTAssertNil(OwnerAnswer.record(of: answer(.doneRequest), in: held), "a Not yet… keeps its line")
        XCTAssertNil(OwnerAnswer.record(of: answer(item: "01a0d6a9-d763-70e1-b4cf-8793e971b5ff"), in: held),
                     "a question the conversation holds no record of keeps its line")
        XCTAssertNil(OwnerAnswer.record(of: answer(), in: [:]), "anywhere that reads no open items keeps the line")
    }

    /// The records a conversation holds: the ones it draws — which keep what the read has let go of, and
    /// the copy drawn from a press until the read has it — over the read's own.
    func testTheConversationHoldsTheRecordsItDrawsElseTheReads() {
        let drawn = record(at: "2026-10-09T00:30:00.000Z")
        let older = record("01a0d6a9-d763-70e1-b4cf-8793e971b5aa")
        let held = CoordinatorQuestions.held(
            drawn: [DeliveredDecisionCard(kind: .coordinatorQuestionRecord(record: drawn)),
                    DeliveredDecisionCard(kind: .coordinatorQuestion(itemID: "open-1"))],
            read: ProjectOpenItemsView(closedQuestions: [record(PublicID.toPublic(drawn.itemId))]))
        XCTAssertEqual(held[OwnerAnswer.itemKey(drawn.itemId)], drawn, "the drawn copy wins, in either spelling")
        XCTAssertEqual(held.count, 1, "an open question is no record")
        let fromRead = CoordinatorQuestions.held(drawn: [], read: ProjectOpenItemsView(closedQuestions: [older]))
        XCTAssertEqual(fromRead[OwnerAnswer.itemKey(older.itemId)], older)
        XCTAssertTrue(CoordinatorQuestions.held(drawn: [], read: nil).isEmpty)
    }

    /// The card is drawn once, by the turn: the conversation does not draw the record again at the moment
    /// the question was answered. Another question's record stays where it ended.
    func testTheConversationDoesNotDrawTheRecordASecondTime() {
        let other = record("01a0d6a9-d763-70e1-b4cf-8793e971b5aa", at: "2026-10-09T00:25:00.000Z")
        var state = TranscriptState()
        state.items = [assistant("asked", "2026-10-09T00:10:00.000Z"), assistant("working", "2026-10-09T00:20:00.000Z"),
                       .user(turn(answer(item: PublicID.toPublic(answer().itemId)))),
                       assistant("reply", "2026-10-09T00:30:00.000Z")]
        XCTAssertEqual(OwnerAnswer.handedOver(state), [OwnerAnswer.itemKey(answer().itemId)])
        XCTAssertEqual(rows(state, records: [record(), other]),
                       ["asked", "working", "question-record-01a0d6a9-d763-70e1-b4cf-8793e971b5aa", "told", "reply",
                        "transcript-bottom"])
    }

    /// A turn still on the queue is the card too, dashed at the tail: the record is not drawn at its
    /// moment either. Nor is it for the accepted head, which waits on its echo where the echo will land.
    func testATurnStillOnTheQueueOrAcceptedHandsItOverToo() {
        var state = TranscriptState()
        state.items = [assistant("asked", "2026-10-09T00:10:00.000Z"), assistant("working", "2026-10-09T00:40:00.000Z")]
        state.queued = [waiting(answer())]
        XCTAssertEqual(rows(state, records: [record()]), ["asked", "working", "queued-queued-told", "transcript-bottom"])

        var accepted = TranscriptState()
        accepted.items = state.items
        accepted.accepted = [turn(answer(), id: "accepted-told")]
        XCTAssertEqual(rows(accepted, records: [record()]), ["asked", "working", "accepted-told", "transcript-bottom"])

        // What waits in the tray is not drawn in the tail, so it is not the card either: an answer's turn
        // never is one (the server writes it), but the rule is the one the rows are drawn by.
        var tray = TranscriptState()
        tray.items = state.items
        tray.queued = [waiting(answer(), authoredByOrbit: false)]
        XCTAssertTrue(OwnerAnswer.handedOver(tray).isEmpty)
    }

    /// Everything else leaves the record where it ended: a Not yet… to a done request, and a turn that
    /// carries no card at all.
    func testANotYetAndAnOrdinaryTurnLeaveTheRecordWhereItEnded() {
        var state = TranscriptState()
        state.items = [assistant("asked", "2026-10-09T00:10:00.000Z"), .user(turn(answer(.doneRequest))),
                       .user(turn(nil, id: "plain")), assistant("reply", "2026-10-09T00:40:00.000Z")]
        XCTAssertTrue(OwnerAnswer.handedOver(state).isEmpty)
        XCTAssertEqual(rows(state, records: [record()]),
                       ["asked", "question-record-01a0d6a9-d763-70e1-b4cf-8793e971b511", "told", "plain", "reply",
                        "transcript-bottom"])
    }

    /// The card's sheet folds the words the coordinator was told: those of the turn that handed this
    /// question over — the newest, in either spelling — and none for a question no turn handed over.
    func testTheSheetFindsTheTurnThatToldTheCoordinator() {
        var state = TranscriptState()
        state.items = [.user(turn(answer(.doneRequest), id: "not-yet")),
                       .user(turn(answer(item: PublicID.toPublic(answer().itemId)), id: "told"))]
        XCTAssertEqual(OwnerAnswer.handover(of: answer().itemId, in: state)?.id, "told")
        XCTAssertEqual(OwnerAnswer.handover(of: answer().itemId, in: state)?.text, Self.told)
        XCTAssertNil(OwnerAnswer.handover(of: "01a0d6a9-d763-70e1-b4cf-8793e971b5ff", in: state))
        state.queued = [waiting(answer())]
        XCTAssertEqual(OwnerAnswer.handover(of: answer().itemId, in: state)?.id, "queued-told", "the newest turn")
    }
}
