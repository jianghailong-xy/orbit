import SwiftUI
import OrbitKit

/// Worktree status bar shown directly above the composer, mirroring web's `SessionOutputs`: the
/// branch this session's work lives on (with the `orbit/…-hash` parts dimmed) + its colored `+/−`
/// diff summary, collapsed to one line and expandable to the changed-file list. A git-state-driven
/// primary action — Commit while the worktree is dirty, Merge once it's clean — sits on the right,
/// reflecting the runner's async outcome (Merging…/✓ Merged/✓ In main/Resolve/Retry). For a session
/// whose agent dir isn't a git repo it becomes an amber "not isolated" nudge. Hidden entirely when
/// there's nothing to show. All the decisions live in `WorktreeBarLogic`; this view just renders them.
struct WorktreeBar: View {
    let console: ConsoleModel
    @State private var showDiff = false
    @State private var copied = false

    var body: some View {
        // A CONCRETE container (VStack), not `Group`: the poller `.task` below must attach to a view
        // that is always present. `Group` applies its modifiers to each *child*, so while the bar is
        // hidden its only child is `EmptyView` — the `.task` would land on `EmptyView` (no lifecycle)
        // and never fire, `worktree` would never load, and the bar would never appear. A VStack owns
        // the modifier itself and is always in the tree, so the poller runs regardless of content.
        VStack(spacing: 0) {
            let d = console.worktree.detail
            let files = d?.changedFiles ?? []
            switch WorktreeBarLogic.mode(isolationStatus: d?.isolationStatus, branch: d?.branch,
                                         changedFileCount: files.count) {
            case .hidden:
                EmptyView()
            case .notIsolated:
                nudge
            case .worktree:
                if let d, let branch = d.branch { pill(detail: d, branch: branch, files: files) }
            }
        }
        // Key the poller to the session id so it restarts for the new session when the console is
        // swapped in place (ConsoleView keeps its tree identity across a session switch).
        .task(id: console.sessionID) { await console.worktree.startPolling() }
        .sheet(isPresented: $showDiff) { DiffSheet(console: console) }
    }

    // MARK: - shared-nogit nudge

    private var nudge: some View {
        HStack(spacing: 8) {
            Text("⚠ Shared workDir — not isolated")
                .font(.orbitLabel.weight(.semibold)).foregroundStyle(.orange)
            Spacer(minLength: 4)
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.orange.opacity(0.4)))
        .padding(.horizontal, 12).padding(.top, 4).padding(.bottom, 8)
    }

    // MARK: - worktree pill

    private func pill(detail d: SessionDetail, branch: String, files: [SessionChangedFile]) -> some View {
        let committed = !console.sessionStatus.isLive
        let turnActive = console.sessionStatus == .running
        let primary = WorktreeBarLogic.primary(worktreeDirty: d.worktreeDirty,
                                                committed: committed, turnActive: turnActive)
        let add = files.reduce(0) { $0 + max(0, $1.additions) }
        let del = files.reduce(0) { $0 + max(0, $1.deletions) }

        return HStack(spacing: 8) {
            // The whole branch + stat summary is one tap target that opens the diff (the chevron on
            // the right is the explicit affordance). Copy is the secondary action, so it moves to the
            // long-press (right-click on macOS) context menu — a plain tap can no longer silently
            // copy, and the Commit/Merge control stays its own target so a diff tap can't fire it.
            Button { showDiff = true } label: {
                HStack(spacing: 8) {
                    branchLabel(branch)
                    statView(add: add, del: del, count: files.count, committed: primary == .merge)
                    Spacer(minLength: 4)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .layoutPriority(1)
            .contextMenu { copyBranchButton(branch) }
            .accessibilityHint("Opens the diff")
            .help("View diff")
            // The action button + chevron keep their size (web `flex: none`); the branch/stat
            // truncate first under narrow width.
            switch primary {
            case .commit: WorktreeCommitControl(console: console, detail: d, turnActive: turnActive).layoutPriority(2)
            case .merge:  WorktreeMergeControl(console: console, detail: d, branch: branch).layoutPriority(2)
            case .none:   EmptyView()
            }
            expandButton.layoutPriority(2)
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background(.bar, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.primary.opacity(0.1)))
        .padding(.horizontal, 12).padding(.top, 4).padding(.bottom, 8)
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

    private func statView(add: Int, del: Int, count: Int, committed: Bool) -> some View {
        (Text("+\(add)").foregroundStyle(.green)
            + Text(" −\(del)").foregroundStyle(.red)
            + Text(" · \(count) \(count == 1 ? "file" : "files")\(committed ? " · committed" : "")")
                .foregroundStyle(.secondary))
            .font(.orbitMono)
            .lineLimit(1)
            .truncationMode(.tail)
    }

    private var expandButton: some View {
        Button {
            showDiff = true   // DiffSheet fetches the per-file patches on appear.
        } label: {
            Image(systemName: "chevron.right").font(.orbitLabel.weight(.semibold))
                .foregroundStyle(.secondary).frame(width: 24, height: 24)
        }
        .buttonStyle(.plain)
        .help("View diff")
        .accessibilityLabel("View diff")
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
/// main"; conflict on main/master → "Resolve in session"; other failure → "Retry merge".
private struct WorktreeMergeControl: View {
    let console: ConsoleModel
    let detail: SessionDetail
    let branch: String

    var body: some View {
        let status = detail.mergeStatus
        let targets = detail.mergeTargets ?? []
        let busy = console.worktree.busy
        let defaultTarget = WorktreeBarLogic.defaultTarget(targets: targets,
                                                           agentDefaultTarget: detail.agent?.defaultMergeTarget)

        if status == "merged" {
            let elsewhere = detail.mergeTarget != nil && detail.mergeTarget != "main" && detail.mergeTarget != "master"
            WTChip(title: "✓ Merged" + (elsewhere ? " → \(detail.mergeTarget!)" : ""))
        } else if detail.branchMerged == true && status == nil {
            let landed = detail.mergeTarget
                ?? (targets.contains("main") ? "main" : targets.contains("master") ? "master" : "main")
            WTChip(title: "✓ In \(landed)")
        } else if status == "pending" {
            WTPillButton(title: "Merging…", disabled: true) {}
        } else if status == "conflict" || status == "error" {
            if WorktreeBarLogic.resolvable(mergeStatus: status, mergeTarget: detail.mergeTarget) {
                WTPillButton(title: busy ? "Resuming…" : "Resolve in session", tint: .red, disabled: busy) {
                    Task { await console.worktree.resolveInSession(branch: branch) }
                }
            } else {
                HStack(spacing: 4) {
                    WTPillButton(title: "Retry merge to \(detail.mergeTarget ?? defaultTarget ?? "main")",
                                 tint: .red, disabled: busy) {
                        Task { await console.worktree.merge(target: detail.mergeTarget ?? defaultTarget) }
                    }
                    if !targets.isEmpty { caret(targets: targets, defaultTarget: defaultTarget, tint: .red) }
                }
            }
        } else {
            HStack(spacing: 4) {
                WTPillButton(title: "Merge to \(defaultTarget ?? "main")", disabled: busy) {
                    Task { await console.worktree.merge(target: defaultTarget) }
                }
                if !targets.isEmpty { caret(targets: targets, defaultTarget: defaultTarget, tint: .accentColor) }
            }
        }
    }

    /// The split-button caret: a menu of the repo's other branches to merge into instead.
    private func caret(targets: [String], defaultTarget: String?, tint: Color) -> some View {
        Menu {
            ForEach(targets, id: \.self) { b in
                Button { Task { await console.worktree.merge(target: b) } } label: {
                    if b == defaultTarget { Label(b, systemImage: "checkmark") } else { Text(b) }
                }
            }
        } label: {
            Image(systemName: "chevron.down").font(.orbitMeta.weight(.semibold)).foregroundStyle(tint)
                .padding(.horizontal, 6).padding(.vertical, 4)
                .background(tint.opacity(0.14), in: Capsule())
                .overlay(Capsule().strokeBorder(tint.opacity(0.3)))
        }
        .menuIndicator(.hidden)
        .fixedSize()
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
    @Environment(\.dismiss) private var dismiss
    @State private var branchCopied = false

    var body: some View {
        let files = console.worktree.detail?.changedFiles ?? []
        let branch = console.worktree.detail?.branch
        NavigationStack {
            List(files) { file in
                NavigationLink {
                    DiffFileView(console: console, file: file)
                } label: {
                    DiffFileRow(file: file)
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
        .task { await console.worktree.loadDiff() }
        #if os(macOS)
        .frame(minWidth: 560, minHeight: 420)
        #endif
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

/// One row in the changed-file list: git status letter + path (dir dimmed) + `+/−` stat (or binary).
private struct DiffFileRow: View {
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
private struct DiffFileView: View {
    let console: ConsoleModel
    let file: SessionChangedFile

    // Cap the rendered lines so a huge file doesn't build a giant string; the runner already caps
    // the patch, but a large in-cap diff still gets trimmed for the preview.
    private static let lineCap = 1200

    var body: some View {
        let patch = console.worktree.diff.first { $0.path == file.path }
        ScrollView {
            if file.additions < 0 || file.deletions < 0 {
                placeholder("Binary file — no preview")
            } else if let text = patch?.patch, !text.isEmpty {
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
            } else if console.worktree.busy {
                placeholder("Loading diff…")
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
    private static func colorize(_ patch: String) -> (AttributedString, Bool) {
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
/// approvals — a port of web's `BackgroundShellsTray`. Collapsed it's a one-line header
/// ("Background processes · N running · N total"); tapping it reveals the list, where each row
/// (status · command · id · age) opens as an accordion to show that shell's captured output tail.
struct BackgroundTrayView: View {
    let procs: [BackgroundProc]
    @State private var open = false
    @State private var expandedID: String? = nil

    var body: some View {
        if !procs.isEmpty {
            VStack(spacing: 0) {
                Divider()
                header
                if open {
                    Divider().opacity(0.5)
                    ForEach(procs) { proc in
                        BackgroundRow(proc: proc, expanded: expandedID == proc.id) {
                            withAnimation(.easeOut(duration: 0.12)) {
                                expandedID = expandedID == proc.id ? nil : proc.id
                            }
                        }
                    }
                }
            }
            .background(.bar)
        }
    }

    private var runningCount: Int { procs.filter { $0.status == "running" }.count }

    private var countText: String {
        (runningCount > 0 ? "\(runningCount) running · " : "") + "\(procs.count) total"
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "gearshape.2.fill").font(.orbitMeta).foregroundStyle(.secondary)
            Text("Background processes").font(.orbitLabel.weight(.semibold))
            Text(countText).font(.orbitMeta).foregroundStyle(.secondary)
            Spacer(minLength: 4)
            Image(systemName: open ? "chevron.down" : "chevron.right")
                .font(.orbitMeta.weight(.semibold)).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 12).padding(.vertical, 7)
        .contentShape(Rectangle())
        .onTapGesture { withAnimation(.easeOut(duration: 0.12)) { open.toggle() } }
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(open ? "Hide background processes" : "Show background processes")
    }
}

/// One background-shell row: a folded head (status · command · id · age) that expands to the
/// captured output tail (or an empty-state note). Mirrors web's `BgShellRow`.
private struct BackgroundRow: View {
    let proc: BackgroundProc
    let expanded: Bool
    let onToggle: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                statusIcon.frame(width: 18)
                Text(proc.command ?? proc.id)
                    .font(.orbitMono).lineLimit(1).truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(proc.id).font(.orbitMonoFine).foregroundStyle(.secondary).lineLimit(1)
                if let ts = proc.startedAt, let rel = RelativeTime.format(ts) {
                    Text(rel).font(.orbitMeta).foregroundStyle(.secondary)
                }
                Image(systemName: expanded ? "chevron.down" : "chevron.right")
                    .font(.orbitMeta).foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
            .onTapGesture(perform: onToggle)
            if expanded {
                if proc.outputTail.isEmpty {
                    Text("No output captured yet — the agent hasn't read this process's output.")
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

    /// Status glyph mirroring web's `BgStatusIcon`. Uses `ProgressView` for the live spinner like the
    /// neighbouring tool cards do — safe here since the tray isn't inside the recycling transcript List.
    @ViewBuilder private var statusIcon: some View {
        switch proc.status {
        case "running":   ProgressView().controlSize(.small)
        case "completed": Image(systemName: "checkmark.circle.fill").font(.orbitLabel).foregroundStyle(.green)
        case "failed":    Image(systemName: "xmark.circle.fill").font(.orbitLabel).foregroundStyle(.red)
        case "killed":    Image(systemName: "stop.circle").font(.orbitLabel).foregroundStyle(.secondary)
        default:          Image(systemName: "minus.circle").font(.orbitLabel).foregroundStyle(.secondary)
        }
    }
}
