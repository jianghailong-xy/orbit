import Foundation
import XCTest
@testable import OrbitKit

/// Prompt optimizer (docs/prompt-optimizer-design.md, board docs/mocks/prompt-optimizer): the wire
/// shapes of @orbit/shared prompt-optimizer.ts, the composer's button rule, Use / Undo, and when a
/// send carries `skipTranslation` or `optimizedTranslation` (D2).
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
        XCTAssertEqual(o.promptLanguage, .en)
        XCTAssertTrue(o.isInAgentLanguage)
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
        XCTAssertEqual(o.promptLanguage, .zhHans)
        XCTAssertFalse(o.isInAgentLanguage)
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

    func testTheSwitchIsOnUnlessExactlyFalseAndTheServerCan() throws {
        XCTAssertTrue(PromptOptimizer.isOn(try user(prefs: "{}", available: true)), "absent is on")
        XCTAssertTrue(PromptOptimizer.isOn(try user(prefs: "null", available: true)), "no preferences at all is on")
        XCTAssertFalse(PromptOptimizer.isOn(try user(prefs: "{\"promptOptimizer\":false}", available: true)))
        XCTAssertTrue(PromptOptimizer.isOn(try user(prefs: "{\"promptOptimizer\":\"yes\"}", available: true)),
                      "a stray value reads as absent rather than failing me")
        XCTAssertFalse(PromptOptimizer.isOn(try user(prefs: "{}", available: false)), "no server key")
        XCTAssertFalse(PromptOptimizer.isOn(try user(prefs: "{}", available: nil)), "a login payload says nothing")
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
        XCTAssertEqual(try encoded(UpdatePreferencesRequest(promptOptimizer: false))["promptOptimizer"] as? Bool, false,
                       "turning it off writes false")
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

    func testUnderAGlossTheCardSaysWhichLanguageTheAgentReceives() {
        XCTAssertEqual(PromptOptimizerCopy.agentReceives(.en), "The agent receives the English version.")
        XCTAssertEqual(PromptOptimizerCopy.agentReceives(.ja), "The agent receives the Japanese version.")
        XCTAssertEqual(PromptOptimizerCopy.agentReceives(nil), "The agent receives the translated version.")
    }

    func testBackFromTheGlossNamesThePromptsLanguageNotEnglish() throws {
        XCTAssertEqual(PromptOptimizerCopy.showPrompt(.en), "Show in English")
        XCTAssertEqual(PromptOptimizerCopy.showPrompt(.ja), "Show in Japanese")
        XCTAssertEqual(PromptOptimizerCopy.showPrompt(nil), "Show original")
        let o = try decode(PromptOptimization.self, """
        {"segments":[{"text":"x","added":false}],"language":"xx-unknown","gloss":"y"}
        """)
        XCTAssertNil(o.promptLanguage)
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
        XCTAssertNil(state.optimizedTranslation(sending: "fix the login redirect bug"))
        XCTAssertFalse(state.showingPrompt, "with a gloss the card opens on it (D2)")
        state.dismiss()
        XCTAssertNil(state.suggestion, "× / Esc: the card goes, the draft stays")
        XCTAssertNil(state.use(current: "fix the login redirect bug"), "nothing to use once dismissed")
    }

    func testUseReplacesTheDraftAndUndoPutsItBack() throws {
        var state = try suggested()
        let draft = "fix the login redirect bug"
        let inserted = try XCTUnwrap(state.use(current: draft))
        XCTAssertEqual(inserted, "登录后用户落在错误的页面。", "with a gloss, Use inserts the owner's language (D2)")
        XCTAssertNil(state.suggestion, "the card goes on Use")
        XCTAssertTrue(state.offersUndo(current: inserted))
        XCTAssertEqual(state.undo(current: inserted), draft)
        XCTAssertFalse(state.offersUndo(current: draft))
        XCTAssertNil(state.undo(current: draft), "Undo once")
        XCTAssertFalse(state.skipTranslation(sending: draft), "the owner's own words are translated as usual")
        XCTAssertNil(state.optimizedTranslation(sending: draft))
    }

    func testWithoutAGlossUseInsertsThePromptItself() throws {
        var state = try suggested("""
        {"segments":[{"text":"修复登录跳转","added":false}],"text":"修复登录跳转","language":"zh-Hans","contextUsed":[]}
        """)
        XCTAssertEqual(state.use(current: "draft"), "修复登录跳转")
    }

    func testUndoIsNotOfferedOnceTheTextWasEditedOrTheToastWent() throws {
        var state = try suggested()
        let inserted = try XCTUnwrap(state.use(current: "draft"))
        XCTAssertFalse(state.offersUndo(current: inserted + " please"))
        XCTAssertNil(state.undo(current: inserted + " please"))
        state.forgetUndo()
        XCTAssertFalse(state.offersUndo(current: inserted))
        XCTAssertNotNil(state.optimizedTranslation(sending: inserted), "the toast going does not edit the text")
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

    // MARK: - optimizedTranslation and skipTranslation (D2)

    func testAnUneditedGlossCarriesTheOptimizersPromptAsItsTranslation() throws {
        var state = try suggested()
        let prompt = try XCTUnwrap(state.suggestion?.text)
        let inserted = try XCTUnwrap(state.use(current: "draft"))
        XCTAssertEqual(state.optimizedTranslation(sending: inserted), prompt)
        XCTAssertEqual(state.optimizedTranslation(sending: inserted + "\n"), prompt, "the send trims as Send does")
        XCTAssertFalse(state.skipTranslation(sending: inserted), "a gloss is translated, by the optimizer's own prompt")
        XCTAssertNil(state.optimizedTranslation(sending: inserted + " Also check iOS."), "edited: translated as usual")
        XCTAssertNil(state.optimizedTranslation(sending: "something else"))
        state.sent()
        XCTAssertNil(state.optimizedTranslation(sending: inserted), "spent by the send")
    }

    func testOptimizedTranslationForAChosenAgentLanguageNotOnlyEnglish() throws {
        var state = try suggested("""
        {"segments":[{"text":"ログインのリダイレクトを直して","added":false}],"language":"ja","gloss":"修复登录跳转","contextUsed":[]}
        """)
        let inserted = try XCTUnwrap(state.use(current: "draft"))
        XCTAssertEqual(inserted, "修复登录跳转")
        XCTAssertEqual(state.optimizedTranslation(sending: inserted), "ログインのリダイレクトを直して")
        XCTAssertNil(state.optimizedTranslation(sending: inserted + "!"))
    }

    func testWithoutAGlossAnUneditedPromptSkipsTranslation() throws {
        var state = try suggested("""
        {"segments":[{"text":"修复登录跳转","added":false}],"text":"修复登录跳转","language":"zh-Hans","contextUsed":[]}
        """)
        let inserted = try XCTUnwrap(state.use(current: "draft"))
        XCTAssertTrue(state.skipTranslation(sending: inserted))
        XCTAssertNil(state.optimizedTranslation(sending: inserted))
        XCTAssertFalse(state.skipTranslation(sending: inserted + "!"), "edited: translated as usual")
        state.sent()
        XCTAssertFalse(state.skipTranslation(sending: inserted), "spent by the send")
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

    func testTheSendBodiesCarryOptimizedTranslationOnlyWhenSet() throws {
        let plain = try encoded(ComposerLogic.makeTurn(clientTurnId: "c", text: "t", shell: false, attachmentIds: []))
        XCTAssertNil(plain["optimizedTranslation"])
        let turn = try encoded(ComposerLogic.makeTurn(clientTurnId: "c", text: "t", shell: false, attachmentIds: [],
                                                      optimizedTranslation: "English"))
        XCTAssertEqual(turn["optimizedTranslation"] as? String, "English")
        XCTAssertNil(turn["skipTranslation"])
        XCTAssertEqual(try encoded(CreateSessionRequest(prompt: "p", optimizedTranslation: "English"))["optimizedTranslation"] as? String, "English")
        XCTAssertNil(try encoded(CreateSessionRequest(prompt: "p"))["optimizedTranslation"])
        XCTAssertEqual(try encoded(ResumeRequest(clientTurnId: "c", content: "p", optimizedTranslation: "English"))["optimizedTranslation"] as? String, "English")
        XCTAssertNil(try encoded(ResumeRequest(clientTurnId: "c", content: "p"))["optimizedTranslation"])
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
        XCTAssertTrue(console.contains("let optimizedTranslation = fromComposer ? promptOptimizer.optimizedTranslation(sending: draft) : nil"))
        XCTAssertTrue(console.contains("skipTranslation: skipTranslation ? true : nil,\n                                          optimizedTranslation: optimizedTranslation)"),
                      "a revive carries them")
        XCTAssertTrue(console.contains("skipTranslation: skipTranslation,\n                                                 optimizedTranslation: optimizedTranslation)"),
                      "a live turn carries them")
        XCTAssertTrue(console.contains("let skip = promptOptimizer.skipTranslation(sending: composerText)"),
                      "a new session's opening message carries them")
        XCTAssertTrue(console.contains("let optimizedTranslation = promptOptimizer.optimizedTranslation(sending: composerText)"))
        XCTAssertTrue(console.contains("skipTranslation: skip, optimizedTranslation: optimizedTranslation))"))
    }

    func testTheCardOpensOnTheGlossAndSaysWhatTheAgentReceives() throws {
        let views = try source(app + "Views/PromptOptimizerViews.swift")
        XCTAssertTrue(views.contains("if !showingPrompt, let gloss = optimization.gloss { return Text(gloss) }"))
        XCTAssertTrue(views.contains("Text(PromptOptimizerCopy.agentReceives(optimization.promptLanguage))"))
        XCTAssertTrue(views.contains("Button(showingPrompt ? PromptOptimizerCopy.showIn(glossLanguage)"))
    }

    func testTabInTheBoxIsUseOnAMac() throws {
        // The web's card says the same (src/web/src/components/PromptOptimizer.tsx).
        XCTAssertEqual(PromptOptimizerCopy.keysHint, "Tab uses it · Esc dismisses · your draft is kept")
        XCTAssertEqual(PromptOptimizerCopy.useKey, "Tab")
        let composer = try source(app + "Views/ComposerView.swift")
        let card = try XCTUnwrap(composer.range(of: "if console.promptOptimizer.suggestion != nil, !showSlash {\n                    console.useOptimization(edit: false)"),
                                 "Tab with the card open presses Use")
        let suggestion = try XCTUnwrap(composer.range(of: "guard offeredSuggestion != nil else { return .ignored }"))
        XCTAssertLessThan(card.lowerBound, suggestion.lowerBound, "the card's Tab is read first")
        let views = try source(app + "Views/PromptOptimizerViews.swift")
        XCTAssertTrue(views.contains("Text(PromptOptimizerCopy.useKey).font(.caption).opacity(0.75)"))
        XCTAssertTrue(views.contains("Text(PromptOptimizerCopy.keysHint)"))
    }

    func testSettingsDrawTheSwitchOnBothPlatforms() throws {
        let sheet = try source(app + "Views/SettingsSheet.swift")
        XCTAssertTrue(sheet.contains("case .promptOptimizer:\n                    promptOptimizerSection"))
        XCTAssertTrue(sheet.contains("UpdatePreferencesRequest(promptOptimizer: value)"))
        // On by default (owner, 2026-11-16): both pages seed absent as on and start the toggle on.
        for page in [sheet, try source(app + "Views/SettingsAdminView.swift")] {
            XCTAssertTrue(page.contains("@State private var promptOptimizer = true"))
            XCTAssertTrue(page.contains("promptOptimizer = !PromptOptimizer.unavailable(model.user) && PromptOptimizer.switchedOn(p)"))
            XCTAssertTrue(page.contains("guard !PromptOptimizer.unavailable(model.user),\n"))
        }
        let mac = try source(app + "Views/SettingsAdminView.swift")
        XCTAssertTrue(mac.contains("Toggle(PromptOptimizerCopy.title, isOn: $promptOptimizer)"))
        XCTAssertTrue(mac.contains(".disabled(PromptOptimizer.unavailable(model.user))"))
    }
}
