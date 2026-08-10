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
}
