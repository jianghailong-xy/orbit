import Foundation
import XCTest
@testable import OrbitKit

/// Who re-sends what a failure card's Retry offers (docs/session-request-reply-contract.md §2.1,
/// §8 criterion 15): the console's own send for the reader's words, the server for another Orbit
/// session's. The decision is `RetryRoute`; `RetrySendWiringTests` holds the console to calling it.
final class RetryRouteTests: XCTestCase {

    private let worker = SessionMessage(fromSessionId: "7nZQb2kQGx3v9pWm1aLrT", fromTitle: "Worker: criterion 3",
                                        fromAgentName: "orbit-worker", requestId: "2Lm8kQGx3v9pWm1aLrTzQ")

    func testTheReadersOwnWordsGoThroughTheConsolesSend() {
        XCTAssertEqual(RetryRoute.of(loadedText: "merge now?", loadedSender: nil, serverText: "", serverSender: nil),
                       .send("merge now?"))
    }

    func testAnotherSessionsWordsAreReSentByTheServer() {
        XCTAssertEqual(RetryRoute.of(loadedText: "merge now?", loadedSender: worker, serverText: "", serverSender: nil),
                       .serverResend, "another session's words went through the owner's own send")
    }

    /// The bubble on screen decides when there is one — the same precedence the words have — so a stale
    /// server answer cannot re-route the reader's own message, nor the other way round.
    func testWhatIsOnScreenDecidesBeforeTheServersAnswer() {
        XCTAssertEqual(RetryRoute.of(loadedText: "mine", loadedSender: nil, serverText: "theirs", serverSender: worker),
                       .send("mine"))
        XCTAssertEqual(RetryRoute.of(loadedText: "theirs", loadedSender: worker, serverText: "theirs", serverSender: nil),
                       .serverResend)
    }

    /// A run's message is thousands of events behind the window: the server's answer says whose it is.
    func testAWindowWithNoBubbleTakesTheServersWordAboutWhoseTheyAre() {
        XCTAssertEqual(RetryRoute.of(loadedText: "", loadedSender: nil, serverText: "the task's words", serverSender: worker),
                       .serverResend)
        XCTAssertEqual(RetryRoute.of(loadedText: "", loadedSender: nil, serverText: "the task's words", serverSender: nil),
                       .send("the task's words"))
    }

    func testNothingToReSendOffersNothing() {
        XCTAssertEqual(RetryRoute.of(loadedText: "", loadedSender: nil, serverText: "", serverSender: worker), .nothing)
    }

    /// The server's answer as the wire carries it: the card beside the words when they are another
    /// session's, and no card at all for the owner's own.
    func testTheServersAnswerCarriesTheSendersCard() throws {
        let theirs = try JSONDecoder().decode(RetryMessage.self, from: Data(#"""
            {"text":"merge now?","sessionMessage":{"fromSessionId":"7nZQb2kQGx3v9pWm1aLrT","fromTitle":"Worker: criterion 3","fromAgentName":"orbit-worker","requestId":"2Lm8kQGx3v9pWm1aLrTzQ"}}
            """#.utf8))
        XCTAssertEqual(theirs.text, "merge now?")
        XCTAssertEqual(theirs.sessionMessage, worker)
        let own = try JSONDecoder().decode(RetryMessage.self, from: Data(#"{"text":"merge now?"}"#.utf8))
        XCTAssertNil(own.sessionMessage)
    }

    /// What the Retry posts: nothing at all — no key to spell a second turn with, and nothing a caller
    /// could use to name somebody else as the sender. The idempotency key is the server's, derived from
    /// the failed message (§2.1, criterion 19).
    func testTheReSendCarriesNothingButTheDoor() throws {
        let body = try JSONEncoder().encode(RetryResendRequest())
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(object.keys.sorted(), [])
    }
}
