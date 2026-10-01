import Foundation

public struct MergeRecoveryCommit: Codable, Equatable, Sendable {
    public let sha: String
    public let subject: String
    public let author: String
    public let date: String
}

/// One button of the merge-recovery review sheet.
public struct MergeRecoveryButton: Equatable, Sendable, Identifiable {
    public enum Action: Equatable, Sendable {
        /// Fetch and preview the candidate again (runner `preview`).
        case preview
        /// Push the reviewed candidate (runner `apply`).
        case apply
        /// Bring this machine's checkout up to the target that landed (runner `sync-local`).
        case syncLocal
        /// Start a repair session — to resolve the recovery, or to prepare a PR candidate.
        case repair(preparePR: Bool)
    }
    public let title: String
    public let action: Action
    public var id: String { title }
    public init(title: String, action: Action) {
        self.title = title
        self.action = action
    }
}

/// What the review sheet offers in a state: the step the state asks for (prominent, pinned at the
/// sheet's foot), the other steps pinned under it, and checking again as the header's link
/// whenever checking isn't the step itself.
public struct MergeRecoveryButtons: Equatable, Sendable {
    public let primary: MergeRecoveryButton?
    public let secondary: [MergeRecoveryButton]
    public let headerCheck: MergeRecoveryButton?
    public init(primary: MergeRecoveryButton?, secondary: [MergeRecoveryButton], headerCheck: MergeRecoveryButton?) {
        self.primary = primary
        self.secondary = secondary
        self.headerCheck = headerCheck
    }
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

    /// The review sheet's buttons — the same steps, titles and gates the inline card had (and web's
    /// `MergeRecoveryPanel` has), arranged around the one the state asks for. An older runner can't
    /// recover, so it gets none.
    public func buttons(supported: Bool) -> MergeRecoveryButtons {
        guard supported else { return MergeRecoveryButtons(primary: nil, secondary: [], headerCheck: nil) }
        if code == "LOCAL_SYNC_PENDING" {
            return MergeRecoveryButtons(primary: MergeRecoveryButton(title: "Sync local checkout", action: .syncLocal),
                                        secondary: [], headerCheck: nil)
        }
        let check = MergeRecoveryButton(title: previewId == nil ? "Check and repair" : "Check again", action: .preview)
        let resolve = MergeRecoveryButton(title: "Resolve in repair session", action: .repair(preparePR: false))
        let preparePR = MergeRecoveryButton(title: "Prepare PR candidate", action: .repair(preparePR: true))
        let repairs = repairWorktree == nil ? [] : ready ? [preparePR] : [resolve, preparePR]
        if ready {
            return MergeRecoveryButtons(primary: MergeRecoveryButton(title: "Sync \(targetBranch) and merge", action: .apply),
                                        secondary: repairs, headerCheck: check)
        }
        if ["PUSH_FAILED", "REMOTE_NOT_VERIFIED"].contains(code) {
            return MergeRecoveryButtons(
                primary: MergeRecoveryButton(title: "Check result / retry reviewed candidate", action: .apply),
                secondary: repairs, headerCheck: check)
        }
        if code == "CONFLICT", repairWorktree != nil {
            return MergeRecoveryButtons(primary: resolve, secondary: [preparePR], headerCheck: check)
        }
        return MergeRecoveryButtons(primary: check, secondary: repairs, headerCheck: nil)
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
