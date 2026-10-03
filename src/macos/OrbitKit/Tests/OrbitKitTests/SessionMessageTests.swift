import Foundation
import XCTest
@testable import OrbitKit

/// Another Orbit session's message is drawn from who the control plane recorded as sending it
/// (`sessionMessage`) — never as the account owner's own bubble, and never from the words.
///
/// `session_send` and `project_send` write a turn into this conversation that the owner did not type.
/// These tests are the native half of the pair the web is held to (`SessionMessageCard.test.tsx`):
/// with the payload the turn carries the card, the bar names the sender, and the block delivery
/// appended stays the control plane's note; without one — the same words — the turn is exactly the
/// bubble it was before any of this existed. `SessionMessageCopyParityTests` holds the words to the
/// browser's, and `SessionMessageWiringTests` holds both shells to drawing the card.
final class SessionMessageTests: XCTestCase {

    // MARK: - the payload, as the apiserver writes it (sessions/session-message.ts)

    static let sender = "01a0cca7-8609-70ed-a0e2-d4b55b832b60"
    static let task = "01a0cca0-aeaa-7618-bd5a-caccc089108c"
    static let words = "The landing on criterion 3 needs a merge decision — the evidence is on the task."
    /// The block delivery appended, recorded as the control plane's note.
    static let note = """


        <orbit-session-message from-session="34YCLEOsvlZDk31Ma1xAy" from-title="Worker: criterion 3" from-agent="orbit" task="34YR26Xq9PRtbB4nPYmPq">
        这条消息来自另一个 Orbit 会话，不是账号 owner 本人。
        </orbit-session-message>
        """

    private let card = """
        {"fromSessionId": "\(SessionMessageTests.sender)",
         "fromTitle": "Worker: criterion 3",
         "fromAgentName": "orbit",
         "fromTaskId": "\(SessionMessageTests.task)"}
        """

    private static func jsonString(_ text: String) -> String {
        String(decoding: try! JSONEncoder().encode(text), as: UTF8.self)
    }

    /// One `user` event exactly as the server stores it — the echo whole, the note beside it, and the
    /// card when there was one — decoded through `RunEvent`, the wire path a client actually gets.
    private func sent(_ card: String?) throws -> RunEvent {
        var fields = [
            "\"text\": \(Self.jsonString(Self.words + Self.note))",
            "\"controlPlaneNote\": \(Self.jsonString(Self.note))",
        ]
        if let card { fields.append("\"sessionMessage\": \(card)") }
        let json = """
            {"seq": 9, "type": "user", "turnId": "turn-sent", "ts": "2026-10-01T15:40:00.000Z",
             "payload": {\(fields.joined(separator: ", "))}}
            """
        return try JSONDecoder().decode(RunEvent.self, from: Data(json.utf8))
    }

    private func bubble(_ reducer: TranscriptReducer) throws -> UserBubble {
        try XCTUnwrap(reducer.state.items.first.flatMap { item -> UserBubble? in
            guard case .user(let b) = item else { return nil }
            return b
        })
    }

    // MARK: - (a) reading the payload

    func testReadsEveryFieldOfACard() throws {
        XCTAssertEqual(SessionMessage.parse(try sent(card).payload), SessionMessage(
            fromSessionId: Self.sender, fromTitle: "Worker: criterion 3", fromAgentName: "orbit",
            fromTaskId: Self.task))
    }

    func testIsACardOnlyWithTheSessionThatSentIt() throws {
        for bad in ["{\"fromTitle\": \"Worker\"}", "{\"fromSessionId\": \"\"}", "{\"fromSessionId\": 42}",
                    "\"from a session\"", "null"] {
            XCTAssertNil(SessionMessage.parse(try sent(bad).payload), "drew a card from \(bad)")
        }
        // Everything else defaults, exactly as the web's reader defaults it: a task left out, or
        // left empty, is no task.
        let bare = try XCTUnwrap(SessionMessage.parse(try sent(
            "{\"fromSessionId\": \"\(Self.sender)\", \"fromTaskId\": \"\"}").payload))
        XCTAssertEqual(bare, SessionMessage(fromSessionId: Self.sender))
    }

    // MARK: - (b) the transcript

    func testAMessageWithNoCardStaysTheBubbleItAlwaysWas() throws {
        var reducer = TranscriptReducer()
        reducer.apply(try sent(nil))
        let b = try bubble(reducer)
        XCTAssertNil(b.sessionMessage)
        XCTAssertEqual(b.text, Self.words, "the recorded note is still taken out of the words")
        XCTAssertEqual(StickySummary.of(text: b.text, note: b.note, sessionMessage: b.sessionMessage).label,
                       StickySummary.yourQuestion)
    }

    func testAMessageWithACardCarriesItKeepsTheWordsAndNamesTheBar() throws {
        var reducer = TranscriptReducer()
        reducer.apply(try sent(card))
        let b = try bubble(reducer)
        XCTAssertEqual(b.sessionMessage?.fromSessionId, Self.sender)
        // The words are the sender's; the block is the control plane's entry, named for what it is.
        XCTAssertEqual(b.text, Self.words)
        XCTAssertEqual(b.attached?.kind, "session message")
        // Not "Your question": who asked it.
        let sticky = StickySummary.of(text: b.text, note: b.note, itemCard: b.itemCard,
                                      taskStart: b.taskStart, startedCard: b.startedCard,
                                      sessionMessage: b.sessionMessage)
        XCTAssertEqual(sticky.label, "↑ From Worker: criterion 3")
        XCTAssertEqual(sticky.text, Self.words)
        XCTAssertTrue(StickySummary.isAnchor(text: b.text, note: b.note, sessionMessage: b.sessionMessage))
    }

    func testTheEchoOfAPendingBubbleTakesTheCard() throws {
        // A row already standing for this turn is reconciled in place, and the card is the event's
        // own: it rides whichever row ends up drawing the turn.
        var reducer = TranscriptReducer()
        reducer.addOptimisticUser(clientTurnId: "local", text: Self.words)
        reducer.setOptimisticTurnId(clientTurnId: "local", turnId: "turn-sent")
        reducer.apply(try sent(card))
        XCTAssertEqual(reducer.state.items.count, 1)
        XCTAssertEqual(try bubble(reducer).sessionMessage?.fromTitle, "Worker: criterion 3")
    }

    func testASnapshotFromBeforeTheCardStillRehydrates() throws {
        let old = #"{"id": "u1", "text": "hi", "pending": false}"#
        let restored = try JSONDecoder().decode(UserBubble.self, from: Data(old.utf8))
        XCTAssertNil(restored.sessionMessage)

        let withCard = UserBubble(id: "u2", text: Self.words, pending: false,
                                  sessionMessage: SessionMessage(fromSessionId: Self.sender, fromTitle: "Worker"))
        let roundTrip = try JSONDecoder().decode(UserBubble.self, from: try JSONEncoder().encode(withCard))
        XCTAssertEqual(roundTrip.sessionMessage, withCard.sessionMessage)
    }

    // MARK: - (c) what the card says

    func testNamesTheSenderLinksItAndItsTaskAndSaysWhoThisIsNot() throws {
        let full = SessionMessage(fromSessionId: Self.sender, fromTitle: "  Worker: criterion 3 ",
                                  fromAgentName: "orbit", fromTaskId: Self.task)
        XCTAssertEqual(SessionMessageCard.title(full), "Worker: criterion 3")
        XCTAssertEqual(SessionMessageCard.title(SessionMessage(fromSessionId: Self.sender, fromTitle: " ")),
                       "Untitled session")
        XCTAssertEqual(SessionMessageCard.sessionLink(full)?.absoluteString, "orbit-session:\(Self.sender)")
        XCTAssertEqual(SessionMessageCard.taskLink(full)?.absoluteString, "orbit-task:\(Self.task)")
        // A sender that runs no task links none, and an id that names nothing is no link at all.
        XCTAssertNil(SessionMessageCard.taskLink(SessionMessage(fromSessionId: Self.sender)))
        XCTAssertNil(SessionMessageCard.sessionLink(SessionMessage(fromSessionId: "not-an-id")))
        XCTAssertEqual(SessionMessageCard.meta(), "Sent by another Orbit session, not by you")
        let now = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-10-01T15:42:00Z"))
        XCTAssertTrue(SessionMessageCard.meta(ts: "2026-10-01T15:40:00.000Z", now: now)
            .hasPrefix("Sent by another Orbit session, not by you · "))
    }
}
