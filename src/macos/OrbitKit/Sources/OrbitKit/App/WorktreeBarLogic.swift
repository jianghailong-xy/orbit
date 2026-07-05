import Foundation

/// Pure decision logic for the worktree status bar, factored out of the SwiftUI `WorktreeBar` so it
/// can be unit-tested on Linux. It mirrors the branching in web's `SessionOutputs`: the view feeds
/// in the session's git state (`SessionDetail`) plus its lifecycle (committed / turn-active) and
/// renders whatever these return — no decisions live in the view.
public enum WorktreeBarLogic {

    /// What the bar shows at the top level.
    public enum Mode: Equatable {
        /// Nothing isolated, or an isolated worktree with no changes yet → the bar is hidden.
        case hidden
        /// Ran in the shared workDir (no git) → the amber "enable isolation" nudge.
        case notIsolated
        /// A real worktree with changes → the branch + diff + Commit/Merge actions.
        case worktree
    }

    /// Mirrors web: no `isolationStatus` → hidden; `shared-nogit` → the nudge; a `worktree` with a
    /// branch and at least one changed file → the full bar; anything else → hidden.
    public static func mode(isolationStatus: String?, branch: String?, changedFileCount: Int) -> Mode {
        guard let iso = isolationStatus else { return .hidden }
        if iso == "shared-nogit" { return .notIsolated }
        guard iso == "worktree", branch != nil, changedFileCount > 0 else { return .hidden }
        return .worktree
    }

    /// The primary action offered on the bar.
    public enum Primary: Equatable { case none, commit, merge }

    /// Git-state-driven primary action (mirrors web). When the runner reports `worktreeDirty`, a
    /// dirty tree on a *live* session shows Commit and a clean one shows Merge; an older runner
    /// (`worktreeDirty == nil`) falls back to the session lifecycle (`committed`). Merge is held
    /// while a turn is in flight — a clean mid-turn tree is a transient checkpoint, not finished work.
    public static func primary(worktreeDirty: Bool?, committed: Bool, turnActive: Bool) -> Primary {
        let dirtyKnown = worktreeDirty != nil
        let showCommit = dirtyKnown && worktreeDirty == true && !committed
        let mergeReady = dirtyKnown ? !showCommit : committed
        if showCommit { return .commit }
        if mergeReady && !turnActive { return .merge }
        return .none
    }

    /// The left-segment default merge target: the agent's remembered target if it's still on offer,
    /// else main, else master, else the first reported branch; nil = no reported targets, so let the
    /// runner auto-detect (the older-runner path).
    public static func defaultTarget(targets: [String], agentDefaultTarget: String?) -> String? {
        if let a = agentDefaultTarget, targets.contains(a) { return a }
        if targets.contains("main") { return "main" }
        if targets.contains("master") { return "master" }
        return targets.first
    }

    /// Whether a failed merge can be resolved in-session: true only for a real *conflict* whose
    /// target is main/master (the agent can rebase onto it and fix it). An `error` (a precondition
    /// failure a rebase can't fix) or a conflict on some other target is not resolvable — the bar
    /// offers a plain "Retry merge" instead.
    public static func resolvable(mergeStatus: String?, mergeTarget: String?) -> Bool {
        mergeStatus == "conflict" && (mergeTarget == nil || mergeTarget == "main" || mergeTarget == "master")
    }

    /// Split an auto-generated `orbit/<slug>-<hash>` branch into its (prefix, slug, hash) parts so the
    /// view can dim the `orbit/` prefix and the `-<hash>` suffix and foreground the slug — matching
    /// web's `BranchLabel` (regex `^(orbit/)(.+)(-[0-9a-f]{6})$`). Returns nil for any other shape,
    /// which the view renders verbatim.
    public static func branchParts(_ branch: String) -> (prefix: String, slug: String, hash: String)? {
        let prefix = "orbit/"
        guard branch.hasPrefix(prefix) else { return nil }
        let rest = branch.dropFirst(prefix.count)
        // Need at least one slug char + "-" + six hex digits.
        guard rest.count >= 8 else { return nil }
        let hash = String(rest.suffix(7))            // "-abcdef"
        guard hash.first == "-" else { return nil }
        let hex = hash.dropFirst()
        guard hex.count == 6, hex.allSatisfy({ "0123456789abcdef".contains($0) }) else { return nil }
        let slug = String(rest.dropLast(7))
        guard !slug.isEmpty else { return nil }
        return (prefix, slug, hash)
    }
}
