import SwiftUI
import OrbitKit

/// Worktree status bar shown directly above the composer, mirroring web's `SessionOutputs`: the
/// branch this session's work lives on (with the `orbit/…-hash` parts dimmed) + its colored `+/−`
/// diff summary, collapsed to one line and expandable to the changed-file list. A git-state-driven
/// primary action — Commit while the worktree is dirty, Merge once it's clean — sits on the right,
/// reflecting the runner's async outcome (Merging…/✓ Merged/✓ In main/Resolve/Retry). For a session
/// that edits its workspace's folder directly (no worktree) it becomes an amber notice that says why,
/// offers Initialize git… and closes. Hidden entirely when there's nothing to show. All the decisions
/// live in `WorktreeBarLogic`; this view just renders them.
struct WorktreeBar: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    #endif
    let console: ConsoleModel
    /// The bar opens one sheet at a time — the session's diff, or the merge recovery's review — so
    /// they share one `.sheet(item:)` host rather than stacking two `.sheet`s on the container.
    private enum Sheet: String, Identifiable {
        case diff, recovery
        var id: String { rawValue }
    }
    @State private var sheet: Sheet?
    @State private var copied = false
    /// The session whose no-branch notice its ✕ hid (web's `noticeHiddenFor`): there is nothing to
    /// change on the workspace, so closing only hides it here. A session id, not a flag, because a Mac
    /// reuses this bar for whichever session is open.
    @State private var noticeHiddenFor: String?
    @State private var confirmingInitGit = false

    var body: some View {
        // A CONCRETE container (VStack), not `Group`, so the `.sheet` below has a stable host that's
        // always in the tree even while the bar's content is hidden (a `Group` applies its modifiers to
        // its current *child* — `EmptyView` when hidden — so the sheet would ride a transient view). The
        // status poll that fills `worktree.detail` is owned by `ConsoleModel` and driven by the app's
        // focus state (see `startStreaming`), NOT a view `.task` here, so it keeps running even when this
        // pushed detail's lifecycle churns on iPhone and freezes an on-screen `.task`.
        VStack(spacing: 0) {
            // The workspace's main checkout, for Shared and Worktree sessions alike (boards 01⑤, 02④):
            // above this session's own bar, because it is about the checkout every session shares.
            MainCheckoutBarView(console: console)
            sessionBar
        }
        // The main checkout's review sheet, opened from this bar, the card or a result line.
        .sheet(item: Binding(get: { console.mainCheckout.reviewWorkspaceID.map(ReviewTarget.init) },
                             set: { if $0 == nil { console.mainCheckout.reviewWorkspaceID = nil } })) { target in
            MainCheckoutReviewSheet(model: console.mainCheckout, workspaceID: target.id, console: console)
        }
    }

    private struct ReviewTarget: Identifiable { let id: String }

    /// This session's own worktree: the branch, its diff and Commit / Merge, or the no-git notice.
    private var sessionBar: some View {
        VStack(spacing: 0) {
            let d = console.worktree.detail
            let files = d?.changedFiles ?? []
            switch WorktreeBarLogic.mode(isolationStatus: d?.isolationStatus, branch: d?.branch,
                                         changedFileCount: files.count,
                                         mergeStatus: d?.mergeStatus,
                                         commitStatus: d?.commitStatus,
                                         hasMergeRecovery: d?.mergeRecovery != nil,
                                         hasSourceLanding: d?.sourceLanding != nil) {
            case .hidden:
                EmptyView()
            case .notIsolated:
                nudge
            case .worktree:
                if let d, let branch = d.branch { pill(detail: d, branch: branch, files: files) }
            }
        }
        .sheet(item: $sheet) { which in
            switch which {
            case .diff: DiffSheet(console: console)
            case .recovery: MergeRecoverySheet(console: console)
            }
        }
    }

    // MARK: - shared-nogit nudge

    /// The amber notice for a session that edits its workspace's folder directly (web's
    /// `SharedFolderNotice`): why, and what that costs, then the way out — Initialize git… on a folder
    /// that isn't a repository — and ✕. Gone once the workspace has answered it, and from a session
    /// whose ✕ hid it. With no workspace to act on, it only says.
    @ViewBuilder
    private var nudge: some View {
        let workspaceID = console.worktree.detail?.workspace?.id
        let workspace = workspaceID.flatMap { app.agents?.agent($0) }
        if noticeHiddenFor != console.sessionID,
           let notice = WorktreeBarLogic.sharedFolderNotice(workDirIsGit: workspace?.workDirIsGit,
                                                            enableWorktree: workspace?.enableWorktree,
                                                            autoInitGit: workspace?.autoInitGit) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    noticeHeadline(notice.headline(workDir: workspace?.workDir))
                        .font(.orbitLabel.weight(.semibold)).foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                        .layoutPriority(1)
                    Spacer(minLength: 4)
                    // The button and ✕ keep their size (web `flex: none`); the headline wraps instead.
                    if notice == .noBranch {
                        noticeClose(notice) { noticeHiddenFor = console.sessionID }
                    } else if let workspaceID {
                        WTPillButton(title: WorktreeBarLogic.initializeGit, tint: .orange) { confirmingInitGit = true }
                            .fixedSize()
                        noticeClose(notice) { app.setWorktreeIsolation(false, inWorkspace: workspaceID) }
                    }
                }
                Text(notice.detail)
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
            .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.orange.opacity(0.4)))
            .orbitConfirmation(WorktreeBarLogic.initializeGitTitle, isPresented: $confirmingInitGit) {
                Button(WorktreeBarLogic.initializeGitConfirm) {
                    if let workspaceID { app.initializeGit(inWorkspace: workspaceID) }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(WorktreeBarLogic.initializeGitMessage(workDir: workspace?.workDir,
                                                           workspaceName: workspace?.name))
            }
            .padding(.bottom, .composerBandGap)
        }
    }

    /// The headline with the folder set in monospace, as web sets it in `<code>`.
    private func noticeHeadline(_ headline: (lead: String, path: String?, tail: String)) -> Text {
        guard let path = headline.path else { return Text(headline.lead + headline.tail) }
        return Text(headline.lead) + Text(path).font(.orbitMono.weight(.medium)) + Text(headline.tail)
    }

    /// The notice's ✕: muted and plain, named for what it does, which a Mac also shows on hover.
    private func noticeClose(_ notice: WorktreeBarLogic.SharedFolderNotice,
                             action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: "xmark").font(.orbitLabel)
                .padding(4).contentShape(Rectangle())
        }
        .buttonStyle(.plain).foregroundStyle(.secondary)
        .accessibilityLabel(notice.closeLabel)
        .help(notice.closeHelp)
    }

    // MARK: - worktree pill

    private func pill(detail d: SessionDetail, branch: String, files: [SessionChangedFile]) -> some View {
        let displayBranch = d.projectMembership?.role == .coordinator
            ? (d.projectIntegrationRef ?? branch)
            : branch
        let committed = !console.sessionStatus.isLive
        // Gate Commit/Merge on the session's AUTHORITATIVE control-plane status (what the composer's
        // Stop button reads via `showsInterrupt`), not the stream-derived `sessionStatus`: the latter
        // never reliably reaches `.running` on a cold open of an already-running session (no durable
        // "running" event is replayed), which left Commit enabled — and Merge shown — mid-turn. Fall
        // back to the reconciled stream status only until the session record loads (fresh deep link).
        // A message on its way counts before either status says so — see `WorktreeBarLogic.turnActive`.
        let session = app.session(id: console.sessionID)
        let turnActive = WorktreeBarLogic.turnActive(status: session?.effectiveRunStatus ?? console.sessionStatus,
                                                     runningSubagents: session?.runningSubagentCount,
                                                     sending: console.sending || console.awaitingReply)
        let primary = WorktreeBarLogic.primary(worktreeDirty: d.worktreeDirty,
                                                committed: committed, turnActive: turnActive)
        let add = files.reduce(0) { $0 + max(0, $1.additions) }
        let del = files.reduce(0) { $0 + max(0, $1.deletions) }
        // A failed commit gets its own panel (what happened, why, what to do); the plain failure line
        // below is for a failed merge.
        let commitFailure = WorktreeBarLogic.commitFailure(commitStatus: d.commitStatus,
                                                           commitError: d.commitError,
                                                           commitResultMessage: d.commitResultMessage)
        let conflict = commitFailure != nil ? nil : WorktreeBarLogic.mergeConflict(mergeStatus: d.mergeStatus,
                                                                                  mergeError: d.mergeError,
                                                                                  mergeTarget: d.mergeTarget,
                                                                                  branch: branch)
        let failure = commitFailure != nil || conflict != nil ? nil
            : WorktreeBarLogic.failureMessage(mergeStatus: d.mergeStatus, mergeError: d.mergeError,
                                              commitStatus: d.commitStatus, commitError: d.commitError)
        // Work handed to the platform to land (board docs/mocks/session-landing-slot-ios): the landing
        // is the one state the card says, so the merge control gives way to it — its second row while
        // it is on its way, a chip at the end of this row once it settled.
        let landing = SessionProjectLandings.sourceSlot(d.sourceLanding, membership: d.projectMembership)

        return VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    // The whole branch + stat summary is the tap target that opens the diff — there's no
                    // separate chevron anymore (a lone › sitting right next to the merge caret's ⌄ read as a
                    // second dropdown, not "view diff"). Copy is the secondary action, so it moves to the
                    // long-press (right-click on macOS) context menu — a plain tap can no longer silently
                    // copy, and the Commit/Merge control stays its own target so a diff tap can't fire it.
                    branchSummary(branch: displayBranch, add: add, del: del, count: files.count,
                                  committed: primary == .merge, commits: d.branchCommits,
                                  dirty: d.worktreeDirty == true)
                    // The action button keeps its size (web `flex: none`); the branch/stat truncate first
                    // under narrow width.
                    switch primary {
                    case .commit: WorktreeCommitControl(console: console, detail: d, turnActive: turnActive).layoutPriority(2)
                    case .merge:
                        if let landing {
                            if !landing.isRow { landingChip(landing, sessionID: d.sourceLanding?.landingSessionId) }
                        } else {
                            WorktreeMergeControl(console: console, detail: d, branch: branch).layoutPriority(2)
                        }
                    case .none:   EmptyView()
                    }
                }
                // Pin to the same 30pt collapsed-row height as the background tray below (web parity: both
                // bars share `min-height: 30`) so the stack above the composer reads as one system — this 24
                // plus the bar's 3pt insets. On the row, as web has it (`.wt-row`), not the whole bar: a
                // `minHeight` frame takes any shorter height it's offered, so on the bar it let whatever the
                // bar holds under the row spill out of it — over the transcript and under the composer.
                .frame(minHeight: 24)
                if let commitFailure {
                    WorktreeCommitFailureView(console: console, failure: commitFailure, branch: branch)
                        .id(d.commitError ?? "")
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 3)
            // A failed merge is its own section under the row, inset from the bar's edges rather than
            // sitting on its bottom border (web `.wt-merge-inset`, board docs/mocks/merge-conflict-strip).
            if d.mergeRecovery == nil, conflict != nil || failure != nil {
                Divider()
                HStack(alignment: .top, spacing: 8) {
                    Group {
                        if let conflict {
                            WorktreeMergeConflictView(conflict: conflict).id(d.mergeError ?? "")
                        } else if let failure {
                            failureView(message: failure)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    // Closes it everywhere (web `.wt-merge-dismiss`, board docs/mocks/merge-error-dismiss).
                    Button { Task { await console.worktree.dismissMergeFailure() } } label: {
                        Image(systemName: "xmark").font(.orbitLabel)
                            .padding(4).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
                    .disabled(console.worktree.busy)
                    .accessibilityLabel("Dismiss")
                    .help("Dismiss")
                    .padding(.top, -4)
                }
                .padding(.leading, 10).padding(.trailing, 6).padding(.top, 9).padding(.bottom, 10)
            }
            // A merge held for target recovery is the bar's second row: what holds it, one line, and
            // the review behind it in a sheet — never the review itself, which is taller than the band
            // can give on a phone. The row is the recovery's only way in; the merge slot above gives
            // way to it.
            if commitFailure == nil, let recovery = d.mergeRecovery {
                Divider()
                MergeRecoveryRow(recovery: recovery, working: d.mergeStatus == "pending") { sheet = .recovery }
            } else if let landing, landing.isRow {
                SourceLandingRow(slot: landing) { openLanding(d.sourceLanding?.landingSessionId) }
                    .padding(.horizontal, 6).padding(.bottom, 6).padding(.top, 2)
            }
        }
        // The same subtle tint the tray uses, NOT `.bar`: the two are peers in the stack and have to
        // read as one surface (web parity: `.wt-bar` and `.bg-tray` are both `--bg-subtle`). This
        // fill is also what lets the pill stand on the bare content backdrop now that `ComposerBand`
        // carries no surface of its own.
        .composerBandCard()
        .padding(.bottom, .composerBandGap)
    }

    /// A settled landing at the end of the branch row, where "✓ Merged" stands for a merge by hand;
    /// it opens the landing session, as the open row does.
    private func landingChip(_ slot: SourceLandingSlot, sessionID: String?) -> some View {
        Button { openLanding(sessionID) } label: {
            Text("\(slot.text) ›")
                .font(.orbitLabel.weight(.semibold))
                .foregroundStyle(slot.kind == .landed ? Color.green : Color.secondary)
                .lineLimit(1)
        }
        .buttonStyle(.plain)
        .layoutPriority(2)
    }

    private func openLanding(_ sessionID: String?) {
        guard let sessionID, !sessionID.isEmpty,
              let url = URL(string: "orbit-session:\(PublicID.toPublic(sessionID))") else { return }
        PlatformHaptics.tap()
        openURL(url)
    }

    @ViewBuilder
    private func branchSummary(branch: String, add: Int, del: Int, count: Int, committed: Bool,
                               commits: [BranchCommit]? = nil, dirty: Bool = false) -> some View {
        if count == 0 {
            HStack(spacing: 8) {
                branchLabel(branch)
                summaryStat(add: add, del: del, count: count, committed: committed, commits: commits, dirty: dirty)
                Spacer(minLength: 4)
            }
            .layoutPriority(1)
            .contextMenu { copyBranchButton(branch) }
        } else {
            Button { sheet = .diff } label: {
                HStack(spacing: 8) {
                    branchLabel(branch)
                    summaryStat(add: add, del: del, count: count, committed: committed, commits: commits, dirty: dirty)
                    Spacer(minLength: 4)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .layoutPriority(1)
            .contextMenu { copyBranchButton(branch) }
            .accessibilityHint("Opens the diff")
            .help("View diff")
        }
    }

    /// The branch pill — now a plain label (a tap opens the diff). On copy its leading glyph flashes
    /// to a green checkmark for ~1.5s so the otherwise-silent clipboard write is visible on iOS,
    /// where there is no hover tooltip to lean on.
    private func branchLabel(_ branch: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: copied ? "checkmark" : "arrow.triangle.branch")
                .font(.orbitMeta).foregroundStyle(copied ? Color.green : Color.secondary)
            BranchLabelView(branch: branch).lineLimit(1).truncationMode(.middle)
        }
        .padding(.horizontal, 6).padding(.vertical, 2)
        .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.primary.opacity(0.1)))
    }

    private func copyBranchButton(_ branch: String) -> some View {
        Button { copyBranch(branch) } label: {
            Label("Copy branch name", systemImage: "doc.on.doc")
        }
    }

    private func copyBranch(_ branch: String) {
        PlatformPasteboard.copyString(branch)
        PlatformHaptics.success()
        copied = true
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            copied = false
        }
    }

    /// The bar counted in commits when the runner reports them (board session-commits-first/02-native A),
    /// else today's file count.
    @ViewBuilder
    private func summaryStat(add: Int, del: Int, count: Int, committed: Bool, commits: [BranchCommit]?, dirty: Bool) -> some View {
        if let commits {
            commitsStatView(commits: commits, dirty: dirty, add: add, del: del, fileCount: count)
        } else {
            statView(add: add, del: del, count: count, committed: committed)
        }
    }

    /// "3 commits + uncommitted  +479 −54", or "Uncommitted · 8 files" before the first commit. Short of
    /// room it drops the line counts, then the "+ uncommitted" tag, never the count. The newest subject
    /// leads on a wide bar (iPad, Mac), as on the web; a phone row has no room for it, and the sheet
    /// opens on the commit list instead.
    private func commitsStatView(commits: [BranchCommit], dirty: Bool, add: Int, del: Int, fileCount: Int) -> some View {
        let lines = (Text("+\(add)").foregroundStyle(.green) + Text(" −\(del)").foregroundStyle(.red)).font(.orbitMono)
        let label = commits.isEmpty
            ? Text("Uncommitted").fontWeight(.semibold)
                + Text(" · \(fileCount) \(fileCount == 1 ? "file" : "files")").foregroundStyle(.secondary)
            : Text(WorktreeBarLogic.commitCountLabel(commits.count)).fontWeight(.semibold)
        let pending = dirty && !commits.isEmpty ? Text(" + uncommitted").foregroundStyle(.orange) : Text("")
        let latest = commits.first.map { Text(" · ").foregroundStyle(.secondary) + Text($0.subject) } ?? Text("")
        return ViewThatFits(in: .horizontal) {
            if showsLatestSubject {
                (label + pending + latest + Text("  ") + lines).fixedSize()
            }
            (label + pending + Text("  ") + lines).fixedSize()
            (label + pending).fixedSize()
            label.fixedSize()
        }
        .font(.orbitLabel)
        .lineLimit(1)
        .layoutPriority(1)
    }

    /// Whether the bar may lead with the newest commit's subject: not on a phone (board decision B).
    private var showsLatestSubject: Bool {
        #if os(iOS)
        horizontalSizeClass == .regular
        #else
        true
        #endif
    }

    /// The count is the row's reading: it takes its room before the branch name, which gives way
    /// first. Short of room it drops words rather than truncating — "· committed" (the Merge button
    /// beside it says as much), then the file count — so the Merge button keeps its title on a phone.
    private func statView(add: Int, del: Int, count: Int, committed: Bool) -> some View {
        let lines = Text("+\(add)").foregroundStyle(.green) + Text(" −\(del)").foregroundStyle(.red)
        let files = lines + Text(" · \(count) \(count == 1 ? "file" : "files")").foregroundStyle(.secondary)
        return ViewThatFits(in: .horizontal) {
            if committed {
                (files + Text(" · committed").foregroundStyle(.secondary)).fixedSize()
            }
            files.fixedSize()
            lines.fixedSize()
        }
        .font(.orbitMono)
        .lineLimit(1)
        .layoutPriority(1)
    }

    private func failureView(message: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.orbitMeta.weight(.semibold))
                .foregroundStyle(Color.red)
                .padding(.top, 1)
            Text(message)
                .font(.orbitMeta)
                .foregroundStyle(Color.red)
                .lineLimit(6)
                .truncationMode(.tail)
                .textSelection(.enabled)
        }
        .contextMenu {
            Button { copyFailureText(message) } label: {
                Label("Copy failure reason", systemImage: "doc.on.doc")
            }
        }
        .accessibilityLabel(message)
    }

    private func copyFailureText(_ text: String) {
        PlatformPasteboard.copyString(text)
        PlatformHaptics.success()
    }

}

/// Render an auto-generated `orbit/<slug>-<hash>` branch with the prefix + hash dimmed so the
/// meaningful slug reads first; falls back to the raw name for any other shape. Mirrors web `BranchLabel`.
struct BranchLabelView: View {
    let branch: String
    var body: some View {
        if let p = WorktreeBarLogic.branchParts(branch) {
            (Text(p.prefix).foregroundStyle(.secondary)
                + Text(p.slug)
                + Text(p.hash).foregroundStyle(.secondary))
                .font(.orbitMono)
        } else {
            Text(branch).font(.orbitMono)
        }
    }
}

// MARK: - primary actions

/// Status-aware "Merge to main" control (mirrors web `MergeButton`): idle → a Merge button with an
/// optional target-branch menu; pending → "Merging…"; merged → a ✓ chip; already-in-main → "✓ In
/// main"; pull_request → the pull request's state, opening it; conflict → "Resolve in session";
/// error → "Retry merge".
private struct WorktreeMergeControl: View {
    @Environment(\.openURL) private var openURL
    let console: ConsoleModel
    let detail: SessionDetail
    let branch: String
    /// The branch the user picked via the caret — it only re-points the primary button's target; the
    /// merge itself waits for a tap on the primary button. Falls back to the default when the pick is
    /// no longer an offered target.
    @State private var selectedTarget: String? = nil

    var body: some View {
        let status = detail.mergeStatus
        let targets = detail.mergeTargets ?? []
        let busy = console.worktree.busy
        let defaultTarget = detail.mergeTarget ?? WorktreeBarLogic.defaultTarget(
            targets: targets, agentDefaultTarget: detail.agent?.defaultMergeTarget)
        // The user's caret pick re-points the primary button until they merge (falls back if the
        // picked branch is no longer an offered target).
        let picked = selectedTarget.flatMap { targets.contains($0) ? $0 : nil }
        // Branch divergence: the agent ran `git checkout -b` inside the worktree, so its real HEAD
        // (worktreeBranch) is no longer the branch Orbit tracks. Merge / "✓ In main" would act on the
        // wrong (tracked) branch, so we surface the untracked branch + an Adopt action instead.
        let diverged = (detail.worktreeBranch.map { !$0.isEmpty && $0 != branch }) ?? false

        if diverged, let wb = detail.worktreeBranch {
            adoptControl(worktreeBranch: wb, busy: busy)
        } else if detail.mergeRecovery != nil, detail.mergeRecoverySupported == true {
            // The recovery's steps live in its review sheet, opened from the bar's second row — a
            // button here would be a second way into the same thing.
            EmptyView()
        } else if status == "merged" {
            let elsewhere = detail.mergeTarget != nil && detail.mergeTarget != "main" && detail.mergeTarget != "master"
            WTChip(title: "✓ Merged" + (elsewhere ? " → \(detail.mergeTarget!)" : ""))
        } else if detail.branchMerged == true && status == nil {
            let landed = detail.mergeTarget
                ?? (targets.contains("main") ? "main" : targets.contains("master") ? "master" : "main")
            WTChip(title: "✓ In \(landed)")
        } else if status == "pull_request" {
            let line = WorktreeBarLogic.mergePullRequestLine(detail.mergePullRequest, target: detail.mergeTarget ?? defaultTarget ?? "main")
            if let url = line.url.flatMap(URL.init(string:)) {
                Button { openURL(url) } label: { WTChip(title: line.label + " ↗", color: pullRequestInk(line.tone)) }
                    .buttonStyle(.plain)
                    .help(line.detail)
            } else {
                WTChip(title: line.label, color: pullRequestInk(line.tone)).help(line.detail)
            }
        } else if status == "pending" {
            WTPillButton(title: "Merging…", disabled: true) {}
        } else if status == "conflict" || status == "error" {
            if WorktreeBarLogic.resolvable(mergeStatus: status) {
                let onto = WorktreeBarLogic.conflictTarget(
                    mergeTarget: detail.mergeTarget, targets: targets,
                    agentDefaultTarget: detail.agent?.defaultMergeTarget)
                WTPillButton(title: busy ? "Resuming…" : "Resolve in session", tint: .red, disabled: busy) {
                    Task { await console.worktree.resolveInSession(branch: branch, target: onto) }
                }
            } else {
                let target = picked ?? detail.mergeTarget ?? defaultTarget
                mergeSplit(title: "Retry merge to \(targetName(target))",
                           tint: .red, busy: busy, primaryTarget: target,
                           targets: targets, currentTarget: target)
            }
        } else {
            let target = picked ?? defaultTarget
            mergeSplit(title: "Merge to \(targetName(target))",
                       tint: .accentColor, busy: busy, primaryTarget: target,
                       targets: targets, currentTarget: target)
        }
    }

    /// The pull request's tone, in `LandingPullRequestBlock`'s inks.
    private func pullRequestInk(_ tone: LandingPullRequestCard.Tone) -> Color {
        switch tone {
        case .blue: return .accentColor
        case .green: return .green
        case .red: return .red
        case .amber: return ProjectPalette.warningInk
        }
    }

    /// The target as the button says it: the project's title for the project's own line, never
    /// `project/<id>`; the caret's list still names every branch in full.
    private func targetName(_ target: String?) -> String {
        SessionProjectLandings.targetName(target ?? "main", membership: detail.projectMembership)
    }

    /// Divergence flag + Adopt action, shown in the merge slot when the worktree's real HEAD has
    /// left the tracked branch (mirrors web's AdoptButton): names the untracked branch and adopts it
    /// (re-points the session) so Merge/diff act on the real work instead of a stale "✓ In main".
    private func adoptControl(worktreeBranch: String, busy: Bool) -> some View {
        HStack(spacing: 8) {
            Text("⚠ On \(worktreeBranch)")
                .font(.orbitLabel.weight(.semibold)).foregroundStyle(.orange).lineLimit(1)
                .help("This worktree is on \"\(worktreeBranch)\", which Orbit isn't tracking — the session tracks \"\(branch)\". Adopt it to merge and diff the work on this branch.")
            WTPillButton(title: busy ? "Adopting…" : "Adopt", tint: .orange, disabled: busy) {
                Task { await console.worktree.adopt() }
            }
        }
    }

    /// The idle/retry action as one unified split button: the primary "Merge to <default>" segment
    /// butted directly against the target-branch caret, sharing a single capsule + border with a 1pt
    /// hairline divider between them, so the caret reads as part of the button rather than a detached
    /// pill (the old `spacing: 4` + standalone caret capsule). No reported targets → a plain pill, no
    /// caret. The caret (MergeTargetCaret) still flips from an inline menu to a searchable sheet once
    /// the repo has many branches.
    private func mergeSplit(title: String, tint: Color, busy: Bool, primaryTarget: String?,
                            targets: [String], currentTarget: String?) -> some View {
        let c = busy ? Color.secondary : tint
        return HStack(spacing: 0) {
            Button { Task { await console.worktree.merge(target: primaryTarget) } } label: {
                // Middle truncation keeps both ends of a long project title readable; the row gives
                // the button its full width first (`statView` drops words instead).
                Text(title).font(.orbitLabel.weight(.semibold)).lineLimit(1).truncationMode(.middle)
                    .foregroundStyle(c)
                    .padding(.leading, 10).padding(.trailing, targets.isEmpty ? 10 : 9).padding(.vertical, 3)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(busy)
            if !targets.isEmpty {
                // Fixed height, NOT a bare `Rectangle().frame(width: 1)`: an unheighted Rectangle is
                // a greedy shape that expands vertically without bound, and since this HStack has no
                // height cap (the bar is only `minHeight: 30`) it stretched the whole split button —
                // and the enclosing Capsule — into a giant pill. 18pt sits ~3pt inside the button.
                Rectangle().fill(c.opacity(0.3)).frame(width: 1, height: 18)
                MergeTargetCaret(targets: targets, currentTarget: currentTarget, tint: c) { selectedTarget = $0 }
            }
        }
        .background(c.opacity(busy ? 0.08 : 0.14), in: Capsule())
        .overlay(Capsule().strokeBorder(c.opacity(0.3)))
    }
}

/// The split-button caret: picks another branch to merge into. A short list stays a native inline
/// `Menu`; once the repo has many branches it becomes a searchable, height-capped sheet so the list
/// stops running off-screen and can be filtered — mirroring web's searchable merge-target dropdown.
/// Rendered inside the merge split button's shared capsule, so its label is a bare chevron (no pill
/// of its own — the enclosing capsule + hairline divider frame it).
private struct MergeTargetCaret: View {
    let targets: [String]
    let currentTarget: String?
    let tint: Color
    /// Called with the picked branch — the parent re-points the primary button to it; the merge is
    /// NOT run here, it waits for the primary button tap.
    let onPick: (String) -> Void
    @State private var showPicker = false

    /// Past this many branches the inline menu is a chore to scan, so switch to the search sheet
    /// (matches web's merge-target search threshold).
    private static let searchThreshold = 8

    var body: some View {
        if targets.count > Self.searchThreshold {
            Button { showPicker = true } label: { caretLabel }
                .buttonStyle(.plain)
                .accessibilityLabel("Choose a branch to merge into")
                .sheet(isPresented: $showPicker) {
                    MergeTargetPickerSheet(targets: targets, currentTarget: currentTarget, onPick: onPick)
                }
        } else {
            Menu {
                ForEach(targets, id: \.self) { b in
                    Button { onPick(b) } label: {
                        if b == currentTarget { Label(b, systemImage: "checkmark") } else { Text(b) }
                    }
                }
            } label: {
                caretLabel
            }
            .menuIndicator(.hidden)
            .fixedSize()
        }
    }

    /// Bare chevron — no capsule of its own; it sits inside the split button's shared capsule.
    private var caretLabel: some View {
        Image(systemName: "chevron.down").font(.orbitMeta.weight(.semibold)).foregroundStyle(tint)
            .padding(.horizontal, 8).padding(.vertical, 4)
            .contentShape(Rectangle())
    }
}

/// A searchable, height-capped list of branches to merge into — shown instead of the inline menu
/// when the repo has many branches (the iOS/macOS counterpart to web's merge-target search box).
/// Medium-height on iOS so it never runs off-screen; picking a branch dismisses and re-points the
/// primary merge button (the merge itself waits for a tap on that button).
private struct MergeTargetPickerSheet: View {
    let targets: [String]
    let currentTarget: String?
    let onPick: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var filtered: [String] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        return q.isEmpty ? targets : targets.filter { $0.lowercased().contains(q) }
    }

    var body: some View {
        NavigationStack {
            List {
                ForEach(filtered, id: \.self) { b in
                    MergeTargetRow(branch: b, isCurrent: b == currentTarget) {
                        dismiss()
                        onPick(b)
                    }
                }
            }
            .listStyle(.plain)
            .softTopEdgeEffect()
            .searchable(text: $query, prompt: "Search branches")
            .overlay { if filtered.isEmpty { ContentUnavailableView.search } }
            .navigationTitle("Merge into")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
        #if os(iOS)
        .presentationDetents([.medium, .large])
        #else
        .frame(minWidth: 360, minHeight: 420)
        #endif
    }
}

/// One branch in the merge-target sheet, marked when it is the one the merge already points at.
private struct MergeTargetRow: View {
    let branch: String
    let isCurrent: Bool
    let pick: () -> Void

    var body: some View {
        Button(action: pick) {
            HStack(spacing: 8) {
                BranchLabelView(branch: branch).lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 8)
                if isCurrent {
                    Image(systemName: "checkmark").font(.orbitMeta.weight(.semibold))
                        .foregroundStyle(Color.accentColor)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// "Commit" control shown while the live worktree is dirty (mirrors web `CommitButton`): idle →
/// Commit; pending → "Committing…"; error → "Retry commit". Disabled mid-turn (a half-built tree
/// would capture an inconsistent snapshot).
private struct WorktreeCommitControl: View {
    let console: ConsoleModel
    let detail: SessionDetail
    let turnActive: Bool

    var body: some View {
        let status = detail.commitStatus
        let busy = console.worktree.busy
        let pending = status == "pending"
        let title = pending ? "Committing…" : (status == "error" ? "Retry commit" : "Commit")
        WTPillButton(title: title, tint: status == "error" ? .red : .accentColor,
                     disabled: pending || turnActive || busy) {
            Task { await console.worktree.commit() }
        }
    }
}

/// A failed commit (mirrors web `CommitFailure`): what happened, why and what to do, with git's own
/// words behind "Show git output" for whoever is debugging. Keyed on the error by its parent, so a
/// new failure starts folded again.
private struct WorktreeCommitFailureView: View {
    let console: ConsoleModel
    let failure: WorktreeBarLogic.CommitFailure
    let branch: String
    @State private var showGitOutput = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.circle.fill")
                Text(failure.headline)
            }
            .font(.orbitMeta.weight(.semibold))
            .foregroundStyle(Color.red)
            Text(failure.why)
                .font(.orbitMeta)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            HStack(spacing: 12) {
                let busy = console.worktree.busy
                WTPillButton(title: busy ? "Resuming…" : "Resolve in session", tint: .red, disabled: busy) {
                    Task { await console.worktree.resolveCommitInSession(branch: branch, why: failure.why) }
                }
                if failure.gitOutput != nil {
                    Button { showGitOutput.toggle() } label: {
                        HStack(spacing: 3) {
                            Text(showGitOutput ? "Hide git output" : "Show git output")
                            Image(systemName: showGitOutput ? "chevron.down" : "chevron.right")
                        }
                        .font(.orbitMeta)
                        .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityValue(showGitOutput ? "Shown" : "Hidden")
                }
            }
            .padding(.top, 2)
            if showGitOutput, let gitOutput = failure.gitOutput {
                Text(gitOutput)
                    .font(.orbitMonoFine)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 8).padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))
            }
        }
        .contextMenu {
            Button { copy(failure.why) } label: {
                Label("Copy failure reason", systemImage: "doc.on.doc")
            }
            if let gitOutput = failure.gitOutput {
                Button { copy(gitOutput) } label: {
                    Label("Copy git output", systemImage: "terminal")
                }
            }
        }
    }

    private func copy(_ text: String) {
        PlatformPasteboard.copyString(text)
        PlatformHaptics.success()
    }
}

/// A merge conflict (mirrors web's conflict panel): what happened, then the by-hand recipe as two
/// steps — where each runs above its command, which a click copies — with git's own words behind
/// "Show git output". Keyed on the error by its parent, so a new conflict starts folded again.
private struct WorktreeMergeConflictView: View {
    let conflict: WorktreeBarLogic.MergeConflict
    @State private var showGitOutput = false
    @State private var copied: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.circle.fill")
                Text(conflict.headline)
            }
            .font(.orbitMeta.weight(.semibold))
            .foregroundStyle(Color.red)
            why
                .font(.orbitMeta)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(Array(conflict.steps.enumerated()), id: \.offset) { i, step in
                HStack(alignment: .top, spacing: 8) {
                    Text("\(i + 1)")
                        .font(.orbitMeta.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 16, height: 16)
                        .background(Color.primary.opacity(0.06), in: Circle())
                    VStack(alignment: .leading, spacing: 3) {
                        Text(step.place)
                            .font(.orbitMeta)
                            .foregroundStyle(.secondary)
                        Button { copy(step.command) } label: {
                            Text(copied == step.command ? "Copied" : step.command)
                                .font(.orbitMono)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.horizontal, 7).padding(.vertical, 2)
                                .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
                        }
                        .buttonStyle(.plain)
                        .help("Copy")
                        .accessibilityLabel("Copy \(step.command)")
                    }
                }
                .padding(.top, 2)
            }
            if conflict.gitOutput != nil {
                Button { showGitOutput.toggle() } label: {
                    HStack(spacing: 3) {
                        Text(showGitOutput ? "Hide git output" : "Show git output")
                        Image(systemName: showGitOutput ? "chevron.down" : "chevron.right")
                    }
                    .font(.orbitMeta)
                    .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityValue(showGitOutput ? "Shown" : "Hidden")
                .padding(.top, 2)
            }
            if showGitOutput, let gitOutput = conflict.gitOutput {
                Text(gitOutput)
                    .font(.orbitMonoFine)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 8).padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))
            }
        }
        .contextMenu {
            if let gitOutput = conflict.gitOutput {
                Button { copy(gitOutput) } label: {
                    Label("Copy git output", systemImage: "terminal")
                }
            }
        }
    }

    /// The why, with the button it names in the primary colour and semibold (web's `<b>`).
    private var why: Text {
        let button = "Resolve in session"
        guard let range = conflict.why.range(of: button) else { return Text(conflict.why) }
        return Text(conflict.why[..<range.lowerBound])
            + Text(button).fontWeight(.semibold).foregroundColor(.primary)
            + Text(conflict.why[range.upperBound...])
    }

    private func copy(_ text: String) {
        PlatformPasteboard.copyString(text)
        PlatformHaptics.success()
        copied = text
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            if copied == text { copied = nil }
        }
    }
}

/// A compact tinted pill button used for the Commit / Merge / Resolve actions.
private struct WTPillButton: View {
    let title: String
    var tint: Color = .accentColor
    var disabled: Bool = false
    let action: () -> Void

    var body: some View {
        let c = disabled ? Color.secondary : tint
        Button(action: action) {
            Text(title)
                .font(.orbitLabel.weight(.semibold))
                .lineLimit(1)
                .padding(.horizontal, 10).padding(.vertical, 3)
                .foregroundStyle(c)
                .background(c.opacity(disabled ? 0.08 : 0.14), in: Capsule())
                .overlay(Capsule().strokeBorder(c.opacity(0.3)))
        }
        .buttonStyle(.plain)
        .disabled(disabled)
    }
}

/// A quiet status chip (e.g. "✓ Merged", "✓ In main").
private struct WTChip: View {
    let title: String
    var color: Color = .green
    var body: some View {
        Text(title).font(.orbitLabel.weight(.semibold)).foregroundStyle(color).lineLimit(1)
    }
}

// MARK: - diff sheet

/// The changed-file list + per-file unified diff, opened by tapping the bar (or its chevron). The
/// file list and its `+/−` stats come from the (already-loaded) `changedFiles`; the diff is lazy.
struct DiffSheet: View {
    let console: ConsoleModel
    /// Opened from somewhere that names no commit (the main checkout's changed-files link): the whole
    /// branch, never the commit list (web parity: the drawer opens on All changes).
    var startOnAllChanges = false
    @Environment(\.dismiss) private var dismiss
    @State private var branchCopied = false
    /// The tab chosen by hand; nil until then, which reads as the opening tab.
    @State private var chosenTab: WorktreeBarLogic.DiffTab?

    var body: some View {
        let files = console.worktree.detail?.changedFiles ?? []
        let detail = console.worktree.detail
        let branch = detail?.projectMembership?.role == .coordinator
            ? (detail?.projectIntegrationRef ?? detail?.branch)
            : detail?.branch
        // Commits first (board session-commits-first/02-native B): the sheet opens on the branch's commits
        // when the runner reports any, with the file list one tab away; without them it is today's list.
        let commits = detail?.branchCommits ?? []
        let opening = WorktreeBarLogic.openingTab(commits: detail?.branchCommits)
        let tab = opening == nil ? WorktreeBarLogic.DiffTab.allChanges
            : (chosenTab ?? (startOnAllChanges ? .allChanges : opening!))
        NavigationStack {
            List {
                if opening != nil {
                    Section {
                        Picker("Show", selection: Binding(get: { tab }, set: { chosenTab = $0 })) {
                            Text(commitsTabTitle(commits.count))
                                .tag(WorktreeBarLogic.DiffTab.commits)
                            Text("All changes \(files.count)").tag(WorktreeBarLogic.DiffTab.allChanges)
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                    }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
                if tab == .commits {
                    Section {
                        if detail?.worktreeDirty == true {
                            // Work no commit holds yet: it is in All changes, as on the web.
                            Button { chosenTab = .allChanges } label: { PendingCommitRow() }
                                .buttonStyle(.plain)
                        }
                        ForEach(commits) { commit in
                            NavigationLink {
                                CommitDetailView(console: console, commit: commit, commits: commits,
                                                 branchFiles: files, worktreeDirty: detail?.worktreeDirty == true)
                            } label: {
                                BranchCommitRow(commit: commit)
                            }
                        }
                    } footer: {
                        if let based = WorktreeBarLogic.basedOn(mergeTarget: detail?.mergeTarget, baseSha: detail?.baseSha) {
                            Text("Based on \(based)")
                        }
                    }
                } else {
                    ForEach(files) { file in
                        NavigationLink {
                            DiffFileView(console: console, file: file)
                        } label: {
                            DiffFileRow(file: file)
                        }
                    }
                }
            }
            .navigationTitle("Worktree changes")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                // An explicit, always-visible copy affordance backs up the bar's long-press menu.
                if let branch {
                    ToolbarItem(placement: .cancellationAction) {
                        Button { copyBranch(branch) } label: {
                            Label(branchCopied ? "Copied" : "Copy branch",
                                  systemImage: branchCopied ? "checkmark" : "doc.on.doc")
                        }
                    }
                }
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        // Re-run when a heartbeat changes the file summary while this sheet stays open. The model's
        // generation fence cancels stale polling and lets the newest file set own the refresh.
        .task(id: files) { await console.worktree.loadDiff() }
        #if os(macOS)
        .frame(minWidth: 560, minHeight: 420)
        #endif
    }

    private func commitsTabTitle(_ n: Int) -> String {
        n >= WorktreeBarLogic.commitsMax ? "Commits \(WorktreeBarLogic.commitsMax)+" : "Commits \(n)"
    }

    private func copyBranch(_ branch: String) {
        PlatformPasteboard.copyString(branch)
        PlatformHaptics.success()
        branchCopied = true
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            branchCopied = false
        }
    }
}

/// One commit in the sheet's commit list: subject, then short sha · age · file count, and the label of a
/// commit the runner made itself (web `CommitRow`).
struct BranchCommitRow: View {
    let commit: BranchCommit

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .strokeBorder(saved == nil ? Color.clear : Color.secondary.opacity(0.6), lineWidth: 1.5)
                .background(Circle().fill(saved == nil ? Color.secondary : Color.clear))
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 2) {
                Text(commit.subject.isEmpty ? "(no message)" : commit.subject)
                    .font(.orbitLabel.weight(.semibold)).lineLimit(1)
                HStack(spacing: 5) {
                    Text(WorktreeBarLogic.shortSha(commit.sha)).font(.orbitMonoFine)
                    Text(meta)
                    if let saved {
                        Text(saved)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 4))
                    }
                }
                .font(.orbitMeta).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .padding(.vertical, 2)
    }

    private var saved: String? { WorktreeBarLogic.savedByLabel(commit.savedBy) }

    private var meta: String {
        let n = commit.files.count
        let files = "\(n)\(commit.filesTruncated == true ? "+" : "") \(n == 1 ? "file" : "files")"
        if let ago = RelativeTime.ago(commit.committedAt) { return "· \(ago) · \(files)" }
        return "· \(files)"
    }
}

/// The commit list's first row while the worktree holds work no commit has.
struct PendingCommitRow: View {
    var body: some View {
        HStack(spacing: 10) {
            Circle().strokeBorder(Color.orange, style: StrokeStyle(lineWidth: 1.5, dash: [2, 2])).frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 2) {
                Text("Uncommitted changes").font(.orbitLabel.weight(.semibold))
                Text("Not committed yet · shown under All changes").font(.orbitMeta).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.orbitMeta).foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
        .padding(.vertical, 2)
    }
}

/// A commit, pushed from the list (board 02-native C): its message first, the why, then only its own
/// files. A file opens the branch's diff of it: patches are per branch, which the note under the files
/// says when that differs from this commit alone.
struct CommitDetailView: View {
    let console: ConsoleModel
    let commit: BranchCommit
    let commits: [BranchCommit]
    let branchFiles: [SessionChangedFile]
    let worktreeDirty: Bool

    var body: some View {
        let stat = WorktreeBarLogic.commitStat(commit)
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(commit.subject.isEmpty ? "(no message)" : commit.subject)
                        .font(.headline).textSelection(.enabled)
                    HStack(spacing: 5) {
                        if let ago = RelativeTime.ago(commit.committedAt) {
                            Text(ago)
                            Text("·")
                        }
                        Text("+\(stat.add)").foregroundStyle(.green).font(.orbitMono)
                        Text("−\(stat.del)").foregroundStyle(.red).font(.orbitMono)
                        Text("· \(commit.files.count) \(commit.files.count == 1 ? "file" : "files")")
                        if let saved = WorktreeBarLogic.savedByLabel(commit.savedBy) { Text("· \(saved)") }
                    }
                    .font(.orbitMeta).foregroundStyle(.secondary)
                    if let body = commit.body, !body.isEmpty {
                        Text(body).font(.orbitLabel).textSelection(.enabled).padding(.top, 2)
                    }
                }
                .padding(.vertical, 2)
            }
            Section {
                ForEach(commit.changedFiles) { file in
                    // The branch's row for the file carries its status letter and is what the diff loads by.
                    let shown = branchFiles.first { $0.path == file.path } ?? file
                    NavigationLink {
                        DiffFileView(console: console, file: shown)
                    } label: {
                        DiffFileRow(file: SessionChangedFile(path: file.path, additions: file.additions,
                                                             deletions: file.deletions, status: shown.status))
                    }
                }
            } header: {
                Text("Files")
            } footer: {
                if WorktreeBarLogic.commitDiffsShowMore(commit, among: commits, worktreeDirty: worktreeDirty) {
                    Text(WorktreeBarLogic.commitDiffsShowMoreNote)
                }
            }
        }
        .navigationTitle(WorktreeBarLogic.shortSha(commit.sha))
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }
}

/// One row in the changed-file list: git status letter + path (dir dimmed) + `+/−` stat (or binary).
/// The merge recovery sheet lists its candidate diff with it too, so a diff has one look in the app.
struct DiffFileRow: View {
    let file: SessionChangedFile

    var body: some View {
        HStack(spacing: 8) {
            Text(String(file.status.prefix(1)).uppercased())
                .font(.orbitMonoFine.weight(.bold)).foregroundStyle(statusColor).frame(width: 14)
            pathText.font(.orbitMono).lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 6)
            if file.additions < 0 || file.deletions < 0 {
                Text("binary").font(.orbitMeta).foregroundStyle(.secondary)
            } else {
                (Text("+\(file.additions)").foregroundStyle(.green)
                    + Text(" −\(file.deletions)").foregroundStyle(.red))
                    .font(.orbitMonoFine)
            }
        }
    }

    private var pathText: Text {
        let i = file.path.lastIndex(of: "/")
        guard let i else { return Text(file.path) }
        let dir = String(file.path[..<file.path.index(after: i)])
        let name = String(file.path[file.path.index(after: i)...])
        return Text(dir).foregroundStyle(.secondary) + Text(name)
    }

    private var statusColor: Color {
        switch file.status.prefix(1).uppercased() {
        case "A": return .green
        case "D": return .red
        case "M": return .orange
        case "R": return .blue
        default:  return .secondary
        }
    }
}

/// One file's unified diff, colored per line (add green / del red / hunk dimmed). The patch text is
/// read live off the console so it appears the moment the lazy `/diff` fetch lands.
struct DiffFileView: View {
    let console: ConsoleModel
    let file: SessionChangedFile

    // Cap the rendered lines so a huge file doesn't build a giant string; the runner already caps
    // the patch, but a large in-cap diff still gets trimmed for the preview.
    private static let lineCap = 1200

    var body: some View {
        if file.additions < 0 || file.deletions < 0 {
            WorktreeFilePreview(worktree: console.worktree, file: file)
                .id(file.path)
        } else {
            textDiff
        }
    }

    @ViewBuilder private var textDiff: some View {
        let patch = console.worktree.diff.first { $0.path == file.path }
        ScrollView {
            if let text = patch?.patch, !text.isEmpty {
                let (attr, trimmed) = Self.colorize(text)
                VStack(alignment: .leading, spacing: 4) {
                    Text(attr).font(.orbitDiffLine).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if trimmed {
                        Text("(preview trimmed)").font(.orbitMeta).foregroundStyle(.secondary)
                    } else if patch?.truncated == true {
                        Text("(diff truncated)").font(.orbitMeta).foregroundStyle(.secondary)
                    }
                }
                .padding(12)
            } else if patch?.truncated == true {
                placeholder("Diff too large to preview")
            } else if console.worktree.diffLoading {
                placeholder("Loading diff…")
            } else if console.worktree.diffRefreshing {
                placeholder("Refreshing diff…")
            } else {
                placeholder("No diff to preview")
            }
        }
        .navigationTitle(file.path)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    private func placeholder(_ s: String) -> some View {
        Text(s).font(.orbitLabel).foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .center).padding(.top, 40)
    }

    /// Build a per-line colored `AttributedString` from a unified diff, dropping git file-header
    /// noise (mirrors web's `parseUnifiedDiff`). Returns whether it was trimmed at the line cap.
    /// Also draws each file of a merge recovery's candidate diff.
    static func colorize(_ patch: String) -> (AttributedString, Bool) {
        var out = AttributedString()
        var count = 0
        var trimmed = false
        for raw in patch.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            if line.hasPrefix("diff --git") || line.hasPrefix("index ") || line.hasPrefix("--- ")
                || line.hasPrefix("+++ ") || line.hasPrefix("new file") || line.hasPrefix("deleted file")
                || line.hasPrefix("old mode") || line.hasPrefix("new mode") || line.hasPrefix("similarity ")
                || line.hasPrefix("rename ") || line.hasPrefix("\\") {
                continue
            }
            if count >= lineCap { trimmed = true; break }
            var seg = AttributedString(line + "\n")
            if line.hasPrefix("@@") { seg.foregroundColor = .secondary }
            else if line.hasPrefix("+") { seg.foregroundColor = .green }
            else if line.hasPrefix("-") { seg.foregroundColor = .red }
            out += seg
            count += 1
        }
        return (out, trimmed)
    }
}

/// Background shells the agent launched, shown as a collapsible tray between the transcript and
/// approvals — a port of web's `BackgroundShellsTray`. Folded it is the Background row the shared
/// rule draws (`BackgroundRowRule`, board v2): "Background", the name in the tint and its mark,
/// several running names rotating, and the count; no row at all when the rule shows nothing. Tapped
/// open it is the list as ever — "Background processes · N running · N total", each row
/// (status · command · age) opening as an accordion to that shell's captured output tail.
struct BackgroundTrayView: View {
    let procs: [BackgroundProc]
    /// The background agents' and workflows' progress, by launching call (TranscriptState.taskProgress).
    var progress: [String: TaskProgress] = [:]
    /// What the folded row draws (`BackgroundRowRule.row`); nil hides the tray.
    let row: BackgroundRowRule.Row?
    /// The band is folded away (`TypingFold`, the folded pill): the names stop rotating.
    var paused = false
    /// Scrolls the conversation to a bg_run job's card (R1): whether it found one to scroll to.
    var revealJob: ((String) -> Bool)? = nil
    /// The owner's stop of a running bg_run job (R3).
    var stopJob: ((String) async throws -> Void)? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var open = false
    @State private var expandedID: String? = nil
    /// Which of the rotating names shows, counted up for good and read modulo their number.
    @State private var turn = 0

    var body: some View {
        if let row {
            VStack(spacing: 0) {
                if open { header } else { folded(row) }
                if open {
                    Divider().opacity(0.5)
                    // Web parity (.bg-tray-list: max-height 320px + overflow auto): cap the open
                    // list and scroll INSIDE it. Uncapped, a tall expanded row (multi-line command
                    // + a 16-line output tail) competes with the transcript for the console's
                    // vertical space, and when the screen can't fit it (iPhone) SwiftUI squeezes
                    // the row's Texts — a height-squeezed Text tail-truncates with "…" even with
                    // no lineLimit, so an expanded process showed only its first few lines. The
                    // plain branch keeps a short list at its natural height (a bare ScrollView is
                    // greedy: capped at 320 it would pad a two-row list out to 320 of empty chrome).
                    // And never below two rows' worth: with another card open above it, the band's
                    // share can run out first, and a scroll area with no floor is squeezed to nothing
                    // under its own header (`CreatedTasksCard.listFloor`, the same rule).
                    ViewThatFits(in: .vertical) {
                        rows
                        ScrollView { rows }
                            .frame(minHeight: CGFloat(min(procs.count, 2)) * 30, maxHeight: 320)
                    }
                }
            }
            // Match the worktree pill's floating-card language (rounded + hairline border + inset) so
            // the stack above the composer reads as one system, not a full-bleed grey strip. The
            // surface is a light translucent tint rather than the `.bar` material, which rendered muddy
            // and border-less — web uses a near-white subtle fill (`--bg-subtle`) here for the crisper look.
            .composerBandCard()
            .padding(.bottom, .composerBandGap)
        }
    }

    /// The open tray's accordion rows — one per shell. A computed var so both ViewThatFits
    /// branches render the identical stack.
    private var rows: some View {
        VStack(spacing: 0) {
            ForEach(procs) { proc in
                BackgroundRow(proc: proc, progress: progress[proc.id], expanded: expandedID == proc.id,
                              onToggle: {
                                  // A bg_run job's row goes to its Job card, as the Agents list goes to a
                                  // run's block (R1); one whose card is not loaded opens here as ever.
                                  if WorktreeBarLogic.jobRowScrollsToCard(proc), revealJob?(proc.id) == true {
                                      withAnimation(.easeOut(duration: 0.12)) { open = false }
                                      return
                                  }
                                  withAnimation(.easeOut(duration: 0.12)) {
                                      expandedID = expandedID == proc.id ? nil : proc.id
                                  }
                              },
                              onStop: stopJob.flatMap { stop in
                                  WorktreeBarLogic.jobRowOffersStop(proc) ? { try await stop(proc.id) } : nil
                              })
            }
        }
    }

    private var runningCount: Int { procs.filter { $0.status == "running" }.count }

    private var countText: String {
        (runningCount > 0 ? "\(runningCount) running · " : "") + "\(procs.count) total"
    }

    // MARK: the folded row

    /// The names in turn while two or more run (and no failure is shown), else nil.
    private func rotating(_ row: BackgroundRowRule.Row) -> [BackgroundRowRule.Item]? {
        if case .rotate(let items, _, _) = row.name, items.count > 1 { return items }
        return nil
    }

    /// The name the row shows now.
    private func current(_ row: BackgroundRowRule.Row) -> BackgroundRowRule.Item {
        switch row.name {
        case .one(let item): return item
        case .rotate(let items, _, _): return items[turn % items.count]
        }
    }

    /// Rotation stops while the list is open, while the app is not in front and while the band is
    /// folded away; it starts again from where it was.
    private var rotationPaused: Bool { open || paused || scenePhase != .active }

    /// "Background", the name, the count and its mark: only the name moves, by a push from below,
    /// or — with Reduce Motion — a crossfade in place.
    private func folded(_ row: BackgroundRowRule.Row) -> some View {
        let item = current(row)
        let names = rotating(row)
        return HStack(spacing: 8) {
            Image(systemName: "terminal").font(.orbitMeta).foregroundStyle(.secondary)
            Text(row.label).font(.orbitLabel.weight(.semibold)).lineLimit(1).fixedSize()
            ZStack(alignment: .leading) {
                Text(item.name)
                    .font(.orbitLabel).foregroundStyle(.tint)
                    .lineLimit(1).truncationMode(item.truncate == .middle ? .middle : .tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .id(item.id)
                    .transition(reduceMotion ? .opacity : .push(from: .bottom))
            }
            .clipped()
            // The screen reader reads the row's own label, never a name that changes every 3 s.
            .accessibilityHidden(true)
            // The count, then the mark, at the right edge before the chevron, as AgentsBandRow ends.
            if !row.countParts.isEmpty {
                row.countParts.enumerated().reduce(Text("")) { line, part in
                    line + Text(part.offset == 0 ? "" : " · ")
                        + Text(part.element.text)
                }
                .font(.orbitMeta).foregroundStyle(.secondary).lineLimit(1).fixedSize()
            }
            BackgroundRowMarkView(mark: item.mark)
            Image(systemName: "chevron.right")
                .font(.orbitMeta.weight(.semibold)).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10).padding(.vertical, 3).frame(minHeight: 30)
        .contentShape(Rectangle())
        .onTapGesture { withAnimation(.easeOut(duration: 0.12)) { open.toggle() } }
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(row.accessibilityLabel)
        // A new set of running names starts again from the newest.
        .onChange(of: names?.map(\.id) ?? []) { _, _ in turn = 0 }
        // Restarted whenever the names or a pause condition change; a pause ends the loop.
        .task(id: RotationKey(ids: names?.map(\.id) ?? [], paused: rotationPaused)) {
            guard let names, !rotationPaused else { return }
            let perName = UInt64(BackgroundRowRule.rotatePerNameMs) * 1_000_000
            let change = Double(BackgroundRowRule.rotateChangeMs) / 1000
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: perName)
                if Task.isCancelled { return }
                withAnimation(.easeInOut(duration: change)) { turn = (turn + 1) % names.count }
            }
        }
    }

    private struct RotationKey: Equatable {
        let ids: [String]
        let paused: Bool
    }

    // MARK: the open list's header

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "terminal").font(.orbitMeta).foregroundStyle(.secondary)
            Text("Background processes").font(.orbitLabel.weight(.semibold))
            Text(countText).font(.orbitMeta).foregroundStyle(.secondary)
            Spacer(minLength: 4)
            Image(systemName: open ? "chevron.down" : "chevron.right")
                .font(.orbitMeta.weight(.semibold)).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10).padding(.vertical, 3).frame(minHeight: 30)
        .contentShape(Rectangle())
        .onTapGesture { withAnimation(.easeOut(duration: 0.12)) { open.toggle() } }
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(open ? "Hide background processes" : "Show background processes")
    }
}

/// The folded row's mark: the list row's own spinner and SF Symbols (`BackgroundRow.statusIcon`).
/// The spinner is the app's one running mark (`SpinnerGlyph`, as on a running session), not the
/// system activity indicator, so the bars above the composer do not show two kinds of loading.
private struct BackgroundRowMarkView: View {
    let mark: BackgroundRowRule.Mark

    var body: some View {
        switch mark {
        case .running: SpinnerGlyph(color: .accentColor)
        case .done:    Image(systemName: "checkmark.circle.fill").font(.orbitLabel).foregroundStyle(.green)
        case .failed:  Image(systemName: "xmark.circle.fill").font(.orbitLabel).foregroundStyle(.red)
        case .killed:  Image(systemName: "stop.circle").font(.orbitLabel).foregroundStyle(.secondary)
        }
    }
}

/// One background-shell row: a folded head (status · command · age) that expands to the
/// captured output tail (or an empty-state note). Mirrors web's `BgShellRow`.
private struct BackgroundRow: View {
    let proc: BackgroundProc
    var progress: TaskProgress? = nil
    let expanded: Bool
    let onToggle: () -> Void
    /// A running bg_run job its runner can stop (R3); nil for anything else.
    var onStop: (() async throws -> Void)? = nil
    @State private var asking = false
    @State private var stopFailed: String?

    /// An async agent or a workflow rather than a shell: named by kind, and opening to its progress.
    private var isTask: Bool { proc.kind == "agent" || proc.kind == "workflow" }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                statusIcon.frame(width: 18)
                if isTask {
                    Text(proc.kind == "workflow" ? "Workflow" : "Agent")
                        .font(.orbitMonoFine).foregroundStyle(.secondary)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Color.gray.opacity(0.14), in: RoundedRectangle(cornerRadius: 4))
                }
                Text(proc.description ?? proc.command ?? "Background process")
                    .font(.orbitMono).lineLimit(1).truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let ts = proc.startedAt, let rel = RelativeTime.format(ts) {
                    Text(rel).font(.orbitMeta).foregroundStyle(.secondary)
                }
                if onStop != nil {
                    Button(BgJobCard.stop) { asking = true }
                        .buttonStyle(.plain).font(.orbitMeta).foregroundStyle(.tint)
                        .accessibilityIdentifier("bg-job-stop")
                }
                Image(systemName: expanded ? "chevron.down" : "chevron.right")
                    .font(.orbitMeta).foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
            .onTapGesture(perform: onToggle)
            .orbitConfirmation(BgJobCard.stopConfirm, isPresented: $asking) {
                Button(BgJobCard.stop, role: .destructive) {
                    guard let onStop else { return }
                    Task {
                        do { try await onStop(); stopFailed = nil } catch { stopFailed = APIClient.failureReason(error) }
                    }
                }
                Button("Cancel", role: .cancel) {}
            }
            if let stopFailed {
                Text(stopFailed).font(.orbitMeta).foregroundStyle(.red).padding(.leading, 26)
            }
            // Where a running workflow is, or what a running agent is on — the row's second line.
            if isTask, proc.status == "running", let progress, let line = TaskProgressCopy.trayLine(progress) {
                Text(line).font(.orbitMeta).foregroundStyle(.secondary).lineLimit(1)
                    .padding(.leading, 26)
            }
            if expanded && isTask {
                if let progress {
                    TaskProgressView(progress: progress)
                } else {
                    Text("No progress reported yet.")
                        .font(.orbitMeta).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else if expanded {
                // When a human description supplies the title above, surface the actual command too —
                // otherwise it's lost (web parity: BgShellRow renders `<Pre command prompt>` here).
                if proc.description != nil, let cmd = proc.command {
                    ToolBodyView(kind: .command(cmd))
                }
                if proc.outputTail.isEmpty {
                    Text("No output captured yet — either the process hasn't written any, or the agent hasn't read its .output file.")
                        .font(.orbitMeta).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    CollapsibleMono(text: proc.outputTail)
                        .padding(.horizontal, 9).padding(.vertical, 6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
                }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
    }

    /// Status glyph mirroring web's `BgStatusIcon`. The live spinner is the folded row's own
    /// (`SpinnerGlyph`), so the row keeps its mark when tapped open.
    @ViewBuilder private var statusIcon: some View {
        switch proc.status {
        case "running":   SpinnerGlyph(color: .accentColor)
        case "completed": Image(systemName: "checkmark.circle.fill").font(.orbitLabel).foregroundStyle(.green)
        case "failed":    Image(systemName: "xmark.circle.fill").font(.orbitLabel).foregroundStyle(.red)
        case "killed":    Image(systemName: "stop.circle").font(.orbitLabel).foregroundStyle(.secondary)
        default:          Image(systemName: "minus.circle").font(.orbitLabel).foregroundStyle(.secondary)
        }
    }
}

// MARK: - main checkout bar

/// "● Main checkout  main  3 uncommitted files   Review" — or "Clean · 1 commit not pushed   Push to
/// origin/main". Read from the workspace's heartbeat counts (`MainCheckoutBar`): absent while the
/// checkout is clean with nothing to push, or while an older runner reports no counts; without the
/// runner's capability it still says what it sees, with no buttons. Dirty isn't broken: grey, never red.
struct MainCheckoutBarView: View {
    @Environment(AppModel.self) private var app
    let console: ConsoleModel

    var body: some View {
        let ctx = MainCheckoutContext(app: app, console: console)
        if let workspaceID = ctx.workspaceID,
           let bar = MainCheckoutBar.make(health: ctx.workspace?.repoHealth,
                                          isolationStatus: console.worktree.detail?.isolationStatus,
                                          isolated: ctx.isolated, actionsSupported: ctx.actionsSupported) {
            let model = console.mainCheckout
            HStack(spacing: 8) {
                Button { if ctx.actionsSupported { model.openReview(workspaceID: workspaceID) } } label: {
                    // Whole words first; a phone's narrower row takes the short status, then drops the
                    // label, and only then truncates (the branch never gives way to the status).
                    ViewThatFits(in: .horizontal) {
                        summary(bar, label: true, status: bar.status)
                        summary(bar, label: true, status: bar.shortStatus)
                        summary(bar, label: false, status: bar.shortStatus)
                        summary(bar, label: false, status: bar.shortStatus, truncates: true)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .layoutPriority(1)
                if let review = bar.reviewLabel {
                    WTPillButton(title: review) { model.openReview(workspaceID: workspaceID) }.fixedSize()
                }
                if let push = bar.pushLabel {
                    WTPillButton(title: push, disabled: model.sending) {
                        Task { await model.push(workspaceID: workspaceID); app.refreshMainCheckoutSoon() }
                    }
                    .fixedSize()
                }
            }
            .frame(minHeight: 24)
            .padding(.horizontal, 10).padding(.vertical, 3)
            .composerBandCard()
            .padding(.bottom, .composerBandGap)
            .accessibilityIdentifier("main-checkout-bar")
        }
    }

    private func summary(_ bar: MainCheckoutBar, label: Bool, status: String, truncates: Bool = false) -> some View {
        HStack(spacing: 6) {
            Circle().fill(bar.dirty ? Color.orange : Color.secondary.opacity(0.6))
                .frame(width: 6, height: 6)
            if label {
                Text(MainCheckoutCopy.label).font(.orbitLabel).foregroundStyle(.secondary)
                    .lineLimit(1).fixedSize()
            }
            if let branch = bar.branch {
                Text(branch).font(.orbitMono).lineLimit(1).fixedSize()
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Color.secondary.opacity(0.35)))
            }
            Text(status).font(.orbitLabel).foregroundStyle(.secondary).lineLimit(1)
                .fixedSize(horizontal: !truncates, vertical: false)
            Spacer(minLength: 4)
        }
    }
}
