import Foundation
import XCTest
@testable import OrbitKit

/// Translation failure policy B (docs/ux/translation-failure-policy.html): a held message's and a card
/// answer's failure line names why (frames 4B and 5, the B column of frame 7), Retry and Send as written
/// after it; no reason draws today's generic line; and while the server skips a failing translator the
/// composer tag says messages will wait (frame 6). The words are the web's, byte for byte.
final class TranslationFailureReasonCopyTests: XCTestCase {

    private let retryAndSend: [SessionTranslation.FootPart] = [.action("Retry", .retryTurn),
                                                              .action("Send as written", .sendAsWritten)]

    /// Frame 7, B column: each reason (and HTTP status) with the sentence a held message draws.
    private let messageLines: [(TranslationFailureReason, Int?, String)] = [
        (.timeout, nil, "The translator didn't answer in time, so it wasn't sent"),
        (.network, nil, "The translator was unreachable, so it wasn't sent"),
        (.http, 429, "The translator was unreachable, so it wasn't sent"),
        (.http, 500, "The translator was unreachable, so it wasn't sent"),
        (.http, 503, "The translator was unreachable, so it wasn't sent"),
        (.http, 400, "The translator refused the message, so it wasn't sent"),
        (.http, 401, "The translator refused the message, so it wasn't sent"),
        (.http, 404, "The translator refused the message, so it wasn't sent"),
        (.truncated, nil, "Too long to translate, so it wasn't sent"),
        (.mangled, nil, "The translation came back damaged, so it wasn't sent"),
        (.empty, nil, "The translation came back damaged, so it wasn't sent"),
        (.unavailable, nil, "Translation is unavailable right now, so it wasn't sent"),
    ]

    private func held(_ reason: TranslationFailureReason?, _ status: Int? = nil) -> TurnTranslation {
        TurnTranslation(state: .failed, from: .zhHans, original: "先只写生产环境", failureReason: reason, httpStatus: status)
    }

    private func refusal(_ body: String) -> APIError { .http(status: 422, body: body) }

    // MARK: - A held message (frame 4B)

    func testAHeldMessageSaysWhyBeforeRetryAndSendAsWritten() {
        for (reason, status, line) in messageLines {
            XCTAssertEqual(SessionTranslation.userFoot(held(reason, status), flipped: false),
                           [.text(line)] + retryAndSend, "\(reason) \(status.map(String.init) ?? "-")")
        }
    }

    func testAHeldMessageWithNoReasonKeepsTheGenericLine() {
        let generic: [SessionTranslation.FootPart] = [.text("Couldn't translate, so it wasn't sent")] + retryAndSend
        XCTAssertEqual(SessionTranslation.userFoot(held(nil), flipped: false), generic)
        // Frame 7 has no sentence for these: the generic line, never a guess.
        XCTAssertEqual(SessionTranslation.userFoot(held(.noKey), flipped: false), generic)
        XCTAssertEqual(SessionTranslation.userFoot(held(.http, nil), flipped: false), generic)
        // A reason this build does not know decodes as none, so it draws the generic line too.
        let unknown = TurnTranslation.parse(.object(["state": .string("FAILED"), "from": .string("zh-Hans"),
                                                     "original": .string("x"), "failureReason": .string("NEW_ONE")]))
        XCTAssertEqual(SessionTranslation.userFoot(unknown, flipped: false), generic)
    }

    func testTheReasonReadOffTheTurnListDrawsItsLine() throws {
        let rows = try JSONDecoder().decode([QueuedTurnInfo].self, Data("""
        [{"turnId":"t1","content":"x","translation":{"state":"FAILED","from":"zh-Hans","original":"x","failureReason":"TIMEOUT"}}]
        """.utf8))
        XCTAssertEqual(SessionTranslation.userFoot(rows[0].turnTranslation, flipped: false),
                       [.text("The translator didn't answer in time, so it wasn't sent")] + retryAndSend)
    }

    // MARK: - A card answer (frame 5)

    func testARefusedCardAnswerSaysWhyNamingYourAnswer() throws {
        for (reason, status, line) in messageLines {
            let answerLine = line.replacingOccurrences(of: ", so it wasn't sent", with: ", so your answer wasn't sent")
            XCTAssertTrue(answerLine.hasSuffix(", so your answer wasn't sent"))
            XCTAssertEqual(SessionTranslation.refusedAnswerFoot(reason, httpStatus: status), [.text(answerLine)] + retryAndSend)
            // Read straight off the 422's body.
            let body = status.map { #"{"code":"TRANSLATION_FAILED","message":"x","failureReason":"\#(reason.rawValue)","httpStatus":\#($0)}"# }
                ?? #"{"code":"TRANSLATION_FAILED","message":"x","failureReason":"\#(reason.rawValue)"}"#
            XCTAssertEqual(SessionTranslation.refusedAnswerFoot(after: refusal(body)), [.text(answerLine)] + retryAndSend,
                           body)
        }
        // Frame 5's own example, word for word.
        XCTAssertEqual(SessionTranslation.refusedAnswerFoot(after: refusal(
            #"{"code":"TRANSLATION_FAILED","message":"x","failureReason":"NETWORK"}"#)),
                       [.text("The translator was unreachable, so your answer wasn't sent")] + retryAndSend)
    }

    func testARefusedCardAnswerWithNoReasonKeepsTheGenericLine() {
        let generic: [SessionTranslation.FootPart] = [.text("Couldn't translate, so it wasn't sent")] + retryAndSend
        XCTAssertEqual(SessionTranslation.refusedAnswerFoot(nil), generic)
        XCTAssertEqual(SessionTranslation.refusedAnswerFoot(.noKey), generic)
        XCTAssertEqual(SessionTranslation.refusedAnswerFoot(after: refusal(#"{"code":"TRANSLATION_FAILED"}"#)), generic)
        XCTAssertEqual(SessionTranslation.refusedAnswerFoot(after: refusal(
            #"{"code":"TRANSLATION_FAILED","failureReason":"NEW_ONE"}"#)), generic)
        // The generic line is the one owner cards already draw.
        XCTAssertEqual(SessionTranslation.refusedAnswerFoot(nil), OwnerCardTranslations.refusedFoot)
    }

    func testEveryReasonIsCovered() {
        let named = Set(messageLines.map(\.0)).union([.noKey])
        XCTAssertEqual(named, Set(TranslationFailureReason.allCases))
    }

    // MARK: - The composer tag while unavailable (frame 6)

    func testTheComposerTagWhileTranslationIsUnavailable() throws {
        XCTAssertEqual(TranslationLanguage.zhHans.tag(to: .en, unavailable: true),
                       "Chinese → English · unavailable, messages will wait")
        XCTAssertEqual(TranslationLanguage.zhHans.tag(to: .en, unavailable: false), "Chinese → English")
        XCTAssertEqual(TranslationLanguage.ja.tag(to: .de, unavailable: true),
                       "Japanese → German · unavailable, messages will wait")
        // It reads unavailable exactly while the account's `translationUnavailableUntil` is ahead.
        let me = try JSONDecoder().decode(User.self, Data("""
        {"id":"u1","email":"a@b.c","translationAvailable":true,"translationUnavailableUntil":"2026-11-18T06:01:00.000Z"}
        """.utf8))
        let until = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-11-18T06:01:00Z"))
        func tag(at now: Date) -> String {
            TranslationLanguage.zhHans.tag(to: .en,
                                           unavailable: SessionTranslation.temporarilyUnavailableUntil(me, now: now) != nil)
        }
        XCTAssertEqual(tag(at: until.addingTimeInterval(-30)), "Chinese → English · unavailable, messages will wait")
        XCTAssertEqual(tag(at: until), "Chinese → English")
    }

    /// The server announces opens and closes as `translation.status_changed`: the app reads the account again.
    func testTheTranslationStatusEventReadsTheAccount() throws {
        let ev = try JSONDecoder().decode(ControlEvent.self, Data("""
        {"type":"translation.status_changed","sessionId":"","agentId":null,"ts":"t","data":{}}
        """.utf8))
        XCTAssertEqual(ev.type, .translationStatusChanged)
        XCTAssertEqual(ControlEventRoute.of(ev), .account)
        XCTAssertFalse(ControlEventRoute.of(ev).readsOpenList)
    }
}
