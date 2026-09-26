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

    /// A failed commit, said the way the person who pressed Commit needs it (mirrors web's
    /// `commitFailureCopy`): what happened, why — the runner's own sentence when it gave one, which it
    /// sends as `commitResultMessage` on an error — and git's words for whoever is debugging. A lock
    /// problem is named as one: git's refusal names index.lock whatever language it speaks, which is
    /// how the runner itself tells.
    public struct CommitFailure: Equatable {
        public let headline: String
        public let why: String
        /// git's words, for "Show git output"; nil when they would only repeat `why`.
        public let gitOutput: String?
    }

    public static func commitFailure(commitStatus: String?, commitError: String?,
                                     commitResultMessage: String?) -> CommitFailure? {
        guard commitStatus == "error" else { return nil }
        let raw = trimmed(commitError) ?? ""
        let lockBusy = raw.contains("index.lock")
        let firstLine = raw.split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty }
        let why = trimmed(commitResultMessage)
            ?? (lockBusy ? "Another git process holds this worktree's index lock. Retry once it finishes, or hand it to the session." : nil)
            ?? firstLine
            ?? "Commit failed — try again."
        return CommitFailure(
            headline: lockBusy ? "Couldn't commit — git is busy in this worktree" : "Couldn't commit",
            why: why,
            gitOutput: !raw.isEmpty && raw != why ? raw : nil)
    }

    /// What "Resolve in session" asks the session's agent to do about a failed commit — word for word
    /// what web sends (`resolveCommitPrompt`).
    public static func resolveCommitPrompt(branch: String, why: String) -> String {
        "The Commit button on the worktree bar could not commit this session's work. It said: \"\(why)\"\n\n"
            + "You're in this session's isolated git worktree, checked out on \(branch). Find out what stopped"
            + " the commit and clear it: let a git command that is still running here finish; an index.lock"
            + " that no process has open was left behind by a git that died and is safe to remove. Then commit"
            + " the work on this branch with a message that describes it. Do not push."
    }

    public static func manualMergeCommand(mergeTarget: String?, branch: String) -> String {
        let target = mergeTarget ?? "main"
        return "git rebase \(target) \(branch) && git checkout \(target) && git merge --ff-only \(branch)"
    }

    /// Whether the compact file list is ahead of the lazily stored per-file patches. Heartbeats
    /// update `changedFiles` during a turn, while the full patches normally settle only at a turn
    /// boundary; a live client can close that gap through `POST /diff/refresh`. Binary files never
    /// have a text preview, and a `truncated` patch is already an intentional terminal result.
    public static func shouldRefreshDiff(isLive: Bool, changedFiles: [SessionChangedFile],
                                         patches: [FilePatch]) -> Bool {
        guard isLive else { return false }
        let readyPaths = Set(patches.compactMap { patch -> String? in
            if patch.truncated == true { return patch.path }
            guard let text = patch.patch, !text.isEmpty else { return nil }
            return patch.path
        })
        return changedFiles.contains { file in
            let binary = file.additions < 0 || file.deletions < 0
            return !binary && !readyPaths.contains(file.path)
        }
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
