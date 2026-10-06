import SwiftUI
import OrbitKit

// Batch E (1/2): the Skills directory + the Runners list/detail, both reading the shared
// `RunnersModel` off `AppModel`. Skills grouping comes from the verified OrbitKit `SkillsLogic`.
// SwiftUI is parse-checked only — verify on a Mac.

// MARK: - Skills

/// Skills directory: every runner's skills/commands grouped by owning agent (Shared last),
/// searchable. A browse-only page, so it lives entirely in the middle column.
struct SkillsView: View {
    @Environment(AppModel.self) private var model
    @State private var search = ""

    var body: some View {
        if let runners = model.runners {
            let groups = SkillsLogic.grouped(runners: runners.runners,
                                             agentName: { runners.agentName($0) },
                                             search: search)
            List {
                ForEach(groups) { g in
                    Section {
                        ForEach(g.skills) { SkillRow(item: $0, isSkill: true) }
                        ForEach(g.commands) { SkillRow(item: $0, isSkill: false) }
                    } header: {
                        HStack(spacing: 6) {
                            Text(g.title)
                            Text(g.runnerName).font(.orbitLabel).foregroundStyle(.secondary)
                            if !g.online { Image(systemName: "moon.zzz").font(.orbitMeta).foregroundStyle(.secondary) }
                            Spacer()
                            Text("\(g.count)").font(.orbitLabel).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .orbitRevealSurface()   // macOS: reveal the unified `orbitSurface`
            .searchable(text: $search)
            .modifier(RunnersLoadOverlay(runners: runners, isEmpty: groups.isEmpty,
                                         failedTitle: "Skills couldn't be loaded",
                                         emptyTitle: "No skills", systemImage: "wand.and.stars"))
            .navigationTitle("Skills")
            .task { await runners.load() }
        } else {
            ProgressView()
        }
    }
}

struct SkillRow: View {
    let item: SlashCommandInfo
    let isSkill: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Image(systemName: isSkill ? "wand.and.stars" : "terminal")
                    .font(.orbitMeta).foregroundStyle(.secondary)
                Text("/\(item.name)").font(.callout).fontDesign(.monospaced)
            }
            if let d = item.description, !d.isEmpty {
                Text(d).font(.orbitLabel).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .padding(.vertical, 1)
    }
}

// MARK: - Runners

struct RunnersListView: View {
    @Environment(AppModel.self) private var model
    /// How this list's rows navigate. Defaults to the three-column shape; the compact shell, whose
    /// stack knows its own pushes, passes `.push`.
    var rowNavigation: SessionRowNavigation = .selection
    @State private var addingRunner = false
    @State private var pendingRemoval: Runner?

    var body: some View {
        @Bindable var model = model
        if let runners = model.runners {
            // Runners' stack projection — the record on top — and only where there is a detail
            // column to select into.
            List(selection: rowNavigation == .selection ? $model.selectedRunnerID : nil) {
                Section {
                    ForEach(runners.runners) { r in
                        row(r)
                    }
                    .onMove { moveRunners(runners, from: $0, to: $1) }
                    .onDelete { pendingRemoval = runnerToRemove(runners, at: $0) }
                }
                RunnerAddSection { addingRunner = true }
            }
            .orbitRevealSurface()   // macOS: reveal the unified `orbitSurface`
            .modifier(RunnersLoadOverlay(runners: runners, isEmpty: runners.runners.isEmpty,
                                         failedTitle: "Runners couldn't be loaded",
                                         emptyTitle: nil, systemImage: "desktopcomputer"))
            .modifier(RunnerListEditing(runners: runners, addingRunner: $addingRunner,
                                        pendingRemoval: $pendingRemoval))
            .navigationTitle("Runners")
            .task { await runners.load() }
        } else {
            ProgressView()
        }
    }

    /// One row, wrapped for the container it is in — the three-column `List`'s selection, or the
    /// compact row's own destination on Runners' stack. The row view is the same either way.
    @ViewBuilder private func row(_ r: Runner) -> some View {
        let row = RunnerRow(runner: r, workspaces: model.runners?.agents(forRunner: r.id) ?? [],
                            latestVersion: model.runners?.latestVersion,
                            disclosure: rowNavigation == .push)
        switch rowNavigation {
        case .selection:
            row.tag(r.id)
        case .push:
            // A `Button`, not a `NavigationLink(value:)`: the link's disclosure indicator has no
            // usable hiding place on iOS 17/18 (see `AppModel.push`), so the row draws its own.
            // `Color.primary`, not `.primary`: a button's label otherwise inherits the accent tint,
            // and inside one `.primary` resolves to the tint too.
            Button { model.push(.runnerDetail(runnerID: r.id)) } label: {
                row.foregroundStyle(Color.primary)
            }
        }
    }
}

#if os(iOS)
/// iOS: the runners list surfaced inside Settings, where Runners moved after leaving the drawer rail.
/// A plain push list — each runner pushes its detail within the Settings navigation stack, reusing
/// `RunnerRow`/`RunnerDetailContent` instead of the sidebar's split-view selection. The row pushes the
/// same `NavNode.runnerDetail` frame the Runners section pushes, so the shape of a runner's record is
/// one page in both places. Under the rows, Add Runner.
struct RunnersSettingsList: View {
    @Environment(AppModel.self) private var model
    @State private var addingRunner = false
    @State private var pendingRemoval: Runner?

    var body: some View {
        Group {
            if let runners = model.runners {
                List {
                    Section {
                        ForEach(runners.runners) { r in
                            // The same shape as the Runners section's row — a `Button` pushing the
                            // frame by hand, so the list looks the same in both places
                            // (`AppModel.push`). `Color.primary`: a button's label otherwise
                            // inherits the tint, `.primary` included.
                            Button { model.push(.runnerDetail(runnerID: r.id)) } label: {
                                RunnerRow(runner: r, workspaces: runners.agents(forRunner: r.id),
                                          latestVersion: runners.latestVersion, disclosure: true)
                                    .foregroundStyle(Color.primary)
                            }
                        }
                        .onMove { moveRunners(runners, from: $0, to: $1) }
                        .onDelete { pendingRemoval = runnerToRemove(runners, at: $0) }
                    }
                    RunnerAddSection { addingRunner = true }
                }
                .modifier(RunnersLoadOverlay(runners: runners, isEmpty: runners.runners.isEmpty,
                                             failedTitle: "Runners couldn't be loaded",
                                             emptyTitle: nil, systemImage: "desktopcomputer"))
                .modifier(RunnerListEditing(runners: runners, addingRunner: $addingRunner,
                                            pendingRemoval: $pendingRemoval))
                .task { await runners.load() }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Runners")
    }
}
#endif

/// How a `RunnersModel` list shows its load outcome, the way TasksView shows its own: a failed fetch
/// with nothing in hand says so with Retry instead of reading as an empty list, and rows left from an
/// earlier fetch stay up under a dismissible notice. `LoadFailureLogic.presentation` decides which, so
/// "No runners" / "No skills" only ever follows a fetch that succeeded. A list with something under
/// its rows — the runners lists' Add Runner — passes no empty title, and shows that instead.
private struct RunnersLoadOverlay: ViewModifier {
    let runners: RunnersModel
    /// Whether the list has no rows to show.
    let isEmpty: Bool
    let failedTitle: String
    let emptyTitle: String?
    let systemImage: String

    func body(content: Content) -> some View {
        let presentation = LoadFailureLogic.presentation(runners.loadState, isEmpty: isEmpty)
        return content
            // The notice sits where iOS 26 hangs the pull's spinner, and the phone's lists pull to
            // refresh (see `topInsetClearOfRefresh`).
            .topInsetClearOfRefresh {
                if presentation == .content(showsError: true), let error = runners.errorText {
                    HStack(spacing: 8) {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                        Text(error).font(.orbitLabel).lineLimit(2)
                        Spacer(minLength: 0)
                        Button { runners.errorText = nil } label: { Image(systemName: "xmark") }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("Dismiss error")
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color.orange.opacity(0.12))
                }
            }
            .overlay {
                switch presentation {
                case .loading:
                    ContentUnavailableView("Loading…", systemImage: systemImage)
                case .failed:
                    VStack(spacing: 10) {
                        ContentUnavailableView(failedTitle, systemImage: "wifi.exclamationmark",
                                               description: Text(runners.errorText ?? "Request failed — check your connection."))
                        Button("Retry") { Task { await runners.load() } }
                    }
                case .empty:
                    if let emptyTitle {
                        ContentUnavailableView(emptyTitle, systemImage: systemImage)
                    }
                case .content:
                    EmptyView()
                }
            }
    }
}

/// The list's last card: Add Runner, and what it will ask of the new machine.
private struct RunnerAddSection: View {
    let add: () -> Void

    var body: some View {
        Section {
            Button(RunnerPageCopy.RUNNER_ADD, action: add)
                #if os(macOS)
                .buttonStyle(.link)
                #endif
        } footer: {
            Text(RunnerPageCopy.RUNNER_ADD_FOOTER)
        }
    }
}

/// What both runners lists add around their rows: Add Runner's sheet; removing a runner, which asks
/// first in the words its own page's Remove card says.
private struct RunnerListEditing: ViewModifier {
    let runners: RunnersModel
    @Binding var addingRunner: Bool
    @Binding var pendingRemoval: Runner?

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: $addingRunner) { AddRunnerSheet() }
            .orbitConfirmation({ _ in removalTitle },
                               isPresented: removalAsked, presenting: pendingRemoval) { runner in
                Button(RunnerPageCopy.RUNNER_REMOVE, role: .destructive) {
                    Task { await remove(runner) }
                }
                Button("Cancel", role: .cancel) {}
            } message: { _ in
                Text(RunnerPageCopy.RUNNER_REMOVE_FOOTER)
            }
            .task { await runners.loadReleaseVersion() }
    }

    private var removalAsked: Binding<Bool> {
        Binding(get: { pendingRemoval != nil }, set: { if !$0 { pendingRemoval = nil } })
    }

    private var removalTitle: String {
        guard let runner = pendingRemoval else { return RunnerPageCopy.RUNNER_REMOVE }
        return "Remove “\(RunnerPageFormat.displayName(runner))”?"
    }

    private func remove(_ runner: Runner) async {
        if let failure = await runners.delete(runner.id) { runners.errorText = failure }
    }
}

/// A drag in Edit: the rows move at once, and the server's order settles it.
@MainActor private func moveRunners(_ runners: RunnersModel, from source: IndexSet, to destination: Int) {
    var order = runners.runners
    order.move(fromOffsets: source, toOffset: destination)
    let ids = order.map(\.id)
    Task { await runners.reorder(ids) }
}

/// The row a delete in Edit (or a swipe) names — asked about before anything is removed.
@MainActor private func runnerToRemove(_ runners: RunnersModel, at offsets: IndexSet) -> Runner? {
    guard let index = offsets.first, runners.runners.indices.contains(index) else { return nil }
    return runners.runners[index]
}

/// One runner in a list (ios-list.png): its status dot and name, the slots in use and their bar at the
/// end of the line; under it the hostname and version — or since when it has been offline — and,
/// only when something needs a person, the list's third line in amber or red. Every word of it is
/// `RunnerAttention`'s, the same line the web card and the runner's own page say.
struct RunnerRow: View {
    let runner: Runner
    /// The runner's workspaces: what its attention line is weighed against.
    var workspaces: [Agent] = []
    var latestVersion: String? = nil
    /// Whether the row draws the disclosure a pushing row needs; a selection row has none.
    var disclosure = false
    var now = Date()
    #if os(iOS)
    /// Edit puts the list's own delete and move controls on the row, and a disclosure has no place
    /// beside them — the one a `NavigationLink` draws goes too.
    @Environment(\.editMode) private var editMode
    #endif

    var body: some View {
        let nowMs = RunnerPageFormat.nowMs(now)
        let items = RunnerAttention.runnerAttention(runner: runner, workspaces: workspaces, nowMs: nowMs,
                                                    latestVersion: latestVersion)
        HStack(spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                RunnerStatusDot(presence: RunnerPageFormat.presence(runner, now: now))
                    .alignmentGuide(.firstTextBaseline) { d in d[VerticalAlignment.center] + 5 }
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(RunnerPageFormat.displayName(runner))
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        if let slots = RunnerPageFormat.slots(runner, now: now) {
                            HStack(spacing: 7) {
                                Text(slots.text)
                                    .font(.orbitListSubtitle)
                                    .foregroundStyle(Color.secondary)
                                    .monospacedDigit()
                                RunnerSlotBar(slots: slots)
                            }
                        }
                    }
                    Text(RunnerAttention.runnerListSubtitle(runner, nowMs: nowMs))
                        .font(.orbitListSubtitle)
                        .foregroundStyle(Color.secondary)
                        .lineLimit(1)
                    if let line = RunnerAttention.listAttentionLine(items) {
                        // Not a `Label`: a list gives a label's icon a column of its own, and the
                        // mock's triangle sits right against its words.
                        HStack(alignment: .firstTextBaseline, spacing: 5) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .font(.orbitLabel)
                            Text(line)
                                .lineLimit(2)
                        }
                        .font(.orbitListSubtitle)
                        .foregroundStyle(RunnerInk.attention(RunnerPageFormat.listTone(items) ?? .warn))
                    }
                }
            }
            if showsDisclosure {
                RunnerChevron()
            }
        }
        .padding(.vertical, 2)
    }

    private var showsDisclosure: Bool {
        #if os(iOS)
        disclosure && editMode?.wrappedValue.isEditing != true
        #else
        disclosure
        #endif
    }
}

struct RunnerDetailView: View {
    @Environment(AppModel.self) private var model
    /// The runner to show. The compact stack hands the page the id its own frame carries; the
    /// three-column detail passes nothing and reads the section's stack instead (the same frame).
    var runnerID: String? = nil

    var body: some View {
        // In the three-column shell the record's own pages — an engine's, its name's — take the
        // detail pane in its place, with a way back to it; a stack draws them as pushes of its own.
        switch runnerID == nil ? model.nav.path.last : nil {
        case .runnerEngine(let id, let engine)?:
            RunnerEnginePage(runnerID: id, engine: engine)
                .modifier(RunnerSubpageBack())
        case .runnerName(let id)?:
            RunnerNamePage(runnerID: id)
                .modifier(RunnerSubpageBack())
        default:
            record
        }
    }

    @ViewBuilder private var record: some View {
        if let runners = model.runners, let id = runnerID ?? model.selectedRunnerID,
           let r = runners.runner(id) {
            RunnerDetailContent(runners: runners, runner: r).id(r.id)
        } else {
            ContentUnavailableView("Select a runner", systemImage: "desktopcomputer",
                                   description: Text("Status, capacity, and engines appear here."))
        }
    }
}

/// The three-column pane's way back from a runner's own page to its record: the pane is no stack,
/// so it has no back button of its own.
private struct RunnerSubpageBack: ViewModifier {
    @Environment(AppModel.self) private var model

    func body(content: Content) -> some View {
        content.toolbar {
            ToolbarItem(placement: .navigation) {
                Button { model.nav.pop() } label: {
                    Label("Back", systemImage: "chevron.backward")
                }
            }
        }
    }
}

/// A runner's page (ios-detail.png), in the order the questions come: what it needs from me (Needs
/// Attention), how much it gets (Capacity), what it runs (Engines), where (Workspaces), what it is
/// (About This Runner) — and the two ways to be done with it, each on a card of its own that asks
/// first. iOS and macOS draw the same grouped form.
struct RunnerDetailContent: View {
    let runners: RunnersModel
    let runner: Runner
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    /// Max Concurrent as the stepper shows it, saved when the press lets go.
    @State private var maxConc = 1
    /// A press on the stepper is under way — hold the save until it ends.
    @State private var stepping = false
    /// The limit last sent, so a release and the settle after it save it once.
    @State private var committedMax: Int?
    /// Keep Free as the picker shows it; nil is Off. Saved as it changes.
    @State private var keepFree: Int?
    @State private var seeded = false
    @State private var choosingReserve = false
    @State private var confirmingRotate = false
    @State private var confirmingRemove = false
    /// The token a rotation just minted: shown on this page once, and gone with it.
    @State private var rotatedToken: String?
    @State private var notice: String?

    var body: some View {
        let now = Date()
        let workspaces = runners.agents(forRunner: runner.id)
        let offline = RunnerPageFormat.isOffline(runner, now: now)
        let items = RunnerAttention.runnerAttention(runner: runner, workspaces: workspaces,
                                                    nowMs: RunnerPageFormat.nowMs(now),
                                                    latestVersion: runners.latestVersion)
        Form {
            head(now: now)
            if !items.isEmpty {
                attentionSection(items, now: now)
            }
            capacitySection(workspaces)
            enginesSection(offline: offline, now: now)
            workspacesSection(workspaces)
            aboutSection(now: now)
            rotateSection
            removeSection
        }
        .formStyle(.grouped)
        .orbitRevealSurface()   // macOS: reveal the unified `orbitSurface` behind the grouped form
        .navigationTitle(RunnerPageFormat.displayName(runner))
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .runnerNotice(notice)
        .onAppear(perform: seed)
        .onChange(of: runner.maxConcurrent) { _, value in
            guard !stepping else { return }
            maxConc = value ?? 1
            committedMax = nil
        }
        .onChange(of: runner.minFreeDiskMb) { _, value in
            keepFree = RunnerPageFormat.keepFreeValue(value)
        }
        .onChange(of: keepFree) { _, value in
            guard seeded, value != RunnerPageFormat.keepFreeValue(runner.minFreeDiskMb) else { return }
            saveKeepFree(value)
        }
        // The stepper's release saves; this catches a change that ended without one (a keyboard's
        // arrow on a Mac), once it has settled.
        .task(id: maxConc) {
            try? await Task.sleep(for: .milliseconds(900))
            guard !Task.isCancelled, seeded, !stepping else { return }
            saveMaxConcurrent(maxConc)
        }
        .task {
            await runners.loadReleaseVersion()
            await runners.loadSessionCounts()
        }
        // A machine checks in every 30s: read it again while its page is up, so the page moves with it.
        .task(id: runner.id) {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                guard !Task.isCancelled else { return }
                await runners.load()
                await runners.loadSessionCounts()
            }
        }
        .refreshable {
            await runners.load()
            await runners.loadSessionCounts()
        }
    }

    // MARK: sections, in the page's order

    /// The machine, where it stands and what it is — the Codex pool page's head, with a machine for
    /// its mark.
    @ViewBuilder private func head(now: Date) -> some View {
        let host = RunnerPageFormat.hostLine(runner)
        Section {
            HStack(spacing: 14) {
                RunnerMachineTile(presence: RunnerPageFormat.presence(runner, now: now))
                VStack(alignment: .leading, spacing: 2) {
                    Text(RunnerPageFormat.displayName(runner))
                        .font(.title3.weight(.bold))
                        .lineLimit(2)
                    Text(statusLine(now: now))
                        .font(.orbitListSubtitle)
                        .foregroundStyle(Color.secondary)
                    if !host.isEmpty {
                        Text(host)
                            .font(.orbitListSubtitle)
                            .foregroundStyle(Color.secondary)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 4)
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
        }
    }

    /// Only what needs a person, most severe first, each with what to do about it.
    @ViewBuilder private func attentionSection(_ items: [RunnerAttentionItem], now: Date) -> some View {
        Section {
            ForEach(items.indices, id: \.self) { index in
                let item = items[index]
                RunnerAttentionRow(item: item, detail: attentionText(item, now: now)) {
                    attentionAction(item)
                }
            }
        } header: {
            RunnerSectionHeader(RunnerPageCopy.RUNNER_NEEDS_ATTENTION)
        }
    }

    /// How much it is given: slots, saved when the stepper lets go; the disk it fills; and the reserve
    /// under which task runs stop being sent here.
    @ViewBuilder private func capacitySection(_ workspaces: [Agent]) -> some View {
        Section {
            Stepper(value: $maxConc, in: 1...64, onEditingChanged: steppingChanged) {
                HStack {
                    Text(RunnerPageCopy.RUNNER_MAX_CONCURRENT)
                    Spacer(minLength: 8)
                    Text(verbatim: "\(maxConc)")
                        .foregroundStyle(Color.secondary)
                        .monospacedDigit()
                }
            }
            if let disk = RunnerAttention.runnerDisk(workspaces) {
                diskRow(disk)
            }
            Picker(RunnerPageCopy.RUNNER_KEEP_FREE, selection: $keepFree) {
                ForEach(RunnerPageFormat.keepFreeChoices(runner.minFreeDiskMb), id: \.label) { tier in
                    Text(tier.label).tag(tier.mb)
                }
            }
            .pickerStyle(.menu)
        } header: {
            RunnerSectionHeader(RunnerPageCopy.RUNNER_CAPACITY)
        } footer: {
            Text(RunnerPageCopy.RUNNER_CAPACITY_FOOTER)
        }
    }

    /// What it runs: each engine — a row that opens the engine's page — and the two presses that act
    /// on all of them.
    @ViewBuilder private func enginesSection(offline: Bool, now: Date) -> some View {
        Section {
            if runner.engines == nil {
                Text("This runner hasn’t reported its engines yet.")
                    .foregroundStyle(Color.secondary)
            }
            ForEach(RunnerPageFormat.engines(runner)) { health in
                engineRow(health, offline: offline, now: now)
            }
            if !offline {
                Button(RunnerPageCopy.RUNNER_UPDATE_ENGINES_NOW) { updateEngines() }
                    .disabled(RunnerPageFormat.engineUpdateInFlight(runner.install))
                if let relay = RunnerPageFormat.updateRelayLine(runner.install) {
                    Text(relay)
                        .font(.orbitLabel)
                        .foregroundStyle(Color.secondary)
                }
                Button(RunnerPageCopy.RUNNER_REFRESH_MODEL_LISTS) { refreshModels() }
            }
        } header: {
            RunnerSectionHeader(RunnerPageCopy.RUNNER_ENGINES,
                                trailing: RunnerPageFormat.enginesNote(runner, now: now))
        } footer: {
            Text(offline ? RunnerPageCopy.RUNNER_ENGINES_OFFLINE_FOOTER : RunnerPageCopy.RUNNER_ENGINES_FOOTER)
        }
    }

    /// Where it runs: each workspace and how many of its sessions are running. A row opens the
    /// workspace's sessions; workspaces are added and changed on the web.
    @ViewBuilder private func workspacesSection(_ workspaces: [Agent]) -> some View {
        Section {
            if workspaces.isEmpty {
                Text("No workspaces on this runner yet.")
                    .foregroundStyle(Color.secondary)
            }
            ForEach(workspaces) { workspace in
                Button { openWorkspace(workspace.id) } label: {
                    RunnerWorkspaceRow(workspace: workspace,
                                       running: RunnerPageFormat.runningCount(workspace,
                                                                              counts: runners.sessionCounts))
                        .foregroundStyle(Color.primary)
                        .contentShape(Rectangle())
                }
                .runnerRowButtonStyle()
            }
        } header: {
            RunnerSectionHeader(RunnerPageCopy.RUNNER_WORKSPACES,
                                trailing: workspaces.isEmpty ? nil : "\(workspaces.count)")
        } footer: {
            Text(RunnerPageCopy.RUNNER_WORKSPACES_FOOTER)
        }
    }

    /// What it is. The name is a page of its own; the rest is read-only.
    @ViewBuilder private func aboutSection(now: Date) -> some View {
        Section {
            Button { model.push(.runnerName(runnerID: runner.id)) } label: {
                HStack {
                    Text(RunnerPageCopy.RUNNER_ABOUT_NAME)
                    Spacer(minLength: 8)
                    Text(RunnerPageFormat.displayName(runner))
                        .foregroundStyle(Color.secondary)
                        .lineLimit(1)
                    RunnerChevron()
                }
                .foregroundStyle(Color.primary)
                .contentShape(Rectangle())
            }
            .runnerRowButtonStyle()
            aboutRow(RunnerPageCopy.RUNNER_ABOUT_HOSTNAME, runner.hostname)
            aboutRow(RunnerPageCopy.RUNNER_ABOUT_VERSION,
                     RunnerPageFormat.versionValue(runner, latest: runners.latestVersion))
            aboutRow(RunnerPageCopy.RUNNER_ABOUT_LAST_UPDATE, RunnerPageFormat.lastUpdate(runner))
            if RunnerAttention.runnerCanUpdateNow(runner, nowMs: RunnerPageFormat.nowMs(now)) {
                Button(RunnerPageCopy.RUNNER_UPDATE_RUNNER_NOW) { updateRunner() }
            }
            aboutRow(RunnerPageCopy.RUNNER_ABOUT_RUNS_AS, RunnerPageFormat.runsAsValue(runner))
            aboutRow(RunnerPageCopy.RUNNER_ABOUT_REPOS_FOLDER, runner.reposRoot)
            aboutRow(RunnerPageCopy.RUNNER_ABOUT_LAST_CHECK_IN, RunnerPageFormat.lastCheckIn(runner, now: now))
            aboutRow(RunnerPageCopy.RUNNER_ABOUT_REGISTERED, RunnerPageFormat.registered(runner, now: now))
        } header: {
            RunnerSectionHeader(RunnerPageCopy.RUNNER_ABOUT)
        } footer: {
            if runner.runsAsRoot == true {
                Text(RunnerPageCopy.RUNNER_ROOT_NO_BYPASS)
            }
        }
    }

    /// A new credential for the machine — asked first, and shown here once.
    private var rotateSection: some View {
        Section {
            Button(RunnerPageCopy.RUNNER_ROTATE_TOKEN) { confirmingRotate = true }
                .orbitConfirmation("Rotate token for “\(RunnerPageFormat.displayName(runner))”?",
                                   isPresented: $confirmingRotate) {
                    Button("Rotate Token", role: .destructive) { rotate() }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text(RunnerPageCopy.RUNNER_ROTATE_TOKEN_FOOTER)
                }
            if let token = rotatedToken {
                Text(token)
                    .font(.orbitMono)
                    .textSelection(.enabled)
                Button(RunnerPageCopy.RUNNER_COPY) { copy(token) }
            }
        } footer: {
            Text(runnerStyledText(RunnerPageCopy.RUNNER_ROTATE_TOKEN_FOOTER, code: ["~/.orbit/config.json"]))
        }
    }

    /// Off the account, with its workspaces — asked first.
    private var removeSection: some View {
        Section {
            Button(role: .destructive) { confirmingRemove = true } label: {
                Text(RunnerPageCopy.RUNNER_REMOVE)
                    .frame(maxWidth: .infinity)
            }
            .orbitConfirmation("Remove “\(RunnerPageFormat.displayName(runner))”?",
                               isPresented: $confirmingRemove) {
                Button(RunnerPageCopy.RUNNER_REMOVE, role: .destructive) { remove() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(RunnerPageCopy.RUNNER_REMOVE_FOOTER)
            }
        } footer: {
            Text(RunnerPageCopy.RUNNER_REMOVE_FOOTER)
        }
    }

    // MARK: rows

    /// `Online · 4 of 12 running`, the status word in its colour.
    private func statusLine(now: Date) -> AttributedString {
        let word = RunnerPageFormat.statusWord(runner, now: now)
        return runnerLeadingWord(RunnerPageFormat.statusLine(runner, now: now), word: word,
                                 colour: word == RunnerPageCopy.RUNNER_ONLINE ? RunnerInk.green : Color.secondary)
    }

    private func attentionText(_ item: RunnerAttentionItem, now: Date) -> AttributedString {
        runnerStyledText(RunnerPageFormat.attentionDetail(item, now: now),
                         strong: RunnerPageFormat.attentionNames(item),
                         code: RunnerPageFormat.attentionCode(item))
    }

    @ViewBuilder private func attentionAction(_ item: RunnerAttentionItem) -> some View {
        if let action = item.action {
            attentionButton(action)
                .buttonStyle(RunnerCapsuleButtonStyle())
        }
    }

    @ViewBuilder private func attentionButton(_ action: RunnerAttentionAction) -> some View {
        switch action.kind {
        case .signIn:
            Button(RunnerPageCopy.RUNNER_SIGN_IN) {
                model.push(.runnerEngine(runnerID: runner.id, engine: action.engine ?? ""))
            }
        case .repair:
            Button(RunnerPageCopy.RUNNER_REPAIR) { repair(action.workspaceId) }
        case .setReserve:
            Button(RunnerPageCopy.RUNNER_SET_A_RESERVE) { choosingReserve = true }
                // On the button that asks, so the panel opens against it rather than at the top of
                // the page.
                .orbitConfirmation(RunnerPageCopy.RUNNER_KEEP_FREE, isPresented: $choosingReserve) {
                    ForEach(RunnerAttention.KEEP_FREE_TIERS.filter { $0.mb != nil }, id: \.label) { tier in
                        Button(tier.label) { keepFree = tier.mb }
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text(RunnerPageCopy.RUNNER_CAPACITY_FOOTER)
                }
        case .copyCommand:
            Button { copy(action.command) } label: {
                Label(RunnerPageCopy.RUNNER_COPY_COMMAND, systemImage: "doc.on.doc")
            }
        case .updateEngines:
            Button(RunnerPageCopy.RUNNER_UPDATE_ENGINES_NOW) { updateEngines() }
                .disabled(RunnerPageFormat.engineUpdateInFlight(runner.install))
        case .updateRunner:
            Button(RunnerPageCopy.RUNNER_UPDATE_RUNNER_NOW) { updateRunner() }
        }
    }

    private func diskRow(_ disk: RunnerDisk) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .firstTextBaseline) {
                Text(RunnerPageCopy.RUNNER_DISK)
                Spacer(minLength: 8)
                Text(RunnerPageFormat.diskUsedLine(disk))
                    .font(.orbitListSubtitle)
                    .foregroundStyle(Color.secondary)
            }
            RunnerGauge(fraction: Double(disk.usedPercent) / 100,
                        tint: RunnerPageFormat.diskIsTight(disk, minFreeDiskMb: runner.minFreeDiskMb)
                            ? RunnerInk.full : Color.accentColor,
                        height: 7)
        }
        .padding(.vertical, 4)
    }

    /// An engine the machine has installed opens its page; one it hasn't is only a line.
    @ViewBuilder private func engineRow(_ health: RunnerEngineHealth, offline: Bool, now: Date) -> some View {
        let row = RunnerEngineRow(health: health, runner: runner, offline: offline, now: now)
        if health.installed == true {
            Button { model.push(.runnerEngine(runnerID: runner.id, engine: health.engine)) } label: {
                row.foregroundStyle(Color.primary)
                    .contentShape(Rectangle())
            }
            .runnerRowButtonStyle()
        } else {
            row
        }
    }

    @ViewBuilder private func aboutRow(_ label: String, _ value: String?) -> some View {
        if let value, !value.isEmpty {
            LabeledContent(label, value: value)
        }
    }

    // MARK: presses

    private func seed() {
        guard !seeded else { return }
        maxConc = runner.maxConcurrent ?? 1
        keepFree = RunnerPageFormat.keepFreeValue(runner.minFreeDiskMb)
        seeded = true
    }

    private func steppingChanged(_ editing: Bool) {
        stepping = editing
        if !editing { saveMaxConcurrent(maxConc) }
    }

    private func saveMaxConcurrent(_ value: Int) {
        guard value != (committedMax ?? runner.maxConcurrent ?? 1) else { return }
        committedMax = value
        let id = runner.id
        Task {
            guard let failure = await runners.setMaxConcurrent(id, value) else { return }
            committedMax = nil
            maxConc = runners.runner(id)?.maxConcurrent ?? maxConc
            show(failure)
        }
    }

    private func saveKeepFree(_ value: Int?) {
        let id = runner.id
        Task {
            guard let failure = await runners.setKeepFree(id, value) else { return }
            keepFree = RunnerPageFormat.keepFreeValue(runners.runner(id)?.minFreeDiskMb)
            show(failure)
        }
    }

    private func updateEngines() {
        let id = runner.id
        Task {
            if let failure = await runners.updateEngines(id) { show(failure) }
        }
    }

    private func refreshModels() {
        let id = runner.id
        Task {
            show(await runners.refreshModels(id)
                 ?? "Re-reading this machine’s model lists — the picker updates within a minute.")
        }
    }

    private func updateRunner() {
        let id = runner.id
        Task {
            show(await runners.updateRunner(id) ?? RunnerPageCopy.RUNNER_UPDATE_RUNNER_REQUESTED)
        }
    }

    private func repair(_ workspaceID: String?) {
        guard let workspaceID else { return }
        Task {
            if let failure = await runners.repair(workspaceID) { show(failure) }
        }
    }

    private func rotate() {
        let id = runner.id
        Task {
            switch await runners.rotateToken(id) {
            case .success(let token): rotatedToken = token
            case .failure(let failure): show(failure.reason)
            }
        }
    }

    private func remove() {
        let id = runner.id
        Task {
            if let failure = await runners.delete(id) {
                show(failure)
            } else {
                dismiss()
            }
        }
    }

    /// Its sessions are the workspace's own list, under Settings on a phone: the sheet comes down
    /// first, then the workspace opens the way its drawer row opens it.
    private func openWorkspace(_ id: String) {
        model.settingsPresented = false
        model.openAgent(id)
    }

    private func copy(_ text: String?) {
        guard let text else { return }
        PlatformPasteboard.copyString(text)
        PlatformHaptics.success()
        show("Copied")
    }

    private func show(_ text: String) {
        notice = text
        Task {
            try? await Task.sleep(for: .seconds(3))
            if notice == text { notice = nil }
        }
    }
}
