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
         "preferences":{"translationEnabled":true,"translationLanguage":"ja"}}
        """)
        XCTAssertEqual(me.translationAvailable, true)
        XCTAssertEqual(me.preferences?.translationEnabled, true)
        XCTAssertEqual(SessionTranslation.language(me.preferences), .ja)
        XCTAssertTrue(SessionTranslation.isOn(me))
        XCTAssertFalse(SessionTranslation.unavailable(me))
    }

    func testAbsentIsOffAndTheDefaultLanguage() throws {
        let me = try decode(User.self, #"{"id":"u1","email":"a@b.c","translationAvailable":true,"preferences":{}}"#)
        XCTAssertNil(me.preferences?.translationEnabled)
        XCTAssertFalse(SessionTranslation.isOn(me), "absent = off")
        XCTAssertEqual(SessionTranslation.language(me.preferences), .zhHans)
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

    func testAStrayValueReadsAsAbsentAndAnUnknownLanguageAsTheDefault() throws {
        let prefs = try decode(UserPreferences.self, #"{"translationEnabled":"yes","translationLanguage":"xx"}"#)
        XCTAssertNil(prefs.translationEnabled)
        XCTAssertEqual(SessionTranslation.language(prefs), .zhHans)
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
    }

    // MARK: - The languages and the composer tag

    func testTheSevenLanguagesInTheWebsOrderWithTheirNames() {
        XCTAssertEqual(TranslationLanguage.allCases.map(\.rawValue), ["zh-Hans", "zh-Hant", "ja", "ko", "es", "fr", "de"])
        XCTAssertEqual(TranslationLanguage.allCases.map(\.name), [
            "Chinese (Simplified)", "Chinese (Traditional)", "Japanese", "Korean", "Spanish", "French", "German",
        ])
    }

    func testTheComposerTagDropsTheParenthesis() {
        XCTAssertEqual(TranslationLanguage.zhHans.tag, "Chinese → English")
        XCTAssertEqual(TranslationLanguage.zhHant.tag, "Chinese → English")
        XCTAssertEqual(TranslationLanguage.ja.tag, "Japanese → English")
    }

    func testTheComposerTagOpensSettingsOnSessions() {
        var nav = NavState()
        nav.openSettings(at: .sessions)
        XCTAssertTrue(nav.settingsPresented)
        XCTAssertEqual(nav.settingsPath, [.settingsPage(.sessions)])
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
                       [.text("Translated"), .action("Show original", .flip)])
        XCTAssertEqual(SessionTranslation.userFoot(done, flipped: true),
                       [.text("Sent to the agent in English"), .action("Show translation", .flip)])
        XCTAssertEqual(SessionTranslation.userFoot(TurnTranslation(state: .translating, from: .zhHans, original: "x"), flipped: false),
                       [.chip("Translating…")])
        XCTAssertEqual(SessionTranslation.userFoot(TurnTranslation(state: .failed, from: .zhHans, original: "x"), flipped: false),
                       [.text("Couldn't translate, so it wasn't sent"), .action("Retry", .retryTurn),
                        .action("Send as written", .sendAsWritten)])
        XCTAssertEqual(SessionTranslation.userFoot(TurnTranslation(state: .sentAsWritten, from: .zhHans, original: "x"), flipped: false), [])
        XCTAssertEqual(SessionTranslation.userFoot(nil, flipped: false), [])
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

    /// Queued messages are drawn in the tray over the composer: a held one says where its translation
    /// is, and cannot be steered.
    func testTheTraySaysWhereAHeldMessageIs() {
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
        XCTAssertEqual(rows.map(\.state), ["Couldn't translate, so it wasn't sent", "Translating…", "Queued for next turn"])
        XCTAssertEqual(rows.map(\.offersSteer), [false, false, true])
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
