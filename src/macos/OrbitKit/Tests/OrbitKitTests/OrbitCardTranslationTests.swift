import XCTest
@testable import OrbitKit

/// Settings › Translation on Orbit's own cards (board 04-owner-cards.html, part 2): a create, a
/// batch, a project, a blocker resolve and a DAG change draw their agent-written fields in the
/// owner's language, with one foot that flips the whole card back to what the agent wrote.
final class OrbitCardTranslationTests: XCTestCase {

    /// The card as it arrives: an ApprovalInfo off the wire, `translation` read the way the reducer does.
    private func approval(_ tool: String, input: String, translation: String?) throws -> PendingApproval {
        let translated = translation.map { #","translation":"# + $0 } ?? ""
        let raw = #"{"id":"a1","toolName":""# + tool + #"","status":"pending","input":"# + input + translated + "}"
        let info = try JSONDecoder().decode(ApprovalInfo.self, from: Data(raw.utf8))
        return PendingApproval(id: info.id, kind: .tool, toolName: info.toolName, input: info.input,
                               translation: ApprovalTranslation.parse(info.translation))
    }

    private func input(_ a: PendingApproval, showOriginal: Bool) throws -> JSONValue {
        try XCTUnwrap(Approvals.orbitCardInput(a, showOriginal: showOriginal))
    }

    private let translatedFoot: [SessionTranslation.FootPart] =
        [.text(TranslationCopy.translated), .action(TranslationCopy.showOriginal, .flip)]
    private let originalFoot: [SessionTranslation.FootPart] =
        [.text(TranslationCopy.original), .action(TranslationCopy.showTranslation, .flip)]

    /// The foot, as words: "Translated · Show original".
    private func words(_ foot: [SessionTranslation.FootPart]) -> String {
        foot.map {
            switch $0 {
            case .text(let s), .chip(let s), .action(let s, _): return s
            }
        }.joined(separator: " · ")
    }

    /// Translated, the foot reads "Translated · Show original"; flipped, "Original · Show translation".
    private func assertFoot(_ a: PendingApproval, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(Approvals.orbitCardFoot(a, showOriginal: false), translatedFoot, file: file, line: line)
        XCTAssertEqual(words(Approvals.orbitCardFoot(a, showOriginal: false)), "Translated · Show original",
                       file: file, line: line)
        XCTAssertEqual(Approvals.orbitCardFoot(a, showOriginal: true), originalFoot, file: file, line: line)
        XCTAssertEqual(words(Approvals.orbitCardFoot(a, showOriginal: true)), "Original · Show translation",
                       file: file, line: line)
    }

    /// No translation, or a failed one: the original, and no foot either way.
    private func assertUntranslated(_ tool: String, input: String,
                                    check: (JSONValue) throws -> Void,
                                    file: StaticString = #filePath, line: UInt = #line) throws {
        for translation in [nil, #"{"lang":"zh-Hans","failed":true}"#] {
            let a = try approval(tool, input: input, translation: translation)
            try check(try self.input(a, showOriginal: false))
            XCTAssertEqual(Approvals.orbitCardFoot(a, showOriginal: false), [], file: file, line: line)
            XCTAssertEqual(Approvals.orbitCardFoot(a, showOriginal: true), [], file: file, line: line)
        }
    }

    // MARK: orbit_task_create

    private let taskInput = """
    {"title":"Fix login","description":"Fix the redirect.","acceptanceCriteria":"Login lands home.",
     "completionCriterion":"EXECUTABLE"}
    """

    func testTaskCreateDrawsTitleDescriptionAndCriteriaTranslated() throws {
        let a = try approval("orbit_task_create", input: taskInput, translation: """
        {"lang":"zh-Hans","title":"T-title","description":"T-description","acceptanceCriteria":"T-criteria"}
        """)
        let shown = try XCTUnwrap(Approvals.createPreview(toolName: "orbit_task_create",
                                                          from: input(a, showOriginal: false)))
        XCTAssertEqual(shown.titleLine, "T-title")
        XCTAssertEqual(shown.descriptionText, "T-description")
        XCTAssertEqual(shown.criteriaText, "T-criteria")
        assertFoot(a)

        let original = try XCTUnwrap(Approvals.createPreview(toolName: "orbit_task_create",
                                                             from: input(a, showOriginal: true)))
        XCTAssertEqual(original.titleLine, "Fix login")
        XCTAssertEqual(original.descriptionText, "Fix the redirect.")
        XCTAssertEqual(original.criteriaText, "Login lands home.")
    }

    func testTaskCreateKeepsAFieldTheTranslationLacks() throws {
        let a = try approval("orbit_task_create", input: taskInput,
                             translation: #"{"lang":"zh-Hans","description":"T-description"}"#)
        let shown = try XCTUnwrap(Approvals.createPreview(toolName: "orbit_task_create",
                                                          from: input(a, showOriginal: false)))
        XCTAssertEqual(shown.titleLine, "Fix login")
        XCTAssertEqual(shown.descriptionText, "T-description")
        XCTAssertEqual(shown.criteriaText, "Login lands home.")
        assertFoot(a)
    }

    func testTaskCreateUntranslatedDrawsTheOriginalWithNoFoot() throws {
        try assertUntranslated("orbit_task_create", input: taskInput) { input in
            let p = try XCTUnwrap(Approvals.createPreview(toolName: "orbit_task_create", from: input))
            XCTAssertEqual(p.titleLine, "Fix login")
            XCTAssertEqual(p.descriptionText, "Fix the redirect.")
            XCTAssertEqual(p.criteriaText, "Login lands home.")
        }
    }

    // MARK: orbit_task_batch

    private let batchInput = """
    {"tasks":[{"title":"Read","description":"Read it.","acceptanceCriteria":"Read."},
              {"title":"Answer","description":"Answer it."}],
     "preview":{"taskCount":2,"tasks":[{"title":"Read","ref":"read"},
                                      {"title":"Answer","dependsOnRefs":["read"]}]}}
    """

    func testBatchDrawsEachTaskTitleTranslated() throws {
        let a = try approval("orbit_task_batch", input: batchInput, translation: """
        {"lang":"zh-Hans","tasks":[{"title":"T-read","description":"T-read-it","acceptanceCriteria":"T-done"},
                                 {"title":"T-answer"}]}
        """)
        let shown = try XCTUnwrap(Approvals.batchPreview(from: input(a, showOriginal: false)))
        XCTAssertEqual(shown.tasks.map(\.title), ["T-read", "T-answer"])
        XCTAssertEqual(shown.tasks.last?.dependsOnRefs, ["read"])
        let details = Approvals.batchTaskDetails(from: try input(a, showOriginal: false))
        XCTAssertEqual(details.map(\.title), ["T-read", "T-answer"])
        XCTAssertEqual(details.map(\.description), ["T-read-it", "Answer it."])
        XCTAssertEqual(details.first?.acceptanceCriteria, "T-done")
        assertFoot(a)

        let original = try XCTUnwrap(Approvals.batchPreview(from: input(a, showOriginal: true)))
        XCTAssertEqual(original.tasks.map(\.title), ["Read", "Answer"])
        XCTAssertEqual(Approvals.batchTaskDetails(from: try input(a, showOriginal: true)).map(\.description),
                       ["Read it.", "Answer it."])
    }

    func testBatchUntranslatedDrawsTheOriginalWithNoFoot() throws {
        try assertUntranslated("orbit_task_batch", input: batchInput) { input in
            XCTAssertEqual(try XCTUnwrap(Approvals.batchPreview(from: input)).tasks.map(\.title), ["Read", "Answer"])
        }
    }

    // MARK: orbit_project_create

    private let projectInput = """
    {"title":"Cards","goal":"Every card works.","instructions":"Go slow.",
     "acceptanceCriteriaItems":[{"text":"All cards work","verificationMethod":"Click each"},
                                {"text":"No crash"}]}
    """

    func testProjectCreateDrawsTitleGoalAndCriteriaTranslated() throws {
        let a = try approval("orbit_project_create", input: projectInput, translation: """
        {"lang":"zh-Hans","title":"T-cards","goal":"T-goal","instructions":"T-slow",
         "acceptanceCriteriaItems":[{"text":"T-all","verificationMethod":"T-click"},{"text":"T-crash"}]}
        """)
        let shownInput = try input(a, showOriginal: false)
        let shown = try XCTUnwrap(Approvals.createPreview(toolName: "orbit_project_create", from: shownInput))
        XCTAssertEqual(shown.title, "T-cards")
        XCTAssertEqual(shown.descriptionText, "T-goal")
        XCTAssertEqual(shown.criteria, ["T-all", "T-crash"])
        XCTAssertEqual(shownInput["instructions"]?.stringValue, "T-slow")
        guard case .array(let items)? = shownInput["acceptanceCriteriaItems"] else { return XCTFail("no items") }
        XCTAssertEqual(items.first?["verificationMethod"]?.stringValue, "T-click")
        assertFoot(a)

        let original = try XCTUnwrap(Approvals.createPreview(toolName: "orbit_project_create",
                                                             from: input(a, showOriginal: true)))
        XCTAssertEqual(original.title, "Cards")
        XCTAssertEqual(original.descriptionText, "Every card works.")
        XCTAssertEqual(original.criteria, ["All cards work", "No crash"])
    }

    func testProjectCreateWithOnlyFieldsTheCardDoesNotDrawHasNoFoot() throws {
        let a = try approval("orbit_project_create", input: projectInput,
                             translation: #"{"lang":"zh-Hans","instructions":"T-slow"}"#)
        XCTAssertEqual(Approvals.orbitCardFoot(a, showOriginal: false), [])
    }

    func testProjectCreateUntranslatedDrawsTheOriginalWithNoFoot() throws {
        try assertUntranslated("orbit_project_create", input: projectInput) { input in
            let p = try XCTUnwrap(Approvals.createPreview(toolName: "orbit_project_create", from: input))
            XCTAssertEqual(p.title, "Cards")
            XCTAssertEqual(p.descriptionText, "Every card works.")
            XCTAssertEqual(p.criteria, ["All cards work", "No crash"])
        }
    }

    // MARK: orbit_blocker_resolve

    private let blockerInput = """
    {"projectTitle":"Cards","reason":"The evidence is now linked.",
     "blocker":{"requiredAction":"Supply review evidence.","kind":"owner"}}
    """

    func testBlockerResolveDrawsTheReasonTranslated() throws {
        let a = try approval("orbit_blocker_resolve", input: blockerInput,
                             translation: #"{"lang":"zh-Hans","reason":"T-reason"}"#)
        let shown = try XCTUnwrap(Approvals.blockerResolvePreview(toolName: "orbit_blocker_resolve",
                                                                  from: input(a, showOriginal: false)))
        XCTAssertEqual(shown.reason, "T-reason")
        XCTAssertEqual(shown.requiredAction, "Supply review evidence.")
        assertFoot(a)

        let original = try XCTUnwrap(Approvals.blockerResolvePreview(toolName: "orbit_blocker_resolve",
                                                                     from: input(a, showOriginal: true)))
        XCTAssertEqual(original.reason, "The evidence is now linked.")
    }

    func testBlockerResolveUntranslatedDrawsTheOriginalWithNoFoot() throws {
        try assertUntranslated("orbit_blocker_resolve", input: blockerInput) { input in
            let p = try XCTUnwrap(Approvals.blockerResolvePreview(toolName: "orbit_blocker_resolve", from: input))
            XCTAssertEqual(p.reason, "The evidence is now linked.")
        }
    }

    // MARK: orbit_dag_change

    private let dagInput = """
    {"note":"Answer after reading.",
     "preview":{"listTitle":"Cards","ops":[{"op":"add","taskTitle":"Answer","dependsOnTitle":"Read"}],
                "edgesBefore":0,"edgesAfter":1}}
    """

    func testDagChangeDrawsTheNoteTranslated() throws {
        let a = try approval("orbit_dag_change", input: dagInput,
                             translation: #"{"lang":"zh-Hans","note":"T-note"}"#)
        let shown = try XCTUnwrap(Approvals.dagPreview(from: input(a, showOriginal: false)))
        XCTAssertEqual(shown.note, "T-note")
        XCTAssertEqual(shown.ops.first?.sentence, "Answer waits on Read")
        assertFoot(a)

        let original = try XCTUnwrap(Approvals.dagPreview(from: input(a, showOriginal: true)))
        XCTAssertEqual(original.note, "Answer after reading.")
    }

    func testDagChangeUntranslatedDrawsTheOriginalWithNoFoot() throws {
        try assertUntranslated("orbit_dag_change", input: dagInput) { input in
            XCTAssertEqual(try XCTUnwrap(Approvals.dagPreview(from: input)).note, "Answer after reading.")
        }
    }

    // MARK: the model

    /// The new fields are additive: a translation without them decodes as before, and one with them
    /// round-trips through Codable.
    func testApprovalTranslationDecodesWithAndWithoutTheOrbitCardFields() throws {
        let bare = try JSONDecoder().decode(ApprovalTranslation.self,
                                            from: Data(#"{"lang":"de","failed":false,"description":"Mach"}"#.utf8))
        XCTAssertEqual(bare, ApprovalTranslation(lang: .de, description: "Mach"))
        let full = ApprovalTranslation(lang: .de, title: "T", acceptanceCriteria: "A",
                                       tasks: [TranslatedTaskBody(title: "t")], goal: "G", instructions: "I",
                                       acceptanceCriteriaItems: [TranslatedCriterionItem(text: "x")],
                                       reason: "R", note: "N")
        XCTAssertEqual(try JSONDecoder().decode(ApprovalTranslation.self, from: JSONEncoder().encode(full)), full)
    }

    /// A tool card that is not one of Orbit's own never gets the foot, translated or not.
    func testOtherCardsHaveNoOrbitFoot() throws {
        let a = try approval("Bash", input: #"{"command":"ls","description":"List"}"#,
                             translation: #"{"lang":"zh-Hans","description":"T-list"}"#)
        XCTAssertEqual(Approvals.orbitCardFoot(a, showOriginal: false), [])
    }
}
