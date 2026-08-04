import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import OrbitKit

/// Which send failures the composer replays, and what it says when it gives up. Reported from iOS:
/// a 503 with an empty body (the gateway, while the apiserver restarted) failed the send outright,
/// printing `Send failed — http(status: 503, body: Optional(""))` over an already-cleared composer —
/// so a message that never reached the server was gone and had to be retyped.
final class ComposerSendRetryTests: XCTestCase {

    /// Nothing reached the app: replay it. Both POST /turns and /resume dedupe on `clientTurnId`
    /// server-side, so the replay can only ever queue the message once.
    func testRetriesServerSideAndTransportFailures() {
        XCTAssertTrue(ComposerLogic.isRetriableSendFailure(APIError.http(status: 503, body: "")))
        XCTAssertTrue(ComposerLogic.isRetriableSendFailure(APIError.http(status: 502, body: nil)))
        XCTAssertTrue(ComposerLogic.isRetriableSendFailure(APIError.http(status: 504, body: nil)))
        XCTAssertTrue(ComposerLogic.isRetriableSendFailure(APIError.http(status: 500, body: nil)))
        XCTAssertTrue(ComposerLogic.isRetriableSendFailure(APIError.invalidResponse))
        XCTAssertTrue(ComposerLogic.isRetriableSendFailure(URLError(.networkConnectionLost)))
        XCTAssertTrue(ComposerLogic.isRetriableSendFailure(URLError(.timedOut)))
        XCTAssertTrue(ComposerLogic.isRetriableSendFailure(URLError(.cannotConnectToHost)))
    }

    /// A 4xx is a verdict on this exact message — replaying it just repeats the same rejection
    /// while the user waits. `.unauthorized` already survived the client's refresh-and-retry, and a
    /// cancelled request is the user's own doing.
    func testDoesNotRetryARejectedMessage() {
        XCTAssertFalse(ComposerLogic.isRetriableSendFailure(
            APIError.http(status: 409, body: "{\"message\":\"the session has ended\"}")))
        XCTAssertFalse(ComposerLogic.isRetriableSendFailure(APIError.http(status: 413, body: nil)))
        XCTAssertFalse(ComposerLogic.isRetriableSendFailure(APIError.http(status: 404, body: nil)))
        XCTAssertFalse(ComposerLogic.isRetriableSendFailure(APIError.unauthorized))
        XCTAssertFalse(ComposerLogic.isRetriableSendFailure(APIError.notConfigured))
        XCTAssertFalse(ComposerLogic.isRetriableSendFailure(URLError(.cancelled)))
    }

    /// Bounded: a few seconds of backoff rides out a restarting apiserver, and then the failure has
    /// to reach the user rather than retry forever behind a spinner.
    func testRetryBudgetIsShort() {
        XCTAssertEqual(ComposerLogic.sendRetryDelaysMs.count, 3)
        XCTAssertLessThanOrEqual(ComposerLogic.sendRetryDelaysMs.reduce(0, +), 10_000)
        XCTAssertEqual(ComposerLogic.sendRetryDelaysMs.sorted(), ComposerLogic.sendRetryDelaysMs,
                       "backs off, never speeds up")
    }

    /// The give-up line has to say what happened and where the message went — the raw
    /// `http(status: 503, body: Optional(""))` said neither.
    func testFailureMessageExplainsAndPointsAtTheRestoredDraft() {
        let unavailable = ComposerLogic.sendFailureMessage(APIError.http(status: 503, body: ""))
        XCTAssertTrue(unavailable.contains("503"), "keeps the status for diagnosis: \(unavailable)")
        XCTAssertFalse(unavailable.contains("Optional"), "no raw enum: \(unavailable)")
        XCTAssertTrue(unavailable.contains("back in the composer"), unavailable)

        // A Nest error body carries the real explanation — surface that instead of the number.
        let ended = ComposerLogic.sendFailureMessage(
            APIError.http(status: 409, body: "{\"message\":\"the session has ended\"}"))
        XCTAssertTrue(ended.contains("the session has ended"), ended)

        // A validation failure sends an array of messages.
        let invalid = ComposerLogic.sendFailureMessage(
            APIError.http(status: 400, body: "{\"message\":[\"content must be a string\"]}"))
        XCTAssertTrue(invalid.contains("content must be a string"), invalid)

        // A non-JSON body is still better than the enum's description.
        let plain = ComposerLogic.sendFailureMessage(APIError.http(status: 502, body: "Bad Gateway"))
        XCTAssertTrue(plain.contains("Bad Gateway"), plain)

        // A transport failure stays in the app's own English rather than the device's locale.
        let dropped = ComposerLogic.sendFailureMessage(URLError(.networkConnectionLost))
        XCTAssertEqual(dropped, "Couldn't send — the connection dropped. Your message is back in the composer.")
    }
}
