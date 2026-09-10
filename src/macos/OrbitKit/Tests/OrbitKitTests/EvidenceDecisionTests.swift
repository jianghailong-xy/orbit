import Foundation
import XCTest
@testable import OrbitKit

/// The completion-decision card is built from the pending ROW — the same row the web card is drawn
/// from — and a conversation gets one only for the rows it is actually being asked about.
///
/// These are the assertions the card is worth having: that the structure on screen comes from
/// fields (so a phone and a browser cannot report different numbers for one submission), that the
/// send-back cannot be sent without the reason the decision door requires, and that the rows a card
/// is delivered for are this project's and ones the door would take an answer to from here. What one
/// press sends, and where a delivered card stands, is `EvidenceDecisionDoorTests`.
final class EvidenceDecisionTests: XCTestCase {

    // MARK: fixtures

    private static let project = "34JdnRJOxuG05yi0TpLq4"

    private func citation(_ ref: String, resolved: Bool, reason: String? = nil)
        -> EvidenceDecisionCitation {
        EvidenceDecisionCitation(kind: "TOOL_CALL", ref: ref, resolved: resolved, reason: reason,
                                 label: resolved ? "Bash · swift test" : nil)
    }

    private func row(taskId: String = "34LMiluvx0jK63cj8arWl",
                     revision: String = "1",
                     projectId: String? = EvidenceDecisionTests.project,
                     claim: String = "改掉了 update() 的头注释。",
                     gaps: [String],
                     citations: [EvidenceDecisionCitation] = [],
                     decidable: Bool = true,
                     independent: Bool = true,
                     criterion: EvidenceDecisionCriterion? =
                         EvidenceDecisionCriterion(key: "6KG2mjp63PrtVvGwxRLvFY",
                                                   text: "提交一条完成证据后…")) -> EvidenceDecisionRow {
        EvidenceDecisionRow(
            taskId: taskId, title: "改掉 update() 的头注释", projectId: projectId,
            criterion: criterion,
            evidenceRevision: revision, ageSeconds: 1200, claim: claim, gaps: gaps,
            citations: citations,
            decidability: EvidenceDecisionDecidability(
                decidable: decidable,
                refusal: decidable ? nil : "EVIDENCE_JUDGMENT_CRITERION_NOT_LIVE"),
            independence: EvidenceDecisionIndependence(
                independent: independent,
                disqualification: independent ? nil : "这条会话提交过这次证据"))
    }

    private func queue(_ rows: [EvidenceDecisionRow],
                       waitingOnYou: [EvidenceDecisionRow] = []) -> EvidenceDecisionQueue {
        EvidenceDecisionQueue(decidingSessionId: "34JbyLO3TvHgOmBBHLgZu", count: rows.count,
                              oldestAgeSeconds: rows.isEmpty ? nil : 1200,
                              pending: rows, waitingOnYou: waitingOnYou)
    }

    // MARK: 1 — the structure comes from the fields

    /// Five declared gaps render as three lines and a count of the other two — off `row.gaps`, in
    /// the submitter's own words.
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

    // MARK: 2 — the send-back needs its reason

    /// The send-back's control is dead until there is a reason, and alive the moment there is.
    /// NEGATIVE CONTROL: make `canSend` unconditional and both halves of this go red.
    func testSendBackIsUnsendableWithoutAReason() {
        var state = EvidenceSendBackState()
        XCTAssertFalse(state.open, "the reason box is closed until 退回重做 is pressed")
        XCTAssertFalse(state.canSend)

        state.open = true
        XCTAssertFalse(state.canSend, "opening the box is not a reason")

        state.note = "   \n  "
        XCTAssertFalse(state.canSend, "whitespace is not a reason either")

        state.note = "  把 pg spec 跑一遍  "
        XCTAssertTrue(state.canSend)
        XCTAssertEqual(state.trimmedNote, "把 pg spec 跑一遍", "and the reason is sent trimmed")
    }

    // MARK: 3 — which rows get a card

    /// A conversation draws the judgments of the project it coordinates that the door would take
    /// from it, and nothing else `pending` holds. Each dropped row differs from the kept one in one
    /// field, so each is dropped for its own reason.
    func testOnlyThisProjectsRowsThatThisSessionMayAnswerGetACard() {
        let rows = [row(taskId: "kept", gaps: []),
                    row(taskId: "another-project", projectId: "34MPiBgZ80YpSKt0lmTQA", gaps: []),
                    row(taskId: "no-project", projectId: nil, gaps: []),
                    row(taskId: "not-independent", gaps: [], independent: false),
                    row(taskId: "not-decidable", gaps: [], decidable: false)]

        XCTAssertEqual(EvidenceDecisions.cardRows(queue: queue(rows), projectId: Self.project)
                           .map(\.taskId),
                       ["kept"])
    }

    /// `waitingOnYou` is a row the door refuses whatever anybody presses, so no card is built from
    /// it; and a conversation that coordinates no project, or has not read the queue, has none.
    func testNoCardComesFromWaitingOnYouFromNoProjectOrFromNoRead() {
        let r = row(gaps: [])
        XCTAssertTrue(EvidenceDecisions.cardRows(queue: queue([], waitingOnYou: [r]),
                                                 projectId: Self.project).isEmpty)
        XCTAssertTrue(EvidenceDecisions.cardRows(queue: queue([r]), projectId: nil).isEmpty)
        XCTAssertTrue(EvidenceDecisions.cardRows(queue: nil, projectId: Self.project).isEmpty)
        XCTAssertEqual(EvidenceDecisions.cardRows(queue: queue([r]), projectId: Self.project), [r],
                       "the same row, pending and in its own project's conversation, is a card")
    }

    /// A delivered card is addressed by the revision as well as the task — a newer revision is a
    /// second card — and spelled the way the web card keys the same row.
    func testTwoRevisionsOfOneTaskAreTwoCards() {
        let first = DeliveredDecisionCard(
            kind: .evidenceDecision(taskID: "34LMiluvx0jK63cj8arWl", evidenceRevision: "1"))
        let second = DeliveredDecisionCard(
            kind: .evidenceDecision(taskID: "34LMiluvx0jK63cj8arWl", evidenceRevision: "2"))
        XCTAssertEqual(first.id, "evidence-decision-34LMiluvx0jK63cj8arWl@1")
        XCTAssertNotEqual(first.id, second.id)
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

    /// The row decodes from what `GET /tasks/evidence-decisions/pending` actually sends — including
    /// the project it is filed under, which is what decides the conversation it gets a card in.
    func testQueueDecodesFromTheServersShape() throws {
        let wire = """
        {"readAt":"2026-09-09T01:00:00.000Z","decidingSessionId":"34JbyLO3TvHgOmBBHLgZu",
         "count":2,"oldestAgeSeconds":1200,
         "pending":[{"taskId":"34LMiluvx0jK63cj8arWl","title":"改注释","status":"OPEN",
           "projectId":"34JdnRJOxuG05yi0TpLq4",
           "criterion":{"key":"6KG2mjp63PrtVvGwxRLvFY","text":"提交一条完成证据后…"},
           "evidenceRevision":"1","submittedAt":"2026-09-09T00:40:00.000Z","ageSeconds":1200,
           "claim":"改掉了头注释","gaps":["没跑 pg spec","没落 main"],
           "citations":[{"kind":"TOOL_CALL","ref":"toolu_1","resolved":true,"reason":null,
                         "label":"Bash · swift test"}],
           "decidability":{"decidable":true,"refusal":null,"requiredAction":null},
           "independence":{"independent":true,"disqualification":null,"requiredAction":null}},
          {"taskId":"34LVxFqhGAi1xul4wjUHP","title":"不在任何项目下","status":"OPEN",
           "projectId":null,"criterion":null,
           "evidenceRevision":"2","submittedAt":"2026-09-09T00:50:00.000Z","ageSeconds":600,
           "claim":"","gaps":[],"citations":[],
           "decidability":{"decidable":true,"refusal":null,"requiredAction":null},
           "independence":{"independent":true,"disqualification":null,"requiredAction":null}}],
         "waitingOnYou":[]}
        """
        let q = try JSONDecoder().decode(EvidenceDecisionQueue.self, from: Data(wire.utf8))
        XCTAssertEqual(q.count, 2)
        XCTAssertEqual(q.pending.first?.gaps, ["没跑 pg spec", "没落 main"])
        XCTAssertEqual(q.pending.first?.criterion?.key, "6KG2mjp63PrtVvGwxRLvFY")
        XCTAssertEqual(q.pending.first?.citations.first?.label, "Bash · swift test")
        XCTAssertEqual(q.pending.first?.projectId, "34JdnRJOxuG05yi0TpLq4")
        XCTAssertNil(q.pending.last?.projectId, "a task filed under no project decodes as one")
        XCTAssertTrue(q.waitingOnYou.isEmpty)
        XCTAssertEqual(EvidenceDecisions.cardRows(queue: q, projectId: Self.project).map(\.taskId),
                       ["34LMiluvx0jK63cj8arWl"])
    }
}
