import XCTest
@testable import OrbitKit

// Row assembly for the transcript List. The invariant these lock down is the one whose violation
// crashed the iOS client: every row the List is handed must carry a UNIQUE id, and each source must
// contribute a fixed, predictable number of rows.
final class TranscriptRowsTests: XCTestCase {
    private func user(_ id: String, _ text: String = "hi", queued: Bool = false,
                      at ts: String? = nil) -> UserBubble {
        UserBubble(id: id, text: text, ts: ts, pending: false, queued: queued)
    }

    /// A row of one of the five receipts, placed by the door's own clock — the shape the console
    /// builds them in (`ConsoleModel`'s `adopt*`).
    private func record(_ kind: DeliveredDecisionCard.Kind,
                        at moment: String) -> DeliveredDecisionCard {
        DeliveredDecisionCard(kind: kind, placement: .at(moment))
    }

    private func card(_ after: String?) -> LocalStatusCard {
        LocalStatusCard(rows: [ComposerStatusRow(label: "Model", value: "opus")], afterItemID: after)
    }

    private func state(items: [TranscriptItem] = [],
                       approvals: [PendingApproval] = [],
                       queued: [UserBubble] = [],
                       oldestSeq: Int? = nil) -> TranscriptState {
        var s = TranscriptState()
        s.items = items
        s.pendingApprovals = approvals
        s.queued = queued
        s.oldestSeq = oldestSeq
        return s
    }

    func testOrderIsSpinnerHistoryApprovalsWorkingQueuedBottom() {
        let appr = PendingApproval(id: "ap1", kind: .tool, toolName: "Bash", input: nil)
        let rows = TranscriptRows.build(
            state: state(items: [.user(user("i1"))], approvals: [appr], queued: [user("i2")], oldestSeq: 42),
            statusCards: [], canPageOlder: true, showWorkingIndicator: true)
        XCTAssertEqual(rows.map(\.id),
                       ["load-older-42", "i1", "approval-ap1", "working-indicator", "queued-i2", "transcript-bottom"])
    }

    func testEverySourceIsOptionalButTheBottomRowAlwaysTrails() {
        let rows = TranscriptRows.build(state: state(), statusCards: [],
                                        canPageOlder: false, showWorkingIndicator: false)
        XCTAssertEqual(rows.map(\.id), ["transcript-bottom"])
    }

    func testStatusCardsSitAfterTheirAnchorAndAnUnanchoredOneLeads() {
        let lead = card(nil)
        let after1 = card("i1")
        let rows = TranscriptRows.build(
            state: state(items: [.user(user("i1")), .user(user("i2"))]),
            statusCards: [lead, after1], canPageOlder: false, showWorkingIndicator: false)
        XCTAssertEqual(rows.map(\.id),
                       ["local-status-\(lead.id)", "i1", "local-status-\(after1.id)", "i2", "transcript-bottom"])
    }

    // An optimistic bubble whose send failed is removed from `items`; a card anchored to it must
    // not vanish with it (the nested-ForEach layout dropped it silently).
    func testStatusCardWithADanglingAnchorTrailsInsteadOfDisappearing() {
        let orphan = card("gone")
        let rows = TranscriptRows.build(state: state(items: [.user(user("i1"))]),
                                        statusCards: [orphan], canPageOlder: false, showWorkingIndicator: false)
        XCTAssertEqual(rows.map(\.id), ["i1", "local-status-\(orphan.id)", "transcript-bottom"])
    }

    // Web parity: the read-only AskUserQuestion card is hidden while its interactive approval is live.
    func testQuestionToolCardIsHiddenWhileItsApprovalIsPending() {
        let card = ToolCard(id: "toolu_1", name: "AskUserQuestion", input: .null, result: nil,
                            status: .running, inputSeq: 5, inputTruncated: false)
        let appr = PendingApproval(id: "ap1", kind: .question, toolName: "AskUserQuestion", input: nil)
        let pending = TranscriptRows.build(state: state(items: [.toolCall(card)], approvals: [appr]),
                                           statusCards: [], canPageOlder: false, showWorkingIndicator: false)
        XCTAssertEqual(pending.map(\.id), ["approval-ap1", "transcript-bottom"])

        // Resolved → the card is the historical record again.
        let resolved = TranscriptRows.build(state: state(items: [.toolCall(card)]),
                                            statusCards: [], canPageOlder: false, showWorkingIndicator: false)
        XCTAssertEqual(resolved.map(\.id), ["toolu_1", "transcript-bottom"])
    }

    // The crash invariant. A malformed stream (two events sharing a tool_use id) must degrade to a
    // missing row, never to a List diff whose item counts don't reconcile.
    func testDuplicateIdsAreCollapsedSoTheListDiffStaysValid() {
        let dup = ToolCard(id: "toolu_1", name: "Bash", input: .null, result: "ok",
                           status: .ok, inputSeq: 1, inputTruncated: false)
        let rows = TranscriptRows.build(state: state(items: [.toolCall(dup), .toolCall(dup)]),
                                        statusCards: [], canPageOlder: false, showWorkingIndicator: false)
        XCTAssertEqual(rows.map(\.id), ["toolu_1", "transcript-bottom"])
    }

    func testIdsAreUniqueAcrossEverySourceAtOnce() {
        // A queued bubble and a history bubble minted by the same reducer counter, plus a tool card
        // and an approval — the full set the List sees during a live turn.
        let tool = ToolCard(id: "toolu_1", name: "Bash", input: .null, result: nil,
                            status: .running, inputSeq: 3, inputTruncated: false)
        let appr = PendingApproval(id: "ap1", kind: .tool, toolName: "Bash", input: nil)
        let c = card("i1")
        let rows = TranscriptRows.build(
            state: state(items: [.user(user("i1")), .toolCall(tool), .error(id: "i2", message: "boom")],
                         approvals: [appr], queued: [user("i3", queued: true)], oldestSeq: 7),
            statusCards: [c], canPageOlder: true, showWorkingIndicator: true)
        XCTAssertEqual(Set(rows.map(\.id)).count, rows.count)
    }

    // MARK: - tool-run folding

    private func toolItem(_ id: String, _ name: String = "Bash", status: ToolStatus = .ok) -> TranscriptItem {
        .toolCall(ToolCard(id: id, name: name, input: .null, result: "ok", status: status))
    }

    private func built(_ items: [TranscriptItem]) -> [TranscriptRow] {
        TranscriptRows.build(state: state(items: items), statusCards: [],
                             canPageOlder: false, showWorkingIndicator: false)
    }

    func testThreeConsecutiveCallsFoldIntoOneRowKeyedOnTheFirst() {
        let r = built([.user(user("i1")), toolItem("t1"), toolItem("t2"), toolItem("t3")])

        // The run's three rows become one, and it answers to the first call's id — the prepend
        // anchor may well be that call, and a scrollTo nobody carries is a silent no-op.
        XCTAssertEqual(r.map(\.id), ["i1", "t1", "transcript-bottom"])
        guard case .toolGroup(let cards) = r[1] else { return XCTFail("expected a folded run") }
        XCTAssertEqual(cards.map(\.id), ["t1", "t2", "t3"])
    }

    func testTwoCallsStayTheirOwnRows() {
        XCTAssertEqual(built([toolItem("t1"), toolItem("t2")]).map(\.id), ["t1", "t2", "transcript-bottom"])
    }

    func testProseBetweenCallsKeepsThemApart() {
        let r = built([toolItem("t1"), toolItem("t2"), .error(id: "e1", message: "boom"), toolItem("t3"), toolItem("t4")])

        XCTAssertEqual(r.map(\.id), ["t1", "t2", "e1", "t3", "t4", "transcript-bottom"])
    }

    // A question, a plan, a spawned child session and a `!`-shell line each render as their own
    // card — folding them away would hide the thing the turn was about.
    func testCallsThatAreNotStepsBreakTheRun() {
        let r = built([toolItem("t1"), toolItem("t2"), toolItem("q1", "AskUserQuestion"), toolItem("t3"), toolItem("t4")])
        XCTAssertEqual(r.map(\.id), ["t1", "t2", "q1", "t3", "t4", "transcript-bottom"])

        let shell = built([toolItem("t1"), toolItem("shell-1"), toolItem("t2"), toolItem("t3")])
        XCTAssertEqual(shell.map(\.id), ["t1", "shell-1", "t2", "t3", "transcript-bottom"])
    }

    // A picture can only be read off the result, never the name — and the folded group is the one
    // fold the card can't open through. An image result therefore leaves the run and splits it,
    // instead of vanishing into a closed "Tools × 7" row.
    func testAnImageResultLeavesTheRunAndSplitsIt() {
        let shot = TranscriptItem.toolCall(ToolCard(id: "img1", name: "Read", input: .null, result: nil,
                                                    resultImages: [Data([0x89, 0x50])], resultHasImage: true,
                                                    status: .ok))
        let r = built([toolItem("t1"), toolItem("t2"), toolItem("t3"), shot,
                       toolItem("t4"), toolItem("t5"), toolItem("t6")])

        XCTAssertEqual(r.map(\.id), ["t1", "img1", "t4", "transcript-bottom"])
        guard case .toolGroup(let head) = r[0], case .item(.toolCall(let card)) = r[1],
              case .toolGroup(let tail) = r[2] else { return XCTFail("expected run · image · run") }
        XCTAssertEqual(head.map(\.id), ["t1", "t2", "t3"])
        XCTAssertEqual(card.id, "img1")
        XCTAssertEqual(tail.map(\.id), ["t4", "t5", "t6"])
    }

    // The server strips an oversized image's bytes and keeps the block, and only an open card
    // refetches them — so this one, with nothing decoded to show yet, is the card that most needs
    // to stay out of the fold.
    func testAnImageStrippedOfItsBytesStillLeavesTheRun() {
        let shot = TranscriptItem.toolCall(ToolCard(id: "img1", name: "Read", input: .null, result: nil,
                                                    resultImages: [], resultHasImage: true, status: .ok))
        let r = built([toolItem("t1"), toolItem("t2"), shot, toolItem("t3")])

        XCTAssertEqual(r.map(\.id), ["t1", "t2", "img1", "t3", "transcript-bottom"])
    }

    func testEveryRowIdStaysUniqueWithFoldedRuns() {
        let r = built([.user(user("i1")), toolItem("t1"), toolItem("t2"), toolItem("t3"), toolItem("t4")])

        XCTAssertEqual(Set(r.map(\.id)).count, r.count)
    }

    // MARK: delivered decision cards

    private func decision(_ intentID: String, after: String?) -> DeliveredDecisionCard {
        DeliveredDecisionCard(kind: .criteriaDecision(intentID: intentID),
                              placement: .onArrival(afterItemID: after))
    }

    /// A question about the project's ruler sits where it ARRIVED, so the messages that came after
    /// it push it up — the property the "N open questions below" bar exists to answer. An approval
    /// cannot do this: it stops the turn, so it is always last.
    func testADeliveredDecisionCardStaysWhereItArrivedAndLaterMessagesGoBelowIt() {
        let rows = TranscriptRows.build(
            state: state(items: [.user(user("i1")), .user(user("i2"))]),
            statusCards: [], canPageOlder: false, showWorkingIndicator: false,
            decisionCards: [decision("in-1", after: "i1")])
        XCTAssertEqual(rows.map(\.id), ["i1", "criteria-decision-in-1", "i2", "transcript-bottom"])
    }

    /// Its id is the web card's DOM id, because the two clients are pointed at it by something else
    /// on screen — a bar here, a strip row there — and one vocabulary is cheaper than two.
    func testTheConfirmationCardHasTheOneIdAProjectEverHasForIt() {
        let rows = TranscriptRows.build(
            state: state(items: [.user(user("i1"))]),
            statusCards: [], canPageOlder: false, showWorkingIndicator: false,
            decisionCards: [DeliveredDecisionCard(kind: .acceptanceConfirmation,
                                                  placement: .onArrival(afterItemID: "i1"))])
        XCTAssertEqual(rows.map(\.id), ["i1", "acceptance-confirmation", "transcript-bottom"])
    }

    /// An unanswered question whose anchor is not in the window — nothing loaded yet, or the item
    /// paged out — trails at the tail instead of being dropped or led with. A `/status` card with
    /// no anchor still leads, which is the case this deliberately does not copy.
    func testAQuestionWhoseAnchorIsMissingIsShownAtTheTailRatherThanLost() {
        let lead = card(nil)
        let rows = TranscriptRows.build(
            state: state(items: [.user(user("i1"))]),
            statusCards: [lead], canPageOlder: false, showWorkingIndicator: false,
            decisionCards: [decision("in-1", after: nil), decision("in-2", after: "gone")])
        XCTAssertEqual(rows.map(\.id),
                       ["local-status-\(lead.id)", "i1",
                        "criteria-decision-in-1", "criteria-decision-in-2", "transcript-bottom"])
    }

    /// The record of an answer sits where the DECISION happened — resolved from the door's clock
    /// against the rows' own clocks on every render, not from when the read brought the row in —
    /// and its id is beside the question's rather than the same as it: for one intent both rows can
    /// be on screen at once while the question is being let go of, and two rows sharing an id costs
    /// the List its diff.
    func testAReceiptSitsWhereItsAnswerHappenedUnderAnIdOfItsOwn() {
        let settled = SettledCriteriaDecision(intentId: "in-1", decision: .approve,
                                              decidedAt: "2026-09-11T15:40:00.000Z",
                                              baseSeal: "a", resultingSeal: "b")
        let receipt = record(.criteriaDecisionReceipt(settled: settled),
                             at: settled.decidedAt)
        let rows = TranscriptRows.build(
            state: state(items: [.user(user("i1", at: "2026-09-11T15:00:00.000Z")),
                                 .user(user("i2", at: "2026-09-11T15:50:00.000Z"))]),
            statusCards: [], canPageOlder: false, showWorkingIndicator: false,
            decisionCards: [decision("in-1", after: "i1"), receipt])
        XCTAssertEqual(rows.map(\.id),
                       ["i1", "criteria-decision-in-1", "criteria-decision-receipt-in-1",
                        "i2", "transcript-bottom"])
    }

    /// THE RULE OF 2026-09-22, and what this test is for. A record whose moment is older than
    /// every loaded row is drawn at the HEAD of the window — above the load-earlier row, which
    /// stays UNDER it because that row is the way up to the moment — and NOT at the tail. At the
    /// tail it reads as a decision made now, and it is where the account owner found one that had
    /// been trimmed out of the window 316 rows earlier (a frozen anchor id, an unplaceable anchor,
    /// `trailingDecisions`: `ReceiptAnchor.Placement` has the story).
    func testARecordOlderThanEveryLoadedRowLeadsAtTheHeadAndNotAtTheTail() {
        let settled = SettledCriteriaDecision(intentId: "in-1", decision: .approve,
                                              decidedAt: "2026-09-19T04:26:49.679Z",
                                              baseSeal: "a", resultingSeal: "b")
        let rows = TranscriptRows.build(
            state: state(items: [.user(user("i1", at: "2026-09-21T09:00:00.000Z")),
                                 .user(user("i2", at: "2026-09-22T09:00:00.000Z"))],
                         oldestSeq: 42),
            statusCards: [], canPageOlder: true, showWorkingIndicator: false,
            decisionCards: [record(.criteriaDecisionReceipt(settled: settled),
                                   at: settled.decidedAt)])
        XCTAssertEqual(rows.map(\.id),
                       ["criteria-decision-receipt-in-1", "load-older-42", "i1", "i2",
                        "transcript-bottom"])
    }

    /// Several records above the window read oldest-first, like the conversation they are the head
    /// of — and the load-earlier row stays under all of them.
    func testHeadRecordsReadOldestFirst() {
        let older = SettledCriteriaDecision(intentId: "in-1", decision: .approve,
                                            decidedAt: "2026-09-19T04:26:49.679Z",
                                            baseSeal: "a", resultingSeal: "b")
        let newer = SettledCriteriaDecision(intentId: "in-2", decision: .reject,
                                            decidedAt: "2026-09-20T04:26:49.679Z",
                                            baseSeal: "c", resultingSeal: "d")
        let rows = TranscriptRows.build(
            state: state(items: [.user(user("i1", at: "2026-09-21T09:00:00.000Z"))], oldestSeq: 42),
            statusCards: [], canPageOlder: true, showWorkingIndicator: false,
            decisionCards: [record(.criteriaDecisionReceipt(settled: newer), at: newer.decidedAt),
                            record(.criteriaDecisionReceipt(settled: older), at: older.decidedAt)])
        XCTAssertEqual(rows.map(\.id),
                       ["criteria-decision-receipt-in-1", "criteria-decision-receipt-in-2",
                        "load-older-42", "i1", "transcript-bottom"])
    }

    /// A stamp nothing can parse is not a licence to draw the record in the wrong place: it is not
    /// drawn at all. (The window's head claims "older than everything here", which is a claim about
    /// a moment — and there is none.)
    func testARecordWhoseStampCannotBeReadIsNotDrawn() {
        let settled = SettledCriteriaDecision(intentId: "in-1", decision: .approve,
                                              decidedAt: "not a stamp",
                                              baseSeal: "a", resultingSeal: "b")
        let rows = TranscriptRows.build(
            state: state(items: [.user(user("i1", at: "2026-09-21T09:00:00.000Z"))]),
            statusCards: [], canPageOlder: false, showWorkingIndicator: false,
            decisionCards: [record(.criteriaDecisionReceipt(settled: settled),
                                   at: settled.decidedAt)])
        XCTAssertEqual(rows.map(\.id), ["i1", "transcript-bottom"])
    }

    /// A record whose moment falls among the loaded rows keeps going where it happened, even with
    /// the head of that window long gone: the placement is re-derived, not remembered.
    func testARecordInsideTheWindowStaysWhereItHappened() {
        let settled = SettledCriteriaDecision(intentId: "in-1", decision: .approve,
                                              decidedAt: "2026-09-21T09:30:00.000Z",
                                              baseSeal: "a", resultingSeal: "b")
        let rows = TranscriptRows.build(
            state: state(items: [.user(user("i1", at: "2026-09-21T09:00:00.000Z")),
                                 .user(user("i2", at: "2026-09-21T10:00:00.000Z"))], oldestSeq: 42),
            statusCards: [], canPageOlder: true, showWorkingIndicator: false,
            decisionCards: [record(.criteriaDecisionReceipt(settled: settled),
                                   at: settled.decidedAt)])
        XCTAssertEqual(rows.map(\.id),
                       ["load-older-42", "i1", "criteria-decision-receipt-in-1", "i2",
                        "transcript-bottom"])
    }

    /// Several records in one render are placed against ONE read of the rows' clocks
    /// (`ReceiptAnchor.Clocks`), and each still lands where its own moment puts it: above the
    /// window, between two rows, after the last.
    func testSeveralRecordsInOneRenderEachLandWhereTheirOwnMomentPutsThem() {
        func receipt(_ intent: String, at stamp: String) -> DeliveredDecisionCard {
            record(.criteriaDecisionReceipt(settled: SettledCriteriaDecision(
                intentId: intent, decision: .approve, decidedAt: stamp,
                baseSeal: "a", resultingSeal: "b")), at: stamp)
        }
        let rows = TranscriptRows.build(
            state: state(items: [.user(user("i1", at: "2026-09-21T09:00:00.000Z")),
                                 .user(user("i2", at: "2026-09-21T10:00:00.000Z"))], oldestSeq: 42),
            statusCards: [], canPageOlder: true, showWorkingIndicator: false,
            decisionCards: [receipt("late", at: "2026-09-21T11:00:00.000Z"),
                            receipt("mid", at: "2026-09-21T09:30:00.000Z"),
                            receipt("early", at: "2026-09-20T09:00:00.000Z")])
        XCTAssertEqual(rows.map(\.id),
                       ["criteria-decision-receipt-early", "load-older-42", "i1",
                        "criteria-decision-receipt-mid", "i2", "criteria-decision-receipt-late",
                        "transcript-bottom"])
    }

    /// The evidence half of the same rule: the record of an answer is a row of its own, id beside
    /// the question card's rather than equal to it.
    func testAnEvidenceReceiptSitsWhereItsAnswerHappenedUnderAnIdOfItsOwn() {
        let decided = RecordedEvidenceDecision(
            taskId: "34LMiluvx0jK63cj8arWl", title: "T", projectId: nil, evidenceRevision: "2",
            decision: .confirm, note: nil, decidedAt: "2026-09-16T09:45:00.000Z",
            decidedByType: "USER")
        let rows = TranscriptRows.build(
            state: state(items: [.user(user("i1", at: "2026-09-16T09:00:00.000Z")),
                                 .user(user("i2", at: "2026-09-16T10:00:00.000Z"))]),
            statusCards: [], canPageOlder: false, showWorkingIndicator: false,
            decisionCards: [
                DeliveredDecisionCard(kind: .evidenceDecision(taskID: decided.taskId,
                                                              evidenceRevision: decided.evidenceRevision),
                                      placement: .onArrival(afterItemID: "i1")),
                record(.evidenceDecisionReceipt(decided: decided), at: decided.decidedAt),
            ])
        XCTAssertEqual(rows.map(\.id),
                       ["i1", "evidence-decision-34LMiluvx0jK63cj8arWl@2",
                        "evidence-decision-receipt-34LMiluvx0jK63cj8arWl@2",
                        "i2", "transcript-bottom"])
    }

    /// The rule the crash taught: every row the List is handed carries a unique id, whatever the
    /// sources do. A card delivered twice must not become two rows with one id.
    func testARepeatedDecisionCardYieldsExactlyOneRow() {
        let rows = TranscriptRows.build(
            state: state(items: [.user(user("i1"))]),
            statusCards: [], canPageOlder: false, showWorkingIndicator: false,
            decisionCards: [decision("in-1", after: "i1"), decision("in-1", after: "i1")])
        XCTAssertEqual(rows.map(\.id), ["i1", "criteria-decision-in-1", "transcript-bottom"])
    }
}
