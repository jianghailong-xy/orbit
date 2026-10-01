import SwiftUI
import OrbitKit
#if os(iOS)
import UIKit
#endif

/// The branch bar's second row while a merge waits on target recovery: what holds it — the
/// recovery's own title — on one line, opening the review sheet. Amber like the bar's "not isolated"
/// nudge: the merge is on hold until the owner acts. A spinner stands in for the mark while the
/// runner works on it.
struct MergeRecoveryRow: View {
    let recovery: MergeRecovery
    let working: Bool
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 8) {
                Group {
                    if working {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    }
                }
                .font(.orbitMeta)
                .frame(width: 16)
                Text(recovery.title)
                    .font(.orbitLabel.weight(.semibold))
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 4)
                Image(systemName: "chevron.right")
                    .font(.orbitMeta.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 10)
            .frame(minHeight: 30)
            .background(Color.orange.opacity(0.09))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Opens the merge review")
    }
}

/// A merge held for target recovery, reviewed in a full-height system sheet — the owner's pick of
/// three (2026-10-01): no half height, so it reads the same on iOS 17/18 and 26, with no floating
/// glass. The steps, titles and gates are web's `MergeRecoveryPanel`'s, laid out for a phone: what
/// holds the merge on top, the commits that go out with it, the remote's commits and the complete
/// candidate diff one push deeper, and the step the state asks for pinned at the foot
/// (`MergeRecovery.buttons`), reachable without scrolling. It reads the console live, so a check, a
/// sync or a landing shows up while it's open; once the recovery is gone — merged, or cleared — it
/// closes itself.
struct MergeRecoverySheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let console: ConsoleModel
    /// The step pressed here, so its button — and only its — says Working… while the runner runs it.
    @State private var pressed: MergeRecoveryButton?

    var body: some View {
        NavigationStack {
            Group {
                if let detail = console.worktree.detail, let recovery = detail.mergeRecovery {
                    review(detail, recovery)
                } else {
                    Color.clear
                }
            }
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar { RecoveryCloseButton(close: { dismiss() }) }
        }
        // `detail` is only ever replaced by a fresher one, never cleared, so this fires on the
        // recovery itself going away.
        .onChange(of: console.worktree.detail?.mergeRecovery == nil) { _, gone in
            if gone { dismiss() }
        }
        #if os(macOS)
        .frame(minWidth: 560, minHeight: 520)
        #endif
    }

    private func review(_ d: SessionDetail, _ r: MergeRecovery) -> some View {
        let supported = d.mergeRecoverySupported == true
        // The bar's gate: the session's authoritative run status, the stream's until it loads.
        let turnActive = (app.session(id: console.sessionID)?.effectiveRunStatus ?? console.sessionStatus) == .running
        // Working = the recovery itself is running; a turn in flight only holds the steps back.
        let working = console.worktree.busy || d.mergeStatus == "pending"
        let repairRunning = d.mergeRepairSession?.effectiveRunState == .queued
            || d.mergeRepairSession?.effectiveRunState == .running
        let blocked = working || turnActive || repairRunning
        let buttons = r.buttons(supported: supported)
        let close = { dismiss() }
        let target = r.targetBranch
        return List {
            Section { header(r, check: buttons.headerCheck, working: working, blocked: blocked) }
                .listRowBackground(Color.clear)
            if let repair = d.mergeRepairSession {
                Section { repairStatus(repair, target: r.targetBranch) }
            }
            if let message = d.mergeError, !r.ready {
                Section {
                    NavigationLink("Details") { RecoveryTextPage(title: "Details", text: message, close: close) }
                }
            }
            if let conflicts = r.conflicts, !conflicts.isEmpty {
                Section("Conflicts") {
                    ForEach(conflicts, id: \.self) { Text($0).font(.orbitMono).textSelection(.enabled) }
                }
            }
            if let commits = r.localCommits, !commits.isEmpty {
                Section {
                    ForEach(commits, id: \.sha) { MergeRecoveryCommitRow(commit: $0) }
                } header: {
                    HStack {
                        Text("Local-only commits — included in the push")
                        Spacer(minLength: 8)
                        Text("\(commits.count)")
                    }
                    .textCase(nil)
                }
            }
            let candidate = r.candidateSha != nil ? r.patch : nil
            if r.remoteCommits != nil || candidate != nil {
                Section {
                    if let remote = r.remoteCommits {
                        NavigationLink {
                            RecoveryCommitsPage(title: "Remote-only commits", commits: remote, close: close)
                        } label: {
                            RecoveryLinkRow(title: "Remote-only commits", subtitle: Text("Already on origin/\(target)"),
                                            value: "\(remote.count)")
                        }
                    }
                    if let candidate {
                        let files = UnifiedDiff.files(candidate)
                        NavigationLink {
                            CandidateDiffPage(target: target, patch: candidate, files: files, close: close)
                        } label: {
                            RecoveryLinkRow(title: "Complete candidate diff",
                                            subtitle: Text("Against origin/\(target) · ") + diffStat(files),
                                            value: "\(files.count) \(files.count == 1 ? "file" : "files")")
                        }
                    }
                }
            }
            if r.check != nil || r.repairBranch != nil {
                Section {
                    if let check = r.check { checkRow(check, close: close) }
                    if let branch = r.repairBranch {
                        NavigationLink {
                            RecoveryTextPage(title: "Saved repair branch",
                                             text: [branch, r.repairWorktree].compactMap { $0 }.joined(separator: "\n"),
                                             close: close)
                        } label: {
                            LabeledContent("Saved repair branch") {
                                Text(branch).font(.orbitMono).lineLimit(1).truncationMode(.middle)
                            }
                        }
                    }
                } footer: {
                    if let note = footer(r) { Text(note) }
                }
            }
        }
        #if os(iOS)
        .listStyle(.insetGrouped)
        #endif
        // The step the state asks for, pinned: on a phone the review is longer than a screen, and the
        // owner shouldn't have to scroll through it to act on it.
        .safeAreaInset(edge: .bottom, spacing: 0) {
            actions(buttons, r, supported: supported, working: working, blocked: blocked)
        }
    }

    // MARK: - header

    /// What holds the merge, when it was last checked (with checking again, when that isn't the
    /// pinned step), and the one sentence the state needs.
    private func header(_ r: MergeRecovery, check: MergeRecoveryButton?, working: Bool, blocked: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(r.title).font(.title3.weight(.semibold)).accessibilityAddTraits(.isHeader)
            if working {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Working…")
                }
                .font(.orbitSubtext)
                .foregroundStyle(.secondary)
            } else if r.checkedAt != nil || check != nil {
                HStack(spacing: 4) {
                    if let checkedAt = r.checkedAt {
                        Text("Checked \(RelativeTime.format(checkedAt) ?? checkedAt)")
                        if check != nil { Text("·") }
                    }
                    // Borderless, so only the words are the target — not the whole list row.
                    if let check { Button(check.title) { run(check, r) }.buttonStyle(.borderless).disabled(blocked) }
                }
                .font(.orbitSubtext)
                .foregroundStyle(.secondary)
            }
            if let sentence = lede(r) {
                Text(sentence).font(.orbitSubtext).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }

    private func lede(_ r: MergeRecovery) -> String? {
        let t = r.targetBranch
        if r.ready { return "Preserves both target histories.\(r.addsMergeCommit == true ? " Adds one merge commit." : "")" }
        switch r.code {
        case "TARGET_DIVERGED": return "Local \(t) and origin/\(t) each have unique commits."
        case "TARGET_AHEAD":
            return "Local \(t) has extra commits that are not on origin/\(t). Review them before continuing this merge."
        case "LOCAL_SYNC_PENDING":
            return "The remote contains the reviewed candidate. Save blocking local edits before syncing; this action only updates this machine."
        default: return nil
        }
    }

    @ViewBuilder
    private func repairStatus(_ repair: MergeRepairSession, target: String) -> some View {
        let running = repair.effectiveRunState == .queued || repair.effectiveRunState == .running
        let failed = repair.effectiveRunState == .failed
        Button {
            app.openProjectCoordinator(sessionID: repair.id, agentID: console.worktree.detail?.workspace?.id)
        } label: {
            HStack(spacing: 10) {
                if running {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: failed ? "xmark.circle.fill" : "checkmark.circle.fill")
                        .foregroundStyle(failed ? .red : .green)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(running ? "Repair session running" : failed ? "Repair session failed" : "Repair session completed")
                        .font(.orbitLabel.weight(.semibold))
                    Text(repair.title ?? "Resolve merge recovery for \(target)")
                        .font(.orbitMeta)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    if running {
                        Text("Tap to open the running session")
                            .font(.orbitMeta)
                            .foregroundStyle(.secondary)
                    } else if !failed {
                        Text("Ready to check again")
                            .font(.orbitMeta)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.orbitMeta.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Opens the repair session")
    }

    // MARK: - check

    @ViewBuilder
    private func checkRow(_ check: MergeRecovery.Check, close: @escaping () -> Void) -> some View {
        let row = LabeledContent("Merge check") {
            Text(check.status == "unconfigured" ? "Not configured" : check.status == "passed" ? "Passed" : "Failed")
                .foregroundStyle(check.status == "failed" ? Color.red : Color.secondary)
        }
        if let output = check.output, !output.isEmpty {
            NavigationLink { RecoveryTextPage(title: "Check output", text: output, close: close) } label: { row }
        } else {
            row
        }
    }

    private func footer(_ r: MergeRecovery) -> String? {
        var parts: [String] = []
        if let check = r.check {
            parts.append(check.status == "unconfigured" ? "Git preview only; no merge check is configured."
                         : check.status == "passed" ? "Configured merge check passed." : "Configured merge check failed.")
        }
        if r.ready {
            parts.append("The local-only commits above will be pushed with this session’s changes. For linear history or required PRs, prepare a PR candidate instead.")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    private func diffStat(_ files: [UnifiedDiffFile]) -> Text {
        let add = files.reduce(0) { $0 + max(0, $1.additions) }
        let del = files.reduce(0) { $0 + max(0, $1.deletions) }
        return Text("+\(add)").foregroundStyle(.green) + Text(" −\(del)").foregroundStyle(.red)
    }

    // MARK: - actions

    @ViewBuilder
    private func actions(_ b: MergeRecoveryButtons, _ r: MergeRecovery, supported: Bool, working: Bool,
                         blocked: Bool) -> some View {
        if b.primary != nil || !b.secondary.isEmpty || !supported {
            VStack(spacing: 4) {
                if let primary = b.primary {
                    Button { run(primary, r) } label: {
                        Text(title(primary, working: working)).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                }
                ForEach(b.secondary) { step in
                    Button(title(step, working: working)) { run(step, r) }
                        .buttonStyle(.borderless)
                        .frame(minHeight: 36)
                }
                if !supported {
                    Text("Update the runner to use target synchronization recovery.")
                        .font(.orbitSubtext)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
            }
            .disabled(blocked)
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, 6)
            .frame(maxWidth: .infinity)
            .background(groupedBackground)
            .overlay(alignment: .top) { Divider() }
        }
    }

    private func title(_ step: MergeRecoveryButton, working: Bool) -> String {
        working && pressed == step ? "Working…" : step.title
    }

    private func run(_ step: MergeRecoveryButton, _ r: MergeRecovery) {
        pressed = step
        Task {
            switch step.action {
            case .preview: await console.worktree.recoverMerge(action: "preview", previewID: r.previewId)
            case .apply: await console.worktree.recoverMerge(action: "apply", previewID: r.previewId)
            case .syncLocal: await console.worktree.recoverMerge(action: "sync-local", previewID: r.previewId)
            case .repair(let preparePR):
                guard let id = await console.worktree.repairRecovery(preparePR: preparePR) else { return }
                // The repair runs in its own session: leave the review, then go there.
                dismiss()
                app.openProjectCoordinator(sessionID: id, agentID: console.worktree.detail?.workspace?.id)
            }
        }
    }

    private var groupedBackground: Color {
        #if os(iOS)
        Color(uiColor: .systemGroupedBackground)
        #else
        Color(nsColor: .windowBackgroundColor)
        #endif
    }
}

// MARK: - rows and pages

/// The sheet's ✕, on every page of it: back steps out of a page, this closes the review.
private struct RecoveryCloseButton: ToolbarContent {
    let close: () -> Void
    var body: some ToolbarContent {
        ToolbarItem(placement: .confirmationAction) {
            Button(action: close) { Image(systemName: "xmark") }
                .accessibilityLabel("Close")
        }
    }
}

/// One commit: its subject, then who, when and which.
private struct MergeRecoveryCommitRow: View {
    let commit: MergeRecoveryCommit

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(commit.subject).font(.orbitSubtext).lineLimit(2)
            (Text("\(commit.author) · \(RelativeTime.format(commit.date) ?? commit.date) · ")
                + Text(String(commit.sha.prefix(8))).font(.orbitMonoFine))
                .font(.orbitMeta)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }
}

/// A row that opens a page: what's behind it, a line about it, and how many.
private struct RecoveryLinkRow: View {
    let title: String
    let subtitle: Text
    let value: String

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.orbitSubtext)
                subtitle.font(.orbitMeta).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Text(value).font(.orbitSubtext).foregroundStyle(.secondary)
        }
    }
}

private struct RecoveryCommitsPage: View {
    let title: String
    let commits: [MergeRecoveryCommit]
    let close: () -> Void

    var body: some View {
        List(commits, id: \.sha) { MergeRecoveryCommitRow(commit: $0) }
            .navigationTitle(title)
            .toolbar { RecoveryCloseButton(close: close) }
    }
}

/// The candidate's complete diff against the remote target, by file — the bar's own diff list rows —
/// each opening that file's coloured patch.
private struct CandidateDiffPage: View {
    let target: String
    let patch: String
    let files: [UnifiedDiffFile]
    let close: () -> Void

    var body: some View {
        List {
            if files.isEmpty {
                Text(patch.isEmpty ? "No content changes." : patch)
                    .font(.orbitDiffLine)
                    .textSelection(.enabled)
            } else {
                Section {
                    ForEach(files) { file in
                        NavigationLink {
                            CandidateFilePage(file: file, close: close)
                        } label: {
                            DiffFileRow(file: SessionChangedFile(path: file.path, additions: file.additions,
                                                                 deletions: file.deletions, status: file.status))
                        }
                    }
                } header: {
                    let add = files.reduce(0) { $0 + max(0, $1.additions) }
                    let del = files.reduce(0) { $0 + max(0, $1.deletions) }
                    (Text("Against origin/\(target) · \(files.count) \(files.count == 1 ? "file" : "files") · ")
                        + Text("+\(add)").foregroundStyle(.green) + Text(" −\(del)").foregroundStyle(.red))
                        .textCase(nil)
                }
            }
        }
        .navigationTitle("Candidate diff")
        .toolbar { RecoveryCloseButton(close: close) }
    }
}

private struct CandidateFilePage: View {
    let file: UnifiedDiffFile
    let close: () -> Void

    var body: some View {
        ScrollView {
            if file.additions < 0 || file.deletions < 0 {
                Text("Binary file — no preview")
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.top, 40)
            } else {
                let (attr, trimmed) = DiffFileView.colorize(file.patch)
                VStack(alignment: .leading, spacing: 4) {
                    Text(attr).font(.orbitDiffLine).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if trimmed {
                        Text("(preview trimmed)").font(.orbitMeta).foregroundStyle(.secondary)
                    }
                }
                .padding(12)
            }
        }
        .navigationTitle(file.path)
        .toolbar { RecoveryCloseButton(close: close) }
    }
}

/// Text to read and copy — the runner's details, a check's output, where the repair branch lives.
private struct RecoveryTextPage: View {
    let title: String
    let text: String
    let close: () -> Void

    var body: some View {
        ScrollView {
            Text(text)
                .font(.orbitMono)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
        }
        .navigationTitle(title)
        .toolbar { RecoveryCloseButton(close: close) }
    }
}
