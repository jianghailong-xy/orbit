import Foundation
import XCTest
@testable import OrbitKit

/// The engine's guess at the next message (docs/prompt-suggestions-design.md): how the transcript
/// keeps it, when the composer offers it, the account switch that turns it off — and, since SwiftUI
/// does not exist on this platform, that the composer is still wired to all three (asserted over the
/// source, as `ComposerHandoffWiringTests` does).
final class PromptSuggestionTests: XCTestCase {

    private func event(_ seq: Int, _ type: RunEventType, _ payload: [String: JSONValue] = [:],
                       turn: String? = "turn-1") -> RunEvent {
        RunEvent(seq: seq, type: type, turnId: turn, payload: .object(payload))
    }

    private func folded(_ events: [RunEvent]) -> TranscriptState {
        var reducer = TranscriptReducer()
        for ev in events { reducer.apply(ev) }
        return reducer.state
    }

    private var turn: [RunEvent] {
        [
            event(1, .user, ["text": .string("fix the flaky socket test")]),
            event(2, .assistant, ["text": .string("Fixed: the retry now waits for the socket.")]),
            event(3, .turnEnd, ["subtype": .string("success")]),
        ]
    }

    // MARK: - The transcript

    func testTheSuggestionAfterATurnIsKeptAndDrawsNoRow() {
        let state = folded(turn + [event(4, .promptSuggestion, ["text": .string("  run the tests \n"),
                                                                 "source": .string("engine")])])
        XCTAssertEqual(state.promptSuggestion, "run the tests")
        XCTAssertEqual(folded(turn).items, state.items, "a suggestion is never a transcript row")
    }

    func testAnythingSaidAfterItTakesItAway() {
        let suggested = turn + [event(4, .promptSuggestion, ["text": .string("run the tests")])]
        XCTAssertNil(folded(suggested + [event(5, .user, ["text": .string("ship it")], turn: "turn-2")])
                        .promptSuggestion, "a message — from this device or another")
        XCTAssertNil(folded(suggested + [event(5, .turnEnd, ["subtype": .string("success")], turn: nil)])
                        .promptSuggestion, "a newer turn ending, one the engine started itself included")
        XCTAssertEqual(folded(suggested + [event(5, .system, ["subtype": .string("status")], turn: nil)])
                        .promptSuggestion, "run the tests", "an event that says nothing about turns leaves it")
    }

    func testAnEmptyGuessIsNoSuggestion() {
        XCTAssertNil(folded(turn + [event(4, .promptSuggestion, ["text": .string("   ")])]).promptSuggestion)
        XCTAssertNil(folded(turn + [event(4, .promptSuggestion, [:])]).promptSuggestion)
    }

    /// A cached session written before the field existed still opens, with nothing on offer.
    func testASnapshotFromBeforeTheFieldStillDecodes() throws {
        var state = folded(turn + [event(4, .promptSuggestion, ["text": .string("run the tests")])])
        let roundTrip = try JSONDecoder().decode(TranscriptState.self, from: JSONEncoder().encode(state))
        XCTAssertEqual(roundTrip.promptSuggestion, "run the tests")
        state.promptSuggestion = nil
        var older = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(state)) as? [String: Any])
        older.removeValue(forKey: "promptSuggestion")
        let decoded = try JSONDecoder().decode(TranscriptState.self,
                                               from: JSONSerialization.data(withJSONObject: older))
        XCTAssertNil(decoded.promptSuggestion)
        XCTAssertEqual(decoded.items, state.items)
    }

    // MARK: - When the composer offers it

    private func offered(_ suggestion: String? = "run the tests", session: SessionRunState? = .awaitingInput,
                         generating: Bool = false, stream: RunStatus = .awaitingInput,
                         hasText: Bool = false, hasAttachments: Bool = false, replying: Bool = false,
                         waitingOnReader: Bool = false, sendable: Bool = true) -> String? {
        ComposerLogic.offeredPromptSuggestion(suggestion, session: session, generating: generating, stream: stream,
                                              hasText: hasText, hasAttachments: hasAttachments, replying: replying,
                                              waitingOnReader: waitingOnReader, sendable: sendable)
    }

    func testAnIdleEmptyBoxOffersIt() {
        XCTAssertEqual(offered(), "run the tests")
        XCTAssertEqual(offered(session: .interrupted), "run the tests", "a stopped turn: carry on is a fair guess")
        XCTAssertEqual(offered(session: .succeeded), "run the tests", "a finished run resumes on send")
        XCTAssertEqual(offered(session: nil, stream: .awaitingInput), "run the tests",
                       "the stream decides only until the record is loaded")
    }

    func testItIsHeldBackWheneverSomethingElseComesFirst() {
        XCTAssertNil(offered(nil))
        XCTAssertNil(offered(session: .running), "a turn is in flight")
        XCTAssertNil(offered(session: .queued), "a message is waiting for the runner")
        XCTAssertNil(offered(generating: true), "the engine is running a turn of its own")
        XCTAssertNil(offered(session: .failed), "a failed run's own card says what next")
        XCTAssertNil(offered(session: nil, stream: .running))
        XCTAssertNil(offered(hasText: true), "something is typed")
        XCTAssertNil(offered(hasAttachments: true), "something is staged")
        XCTAssertNil(offered(replying: true), "the box belongs to a reply")
        XCTAssertNil(offered(waitingOnReader: true), "a card waits on the reader")
        XCTAssertNil(offered(sendable: false), "the conversation cannot take a message")
    }

    // MARK: - The account's switch

    func testTheSwitchIsOnUntilTurnedOff() throws {
        func prefs(_ json: String) throws -> UserPreferences {
            try JSONDecoder().decode(UserPreferences.self, from: Data(json.utf8))
        }
        XCTAssertTrue(try prefs("{}").suggestedReplies)
        XCTAssertTrue(try prefs(#"{"promptSuggestions":true}"#).suggestedReplies)
        XCTAssertFalse(try prefs(#"{"promptSuggestions":false}"#).suggestedReplies)
        XCTAssertTrue(try prefs(#"{"promptSuggestions":"no"}"#).suggestedReplies,
                      "a stray value reads as absent rather than failing the whole of `me`")
    }

    func testTurningItOffWritesOnlyThatKey() throws {
        let body = try JSONEncoder().encode(UpdatePreferencesRequest(promptSuggestions: false))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json.count, 1)
        XCTAssertEqual(json["promptSuggestions"] as? Bool, false)
    }

    // MARK: - The composer is wired to it

    private func composerSource() throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("src/macos/OrbitApp/Sources/OrbitApp/Views/ComposerView.swift")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("ComposerView.swift is not beside this checkout")
    }

    func testTheComposerOffersItFillsTheBoxAndSendsNothing() throws {
        let composer = try composerSource()
        XCTAssertTrue(composer.contains("ComposerLogic.offeredPromptSuggestion(\n            console.state.promptSuggestion,"),
                      "the offer is the transcript's suggestion, held to ComposerLogic's rule")
        XCTAssertTrue(composer.contains("PromptSuggestionLine(text: suggestion, accept: acceptSuggestion)"),
                      "the empty field draws it, with Use")
        XCTAssertTrue(composer.contains("if offeredSuggestion != nil { return \"\" }"),
                      "and gives it the placeholder's line")
        XCTAssertTrue(composer.contains("console.sending || console.awaitingReply"),
                      "a message on its way keeps the suggestion it answered out of the box it just left")
        let accept = try XCTUnwrap(composer.range(of: "private func acceptSuggestion() {"))
        let body = String(composer[accept.upperBound...].prefix(240))
        XCTAssertTrue(body.contains("console.composerText = suggestion"), "Use fills the box")
        XCTAssertTrue(body.contains("requestFocus()"), "and focuses it")
        XCTAssertFalse(body.contains("send("), "Use never sends")
        XCTAssertTrue(composer.contains(".onKeyPress(keys: [.tab]) { press in"), "Tab takes it on the Mac")
    }
}
