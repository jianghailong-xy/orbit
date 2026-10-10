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
}
