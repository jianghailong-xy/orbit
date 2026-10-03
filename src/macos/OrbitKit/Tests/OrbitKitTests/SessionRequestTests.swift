import Foundation
import XCTest
@testable import OrbitKit

/// Session requests on the native clients (docs/session-request-reply-contract.md §6): the recipient's
/// card knows the message is a request and reads its state live; the asker's turn that handed
/// outcomes back carries reply cards, not the owner's words; a live summary clears the session's
/// open request peers when the request closes. The native half of the pair the web
/// is held to (`SessionReplyCard.test.tsx`). `SessionRequestCopyParityTests` holds the words to the
/// browser's, and `SessionRequestWiringTests` holds both shells to drawing the cards.
final class SessionRequestTests: XCTestCase {

    static let asker = "01a0cca7-8609-70ed-a0e2-d4b55b832b60"
    static let recipient = "01a0cca0-aeaa-7618-bd5a-caccc089108c"
    static let requestTurn = "01a0cca9-1111-7222-8333-444455556666"

    private static func jsonString(_ text: String) -> String {
        String(decoding: try! JSONEncoder().encode(text), as: UTF8.self)
    }

    private static let replied = """
        {"requestId": "34YfReq0000000000000000", "outcome": "REPLIED",
         "fromSessionId": "\(recipient)", "fromTitle": "Coordinator",
         "requestTurnId": "\(requestTurn)", "requestPreview": "merge now or wait for review?",
         "replyText": "the reviewer is back at 3", "replyOption": 1, "replyOptionLabel": "wait for review",
         "closedAt": "2026-10-02T10:00:00.000Z"}
        """

    /// One `user` event of the asking session exactly as the server stores it: the echo whole, the
    /// note beside it, and the cards.
    private func handedBack(_ cards: String?, words: String = "") throws -> RunEvent {
        let blocks = "<orbit-session-reply request-id=\"34YfReq0000000000000000\" outcome=\"REPLIED\">\n你问的是：…\n</orbit-session-reply>"
        let note = words.isEmpty ? blocks : "\n\n\(blocks)"
        var fields = [
            "\"text\": \(Self.jsonString(words + note))",
            "\"controlPlaneNote\": \(Self.jsonString(note))",
        ]
        if let cards { fields.append("\"sessionReplies\": \(cards)") }
        let json = """
            {"seq": 12, "type": "user", "turnId": "turn-reply", "ts": "2026-10-02T10:00:05.000Z",
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

    // MARK: - the recipient's card

    func testTheMessageCardNamesTheRequestItIs() throws {
        let card = try XCTUnwrap(SessionMessage.parseCard(.object([
            "fromSessionId": .string(Self.asker), "requestId": .string("34YfReq0000000000000000"),
        ])))
        XCTAssertEqual(card.requestId, "34YfReq0000000000000000")
        // A message that asked for nothing names no request — and an empty one is none.
        XCTAssertNil(SessionMessage.parseCard(.object(["fromSessionId": .string(Self.asker)]))?.requestId)
        XCTAssertNil(SessionMessage.parseCard(.object([
            "fromSessionId": .string(Self.asker), "requestId": .string(""),
        ]))?.requestId)
    }

    func testTheRequestIsReadAsTheServerAnswersIt() throws {
        let json = """
            {"requestId": "34YfReq0000000000000000", "state": "OPEN", "fromSessionId": "\(Self.asker)",
             "fromTitle": "Worker", "toSessionId": "\(Self.recipient)", "toTitle": "Coordinator",
             "requestPreview": "merge?", "replyOptions": [{"label": "now"}, {"label": "later", "description": "after review"}],
             "replyBy": "2026-10-02T18:00:00.000Z", "createdAt": "2026-10-02T09:00:00.000Z"}
            """
        let view = try JSONDecoder().decode(SessionRequestView.self, from: Data(json.utf8))
        XCTAssertEqual(view.state, .open)
        XCTAssertEqual(view.replyOptions?.last?.description, "after review")
        XCTAssertEqual(SessionRequestCopy.stateLabel(.open), "Waiting for a reply")
        // An outcome this client has never heard of reads as no state rather than failing the card.
        let newer = json.replacingOccurrences(of: "\"OPEN\"", with: "\"SOMETHING_NEW\"")
        XCTAssertNil(try JSONDecoder().decode(SessionRequestView.self, from: Data(newer.utf8)).state)
    }

    func testTheStatusLineSaysTheDeadlineOnlyWhileItWaits() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let now = try XCTUnwrap(RelativeTime.parse("2026-10-02T09:00:00.000Z"))
        let open = SessionRequestView(requestId: "r", state: .open, replyBy: "2026-10-02T18:00:00.000Z")
        XCTAssertEqual(SessionRequestCopy.statusLine(open, now: now, calendar: calendar), "Asked for a reply · due 18:00")
        let tomorrow = SessionRequestView(requestId: "r", state: .open, replyBy: "2026-10-03T08:30:00Z")
        XCTAssertEqual(SessionRequestCopy.statusLine(tomorrow, now: now, calendar: calendar), "Asked for a reply · due Oct 3, 08:30")
        let closed = SessionRequestView(requestId: "r", state: .closed(.replied), replyBy: "2026-10-02T18:00:00.000Z")
        XCTAssertEqual(SessionRequestCopy.statusLine(closed, now: now, calendar: calendar), "Asked for a reply")
        XCTAssertEqual(SessionRequestCopy.statusLine(nil), "Asked for a reply", "before the first read")
    }

    // MARK: - the asker's turn

    func testAHandedBackTurnCarriesItsOutcomesAsCards() throws {
        var reducer = TranscriptReducer()
        reducer.apply(try handedBack("[\(Self.replied)]"))
        let b = try bubble(reducer)
        let replies = try XCTUnwrap(b.sessionReplies)
        XCTAssertEqual(replies.count, 1)
        XCTAssertEqual(replies[0].outcome, .replied)
        XCTAssertEqual(replies[0].fromSessionId, Self.recipient)
        XCTAssertEqual(replies[0].replyOption, 1)
        XCTAssertEqual(replies[0].replyOptionLabel, "wait for review")
        XCTAssertEqual(b.text, "", "the reply turn carries nobody's words")
        // The way back to the original request: the asked session, at the request's own turn.
        let link = try XCTUnwrap(SessionRequestCopy.requestLink(replies[0])).absoluteString
        XCTAssertTrue(link.contains(PublicID.toPublic(Self.recipient)), link)
        XCTAssertTrue(link.contains("at=\(PublicID.toPublic(Self.requestTurn))"), link)
    }

    func testCardsThatNameNothingAreNotDrawn() throws {
        XCTAssertNil(SessionReply.parse(.object(["sessionReplies": .array([
            .object(["requestId": .string("r"), "outcome": .string("MAYBE"), "fromSessionId": .string(Self.recipient)]),
            .object(["requestId": .string(""), "outcome": .string("REPLIED"), "fromSessionId": .string(Self.recipient)]),
            .string("a card"),
        ])])))
        XCTAssertNil(SessionReply.parse(.object(["text": .string("hi")])))
        var reducer = TranscriptReducer()
        reducer.apply(try handedBack(nil, words: "an ordinary message"))
        XCTAssertNil(try bubble(reducer).sessionReplies)
    }

    func testTheReplyBlocksLeaveTheNoteToWhatElseWasAppended() {
        let block = "<orbit-session-reply request-id=\"a\" outcome=\"REPLIED\">\n回复：ok\n</orbit-session-reply>"
        XCTAssertEqual(SessionReply.withoutReplyBlocks(block), "")
        XCTAssertEqual(SessionReply.withoutReplyBlocks("\(block)\n\n<background-jobs>\n…\n</background-jobs>"),
                       "<background-jobs>\n…\n</background-jobs>")
        XCTAssertEqual(SessionReply.withoutReplyBlocks(nil), "")
        XCTAssertEqual(describeNote(block), "session reply")
    }

    // MARK: - the list

    func testALiveSummaryClearsThePeersWhenTheRequestCloses() throws {
        let row = try JSONDecoder().decode(Session.self, from: Data("""
            {"id":"s1","status":"AWAITING_INPUT","pendingApprovals":0,
             "awaitingReplyFrom":[{"requestId":"r1","sessionId":"\(Self.recipient)","title":"Coordinator"}],
             "owesReplyTo":[]}
            """.utf8))
        XCTAssertEqual(row.awaitingReplyFrom?.first?.title, "Coordinator")
        // An older control plane says nothing about it: the row keeps what it knows.
        let older = try JSONDecoder().decode(ControlSessionSummary.self, from: Data("""
            {"id":"s1","status":"AWAITING_INPUT","pendingApprovals":0}
            """.utf8))
        XCTAssertEqual(row.applying(older).awaitingReplyFrom?.count, 1)
        // This server says none is open any more: the row lets go of it.
        let closed = try JSONDecoder().decode(ControlSessionSummary.self, from: Data("""
            {"id":"s1","status":"AWAITING_INPUT","pendingApprovals":0,"awaitingReplyFrom":[],"owesReplyTo":[]}
            """.utf8))
        XCTAssertEqual(row.applying(closed).awaitingReplyFrom, [])
        XCTAssertEqual(row.applying(closed).owesReplyTo, [])
    }
}
