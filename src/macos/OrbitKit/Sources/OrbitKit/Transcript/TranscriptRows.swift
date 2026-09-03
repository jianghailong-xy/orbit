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
    /// A run of consecutive tool calls, folded into one row (see `TranscriptRows.groupToolRuns`).
    case toolGroup([ToolCard])
    case statusCard(LocalStatusCard)
    case approval(PendingApproval)
    case working
    case queued(UserBubble)
    case bottom

    /// A history row keeps its bare item id — that's what `scrollTo` targets (the prepend anchor,
    /// the sticky header's jump-back) and what `AnchorRow` reports as the top anchor. Every other
    /// kind is namespaced, so no two rows can collide however the sources move.
    ///
    /// A group takes the bare id of its first call rather than a namespaced one, and can do so
    /// without risking a collision because it *replaces* that call's own row. It has to: a prepend
    /// anchor is the id of the window's first item, which may well be a tool call, and a
    /// `scrollTo` at an id no row carries is a silent no-op — the reader's place, lost.
    public var id: String {
        switch self {
        case .loadOlder(let cursor): return "load-older-\(cursor)"
        case .item(let item):        return item.id
        case .toolGroup(let cards):  return cards.first?.id ?? "tool-group-empty"
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
        return groupToolRuns(rows).filter { seen.insert($0.id).inserted }
    }

    /// Web parity (`TOOL_GROUP_MIN`): a shorter run reads better as its own rows than as a row
    /// saying "Bash × 2".
    public static let toolGroupMin = 3

    /// Fold runs of consecutive tool calls into one row. Between two pieces of prose the transcript's
    /// job is to say "it did nine things", not to spend nine rows saying which — on a phone those
    /// nine rows are the whole screen, and the reply that follows them is off it.
    ///
    /// Anything that isn't a groupable call ends the run, so a status card, a sentence, or an
    /// approval between two calls keeps them apart, exactly as the reader saw them happen.
    static func groupToolRuns(_ rows: [TranscriptRow]) -> [TranscriptRow] {
        var out: [TranscriptRow] = []
        var run: [ToolCard] = []
        func flush() {
            if run.count >= toolGroupMin {
                out.append(.toolGroup(run))
            } else {
                out.append(contentsOf: run.map { TranscriptRow.item(.toolCall($0)) })
            }
            run.removeAll()
        }
        for row in rows {
            if case .item(let item) = row, case .toolCall(let card) = item, isGroupable(card) {
                run.append(card)
            } else {
                flush()
                out.append(row)
            }
        }
        flush()
        return out
    }

    /// A call one folded row can stand in for: no interactive twin rendered below it (question,
    /// plan), no transcript or card of its own (Task, Workspace, a spawned child session), and not
    /// a `!`-shell command the user ran — that one is the user's own line, not a step.
    ///
    /// A picture is the one exclusion that can't be read off the name: `Read` on a .png and an MCP
    /// screenshot tool answer alike with an image block, and only the result says so. It is excluded
    /// anyway, because the group is the one fold the card can't open through — the card unfolds
    /// itself on an image (`ToolCardView.defaultOpen`) and a closed group hides it whole, so a
    /// screenshot inside a run reaches the reader as nothing at all, and a folded card never
    /// refetches the bytes the server stripped. The hop out of the run this costs happens once and
    /// never reverses: an image block that has arrived stays arrived, unlike the running/failed
    /// states the folded row deliberately reports instead of opening on. Web parity:
    /// `isGroupableTool`.
    private static func isGroupable(_ card: ToolCard) -> Bool {
        if card.id.hasPrefix("shell-") { return false }
        if card.resultHasImage { return false }
        switch card.name {
        case "AskUserQuestion", "ExitPlanMode", "mcp__orbit__session_create", "Task", "Workspace":
            return false
        default:
            return true
        }
    }
}
