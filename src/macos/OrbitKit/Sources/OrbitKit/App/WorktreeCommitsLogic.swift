import Foundation

/// The worktree bar counted in commits (board docs/mocks/session-commits-first/02-native; web
/// `SessionCommits.tsx`): what the bar says, which tab the sheet opens on, and what a commit row and
/// a commit's screen say. The views only render these.
public extension WorktreeBarLogic {
    /// The runner lists at most this many (runner branch_commits.go `branchCommitsMax`).
    static let commitsMax = 100

    /// "1 commit", "3 commits", "100+ commits".
    static func commitCountLabel(_ n: Int) -> String {
        if n >= commitsMax { return "\(commitsMax)+ commits" }
        return n == 1 ? "1 commit" : "\(n) commits"
    }

    /// What a runner-made commit is labelled, so it never reads as the agent's intent; nil for the
    /// agent's own commit. Web parity: `savedByLabel`.
    static func savedByLabel(_ savedBy: String?) -> String? {
        switch savedBy {
        case nil, "": return nil
        case "commit-button": return "Saved with Commit"
        default: return "Auto-saved by Orbit"
        }
    }

    enum DiffTab: String, Hashable, Sendable { case commits, allChanges }

    /// Which tab the sheet opens on from the bar, or nil when it has no tabs: a runner too old to report
    /// commits, or a branch with none yet, keeps today's file list.
    static func openingTab(commits: [BranchCommit]?) -> DiffTab? {
        guard let commits, !commits.isEmpty else { return nil }
        return .commits
    }

    /// A commit's line counts, a binary file adding none.
    static func commitStat(_ commit: BranchCommit) -> (add: Int, del: Int) {
        commit.files.reduce(into: (add: 0, del: 0)) { sum, f in
            sum.add += max(0, f.additions)
            sum.del += max(0, f.deletions)
        }
    }

    /// Whether a commit's file diffs can hold more than that commit: patches are per branch, so a file
    /// another commit also changes, or any file while the worktree holds uncommitted work, shows the
    /// file's whole change on the branch. The commit screen says so when this is true.
    static func commitDiffsShowMore(_ commit: BranchCommit, among commits: [BranchCommit], worktreeDirty: Bool) -> Bool {
        if worktreeDirty { return true }
        let mine = Set(commit.files.map(\.path))
        return commits.contains { other in other.sha != commit.sha && other.files.contains { mine.contains($0.path) } }
    }

    /// The commit screen's note when `commitDiffsShowMore` holds.
    static let commitDiffsShowMoreNote =
        "Some of these files change elsewhere on the branch too: their diffs show each file's whole change."

    /// "a41c9e2".
    static func shortSha(_ sha: String) -> String { String(sha.prefix(7)) }

    /// "main @ e9f1c07", what the commit list is based on; nil without a base.
    static func basedOn(mergeTarget: String?, baseSha: String?) -> String? {
        guard let baseSha, !baseSha.isEmpty else { return nil }
        let target = (mergeTarget?.isEmpty == false ? mergeTarget : nil) ?? "main"
        return "\(target) @ \(shortSha(baseSha))"
    }
}
