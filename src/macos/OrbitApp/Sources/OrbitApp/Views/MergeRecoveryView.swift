import SwiftUI
import OrbitKit

/// The same reviewed candidate and recovery actions as the web worktree bar.
struct MergeRecoveryView: View {
    @Environment(AppModel.self) private var app
    let console: ConsoleModel
    let recovery: MergeRecovery
    let message: String?
    let supported: Bool
    let busy: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(recovery.title).font(.orbitLabel.weight(.semibold))
            if let checkedAt = recovery.checkedAt { Text("Checked at \(checkedAt)").foregroundStyle(.secondary) }
            if recovery.code == "TARGET_DIVERGED" {
                Text("Local \(recovery.targetBranch) and origin/\(recovery.targetBranch) each have unique commits.")
            }
            if recovery.code == "TARGET_AHEAD" {
                Text("Local \(recovery.targetBranch) has extra commits that are not on origin/\(recovery.targetBranch). Review them before continuing this merge.")
            }
            if let message, !recovery.ready {
                DisclosureGroup("Details") { Text(message).textSelection(.enabled) }
            }
            if let commits = recovery.localCommits {
                DisclosureGroup("Local-only commits (\(commits.count)) — included in the push") {
                    commitsView(commits)
                }
            }
            if let commits = recovery.remoteCommits {
                DisclosureGroup("Remote-only commits (\(commits.count))") { commitsView(commits) }
            }
            if let conflicts = recovery.conflicts, !conflicts.isEmpty {
                Text(conflicts.joined(separator: "\n")).textSelection(.enabled)
            }
            if let patch = recovery.patch, recovery.candidateSha != nil {
                DisclosureGroup("Complete candidate diff against origin/\(recovery.targetBranch)") {
                    ScrollView([.horizontal, .vertical]) {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(patch.components(separatedBy: "\n").enumerated()), id: \.offset) { line in
                                Text(verbatim: line.element).font(.orbitDiffLine)
                            }
                        }
                    }.frame(maxHeight: 300)
                }
            }
            if let check = recovery.check {
                Text(check.status == "unconfigured" ? "Git preview only; no merge check is configured."
                     : check.status == "passed" ? "Configured merge check passed." : "Configured merge check failed.")
                if let output = check.output, !output.isEmpty {
                    DisclosureGroup("Check output") { Text(output).textSelection(.enabled) }
                }
            }
            if recovery.ready {
                Text("Preserves both target histories.\(recovery.addsMergeCommit == true ? " Adds one merge commit." : "") The local-only commits above will be pushed with this session’s changes. For linear history or required PRs, prepare a PR candidate instead.")
            }
            if recovery.code == "LOCAL_SYNC_PENDING" {
                Text("The remote contains the reviewed candidate. Save blocking local edits before syncing; this action only updates this machine.")
            }
            if let branch = recovery.repairBranch {
                DisclosureGroup("Saved repair branch and location") {
                    Text(branch).textSelection(.enabled)
                    if let path = recovery.repairWorktree { Text(path).textSelection(.enabled) }
                }
            }
            if supported {
                if recovery.code == "LOCAL_SYNC_PENDING" {
                    action("Sync local checkout", "sync-local")
                } else {
                    action(recovery.previewId == nil ? "Check and repair" : "Check again", "preview")
                    if recovery.ready { action("Sync \(recovery.targetBranch) and merge", "apply") }
                    if ["PUSH_FAILED", "REMOTE_NOT_VERIFIED"].contains(recovery.code) {
                        action("Check result / retry reviewed candidate", "apply")
                    }
                    if recovery.repairWorktree != nil {
                        if !recovery.ready { repairButton("Resolve in repair session", preparePR: false) }
                        repairButton("Prepare PR candidate", preparePR: true)
                    }
                }
            } else { Text("Update the runner to use target synchronization recovery.") }
        }
        .font(.orbitLabel)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
    }

    private func commitsView(_ commits: [MergeRecoveryCommit]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(commits, id: \.sha) { commit in
                Text(commit.subject)
                Text("\(commit.author) · \(commit.date) · \(commit.sha.prefix(8))").foregroundStyle(.secondary)
            }
        }
    }

    private func action(_ title: String, _ action: String) -> some View {
        Button(title) {
            Task { await console.worktree.recoverMerge(action: action, previewID: recovery.previewId) }
        }.disabled(busy)
    }

    private func repairButton(_ title: String, preparePR: Bool) -> some View {
        Button(title) {
            Task {
                if let id = await console.worktree.repairRecovery(preparePR: preparePR) {
                    app.openProjectCoordinator(sessionID: id, agentID: console.worktree.detail?.workspace?.id)
                }
            }
        }.disabled(busy)
    }
}
