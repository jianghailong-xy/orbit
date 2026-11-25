import XCTest
@testable import OrbitKit

/// Settings › Translation on a project's own words (`translation` on `GET /projects/:id`,
/// @orbit/shared `ProjectTextTranslation`): both project documents decode it, and "Is this project
/// done?" (asked or not), its Done when list and the why-not-done card draw the title and criteria
/// in the owner's language, matched by criterion id, with one "Translated · Show original" foot, as
/// does the project page's own Acceptance criteria list —
/// and the originals with no translation, a failed one, one in another language, or translation off.
final class ProjectTextTranslationTests: XCTestCase {

    /// A real `GET /projects/:id` answer (project 353RJQmZhOJFVF4a5LHrc, read 2026-11-25), kept to the
    /// fields these cards read — its goal, instructions and per-criterion audit fields left out — with
    /// the `translation` the server serves once one is stored (the shape
    /// `project-text-translation.pg.spec.ts` asserts: `{ lang, title, criteria: [{ id, text }] }`,
    /// no digest).
    private func payload(translation: String?) -> String {
        """
        {"id":"353RJQmZhOJFVF4a5LHrc","title":"Translate project criteria and title for the owner",
         "ownerId":"2p7QMFOwEGtL5oaTxZHihm","status":"OPEN","doneBy":null,"doneAt":null,"acceptedGaps":[],
         "nonCode":false,"coordinatorSessionId":"353R9GvARUVoJds27jf0q","coordinatorEnabled":true,
         "maxConcurrentTasks":3,"configRevision":"1","exceptionEscalationSeconds":7200,
         "startedAt":"2026-11-25T01:07:31.812Z","pausedAt":null,"createdAt":"2026-11-25T01:01:27.576Z",
         "updatedAt":"2026-11-25T01:24:53.250Z","_count":{"tasks":5},"tasksByStatus":{"OPEN":4,"DONE":1},
         "acceptanceCriteriaItems":[
          {"id":"3BzG1UL7dbTlQg9BnWtx2O","ordinal":1,"text":"With translation on, GET /projects/:id serves `translation` holding the project title and every criterion's text in the owner's language.","verificationMethod":"An apiserver pg spec.","satisfiedBy":"TASKS","key":"3BzG1UL7dbTlQg9BnWtx2O","revision":1,"satisfied":true,"unmet":[],"confirmation":null,"landing":"ON_INTEGRATION_LINE","movedFrom":null},
          {"id":"3xdXhR5bImqxrNhWBBmZuB","ordinal":2,"text":"The web draws the translated title and criteria on the \\"Is this project done?\\" card.","verificationMethod":"Web vitest specs.","satisfiedBy":"TASKS","key":"3xdXhR5bImqxrNhWBBmZuB","revision":1,"satisfied":false,"unmet":[{"clause":"SERVING_WORK_UNSETTLED","heldUpBy":[{"taskId":"353RKUTOJtfkDltRE4uc7","title":"Web: draw the translated project title","requiredAction":"SUBMIT_EVIDENCE_AND_AWAIT_INDEPENDENT_DECISION"}]}],"confirmation":null,"landing":"UNKNOWN","movedFrom":null},
          {"id":"6B0QupNv40Ja8OUYERPBX5","ordinal":3,"text":"iOS, macOS and Android draw the same translated title and criteria on the same surfaces from the server-built payload, with the same toggle and fallbacks.","verificationMethod":"OrbitKit swift tests.","satisfiedBy":"TASKS","key":"6B0QupNv40Ja8OUYERPBX5","revision":1,"satisfied":false,"unmet":[],"confirmation":null,"landing":"UNKNOWN","movedFrom":null},
          {"id":"3OcAZZHriAWSgzT3w925fn","ordinal":4,"text":"On a real stack with translation on (Chinese), the owner-started done card shows the title and criteria in Chinese.","verificationMethod":"A real-stack walk.","satisfiedBy":"TASKS","key":"3OcAZZHriAWSgzT3w925fn","revision":1,"satisfied":false,"unmet":[],"confirmation":null,"landing":"UNKNOWN","movedFrom":null}],
         "criteriaMovedOut":[],"rulings":[],"settingChanges":[],"blockers":{"open":[],"resolved":[],"resolvedCount":0},
         "integration":{"line":"PROJECT_BRANCH","lineAbsentReason":null,"ref":"project/translate-project-criteria-and-title-for-353RJQmZ","defaultProjectBranch":"project/translate-project-criteria-and-title-for-353RJQmZ","upstreamRef":"main","upstreamChosenAt":"2026-11-25T01:07:31.807Z","source":"EXPLICIT","locked":true,"startedAt":"2026-11-25T01:23:59.063Z","landingCheckCommand":null,"landingCheckTimeoutSeconds":null,"mergeCheckCommand":"scripts/merge-check.sh","mergeCheckTimeoutSeconds":5400,"escalationSeconds":7200,"deliveryMode":"PLATFORM"},
         "derivedDone":{"status":"OPEN","done":false,"withheld":["CRITERION_UNSATISFIED","CRITERION_UNLANDED"],"criteria":[
          {"definitionId":"3BzG1UL7dbTlQg9BnWtx2O","satisfied":true,"landing":"ON_INTEGRATION_LINE","landingReason":"ON_PROJECT_BRANCH","satisfiedBy":"TASKS","confirmation":null,"withheld":["CRITERION_UNLANDED"]},
          {"definitionId":"3xdXhR5bImqxrNhWBBmZuB","satisfied":false,"landing":"UNKNOWN","landingReason":"NO_RECEIPT","satisfiedBy":"TASKS","confirmation":null,"withheld":["CRITERION_UNSATISFIED","CRITERION_UNLANDED"]},
          {"definitionId":"6B0QupNv40Ja8OUYERPBX5","satisfied":false,"landing":"UNKNOWN","landingReason":"NO_RECEIPT","satisfiedBy":"TASKS","confirmation":null,"withheld":["CRITERION_UNSATISFIED","CRITERION_UNLANDED"]},
          {"definitionId":"3OcAZZHriAWSgzT3w925fn","satisfied":false,"landing":"UNKNOWN","landingReason":"NO_BRANCH","satisfiedBy":"TASKS","confirmation":null,"withheld":["CRITERION_UNSATISFIED","CRITERION_UNLANDED"]}],
          "confirmation":"CONFIRMED","counts":{"criteria":4,"met":1,"landed":0,"onMain":0,"byReason":{"IN_FLIGHT":0,"ON_PROJECT_BRANCH":1,"NOTHING_TO_LAND":0,"NO_RECEIPT":0,"NO_BRANCH":0,"CODELESS":0}},"nonCode":false}
         \(translation.map { ",\"translation\":\($0)" } ?? "")}
        """
    }

    /// The server's translation, its criteria in an order other than the document's: they are matched
    /// by id, never by position.
    private let zhTranslation = """
    {"lang":"zh-Hans","title":"为负责人翻译项目标准和标题",
     "criteria":[{"id":"6B0QupNv40Ja8OUYERPBX5","text":"iOS、macOS 和 Android 绘制相同的翻译。"},
                 {"id":"3BzG1UL7dbTlQg9BnWtx2O","text":"开启翻译后，GET /projects/:id 提供翻译。"},
                 {"id":"3xdXhR5bImqxrNhWBBmZuB","text":"网页绘制翻译后的标题和标准。"},
                 {"id":"3OcAZZHriAWSgzT3w925fn","text":"在真实环境中，卡片显示中文。"}]}
    """

    private let zh = TranslationLanguage.zhHans
    private let translatedFoot: [SessionTranslation.FootPart] =
        [.text(TranslationCopy.translated), .action(TranslationCopy.showOriginal, .flip)]
    private let originalFoot: [SessionTranslation.FootPart] =
        [.text(TranslationCopy.original), .action(TranslationCopy.showTranslation, .flip)]

    private func document(_ translation: String?) throws -> ProjectDocument {
        try JSONDecoder().decode(ProjectDocument.self, from: Data(payload(translation: translation).utf8))
    }

    private func criteriaDocument(_ translation: String?) throws -> ProjectCriteriaDocument {
        try JSONDecoder().decode(ProjectCriteriaDocument.self, from: Data(payload(translation: translation).utf8))
    }

    private func text(_ subject: ProjectDoneSubject, _ id: String) -> String? { subject.criterion(id)?.text }

    // MARK: decoding

    func testBothProjectDocumentsDecodeTheServersTranslation() throws {
        for subject in [try document(zhTranslation).doneSubject, try criteriaDocument(zhTranslation).doneSubject] {
            let t = try XCTUnwrap(subject.translation)
            XCTAssertEqual(t.lang, "zh-Hans")
            XCTAssertFalse(t.failed)
            XCTAssertEqual(t.title, "为负责人翻译项目标准和标题")
            XCTAssertEqual(t.criteria?.count, 4)
            XCTAssertEqual(subject.title, "Translate project criteria and title for the owner",
                           "the document's own words stay what the agent wrote")
        }
        XCTAssertNil(try document(nil).translation, "translation off: the read carries no field")
        XCTAssertNil(try criteriaDocument(nil).translation)
    }

    func testAFailedTranslationAndAnUnreadableEntryDecodeWithoutFailingTheRead() throws {
        let failed = try document(#"{"lang":"zh-Hans","failed":true}"#)
        XCTAssertEqual(failed.translation, ProjectTextTranslation(lang: "zh-Hans", failed: true))
        let lossy = try document(#"{"lang":"zh-Hans","title":7,"criteria":[{"id":"6B0QupNv40Ja8OUYERPBX5","text":"甲"},{"id":1}]}"#)
        XCTAssertNil(lossy.translation?.title)
        XCTAssertEqual(lossy.translation?.criteria, [.init(id: "6B0QupNv40Ja8OUYERPBX5", text: "甲")])
        XCTAssertEqual(lossy.title, "Translate project criteria and title for the owner")
    }

    func testTheTranslationSurvivesAnEncodeAndDecode() throws {
        let doc = try document(zhTranslation)
        let again = try JSONDecoder().decode(ProjectDocument.self, from: JSONEncoder().encode(doc))
        XCTAssertEqual(again.translation, doc.translation)
        let narrow = try criteriaDocument(zhTranslation)
        let narrowAgain = try JSONDecoder().decode(ProjectCriteriaDocument.self, from: JSONEncoder().encode(narrow))
        XCTAssertEqual(narrowAgain.translation, narrow.translation)
    }

    // MARK: drawn translated

    func testTheDoneCardsDrawTheTitleAndCriteriaTranslatedMatchedById() throws {
        let subject = try document(zhTranslation).doneSubject
        let shown = subject.shown(owner: zh, showOriginal: false)
        XCTAssertEqual(shown.title, "为负责人翻译项目标准和标题")
        XCTAssertEqual(text(shown, "3BzG1UL7dbTlQg9BnWtx2O"), "开启翻译后，GET /projects/:id 提供翻译。")
        XCTAssertEqual(text(shown, "6B0QupNv40Ja8OUYERPBX5"), "iOS、macOS 和 Android 绘制相同的翻译。")
        XCTAssertEqual(shown.criteria.map(\.ordinal), [1, 2, 3, 4], "the document's order, not the translation's")
        // A criterion reached by its key, as a gap names it, reads the same translated words.
        XCTAssertEqual(shown.criterion("3OcAZZHriAWSgzT3w925fn")?.text, "在真实环境中，卡片显示中文。")
        // Everything else the cards read is the document's.
        XCTAssertEqual(shown.derivedDone, subject.derivedDone)
        XCTAssertEqual(shown.criteria.map(\.verificationMethod), subject.criteria.map(\.verificationMethod))
        XCTAssertEqual(shown.main, "main")
        XCTAssertEqual(ProjectDone.cardTally(shown), ProjectDone.cardTally(subject))
        // The coordinator is handed the original, not the drawn words.
        XCTAssertTrue(ProjectDone.settlementContext(subject).contains("Translate project criteria and title"))
    }

    func testTheConversationsDocumentDrawsTheSameWords() throws {
        let page = try document(zhTranslation).doneSubject.shown(owner: zh, showOriginal: false)
        let conversation = try criteriaDocument(zhTranslation).doneSubject.shown(owner: zh, showOriginal: false)
        XCTAssertEqual(conversation.title, page.title)
        XCTAssertEqual(conversation.criteria.map(\.text), page.criteria.map(\.text))
    }

    func testShowOriginalDrawsTheAgentsWordsAndFlipsTheFoot() throws {
        let subject = try document(zhTranslation).doneSubject
        XCTAssertEqual(subject.shown(owner: zh, showOriginal: true), subject)
        // The owner-started card: no request, and the foot is the project's words' own.
        XCTAssertEqual(OwnerCardTranslations.doneCardFoot(subject: subject, request: nil, owner: zh,
                                                          showOriginal: false), translatedFoot)
        XCTAssertEqual(OwnerCardTranslations.doneCardFoot(subject: subject, request: nil, owner: zh,
                                                          showOriginal: true), originalFoot)
    }

    func testACriterionTheTranslationDoesNotNameKeepsItsWords() throws {
        let partial = try document(#"{"lang":"zh-Hans","criteria":[{"id":"3xdXhR5bImqxrNhWBBmZuB","text":"网页。"}]}"#)
            .doneSubject
        let shown = partial.shown(owner: zh, showOriginal: false)
        XCTAssertEqual(shown.title, partial.title, "no translated title: the original")
        XCTAssertEqual(text(shown, "3xdXhR5bImqxrNhWBBmZuB"), "网页。")
        XCTAssertEqual(text(shown, "6B0QupNv40Ja8OUYERPBX5"), text(partial, "6B0QupNv40Ja8OUYERPBX5"))
    }

    // MARK: the request card

    private func doneRequestRow(translated: Bool) throws -> ProjectOpenItemRow {
        let translation = translated ? #","translation":{"lang":"zh-Hans","judgment":"做完了。"}"# : ""
        return try JSONDecoder().decode(ProjectOpenItemRow.self, from: Data("""
        {"itemId":"34Y9req","kind":"DONE_REQUEST","title":"Is this project done?",
         "doneRequest":{"criteriaDigest":"c","judgment":"Done.","gaps":[]}\(translation)}
        """.utf8))
    }

    func testTheRequestedCardFlipsTheProjectsWordsAndTheRequestWithOneFoot() throws {
        let subject = try document(zhTranslation).doneSubject
        let plain = try doneRequestRow(translated: false)
        XCTAssertEqual(OwnerCardTranslations.doneCardFoot(subject: subject, request: plain, owner: zh,
                                                          showOriginal: false), translatedFoot,
                       "a request with no translation of its own still flips the project's words")
        let untranslatedProject = try document(nil).doneSubject
        let translatedRow = try doneRequestRow(translated: true)
        XCTAssertEqual(OwnerCardTranslations.doneCardFoot(subject: untranslatedProject, request: translatedRow,
                                                          owner: zh, showOriginal: false), translatedFoot,
                       "the request's translation keeps its foot when the project has none")
        XCTAssertEqual(OwnerCardTranslations.doneCardFoot(subject: untranslatedProject, request: plain,
                                                          owner: zh, showOriginal: false), [])
    }

    // MARK: the why-not-done card

    func testTheWhyNotDoneCardDrawsItsCriteriaTranslatedWithAFoot() throws {
        let subject = try document(zhTranslation).doneSubject
        let why = ProjectDone.WhyNotDone(subject: subject, withCoordinator: 0, requested: false)
        // Criterion 1 is met and on the project branch, on its way to main; the rest are not met.
        XCTAssertEqual(why.waiting.map(\.definitionId),
                       ["3BzG1UL7dbTlQg9BnWtx2O", "3xdXhR5bImqxrNhWBBmZuB", "6B0QupNv40Ja8OUYERPBX5",
                        "3OcAZZHriAWSgzT3w925fn"])
        let shown = subject.shown(owner: zh, showOriginal: false)
        XCTAssertEqual(text(shown, "3xdXhR5bImqxrNhWBBmZuB"), "网页绘制翻译后的标题和标准。")
        XCTAssertEqual(subject.whyNotDoneFoot(why, owner: zh, showOriginal: false), translatedFoot)
        XCTAssertEqual(subject.whyNotDoneFoot(why, owner: zh, showOriginal: true), originalFoot)
        // It draws no title, so a translation of the title alone draws no foot there.
        let titleOnly = try document(#"{"lang":"zh-Hans","title":"标题"}"#).doneSubject
        XCTAssertEqual(titleOnly.whyNotDoneFoot(why, owner: zh, showOriginal: false), [])
    }

    // MARK: the project page's Acceptance criteria list

    func testThePagesCriteriaListDrawsTheTranslatedTextByIdWithOneFoot() throws {
        let doc = try document(zhTranslation)
        let rows = doc.acceptanceCriteriaItems.map { doc.criterionText($0, owner: zh, showOriginal: false) }
        XCTAssertEqual(rows, ["开启翻译后，GET /projects/:id 提供翻译。", "网页绘制翻译后的标题和标准。",
                              "iOS、macOS 和 Android 绘制相同的翻译。", "在真实环境中，卡片显示中文。"],
                       "each row by its own id, in the document's order")
        XCTAssertEqual(doc.criteriaTranslationFoot(owner: zh, showOriginal: false), translatedFoot)
        // Show original: the agent's words, and the foot offers the translation back.
        XCTAssertEqual(doc.acceptanceCriteriaItems.map { doc.criterionText($0, owner: zh, showOriginal: true) },
                       doc.acceptanceCriteriaItems.map(\.text))
        XCTAssertEqual(doc.criteriaTranslationFoot(owner: zh, showOriginal: true), originalFoot)
        XCTAssertTrue(doc.acceptanceCriteriaItems[0].text.hasPrefix("With translation on"),
                      "the criterion itself, which every press reads, stays as written")
    }

    func testThePagesCriteriaListIsAsWrittenWithoutAUsableTranslation() throws {
        let cases: [(String, ProjectDocument, TranslationLanguage?)] = [
            ("no translation", try document(nil), zh),
            ("failed", try document(#"{"lang":"zh-Hans","failed":true}"#), zh),
            ("another language", try document(zhTranslation), .ja),
            ("translation off", try document(zhTranslation), nil),
            ("title only", try document(#"{"lang":"zh-Hans","title":"标题"}"#), zh),
        ]
        for (label, doc, owner) in cases {
            XCTAssertEqual(doc.acceptanceCriteriaItems.map { doc.criterionText($0, owner: owner, showOriginal: false) },
                           doc.acceptanceCriteriaItems.map(\.text), label)
            XCTAssertEqual(doc.criteriaTranslationFoot(owner: owner, showOriginal: false), [], label)
        }
        // One criterion the translation does not name keeps its words; the others are translated.
        let partial = try document(#"{"lang":"zh-Hans","criteria":[{"id":"3xdXhR5bImqxrNhWBBmZuB","text":"网页。"}]}"#)
        XCTAssertEqual(partial.acceptanceCriteriaItems.map { partial.criterionText($0, owner: zh, showOriginal: false) },
                       [partial.acceptanceCriteriaItems[0].text, "网页。", partial.acceptanceCriteriaItems[2].text,
                        partial.acceptanceCriteriaItems[3].text])
        XCTAssertEqual(partial.criteriaTranslationFoot(owner: zh, showOriginal: false), translatedFoot)
    }

    // MARK: the fallbacks

    func testTheOriginalsAreDrawnWithoutAUsableTranslation() throws {
        let cases: [(String, ProjectDoneSubject, TranslationLanguage?)] = [
            ("no translation", try document(nil).doneSubject, zh),
            ("failed", try document(#"{"lang":"zh-Hans","failed":true}"#).doneSubject, zh),
            ("another language", try document(zhTranslation).doneSubject, .ja),
            ("translation off", try document(zhTranslation).doneSubject, nil),
        ]
        for (label, subject, owner) in cases {
            XCTAssertEqual(subject.shown(owner: owner, showOriginal: false), subject, label)
            XCTAssertEqual(subject.shown(owner: owner, showOriginal: false).title,
                           "Translate project criteria and title for the owner", label)
            XCTAssertEqual(OwnerCardTranslations.doneCardFoot(subject: subject, request: nil, owner: owner,
                                                              showOriginal: false), [], label)
            let why = ProjectDone.WhyNotDone(subject: subject, withCoordinator: 0, requested: false)
            XCTAssertEqual(subject.whyNotDoneFoot(why, owner: owner, showOriginal: false), [], label)
        }
    }
}
