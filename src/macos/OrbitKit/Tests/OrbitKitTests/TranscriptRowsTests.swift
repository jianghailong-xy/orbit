import XCTest
@testable import OrbitKit

// Row assembly for the transcript List. The invariant these lock down is the one whose violation
// crashed the iOS client: every row the List is handed must carry a UNIQUE id, and each source must
// contribute a fixed, predictable number of rows.
final class TranscriptRowsTests: XCTestCase {
    private func user(_ id: String, _ text: String = "hi", queued: Bool = false) -> UserBubble {
        UserBubble(id: id, text: text, pending: false, queued: queued)
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

    func testEveryRowIdStaysUniqueWithFoldedRuns() {
        let r = built([.user(user("i1")), toolItem("t1"), toolItem("t2"), toolItem("t3"), toolItem("t4")])

        XCTAssertEqual(Set(r.map(\.id)).count, r.count)
    }
}
