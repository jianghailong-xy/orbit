import Foundation
import XCTest
@testable import OrbitKit

/// The completion-decision card is built from the pending ROW, not from the question string the
/// ask flattened that row into — and it is the ONE question either client special-cases.
///
/// These are the assertions the redesign is worth having: that the structure on screen comes from
/// fields (so a phone and a browser cannot report different numbers for one submission), that the
/// send-back cannot be sent without the reason the decision door requires, and that an ordinary
/// two-option question is untouched by any of it.
final class EvidenceDecisionTests: XCTestCase {

    // MARK: fixtures

    private func citation(_ ref: String, resolved: Bool, reason: String? = nil)
        -> EvidenceDecisionCitation {
        EvidenceDecisionCitation(kind: "TOOL_CALL", ref: ref, resolved: resolved, reason: reason,
                                 label: resolved ? "Bash · swift test" : nil)
    }

    private func row(taskId: String = "34LMiluvx0jK63cj8arWl",
                     revision: String = "1",
                     claim: String = "改掉了 update() 的头注释。",
                     gaps: [String],
                     citations: [EvidenceDecisionCitation] = [],
                     decidable: Bool = true,
                     independent: Bool = true,
                     criterion: EvidenceDecisionCriterion? =
                         EvidenceDecisionCriterion(key: "6KG2mjp63PrtVvGwxRLvFY",
                                                   text: "提交一条完成证据后…")) -> EvidenceDecisionRow {
        EvidenceDecisionRow(
            taskId: taskId, title: "改掉 update() 的头注释", criterion: criterion,
            evidenceRevision: revision, ageSeconds: 1200, claim: claim, gaps: gaps,
            citations: citations,
            decidability: EvidenceDecisionDecidability(
                decidable: decidable,
                refusal: decidable ? nil : "EVIDENCE_JUDGMENT_CRITERION_NOT_LIVE"),
            independence: EvidenceDecisionIndependence(
                independent: independent,
                disqualification: independent ? nil : "这条会话提交过这次证据"))
    }

    private func queue(_ rows: [EvidenceDecisionRow]) -> EvidenceDecisionQueue {
        EvidenceDecisionQueue(decidingSessionId: "34JbyLO3TvHgOmBBHLgZu", count: rows.count,
                              oldestAgeSeconds: rows.isEmpty ? nil : 1200,
                              pending: rows, waitingOnYou: [])
    }

    /// The body the server writes: claim, criterion, gaps, and the identity line at the END.
    /// Copied from `evidenceQuestionBody` rather than derived, so a change to that shape shows up
    /// here as a card that stopped being recognised — which is what would happen in the app.
    private func askBody(_ row: EvidenceDecisionRow) -> String {
        let gaps = row.gaps.isEmpty
            ? "Declared gaps: the submitter declared none."
            : "Declared gaps:\n" + row.gaps.map { "- \($0)" }.joined(separator: "\n")
        return """
            \(row.claim)

            Against criterion \(row.criterion?.key ?? "none"): \(row.criterion?.text ?? "")

            \(gaps)

            \(row.title) — task \(row.taskId), evidence rev \(row.evidenceRevision)
            """
    }

    private func approval(_ rows: [EvidenceDecisionRow]) -> PendingApproval {
        let questions = rows.map { row in
            """
            {"question": \(quoted(askBody(row))), "header": "Completion", "multiSelect": false,
             "options": [{"label": "Confirm completion", "description": "settles it"},
                         {"label": "Send back", "description": "does not"}]}
            """
        }
        return PendingApproval(id: "appr-1", kind: .question, toolName: "AskUserQuestion",
                               input: json("{\"questions\":[\(questions.joined(separator: ","))]}"))
    }

    private func quoted(_ s: String) -> String {
        String(data: try! JSONEncoder().encode(s), encoding: .utf8)!
    }

    private func json(_ s: String) -> JSONValue {
        try! JSONDecoder().decode(JSONValue.self, from: Data(s.utf8))
    }

    // MARK: 1 — the structure comes from the fields

    /// Five declared gaps render as three lines and a count of the other two — off `row.gaps`,
    /// never off the question body. NEGATIVE CONTROL: rebuild `gapPreview` by splitting the
    /// flattened string and this goes red, because the string carries them as `- ` bullets inside
    /// one paragraph and nothing here would count 5.
    func testFiveGapsShowThreeAndCountTheRest() {
        let r = row(gaps: ["没跑 pg spec 与 full-api",
                           "改动停在任务分支，尚未落 main",
                           "「措辞够不够好」只能你读",
                           "普查 spec 的绿不证明注释正确",
                           "顺手发现开头段边数没改"])
        let preview = EvidenceDecisions.gapPreview(r)

        XCTAssertEqual(preview.shown, ["没跑 pg spec 与 full-api",
                                       "改动停在任务分支，尚未落 main",
                                       "「措辞够不够好」只能你读"],
                       "the first three gaps are their own rows, in the submitter's own words")
        XCTAssertEqual(preview.rest.count, 2)
        XCTAssertEqual(EvidenceDecisions.gapsMore(preview.rest.count), "还有 2 条")
        XCTAssertEqual(EvidenceDecisions.gapsHeading(r.gaps.count), "提交者声明的缺口 · 5 条",
                       "the count is never hidden, whatever fits")
    }

    /// Claim, criterion and citations are read the same way: as fields.
    func testClaimCriterionAndCitationsAreReadAsFields() {
        let r = row(claim: "  一句主张。  ", gaps: [],
                    citations: [citation("toolu_a", resolved: true),
                                citation("toolu_b", resolved: true),
                                citation("toolu_c", resolved: false, reason: "不在本任务下")])

        XCTAssertEqual(EvidenceDecisions.foldedClaim(r.claim, clamp: 90).text, "一句主张。")
        XCTAssertEqual(EvidenceDecisions.meta(r),
                       "34LMiluvx0jK63cj8arWl · rev 1 · 6KG2mjp63PrtVvGwxRLvFY")

        let checks = EvidenceDecisions.checks(r)
        XCTAssertEqual(checks.map(\.text), ["引用的验收条目仍是线上那一条",
                                            "2/3 条引用解析成功",
                                            "裁决人独立于这次提交"])
        XCTAssertEqual(checks.map(\.ok), [true, false, true])
        XCTAssertEqual(checks[1].detail, "toolu_c：不在本任务下",
                       "the citation that did not resolve is named, never folded to a number")
        XCTAssertEqual(EvidenceDecisions.heldCount(r), 2)
        XCTAssertEqual(EvidenceDecisions.checksHeading(held: 2, total: 3), "2 项机器已核 · 1 项没过")
    }

    /// Evidence from before the envelope has no claim and quotes no criterion: the card says so
    /// rather than rendering a blank where its lead should be.
    func testEmptyClaimAndNoCriterionSaySo() {
        let r = row(claim: "   ", gaps: [], criterion: nil)
        XCTAssertEqual(EvidenceDecisions.foldedClaim(r.claim, clamp: 90).text, "")
        XCTAssertEqual(EvidenceDecisions.meta(r), "34LMiluvx0jK63cj8arWl · rev 1 · 未引用验收条目")
        XCTAssertEqual(EvidenceDecisions.gapsHeading(0), "提交者声明没有缺口")
        XCTAssertFalse(EvidenceDecisions.noClaim.isEmpty)
    }

    // MARK: 2 — the actions are a judgment's, not a form's

    /// `确认完成` submits on the press: one action, no pick-then-Submit step in between.
    func testConfirmSendsOnTheFirstPress() {
        let question = "任意一段问题正文"
        XCTAssertEqual(EvidenceDecisions.answers(question: question, action: .confirm),
                       [question: ["Confirm completion"]],
                       "the label that goes back is the server's own, so the door reads it")
    }

    /// The send-back's control is dead until there is a reason, and alive the moment there is.
    /// NEGATIVE CONTROL: make `canSend` unconditional and both halves of this go red.
    func testSendBackIsUnsendableWithoutAReason() {
        var state = EvidenceSendBackState()
        XCTAssertFalse(state.open, "the reason box is closed until 退回重做 is pressed")
        XCTAssertFalse(state.canSend)
        XCTAssertNil(state.action)

        state.open = true
        XCTAssertFalse(state.canSend, "opening the box is not a reason")

        state.note = "   \n  "
        XCTAssertFalse(state.canSend, "whitespace is not a reason either")
        XCTAssertNil(state.action)

        state.note = "  把 pg spec 跑一遍  "
        XCTAssertTrue(state.canSend)
        XCTAssertEqual(state.action, .sendBack(note: "把 pg spec 跑一遍"))
        XCTAssertEqual(
            EvidenceDecisions.answers(question: "正文", action: state.action!),
            ["正文": ["Send back", "把 pg spec 跑一遍"]],
            "the reason rides as the second entry, the shape a typed answer has always taken")
    }

    // MARK: 3 — only the judgment is special-cased

    /// An ordinary two-option question is not a decision card, whatever else is pending.
    func testOrdinaryQuestionStaysTheGenericForm() {
        let pending = queue([row(gaps: [])])
        let ordinary = PendingApproval(
            id: "appr-2", kind: .question, toolName: "AskUserQuestion",
            input: json("""
                {"questions":[{"question":"Which database?","header":"DB","multiSelect":false,
                 "options":[{"label":"Postgres"},{"label":"SQLite"}]}]}
                """))

        XCTAssertNil(EvidenceDecisions.rows(for: ordinary, queue: pending),
                     "two options and a pending queue are not enough — the generic form renders it")
        // And it is still parsed by the untouched generic path.
        let questions = Approvals.parseQuestions(from: ordinary.input!)
        XCTAssertEqual(questions.map(\.options).flatMap { $0 }.map(\.label), ["Postgres", "SQLite"])
        XCTAssertTrue(Approvals.allAnswered(questions,
                                            selections: ["Which database?": ["Postgres"]],
                                            custom: [:]))
    }

    /// A question wearing the two decision labels but naming no pending row is not one either —
    /// which is also what happens if the server ever re-words its identity line.
    func testDecisionLabelsWithoutAMatchingRowAreNotACard() {
        let r = row(gaps: [])
        let impostor = PendingApproval(
            id: "appr-3", kind: .question, toolName: "AskUserQuestion",
            input: json("""
                {"questions":[{"question":"Is it done? task nobody, evidence rev 9","header":"C",
                 "multiSelect":false,
                 "options":[{"label":"Confirm completion"},{"label":"Send back"}]}]}
                """))
        XCTAssertNil(EvidenceDecisions.rows(for: impostor, queue: queue([r])))
    }

    /// A tool approval and a plan are never this card, whatever the queue holds.
    func testOnlyAskUserQuestionIsEverConsidered() {
        let pending = queue([row(gaps: [])])
        let tool = PendingApproval(id: "t", kind: .tool, toolName: "Bash",
                                   input: json("{\"command\":\"ls\"}"))
        XCTAssertNil(EvidenceDecisions.rows(for: tool, queue: pending))
    }

    /// The card matches when the question IS one of the pending rows.
    func testTheAskRaisedOverAPendingRowIsRecognised() {
        let r = row(gaps: ["a", "b"])
        let matched = EvidenceDecisions.rows(for: approval([r]), queue: queue([r]))
        XCTAssertEqual(matched?.map(\.taskId), [r.taskId])
        XCTAssertEqual(matched?.first?.gaps, ["a", "b"])
    }

    /// All or nothing: one unmatched question in a multi-row ask sends the WHOLE approval back to
    /// the generic form, rather than rendering half a card with one Submit across both halves.
    func testAMixedAskIsNotHalfACard() {
        let known = row(gaps: [])
        let unknown = row(taskId: "34LVxFqhGAi1xul4wjUHP", revision: "2", gaps: [])
        XCTAssertNil(EvidenceDecisions.rows(for: approval([known, unknown]),
                                            queue: queue([known])),
                     "a card cannot be a judgment about one row and a form about another")
        XCTAssertEqual(EvidenceDecisions.rows(for: approval([known, unknown]),
                                              queue: queue([known, unknown]))?.count, 2)
    }

    /// `waitingOnYou` is a row the door refuses whatever anybody presses, so no card is built from
    /// it — the same rule the server's own ask follows.
    func testOnlyPendingRowsBuildCards() {
        let r = row(gaps: [])
        let onlyWaiting = EvidenceDecisionQueue(decidingSessionId: "s", count: 0,
                                                oldestAgeSeconds: nil, pending: [],
                                                waitingOnYou: [r])
        XCTAssertNil(EvidenceDecisions.rows(for: approval([r]), queue: onlyWaiting))
        XCTAssertNil(EvidenceDecisions.rows(for: approval([r]), queue: nil),
                     "before the queue has loaded, the generic form is what renders")
    }

    // MARK: 4 — the fold threshold is the one thing the two clients do not share

    /// Structure is shared, width is not: the claim clamp is two constants, and the code that folds
    /// takes it as an argument rather than reaching for a single global.
    func testClaimClampDiffersBetweenAPhoneAndAWindow() {
        XCTAssertNotEqual(EvidenceDecisions.claimClampCompact, EvidenceDecisions.claimClampRegular,
                          "390pt and a macOS window must not fold at the same number")
        XCTAssertLessThan(EvidenceDecisions.claimClampCompact, EvidenceDecisions.claimClampRegular)

        let claim = String(repeating: "长", count: 150)
        let phone = EvidenceDecisions.foldedClaim(claim, clamp: EvidenceDecisions.claimClampCompact)
        let desk = EvidenceDecisions.foldedClaim(claim, clamp: EvidenceDecisions.claimClampRegular)
        XCTAssertTrue(phone.folded)
        XCTAssertEqual(phone.text.count, EvidenceDecisions.claimClampCompact + 1, "clamp + the ellipsis")
        XCTAssertFalse(desk.folded, "the same claim has room in a window and is not folded there")
        XCTAssertEqual(desk.text, claim)
    }

    /// The gaps count, by contrast, is deliberately NOT forked: it is what keeps the two clients
    /// reporting the same "3 shown, N more" for one submission.
    func testGapsShownIsSharedByBothClients() {
        XCTAssertEqual(EvidenceDecisions.gapsShown, 3)
        let r = row(gaps: ["1", "2", "3", "4", "5"])
        XCTAssertEqual(EvidenceDecisions.gapPreview(r).shown.count, EvidenceDecisions.gapsShown)
    }

    // MARK: the wire

    /// The row decodes from what `GET /tasks/evidence-decisions/pending` actually sends.
    func testQueueDecodesFromTheServersShape() throws {
        let wire = """
        {"readAt":"2026-09-09T01:00:00.000Z","decidingSessionId":"34JbyLO3TvHgOmBBHLgZu",
         "count":1,"oldestAgeSeconds":1200,
         "pending":[{"taskId":"34LMiluvx0jK63cj8arWl","title":"改注释","status":"OPEN",
           "projectId":"34JdnRJOxuG05yi0TpLq4",
           "criterion":{"key":"6KG2mjp63PrtVvGwxRLvFY","text":"提交一条完成证据后…"},
           "evidenceRevision":"1","submittedAt":"2026-09-09T00:40:00.000Z","ageSeconds":1200,
           "claim":"改掉了头注释","gaps":["没跑 pg spec","没落 main"],
           "citations":[{"kind":"TOOL_CALL","ref":"toolu_1","resolved":true,"reason":null,
                         "label":"Bash · swift test"}],
           "decidability":{"decidable":true,"refusal":null,"requiredAction":null},
           "independence":{"independent":true,"disqualification":null,"requiredAction":null}}],
         "waitingOnYou":[]}
        """
        let q = try JSONDecoder().decode(EvidenceDecisionQueue.self, from: Data(wire.utf8))
        XCTAssertEqual(q.count, 1)
        XCTAssertEqual(q.pending.first?.gaps, ["没跑 pg spec", "没落 main"])
        XCTAssertEqual(q.pending.first?.criterion?.key, "6KG2mjp63PrtVvGwxRLvFY")
        XCTAssertEqual(q.pending.first?.citations.first?.label, "Bash · swift test")
        XCTAssertTrue(q.waitingOnYou.isEmpty)
        // And the identity line built from it is the one the server writes into the ask.
        XCTAssertEqual(EvidenceDecisions.askIdentity(q.pending[0]),
                       "task 34LMiluvx0jK63cj8arWl, evidence rev 1")
    }
}
