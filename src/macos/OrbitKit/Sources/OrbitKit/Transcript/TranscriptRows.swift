import Foundation

// The transcript's rows, flattened.
//
// The console draws from five independently-updating sources — history items, local `/status`
// cards, pending approvals, the working indicator, queued sends — and the view used to assemble
// them with an inline `if` and a nested `ForEach` INSIDE `ForEach(state.items)`, so a single
// `ForEach` element could yield 0, 1 or N rows and that count changed while other rows were
// inserted in the same update. SwiftUI's `List` is UICollectionView-backed on iOS, and that shape
// made its batch update miscount: NSInternalInconsistencyException out of
// `_endItemAnimationsWithInvalidationContext` ("invalid number of items in section") — the two
// TestFlight crashes on 0.1.2 (1299), one on the animated update path and one on the non-animated
// one, i.e. the row set itself was inconsistent, not the animation.
//
// Building the rows here gives the List a diff it can always reconcile — one row per element, from
// one consistent snapshot, every id unique — and makes the ordering unit-testable off-device.

/// A local-only command result rendered inline with the conversation. It deliberately stays out of
/// `TranscriptState`: `/status` never reaches the runner and therefore has no durable server event.
public struct LocalStatusCard: Identifiable, Equatable, Sendable {
    public let id: UUID
    public let rows: [ComposerStatusRow]
    /// The transcript item that was last when the command ran. Rendering after this stable id keeps
    /// later runner messages below the card instead of moving an old local result back to the tail.
    public let afterItemID: String?

    public init(id: UUID = UUID(), rows: [ComposerStatusRow], afterItemID: String? = nil) {
        self.id = id
        self.rows = rows
        self.afterItemID = afterItemID
    }
}

/// One rendered transcript row, whatever it was assembled from.
public enum TranscriptRow: Identifiable, Equatable, Sendable {
    case loadOlder(cursor: Int)
    case item(TranscriptItem)
    case statusCard(LocalStatusCard)
    case approval(PendingApproval)
    case working
    case queued(UserBubble)
    case bottom

    /// A history row keeps its bare item id — that's what `scrollTo` targets (the prepend anchor,
    /// the sticky header's jump-back) and what `AnchorRow` reports as the top anchor. Every other
    /// kind is namespaced, so no two rows can collide however the sources move.
    public var id: String {
        switch self {
        case .loadOlder(let cursor): return "load-older-\(cursor)"
        case .item(let item):        return item.id
        case .statusCard(let card):  return "local-status-\(card.id)"
        case .approval(let appr):    return "approval-\(appr.id)"
        case .working:               return "working-indicator"
        case .queued(let bubble):    return "queued-\(bubble.id)"
        case .bottom:                return "transcript-bottom"
        }
    }
}

public enum TranscriptRows {
    /// Flatten one snapshot into the rows to render, in web's order: history, then pending
    /// approvals, then the working indicator, then queued sends, then the scroll-to-bottom target.
    public static func build(state: TranscriptState,
                             statusCards: [LocalStatusCard],
                             canPageOlder: Bool,
                             showWorkingIndicator: Bool) -> [TranscriptRow] {
        var rows: [TranscriptRow] = []
        // Scroll-up history paging: while older pages remain, the first row is a spinner that pulls
        // the previous page in when it scrolls into view. Its id moves with the cursor, so a page
        // too short to push it off-screen re-materializes it and chains the next fetch.
        if canPageOlder { rows.append(.loadOlder(cursor: state.oldestSeq ?? 0)) }

        // A command run before the first transcript event belongs above events that arrive later;
        // the rest are placed after the item that was last at invocation time.
        var anchored: [String: [LocalStatusCard]] = [:]
        for card in statusCards {
            guard let anchor = card.afterItemID else { rows.append(.statusCard(card)); continue }
            anchored[anchor, default: []].append(card)
        }
        for item in state.items {
            // An AskUserQuestion / ExitPlanMode tool card duplicates the live interactive approval
            // rendered below while the prompt still awaits an answer — show only the interactive
            // card until it resolves, after which this one is the historical record (web parity:
            // Transcript.tsx hides the read-only copy while `live && !result`).
            if !Approvals.duplicatesPendingApproval(item, pendingApprovals: state.pendingApprovals) {
                rows.append(.item(item))
            }
            for card in anchored.removeValue(forKey: item.id) ?? [] { rows.append(.statusCard(card)) }
        }
        // An anchor no longer in the window (its item was dropped — e.g. an optimistic bubble whose
        // send failed) would otherwise take the card down with it. Trail those instead of losing them.
        for card in statusCards where card.afterItemID.map({ anchored[$0] != nil }) == true {
            rows.append(.statusCard(card))
        }

        // Approvals render as the agent's latest turn (web's AgentView puts the panel right after
        // the messages), the working indicator belongs to the RUNNING turn, and queued sends wait
        // behind it.
        rows.append(contentsOf: state.pendingApprovals.map(TranscriptRow.approval))
        if showWorkingIndicator { rows.append(.working) }
        rows.append(contentsOf: state.queued.map(TranscriptRow.queued))
        // Zero-height tail row: a stable `scrollTo` target that always sits below the last message
        // (the last item's own id moves as it streams).
        rows.append(.bottom)

        // Ids are unique by construction above; a repeat could only come from a malformed stream
        // (two events sharing a tool_use id). Drop it rather than hand the List a diff that aborts.
        var seen = Set<String>()
        return rows.filter { seen.insert($0.id).inserted }
    }
}
