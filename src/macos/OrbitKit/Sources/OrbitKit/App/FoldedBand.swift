import Foundation

/// What a phone's composer band says once it has folded to its one-line bar, while the reader goes
/// back through the history (`TailPinning.foldsBand`; the owner, 2026-10-16): the draft, or the
/// composer's placeholder, then one mark for each of the session's cards it folded — each card's own
/// line cut to its count.
public enum FoldedBand {
    /// The composer's placeholder, read where nothing is drafted.
    public static let placeholder = "Message…"
    /// The merge slot's word while a merge runs (`WorktreeMergeControl`).
    public static let merging = "Merging…"

    /// The draft as the bar shows it: its first line with words on it, or nil for an empty box.
    public static func draftLine(_ text: String) -> String? {
        for line in text.split(whereSeparator: \.isNewline) {
            let words = line.trimmingCharacters(in: .whitespaces)
            if !words.isEmpty { return words }
        }
        return nil
    }

    /// The Background processes tray: what still runs, or, once nothing does, how many there are.
    public static func processes(_ procs: [BackgroundProc]) -> String {
        let running = procs.filter { $0.status == "running" }.count
        return running > 0 ? "\(running) running" : "\(procs.count)"
    }

    /// The Tasks card's sentence cut to one part: what failed, the one part drawn red, or else how
    /// many of them are done.
    public static func tasks(_ card: SessionTaskCard) -> SessionCreatedTasksCopy.CountPart {
        card.failed > 0
            ? SessionCreatedTasksCopy.CountPart(text: "\(card.failed) failed", failed: true)
            : SessionCreatedTasksCopy.CountPart(text: "\(card.done)/\(card.total)", failed: false)
    }

    /// The branch bar cut to one mark.
    public enum Branch: Equatable, Sendable {
        /// Where the work landed, in the merge slot's own words: "✓ Merged", "✓ In main".
        case landed(String)
        /// A merge under way.
        case merging
        /// The size of the change, while it has not landed.
        case changes(added: Int, deleted: Int)
    }

    /// The branch bar's merge slot (`WorktreeMergeControl`), for the states it marks with a chip and
    /// its Merging…; anything else is the change itself. A worktree on a branch Orbit is not tracking
    /// and a merge held for target recovery come first there, and neither is a landing. Nil when there
    /// is nothing to count.
    public static func branch(mergeStatus: String?, branchMerged: Bool?, mergeTarget: String?,
                              targets: [String], diverged: Bool, recovering: Bool,
                              added: Int, deleted: Int) -> Branch? {
        if !diverged && !recovering {
            if mergeStatus == "merged" {
                let elsewhere = mergeTarget != nil && mergeTarget != "main" && mergeTarget != "master"
                return .landed("✓ Merged" + (elsewhere ? " → \(mergeTarget!)" : ""))
            }
            if branchMerged == true && mergeStatus == nil {
                let landed = mergeTarget
                    ?? (targets.contains("main") ? "main" : targets.contains("master") ? "master" : "main")
                return .landed("✓ In \(landed)")
            }
            if mergeStatus == "pending" { return .merging }
        }
        return added + deleted > 0 ? .changes(added: added, deleted: deleted) : nil
    }
}
