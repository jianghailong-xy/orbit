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
        try repoSource("src/macos/OrbitApp/Sources/OrbitApp/Views/ComposerView.swift")
    }

    private func repoSource(_ path: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(path)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("\(path) is not beside this checkout")
    }

    func testTheComposerOffersItFillsTheBoxAndSendsNothing() throws {
        let composer = try composerSource()
        XCTAssertTrue(composer.contains("ComposerLogic.offeredPromptSuggestion(\n            console.state.promptSuggestion,"),
                      "the offer is the transcript's suggestion, held to ComposerLogic's rule")
        XCTAssertTrue(composer.contains("PromptSuggestionLine(text: suggestion, accept: acceptSuggestion)"),
                      "the empty field draws it, on a Mac with Use")
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

    /// A touch screen has no Use (design §4.1, §9 补充二): a double-tap on the field takes the guess,
    /// the field's own taps wait to see whether a second one follows (the keyboard a first tap raised
    /// would lift the field out from under the second), and "Double-tap to use" follows the words until
    /// the first double-tap on the device. VoiceOver, whose double-tap is "activate", gets an action.
    func testATouchScreenTakesItWithADoubleTapOnTheField() throws {
        let composer = try composerSource()
        XCTAssertTrue(composer.contains("PromptSuggestionLine(text: suggestion, showsDoubleTapHint: !suggestionDoubleTapLearned)"),
                      "the iPhone line has no Use, and the hint until it has been learned")
        XCTAssertTrue(composer.contains("@AppStorage(\"composer.suggestionDoubleTapLearned\") private var suggestionDoubleTapLearned = false"),
                      "learned once per device")
        XCTAssertTrue(composer.contains("suggestion: offeredSuggestion, useSuggestion: useSuggestionByTouch)"),
                      "the field takes the double-tap only while a guess is on offer")

        let byTouch = try XCTUnwrap(composer.range(of: "private func useSuggestionByTouch() {"))
        let touchBody = String(composer[byTouch.upperBound...].prefix(220))
        XCTAssertTrue(touchBody.contains("PlatformHaptics.tap()"), "a light tap says it landed")
        XCTAssertTrue(touchBody.contains("acceptSuggestion()"), "the same fill as Use and Tab")
        XCTAssertTrue(touchBody.contains("suggestionDoubleTapLearned = true"), "and the hint has done its job")
        XCTAssertFalse(touchBody.contains("send("), "a double-tap never sends")

        let editor = try XCTUnwrap(composer.range(of: "private struct GrowingTextEditor: UIViewRepresentable {"))
        let field = String(composer[editor.lowerBound...])
        XCTAssertTrue(field.contains("doubleTap.numberOfTapsRequired = 2"))
        XCTAssertTrue(field.contains("doubleTap.delaysTouchesEnded = false"), "touches reach the field as ever")
        XCTAssertTrue(field.contains("context.coordinator.doubleTap?.isEnabled = suggestion != nil"),
                      "no guess, no double-tap: the field's taps are its own, with no wait")
        XCTAssertTrue(field.contains("return other is UITapGestureRecognizer && other.view?.isDescendant(of: field) == true"),
                      "with one, the field's taps wait on the double-tap")
        XCTAssertTrue(field.contains("UIAccessibilityCustomAction(name: \"Use suggestion\")"), "VoiceOver's way to take it")
        XCTAssertTrue(field.contains("view.accessibilityHint = suggestion.map { \"Suggested reply: \\($0).\" }"))

        let line = try XCTUnwrap(composer.range(of: "private struct PromptSuggestionLine: View {"))
        let lineBody = String(composer[line.lowerBound...].prefix(3_000))
        XCTAssertTrue(lineBody.contains("Text(\"Double-tap to use\")"))
        XCTAssertTrue(lineBody.contains(".accessibilityHidden(true)"), "VoiceOver hears it from the field")
        XCTAssertTrue(lineBody.contains("Text(\"⇥\")"), "the Mac keeps Use ⇥")
    }

    /// Every touch client says it the same way and offers the same action to a screen reader.
    func testTheTouchClientsShareTheHintAndTheAction() throws {
        let web = try repoSource("src/web/src/components/WorkspaceView.tsx")
        XCTAssertTrue(web.contains("Double-tap to use"), "the phone web's hint")
        XCTAssertTrue(web.contains("Use suggestion: ${offeredSuggestion}"), "and its screen-reader button")
        let android = try repoSource("src/android/app/src/main/kotlin/io/orbitd/android/composer/SessionComposer.kt")
        XCTAssertTrue(android.contains("\"Double-tap to use\""), "Android's hint")
        XCTAssertTrue(android.contains("\"Use suggestion\""), "and its TalkBack action")
    }
}
