import Foundation

public struct MergeRecoveryCommit: Codable, Equatable, Sendable {
    public let sha: String
    public let subject: String
    public let author: String
    public let date: String
}

public struct MergeRecovery: Codable, Equatable, Sendable {
    public struct Check: Codable, Equatable, Sendable {
        public let status: String
        public let output: String?
        public let command: String?
        public let timeoutSeconds: Int?
    }
    public let code: String
    public let targetBranch: String
    public let repoRoot: String?
    public let previewId: String?
    public let sourceSha: String?
    public let localSha: String?
    public let remoteSha: String?
    public let candidateSha: String?
    public let candidateTreeSha: String?
    public let rebaseBaseSha: String?
    public let repairBranch: String?
    public let repairWorktree: String?
    public let phase: String?
    public let conflicts: [String]?
    public let localCommits: [MergeRecoveryCommit]?
    public let remoteCommits: [MergeRecoveryCommit]?
    public let patch: String?
    public let addsMergeCommit: Bool?
    public let checkedAt: String?
    public let check: Check?

    public var ready: Bool {
        let shas = [sourceSha, localSha, remoteSha, candidateSha, candidateTreeSha].compactMap { $0 }
        return code == "READY" && !(previewId ?? "").isEmpty && patch != nil && ["passed", "unconfigured"].contains(check?.status ?? "")
            && shas.count == 5 && shas.allSatisfy {
                $0.count == 40 && $0.unicodeScalars.allSatisfy { CharacterSet(charactersIn: "0123456789abcdef").contains($0) }
            }
    }

    public var title: String {
        if code == "LOCAL_SYNC_PENDING" { return "Merged into origin/\(targetBranch); local sync pending" }
        if ready { return "Review synchronization into \(targetBranch)" }
        if code == "CONFLICT" {
            return phase == "TARGET_SYNC" ? "\(targetBranch) synchronization has conflicts"
                : "Your changes conflict with the synchronized target"
        }
        if code == "PREVIEW_CHANGED" { return "Branches changed — check again" }
        if code == "FETCH_FAILED" { return "Could not check the remote" }
        if ["PUSH_FAILED", "REMOTE_NOT_VERIFIED"].contains(code) { return "Could not confirm the target push" }
        return "\(targetBranch) needs synchronization"
    }

    public func repairPrompt(preparePR: Bool) -> String {
        "\(preparePR ? "Prepare a reviewable PR candidate" : "Resolve this merge recovery") for \(targetBranch).\n\n" +
        "Repository: \(repoRoot ?? "see workspace configuration")\n" +
        "Repair branch: \(repairBranch ?? "create a separate branch")\n" +
        "Repair worktree: \(repairWorktree ?? "use a separate worktree")\n" +
        "Frozen source: \(sourceSha ?? "unknown")\nLocal target: \(localSha ?? "unknown")\n" +
        "Remote target: \(remoteSha ?? "unknown")\nPhase: \(phase ?? code)\n" +
        "Conflicting files: \((conflicts ?? []).joined(separator: ", "))\n\n" +
        "Work only in the separate repair worktree. " +
        (preparePR ? "Preserve both sides’ content; organize commits on a separate PR candidate according to repository policy. Preserve the original source branch. "
         : "Preserve both target histories and the original source branch. ") +
        "Finish the pending merge/rebase there, resolving every conflict, and run the repository checks. " +
        "Do not reset or rebase the shared target checkout. Do not push the target. " +
        (preparePR ? "Respect linear history and branch protection; prepare a candidate branch and complete diff for review. Do not claim it is merged. " : "") +
        "Report the repair branch and checks when finished. The owner will check again and review the complete diff before any target push."
    }
}
