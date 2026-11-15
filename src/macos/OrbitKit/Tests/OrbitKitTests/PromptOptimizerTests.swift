import Foundation
import XCTest
@testable import OrbitKit

/// Prompt optimizer (docs/prompt-optimizer-design.md, board docs/mocks/prompt-optimizer): the wire
/// shapes of @orbit/shared prompt-optimizer.ts, the composer's button rule, Use / Undo, and when a
/// send carries `skipTranslation`.
final class PromptOptimizerTests: XCTestCase {

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private func encoded<T: Encodable>(_ value: T) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    /// The board's frame 4 answer, with Translation on: English, a gloss, and every context kind.
    private let boardAnswer = """
    {"segments":[{"text":"After signing in, users land on the wrong page. ","added":false},
                 {"text":"The redirect target is meant to come from the `returnTo` query parameter.","added":true}],
     "text":"After signing in, users land on the wrong page. The redirect target is meant to come from the `returnTo` query parameter.",
     "language":"en",
     "gloss":"登录后用户落在错误的页面。",
     "contextUsed":[{"kind":"TURNS","count":6},{"kind":"RECAP"},{"kind":"PROJECT","title":"Auth cleanup"},
                    {"kind":"WIKI","count":2},{"kind":"WORKSPACE","name":"orbit"}]}
    """

    // MARK: - Decoding

    func testDecodesEveryContextKindAndTheGloss() throws {
        let o = try decode(PromptOptimization.self, boardAnswer)
        XCTAssertEqual(o.segments.count, 2)
        XCTAssertFalse(o.segments[0].added)
        XCTAssertTrue(o.segments[1].added)
        XCTAssertEqual(o.text, o.segments.map(\.text).joined())
        XCTAssertEqual(o.language, "en")
        XCTAssertTrue(o.isEnglish)
        XCTAssertEqual(o.gloss, "登录后用户落在错误的页面。")
        XCTAssertEqual(o.contextUsed, [.turns(count: 6), .recap, .project(title: "Auth cleanup"),
                                       .wiki(count: 2), .workspace(name: "orbit")])
        XCTAssertEqual(o.chips, ["this session's last 6 turns", "session recap", "project \"Auth cleanup\" goal",
                                 "2 wiki entries", "workspace \"orbit\""])
    }

    func testDecodesAnAnswerWithoutAGlossInTheDraftsOwnLanguage() throws {
        let o = try decode(PromptOptimization.self, """
        {"segments":[{"text":"修复登录跳转","added":false}],"text":"修复登录跳转","language":"zh-Hans","contextUsed":[]}
        """)
        XCTAssertNil(o.gloss)
        XCTAssertEqual(o.language, "zh-Hans")
        XCTAssertFalse(o.isEnglish)
        XCTAssertTrue(o.chips.isEmpty)
    }

    func testAnEmptyGlossIsNoGlossAndAMissingTextIsTheSegmentsJoined() throws {
        let o = try decode(PromptOptimization.self, """
        {"segments":[{"text":"a ","added":false},{"text":"b","added":true}],"language":"en","gloss":""}
        """)
        XCTAssertNil(o.gloss)
        XCTAssertEqual(o.text, "a b")
        XCTAssertTrue(o.contextUsed.isEmpty)
    }

    func testSingularChipsAndAnUnknownKindDecodeWithoutFailingTheAnswer() throws {
        let o = try decode(PromptOptimization.self, """
        {"segments":[{"text":"x","added":false}],"text":"x","language":"en",
         "contextUsed":[{"kind":"TURNS","count":1},{"kind":"WIKI","count":1},{"kind":"FILES","count":3}]}
        """)
        XCTAssertEqual(o.contextUsed, [.turns(count: 1), .wiki(count: 1), .unknown("FILES")])
        XCTAssertEqual(o.chips, ["this session's last turn", "1 wiki entry"])
    }

    func testTheRequestBodyLeavesOutWhatItDoesNotName() throws {
        let body = try encoded(PromptOptimizationRequest(draft: "fix it", sessionId: "S1"))
        XCTAssertEqual(body["draft"] as? String, "fix it")
        XCTAssertEqual(body["sessionId"] as? String, "S1")
        XCTAssertNil(body["workspaceId"])
        XCTAssertNil(body["projectId"])
        let draft = try encoded(PromptOptimizationRequest(draft: "x", workspaceId: "W1", projectId: "P1"))
        XCTAssertEqual(draft["workspaceId"] as? String, "W1")
        XCTAssertEqual(draft["projectId"] as? String, "P1")
        XCTAssertNil(draft["sessionId"])
    }

    // MARK: - Account switch

    private func user(prefs: String, available: Bool?) throws -> User {
        let avail = available.map { ",\"promptOptimizerAvailable\":\($0)" } ?? ""
        return try decode(User.self, "{\"id\":\"u\",\"email\":\"a@b.c\",\"preferences\":\(prefs)\(avail)}")
    }

    func testTheSwitchIsOffUnlessExactlyTrueAndTheServerCan() throws {
        XCTAssertFalse(PromptOptimizer.isOn(try user(prefs: "{}", available: true)), "absent is off")
        XCTAssertFalse(PromptOptimizer.isOn(try user(prefs: "{\"promptOptimizer\":false}", available: true)))
        XCTAssertFalse(PromptOptimizer.isOn(try user(prefs: "{\"promptOptimizer\":\"yes\"}", available: true)),
                       "a stray value reads as absent rather than failing me")
        XCTAssertTrue(PromptOptimizer.isOn(try user(prefs: "{\"promptOptimizer\":true}", available: true)))
        XCTAssertFalse(PromptOptimizer.isOn(try user(prefs: "{\"promptOptimizer\":true}", available: false)))
        XCTAssertFalse(PromptOptimizer.isOn(nil))
    }

    func testOnlyAMeThatSaysSoIsUnavailable() throws {
        XCTAssertTrue(PromptOptimizer.unavailable(try user(prefs: "{}", available: false)))
        XCTAssertFalse(PromptOptimizer.unavailable(try user(prefs: "{}", available: true)))
        XCTAssertFalse(PromptOptimizer.unavailable(try user(prefs: "{}", available: nil)), "a login payload")
    }

    func testThePreferenceIsWrittenOnlyWhenSet() throws {
        XCTAssertEqual(try encoded(UpdatePreferencesRequest(promptOptimizer: true))["promptOptimizer"] as? Bool, true)
        XCTAssertNil(try encoded(UpdatePreferencesRequest(recaps: true))["promptOptimizer"])
    }

    // MARK: - The button (frame 2)

    func testTheButtonShowsForAWordedDraftWithTheSwitchOn() {
        XCTAssertTrue(PromptOptimizer.showsButton(on: true, text: "fix the login redirect bug"))
        XCTAssertTrue(PromptOptimizer.showsButton(on: true, text: "/review the auth module"),
                      "a command with words after it is a draft")
        XCTAssertFalse(PromptOptimizer.showsButton(on: false, text: "fix the login redirect bug"), "switch off")
    }

    func testTheButtonHidesForAnEmptyBoxAShellCommandAndABareSlashCommand() {
        XCTAssertFalse(PromptOptimizer.showsButton(on: true, text: ""))
        XCTAssertFalse(PromptOptimizer.showsButton(on: true, text: "  \n "))
        XCTAssertFalse(PromptOptimizer.showsButton(on: true, text: "!ls -la"), "shell mode")
        XCTAssertFalse(PromptOptimizer.showsButton(on: true, text: " !git status"))
        XCTAssertFalse(PromptOptimizer.showsButton(on: true, text: "/compact"), "only a /command")
        XCTAssertFalse(PromptOptimizer.showsButton(on: true, text: "/compact  "))
    }

    // MARK: - The card's text

    func testRunsTintAdditionsAndSetCodeSpansApart() {
        let runs = PromptOptimizer.runs([
            PromptOptimizationSegment(text: "Fix it. ", added: false),
            PromptOptimizationSegment(text: "Read `returnTo` first.", added: true),
            PromptOptimizationSegment(text: "odd ` tick", added: false),
        ])
        XCTAssertEqual(runs, [
            .init(text: "Fix it. ", added: false, code: false),
            .init(text: "Read ", added: true, code: false),
            .init(text: "returnTo", added: true, code: true),
            .init(text: " first.", added: true, code: false),
            .init(text: "odd ` tick", added: false, code: false),
        ])
    }

    func testShowInNamesTheLanguageWithoutItsParenthesis() {
        XCTAssertEqual(PromptOptimizerCopy.showIn(.zhHans), "Show in Chinese")
        XCTAssertEqual(PromptOptimizerCopy.showIn(.ja), "Show in Japanese")
    }

    // MARK: - Use and Undo (frames 4–5)

    private func suggested(_ json: String? = nil, draft: String = "fix the login redirect bug") throws -> PromptOptimizerState {
        var state = PromptOptimizerState()
        state.start(draft: draft)
        XCTAssertTrue(state.isOptimizing)
        state.succeeded(try decode(PromptOptimization.self, json ?? boardAnswer))
        return state
    }

    func testTheSuggestionLeavesTheBoxAloneUntilUse() throws {
        var state = try suggested()
        XCTAssertNotNil(state.suggestion)
        XCTAssertFalse(state.isOptimizing)
        XCTAssertFalse(state.offersUndo(current: "fix the login redirect bug"))
        XCTAssertFalse(state.skipTranslation(sending: "fix the login redirect bug"))
        state.dismiss()
        XCTAssertNil(state.suggestion, "× / Esc: the card goes, the draft stays")
        XCTAssertNil(state.use(current: "fix the login redirect bug"), "nothing to use once dismissed")
    }

    func testUseReplacesTheDraftAndUndoPutsItBack() throws {
        var state = try suggested()
        let draft = "fix the login redirect bug"
        let inserted = try XCTUnwrap(state.use(current: draft))
        XCTAssertTrue(inserted.hasPrefix("After signing in"))
        XCTAssertNil(state.suggestion, "the card goes on Use")
        XCTAssertTrue(state.offersUndo(current: inserted))
        XCTAssertEqual(state.undo(current: inserted), draft)
        XCTAssertFalse(state.offersUndo(current: draft))
        XCTAssertNil(state.undo(current: draft), "Undo once")
        XCTAssertFalse(state.skipTranslation(sending: draft), "the owner's own words are translated as usual")
    }

    func testUndoIsNotOfferedOnceTheTextWasEditedOrTheToastWent() throws {
        var state = try suggested()
        let inserted = try XCTUnwrap(state.use(current: "draft"))
        XCTAssertFalse(state.offersUndo(current: inserted + " please"))
        XCTAssertNil(state.undo(current: inserted + " please"))
        state.forgetUndo()
        XCTAssertFalse(state.offersUndo(current: inserted))
        XCTAssertTrue(state.skipTranslation(sending: inserted), "the toast going does not edit the text")
    }

    func testBasedOnAnEarlierDraftWhenTheBoxChangedWhileOptimizing() throws {
        let state = try suggested(draft: "fix it")
        XCTAssertFalse(state.basedOnEarlierDraft(current: "fix it"))
        XCTAssertTrue(state.basedOnEarlierDraft(current: "fix it now"))
    }

    func testAFailureKeepsTheDraftAndCancelDropsThePress() {
        var state = PromptOptimizerState()
        state.start(draft: "x")
        state.failedNow()
        XCTAssertTrue(state.failed)
        XCTAssertNil(state.suggestion)
        state.dismiss()
        XCTAssertFalse(state.failed)
        state.start(draft: "x")
        state.cancel()
        XCTAssertEqual(state.phase, .idle)
        state.succeeded(PromptOptimization(segments: [.init(text: "late", added: false)], language: "en"))
        XCTAssertNil(state.suggestion, "an answer after a cancel is dropped")
    }

    // MARK: - skipTranslation (D2)

    func testSkipTranslationOnlyForUneditedOptimizedEnglish() throws {
        var state = try suggested()
        let inserted = try XCTUnwrap(state.use(current: "draft"))
        XCTAssertTrue(state.skipTranslation(sending: inserted))
        XCTAssertTrue(state.skipTranslation(sending: inserted + "\n"), "the send trims as Send does")
        XCTAssertFalse(state.skipTranslation(sending: inserted + " Also check iOS."), "edited: translated as usual")
        XCTAssertFalse(state.skipTranslation(sending: "something else"))
        state.sent()
        XCTAssertFalse(state.skipTranslation(sending: inserted), "spent by the send")
    }

    func testNoSkipForAPromptInTheDraftsOwnLanguage() throws {
        var state = try suggested("""
        {"segments":[{"text":"修复登录跳转","added":false}],"text":"修复登录跳转","language":"zh-Hans","contextUsed":[]}
        """)
        let inserted = try XCTUnwrap(state.use(current: "draft"))
        XCTAssertFalse(state.skipTranslation(sending: inserted))
    }

    func testTheSendBodiesCarrySkipTranslationOnlyWhenSet() throws {
        let plain = try encoded(ComposerLogic.makeTurn(clientTurnId: "c", text: "t", shell: false, attachmentIds: []))
        XCTAssertNil(plain["skipTranslation"])
        let skip = try encoded(ComposerLogic.makeTurn(clientTurnId: "c", text: "t", shell: false, attachmentIds: [],
                                                      skipTranslation: true))
        XCTAssertEqual(skip["skipTranslation"] as? Bool, true)
        XCTAssertEqual(try encoded(CreateSessionRequest(prompt: "p", skipTranslation: true))["skipTranslation"] as? Bool, true)
        XCTAssertNil(try encoded(CreateSessionRequest(prompt: "p"))["skipTranslation"])
        XCTAssertEqual(try encoded(ResumeRequest(clientTurnId: "c", content: "p", skipTranslation: true))["skipTranslation"] as? Bool, true)
        XCTAssertNil(try encoded(ResumeRequest(clientTurnId: "c", content: "p"))["skipTranslation"])
    }
}

/// SwiftUI does not exist on this platform, so the views that draw the optimizer are held to it over
/// their source, as `TranslationWiringTests` holds Translation's.
final class PromptOptimizerWiringTests: XCTestCase {

    private let app = "src/macos/OrbitApp/Sources/OrbitApp/"

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw NSError(domain: "PromptOptimizerWiringTests", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "\(relative) not found"])
    }

    func testTheComposerDrawsTheButtonTheMacCardAndThePhoneSheet() throws {
        let composer = try source(app + "Views/ComposerView.swift")
        XCTAssertTrue(composer.contains("PromptOptimizer.showsButton(on: PromptOptimizer.isOn(app.user), text: console.composerText)"))
        XCTAssertTrue(composer.contains("PromptOptimizeButton(busy: console.promptOptimizer.isOptimizing) { console.optimizePrompt() }"))
        XCTAssertTrue(composer.contains("#if os(macOS)\n            if let optimization = console.promptOptimizer.suggestion {\n                optimizationCard(optimization, sheet: false)"),
                      "a Mac draws the card above the composer")
        XCTAssertTrue(composer.contains(".sheet(isPresented: optimizationSheetShown) {"), "a phone draws it as a sheet")
        XCTAssertTrue(composer.contains("PromptOptimizationFailureLine(retry:"))
        XCTAssertTrue(composer.contains("if console.promptOptimizer.offersUndo(current: console.composerText) {"))
    }

    func testSendsCarryTheFlagFromTheState() throws {
        let console = try source(app + "ConsoleModel.swift")
        XCTAssertTrue(console.contains("let skipTranslation = fromComposer && promptOptimizer.skipTranslation(sending: draft)"))
        XCTAssertTrue(console.contains("skipTranslation: skipTranslation ? true : nil)"), "a revive carries it")
        XCTAssertTrue(console.contains("let skip = promptOptimizer.skipTranslation(sending: composerText)"),
                      "a new session's opening message carries it")
    }

    func testSettingsDrawTheSwitchOnBothPlatforms() throws {
        let sheet = try source(app + "Views/SettingsSheet.swift")
        XCTAssertTrue(sheet.contains("case .promptOptimizer:\n                    promptOptimizerSection"))
        XCTAssertTrue(sheet.contains("UpdatePreferencesRequest(promptOptimizer: value)"))
        let mac = try source(app + "Views/SettingsAdminView.swift")
        XCTAssertTrue(mac.contains("Toggle(PromptOptimizerCopy.title, isOn: $promptOptimizer)"))
        XCTAssertTrue(mac.contains(".disabled(PromptOptimizer.unavailable(model.user))"))
    }
}
