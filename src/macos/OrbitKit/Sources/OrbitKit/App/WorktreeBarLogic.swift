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
    /// branch and at least one changed file → the full bar. Pending/failed commit and merge states
    /// also keep the bar visible so their outcome text has somewhere to land even if the runner
    /// reports an empty diff.
    public static func mode(isolationStatus: String?, branch: String?, changedFileCount: Int,
                            mergeStatus: String? = nil, commitStatus: String? = nil) -> Mode {
        guard let iso = isolationStatus else { return .hidden }
        if iso == "shared-nogit" { return .notIsolated }
        guard iso == "worktree", branch != nil else { return .hidden }
        let actionableStatus =
            mergeStatus == "pending" || mergeStatus == "conflict" || mergeStatus == "error" ||
            commitStatus == "pending" || commitStatus == "error"
        return changedFileCount > 0 || actionableStatus ? .worktree : .hidden
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

    /// Whether a failed merge can be resolved in-session: true for a real *conflict*, whatever the
    /// target — the merge aborted cleanly and moved neither tip, so retrying it replays the same
    /// rebase and conflicts identically; only the agent rebasing onto the target can clear it. An
    /// `error` is a precondition failure a rebase can't fix, so the bar keeps a plain "Retry merge"
    /// for it (the user clears the precondition, then retries).
    public static func resolvable(mergeStatus: String?) -> Bool {
        mergeStatus == "conflict"
    }

    /// The branch a conflicted merge was rebasing onto, for the resolve prompt: the recorded
    /// target, else the default the runner would have auto-detected.
    public static func conflictTarget(mergeTarget: String?, targets: [String],
                                      agentDefaultTarget: String?) -> String {
        mergeTarget ?? defaultTarget(targets: targets, agentDefaultTarget: agentDefaultTarget) ?? "main"
    }

    /// User-facing reason for the failed commit/merge state. The runner keeps raw git output in
    /// `mergeError` for conflicts and precondition failures; trim it but do not discard it, because
    /// native clients do not have web's hover-only tooltip as a fallback on iOS.
    public static func failureMessage(mergeStatus: String?, mergeError: String?,
                                      commitStatus: String?, commitError: String?) -> String? {
        if commitStatus == "error" {
            return trimmed(commitError) ?? "Commit failed — try again."
        }
        if mergeStatus == "conflict" {
            guard let err = trimmed(mergeError) else {
                return "Merge conflict — aborted, working tree left clean."
            }
            return "Merge conflict — aborted, working tree left clean.\n\(err)"
        }
        if mergeStatus == "error" {
            return trimmed(mergeError) ?? "Merge failed — try again."
        }
        return nil
    }

    public static func manualMergeCommand(mergeTarget: String?, branch: String) -> String {
        let target = mergeTarget ?? "main"
        return "git rebase \(target) \(branch) && git checkout \(target) && git merge --ff-only \(branch)"
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

    private static func trimmed(_ value: String?) -> String? {
        let text = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return text.isEmpty ? nil : text
    }
}
