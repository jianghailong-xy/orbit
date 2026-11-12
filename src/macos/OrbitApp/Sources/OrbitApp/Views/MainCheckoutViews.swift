import SwiftUI
import OrbitKit

// Main checkout Git on macOS and iOS (docs/main-checkout-git-contract.md, boards
// docs/mocks/main-checkout-git/01–04, the web's review drawer drawn as a sheet). Every word and rule
// is OrbitKit's `MainCheckoutCopy` / `MainCheckoutBar` / `MainCheckoutCard` / `WorktreeIsolationDialog`;
// these views lay them out. The bar itself is in WorktreeBar.swift.

/// What a console knows about its workspace's main checkout: which workspace, whether this session has
/// a worktree of its own, and whether the runner can act.
@MainActor
struct MainCheckoutContext {
    let workspaceID: String?
    let workspace: Agent?
    /// The session works in a worktree of its own (not Shared).
    let isolated: Bool
    /// The session's own worktree branch.
    let sessionBranch: String?
    let actionsSupported: Bool
    /// The session is working on a turn: a Move into it would be refused (TARGET_BUSY).
    let turnActive: Bool

    init(app: AppModel, console: ConsoleModel) {
        let detail = console.worktree.detail
        let session = app.session(id: console.sessionID)
        let id = detail?.workspace?.id ?? session.flatMap { $0.agent?.id ?? $0.agentId } ?? console.agentID
        workspaceID = id
        workspace = id.flatMap { app.agents?.agent($0) }
        isolated = detail?.isolationStatus == "worktree"
        sessionBranch = detail?.branch
        actionsSupported = workspace?.mainCheckoutActions == true
        turnActive = WorktreeBarLogic.turnActive(status: session?.effectiveRunStatus ?? console.sessionStatus,
                                                 runningSubagents: session?.runningSubagentCount,
                                                 sending: console.sending || console.awaitingReply)
    }
}

/// A git status letter in its board colour: M amber, A green, D red.
struct MainCheckoutStatusLetter: View {
    let status: String
    var body: some View {
        Text(status)
            .font(.orbitMono.weight(.semibold))
            .foregroundStyle(status == "A" ? Color.green : status == "D" ? Color.red : Color.orange)
            .frame(width: 12, alignment: .leading)
    }
}

/// One changed file: letter, path, and its +/− (or "binary").
struct MainCheckoutFileLine: View {
    let file: MainCheckoutFile
    var body: some View {
        HStack(spacing: 8) {
            MainCheckoutStatusLetter(status: file.status)
            Text(file.path).font(.orbitMono).lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 8)
            if file.binary == true {
                Text("binary").font(.orbitMeta).foregroundStyle(.secondary)
            } else {
                if let add = file.additions, add > 0 { Text("+\(add)").font(.orbitMono).foregroundStyle(.green) }
                if let del = file.deletions, del > 0 { Text("−\(del)").font(.orbitMono).foregroundStyle(.red) }
            }
        }
    }
}

// MARK: - board 01: the card

/// "3 files changed in the main checkout during this turn": the files, then the one decision — Move to
/// this worktree, Review and commit, or the ⋯ (save to a rescue branch, ask the agent, leave as is).
/// Without the runner's capability, or once the checkout is clean again, only the words remain.
struct MainCheckoutCardView: View {
    @Environment(AppModel.self) private var app
    let console: ConsoleModel
    let item: MainCheckoutNoticeItem
    let notice: MainCheckoutChangedNotice

    var body: some View {
        let ctx = MainCheckoutContext(app: app, console: console)
        let card = MainCheckoutCard(notice)
        let actions = MainCheckoutCard.showsActions(actionsSupported: ctx.actionsSupported,
                                                    dismissed: console.mainCheckout.dismissedCards.contains(item.id))
        // Moved, saved or gone: the card stays as history, its buttons held and one muted line saying why.
        let handled = MainCheckoutCard.handled(notice, seq: item.seq, in: console.state.items,
                                               health: ctx.workspace?.repoHealth)
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "exclamationmark.circle")
                    .font(.orbitGlyph).foregroundStyle(.orange)
                VStack(alignment: .leading, spacing: 3) {
                    Text(card.title).font(.orbitControl.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    subtitle.font(.orbitLabel).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(12)
            Divider()
            VStack(alignment: .leading, spacing: 5) {
                ForEach(card.visibleFiles) { file in
                    Button { openReview(ctx) } label: { MainCheckoutFileLine(file: file).contentShape(Rectangle()) }
                        .buttonStyle(.plain)
                        .disabled(handled != nil)
                }
                if let more = card.moreFiles { Text(more).font(.orbitLabel).foregroundStyle(.secondary) }
                if let note = card.truncatedNote { Text(note).font(.orbitLabel).foregroundStyle(.secondary) }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(Color.primary.opacity(0.03))
            if actions {
                Divider()
                buttons(ctx, handled: handled)
            } else if let handled {
                Divider()
                handledLine(handled).padding(12)
            }
        }
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.02)))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.secondary.opacity(0.25)))
        .accessibilityIdentifier("main-checkout-card")
    }

    /// "/root/orbit on main, outside …" with the path and branch set in monospace.
    private var subtitle: Text {
        let tail = ", outside this session's worktree. Orbit saw them appear; it can't tell who wrote them."
        var text = Text(notice.root).font(.orbitMono)
        if let branch = notice.branch { text = text + Text(" on ") + Text(branch).font(.orbitMono) }
        return text + Text(tail)
    }

    private func handledLine(_ handled: MainCheckoutCardHandled) -> some View {
        Text(handled.line).font(.orbitLabel).foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("main-checkout-card-handled")
    }

    @ViewBuilder
    private func buttons(_ ctx: MainCheckoutContext, handled: MainCheckoutCardHandled?) -> some View {
        let model = console.mainCheckout
        VStack(alignment: .leading, spacing: 6) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { primary(ctx); review(ctx); more(ctx) }
                VStack(alignment: .leading, spacing: 8) {
                    primary(ctx)
                    HStack(spacing: 8) { review(ctx); more(ctx) }
                }
            }
            .disabled(handled != nil)
            if let handled {
                handledLine(handled)
            } else if ctx.isolated, let branch = ctx.sessionBranch {
                (Text("Copies them onto ") + Text(branch).font(.orbitMono)
                    + Text(", then clears them from the main checkout. A recovery branch is saved first."))
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(12)
        .disabled(model.sending)
    }

    @ViewBuilder
    private func primary(_ ctx: MainCheckoutContext) -> some View {
        if ctx.isolated, let workspaceID = ctx.workspaceID {
            Button(MainCheckoutCopy.moveToThisWorktree) {
                let paths = notice.files.map(\.path)
                Task {
                    if await console.mainCheckout.act(workspaceID: workspaceID, { requestId, from in
                        .move(root: notice.root, fingerprint: notice.fingerprint, files: paths,
                              targetSessionId: console.sessionID, requestId: requestId, from: from)
                    }) { app.refreshMainCheckoutSoon() }
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(ctx.turnActive)
            .help(ctx.turnActive ? MainCheckoutCopy.targetBusy : "")
        }
    }

    private func review(_ ctx: MainCheckoutContext) -> some View {
        Button(MainCheckoutCopy.reviewAndCommit(branch: notice.branch ?? "HEAD")) { openReview(ctx) }
            .buttonStyle(.bordered)
    }

    private func more(_ ctx: MainCheckoutContext) -> some View {
        Menu {
            Button {
                guard let workspaceID = ctx.workspaceID else { return }
                Task {
                    if await console.mainCheckout.act(workspaceID: workspaceID, { requestId, from in
                        .rescue(root: notice.root, fingerprint: notice.fingerprint, requestId: requestId, from: from)
                    }) { app.refreshMainCheckoutSoon() }
                }
            } label: {
                Text(MainCheckoutCopy.saveAndClean)
                Text(MainCheckoutCopy.saveAndCleanHint)
            }
            Button {
                console.composerText = MainCheckoutCopy.askAboutChangesPrompt(root: notice.root,
                                                                             paths: notice.files.map(\.path))
                console.focusRequests &+= 1
            } label: {
                Text(MainCheckoutCopy.askAgent)
                Text(MainCheckoutCopy.askAgentHint)
            }
            Button(MainCheckoutCopy.leaveAsIs) { console.mainCheckout.dismissedCards.insert(item.id) }
        } label: {
            Image(systemName: "ellipsis").font(.orbitGlyph).frame(minWidth: 28, minHeight: 24)
        }
        .menuIndicator(.hidden)
        .fixedSize()
        .accessibilityLabel("More")
    }

    private func openReview(_ ctx: MainCheckoutContext) {
        guard let workspaceID = ctx.workspaceID else { return }
        console.mainCheckout.openReview(workspaceID: workspaceID)
    }
}

// MARK: - board 03: result lines

/// One action's outcome, as the shared builder words it: ✓ or ! , the bold lead, the rest, and the
/// line's link inline (View changes, Push to origin/main, Review again, Cancel, …).
struct MainCheckoutResultRow: View {
    @Environment(AppModel.self) private var app
    let console: ConsoleModel
    let result: MainCheckoutActionResult
    @State private var showingDiff = false

    var body: some View {
        let ctx = MainCheckoutContext(app: app, console: console)
        let target = result.targetSessionId.flatMap { app.session(id: $0) }
        let line = MainCheckoutCopy.resultLine(result, view: .init(sessionId: console.sessionID,
                                                                   targetTitle: target?.title,
                                                                   isolated: ctx.isolated))
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: line.tone == .ok ? "checkmark" : "exclamationmark")
                .font(.orbitLabel.weight(.bold))
                .foregroundStyle(line.tone == .ok ? Color.green : Color.orange)
                .frame(width: 12)
            Text(attributed(line))
                .font(.orbitLabel)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .environment(\.openURL, OpenURLAction { url in
                    perform(url.host ?? "", ctx: ctx)
                    return .handled
                })
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("main-checkout-result")
        .sheet(isPresented: $showingDiff) { DiffSheet(console: console) }
    }

    private func attributed(_ line: MainCheckoutCopy.ResultLine) -> AttributedString {
        var lead = AttributedString(line.lead)
        lead.inlinePresentationIntent = .stronglyEmphasized
        var out = lead + AttributedString(line.rest)
        if let link = line.link, let url = URL(string: "orbit-main-checkout://\(link.action.rawValue)") {
            var label = AttributedString(link.label)
            label.link = url
            out += AttributedString("  ") + label
        }
        return out
    }

    private func perform(_ action: String, ctx: MainCheckoutContext) {
        guard let action = MainCheckoutCopy.LinkAction(rawValue: action) else { return }
        let model = console.mainCheckout
        let workspaceID = ctx.workspaceID ?? model.sentWorkspace[result.requestId]
        let paths = result.paths ?? []
        switch action {
        case .viewChanges:
            showingDiff = true
        case .push:
            guard let workspaceID else { return }
            Task { await model.push(workspaceID: workspaceID); app.refreshMainCheckoutSoon() }
        case .openInNewSession:
            guard let workspaceID, let branch = result.rescueBranch else { return }
            app.openNewSession(inWorkspace: workspaceID, text: MainCheckoutCopy.rescuePrompt(rescueBranch: branch))
        case .reviewAgain:
            guard let workspaceID else { return }
            model.openReview(workspaceID: workspaceID)
        case .askAgentCombine:
            console.composerText = MainCheckoutCopy.combinePrompt(root: result.root, paths: paths)
            console.focusRequests &+= 1
        case .askAgentRebasePush:
            let branch = result.branch ?? "HEAD"
            console.composerText = MainCheckoutCopy.rebasePushPrompt(root: result.root, branch: branch,
                                                                     upstream: result.upstream ?? "origin/\(branch)")
            console.focusRequests &+= 1
        case .cleanUpCheckout:
            guard let workspaceID else { return }
            Task { await model.cleanUp(workspaceID: workspaceID); app.refreshMainCheckoutSoon() }
        case .cancel:
            guard let workspaceID else { return }
            Task { await model.cancel(workspaceID: workspaceID, requestId: result.requestId) }
        }
    }
}

// MARK: - board 02: the review sheet

/// The main checkout's review, the web's drawer as a sheet: the files (each chosen when it opens), the
/// focused file's diff, and the exits — Commit N files to <branch>, Move to a worktree, and the ⋯ with
/// Save to a rescue branch and clean and Ask the agent about it. Read-only without the runner's
/// capability. A phone stacks files over the diff; a Mac sets them side by side.
struct MainCheckoutReviewSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let model: MainCheckoutModel
    let workspaceID: String
    /// The session it was opened from; nil from a workspace's settings.
    var console: ConsoleModel?

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(MainCheckoutCopy.label)
                #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
                #endif
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button { dismiss() } label: { Image(systemName: "xmark") }
                            .accessibilityLabel("Close")
                    }
                }
        }
        #if os(macOS)
        .frame(minWidth: 760, idealWidth: 900, minHeight: 520, idealHeight: 620)
        #endif
        .task(id: workspaceID) { if model.read == nil { await model.load(workspaceID: workspaceID) } }
    }

    @ViewBuilder
    private var content: some View {
        if let read = model.read {
            VStack(spacing: 0) {
                HStack(spacing: 0) {
                    header(read.snapshot)
                    #if os(macOS)
                    // A Mac sheet draws no toolbar ✕: a visible Close, which Esc presses too.
                    Button("Close") { dismiss() }
                        .keyboardShortcut(.cancelAction)
                        .padding(.trailing, 14)
                    #endif
                }
                Divider()
                #if os(macOS)
                HStack(spacing: 0) {
                    fileList(read).frame(width: 280)
                    Divider()
                    diffPane
                }
                #else
                VStack(spacing: 0) {
                    fileList(read).frame(maxHeight: 210)
                    Divider()
                    diffPane
                }
                #endif
                if read.actionsSupported && !read.snapshot.files.isEmpty {
                    Divider()
                    actionBar(read)
                }
            }
        } else if model.loading {
            ProgressView(MainCheckoutCopy.loading).frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            VStack(spacing: 8) {
                Text(MainCheckoutCopy.readFailed).font(.orbitControl.weight(.semibold))
                if let error = model.loadError { Text(error).font(.orbitLabel).foregroundStyle(.secondary) }
                Button("Try again") { Task { await model.load(workspaceID: workspaceID) } }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// root · branch · short head · N uncommitted · Checked … ago.
    private func header(_ s: MainCheckoutSnapshot) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chip(s.root, mono: true)
                chip([s.branch ?? "HEAD", MainCheckoutCopy.shortSha(s.head)].filter { !$0.isEmpty }.joined(separator: " · "),
                     mono: true)
                if s.fileCount > 0 {
                    chip(MainCheckoutCopy.uncommitted(s.fileCount), tint: .orange)
                }
                Text(checked(s.checkedAt)).font(.orbitLabel).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 14).padding(.vertical, 8)
        }
    }

    private func checked(_ iso: String) -> String {
        guard let date = RelativeTime.parse(iso) else { return "" }
        let seconds = max(0, Int(Date().timeIntervalSince(date)))
        return seconds < 60 ? "Checked \(seconds)s ago" : "Checked \(seconds / 60)m ago"
    }

    private func chip(_ text: String, mono: Bool = false, tint: Color = .secondary) -> some View {
        Text(text)
            .font(mono ? .orbitMono : .orbitLabel.weight(.medium))
            .foregroundStyle(tint == .secondary ? Color.primary.opacity(0.75) : tint)
            .lineLimit(1)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(tint.opacity(0.12), in: Capsule())
    }

    private func fileList(_ read: MainCheckoutRead) -> some View {
        let files = read.snapshot.files
        return VStack(alignment: .leading, spacing: 0) {
            Text(MainCheckoutCopy.chooseFiles(chosen: model.selection.paths.count, total: files.count))
                .font(.orbitLabel).foregroundStyle(.secondary)
                .padding(.horizontal, 14).padding(.top, 10).padding(.bottom, 6)
            if files.isEmpty {
                Text(MainCheckoutCopy.noFiles).font(.orbitLabel).foregroundStyle(.secondary)
                    .padding(.horizontal, 14)
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(files) { file in fileRow(file, actions: read.actionsSupported) }
                }
            }
            Spacer(minLength: 0)
            Text(MainCheckoutCopy.notShown)
                .font(.orbitLabel).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 14).padding(.vertical, 8)
        }
    }

    private func fileRow(_ file: MainCheckoutFile, actions: Bool) -> some View {
        let chosen = model.selection.chosen.contains(file.path)
        let focused = model.focusedPath == file.path
        return HStack(spacing: 8) {
            if actions {
                Button { model.selection.toggle(file.path) } label: {
                    Image(systemName: chosen ? "checkmark.square.fill" : "square")
                        .font(.orbitGlyph)
                        .foregroundStyle(chosen ? Color.accentColor : Color.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(file.path)
                .accessibilityValue(chosen ? "Chosen" : "Not chosen")
            }
            MainCheckoutFileLine(file: file)
        }
        .padding(.horizontal, 14).padding(.vertical, 6)
        .background(focused ? Color.accentColor.opacity(0.1) : Color.clear)
        .contentShape(Rectangle())
        .onTapGesture {
            model.focusedPath = file.path
            Task { await model.loadDiff(workspaceID: workspaceID, path: file.path) }
        }
    }

    @ViewBuilder
    private var diffPane: some View {
        ScrollView([.vertical]) {
            VStack(alignment: .leading, spacing: 8) {
                if let path = model.focusedPath {
                    let file = model.read?.snapshot.files.first { $0.path == path }
                    HStack(spacing: 8) {
                        Text(path).font(.orbitMono.weight(.semibold)).lineLimit(1).truncationMode(.middle)
                        if let add = file?.additions, add > 0 { Text("+\(add)").font(.orbitMono).foregroundStyle(.green) }
                        if let del = file?.deletions, del > 0 { Text("−\(del)").font(.orbitMono).foregroundStyle(.red) }
                    }
                    if let diff = model.diffs[path] {
                        if diff.binary {
                            Text(MainCheckoutCopy.binaryFile).font(.orbitLabel).foregroundStyle(.secondary)
                        } else if let patch = diff.patch, !patch.isEmpty {
                            Text(DiffFileView.colorize(patch).0).font(.orbitDiffLine).textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            if diff.patchTruncated == true {
                                Text(MainCheckoutCopy.patchCut).font(.orbitMeta).foregroundStyle(.secondary)
                            }
                        }
                    } else if model.diffLoading.contains(path) {
                        ProgressView().frame(maxWidth: .infinity)
                    }
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: exits

    private func actionBar(_ read: MainCheckoutRead) -> some View {
        @Bindable var model = model
        let s = read.snapshot
        let branch = s.branch ?? "HEAD"
        let chosen = model.selection.paths
        return VStack(alignment: .leading, spacing: 8) {
            if let managed = read.managedBranch {
                Label(MainCheckoutCopy.managedBranchWarning(projectTitle: managed.projectTitle),
                      systemImage: "exclamationmark.triangle")
                    .font(.orbitLabel).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
            TextField(MainCheckoutCopy.commitMessagePlaceholder, text: $model.message, axis: .vertical)
                .lineLimit(1...4)
                .textFieldStyle(.roundedBorder)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { commitButton(read, branch: branch, chosen: chosen); moveMenu(read, chosen: chosen); moreMenu(read, chosen: chosen) }
                VStack(alignment: .leading, spacing: 8) {
                    commitButton(read, branch: branch, chosen: chosen)
                    HStack(spacing: 8) { moveMenu(read, chosen: chosen); moreMenu(read, chosen: chosen) }
                }
            }
        }
        .padding(14)
        .disabled(model.sending)
    }

    private func commitButton(_ read: MainCheckoutRead, branch: String, chosen: [String]) -> some View {
        Button(MainCheckoutCopy.commitButton(chosen: chosen.count, branch: branch)) {
            let message = model.message
            send { requestId, from in
                .commit(root: read.snapshot.root, fingerprint: read.snapshot.fingerprint, files: chosen,
                        message: message, requestId: requestId, from: from)
            }
        }
        .buttonStyle(.borderedProminent)
        .disabled(!model.selection.canCommit(message: model.message))
    }

    /// Sessions of this workspace on a worktree of their own; the one it was opened from first, and any
    /// working on a turn shown but not offered.
    private var targets: [Session] {
        let all = app.sessions.filter { ($0.agent?.id ?? $0.agentId) == workspaceID && ($0.branch?.isEmpty == false) }
        let opened = console?.sessionID
        return all.filter { $0.id == opened } + all.filter { $0.id != opened }
    }

    private func moveMenu(_ read: MainCheckoutRead, chosen: [String]) -> some View {
        Menu {
            if targets.isEmpty { Text(MainCheckoutCopy.noTargets) }
            ForEach(targets) { session in
                let busy = WorktreeBarLogic.turnActive(status: session.effectiveRunStatus,
                                                       runningSubagents: session.runningSubagentCount, sending: false)
                Button {
                    send { requestId, from in
                        .move(root: read.snapshot.root, fingerprint: read.snapshot.fingerprint, files: chosen,
                              targetSessionId: session.id, requestId: requestId, from: from)
                    }
                } label: {
                    Text("\(session.title ?? "Untitled") · \(session.branch ?? "")")
                    if busy { Text(MainCheckoutCopy.targetBusy) }
                    else if session.id == console?.sessionID { Text(MainCheckoutCopy.targetOpenedFrom) }
                }
                .disabled(busy)
            }
        } label: {
            Text(MainCheckoutCopy.moveToAWorktree)
        }
        .fixedSize()
        .disabled(!model.selection.canMove)
    }

    private func moreMenu(_ read: MainCheckoutRead, chosen: [String]) -> some View {
        Menu {
            Button {
                send { requestId, from in
                    .rescue(root: read.snapshot.root, fingerprint: read.snapshot.fingerprint, requestId: requestId, from: from)
                }
            } label: {
                Text(MainCheckoutCopy.saveAndClean)
                Text(MainCheckoutCopy.saveAndCleanHint)
            }
            if let console {
                Button {
                    console.composerText = MainCheckoutCopy.askAboutChangesPrompt(root: read.snapshot.root, paths: chosen)
                    console.focusRequests &+= 1
                    dismiss()
                } label: {
                    Text(MainCheckoutCopy.askAgent)
                    Text(MainCheckoutCopy.askAgentHint)
                }
            }
        } label: {
            Image(systemName: "ellipsis").frame(minWidth: 28, minHeight: 22)
        }
        .menuIndicator(.hidden)
        .fixedSize()
        .accessibilityLabel("More")
    }

    /// Send, and on the server's acceptance close the sheet: the outcome comes back as a line.
    private func send(_ build: @escaping (_ requestId: String, _ from: String?) -> MainCheckoutActionPost) {
        Task {
            if await model.act(workspaceID: workspaceID, build) {
                model.message = ""
                app.refreshMainCheckoutSoon()
                dismiss()
            }
        }
    }
}

// MARK: - board 04: the worktree isolation switch

/// A workspace's Worktree isolation switch. It takes effect at once, as on web; when the main checkout
/// holds something new sessions would no longer see (or still-running worktrees would keep), it says
/// so first. Nothing in the checkout is ever touched by the switch.
struct WorktreeIsolationSwitch: View {
    @Environment(AppModel.self) private var app
    let workspace: Agent
    @State private var on = true
    @State private var dialog: WorktreeIsolationDialog?
    @State private var asking = false
    @State private var reviewing: MainCheckoutModel?

    var body: some View {
        Toggle(isOn: Binding(get: { on }, set: { request($0) })) {
            VStack(alignment: .leading, spacing: 3) {
                Text(WorktreeIsolationDialog.switchLabel)
                Text(WorktreeIsolationDialog.switchDetail)
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .onAppear { on = workspace.enableWorktree ?? true }
        .orbitConfirmation(dialog?.title ?? "", isPresented: $asking) {
            if case .turnOnDirty? = dialog {
                Button(WorktreeIsolationDialog.reviewFiles) { review() }
            }
            if case .turnOnStuck? = dialog {
                Button(WorktreeIsolationDialog.cleanUpCheckout) {
                    let model = app.makeMainCheckoutModel()
                    Task { await model?.cleanUp(workspaceID: workspace.id) }
                }
            }
            Button(dialog?.confirm ?? WorktreeIsolationDialog.turnOn) { apply(dialog.map(turningOn) ?? !on) }
            Button(WorktreeIsolationDialog.cancel, role: .cancel) {}
        } message: {
            Text(dialog?.message ?? "")
        }
        .sheet(item: Binding(get: { reviewing.map(ReviewHandle.init) }, set: { if $0 == nil { reviewing = nil } })) { handle in
            MainCheckoutReviewSheet(model: handle.model, workspaceID: workspace.id)
        }
    }

    private struct ReviewHandle: Identifiable {
        let model: MainCheckoutModel
        var id: ObjectIdentifier { ObjectIdentifier(model) }
    }

    private func turningOn(_ dialog: WorktreeIsolationDialog) -> Bool {
        switch dialog {
        case .turnOnDirty, .turnOnStuck: return true
        case .unseen(let on): return on
        case .turnOff: return false
        }
    }

    private func request(_ want: Bool) {
        guard want != on else { return }
        let next = WorktreeIsolationDialog.make(turningOn: want, health: workspace.repoHealth, workDir: workspace.workDir,
                                                unmergedSessions: app.worktreeSessionCount(inWorkspace: workspace.id))
        if let next {
            dialog = next
            asking = true
        } else {
            apply(want)
        }
    }

    private func apply(_ want: Bool) {
        on = want
        app.setWorktreeIsolation(want, inWorkspace: workspace.id)
    }

    private func review() {
        guard let model = app.makeMainCheckoutModel() else { return }
        reviewing = model
        model.openReview(workspaceID: workspace.id)
    }
}
