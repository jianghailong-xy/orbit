import Foundation

// One row of the Open list changing in place — what a `session.updated` / `approval.*` event does —
// without re-deriving everything from the whole list. Several sessions running means several such
// events a second, each of which used to rebuild every derived surface from the full list on the
// main thread. Pure, so that "the same as a full snapshot would have given" is a unit test
// (`OpenListRowUpdateTests`) rather than a hope. See `AppModel.applySessionRow`.

/// What a control event does to the Open list.
public enum OpenRowChange: Equatable, Sendable {
    /// Nothing the row shows changed.
    case unchanged
    /// The row at `index` becomes `row`; every other row and the order stay as they are.
    case replace(index: Int, row: Session)
    /// Only the list query can answer it — see `OpenRowChange.merging(_:into:)`.
    case needsSnapshot

    /// Fold a `session.created` / `session.updated` summary into the Open list. `needsSnapshot` when:
    ///   • the session left Open — the row has to disappear, which membership alone decides;
    ///   • the row isn't loaded — a session created elsewhere can't be built from the slim summary
    ///     (no preview line, tags, runner or background count), and prepending a half-populated row
    ///     would render worse than the ~½s wait for the real snapshot;
    ///   • the run just reached a terminal status — whether that is an outcome or a failure the
    ///     server is about to retry is decided by `retryAt`, which the summary doesn't carry, so
    ///     folding the status in alone would announce a failure that undoes itself a minute later.
    ///     Once per session ended, against a per-turn event: the refetch costs nothing here.
    public static func merging(_ summary: ControlSessionSummary, into sessions: [Session]) -> OpenRowChange {
        if let lifecycle = summary.effectiveLifecycleState, lifecycle != .open { return .needsSnapshot }
        if summary.effectiveRunStatus.isTerminal { return .needsSnapshot }
        guard let index = sessions.firstIndex(where: { $0.id == summary.id }) else { return .needsSnapshot }
        return change(at: index, to: sessions[index].applying(summary), in: sessions)
    }

    /// An `approval.requested` / `approval.resolved` count (and the kind that comes with it).
    public static func settingPendingApprovals(sessionID: String, pending: Int,
                                               waitingKind: SessionWaitingKind?,
                                               in sessions: [Session]) -> OpenRowChange {
        guard let index = sessions.firstIndex(where: { $0.id == sessionID }) else { return .needsSnapshot }
        guard sessions[index].pendingApprovals != pending
                || sessions[index].waitingKind != waitingKind else { return .unchanged }
        return .replace(index: index,
                        row: sessions[index].settingPendingApprovals(pending, waitingKind: waitingKind))
    }

    /// A polled `list` that holds the same sessions as `sessions` and differs from it only in the
    /// rows named by `ids` and, perhaps, in their order: the rows to replace where `sessions` has
    /// them (`index` is theirs), in `list`'s order, and whether the order moved. nil when it cannot
    /// be told that way — a session added or gone, or one of `ids` not in the list — and the list
    /// is adopted whole. Rows that already read the same are left out.
    public static func replacements(of ids: Set<String>, in list: [Session], over sessions: [Session])
        -> (changes: [(index: Int, row: Session)], reordered: Bool)? {
        guard list.count == sessions.count else { return nil }
        let reordered = zip(list, sessions).contains { $0.id != $1.id }
        var position: [String: Int] = [:]
        if reordered {
            position.reserveCapacity(sessions.count)
            for (index, row) in sessions.enumerated() {
                if position.updateValue(index, forKey: row.id) != nil { return nil }
            }
            // Same count, unique ids, each found once: the same sessions.
            var seen = Set<String>(minimumCapacity: list.count)
            for row in list {
                guard position[row.id] != nil, seen.insert(row.id).inserted else { return nil }
            }
        }
        var changes: [(index: Int, row: Session)] = []
        var found = 0
        for (index, row) in list.enumerated() where ids.contains(row.id) {
            found += 1
            let held = reordered ? position[row.id]! : index
            if sessions[held] != row { changes.append((held, row)) }
        }
        guard found == ids.count else { return nil }
        return (changes: changes, reordered: reordered)
    }

    private static func change(at index: Int, to row: Session, in sessions: [Session]) -> OpenRowChange {
        row == sessions[index] ? .unchanged : .replace(index: index, row: row)
    }
}

/// Everything the drawer, the banner, the menu bar and the badge derive from the Open list, kept
/// up to date one row at a time. `init(_:)` is the full derivation a fetched snapshot runs; a row
/// event calls `replace(_:with:in:)`, which reaches for the whole list only when the row moved into
/// or out of something — a bucket, a workspace's spinner — and otherwise touches that row alone.
public struct OpenListDerived: Equatable, Sendable {
    /// `SessionGrouping.group(list).needsYou`.
    public private(set) var needsYou: [Session]
    /// `NeedsYouLogic.byAgent(list)`.
    public private(set) var agentNeedsYou: [String: Int]
    /// `MenuBar.summary(from: list)` — its `badge` is the Dock / app-icon badge.
    public private(set) var menu: MenuBarSummary
    /// The workspace-activity marks and the coordinator pulses, which only the iOS navigation
    /// draws: nil leaves them out of both derivations.
    public private(set) var activity: Activity?

    public struct Activity: Equatable, Sendable {
        /// `WorkspaceActivityLogic.runningWorkspaceIDs(list)`.
        public var runningWorkspaceIDs: Set<String>
        /// `WorkspaceActivityLogic.jobWorkspaceIDs(list)`.
        public var jobWorkspaceIDs: Set<String>
        /// `ProjectAttention.coordinatorPulses(list)`.
        public var coordinatorPulses: [String: ProjectCoordinatorPulse]

        public init(runningWorkspaceIDs: Set<String>, jobWorkspaceIDs: Set<String>,
                    coordinatorPulses: [String: ProjectCoordinatorPulse]) {
            self.runningWorkspaceIDs = runningWorkspaceIDs
            self.jobWorkspaceIDs = jobWorkspaceIDs
            self.coordinatorPulses = coordinatorPulses
        }

        public init(_ list: [Session]) {
            self.init(runningWorkspaceIDs: WorkspaceActivityLogic.runningWorkspaceIDs(list),
                      jobWorkspaceIDs: WorkspaceActivityLogic.jobWorkspaceIDs(list),
                      coordinatorPulses: ProjectAttention.coordinatorPulses(list))
        }
    }

    /// The full derivation, from the whole list.
    public init(_ list: [Session], tracksActivity: Bool = true) {
        self.init(needsYou: SessionGrouping.group(list).needsYou,
                  agentNeedsYou: NeedsYouLogic.byAgent(list),
                  menu: MenuBar.summary(from: list),
                  activity: tracksActivity ? Activity(list) : nil)
    }

    /// Values already derived from the list in hand, to carry on from.
    public init(needsYou: [Session], agentNeedsYou: [String: Int], menu: MenuBarSummary,
                activity: Activity?) {
        self.needsYou = needsYou
        self.agentNeedsYou = agentNeedsYou
        self.menu = menu
        self.activity = activity
    }

    /// `list` holds the same rows as the list these values were derived from, in another order.
    /// Only the needs-you rows and the menu's items are read in list order; the counts, the
    /// per-workspace numbers and marks, and the pulses are the same in any order.
    public mutating func reorder(_ list: [Session]) {
        let groups = SessionGrouping.group(list)
        needsYou = groups.needsYou
        menu = MenuBar.summary(groups)
    }

    /// `old` was replaced by `new` (the same session) in place; `list` is the list after it.
    /// Leaves every value exactly as `init(list)` would derive it.
    public mutating func replace(_ old: Session, with new: Session, in list: [Session]) {
        let bucket = SessionGrouping.bucket(new)
        if SessionGrouping.bucket(old) != bucket {
            // Membership moved: the counts, the badge and which rows the menu lists all can.
            needsYou = SessionGrouping.group(list).needsYou
            menu = MenuBar.summary(from: list)
        } else if bucket != nil {
            // Same bucket, same position: only this row's own copy differs.
            if bucket == .needsYou, let i = needsYou.firstIndex(where: { $0.id == new.id }) {
                needsYou[i] = new
            }
            menu = MenuBar.replacing(new, in: menu)
        }

        let oldAgent = old.agent?.id ?? old.agentId, newAgent = new.agent?.id ?? new.agentId
        let oldCounted = NeedsYouLogic.isCounted(old), newCounted = NeedsYouLogic.isCounted(new)
        if oldCounted != newCounted || oldAgent != newAgent {
            if oldCounted, let id = oldAgent {
                let left = (agentNeedsYou[id] ?? 0) - 1
                agentNeedsYou[id] = left > 0 ? left : nil
            }
            if newCounted, let id = newAgent { agentNeedsYou[id, default: 0] += 1 }
        }

        guard var marks = activity else { return }
        // Another row in the same workspace can hold the mark up, so a change is re-read from the
        // list — only when this row's own half of it moved, which is a run starting or stopping.
        if oldAgent != newAgent
            || WorkspaceActivityLogic.isRunning(old) != WorkspaceActivityLogic.isRunning(new) {
            marks.runningWorkspaceIDs = WorkspaceActivityLogic.runningWorkspaceIDs(list)
        }
        if oldAgent != newAgent
            || WorkspaceActivityLogic.isRunningJob(old) != WorkspaceActivityLogic.isRunningJob(new) {
            marks.jobWorkspaceIDs = WorkspaceActivityLogic.jobWorkspaceIDs(list)
        }
        // Only a project's coordinator conversation carries a pulse; the rest of the list is none.
        if old.projectId != nil || new.projectId != nil {
            marks.coordinatorPulses = ProjectAttention.coordinatorPulses(list)
        }
        activity = marks
    }
}
