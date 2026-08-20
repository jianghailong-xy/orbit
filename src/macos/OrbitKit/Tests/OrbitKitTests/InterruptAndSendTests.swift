import XCTest
@testable import OrbitKit

/// "Stop the current turn and send THIS instead" — when it is offered, and what it puts on the
/// wire. The twin of web's `lib/interruptAndSend.test.ts`; the rule and the request are the same
/// on both, because the safety property lives in the request shape rather than in either client.
///
/// Stopping DROPS the follow-ups queued behind the running turn, and a message sent while the turn
/// still runs is filed as a steer — written INTO the turn being stopped. So a client that POSTed
/// /interrupt and then POSTed /turns would be racing its own delete, and which of those two
/// outcomes it got would come down to network ordering. One request is what makes neither possible.
final class InterruptAndSendTests: XCTestCase {
    private func offers(session: RunStatus? = .running, stream: RunStatus = .running,
                        canSend: Bool = true, ordinaryDraft: Bool = true,
                        replying: Bool = false, busy: Bool = false) -> Bool {
        ComposerLogic.offersInterruptAndSend(session: session, stream: stream, canSend: canSend,
                                             ordinaryDraft: ordinaryDraft, replying: replying,
                                             busy: busy)
    }

    func testOfferedWhileATurnGeneratesAndThereIsSomethingToSend() {
        XCTAssertTrue(offers())
        // Same authoritative-status precedence as Stop and the Queued label, so the three always
        // agree: a cold open of an already-running session never replays a `.running` event into
        // the reducer, and reading the stream alone would hide this button exactly there.
        XCTAssertTrue(offers(session: .running, stream: .awaitingInput))
        XCTAssertTrue(offers(session: nil, stream: .running))
    }

    func testNotOfferedWhenNothingIsRunning() {
        // Send already means "do this next" when no turn is in flight; there is nothing to stop.
        XCTAssertFalse(offers(session: .awaitingInput, stream: .running))
        XCTAssertFalse(offers(session: nil, stream: .awaitingInput))
    }

    func testOffersNothingSendItselfWouldRefuse() {
        // An empty composer, a mid-flight upload, an offline runner: `canSend` carries them all,
        // and a stop with nothing to put in its place is what the Stop button is for.
        XCTAssertFalse(offers(canSend: false))
        // A `!cmd` runs on the runner beside the engine — not something the engine is stopped for.
        XCTAssertFalse(offers(ordinaryDraft: false))
        // A reply to a blocking question goes back through the approval it answers, not as a turn.
        XCTAssertFalse(offers(replying: true))
        // And never twice: a second stop would drop the follow-up the first one just queued.
        XCTAssertFalse(offers(busy: true))
    }

    func testTheRequestCarriesTheFollowUpAndItsIdempotencyKey() throws {
        let req = SessionInterruptRequest(clientTurnId: "key-1", content: "do this instead",
                                          attachmentIds: ["att-1"])
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(req)) as? [String: Any]

        // The same three fields the browser sends (SessionInterruptDto). The key covers BOTH
        // halves server-side — the interrupt is filed under a key derived from it — so a retry
        // re-files neither the stop nor the message.
        XCTAssertEqual(json?["clientTurnId"] as? String, "key-1")
        XCTAssertEqual(json?["content"] as? String, "do this instead")
        XCTAssertEqual(json?["attachmentIds"] as? [String], ["att-1"])
    }

    func testAFollowUpWithNoAttachmentsOmitsTheField() throws {
        let req = SessionInterruptRequest(clientTurnId: "key-2", content: "just text")
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(req)) as? [String: Any]

        // Absent, not an empty array: the server treats "any attachments?" as part of deciding
        // whether a follow-up is present at all.
        XCTAssertNil(json?["attachmentIds"])
    }

    func testTheAnswerNamesTheTurnTheFollowUpWasQueuedAs() throws {
        let body = Data(#"{"ok":true,"turnId":"turn-2","seq":8}"#.utf8)
        let accepted = try JSONDecoder().decode(TurnAccepted.self, from: body)

        // The follow-up is an ordinary queued message, never a steer — a steer joins the turn
        // being stopped, which is the opposite of what was asked. There is no `kind` to read here
        // and none is needed: this one is queued by construction.
        XCTAssertEqual(accepted.turnId, "turn-2")
        XCTAssertEqual(accepted.seq, 8)
        XCTAssertNil(accepted.kind)
    }
}
