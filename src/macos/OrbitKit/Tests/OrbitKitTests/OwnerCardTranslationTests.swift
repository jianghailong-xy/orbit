import XCTest
@testable import OrbitKit

/// Settings › Translation on the owner cards outside a session (board 04-owner-cards.html, frames
/// 1–4): each card decodes its `translation`, is drawn in the owner's language when that translation
/// is in the owner's language and did not fail (the original otherwise), flips whole with one
/// "Translated · Show original" foot, and answers a 422 TRANSLATION_FAILED with "Couldn't translate,
/// so it wasn't sent · Retry · Send as written".
final class OwnerCardTranslationTests: XCTestCase {

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    private let zh = TranslationLanguage.zhHans

    private let translatedFoot: [SessionTranslation.FootPart] =
        [.text(TranslationCopy.translated), .action(TranslationCopy.showOriginal, .flip)]
    private let originalFoot: [SessionTranslation.FootPart] =
        [.text(TranslationCopy.original), .action(TranslationCopy.showTranslation, .flip)]

    private func words(_ foot: [SessionTranslation.FootPart]) -> String {
        foot.map {
            switch $0 {
            case .text(let s), .chip(let s), .action(let s, _): return s
            }
        }.joined(separator: " · ")
    }

    // MARK: whose language

    func testCardsAreDrawnInTheOwnersLanguageOnlyWhileTranslationIsOn() throws {
        let on = try decode(User.self, #"{"id":"u1","email":"a@b.c","translationAvailable":true,"preferences":{"translationEnabled":true,"translationLanguage":"ja"}}"#)
        XCTAssertEqual(OwnerCardTranslations.ownerLanguage(on), .ja)
        let off = try decode(User.self, #"{"id":"u1","email":"a@b.c","translationAvailable":true,"preferences":{"translationEnabled":false,"translationLanguage":"ja"}}"#)
        XCTAssertNil(OwnerCardTranslations.ownerLanguage(off))
        let noKey = try decode(User.self, #"{"id":"u1","email":"a@b.c","translationAvailable":false,"preferences":{"translationEnabled":true}}"#)
        XCTAssertNil(OwnerCardTranslations.ownerLanguage(noKey))
        XCTAssertNil(OwnerCardTranslations.ownerLanguage(nil))
    }

    func testOnlyATranslationInTheOwnersLanguageThatDidNotFailIsUsed() {
        let t = OwnerCardTranslation(lang: "zh-Hans", question: "问题")
        XCTAssertEqual(OwnerCardTranslations.usable(t, owner: .zhHans), t)
        XCTAssertNil(OwnerCardTranslations.usable(t, owner: .ja), "another language: the original")
        XCTAssertNil(OwnerCardTranslations.usable(t, owner: nil), "translation off: the original")
        XCTAssertNil(OwnerCardTranslations.usable(OwnerCardTranslation(lang: "zh-Hans", failed: true), owner: .zhHans))
        XCTAssertNil(OwnerCardTranslations.usable(OwnerCardTranslation?.none, owner: .zhHans))
        XCTAssertNil(OwnerCardTranslations.usable(EvidenceTranslation(lang: "zh-Hans", failed: true), owner: .zhHans))
    }

    func testAnUnreadableTranslationCostsOnlyItself() throws {
        let t = try decode(OwnerCardTranslation.self, #"{"lang":"xx-new","question":7,"why":"为什么"}"#)
        XCTAssertEqual(t.lang, "xx-new")
        XCTAssertNil(t.question)
        XCTAssertEqual(t.why, "为什么")
        XCTAssertFalse(t.failed)
        let failed = try decode(OwnerCardTranslation.self, #"{"lang":"zh-Hans","failed":true}"#)
        XCTAssertTrue(failed.failed)
    }

    // MARK: the coordinator's question (frames 2 and 3)

    private let questionItem = """
    {"itemId":"i1","kind":"COORDINATOR_QUESTION","title":"Q","waitingSince":"2026-11-16T00:00:00Z",
     "question":{"question":"Keep the old columns?","options":[
        {"label":"Keep the old columns","description":"Both shapes for one release."},
        {"label":"Update the finance sheet"}],"recommendedOption":0,"blocksTaskIds":[],
        "ifUnanswered":"I keep both."},
     "translation":{"lang":"zh-Hans","question":"保留旧列吗？","options":[
        {"label":"保留旧列","description":"一个版本内两种格式都写。"},{"label":"改财务表"}],
        "ifUnanswered":"我两种都留。"}}
    """

    func testTheCoordinatorsQuestionDecodesAndIsDrawnTranslated() throws {
        let row = try decode(ProjectOpenItemRow.self, questionItem)
        XCTAssertEqual(row.translation?.lang, "zh-Hans")
        XCTAssertEqual(row.translation?.options?.first?.label, "保留旧列")

        let shown = try XCTUnwrap(row.shownQuestion(owner: zh, showOriginal: false))
        XCTAssertEqual(shown.question, "保留旧列吗？")
        XCTAssertEqual(shown.options.map(\.label), ["保留旧列", "改财务表"])
        XCTAssertEqual(shown.options[0].description, "一个版本内两种格式都写。")
        XCTAssertNil(shown.options[1].description, "the original has none")
        XCTAssertEqual(shown.ifUnanswered, "我两种都留。")
        XCTAssertEqual(shown.recommendedOption, 0, "answered by index, whatever the language")
        XCTAssertEqual(row.translationFoot(owner: zh, showOriginal: false), translatedFoot)
        XCTAssertEqual(words(row.translationFoot(owner: zh, showOriginal: false)), "Translated · Show original")

        // Show original: the whole card goes back at once.
        XCTAssertEqual(row.shownQuestion(owner: zh, showOriginal: true), row.question)
        XCTAssertEqual(words(row.translationFoot(owner: zh, showOriginal: true)), "Original · Show translation")
        XCTAssertEqual(row.translationFoot(owner: zh, showOriginal: true), originalFoot)
    }

    func testTheQuestionIsTheOriginalOtherwise() throws {
        let row = try decode(ProjectOpenItemRow.self, questionItem)
        for owner in [TranslationLanguage.ja, nil] {
            XCTAssertEqual(row.shownQuestion(owner: owner, showOriginal: false), row.question)
            XCTAssertEqual(row.translationFoot(owner: owner, showOriginal: false), [])
        }
        let failed = try decode(ProjectOpenItemRow.self, questionItem.replacingOccurrences(
            of: #""lang":"zh-Hans","question""#, with: #""lang":"zh-Hans","failed":true,"question""#))
        XCTAssertEqual(failed.shownQuestion(owner: zh, showOriginal: false), failed.question)
        XCTAssertEqual(failed.translationFoot(owner: zh, showOriginal: false), [])
        let none = try decode(ProjectOpenItemRow.self, #"{"itemId":"i1","kind":"COORDINATOR_QUESTION","question":{"question":"Q?"}}"#)
        XCTAssertNil(none.translation)
        XCTAssertEqual(none.shownQuestion(owner: zh, showOriginal: false)?.question, "Q?")
        XCTAssertEqual(none.translationFoot(owner: zh, showOriginal: false), [])
    }

    func testAnAnsweredQuestionsRecordIsDrawnTranslated() throws {
        let closed = try decode(ProjectClosedQuestion.self, """
        {"itemId":"i1","question":{"question":"Keep?","options":[{"label":"Yes"}]},"askedAt":"a",
         "resolution":"ANSWERED","resolvedBy":"USER","resolvedAt":"b","answer":{"option":0},
         "translation":{"lang":"zh-Hans","question":"保留？","options":[{"label":"是"}]}}
        """)
        XCTAssertEqual(closed.shownQuestion(owner: zh, showOriginal: false).question, "保留？")
        XCTAssertEqual(closed.shownQuestion(owner: zh, showOriginal: false).options.first?.label, "是")
        XCTAssertEqual(closed.shownQuestion(owner: zh, showOriginal: true).question, "Keep?")
        XCTAssertEqual(closed.translationFoot(owner: zh, showOriginal: false), translatedFoot)
        XCTAssertEqual(closed.shownQuestion(owner: .ja, showOriginal: false).question, "Keep?")
    }

    // MARK: start and done requests

    func testAStartRequestsWhyIsDrawnTranslated() throws {
        let row = try decode(ProjectOpenItemRow.self, """
        {"itemId":"i2","kind":"UNKNOWN","startRequest":{"settings":{"line":"MAIN","automatic":true,
          "maxConcurrentTasks":2},"why":"Plan is ready.",
          "criteriaDigest":"c"},"translation":{"lang":"zh-Hans","why":"计划好了。"}}
        """)
        XCTAssertNotNil(row.startRequest)
        XCTAssertEqual(row.translation?.why, "计划好了。")
        XCTAssertEqual(row.shownStartRequest(owner: zh, showOriginal: false)?.why, "计划好了。")
        XCTAssertEqual(row.shownStartRequest(owner: zh, showOriginal: true)?.why, "Plan is ready.")
        XCTAssertEqual(row.translationFoot(owner: zh, showOriginal: false), translatedFoot)
    }

    func testAStartRequestTranslatesItsWhy() {
        let t = OwnerCardTranslation(lang: "zh-Hans", why: "计划好了。")
        let settings = ProjectStartSettings(line: .main, automatic: true, maxConcurrentTasks: 2)
        let request = ProjectStartRequest(settings: settings, why: "Plan is ready.", criteriaDigest: "c")
        XCTAssertEqual(request.translated(t).why, "计划好了。")
        XCTAssertEqual(ProjectStartRequest(settings: settings, why: "", criteriaDigest: "c").translated(t).why, "",
                       "no original, nothing drawn")
    }

    func testADoneRequestIsDrawnTranslatedAndSendsItsOriginalGaps() throws {
        let row = try decode(ProjectOpenItemRow.self, """
        {"itemId":"i3","kind":"UNKNOWN","doneRequest":{"criteriaDigest":"c","judgment":"Done.",
          "gaps":[{"criterionKey":"k1","title":"No device run","whyNotProven":"No iPhone.","evidenceRefs":["r"]}]},
         "translation":{"lang":"zh-Hans","judgment":"做完了。",
          "gaps":[{"title":"没在真机跑","whyNotProven":"没有 iPhone。","coordinatorChecked":"x"}]}}
        """)
        XCTAssertEqual(row.translation?.gaps?.first?.title, "没在真机跑")
        let shown = try XCTUnwrap(row.shownDoneRequest(owner: zh, showOriginal: false))
        XCTAssertEqual(shown.judgment, "做完了。")
        XCTAssertEqual(shown.gaps.first?.title, "没在真机跑")
        XCTAssertEqual(shown.gaps.first?.whyNotProven, "没有 iPhone。")
        XCTAssertNil(shown.gaps.first?.coordinatorChecked, "a field the original lacks stays absent")
        XCTAssertEqual(shown.gaps.first?.criterionKey, "k1")
        XCTAssertEqual(shown.gaps.first?.evidenceRefs, ["r"])
        XCTAssertEqual(row.doneRequest?.gaps.first?.title, "No device run", "the press sends the original")
        XCTAssertEqual(row.shownDoneRequest(owner: zh, showOriginal: true), row.doneRequest)
        XCTAssertEqual(row.translationFoot(owner: zh, showOriginal: false), translatedFoot)
        XCTAssertEqual(row.translationFoot(owner: .ko, showOriginal: false), [])
    }

    // MARK: an owner request

    private let ownerRequest = """
    {"id":"r1","kind":"MANUAL_STEP","state":"PENDING","title":"Rotate the key","why":"It leaked.",
     "blocksTaskIds":[],"ifUnanswered":"I stop.","steps":[{"text":"Open the console","command":"open x",
     "link":"https://example.com"},{"text":"Press rotate"}],"verifyHint":"Run the check.",
     "options":[{"label":"A","description":"first"}],
     "askedBySessionId":"s1","createdAt":"2026-11-16T00:00:00Z",
     "translation":{"lang":"zh-Hans","title":"轮换密钥","why":"它泄露了。","ifUnanswered":"我停下。",
      "steps":[{"text":"打开控制台"},{"text":"点轮换"}],"verifyHint":"跑一下检查。",
      "options":[{"label":"甲","description":"第一个"}]}}
    """

    func testAnOwnerRequestDecodesAndIsDrawnTranslated() throws {
        let r = try decode(OwnerRequest.self, ownerRequest)
        XCTAssertEqual(r.translation?.steps?.count, 2)
        let shown = r.shown(owner: zh, showOriginal: false)
        XCTAssertEqual(shown.title, "轮换密钥")
        XCTAssertEqual(shown.why, "它泄露了。")
        XCTAssertEqual(shown.ifUnanswered, "我停下。")
        XCTAssertEqual(shown.verifyHint, "跑一下检查。")
        XCTAssertEqual(shown.steps?.map(\.text), ["打开控制台", "点轮换"])
        XCTAssertEqual(shown.steps?.first?.command, "open x", "a command is never translated")
        XCTAssertEqual(shown.steps?.first?.link, "https://example.com")
        XCTAssertEqual(shown.options?.first?.label, "甲")
        XCTAssertEqual(shown.options?.first?.description, "第一个")
        XCTAssertEqual(r.translationFoot(owner: zh, showOriginal: false), translatedFoot)
        XCTAssertEqual(r.shown(owner: zh, showOriginal: true), r)
        XCTAssertEqual(r.translationFoot(owner: zh, showOriginal: true), originalFoot)
        XCTAssertEqual(r.shown(owner: .ja, showOriginal: false), r)
        XCTAssertEqual(r.translationFoot(owner: nil, showOriginal: false), [])

        let failed = try decode(OwnerRequest.self, ownerRequest.replacingOccurrences(
            of: #""lang":"zh-Hans","title""#, with: #""lang":"zh-Hans","failed":true,"title""#))
        XCTAssertEqual(failed.shown(owner: zh, showOriginal: false), failed)
        XCTAssertEqual(failed.translationFoot(owner: zh, showOriginal: false), [])
    }

    // MARK: an owner confirmation

    func testAnOwnerConfirmationsReportAndReviewDecodeAndFlipTogether() throws {
        let view = try decode(OwnerConfirmationView.self, """
        {"taskId":"t1","title":"T","status":"OPEN","projectId":null,"completionCriterion":"OWNER_CONFIRMED",
         "acceptanceCriteria":null,"decisions":[],
         "waiting":{"requestId":"r1","sessionId":"s1","requestedAt":"2026-10-02T14:55:00Z",
          "report":{"text":"All done.","reportedAt":"2026-10-02T14:55:00Z",
                    "translation":{"lang":"zh-Hans","text":"都做完了。"}},
          "review":{"reviewId":"rv1","reviewer":{"kind":"TASK_CREATOR","sessionId":"s2","title":"R"},
           "since":"2026-10-02T14:55:00Z","dueAt":null,"windowSeconds":1800,"state":"REVIEWED",
           "notReviewedReason":null,"outdated":null,
           "headline":{"kind":"NEEDS_YOU","text":"Ship behind the flag?","more":0},
           "review":{"recordId":"rec1","recordedAt":"2026-10-02T15:00:00Z","reviewedSha":null,
            "judgment":"Looks right.","checked":[],"notChecked":[],"leftOpen":[],
            "needsYou":[{"key":"n1","text":"Ship behind the flag?","options":[{"label":"Yes","description":"Safer."},
              {"label":"No"}],"recommendedOption":0}],
            "translation":{"lang":"zh-Hans","judgment":"看起来没问题。",
             "needsYou":[{"text":"放在开关后面发？","options":[{"label":"是","description":"更稳。"},{"label":"否"}]}]}},
           "returned":null,
           "problems":{"recordId":"rec2","recordedAt":"2026-10-02T15:01:00Z","reviewedSha":null,
            "reason":"Two problems.","problems":[{"key":"p1","text":"Tests red."}],
            "translation":{"lang":"zh-Hans","reason":"两个问题。","problems":[{"text":"测试红了。"}]}}}}}
        """)
        let waiting = try XCTUnwrap(view.waiting)
        let report = try XCTUnwrap(waiting.report)
        let review = try XCTUnwrap(waiting.review)
        XCTAssertEqual(report.translation?.text, "都做完了。")
        XCTAssertEqual(review.review?.translation?.judgment, "看起来没问题。")
        XCTAssertEqual(review.problems?.translation?.reason, "两个问题。")

        XCTAssertEqual(report.shown(owner: zh, showOriginal: false).text, "都做完了。")
        XCTAssertEqual(report.shown(owner: zh, showOriginal: true).text, "All done.")
        XCTAssertEqual(report.shown(owner: .ja, showOriginal: false).text, "All done.")

        let shown = review.shown(owner: zh, showOriginal: false)
        XCTAssertEqual(shown.review?.judgment, "看起来没问题。")
        XCTAssertEqual(shown.review?.needsYou.first?.text, "放在开关后面发？")
        XCTAssertEqual(shown.review?.needsYou.first?.options.map(\.label), ["是", "否"])
        XCTAssertEqual(shown.review?.needsYou.first?.options.first?.description, "更稳。")
        XCTAssertEqual(shown.review?.needsYou.first?.key, "n1", "an answer is keyed by the original's key")
        XCTAssertEqual(shown.headline, .needsYou(text: "放在开关后面发？", more: 0))
        XCTAssertEqual(shown.problems?.reason, "两个问题。")
        XCTAssertEqual(shown.problems?.problems.first?.text, "测试红了。")
        XCTAssertEqual(review.shown(owner: zh, showOriginal: true), review)

        XCTAssertEqual(OwnerCardTranslations.confirmationFoot(report: report, review: review, owner: zh,
                                                              showOriginal: false), translatedFoot)
        XCTAssertEqual(OwnerCardTranslations.confirmationFoot(report: report, review: review, owner: zh,
                                                              showOriginal: true), originalFoot)
        XCTAssertEqual(OwnerCardTranslations.confirmationFoot(report: report, review: review, owner: .ja,
                                                              showOriginal: false), [])
        // The report's translation alone still earns the foot.
        XCTAssertEqual(OwnerCardTranslations.confirmationFoot(report: report, review: nil, owner: zh,
                                                              showOriginal: false), translatedFoot)
    }

    func testAReportWithAFailedTranslationIsTheOriginal() throws {
        let report = try decode(OwnerConfirmationReport.self,
                                #"{"text":"All done.","reportedAt":"t","translation":{"lang":"zh-Hans","failed":true}}"#)
        XCTAssertEqual(report.translation?.failed, true)
        XCTAssertEqual(report.shown(owner: zh, showOriginal: false).text, "All done.")
        XCTAssertEqual(OwnerCardTranslations.confirmationFoot(report: report, review: nil, owner: zh,
                                                              showOriginal: false), [])
        let older = try decode(OwnerConfirmationReport.self, #"{"text":"All done.","reportedAt":"t"}"#)
        XCTAssertNil(older.translation)
    }

    // MARK: completion evidence

    func testEvidenceDecodesAndIsDrawnTranslated() throws {
        let row = try decode(EvidenceDecisionRow.self, """
        {"taskId":"t1","title":"T","projectId":"p1","criterion":null,"evidenceRevision":"2",
         "claim":"Shipped the cards.","gaps":["No device run","No pg run"],"citations":[],
         "decidability":{"decidable":true,"refusal":null,"requiredAction":null},
         "independence":{"independent":true,"disqualification":null,"requiredAction":null},
         "translation":{"lang":"zh-Hans","claim":"卡片做完了。","gaps":["没在真机跑"]}}
        """)
        XCTAssertEqual(row.translation?.claim, "卡片做完了。")
        let shown = row.shown(owner: zh, showOriginal: false)
        XCTAssertEqual(shown.claim, "卡片做完了。")
        XCTAssertEqual(shown.gaps, ["没在真机跑", "No pg run"], "index for index; one not translated stays")
        XCTAssertEqual(shown.evidenceRevision, "2")
        XCTAssertEqual(row.shown(owner: zh, showOriginal: true), row)
        XCTAssertEqual(row.translationFoot(owner: zh, showOriginal: false), translatedFoot)
        XCTAssertEqual(row.translationFoot(owner: .ja, showOriginal: false), [])
        XCTAssertEqual(row.shown(owner: nil, showOriginal: false), row)
    }

    // MARK: a criteria-change proposal

    func testACriteriaProposalDecodesAndIsDrawnTranslated() throws {
        let row = try decode(PendingCriteriaDecisionRow.self, """
        {"intentId":"i1","projectId":"p1","commitToken":"tok","actionDigest":"d",
         "filedAt":"2026-09-09T12:00:00.000Z","ageSeconds":240,"baselineSeal":"a","currentSeal":"a",
         "proposed":[{"id":"c1","ordinal":1,"text":"Cards are translated","verificationMethod":"Unit tests",
                      "completionCriterionOverrideReason":null},
                     {"id":"c2","ordinal":2,"text":"Same","verificationMethod":"v",
                      "completionCriterionOverrideReason":null}],
         "diff":{"sameCount":1,"changedCount":1,"newCount":0,"removedCount":0,"entries":[
           {"change":"CHANGED","definitionId":"c1","ordinal":1,
            "proposed":{"text":"Cards are translated","verificationMethod":"Unit tests"},
            "onRecord":{"text":"Cards are drawn","verificationMethod":"Unit tests"},"changed":["text"],
            "rewrites":[{"field":"text","segments":[{"side":"KEPT","text":"Cards are "},
              {"side":"REMOVED","text":"drawn"},{"side":"ADDED","text":"translated"}]}]}]},
         "supersededIntentId":null,
         "decidability":{"decidable":true,"refusal":null,"requiredAction":null},
         "translation":{"lang":"zh-Hans","proposed":[{"text":"卡片已翻译","verificationMethod":"单元测试"},{}]}}
        """)
        XCTAssertEqual(row.translation?.proposed?.first?.text, "卡片已翻译")
        let shown = row.shown(owner: zh, showOriginal: false)
        XCTAssertEqual(shown.proposed.map(\.text), ["卡片已翻译", "Same"])
        XCTAssertEqual(shown.proposed.first?.verificationMethod, "单元测试")
        XCTAssertEqual(shown.diff.entries.first?.proposed?.text, "卡片已翻译")
        XCTAssertEqual(shown.diff.entries.first?.onRecord?.text, "Cards are drawn", "the words on record are not the proposal's")
        XCTAssertEqual(shown.diff.entries.first?.rewrites, [], "the cut is over the agent's words")
        XCTAssertEqual(shown.actionDigest, "d")
        XCTAssertEqual(row.shown(owner: zh, showOriginal: true), row)
        XCTAssertEqual(row.translationFoot(owner: zh, showOriginal: false), translatedFoot)
        XCTAssertEqual(row.translationFoot(owner: .ja, showOriginal: false), [])
    }

    // MARK: a crossing

    func testACrossingDecodesAndIsDrawnTranslated() throws {
        let crossing = try decode(ProjectCrossing.self, """
        {"id":"h1","fromProjectId":"p1","toProjectId":"p2","kind":"FILE_TASK","crossingKey":"k",
         "state":"PENDING","title":"Move the export","reason":"It belongs there.","requestedAt":"t",
         "translation":{"lang":"zh-Hans","title":"移走导出","reason":"它属于那边。"}}
        """)
        XCTAssertEqual(crossing.translation?.title, "移走导出")
        XCTAssertEqual(crossing.shown(owner: zh, showOriginal: false).title, "移走导出")
        XCTAssertEqual(crossing.shown(owner: zh, showOriginal: false).reason, "它属于那边。")
        XCTAssertEqual(crossing.shown(owner: zh, showOriginal: false).crossingKey, "k")
        XCTAssertEqual(crossing.shown(owner: zh, showOriginal: true), crossing)
        XCTAssertEqual(crossing.translationFoot(owner: zh, showOriginal: false), translatedFoot)
        XCTAssertEqual(crossing.translationFoot(owner: .ja, showOriginal: false), [])
    }

    // MARK: the refused answer (frame 4)

    func testATranslationFailedRefusalIsSendFailedWithRetryAndSendAsWritten() {
        let refusal = APIError.http(status: 422, body: #"{"code":"TRANSLATION_FAILED","message":"x"}"#)
        XCTAssertTrue(OwnerCardTranslations.refused(refusal))
        let foot = OwnerCardTranslations.answerFoot(after: refusal)
        XCTAssertEqual(foot, [SessionTranslation.FootPart.text(TranslationCopy.sendFailed),
                              .action(TranslationCopy.retry, .retryTurn),
                              .action(TranslationCopy.sendAsWritten, .sendAsWritten)])
        XCTAssertEqual(words(foot), "Couldn't translate, so it wasn't sent · Retry · Send as written")

        // Any other failure keeps the card's own error line.
        XCTAssertFalse(OwnerCardTranslations.refused(APIError.http(status: 422, body: #"{"code":"OTHER"}"#)))
        XCTAssertFalse(OwnerCardTranslations.refused(APIError.http(status: 500, body: #"{"code":"TRANSLATION_FAILED"}"#)))
        XCTAssertFalse(OwnerCardTranslations.refused(nil))
        XCTAssertEqual(OwnerCardTranslations.answerFoot(after: APIError.http(status: 409, body: nil)), [])
        XCTAssertEqual(OwnerCardTranslations.answerFoot(after: nil), [])
    }

    /// Send as written rides on every door the owner's words go through, and only when pressed.
    func testSendAsWrittenIsWrittenOnlyWhenPressed() throws {
        func json<T: Encodable>(_ body: T) throws -> [String: JSONValue] {
            let data = try JSONEncoder().encode(body)
            guard case .object(let o) = try JSONDecoder().decode(JSONValue.self, from: data) else { return [:] }
            return o
        }
        XCTAssertNil(try json(OwnerAnswerRequest(text: "x"))["sendAsWritten"])
        XCTAssertEqual(try json(OwnerAnswerRequest(text: "x", sendAsWritten: true))["sendAsWritten"], .bool(true))
        XCTAssertNil(try json(ProjectDoneDeclineBody(note: "x"))["sendAsWritten"])
        XCTAssertEqual(try json(ProjectDoneDeclineBody(note: "x", sendAsWritten: true))["sendAsWritten"], .bool(true))
        XCTAssertNil(try json(OwnerRequestDoneBody(text: "x"))["sendAsWritten"])
        XCTAssertEqual(try json(OwnerRequestDoneBody(text: "x", sendAsWritten: true))["sendAsWritten"], .bool(true))
        XCTAssertNil(try json(OwnerRequestDeclineBody(reason: "x"))["sendAsWritten"])
        XCTAssertEqual(try json(OwnerRequestDeclineBody(reason: "x", sendAsWritten: true))["sendAsWritten"], .bool(true))
        XCTAssertNil(try json(OwnerDecisionRequest(decision: .sendBack, note: "x"))["sendAsWritten"])
        XCTAssertEqual(try json(OwnerDecisionRequest(decision: .sendBack, note: "x", sendAsWritten: true))["sendAsWritten"],
                       .bool(true))
        XCTAssertNil(try json(EvidenceDecisionRequest(decidingSessionId: "s", evidenceRevision: "1",
                                                      decision: .sendBack, note: "x"))["sendAsWritten"])
        XCTAssertEqual(try json(EvidenceDecisionRequest(decidingSessionId: "s", evidenceRevision: "1",
                                                        decision: .sendBack, note: "x",
                                                        sendAsWritten: true))["sendAsWritten"], .bool(true))
    }
}
