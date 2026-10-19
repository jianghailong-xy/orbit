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
                                                   text: "提交一条完成证据后…"),
                     ownerCard: EvidenceDecisionOwnerCard? = nil) -> EvidenceDecisionRow {
        EvidenceDecisionRow(
            taskId: taskId, title: "改掉 update() 的头注释", projectId: projectId,
            ownerCard: ownerCard,
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
        XCTAssertEqual(EvidenceDecisions.gapsMore(preview.rest.count), "2 more")
        XCTAssertEqual(EvidenceDecisions.gapsHeading(r.gaps.count),
                       "WHAT THIS EVIDENCE DOES NOT ESTABLISH · 5",
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
        XCTAssertEqual(checks.map(\.text), ["the criterion it cites is still the live one",
                                            "2/3 citations resolved",
                                            "the decider is independent of this submission"])
        XCTAssertEqual(checks.map(\.ok), [true, false, true])
        XCTAssertEqual(checks[1].detail, "toolu_c: 不在本任务下",
                       "the citation that did not resolve is named, never folded to a number")
        XCTAssertEqual(EvidenceDecisions.heldCount(r), 2)
        XCTAssertEqual(EvidenceDecisions.checksHeading(held: 2, total: 3),
                       "2 checked for you · 1 did not hold")
    }

    /// Evidence from before the envelope has no claim and quotes no criterion: the card says so
    /// rather than rendering a blank where its lead should be.
    func testEmptyClaimAndNoCriterionSaySo() {
        let r = row(claim: "   ", gaps: [], criterion: nil)
        XCTAssertEqual(EvidenceDecisions.foldedClaim(r.claim, clamp: 90).text, "")
        XCTAssertEqual(EvidenceDecisions.meta(r),
                       "34LMiluvx0jK63cj8arWl · rev 1 · no acceptance criterion cited")
        XCTAssertEqual(EvidenceDecisions.gapsHeading(0), "the submitter declares nothing missing")
        XCTAssertFalse(EvidenceDecisions.noClaim.isEmpty)
    }

    // MARK: 2 — the second answer's two words, and the sentence it promises

    /// The button says one thing and the record says another, deliberately. The button is
    /// `Approvals.chatAction` — the word the four other cards that hand their reply to the composer
    /// use — and the receipt a send-back leaves keeps the answer's own name. What the card no
    /// longer holds is the reason itself: the composer holds the draft, and the rule that a
    /// send-back needs one lives where the request is built (`EvidenceDecisionDoorTests`).
    func testTheSecondAnswerHasOneWordForTheButtonAndOneForTheRecord() {
        XCTAssertEqual(EvidenceDecisions.sendBackAction, "Send back")
        XCTAssertNotEqual(EvidenceDecisions.sendBackAction, Approvals.chatAction,
                          "the record keeps the answer's own name; the button is the shared control")
        // What the card prints under the buttons, and what the armed composer asks for. Both are
        // compared word for word against the web card by `EvidenceDecisionCopyParityTests`.
        XCTAssertTrue(EvidenceDecisions.sendBackHint.contains("The task stays open."),
                      "the promise that pressing it closes nothing has to be on the card")
        XCTAssertFalse(EvidenceDecisions.sendBackLabel.isEmpty)
        XCTAssertFalse(EvidenceDecisions.sendingBackPrefix.isEmpty)
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

    /// A task a session dispatched outside any project (the B line, apiserver
    /// `tasks/evidence-review.ts`): the read names the one conversation its owner card is drawn in,
    /// whether or not that conversation coordinates a project, and no other conversation draws it.
    func testADispatchedTasksRowGetsACardOnlyWhereItsOwnerCardIs() {
        let here = "34JbyLO3TvHgOmBBHLgZu"
        let dispatched = row(taskId: "dispatched", projectId: nil, gaps: [],
                             ownerCard: EvidenceDecisionOwnerCard(sessionId: here, decidingSessionId: here))
        XCTAssertEqual(EvidenceDecisions.cardRows(queue: queue([dispatched]), projectId: nil, sessionId: here)
                           .map(\.taskId), ["dispatched"])
        XCTAssertEqual(EvidenceDecisions.cardRows(queue: queue([dispatched]), projectId: Self.project,
                                                  sessionId: here).map(\.taskId), ["dispatched"],
                       "a coordinator that dispatched it draws it too")
        XCTAssertTrue(EvidenceDecisions.cardRows(queue: queue([dispatched]), projectId: nil,
                                                 sessionId: "another").isEmpty)
        XCTAssertTrue(EvidenceDecisions.cardRows(queue: queue([dispatched]), projectId: nil).isEmpty,
                      "a caller that names no session draws none of them")
        let notMine = row(taskId: "not-mine", projectId: nil, gaps: [], independent: false,
                          ownerCard: EvidenceDecisionOwnerCard(sessionId: here, decidingSessionId: here))
        XCTAssertTrue(EvidenceDecisions.cardRows(queue: queue([notMine]), projectId: nil, sessionId: here).isEmpty)
        // And a legacy row in no project, with no owner card, is still no conversation's.
        XCTAssertTrue(EvidenceDecisions.cardRows(queue: queue([row(taskId: "legacy", projectId: nil, gaps: [])]),
                                                 projectId: nil, sessionId: here).isEmpty)
        XCTAssertEqual(EvidenceDecisions.standing(queue: queue([dispatched]), projectId: nil, sessionId: here,
                                                  taskId: "dispatched", evidenceRevision: "1").answerable, true)
    }

    /// A card that has moved to the task's run decides in the dispatching session's name: the run
    /// did the work, and the door refuses it.
    func testAPressDecidesAsTheSessionTheOwnerCardNames() {
        let run = "34RunSessionOfTheTaskXy"
        let dispatcher = "34DispatchingSessionAbc"
        let moved = row(taskId: "moved", projectId: nil, gaps: [],
                        ownerCard: EvidenceDecisionOwnerCard(sessionId: run, decidingSessionId: dispatcher))
        XCTAssertEqual(EvidenceDecisions.decidingSession(row: moved, sessionID: run), dispatcher)
        XCTAssertEqual(EvidenceDecisions.request(row: moved, decision: .confirm, decidingSessionID: run)?
                           .decidingSessionId, dispatcher)
        XCTAssertEqual(EvidenceDecisions.request(row: moved, decision: .sendBack, note: "show the counts",
                                                 decidingSessionID: run)?.decidingSessionId, dispatcher)
        let plain = row(gaps: [])
        XCTAssertEqual(EvidenceDecisions.request(row: plain, decision: .confirm, decidingSessionID: run)?
                           .decidingSessionId, run, "a project's row decides as the conversation it is in")
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

    // MARK: the receipt an answered revision leaves

    private func recorded(_ taskID: String = "34LMiluvx0jK63cj8arWl", revision: String = "1",
                          _ decision: EvidenceDecisionAnswer = .confirm,
                          note: String? = nil, at decidedAt: String,
                          by: String = "USER") -> RecordedEvidenceDecision {
        RecordedEvidenceDecision(taskId: taskID, title: "改掉 update() 的头注释",
                                 projectId: EvidenceDecisionTests.project,
                                 evidenceRevision: revision, decision: decision, note: note,
                                 decidedAt: decidedAt, decidedByType: by)
    }

    private func item(_ id: String, at ts: String?) -> TranscriptItem {
        .assistant(AssistantBubble(id: id, text: "…", streamingText: "", seq: 1, turnId: "t", ts: ts))
    }

    /// The record carries the door's own clock and nothing else: the row it is drawn in is resolved
    /// at RENDER time against the rows the console holds (`ReceiptAnchor.place`,
    /// `TranscriptRowsTests`), so a window that has since moved does not leave it pinned to a row
    /// that no longer exists.
    func testAReceiptCarriesTheMomentTheRecordIsPlacedBy() {
        let read = EvidenceDecisionQueue(
            decidingSessionId: "s", count: 0, pending: [], waitingOnYou: [],
            decided: [recorded(at: "2026-09-16T09:45:00.000Z")])
        let receipts = EvidenceDecisions.receipts(queue: read)
        XCTAssertEqual(receipts.map(\.moment), ["2026-09-16T09:45:00.000Z"])
        XCTAssertEqual(receipts.map(\.id), ["evidence-decision-receipt-34LMiluvx0jK63cj8arWl@1"])
    }

    /// An answer older than everything this console holds is STILL a record this console draws: it
    /// is the read's answer, and the console hands its moment to the transcript, which puts it at
    /// the head of the window (`TranscriptRowsTests`). A read that has not come back draws nothing.
    func testAnAnswerOlderThanTheWindowIsStillDrawn() {
        let read = EvidenceDecisionQueue(
            decidingSessionId: "s", count: 0, pending: [], waitingOnYou: [],
            decided: [recorded(at: "2026-09-16T08:00:00.000Z")])
        XCTAssertEqual(EvidenceDecisions.receipts(queue: read).map(\.moment),
                       ["2026-09-16T08:00:00.000Z"])
        XCTAssertTrue(EvidenceDecisions.receipts(queue: nil).isEmpty)
    }

    /// What the question card is let go of by: the read naming that revision's answer.
    func testAQuestionGivesWayOnlyWhenTheReadNamesItsRevision() {
        let read = EvidenceDecisionQueue(
            decidingSessionId: "s", count: 0, pending: [], waitingOnYou: [],
            decided: [recorded("34LMiluvx0jK63cj8arWl", revision: "2",
                               at: "2026-09-16T09:45:00.000Z")])
        XCTAssertTrue(EvidenceDecisions.answered(read, taskID: "34LMiluvx0jK63cj8arWl",
                                                 evidenceRevision: "2"))
        // The same task at the revision a NEWER submission filed: still a question.
        XCTAssertFalse(EvidenceDecisions.answered(read, taskID: "34LMiluvx0jK63cj8arWl",
                                                  evidenceRevision: "3"))
        XCTAssertFalse(EvidenceDecisions.answered(nil, taskID: "34LMiluvx0jK63cj8arWl",
                                                  evidenceRevision: "2"))
    }

    /// The line itself: which answer, to which revision, and when. Web's `decisionReceiptLine`, in
    /// the reader's own locale for the clock — so only the shape is asserted here.
    func testTheReceiptLineSaysWhichAnswerToWhichRevision() {
        let confirmed = EvidenceDecisions.receiptLine(recorded(at: "2026-09-16T09:45:00.000Z"))
        XCTAssertTrue(confirmed.hasPrefix("\(EvidenceDecisions.confirmAction) · rev 1 · "), confirmed)

        let returned = EvidenceDecisions.receiptLine(
            recorded(revision: "2", .sendBack, at: "2026-09-16T09:45:00.000Z"))
        XCTAssertTrue(returned.hasPrefix("\(EvidenceDecisions.sendBackAction) · rev 2 · "), returned)

        // The clock is the date as well once the day has passed: a bare "5:42" a week later reads
        // as this morning. Both are rendered from the same stamp, so the later one is longer.
        let stamp = "2026-09-16T09:45:00.000Z"
        let sameDay = EvidenceDecisions.receiptTime(stamp, now: ThinkingSummary.date(stamp)!)
        let later = EvidenceDecisions.receiptTime(stamp, now: ThinkingSummary.date("2026-09-20T09:45:00.000Z")!)
        XCTAssertTrue(later.hasSuffix(sameDay), "\(later) should end with \(sameDay)")
        XCTAssertGreaterThan(later.count, sameDay.count)
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
           "projectId":null,"ownerCard":{"sessionId":"34JbyLO3TvHgOmBBHLgZu",
                                         "decidingSessionId":"34JbyLO3TvHgOmBBHLgZu"},"criterion":null,
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
        XCTAssertNil(q.pending.first?.ownerCard, "a project's row carries no owner card")
        XCTAssertEqual(q.pending.last?.ownerCard,
                       EvidenceDecisionOwnerCard(sessionId: "34JbyLO3TvHgOmBBHLgZu",
                                                 decidingSessionId: "34JbyLO3TvHgOmBBHLgZu"))
        XCTAssertEqual(EvidenceDecisions.cardRows(queue: q, projectId: nil, sessionId: "34JbyLO3TvHgOmBBHLgZu")
                           .map(\.taskId), ["34LVxFqhGAi1xul4wjUHP"],
                       "and the dispatched one is a card in the conversation it names")
        XCTAssertTrue(q.waitingOnYou.isEmpty)
        XCTAssertEqual(EvidenceDecisions.cardRows(queue: q, projectId: Self.project).map(\.taskId),
                       ["34LMiluvx0jK63cj8arWl"])
        XCTAssertEqual(q.pending.first?.submittedAt, "2026-09-09T00:40:00.000Z")
        XCTAssertTrue(q.waitingOnCoordinator.isEmpty && q.sentToCoordinator.isEmpty,
                      "a server older than the coordinator's queue sends neither group")
    }

    // MARK: 5 — while the coordinator is paused (project 34cygPTQe5LPUT7tdUAzG)

    private static let coordinator = "34cucZFGh0i7pUbWKZlgG"

    private func sent(_ taskId: String = "34LVxFqhGAi1xul4wjUHP", revision: String = "1",
                      projectId: String? = EvidenceDecisionTests.project) -> SentToCoordinatorRow {
        SentToCoordinatorRow(taskId: taskId, title: "把排着的证据投出去", projectId: projectId,
                             evidenceRevision: revision, deliveredAt: "2026-10-09T12:05:00.000Z")
    }

    private func coordinatorQueue(pending: [EvidenceDecisionRow] = [],
                                  waiting: [EvidenceDecisionRow] = [],
                                  sent: [SentToCoordinatorRow] = []) -> EvidenceDecisionQueue {
        EvidenceDecisionQueue(decidingSessionId: Self.coordinator, count: pending.count,
                              pending: pending, waitingOnCoordinator: waiting, sentToCoordinator: sent)
    }

    private func standing(_ queue: EvidenceDecisionQueue?, _ taskId: String,
                          _ revision: String = "1") -> EvidenceDecisionStanding {
        EvidenceDecisions.standing(queue: queue, projectId: Self.project, sessionId: Self.coordinator,
                                   taskId: taskId, evidenceRevision: revision)
    }

    /// The pending read's two groups decode as the server sends them (the project's wire contract):
    /// each waiting version shaped as a pending row, submission time and all, and each version sent
    /// since as its address and the moment of delivery. A group the server did not send — or sent
    /// as something this build cannot read — is empty, not a read that failed.
    func testTheCoordinatorsTwoGroupsDecodeFromTheServersShape() throws {
        let wire = """
        {"decidingSessionId":"34cucZFGh0i7pUbWKZlgG","count":0,"oldestAgeSeconds":null,
         "pending":[],"waitingOnYou":[],"decided":[],
         "waitingOnCoordinator":[{"taskId":"34LMiluvx0jK63cj8arWl","title":"卡片增量","status":"OPEN",
           "projectId":"34JdnRJOxuG05yi0TpLq4","ownerCard":null,
           "criterion":{"key":"6KG2mjp63PrtVvGwxRLvFY","text":"与 iOS 体验对齐"},
           "evidenceRevision":"1","submittedAt":"2026-10-09T11:59:30.000Z","ageSeconds":150,
           "claim":"卡片增量做完了","gaps":["没在实体机上跑"],"citations":[],
           "decidability":{"decidable":true,"refusal":null,"requiredAction":null},
           "independence":{"independent":true,"disqualification":null,"requiredAction":null}}],
         "sentToCoordinator":[{"taskId":"34LVxFqhGAi1xul4wjUHP","title":"导航增量",
           "projectId":"34JdnRJOxuG05yi0TpLq4","evidenceRevision":"2",
           "deliveredAt":"2026-10-09T12:05:00.000Z"}]}
        """
        let q = try JSONDecoder().decode(EvidenceDecisionQueue.self, from: Data(wire.utf8))
        XCTAssertEqual(q.count, 0, "neither group is counted: count is pending's length")
        XCTAssertEqual(q.waitingOnCoordinator.map(\.taskId), ["34LMiluvx0jK63cj8arWl"])
        XCTAssertEqual(q.waitingOnCoordinator.first?.submittedAt, "2026-10-09T11:59:30.000Z")
        XCTAssertEqual(q.waitingOnCoordinator.first?.gaps, ["没在实体机上跑"])
        XCTAssertEqual(q.sentToCoordinator, [SentToCoordinatorRow(
            taskId: "34LVxFqhGAi1xul4wjUHP", title: "导航增量", projectId: "34JdnRJOxuG05yi0TpLq4",
            evidenceRevision: "2", deliveredAt: "2026-10-09T12:05:00.000Z")])

        let unreadable = """
        {"decidingSessionId":"s","count":0,"pending":[],"waitingOnCoordinator":{"what":"this"},
         "sentToCoordinator":null}
        """
        let tolerant = try JSONDecoder().decode(EvidenceDecisionQueue.self, from: Data(unreadable.utf8))
        XCTAssertTrue(tolerant.waitingOnCoordinator.isEmpty)
        XCTAssertTrue(tolerant.sentToCoordinator.isEmpty)
    }

    /// The shared corpus Android and the web read (`interaction-cards.fixture.json`, T1's groups)
    /// decodes into the same two groups, and each version stands where the conversation it names
    /// would draw it: one waiting, one sent, and the pending one still the question it was.
    func testTheSharedFixturesQueueStandsWhereItsConversationDrawsIt() throws {
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        var corpus: [String: Any]?
        for _ in 0..<12 where corpus == nil {
            let file = directory.appendingPathComponent("src/shared/src/interaction-cards.fixture.json")
            if FileManager.default.fileExists(atPath: file.path) {
                corpus = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any]
            }
            directory.deleteLastPathComponent()
        }
        let root = try XCTUnwrap(corpus, "src/shared/src/interaction-cards.fixture.json was not found")
        let sessionID = try XCTUnwrap(root["sessionId"] as? String)
        let projectID = try XCTUnwrap(root["projectId"] as? String)
        let standingRead = try XCTUnwrap((root["snapshot"] as? [String: Any])?["standing"] as? [String: Any])
        let queue = try JSONDecoder().decode(
            EvidenceDecisionQueue.self,
            from: JSONSerialization.data(withJSONObject: try XCTUnwrap(standingRead["evidenceDecisions"])))

        let waiting = try XCTUnwrap(queue.waitingOnCoordinator.first)
        let handed = try XCTUnwrap(queue.sentToCoordinator.first)
        XCTAssertNotNil(waiting.submittedAt, "a waiting version carries when it was submitted")
        func at(_ taskId: String, _ revision: String) -> EvidenceDecisionStanding.State {
            EvidenceDecisions.standing(queue: queue, projectId: projectID, sessionId: sessionID,
                                       taskId: taskId, evidenceRevision: revision).state
        }
        XCTAssertEqual(at(waiting.taskId, waiting.evidenceRevision), .waiting(waiting))
        XCTAssertEqual(at(handed.taskId, handed.evidenceRevision), .sent(handed))
        let asked = try XCTUnwrap(queue.pending.first)
        XCTAssertEqual(at(asked.taskId, asked.evidenceRevision), .decidable(asked))
    }

    /// Where a version stands in the coordinator's conversation: waiting (its owner may still decide
    /// it, nobody is asking them to), sent (nothing to press — the coordinator holds it), or the
    /// question it always was. Neither of the first two is open, which is what the bar over the
    /// transcript counts (`NeedsYouLogicTests`).
    func testAVersionWaitingOrSentIsAnswerableOrNotButNeverOpen() {
        let waiting = row(taskId: "waiting", gaps: ["没在实体机上跑"])
        let asked = row(taskId: "asked", gaps: [])
        let queue = coordinatorQueue(pending: [asked], waiting: [waiting], sent: [sent("handed")])

        let folded = standing(queue, "waiting")
        XCTAssertEqual(folded.state, .waiting(waiting))
        XCTAssertTrue(folded.waitsForCoordinator)
        XCTAssertTrue(folded.answerable, "Decide it myself: its owner may still decide it")
        XCTAssertEqual(folded.row, waiting, "and the opened card reads the row the read published")
        XCTAssertFalse(EvidenceDecisions.isOpen(folded), "nobody is asking the reader yet")
        XCTAssertEqual(EvidenceDecisions.heading(folded), EvidenceDecisions.askHeading,
                       "opened, it asks today's question")
        XCTAssertNil(EvidenceDecisions.staleExplanation(folded))

        let handed = standing(queue, "handed")
        XCTAssertEqual(handed.state, .sent(sent("handed")))
        XCTAssertFalse(handed.answerable, "the coordinator holds it; this end offers nothing to press")
        XCTAssertFalse(EvidenceDecisions.isOpen(handed))
        XCTAssertFalse(handed.waitsForCoordinator)

        XCTAssertEqual(standing(queue, "asked").state, .decidable(asked))
        XCTAssertTrue(EvidenceDecisions.isOpen(standing(queue, "asked")))
    }

    /// The two groups are drawn under the rule the cards are: this project's versions, ones the door
    /// would take from this session — and each in the conversation it is listed for.
    func testOnlyThisProjectsQueueIsDrawnHere() {
        let elsewhere = row(taskId: "elsewhere", projectId: "34MPiBgZ80YpSKt0lmTQA", gaps: [])
        let notMine = row(taskId: "not-mine", gaps: [], independent: false)
        let mine = row(taskId: "mine", gaps: [])
        let queue = coordinatorQueue(waiting: [elsewhere, notMine, mine],
                                     sent: [sent("sent-elsewhere", projectId: "34MPiBgZ80YpSKt0lmTQA"),
                                            sent("sent-here")])
        XCTAssertEqual(EvidenceDecisions.coordinatorQueueRows(queue: queue, projectId: Self.project,
                                                              sessionId: Self.coordinator).map(\.taskId),
                       ["mine"])
        XCTAssertEqual(EvidenceDecisions.sentRows(queue: queue, projectId: Self.project).map(\.taskId),
                       ["sent-here"])
        XCTAssertTrue(EvidenceDecisions.coordinatorQueueRows(queue: queue, projectId: nil).isEmpty,
                      "a conversation that coordinates nothing draws none of them")
        XCTAssertTrue(EvidenceDecisions.sentRows(queue: queue, projectId: nil).isEmpty)
        XCTAssertEqual(standing(queue, "elsewhere").state, .alreadyDecided,
                       "another project's waiting version is no card here")
    }

    /// One card per version, whichever group it is in: it is superseded by a later revision in
    /// either drawn group, it gives a reply typed against it somewhere to go only while it can still
    /// be decided here, and a card for a version that only ever waited is let go of once the read
    /// stops listing it — nobody was asked it — while one that was a question here stays to explain.
    func testOneCardFollowsItsVersionBetweenTheGroups() {
        let later = row(taskId: "task", revision: "2", gaps: [])
        let replaced = standing(coordinatorQueue(waiting: [later]), "task", "1")
        XCTAssertEqual(replaced.state, .superseded(replacement: later))
        XCTAssertTrue(EvidenceDecisions.letsGo(replaced, engaged: false),
                      "it only ever waited: nothing is left behind")
        XCTAssertFalse(EvidenceDecisions.letsGo(replaced, engaged: true),
                       "asked here, or opened: it stays and says it was superseded")

        let settled = standing(coordinatorQueue(), "task", "1")
        XCTAssertEqual(settled.state, .alreadyDecided)
        XCTAssertTrue(EvidenceDecisions.letsGo(settled, engaged: false))
        for kept in [standing(coordinatorQueue(waiting: [row(taskId: "task", gaps: [])]), "task"),
                     standing(coordinatorQueue(sent: [sent("task")]), "task"),
                     standing(coordinatorQueue(pending: [row(taskId: "task", gaps: [])]), "task"),
                     standing(nil, "task")] {
            XCTAssertFalse(EvidenceDecisions.letsGo(kept, engaged: false), "\(kept.state)")
        }

        // The armed composer keeps a reason while the version can still take one from here.
        XCTAssertTrue(EvidenceDecisions.holdsReply(standing(coordinatorQueue(waiting: [row(taskId: "task", gaps: [])]), "task")))
        XCTAssertTrue(EvidenceDecisions.holdsReply(standing(coordinatorQueue(pending: [row(taskId: "task", gaps: [])]), "task")))
        XCTAssertTrue(EvidenceDecisions.holdsReply(standing(nil, "task")),
                      "one failed read does not throw away a reason somebody is typing")
        XCTAssertFalse(EvidenceDecisions.holdsReply(standing(coordinatorQueue(sent: [sent("task")]), "task")),
                       "handed to the coordinator: the reason has nowhere to go from here")
        XCTAssertFalse(EvidenceDecisions.holdsReply(replaced))
        XCTAssertFalse(EvidenceDecisions.holdsReply(settled))
    }

    /// The conversation's own row does not move when a version is queued for its paused coordinator
    /// or handed to it, so the console re-reads the queue on a timer exactly while one of those can
    /// happen — and in a conversation that coordinates a project, never in any other.
    func testTheQueueIsReReadWhileItCanMove() {
        let paused = CoordinatorPause.paused(window: nil, retryAt: nil)
        XCTAssertTrue(EvidenceDecisions.rereadsQueue(nil, coordinates: true, pause: paused),
                      "paused: a version submitted now waits, and nothing else would show it")
        XCTAssertFalse(EvidenceDecisions.rereadsQueue(nil, coordinates: false, pause: paused),
                       "a failed conversation that coordinates nothing has no queue")
        XCTAssertFalse(EvidenceDecisions.rereadsQueue(coordinatorQueue(), coordinates: true, pause: .back))
        XCTAssertTrue(EvidenceDecisions.rereadsQueue(coordinatorQueue(waiting: [row(gaps: [])]),
                                                     coordinates: true, pause: .back),
                      "back, and still owed one: it is handed over when its turn ends")
        XCTAssertTrue(EvidenceDecisions.rereadsQueue(coordinatorQueue(sent: [sent()]),
                                                     coordinates: true, pause: .back),
                      "holding one: its decision turns the line into a receipt")
    }

    // MARK: why it waits

    private static let weeklyLimit = "You've hit your weekly limit · resets Oct 12, 7pm (Asia/Shanghai)"
    private static let resetsAt = "2026-10-12T11:00:00.000Z"

    private func coordinatorSession(_ state: SessionRunState, error: String? = weeklyLimit,
                                    retryAt: String? = resetsAt) -> Session {
        Session(id: Self.coordinator, title: "协调者停着时，证据卡排队等它",
                status: state == .failed ? .failed : (state == .running ? .running : .awaitingInput),
                runState: state, agentId: "orbit", assignedRunnerId: "hpc", pendingApprovals: 0,
                branch: nil, updatedAt: nil, projectId: Self.project, error: error, retryAt: retryAt)
    }

    /// The pause line, read off the coordinator's own row the way the web card reads it — the same
    /// cases, the same words. The window is the transcript's quota judgment
    /// (`AutoRetryLogic.quotaWindowKind`), named only for a failure that is a usage limit at all;
    /// the time is the retry it armed, in the receipt's clock.
    func testThePauseLineIsReadOffTheCoordinatorsOwnRow() {
        let now = ThinkingSummary.date("2026-10-09T12:02:00.000Z")!
        let retries = "2026-10-09T12:02:30.000Z"
        func at(_ iso: String) -> String { EvidenceDecisions.receiptTime(iso, now: now) }
        let cases: [(String, Session?, String)] = [
            ("a weekly limit, with the reset it armed a retry for", coordinatorSession(.failed),
             "Coordinator paused · weekly limit · resets \(at(Self.resetsAt))"),
            ("a 5-hour limit, with its reset",
             coordinatorSession(.failed, error: "You've hit your session limit · resets 6:20pm (Europe/Berlin)"),
             "Coordinator paused · 5-hour limit · resets \(at(Self.resetsAt))"),
            ("a weekly limit with no retry armed", coordinatorSession(.failed, retryAt: nil),
             "Coordinator paused · weekly limit"),
            ("a usage limit that names no window, with no retry armed",
             coordinatorSession(.failed,
                                error: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage "
                                    + "to purchase more credits or try again at Aug 9th, 2026 1:26 PM.",
                                retryAt: nil),
             "Coordinator paused · usage limit"),
            ("a provider error it will retry",
             coordinatorSession(.failed,
                                error: "API Error: 429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}",
                                retryAt: retries),
             "Coordinator paused · retries \(at(retries))"),
            ("a runner that went away, with nothing armed",
             coordinatorSession(.failed, error: "runner offline", retryAt: nil), "Coordinator paused"),
            ("a limit parked waiting for input, with its retry armed",
             coordinatorSession(.awaitingInput, error: nil),
             "Coordinator paused · retries \(at(Self.resetsAt))"),
            ("a failure that only quotes a limit",
             coordinatorSession(.failed,
                                error: "The earlier run stopped on this line from the runtime: \(Self.weeklyLimit)",
                                retryAt: nil),
             "Coordinator paused"),
            ("back, and running", coordinatorSession(.running, error: nil, retryAt: nil),
             "Coordinator is back · it gets this when its current turn ends"),
            ("back, and waiting for its reader", coordinatorSession(.awaitingInput, error: nil, retryAt: nil),
             "Coordinator is back · it gets this when its current turn ends"),
            ("no row to read yet: paused for a reason nobody knows", nil, "Coordinator paused"),
        ]
        for (name, session, line) in cases {
            XCTAssertEqual(EvidenceDecisions.pauseLine(EvidenceDecisions.coordinatorPause(session), now: now),
                           line, name)
        }
        XCTAssertEqual(EvidenceDecisions.coordinatorPause(coordinatorSession(.running, error: nil, retryAt: nil)),
                       .back)
        XCTAssertEqual(EvidenceDecisions.coordinatorPause(coordinatorSession(.failed)),
                       .paused(window: EvidenceDecisions.pauseWeeklyLimit, retryAt: Self.resetsAt))
    }

    /// The line a version that waited leaves once it is handed over: when, in the receipt's clock —
    /// the date as well once the day has passed.
    func testTheSentLineSaysWhenInTheReceiptsClock() {
        let delivered = "2026-10-09T12:05:00.000Z"
        let sameDay = ThinkingSummary.date("2026-10-09T12:06:00.000Z")!
        XCTAssertEqual(EvidenceDecisions.sentLine(delivered, now: sameDay),
                       "Sent to the coordinator · \(EvidenceDecisions.receiptTime(delivered, now: sameDay))")
        let later = ThinkingSummary.date("2026-10-12T12:06:00.000Z")!
        XCTAssertGreaterThan(EvidenceDecisions.sentLine(delivered, now: later).count,
                             EvidenceDecisions.sentLine(delivered, now: sameDay).count)
    }
}
