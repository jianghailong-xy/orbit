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
    @Environment(AppModel.self) private var app
    let console: ConsoleModel
    @State private var showDiff = false
    @State private var copied = false

    var body: some View {
        // A CONCRETE container (VStack), not `Group`, so the `.sheet` below has a stable host that's
        // always in the tree even while the bar's content is hidden (a `Group` applies its modifiers to
        // its current *child* — `EmptyView` when hidden — so the sheet would ride a transient view). The
        // status poll that fills `worktree.detail` is owned by `ConsoleModel` and driven by the app's
        // focus state (see `startStreaming`), NOT a view `.task` here, so it keeps running even when this
        // pushed detail's lifecycle churns on iPhone and freezes an on-screen `.task`.
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
        .padding(.horizontal, 16).padding(.top, 4).padding(.bottom, 8)
    }

    // MARK: - worktree pill

    private func pill(detail d: SessionDetail, branch: String, files: [SessionChangedFile]) -> some View {
        let committed = !console.sessionStatus.isLive
        // Gate Commit/Merge on the session's AUTHORITATIVE control-plane status (what the composer's
        // Stop button reads via `showsInterrupt`), not the stream-derived `sessionStatus`: the latter
        // never reliably reaches `.running` on a cold open of an already-running session (no durable
        // "running" event is replayed), which left Commit enabled — and Merge shown — mid-turn. Fall
        // back to the reconciled stream status only until the session record loads (fresh deep link).
        let turnActive = (app.session(id: console.sessionID)?.status ?? console.sessionStatus) == .running
        let primary = WorktreeBarLogic.primary(worktreeDirty: d.worktreeDirty,
                                                committed: committed, turnActive: turnActive)
        let add = files.reduce(0) { $0 + max(0, $1.additions) }
        let del = files.reduce(0) { $0 + max(0, $1.deletions) }

        return HStack(spacing: 8) {
            // The whole branch + stat summary is the tap target that opens the diff — there's no
            // separate chevron anymore (a lone › sitting right next to the merge caret's ⌄ read as a
            // second dropdown, not "view diff"). Copy is the secondary action, so it moves to the
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
            // The action button keeps its size (web `flex: none`); the branch/stat truncate first
            // under narrow width.
            switch primary {
            case .commit: WorktreeCommitControl(console: console, detail: d, turnActive: turnActive).layoutPriority(2)
            case .merge:  WorktreeMergeControl(console: console, detail: d, branch: branch).layoutPriority(2)
            case .none:   EmptyView()
            }
        }
        // Pin to the same 30pt collapsed-row height as the background tray below (web parity: both
        // bars share `min-height: 30`) so the stack above the composer reads as one system.
        .padding(.horizontal, 10).padding(.vertical, 3).frame(minHeight: 30)
        .background(.bar, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.primary.opacity(0.1)))
        .padding(.horizontal, 16).padding(.top, 4).padding(.bottom, 8)
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
    /// The branch the user picked via the caret — it only re-points the primary button's target; the
    /// merge itself waits for a tap on the primary button. Falls back to the default when the pick is
    /// no longer an offered target.
    @State private var selectedTarget: String? = nil

    var body: some View {
        let status = detail.mergeStatus
        let targets = detail.mergeTargets ?? []
        let busy = console.worktree.busy
        let defaultTarget = WorktreeBarLogic.defaultTarget(targets: targets,
                                                           agentDefaultTarget: detail.agent?.defaultMergeTarget)
        // The user's caret pick re-points the primary button until they merge (falls back if the
        // picked branch is no longer an offered target).
        let picked = selectedTarget.flatMap { targets.contains($0) ? $0 : nil }

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
                let target = picked ?? detail.mergeTarget ?? defaultTarget
                mergeSplit(title: "Retry merge to \(target ?? "main")",
                           tint: .red, busy: busy, primaryTarget: target,
                           targets: targets, currentTarget: target)
            }
        } else {
            let target = picked ?? defaultTarget
            mergeSplit(title: "Merge to \(target ?? "main")",
                       tint: .accentColor, busy: busy, primaryTarget: target,
                       targets: targets, currentTarget: target)
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
                Text(title).font(.orbitLabel.weight(.semibold)).lineLimit(1)
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
            List(filtered, id: \.self) { b in
                Button {
                    dismiss()
                    onPick(b)
                } label: {
                    HStack(spacing: 8) {
                        BranchLabelView(branch: b).lineLimit(1).truncationMode(.middle)
                        Spacer(minLength: 8)
                        if b == currentTarget {
                            Image(systemName: "checkmark").font(.orbitMeta.weight(.semibold))
                                .foregroundStyle(Color.accentColor)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .listStyle(.plain)
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
/// (status · command · age) opens as an accordion to show that shell's captured output tail.
struct BackgroundTrayView: View {
    let procs: [BackgroundProc]
    @State private var open = false
    @State private var expandedID: String? = nil

    var body: some View {
        if !procs.isEmpty {
            VStack(spacing: 0) {
                header
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
                    ViewThatFits(in: .vertical) {
                        rows
                        ScrollView { rows }.frame(maxHeight: 320)
                    }
                }
            }
            // Match the worktree pill's floating-card language (rounded + hairline border + inset) so
            // the stack above the composer reads as one system, not a full-bleed grey strip. The
            // surface is a light translucent tint rather than the `.bar` material, which rendered muddy
            // and border-less — web uses a near-white subtle fill (`--bg-subtle`) here for the crisper look.
            .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.primary.opacity(0.1)))
            .padding(.horizontal, 16).padding(.bottom, 8)
        }
    }

    /// The open tray's accordion rows — one per shell. A computed var so both ViewThatFits
    /// branches render the identical stack.
    private var rows: some View {
        VStack(spacing: 0) {
            ForEach(procs) { proc in
                BackgroundRow(proc: proc, expanded: expandedID == proc.id) {
                    withAnimation(.easeOut(duration: 0.12)) {
                        expandedID = expandedID == proc.id ? nil : proc.id
                    }
                }
            }
        }
    }

    private var runningCount: Int { procs.filter { $0.status == "running" }.count }

    private var countText: String {
        (runningCount > 0 ? "\(runningCount) running · " : "") + "\(procs.count) total"
    }

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

/// One background-shell row: a folded head (status · command · age) that expands to the
/// captured output tail (or an empty-state note). Mirrors web's `BgShellRow`.
private struct BackgroundRow: View {
    let proc: BackgroundProc
    let expanded: Bool
    let onToggle: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                statusIcon.frame(width: 18)
                Text(proc.description ?? proc.command ?? "Background process")
                    .font(.orbitMono).lineLimit(1).truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let ts = proc.startedAt, let rel = RelativeTime.format(ts) {
                    Text(rel).font(.orbitMeta).foregroundStyle(.secondary)
                }
                Image(systemName: expanded ? "chevron.down" : "chevron.right")
                    .font(.orbitMeta).foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
            .onTapGesture(perform: onToggle)
            if expanded {
                // When a human description supplies the title above, surface the actual command too —
                // otherwise it's lost (web parity: BgShellRow renders `<Pre command prompt>` here).
                if proc.description != nil, let cmd = proc.command {
                    ToolBodyView(kind: .command(cmd))
                }
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
