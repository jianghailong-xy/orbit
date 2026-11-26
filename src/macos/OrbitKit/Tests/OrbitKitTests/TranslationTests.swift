import Foundation
import XCTest
@testable import OrbitKit

/// Settings › Translation on iOS/macOS (board docs/mocks/session-translation/01-board.png, frames 7–8;
/// behaviour as frames 4–6): decoding of the server's fields (@orbit/shared translation.ts), the
/// account switch's state, what a translated message's foot says, and the transcript folding the
/// translations the server writes.
final class TranslationTests: XCTestCase {

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    private func event(_ seq: Int, _ type: RunEventType, _ payload: [String: JSONValue] = [:],
                       turn: String? = "turn-1") -> RunEvent {
        RunEvent(seq: seq, type: type, turnId: turn, payload: .object(payload))
    }

    private func user(_ seq: Int, english: String, original: String, state: String = "DONE",
                      turn: String = "turn-1") -> RunEvent {
        event(seq, .user, ["text": .string(english),
                           "translation": .object(["state": .string(state), "from": .string("zh-Hans"),
                                                   "original": .string(original)])], turn: turn)
    }

    private func replies(_ state: TranscriptState) -> [AssistantBubble] {
        state.items.compactMap { if case .assistant(let b) = $0 { return b } else { return nil } }
    }

    private func users(_ state: TranscriptState) -> [UserBubble] {
        state.items.compactMap { if case .user(let b) = $0 { return b } else { return nil } }
    }

    // MARK: - Decoding the account's fields

    func testMeCarriesTheSwitchTheLanguageAndWhetherTheServerCanTranslate() throws {
        let me = try decode(User.self, """
        {"id":"u1","email":"a@b.c","translationAvailable":true,
         "preferences":{"translationEnabled":true,"translationLanguage":"ja","translationAgentLanguage":"pt"}}
        """)
        XCTAssertEqual(me.translationAvailable, true)
        XCTAssertEqual(me.preferences?.translationEnabled, true)
        XCTAssertEqual(SessionTranslation.language(me.preferences), .ja)
        XCTAssertEqual(SessionTranslation.agentLanguage(me.preferences), .pt)
        XCTAssertTrue(SessionTranslation.isOn(me))
        XCTAssertFalse(SessionTranslation.unavailable(me))
    }

    func testAbsentIsOffAndTheDefaultLanguage() throws {
        let me = try decode(User.self, #"{"id":"u1","email":"a@b.c","translationAvailable":true,"preferences":{}}"#)
        XCTAssertNil(me.preferences?.translationEnabled)
        XCTAssertFalse(SessionTranslation.isOn(me), "absent = off")
        XCTAssertEqual(SessionTranslation.language(me.preferences), .zhHans)
        XCTAssertEqual(SessionTranslation.agentLanguage(me.preferences), .en, "absent agent language = English")
    }

    func testAServerWithoutAKeyTranslatesNothingWhateverThePreferenceSays() throws {
        let me = try decode(User.self, """
        {"id":"u1","email":"a@b.c","translationAvailable":false,"preferences":{"translationEnabled":true}}
        """)
        XCTAssertFalse(SessionTranslation.isOn(me))
        XCTAssertTrue(SessionTranslation.unavailable(me), "frame 2: the switch is drawn disabled with the notice")
        // A login payload says nothing about the key: that is not a server without one.
        let login = try decode(User.self, #"{"id":"u1","email":"a@b.c"}"#)
        XCTAssertFalse(SessionTranslation.unavailable(login))
    }

    func testTranslationUnavailableUntilIsReadWhileItLiesAhead() throws {
        let me = try decode(User.self, """
        {"id":"u1","email":"a@b.c","translationAvailable":true,"translationUnavailableUntil":"2026-11-18T06:01:00.000Z"}
        """)
        XCTAssertEqual(me.translationUnavailableUntil, "2026-11-18T06:01:00.000Z")
        let until = Date(timeIntervalSince1970: 1_794_981_660)
        XCTAssertEqual(SessionTranslation.temporarilyUnavailableUntil(me, now: until.addingTimeInterval(-1)), until)
        XCTAssertNil(SessionTranslation.temporarilyUnavailableUntil(me, now: until), "past it, the ordinary tag again")
        let closed = try decode(User.self, #"{"id":"u1","email":"a@b.c","translationAvailable":true,"translationUnavailableUntil":null}"#)
        XCTAssertNil(closed.translationUnavailableUntil)
        XCTAssertNil(SessionTranslation.temporarilyUnavailableUntil(closed))
        XCTAssertNil(SessionTranslation.temporarilyUnavailableUntil(try decode(User.self, #"{"id":"u1","email":"a@b.c"}"#)))
    }

    func testAStrayValueReadsAsAbsentAndAnUnknownLanguageAsTheDefault() throws {
        let prefs = try decode(UserPreferences.self,
                               #"{"translationEnabled":"yes","translationLanguage":"xx","translationAgentLanguage":"xx"}"#)
        XCTAssertNil(prefs.translationEnabled)
        XCTAssertEqual(SessionTranslation.language(prefs), .zhHans)
        XCTAssertEqual(SessionTranslation.agentLanguage(prefs), .en)
        let stray = try decode(UserPreferences.self, #"{"translationAgentLanguage":7}"#)
        XCTAssertNil(stray.translationAgentLanguage)
    }

    func testTheToggleWritesOnlyItsOwnKey() throws {
        func keys(_ req: UpdatePreferencesRequest) throws -> [String: Any] {
            try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(req)) as? [String: Any])
        }
        let on = try keys(UpdatePreferencesRequest(translationEnabled: true))
        XCTAssertEqual(on.count, 1)
        XCTAssertEqual(on["translationEnabled"] as? Bool, true)
        let off = try keys(UpdatePreferencesRequest(translationEnabled: false))
        XCTAssertEqual(off["translationEnabled"] as? Bool, false)
        let lang = try keys(UpdatePreferencesRequest(translationLanguage: TranslationLanguage.ko.rawValue))
        XCTAssertEqual(lang.count, 1)
        XCTAssertEqual(lang["translationLanguage"] as? String, "ko")
        let agent = try keys(UpdatePreferencesRequest(translationAgentLanguage: TranslationLanguage.de.rawValue))
        XCTAssertEqual(agent.count, 1)
        XCTAssertEqual(agent["translationAgentLanguage"] as? String, "de")
    }

    // MARK: - Show both languages (docs/mocks/session-translation/02-bilingual.png)

    func testShowBothLanguagesIsOffUntilTheAccountSaysSoAndOnlyWhileTranslating() throws {
        let absent = try decode(UserPreferences.self, #"{"translationEnabled":true}"#)
        XCTAssertNil(absent.translationBilingual)
        XCTAssertFalse(SessionTranslation.bilingual(absent), "absent = off")
        let on = try decode(UserPreferences.self, #"{"translationEnabled":true,"translationBilingual":true}"#)
        XCTAssertTrue(SessionTranslation.bilingual(on))
        let translationOff = try decode(UserPreferences.self, #"{"translationEnabled":false,"translationBilingual":true}"#)
        XCTAssertFalse(SessionTranslation.bilingual(translationOff), "shown only while Translate conversations is on")
        let stray = try decode(UserPreferences.self, #"{"translationEnabled":true,"translationBilingual":"yes"}"#)
        XCTAssertNil(stray.translationBilingual)
        let write = try XCTUnwrap(JSONSerialization.jsonObject(
            with: JSONEncoder().encode(UpdatePreferencesRequest(translationBilingual: true))) as? [String: Any])
        XCTAssertEqual(write.count, 1)
        XCTAssertEqual(write["translationBilingual"] as? Bool, true)
    }

    func testBothLanguagesOnTheFeetLoseTheFlip() {
        let done = TurnTranslation(state: .done, from: .zhHans, original: "改吧")
        XCTAssertEqual(SessionTranslation.userFoot(done, flipped: false, bilingual: true),
                       [.text("Sent to the agent in English"), .action("Hide original", .hideOriginal)])
        // Agents working in another language: the foot names it.
        XCTAssertEqual(SessionTranslation.userFoot(done, flipped: false, bilingual: true, agentLanguage: .ja),
                       [.text("Sent to the agent in Japanese"), .action("Hide original", .hideOriginal)])
        XCTAssertEqual(SessionTranslation.replyFoot(ReplyTranslation(lang: .zhHans, text: "好"), pending: false,
                                                    flipped: false, bilingual: true),
                       [.text("Translated"), .action("Hide original", .hideOriginal)])
        // Hidden (docs/mocks/translation-hide-original): "Show both" brings the original back.
        XCTAssertEqual(SessionTranslation.userFoot(done, flipped: false, bilingual: true, originalHidden: true),
                       [.text("Sent to the agent in English"), .action("Show both", .hideOriginal)])
        XCTAssertEqual(SessionTranslation.replyFoot(ReplyTranslation(lang: .zhHans, text: "好"), pending: false,
                                                    flipped: false, bilingual: true, originalHidden: true),
                       [.text("Translated"), .action("Show both", .hideOriginal)])
        // Off: exactly today's feet.
        XCTAssertEqual(SessionTranslation.userFoot(done, flipped: false, bilingual: false),
                       [.action("Show original", .flip)])
        XCTAssertEqual(SessionTranslation.replyFoot(ReplyTranslation(lang: .zhHans, text: "好"), pending: false, flipped: false),
                       [.text("Translated"), .action("Show original", .flip)])
        // States unchanged with it on.
        XCTAssertEqual(SessionTranslation.userFoot(TurnTranslation(state: .translating, from: .zhHans, original: "x"),
                                                   flipped: false, bilingual: true), [.chip("Translating…")])
        XCTAssertEqual(SessionTranslation.replyFoot(ReplyTranslation(lang: .zhHans, failed: true), pending: false,
                                                    flipped: false, bilingual: true),
                       [.text("Couldn't translate this reply"), .action("Retry", .retryReply)])
        XCTAssertEqual(SessionTranslation.replyFoot(nil, pending: true, flipped: false, bilingual: true),
                       [.chip("Translates when the reply is done")])
    }

    func testTheEnglishBlockIsDrawnOnlyWhenBothTextsExist() {
        let done = TurnTranslation(state: .done, from: .zhHans, original: "改吧")
        XCTAssertEqual(SessionTranslation.userEnglish("Go ahead.", done, bilingual: true), "Go ahead.")
        XCTAssertNil(SessionTranslation.userEnglish("Go ahead.", done, bilingual: false), "off: none")
        XCTAssertNil(SessionTranslation.userEnglish("x", TurnTranslation(state: .translating, from: .zhHans, original: "x"),
                                                    bilingual: true))
        XCTAssertNil(SessionTranslation.userEnglish("x", TurnTranslation(state: .sentAsWritten, from: .zhHans, original: "x"),
                                                    bilingual: true))
        // A reply drawn whole: one whose blocks do not pair (two paragraphs translated as one).
        XCTAssertEqual(SessionTranslation.replyEnglish("Done.\n\nAll tests pass.",
                                                       ReplyTranslation(lang: .zhHans, text: "好了，测试全部通过。"), bilingual: true),
                       "Done.\n\nAll tests pass.")
        // One that pairs is drawn block by block instead, with no English under it.
        XCTAssertNil(SessionTranslation.replyEnglish("Done.", ReplyTranslation(lang: .zhHans, text: "好了"), bilingual: true))
        XCTAssertNil(SessionTranslation.replyEnglish("Done.", ReplyTranslation(lang: .zhHans, failed: true), bilingual: true))
        XCTAssertNil(SessionTranslation.replyEnglish("Done.", nil, bilingual: true))
        // With it on the bubble shows what they wrote whatever the old flip said; copy follows.
        XCTAssertEqual(SessionTranslation.shownUserText("Go ahead.", done, flipped: false), "改吧")
    }

    func testALongRepliesEnglishCollapsesAndCodeIsNotRepeated() {
        let long = [
            "Done. The popup now opens synchronously on click:",
            "1. The script preloads on page load in a useEffect;",
            "2. The click handler no longer awaits before signInWithPopup;",
            "```ts",
            "useEffect(() => { void loadGoogleScript(); }, []);",
            "```",
            "3. A new LoginPage.safari.test.tsx covers this case.",
            "All tests pass.",
            "The fix is on the branch.",
            "Safari keeps blocking popups that are opened after an await.",
            "Chrome and Firefox were never affected.",
            "Want me to open a pull request?",
        ].joined(separator: "\n")
        let english = BilingualEnglish.prose(long)
        XCTAssertFalse(english.contains("loadGoogleScript(); }"), "a code block is drawn once, above")
        // The same N the web counts for the same reply (Transcript.translation.test.tsx).
        XCTAssertEqual(BilingualEnglish.lineCount(english), 10)
        XCTAssertTrue(BilingualEnglish.collapses(english))
        XCTAssertEqual(TranslationCopy.showEnglishLabel(lines: BilingualEnglish.lineCount(english)), "Show English · 10 lines")
        let short = "Found it: Safari blocks popups that aren't opened directly by a click."
        XCTAssertEqual(BilingualEnglish.lineCount(short), 2)
        XCTAssertFalse(BilingualEnglish.collapses(short))
        // A long line wraps every 60 characters; blank lines do not count; an unclosed fence stays.
        XCTAssertEqual(BilingualEnglish.lineCount(String(repeating: "a", count: 121) + "\n\n\nb"), 4)
        XCTAssertEqual(BilingualEnglish.prose("a\n```\nb"), "a\n```\nb")
    }

    // MARK: - The languages and the composer tag

    func testTheSharedListInItsOrderWithTheirNames() {
        XCTAssertEqual(TranslationLanguage.allCases.map(\.rawValue), [
            "en", "zh-Hans", "zh-Hant", "ja", "ko", "es", "fr", "de", "ru", "pt", "it", "nl", "ar", "hi", "tr",
            "vi", "th", "id", "pl", "uk", "he", "sv", "cs", "da", "fi", "el", "hu", "ro", "ms", "bn",
        ])
        XCTAssertEqual(TranslationLanguage.allCases.map(\.name), [
            "English", "Chinese (Simplified)", "Chinese (Traditional)", "Japanese", "Korean", "Spanish", "French",
            "German", "Russian", "Portuguese", "Italian", "Dutch", "Arabic", "Hindi", "Turkish", "Vietnamese",
            "Thai", "Indonesian", "Polish", "Ukrainian", "Hebrew", "Swedish", "Czech", "Danish", "Finnish",
            "Greek", "Hungarian", "Romanian", "Malay", "Bengali",
        ])
        XCTAssertEqual(TranslationLanguage.default, .zhHans)
        XCTAssertEqual(TranslationLanguage.agentDefault, .en)
    }

    func testTheComposerTagNamesTheAgentLanguageWithoutParentheses() {
        XCTAssertEqual(TranslationLanguage.zhHans.tag(to: .en), "Chinese → English")
        XCTAssertEqual(TranslationLanguage.zhHant.tag(to: .en), "Chinese → English")
        XCTAssertEqual(TranslationLanguage.ja.tag(to: .en), "Japanese → English")
        XCTAssertEqual(TranslationLanguage.en.tag(to: .zhHans), "English → Chinese")
        XCTAssertEqual(TranslationLanguage.ko.tag(to: .de), "Korean → German")
    }

    func testTheSwitchsLineNamesTheAgentLanguage() {
        XCTAssertTrue(TranslationCopy.translateConversationsHint(.en).hasPrefix("Agents read and write in English; "))
        XCTAssertTrue(TranslationCopy.translateConversationsHint(.zhHans)
            .hasPrefix("Agents read and write in Chinese (Simplified); you write and read in your language."))
        XCTAssertFalse(TranslationCopy.translateConversationsHint(.ja).contains("English"))
    }

    func testTheComposerTagOpensSettingsOnSessions() {
        var nav = NavState()
        nav.openSettings(at: .general)
        XCTAssertTrue(nav.settingsPresented)
        XCTAssertEqual(nav.settingsPath, [.settingsPage(.general)])
    }

    // MARK: - Decoding a message's, a reply's and a card's translation

    func testATurnTranslationIsReadOnlyWhenEveryFieldIsKnown() {
        let ok = TurnTranslation.parse(.object(["state": .string("FAILED"), "from": .string("fr"),
                                                "original": .string("bonjour")]))
        XCTAssertEqual(ok, TurnTranslation(state: .failed, from: .fr, original: "bonjour"))
        XCTAssertEqual(ok?.held, true)
        XCTAssertNil(TurnTranslation.parse(.object(["state": .string("LOST"), "from": .string("fr"),
                                                    "original": .string("x")])))
        XCTAssertNil(TurnTranslation.parse(.object(["state": .string("DONE"), "from": .string("xx"),
                                                    "original": .string("x")])))
        XCTAssertNil(TurnTranslation.parse(nil))
    }

    func testAFailedTurnAndARefusalSayWhyInSharedsReasons() throws {
        XCTAssertEqual(TranslationFailureReason.allCases.map(\.rawValue),
                       ["TIMEOUT", "NETWORK", "HTTP", "EMPTY", "TRUNCATED", "MANGLED", "NO_KEY", "UNAVAILABLE"])
        let http = TurnTranslation.parse(.object(["state": .string("FAILED"), "from": .string("ja"), "original": .string("x"),
                                                  "failureReason": .string("HTTP"), "httpStatus": .int(503)]))
        XCTAssertEqual(http, TurnTranslation(state: .failed, from: .ja, original: "x", failureReason: .http, httpStatus: 503))
        for reason in TranslationFailureReason.allCases {
            let t = TurnTranslation.parse(.object(["state": .string("FAILED"), "from": .string("ja"), "original": .string("x"),
                                                   "failureReason": .string(reason.rawValue)]))
            XCTAssertEqual(t?.failureReason, reason)
            XCTAssertNil(t?.httpStatus)
        }
        // An unknown reason is no reason (the generic line), not a turn that cannot be read.
        let unknown = TurnTranslation.parse(.object(["state": .string("FAILED"), "from": .string("ja"), "original": .string("x"),
                                                     "failureReason": .string("COSMIC_RAY")]))
        XCTAssertNotNil(unknown)
        XCTAssertNil(unknown?.failureReason)
        // The Decodable path (turn list, send answer) reads it the same way.
        let rows = try decode([QueuedTurnInfo].self, """
        [{"turnId":"t1","content":"x","translation":{"state":"FAILED","from":"zh-Hans","original":"x","failureReason":"TIMEOUT"}},
         {"turnId":"t2","content":"x","translation":{"state":"FAILED","from":"zh-Hans","original":"x","failureReason":"HTTP","httpStatus":401}},
         {"turnId":"t3","content":"x","translation":{"state":"FAILED","from":"zh-Hans","original":"x","failureReason":"NEW_ONE"}}]
        """)
        XCTAssertEqual(rows[0].turnTranslation?.failureReason, .timeout)
        XCTAssertEqual(rows[1].turnTranslation?.failureReason, .http)
        XCTAssertEqual(rows[1].turnTranslation?.httpStatus, 401)
        XCTAssertNotNil(rows[2].turnTranslation)
        XCTAssertNil(rows[2].turnTranslation?.failureReason)
        // The 422 says why.
        let refusal = APIError.http(status: 422, body: #"{"code":"TRANSLATION_FAILED","message":"x","failureReason":"HTTP","httpStatus":429}"#)
        XCTAssertEqual(SessionTranslation.refusalReason(refusal)?.reason, .http)
        XCTAssertEqual(SessionTranslation.refusalReason(refusal)?.httpStatus, 429)
        let timeout = APIError.http(status: 422, body: #"{"code":"TRANSLATION_FAILED","failureReason":"TIMEOUT"}"#)
        XCTAssertEqual(SessionTranslation.refusalReason(timeout)?.reason, .timeout)
        XCTAssertNil(SessionTranslation.refusalReason(timeout)?.httpStatus)
        XCTAssertNil(SessionTranslation.refusalReason(APIError.http(status: 422, body: #"{"code":"TRANSLATION_FAILED"}"#)))
        XCTAssertNil(SessionTranslation.refusalReason(APIError.http(status: 500, body: #"{"failureReason":"TIMEOUT"}"#)))
    }

    func testTheTurnListAndTheSendAnswerCarryTheHeldMessage() throws {
        let rows = try decode([QueuedTurnInfo].self, """
        [{"turnId":"t1","kind":"message","placement":"queued","content":"再跑一遍",
          "translation":{"state":"TRANSLATING","from":"zh-Hans","original":"再跑一遍"}},
         {"turnId":"t2","content":"plain"}]
        """)
        XCTAssertEqual(rows[0].turnTranslation?.state, .translating)
        XCTAssertNil(rows[1].turnTranslation)
        let sent = try decode(TurnAccepted.self, """
        {"turnId":"t1","translation":{"state":"TRANSLATING","from":"zh-Hans","original":"x"}}
        """)
        XCTAssertEqual(sent.turnTranslation?.state, .translating)
        let answer = try decode(TranslationActionResponse.self, """
        {"turnId":"t1","translation":{"state":"SENT_AS_WRITTEN","from":"zh-Hans","original":"x"}}
        """)
        XCTAssertEqual(answer.translation.state, .sentAsWritten)
    }

    func testAReplyTranslationIsTextOrFailed() {
        XCTAssertEqual(ReplyTranslation.parse(.object(["lang": .string("ja"), "text": .string("はい")])),
                       ReplyTranslation(lang: .ja, text: "はい"))
        XCTAssertEqual(ReplyTranslation.parse(.object(["lang": .string("ja"), "failed": .bool(true)])),
                       ReplyTranslation(lang: .ja, failed: true))
        XCTAssertNil(ReplyTranslation.parse(.object(["lang": .string("ja")])))
    }

    func testAnApprovalCardShowsItsQuestionsInTheOwnersLanguage() throws {
        let info = try decode(ApprovalInfo.self, """
        {"id":"a1","toolName":"AskUserQuestion","status":"PENDING",
         "input":{"questions":[{"question":"Which one?","header":"Pick",
            "options":[{"label":"Yes","description":"Do it"},{"label":"No"}]}]},
         "translation":{"lang":"zh-Hans","questions":[{"question":"哪一个？","header":"选择",
            "options":[{"label":"是","description":"做"},{"label":"否"}]}]}}
        """)
        let card = PendingApproval(id: info.id, kind: .question, toolName: info.toolName, input: info.input,
                                   translation: ApprovalTranslation.parse(info.translation))
        let shown = try XCTUnwrap(card.shownInput)
        let questions = Approvals.parseQuestions(from: shown)
        XCTAssertEqual(questions.first?.question, "哪一个？")
        XCTAssertEqual(questions.first?.options.map(\.label), ["是", "否"])
        XCTAssertEqual(card.input?["questions"], info.input?["questions"], "input stays the engine's English")
        // A card that could not be translated is drawn in English.
        let failed = PendingApproval(id: "a2", kind: .question, toolName: "AskUserQuestion", input: info.input,
                                     translation: ApprovalTranslation(lang: .zhHans, failed: true))
        XCTAssertEqual(failed.shownInput, info.input)
    }

    /// After the answer (3A): the transcript's record finds the card's translation by its call and
    /// shows the questions as the card did, the answer still read off the English result.
    func testAnAnsweredQuestionKeepsItsCardsLanguage() throws {
        let info = try decode([ApprovalInfo].self, """
        [{"id":"a1","toolName":"AskUserQuestion","status":"ALLOWED","toolUseId":"toolu_q",
          "input":{"questions":[{"question":"Which one?","header":"Pick",
            "options":[{"label":"Yes","description":"Do it"},{"label":"No"}]}]},
          "translation":{"lang":"zh-Hans","questions":[{"question":"哪一个？","header":"选择",
            "options":[{"label":"是","description":"做"},{"label":"否","description":"不该出现"}]}]}},
         {"id":"a2","toolName":"Bash","status":"ALLOWED","toolUseId":"toolu_b","input":{},
          "translation":{"lang":"zh-Hans","description":"列出"}}]
        """)
        let byCall = ApprovalTranslation.byToolUse(info)
        XCTAssertEqual(Array(byCall.keys), ["toolu_q"], "only question cards, by their call")
        let asked = Approvals.parseQuestions(from: try XCTUnwrap(info[0].input))
        let outcome = QuestionRecords.outcome(questions: asked, result: #"The user answered: "Which one?"="No". Read the answers carefully."#, isError: false)
        XCTAssertEqual(outcome, .answered([QuestionAnswer(picked: [1], typed: nil)]))
        let shown = ApprovalTranslation.shownQuestions(asked, byCall["toolu_q"])
        XCTAssertEqual(shown.first?.question, "哪一个？")
        XCTAssertEqual(shown.first?.header, "选择")
        XCTAssertEqual(shown.first?.options.map(\.label), ["是", "否"])
        XCTAssertEqual(shown.first?.options.map(\.description), ["做", nil], "no description where the original had none")
        if case .answered(let answers)? = outcome {
            XCTAssertEqual(QuestionRecords.answerLine(shown[0], answers[0]), "否")
        }
        XCTAssertEqual(ApprovalTranslation.shownQuestions(asked, ApprovalTranslation(lang: .zhHans, failed: true)), asked)
        XCTAssertEqual(ApprovalTranslation.shownQuestions(asked, nil), asked)
    }

    func testAPlanIsShownTranslated() {
        let input: JSONValue = .object(["plan": .string("Do the thing")])
        let shown = ApprovalTranslation.shownInput(input, ApprovalTranslation(lang: .de, plan: "Mach es"))
        XCTAssertEqual(shown?["plan"]?.stringValue, "Mach es")
    }

    func testADecisionAsksForSendAsWrittenOnlyWhenPressed() throws {
        func keys(_ req: ApprovalDecisionRequest) throws -> [String: Any] {
            try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(req)) as? [String: Any])
        }
        XCTAssertNil(try keys(ApprovalDecisionRequest(behavior: .allow))["sendAsWritten"])
        XCTAssertEqual(try keys(ApprovalDecisionRequest(behavior: .allow, sendAsWritten: true))["sendAsWritten"] as? Bool, true)
    }

    func testTheRefusalForWordsThatCouldNotBeTranslatedIsRecognized() {
        XCTAssertTrue(SessionTranslation.refusedUntranslated(APIError.http(status: 422, body: #"{"code":"TRANSLATION_FAILED"}"#)))
        XCTAssertFalse(SessionTranslation.refusedUntranslated(APIError.http(status: 422, body: #"{"code":"OTHER"}"#)))
        XCTAssertFalse(SessionTranslation.refusedUntranslated(APIError.http(status: 500, body: "TRANSLATION_FAILED")))
    }

    func testTheLiveTranslationEventIsLiveOnly() throws {
        let ev = try decode(RunEvent.self, #"{"seq":0,"type":"translation","payload":{"of":7,"lang":"ja","text":"x"}}"#)
        XCTAssertEqual(ev.type, .translation)
        XCTAssertFalse(ev.type.isDurable)
    }

    // MARK: - What the foot under a message says (frames 4–6)

    func testTheOwnersMessageFoot() {
        let done = TurnTranslation(state: .done, from: .zhHans, original: "修一下")
        XCTAssertEqual(SessionTranslation.userFoot(done, flipped: false),
                       [.action("Show original", .flip)])
        XCTAssertEqual(SessionTranslation.userFoot(done, flipped: true),
                       [.action("Show translation", .flip)])
        XCTAssertEqual(SessionTranslation.userFoot(TurnTranslation(state: .translating, from: .zhHans, original: "x"), flipped: false),
                       [.chip("Translating…")])
        XCTAssertEqual(SessionTranslation.userFoot(TurnTranslation(state: .failed, from: .zhHans, original: "x"), flipped: false),
                       [.text("Couldn't translate, so it wasn't sent"), .action("Retry", .retryTurn),
                        .action("Send as written", .sendAsWritten)])
        XCTAssertEqual(SessionTranslation.userFoot(TurnTranslation(state: .sentAsWritten, from: .zhHans, original: "x"), flipped: false), [])
        XCTAssertEqual(SessionTranslation.userFoot(nil, flipped: false), [])
    }

    /// A failed held message's line also offers Cancel, but never on the session's opening prompt
    /// (the server refuses to withdraw it), without a turn id, or while still translating.
    func testCancelIsOfferedOnAFailedMessageAndNotOnTheOpening() {
        let failed = TurnTranslation(state: .failed, from: .zhHans, original: "x")
        XCTAssertEqual(SessionTranslation.userFoot(failed, flipped: false, cancellable: true).last,
                       .action("Cancel", .cancelTurn))
        XCTAssertFalse(SessionTranslation.userFoot(failed, flipped: false).contains(.action("Cancel", .cancelTurn)))
        let translating = TurnTranslation(state: .translating, from: .zhHans, original: "x")
        XCTAssertEqual(SessionTranslation.userFoot(translating, flipped: false, cancellable: true),
                       [.chip("Translating…")])

        func bubble(_ translation: TurnTranslation, turnId: String? = "t1") -> UserBubble {
            var b = UserBubble(id: "b", text: "x", turnId: turnId, pending: true, queued: true)
            b.translation = translation
            return b
        }
        XCTAssertTrue(SessionTranslation.offersCancel(bubble(failed)))
        XCTAssertFalse(SessionTranslation.offersCancel(bubble(failed, turnId: nil)))
        XCTAssertFalse(SessionTranslation.offersCancel(bubble(translating)))
        var opening = bubble(failed)
        opening.opening = true
        XCTAssertFalse(SessionTranslation.offersCancel(opening))
    }

    /// A held opening is listed as queued, and keeps its `opening` mark there.
    func testAQueuedOpeningKeepsItsMarkSoItOffersNoCancel() throws {
        let rows = try JSONDecoder().decode([QueuedTurnInfo].self, from: Data("""
        [{"turnId":"t1","kind":"message","placement":"queued","content":"x","opening":true,
          "translation":{"state":"FAILED","from":"zh-Hans","original":"x"}},
         {"turnId":"t2","kind":"message","placement":"queued","content":"y",
          "translation":{"state":"FAILED","from":"zh-Hans","original":"y"}}]
        """.utf8))
        var reducer = TranscriptReducer()
        // First seen in a listing, then reconciled in place by the next one.
        for _ in 0..<2 {
            reducer.reconcileQueuedTurns(rows, knownBefore: [])
            XCTAssertEqual(reducer.state.queued.map(SessionTranslation.offersCancel), [false, true])
        }
        reducer.removeWithdrawnSteer(turnId: "t2")
        XCTAssertEqual(reducer.state.queued.map(\.turnId), ["t1"])
    }

    func testTheReplyFoot() {
        let done = ReplyTranslation(lang: .zhHans, text: "找到了")
        XCTAssertEqual(SessionTranslation.replyFoot(done, pending: false, flipped: false),
                       [.text("Translated"), .action("Show original", .flip)])
        XCTAssertEqual(SessionTranslation.replyFoot(done, pending: false, flipped: true),
                       [.text("Original"), .action("Show translation", .flip)])
        XCTAssertEqual(SessionTranslation.replyFoot(ReplyTranslation(lang: .zhHans, failed: true), pending: false, flipped: false),
                       [.text("Couldn't translate this reply"), .action("Retry", .retryReply)])
        XCTAssertEqual(SessionTranslation.replyFoot(nil, pending: true, flipped: false), [.chip("Translates when the reply is done")])
        XCTAssertEqual(SessionTranslation.replyFoot(nil, pending: false, flipped: false), [])
    }

    func testTheShowOriginalToggleFlipsTheWordsOnScreen() {
        let done = TurnTranslation(state: .done, from: .zhHans, original: "修一下")
        XCTAssertEqual(SessionTranslation.shownUserText("Fix it", done, flipped: false), "修一下")
        XCTAssertEqual(SessionTranslation.shownUserText("Fix it", done, flipped: true), "Fix it")
        XCTAssertEqual(SessionTranslation.shownUserText("再跑", TurnTranslation(state: .failed, from: .zhHans, original: "再跑"),
                                                 flipped: true), "再跑", "a held message has only what was written")
        XCTAssertEqual(SessionTranslation.shownUserText("plain", nil, flipped: true), "plain")
        let reply = ReplyTranslation(lang: .zhHans, text: "找到了")
        XCTAssertEqual(SessionTranslation.shownReplyText("Found it", reply, flipped: false), "找到了")
        XCTAssertEqual(SessionTranslation.shownReplyText("Found it", reply, flipped: true), "Found it")
        XCTAssertEqual(SessionTranslation.shownReplyText("Found it", ReplyTranslation(lang: .zhHans, failed: true), flipped: false),
                       "Found it", "a failed translation shows the English")
    }

    // MARK: - The transcript

    func testATranslatedMessageKeepsTheEnglishAndWhatTheOwnerWrote() {
        var reducer = TranscriptReducer()
        reducer.apply(user(1, english: "Fix the sign-in", original: "修一下登录"))
        let bubble = users(reducer.state).first
        XCTAssertEqual(bubble?.text, "Fix the sign-in")
        XCTAssertEqual(bubble?.translation?.original, "修一下登录")
        XCTAssertEqual(bubble?.translation?.state, .done)
    }

    func testARepliesTranslationRidesItsPayloadOnReplay() {
        var reducer = TranscriptReducer()
        reducer.apply(user(1, english: "Fix it", original: "修一下"))
        reducer.apply(event(2, .assistant, ["text": .string("Found it."),
                                            "translation": .object(["lang": .string("zh-Hans"), "text": .string("找到了。")])]))
        let reply = replies(reducer.state).first
        XCTAssertEqual(reply?.translation?.text, "找到了。")
        XCTAssertNil(reply?.awaitsTranslation)
    }

    func testAReplyInATranslatedTurnWaitsAndTheLiveEventFoldsIntoIt() {
        var reducer = TranscriptReducer()
        reducer.apply(user(1, english: "Fix it", original: "修一下"))
        reducer.apply(event(2, .assistant, ["text": .string("Found it.")]))
        XCTAssertEqual(replies(reducer.state).first?.awaitsTranslation, true, "2A: greyed with its chip")
        reducer.apply(event(0, .translation, ["of": .int(2), "lang": .string("zh-Hans"), "text": .string("找到了。")], turn: nil))
        XCTAssertEqual(replies(reducer.state).first?.translation?.text, "找到了。")
        XCTAssertNil(replies(reducer.state).first?.awaitsTranslation)
        // A failure, then Retry: waiting again until the next live event.
        reducer.apply(event(0, .translation, ["of": .int(2), "lang": .string("zh-Hans"), "failed": .bool(true)], turn: nil))
        XCTAssertEqual(replies(reducer.state).first?.translation?.failed, true)
        reducer.markReplyRetrying(seq: 2)
        XCTAssertNil(replies(reducer.state).first?.translation)
        XCTAssertEqual(replies(reducer.state).first?.awaitsTranslation, true)
    }

    func testAReplyAlreadyInTheOwnersLanguageIsDrawnAsItIs() {
        var reducer = TranscriptReducer()
        reducer.apply(user(1, english: "Fix it", original: "修一下"))
        // On replay: the translator handed back the reply itself, spaces aside.
        reducer.apply(event(2, .assistant, ["text": .string("找到了。"),
                                            "translation": .object(["lang": .string("zh-Hans"), "text": .string("找到了。\n")])]))
        XCTAssertNil(replies(reducer.state).first?.translation)
        XCTAssertNil(replies(reducer.state).first?.awaitsTranslation, "nor waits for one")
        // Live: the same, once the translation event arrives.
        reducer.apply(event(3, .assistant, ["text": .string("改好了。")]))
        XCTAssertEqual(replies(reducer.state).last?.awaitsTranslation, true)
        reducer.apply(event(0, .translation, ["of": .int(3), "lang": .string("zh-Hans"), "text": .string("改好了。")], turn: nil))
        XCTAssertNil(replies(reducer.state).last?.translation)
        XCTAssertNil(replies(reducer.state).last?.awaitsTranslation)
    }

    func testAReplyInAnUntranslatedTurnIsLeftAlone() {
        var reducer = TranscriptReducer()
        reducer.apply(event(1, .user, ["text": .string("Fix it")]))
        reducer.apply(event(2, .assistant, ["text": .string("Found it.")]))
        XCTAssertNil(replies(reducer.state).first?.awaitsTranslation)
        XCTAssertNil(replies(reducer.state).first?.translation)
    }

    func testATranslationForAnEventOutsideTheWindowChangesNothing() {
        var reducer = TranscriptReducer()
        reducer.apply(event(1, .user, ["text": .string("Fix it")]))
        let before = reducer.state
        reducer.apply(event(0, .translation, ["of": .int(99), "lang": .string("ja"), "text": .string("x")], turn: nil))
        XCTAssertEqual(reducer.state, before)
    }

    func testTheSuggestionIsOfferedTranslated() {
        var reducer = TranscriptReducer()
        reducer.apply(event(1, .user, ["text": .string("Fix it")]))
        reducer.apply(event(2, .turnEnd, ["subtype": .string("success")]))
        reducer.apply(event(3, .promptSuggestion, ["text": .string("run the tests")]))
        XCTAssertEqual(reducer.state.shownPromptSuggestion, "run the tests")
        reducer.apply(event(0, .translation, ["of": .int(3), "lang": .string("zh-Hans"), "text": .string("跑一下测试")], turn: nil))
        XCTAssertEqual(reducer.state.shownPromptSuggestion, "跑一下测试")
        XCTAssertEqual(reducer.state.promptSuggestion, "run the tests", "the English is kept")
        reducer.apply(event(4, .user, ["text": .string("ok")], turn: "turn-2"))
        XCTAssertNil(reducer.state.shownPromptSuggestion)
        XCTAssertNil(reducer.state.promptSuggestionTranslation)
    }

    func testAReplayedSuggestionCarriesItsTranslation() {
        var reducer = TranscriptReducer()
        reducer.apply(event(3, .promptSuggestion, ["text": .string("run the tests"),
                                                   "translation": .object(["lang": .string("ja"), "text": .string("テスト")])]))
        XCTAssertEqual(reducer.state.shownPromptSuggestion, "テスト")
    }

    func testARepublishedCardCarriesItsTranslation() {
        var reducer = TranscriptReducer()
        let input: JSONValue = .object(["questions": .array([.object(["question": .string("Which?"),
                                                                      "options": .array([.object(["label": .string("A")])])])])])
        reducer.apply(event(0, .approvalRequest, ["id": .string("a1"), "toolName": .string("AskUserQuestion"), "input": input], turn: nil))
        XCTAssertNil(reducer.state.pendingApprovals.first?.translation)
        reducer.apply(event(0, .approvalRequest, [
            "id": .string("a1"), "toolName": .string("AskUserQuestion"), "input": input,
            "translation": .object(["lang": .string("zh-Hans"), "questions": .array([.object([
                "question": .string("哪个？"), "options": .array([.object(["label": .string("甲")])])])])]),
        ], turn: nil))
        XCTAssertEqual(reducer.state.pendingApprovals.count, 1, "the same card, replaced")
        XCTAssertEqual(Approvals.parseQuestions(from: reducer.state.pendingApprovals[0].shownInput!).first?.question, "哪个？")
    }

    func testAHeldMessageIsDrawnInTheTailWithItsState() {
        var reducer = TranscriptReducer()
        let held = QueuedTurnInfo(turnId: "t9", kind: "message", content: "再跑一遍全部测试", placement: "queued",
                                  translation: .object(["state": .string("FAILED"), "from": .string("zh-Hans"),
                                                        "original": .string("再跑一遍全部测试")]))
        reducer.reconcileQueuedTurns([held], knownBefore: [])
        XCTAssertEqual(reducer.state.queued.first?.translation?.state, .failed)
        // Retry answers the new state at once.
        reducer.setTurnTranslation(turnId: "t9", TurnTranslation(state: .translating, from: .zhHans, original: "再跑一遍全部测试"))
        XCTAssertEqual(reducer.state.queued.first?.translation?.state, .translating)
    }

    /// Queued messages are drawn in the tray over the composer, but one held for its translation is not:
    /// it stays in the conversation with its chip or its failure, since the tray only waits for the
    /// engine (web parity: `inPendingTray`, board frame 6).
    func testAHeldMessageStaysOutOfTheTray() {
        var reducer = TranscriptReducer()
        func held(_ id: String, _ state: String) -> QueuedTurnInfo {
            QueuedTurnInfo(turnId: id, kind: "message", content: id, placement: "queued",
                           translation: .object(["state": .string(state), "from": .string("zh-Hans"),
                                                 "original": .string(id)]))
        }
        reducer.reconcileQueuedTurns([held("t1", "FAILED"), held("t2", "TRANSLATING"),
                                      QueuedTurnInfo(turnId: "t3", kind: "message", content: "plain", placement: "queued")],
                                     knownBefore: [])
        let rows = PendingTray.rows(state: reducer.state, withdrawing: [], steering: [], steerOffered: true)
        XCTAssertEqual(rows.map(\.bubble.turnId), ["t3"])
        XCTAssertEqual(rows.map(\.state), ["Queued for next turn"])
        XCTAssertEqual(reducer.state.queued.filter { !PendingTray.holds($0) }.map(\.turnId), ["t1", "t2"])
    }

    /// Sent while held, the message stays in the conversation; translated with a turn ahead of it, the
    /// next listing has it queued, and it moves to the tray (web parity: the snapshot re-places it).
    func testATranslatedMessageWaitingBehindATurnMovesToTheTray() {
        var reducer = TranscriptReducer()
        reducer.addOptimisticUser(clientTurnId: "c1", text: "再跑一遍")
        reducer.setOptimisticTurnId(clientTurnId: "c1", turnId: "t1",
                                    translation: TurnTranslation(state: .translating, from: .zhHans, original: "再跑一遍"),
                                    placement: "queued")
        func listed(_ state: String, _ placement: String) -> QueuedTurnInfo {
            QueuedTurnInfo(turnId: "t1", kind: "message", content: "再跑一遍", placement: placement,
                           translation: .object(["state": .string(state), "from": .string("zh-Hans"),
                                                 "original": .string("再跑一遍")]))
        }
        reducer.reconcileQueuedTurns([listed("TRANSLATING", "queued")], knownBefore: ["t1"])
        XCTAssertEqual(users(reducer.state).map(\.turnId), ["t1"], "still being translated: in the conversation")
        XCTAssertTrue(reducer.state.queued.isEmpty)
        // Translated, and accepted as the next turn: it stays where it is.
        reducer.reconcileQueuedTurns([listed("DONE", "accepted")], knownBefore: ["t1"])
        XCTAssertEqual(users(reducer.state).map(\.turnId), ["t1"])
        XCTAssertTrue(reducer.state.accepted.isEmpty, "drawn once, in the conversation")
        // Translated with a turn ahead of it: the tray's.
        reducer.reconcileQueuedTurns([listed("DONE", "queued")], knownBefore: ["t1"])
        XCTAssertTrue(users(reducer.state).isEmpty)
        XCTAssertEqual(reducer.state.queued.map(\.turnId), ["t1"])
        XCTAssertEqual(reducer.state.queued.first?.queued, true)
        XCTAssertEqual(PendingTray.rows(state: reducer.state, withdrawing: [], steering: [], steerOffered: false).map(\.state),
                       ["Queued for next turn"])
    }

    func testTheSendAnswerPutsTheChipOnTheOptimisticBubble() {
        var reducer = TranscriptReducer()
        reducer.addOptimisticUser(clientTurnId: "c1", text: "好的，改吧")
        reducer.setOptimisticTurnId(clientTurnId: "c1", turnId: "t1",
                                    translation: TurnTranslation(state: .translating, from: .zhHans, original: "好的，改吧"))
        let bubble = users(reducer.state).first ?? reducer.state.queued.first
        XCTAssertEqual(bubble?.translation?.state, .translating)
        // Its echo is the English, matched by turn id, and keeps the original beside it.
        reducer.apply(user(5, english: "OK, change it", original: "好的，改吧", turn: "t1"))
        XCTAssertEqual(users(reducer.state).count, 1, "one message, one row")
        XCTAssertEqual(users(reducer.state).first?.text, "OK, change it")
        XCTAssertEqual(users(reducer.state).first?.translation?.state, .done)
    }

    func testABubbleSnapshotFromBeforeTranslationStillDecodes() throws {
        let old = #"{"id":"u1","text":"hi","pending":false}"#
        XCTAssertNil(try decode(UserBubble.self, old).translation)
        let reply = #"{"id":"a1","text":"hello","streamingText":"","seq":3}"#
        XCTAssertNil(try decode(AssistantBubble.self, reply).translation)
    }
}
