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

/// A standing question a project puts to its owner, delivered into the conversation it belongs to:
/// the held weakening proposal, the settlement confirmation, and the decision on one revision of a
/// task's completion evidence. None is an `Approval` and none stops a turn, so none can be rendered
/// at the tail the way a pending approval is — they sit where they arrived and later messages push
/// them up, which is exactly why the cross-session "needs you" bar now also points DOWN at them
/// inside their own session. The one exception, and why it is one, is `DeliveryAnchor`.
///
/// It carries an address and never any content: what the card shows is re-derived from the server
/// on every render (see OrbitKit's `CriteriaDecision.swift` and `EvidenceDecision.swift`), and a
/// copy kept here would be the one thing that design is buying its way out of.
public struct DeliveredDecisionCard: Identifiable, Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        /// One held loosening proposal, by the address the pending read publishes.
        case criteriaDecision(intentID: String)
        /// One answer to such a proposal, as the same read publishes it under `settled`.
        ///
        /// The row carries the answer ITSELF and not its address, unlike the question above it. A
        /// question is re-derived from the read on every render, because what a reader may do with
        /// it depends on what the project's ruler says now; an answer is a committed fact that
        /// cannot change, and the read carries only the most recent handful — a record that
        /// disappeared because the read's window slid would be the same defect as one that never
        /// survived a relaunch.
        case criteriaDecisionReceipt(settled: SettledCriteriaDecision)
        /// The one confirmation question a project has. There is never more than one.
        case acceptanceConfirmation
        /// One revision of one task's completion evidence. The revision is part of the address
        /// because the door's compare-and-set is against it: a newer revision is its own card.
        case evidenceDecision(taskID: String, evidenceRevision: String)
        /// One OWNER_CONFIRMED task's run waiting on its owner, by the report the door's
        /// compare-and-set is against: a later report is its own card, and the earlier one becomes a
        /// receipt (`OwnerConfirmation.swift`).
        case ownerConfirmation(taskID: String, requestID: String)
        /// A recorded owner decision, drawn where it was made. Not a question: nothing on it is
        /// pressable, and it stays for as long as the read publishes the decision.
        case ownerDecisionReceipt(taskID: String, decisionID: String)
        /// One answer to such a revision, as the same read publishes it under `decided`. Carries
        /// the answer itself, for the reason `criteriaDecisionReceipt` gives.
        case evidenceDecisionReceipt(decided: RecordedEvidenceDecision)
    }

    public let kind: Kind
    /// The transcript item that was last when this card arrived — the same anchoring
    /// `LocalStatusCard` uses, and for the same reason: a question delivered an hour ago must not
    /// walk back down to the tail every time somebody says something.
    ///
    /// Nil is not "unknown": it is a card that FOLLOWS the tail, which `build` renders below every
    /// item there is. `DeliveryAnchor` says which kind gets which, and why one of them does.
    public let afterItemID: String?

    public init(kind: Kind, afterItemID: String? = nil) {
        self.kind = kind
        self.afterItemID = afterItemID
    }

    public var id: String {
        switch kind {
        // The web card's DOM id, in the same spelling, because both clients are pointed at it by
        // something else on screen and one vocabulary is cheaper than two.
        case .criteriaDecision(let intentID): return "criteria-decision-\(intentID)"
        // Beside the question's id rather than equal to it: for one intent both rows can be on
        // screen at once while the question is being let go of, and a duplicate id costs the List
        // its diff.
        case .criteriaDecisionReceipt(let settled):
            return "criteria-decision-receipt-\(settled.intentId)"
        case .acceptanceConfirmation:         return "acceptance-confirmation"
        // The web evidence card's `decisionRowKey` spelling, taskId@evidenceRevision.
        case .evidenceDecision(let taskID, let evidenceRevision):
            return "evidence-decision-\(taskID)@\(evidenceRevision)"
        // The web confirmation card's `data-owner-confirmation` spelling, plus the task it belongs
        // to: two tasks can each have a card on screen in their own run's session, and the request
        // alone would still collide with a sibling window's.
        case .ownerConfirmation(let taskID, let requestID):
            return "owner-confirmation-\(taskID)@\(requestID)"
        // The web receipt's element key, `owner-decision-receipt:${decided.id}`.
        case .ownerDecisionReceipt(let taskID, let decisionID):
            return "owner-decision-receipt-\(taskID)@\(decisionID)"
        case .evidenceDecisionReceipt(let decided):
            return "evidence-decision-receipt-\(decided.id)"
        }
    }
}

public extension TranscriptItem {
    /// The runner's clock on this row, when it carries one.
    ///
    /// Reasoning is stamped at both ends (`ThinkingBlock.startedTs`/`finishedTs`) and a closed one
    /// reads as when it FINISHED — the moment its row's words stopped being written. Nothing else
    /// carries a clock: an interrupt or an error row has no time of its own, which is why
    /// `ReceiptAnchor` takes the last row that HAS one rather than the row beside the moment.
    var clock: String? {
        switch self {
        case .user(let bubble):      return bubble.ts
        case .assistant(let bubble): return bubble.ts
        case .thinking(let block):   return block.finishedTs ?? block.startedTs
        case .toolCall(let card):    return card.ts
        case .interrupt, .error, .authError, .autoRetry: return nil
        }
    }
}

/// Where a record that arrived from a READ — not from the stream — belongs in the conversation.
///
/// A card delivered live anchors to the item that was last when it ARRIVED. A record has no arrival
/// of its own on a device that was not there: the criteria decision's receipt and the evidence
/// decision's are both derived from the answers the server publishes, on every console open and
/// every reload, so they are placed by the door's own clock against the rows' clocks instead. One
/// function, because two ends of one rule is how a phone and a browser come to disagree about where
/// the same answer happened.
public enum ReceiptAnchor {
    /// The id of the LAST item whose own clock is at or before `stamp`.
    ///
    /// Nil when every loaded item is later: the moment is then above the window this device holds,
    /// and drawing the record at the top would put a decision above things that happened first. Nil
    /// too for a stamp nothing can parse — a record nobody can place is not drawn in the wrong one.
    public static func after(items: [TranscriptItem], at stamp: String) -> String? {
        guard let at = ThinkingSummary.date(stamp) else { return nil }
        var anchor: String?
        for item in items {
            guard let own = item.clock, let when = ThinkingSummary.date(own), when <= at else {
                continue
            }
            anchor = item.id
        }
        return anchor
    }
}

/// Where a card being delivered RIGHT NOW belongs — the other half of the rule `ReceiptAnchor`
/// states for a record that has a moment of its own.
///
/// Nearly every delivered card anchors to the item that was last when it arrived, and must: a
/// question delivered an hour ago walking back down to the tail every time somebody says something
/// is the thing the "needs you" bar points UP at. The owner-confirmation QUESTION is the one that
/// cannot be placed that way, because its arrival is not its own. It is delivered by a read the
/// CONTROL PLANE triggers — `adoptServerSnapshot` re-reads the moment the run's row moves — and
/// that snapshot reaches the device before this turn's own transcript rows do, so the item that was
/// last at delivery is the owner's question rather than the reply being asked about. Anchored
/// there, the card was drawn ABOVE the report it quotes: the account owner's beta v0.1.2-beta.77
/// screenshot, 2026-09-16 — `↑ Your question …`, the card, and only then the run's report.
///
/// It follows the tail instead, which is where the browser has always drawn it: a fixed slot after
/// the transcript (`WorkspaceView.tsx`'s `SessionOwnerConfirmationCard`), re-derived on every render
/// rather than frozen at delivery. That is the same guarantee, not a second one — the card sits
/// below its own report however late the report arrives.
///
/// An ANSWERED card is not this. It is a receipt: a record of a decision, which keeps the place it
/// was given (`adoptReceipts`) so a read coming round again cannot walk it down the conversation.
public enum DeliveryAnchor {
    /// The id `kind` anchors to, against the transcript as it stands this instant. Nil is a card
    /// that trails: `TranscriptRows.build` draws an unanchored question below every item.
    public static func onArrival(of kind: DeliveredDecisionCard.Kind,
                                 items: [TranscriptItem]) -> String? {
        switch kind {
        case .ownerConfirmation:
            return nil
        // Exhaustive rather than defaulted: a card added later has to say which of the two it is.
        case .criteriaDecision, .criteriaDecisionReceipt, .acceptanceConfirmation,
             .evidenceDecision, .ownerDecisionReceipt, .evidenceDecisionReceipt:
            return items.last?.id
        }
    }
}

/// One rendered transcript row, whatever it was assembled from.
public enum TranscriptRow: Identifiable, Equatable, Sendable {
    case loadOlder(cursor: Int)
    case item(TranscriptItem)
    /// A run of consecutive tool calls, folded into one row (see `TranscriptRows.groupToolRuns`).
    case toolGroup([ToolCard])
    case statusCard(LocalStatusCard)
    case decisionCard(DeliveredDecisionCard)
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
        case .decisionCard(let card): return card.id
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
                             showWorkingIndicator: Bool,
                             decisionCards: [DeliveredDecisionCard] = []) -> [TranscriptRow] {
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
        // A delivered decision card anchors the same way — but one whose anchor it cannot place
        // trails at the TAIL rather than leading at the head. A `/status` result with no anchor ran
        // before the conversation and belongs above it; an unanswered question belongs where it can
        // be found.
        var anchoredDecisions: [String: [DeliveredDecisionCard]] = [:]
        var trailingDecisions: [DeliveredDecisionCard] = []
        for card in decisionCards {
            guard let anchor = card.afterItemID else { trailingDecisions.append(card); continue }
            anchoredDecisions[anchor, default: []].append(card)
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
            for card in anchoredDecisions.removeValue(forKey: item.id) ?? [] {
                rows.append(.decisionCard(card))
            }
        }
        // An anchor no longer in the window (its item was dropped — e.g. an optimistic bubble whose
        // send failed) would otherwise take the card down with it. Trail those instead of losing them.
        for card in statusCards where card.afterItemID.map({ anchored[$0] != nil }) == true {
            rows.append(.statusCard(card))
        }
        // Same for a question whose anchor has been paged out of the window: it is still waiting on
        // somebody, so it is shown at the tail rather than dropped with the item it arrived after.
        for card in decisionCards where card.afterItemID.map({ anchoredDecisions[$0] != nil }) == true {
            trailingDecisions.append(card)
        }
        rows.append(contentsOf: trailingDecisions.map(TranscriptRow.decisionCard))

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
