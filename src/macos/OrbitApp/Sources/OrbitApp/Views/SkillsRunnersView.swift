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
                    SkillsGroupSection(group: g)
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

/// One agent's skills and commands under a section title. A child view so the Skills list's ForEach
/// draws one group per row and no second ForEach sits under it.
private struct SkillsGroupSection: View {
    let group: SkillGroup

    var body: some View {
        Section {
            ForEach(group.skills) { SkillRow(item: $0, isSkill: true) }
            ForEach(group.commands) { SkillRow(item: $0, isSkill: false) }
        } header: {
            HStack(spacing: 6) {
                Text(group.title)
                Text(group.runnerName).font(.orbitLabel).foregroundStyle(.secondary)
                if !group.online {
                    Image(systemName: "moon.zzz").font(.orbitMeta).foregroundStyle(.secondary)
                }
                Spacer()
                Text("\(group.count)").font(.orbitLabel).foregroundStyle(.secondary)
            }
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

/// The Machines & models page (docs/mocks/infrastructure-page/03-ios.png): the Machines & models section's list
/// on a Mac and an iPad, the section's own page on a phone, and Settings › Machines & models there — what needs
/// a person, the machines (each opening its record; reordered and removed here), then the account pools
/// and the API keys. Every way out stays in the app: an engine is signed in on its page, a machine on its
/// record, a pool on its page — iOS's own; the Mac has none.
///
/// iOS Settings opens it twice, as the web's Settings nav has two groups: Machines (what needs a person
/// about a machine, the machines, Add) and Providers (what needs a person about a pool, the pools, the
/// keys, the model tiers). Everywhere else it is the whole page.
struct RunnersListView: View {
    enum Part { case all, machines, providers }

    @Environment(AppModel.self) private var model
    /// How this list's rows navigate. Defaults to the three-column shape; the compact shell and Settings,
    /// whose stacks know their own pushes, pass `.push`.
    var rowNavigation: SessionRowNavigation = .selection
    /// Which of the page's halves it shows.
    var part: Part = .all
    @State private var addingRunner = false
    @State private var pendingRemoval: Runner?
    /// The clock the waiting terminals are filtered against, so a card folds at its deadline.
    @State private var terminalNow = Date()

    var body: some View {
        @Bindable var model = model
        if let runners = model.runners {
            let lists = MachinesAndModelsLists(model)
            // The managed runner's entry above the machines: for an account with no runner at all,
            // and for an existing account while the server offers it one (`ManagedRunnerLogic.onboarding`,
            // D1). Once mapped it is one machine row instead (D4).
            let managed = runners.loadState.hasLoaded
                ? ManagedRunnerLogic.onboarding(model.managedRunner?.display, runnerCount: runners.runners.count)
                : nil
            let terminals = Terminals.liveRequests(lists.terminalRequests, now: terminalNow)
            // Runners' stack projection — the record on top — and only where there is a detail
            // column to select into.
            List(selection: rowNavigation == .selection ? $model.selectedRunnerID : nil) {
                #if os(iOS)
                if part != .providers, let managed {
                    Section {
                        ManagedRunnerBanner(display: managed, runnerID: model.managedRunner?.status?.runnerId,
                                            confirmsSetup: confirmsSetup, onEnsured: openManagedRunner)
                    }
                }
                #endif
                if !terminals.isEmpty || lists.settled {
                    // The managed runner's heartbeat "offline" is not said of it: its shared state is.
                    let attention = lists.settled ? lists.attention.filter { !isManagedOffline($0) && shows($0) } : []
                    if !attention.isEmpty || !terminals.isEmpty {
                        MachinesAndModelsNeedsYouSection(
                            items: attention, terminals: terminals, ownerRequests: model.ownerRequests,
                            lit: model.terminalRequestToLight, onSaid: { model.showToast($0) },
                            opensPools: opensPools, open: openAttention)
                    }
                }
                if part != .providers {
                    let managedID = model.managedRunner?.display == nil ? nil : model.managedRunner?.status?.runnerId
                    let order = RunnerPageFormat.managedFirst(runners.runners, managedRunnerID: managedID)
                    let pinned = order.first.flatMap { RunnerPageFormat.isManaged($0, managedRunnerID: managedID) ? $0 : nil }
                    let movable = pinned == nil ? order : Array(order.dropFirst())
                    Section {
                        if let pinned {
                            row(pinned, isManaged: true, separates: !movable.isEmpty)
                                .listRowSeparator(.hidden, edges: .bottom)
                        }
                        ForEach(movable) { r in
                            row(r)
                                .listRowSeparator(pinned != nil && r.id == movable.first?.id ? .hidden : .automatic,
                                                  edges: .top)
                        }
                        .onMove { moveRunners(runners, movable: movable, from: $0, to: $1) }
                        .onDelete { offsets in
                            guard let index = offsets.first, movable.indices.contains(index) else { return }
                            pendingRemoval = movable[index]
                        }
                    } header: {
                        RunnerSectionHeader(MachinesAndModels.machines,
                                            trailing: MachinesAndModels.machinesCount(runners.runners))
                    } footer: {
                        Text(MachinesAndModels.machinesDetail)
                    }
                    RunnerAddSection { addingRunner = true }
                }
                if part != .machines {
                    MachinesAndModelsPoolsSection(memberPools: lists.memberPools, ownPools: lists.ownPools,
                                               open: opensPools ? push : nil)
                    MachinesAndModelsKeysSection(keys: lists.keys, balances: model.agents?.deepSeekBalances ?? [:],
                                              cursorModel: MachinesAndModels.cursorModel(lists.runners.filter { $0.online == true }),
                                              open: opensPools ? push : nil, health: AccountHealthRows(runners))
                    if let agents = model.agents {
                        InfrastructureModelTiersSection(agents: agents)
                    }
                }
            }
            .orbitRevealSurface()   // macOS: reveal the unified `orbitSurface`
            .modifier(ManagedRunnerAboveList(display: managed, runnerID: model.managedRunner?.status?.runnerId,
                                             confirmsSetup: confirmsSetup, onEnsured: openManagedRunner))
            .modifier(RunnersLoadOverlay(runners: runners, isEmpty: part != .providers && runners.runners.isEmpty,
                                         failedTitle: "Machines couldn't be loaded",
                                         emptyTitle: nil, systemImage: "desktopcomputer"))
            .modifier(RunnerListEditing(runners: runners, addingRunner: $addingRunner,
                                        pendingRemoval: $pendingRemoval))
            .navigationTitle(title)
            #if os(iOS)
            // The board's phone page under Settings' back button: a centred title, and the Needs
            // you section — the first thing on the page — fully visible under it.
            .navigationBarTitleDisplayMode(.inline)
            #endif
            // Each list is its own read, so they are asked for side by side. A machine checks in every
            // 30s: the machines are read again while the page is up, so where each one stands — its row,
            // and what needs you — moves with it, as a machine's own page does. No event reports a
            // machine checking in, so this keeps its cadence whatever the control stream does — but
            // only while the app can be seen, backing off while reads fail (`ViewPoll`), and the app's
            // own runner snapshot takes each read instead of making its own (`RunnersModel.onRead`).
            .task {
                await runners.load()
                await ViewPoll.run(model, every: 15, inFlight: { 15 }) { await runners.load() }
            }
            .task { await self.model.agents?.reloadPools() }
            .task { await self.model.agents?.loadOwnKeys() }
            .task { await self.model.agents?.loadDeepSeekBalances() }
            .task { await self.model.sharedPools?.load() }
            .task(id: MachinesAndModelsLists.codexPoolIDs(model)) {
                for id in MachinesAndModelsLists.codexPoolIDs(self.model) { await self.model.sharedPools?.loadAccess(id) }
            }
            // The terminals asking to be approved: read every 20 s, and again at their deadline.
            .modifier(TerminalRequestsCurrent(now: $terminalNow))
        } else {
            ProgressView()
        }
    }

    /// One row, wrapped for the container it is in — the three-column `List`'s selection, or the
    /// compact row's own destination on Runners' stack. The row view is the same either way, and the
    /// managed runner's row carries its shared state label instead of the heartbeat's (D4).
    @ViewBuilder private func row(_ r: Runner, isManaged: Bool = false, separates: Bool = false) -> some View {
        let row = VStack(spacing: 6) {
            RunnerRow(runner: r, workspaces: model.runners?.agents(forRunner: r.id) ?? [],
                      latestVersion: model.runners?.latestVersion,
                      managed: ManagedRunnerLogic.row(runnerID: r.id, status: model.managedRunner?.status),
                      isManaged: isManaged,
                      updateAvailable: ManagedRunnerLogic.row(runnerID: r.id, status: model.managedRunner?.status) != nil
                          && ManagedRunnerUpdateLogic.showsDot(model.managedRunner?.status),
                      disclosure: rowNavigation == .push)
            if separates { Divider() }
        }
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

    private var title: String {
        switch part {
        case .all:       return AppSection.runners.title
        case .machines:  return SettingsPage.machines.title
        case .providers: return SettingsPage.providers.title
        }
    }

    /// Whether a Needs you line belongs to the half shown.
    private func shows(_ item: MachinesAndModels.Attention) -> Bool {
        switch part {
        case .all:       return true
        case .machines:  return item.isMachine
        case .providers: return !item.isMachine
        }
    }

    /// A pool's page — and a DeepSeek key's — is pushed where the page is a stack's (iOS); the three-column
    /// pane shows records only.
    private var opensPools: Bool { rowNavigation == .push }

    /// Set up on an account that already has a machine or a workspace asks first (D3); a new account's
    /// one-click landing is unchanged.
    private var confirmsSetup: Bool {
        ManagedRunnerLogic.confirmsSetup(runnerCount: model.runners?.runners.count ?? 0,
                                         workspaceCount: model.agents?.items.count ?? 0)
    }

    /// Where the server's Set up answer lands: the managed runner's own machine page (D1) — pushed on
    /// a stack, selected in the three-column pane — with the machines read again so its row is there.
    private func openManagedRunner(_ id: String) {
        Task { await model.runners?.load() }
        if rowNavigation == .push {
            model.push(.runnerDetail(runnerID: id))
        } else {
            model.selectedRunnerID = id
        }
    }

    private func push(_ page: NavNode) { model.push(page) }

    /// Whether a Needs you line is the heartbeat saying a managed runner is offline: its shared state
    /// (Preparing, Asleep…) is shown instead, on its row.
    private func isManagedOffline(_ item: MachinesAndModels.Attention) -> Bool {
        guard case .offline(let runnerID) = item.kind else { return false }
        return ManagedRunnerLogic.row(runnerID: runnerID, status: model.managedRunner?.status) != nil
    }

    /// A line of Needs you, opened: the machine's record, the pool's page.
    private func openAttention(_ item: MachinesAndModels.Attention) {
        switch item.kind {
        case .offline(let runnerID), .noCliSignedIn(let runnerID), .updating(let runnerID):
            if rowNavigation == .selection {
                model.selectedRunnerID = runnerID
            } else {
                model.push(.runnerDetail(runnerID: runnerID))
            }
        case .poolUnavailable(let poolID, let own):
            model.push(own ? .accountPool(poolID: poolID) : .sharedPool(poolID: poolID))
        }
    }
}

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
/// The managed runner above Machines & models' list on the Mac (`ManagedRunnerLogic.onboarding`). A Mac
/// list is a table that keeps its rows where they were when a row or a top inset that arrives after it
/// has drawn changes its height, so there the banner takes room of its own above the list; on iOS it is
/// the list's first section.
private struct ManagedRunnerAboveList: ViewModifier {
    let display: ManagedRunnerDisplay?
    let runnerID: String?
    let confirmsSetup: Bool
    let onEnsured: ((String) -> Void)?

    func body(content: Content) -> some View {
        #if os(macOS)
        VStack(spacing: 0) {
            if let display {
                ManagedRunnerBanner(display: display, runnerID: runnerID,
                                    confirmsSetup: confirmsSetup, onEnsured: onEnsured)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
            }
            content
        }
        #else
        content
        #endif
    }
}

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
@MainActor private func moveRunners(_ runners: RunnersModel, movable: [Runner], from source: IndexSet, to destination: Int) {
    var order = movable
    order.move(fromOffsets: source, toOffset: destination)
    let ids = order.map(\.id)
    Task { await runners.reorder(ids) }
}

/// One machine in the list (03-ios.png): its status dot and name, the bar of its slots in use at the end
/// of the line — or Offline; under it how many of them run and how many of its engines are signed out,
/// in amber, or where its engines stand (`MachinesAndModels.machineLine`); and, only when something needs a
/// person, the list's third line in amber or red — `RunnerAttention`'s, the line the web card and the
/// machine's own page say.
struct RunnerRow: View {
    let runner: Runner
    /// The runner's workspaces: what its attention line is weighed against.
    var workspaces: [Agent] = []
    var latestVersion: String? = nil
    /// The account's managed runner, as its machine row shows it (D4): the shared short label in
    /// place of the heartbeat's Online/Offline, and the asleep line whole. Nil for every other runner,
    /// and with the feature off.
    var managed: ManagedRunnerRow? = nil
    var isManaged = false
    /// A newer build is available for the managed runner (`ManagedRunnerUpdateLogic.showsDot`).
    var updateAvailable = false
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
                mark
                    .alignmentGuide(.firstTextBaseline) { d in d[VerticalAlignment.center] + 5 }
                if isManaged {
                    Image(systemName: "cloud")
                        .foregroundStyle(Color.accentColor)
                        .accessibilityHidden(true)
                } else {
                    // Every other machine by the OS it reported (docs/mocks/machine-menu-icons, A).
                    MachineOSMark(runner: runner)
                }
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(RunnerPageFormat.displayName(runner))
                            .fontWeight(isManaged ? .semibold : nil)
                            .lineLimit(1)
                        if updateAvailable {
                            // An older build is running: the machine row's update dot.
                            Circle()
                                .fill(Color.accentColor)
                                .frame(width: 7, height: 7)
                                .accessibilityLabel(RunnerPageCopy.MANAGED_UPDATE_ROW_TITLE)
                                .accessibilityIdentifier("runner-update-dot")
                        }
                        Spacer(minLength: 8)
                        if let managed {
                            Text(managed.label)
                                .font(.orbitListSubtitle)
                                .foregroundStyle(managed.ink)
                                .lineLimit(1)
                        } else if let slots = RunnerPageFormat.slots(runner, now: now) {
                            RunnerSlotBar(slots: slots)
                                .alignmentGuide(.firstTextBaseline) { d in d[VerticalAlignment.center] + 4 }
                        } else if RunnerPageFormat.isOffline(runner, now: now) {
                            Text(RunnerPageCopy.RUNNER_OFFLINE)
                                .font(.orbitListSubtitle)
                                .foregroundStyle(Color.secondary)
                        }
                    }
                    // An asleep managed runner says when it wakes, whole — never cut to one line.
                    if let detail = managed?.detail {
                        Text(detail)
                            .font(.orbitListSubtitle)
                            .foregroundStyle(Color.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    } else {
                        Text(MachinesAndModels.machineLine(runner, now: now))
                            .font(.orbitListSubtitle)
                            .foregroundStyle(Color.secondary)
                            .lineLimit(1)
                    }
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

    /// The state mark: the managed runner's shared tone — a spinner while it moves by itself, grey
    /// asleep, green ready, orange when it needs a person — else the heartbeat's dot.
    @ViewBuilder private var mark: some View {
        if let managed {
            if managed.tone == .progress {
                ProgressView().controlSize(.small)
            } else {
                Circle()
                    .fill(managed.ink)
                    .frame(width: 9, height: 9)
                    .padding(2.5)
                    .background(Circle().fill(managed.ink.opacity(0.2)))
            }
        } else {
            RunnerStatusDot(presence: RunnerPageFormat.presence(runner, now: now), ringed: true)
        }
    }

    private var showsDisclosure: Bool {
        #if os(iOS)
        disclosure && editMode?.wrappedValue.isEditing != true
        #else
        disclosure
        #endif
    }
}

extension ManagedRunnerRow {
    /// The row's ink for its tone: green ready, orange needing a person, grey everything that is
    /// merely asleep or on its way (asleep is never the colour of a fault).
    var ink: Color {
        switch tone {
        case .ready: return RunnerInk.green
        case .attention: return RunnerInk.amber
        case .idle, .progress: return Color.secondary
        }
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
            // A new account with no machine lands here: the welcome card (docs/mocks/new-user-onboarding).
            NoMachineWelcomeGate {
                ContentUnavailableView("Select a runner", systemImage: "desktopcomputer",
                                       description: Text("Status, capacity, and engines appear here."))
            }
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
/// Attention), how busy the machine is (Resources), how much it gets (Capacity), what it runs
/// (Engines), where (Workspaces), what it is (About This Runner) — and the two ways to be done with it, each on a card of its own that asks
/// first. iOS and macOS draw the same grouped form.
struct RunnerDetailContent: View {
    let runners: RunnersModel
    let runner: Runner
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var hSize
    #endif

    /// Max Concurrent's sheet, and the limit its stepper holds while open — saved on Save.
    @State private var editingMax = false
    @State private var maxDraft = 1
    /// Keep Free as the picker shows it; nil is Off. Saved as it changes.
    @State private var keepFree: Int?
    @State private var seeded = false
    @State private var choosingReserve = false
    @State private var confirmingRotate = false
    @State private var confirmingRemove = false
    /// The postponed Update card's Update Now… asks first (a runner without `self-update-now/v1`).
    @State private var confirmingUpdateNow = false
    /// A Fix with an agent press is on its way: its button holds until the list read after it.
    @State private var fixPressing = false
    /// The token a rotation just minted: shown on this page once, and gone with it.
    @State private var rotatedToken: String?
    /// The approved terminal whose Revoke is up: its own row asks, so only that one's question is ever open.
    @State private var pendingRevokeTerminal: Terminal?
    @State private var notice: String?

    var body: some View {
        let now = Date()
        let workspaces = runners.agents(forRunner: runner.id)
        let offline = RunnerPageFormat.isOffline(runner, now: now)
        // When this machine is the account's managed runner: its state in the shared words, its
        // banner on top (D4), and — before it first reports — no readings or engines to show.
        let managed = managedRow
        let managedDisplay = self.managedDisplay
        let managedWaiting = managed.map {
            $0.kind != .available && (runner.version?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "").isEmpty
        } ?? false
        let items = RunnerAttention.runnerAttention(runner: runner, workspaces: workspaces,
                                                    nowMs: RunnerPageFormat.nowMs(now),
                                                    latestVersion: runners.latestVersion,
                                                    managed: managed != nil)
            // The managed runner's heartbeat "offline" card is not repeated beside its shared state.
            .filter { !(managed != nil && $0.kind == .offline) }
        Form {
            head(now: now)
            if let managedDisplay, managedDisplay.kind != .available {
                Section {
                    ManagedRunnerBanner(display: managedDisplay, runnerID: runner.id)
                }
            }
            // The terminals asking to be approved on this machine (board ①): its own cards under
            // the title, drawn from the same read as Machines & models' Needs you section.
            TerminalRequestsSection(runnerID: runner.id, onSaid: show)
            // A managed runner that has not reported yet has no release, readings or engines to show:
            // no Update card, and one quiet line where Resources and Engines would be.
            if managed != nil, let managedRunner = model.managedRunner {
                ManagedRunnerUpdateSection(managedRunner: managedRunner, onNotice: show)
            } else if !managedWaiting, let card = RunnerPageFormat.updateCard(runner, now: now) {
                updateSection(card)
            }
            if !items.isEmpty {
                attentionSection(items, now: now)
            }
            if managedWaiting {
                managedWaitingSection(RunnerPageCopy.RUNNER_RESOURCES)
                capacitySection(now: now)
                managedWaitingSection(RunnerPageCopy.RUNNER_ENGINES)
            } else {
                resourcesSection(workspaces, now: now)
                capacitySection(now: now)
                enginesSection(offline: offline, now: now)
            }
            workspacesSection(workspaces)
            terminalsSection(now: now)
            aboutSection(now: now)
            rotateSection
            removeSection
        }
        .formStyle(.grouped)
        .orbitRevealSurface()   // macOS: reveal the unified `orbitSurface` behind the grouped form
        .navigationTitle(RunnerPageFormat.displayName(runner, managedRunnerID: managedRow?.runnerID))
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .runnerNotice(notice)
        .onAppear(perform: seed)
        .onChange(of: runner.minFreeDiskMb) { _, value in
            keepFree = RunnerPageFormat.keepFreeValue(value)
        }
        .onChange(of: keepFree) { _, value in
            guard seeded, value != RunnerPageFormat.keepFreeValue(runner.minFreeDiskMb) else { return }
            saveKeepFree(value)
        }
        .task {
            await runners.loadReleaseVersion()
            await runners.loadSessionCounts()
        }
        // The machine's approved terminals: read when the page opens, and again when the server says
        // they changed (`terminals.changed`) — an approval or a revoke lands on this section at once.
        .task { await model.terminals?.load() }
        // A machine checks in every 30s: read it again while its page is up, so the page moves with it
        // — while the app can be seen (`ViewPoll`).
        .task(id: runner.id) {
            await ViewPoll.run(model, every: 15, inFlight: { 15 }) {
                await runners.load()
                await runners.loadSessionCounts()
            }
        }
        // Resources asks again every heartbeat while the machine is online, once when it is not, and
        // never for a runner that reads none (MachineResources).
        .task(id: "\(runner.id)|\(offline)|\(MachineResources.reports(runner))") {
            guard MachineResources.reports(runner) else { return }
            await runners.loadResources(runner.id)
            guard !offline else { return }
            await ViewPoll.run(model, every: MachineResources.pollSeconds,
                               inFlight: { MachineResources.pollSeconds }) {
                await runners.loadResources(runner.id)
            }
        }
        .refreshable {
            await runners.load()
            await runners.loadSessionCounts()
        }
    }

    // MARK: sections, in the page's order

    /// The machine, where it stands and what it is — the Codex pool page's head, with a machine for
    /// its mark. The managed runner's state is the shared short label (Asleep, never Offline), in its
    /// tone's colour.
    @ViewBuilder private func head(now: Date) -> some View {
        // The country its IP is in, ahead of the host and version.
        let host = [RunnerPageFormat.location(runner), RunnerPageFormat.hostLine(runner, managed: managedRow != nil)]
            .compactMap { $0?.isEmpty == false ? $0 : nil }
            .joined(separator: RunnerPageCopy.RUNNER_LINE_SEPARATOR)
        Section {
            HStack(spacing: 14) {
                RunnerMachineTile(presence: RunnerPageFormat.presence(runner, now: now))
                VStack(alignment: .leading, spacing: 2) {
                    Text(RunnerPageFormat.displayName(runner, managedRunnerID: managedRow?.runnerID))
                        .font(.title3.weight(.bold))
                        .lineLimit(2)
                    if let managed = managedRow {
                        Text(managed.label)
                            .font(.orbitListSubtitle)
                            .foregroundStyle(managed.ink)
                    } else {
                        Text(statusLine(now: now))
                            .font(.orbitListSubtitle)
                            .foregroundStyle(Color.secondary)
                    }
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

    /// This machine as the managed runner's row, when it is the account's managed runner (D4): nil for
    /// any other runner, and with the feature off.
    private var managedRow: ManagedRunnerRow? {
        ManagedRunnerLogic.row(runnerID: runner.id, status: model.managedRunner?.status)
    }

    /// The managed runner's shared display for this machine's page: nil for any other runner, and
    /// with the feature off.
    private var managedDisplay: ManagedRunnerDisplay? {
        guard let status = model.managedRunner?.status, let id = status.runnerId,
              PublicID.storageKey(id) == PublicID.storageKey(runner.id) else { return nil }
        return ManagedRunnerLogic.display(status)
    }

    /// A managed runner that has not reported yet: one quiet sentence where a section would be, not
    /// controls for a machine still being started.
    private func managedWaitingSection(_ title: String) -> some View {
        Section {
            Text(ManagedRunnerCopy.notReported)
                .foregroundStyle(Color.secondary)
        } header: {
            RunnerSectionHeader(title)
        }
    }

    /// The Update card (board 4): a release this runner is behind, in the phase it reports — amber
    /// while it holds work back or restarts, and Updated for a day after. Later ▾ while draining;
    /// Change ▾ once postponed. Update Now… (`RunnerUpdateNowControl`) while available, draining or
    /// postponed for a runner that declares `self-update-now/v1`; one without it keeps the postponed
    /// card's Update Now…, which asks for Update Runner Now.
    /// One turn the update waits for: its session's title, and how long it has run when it says.
    /// The turn is the row the section's ForEach draws, so that closure holds no branch.
    private func updateTurnRow(_ turn: RunnerPageFormat.UpdateCard.Turn) -> some View {
        Button { openSession(turn.id) } label: {
            HStack(alignment: .firstTextBaseline) {
                Text(turn.title)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 8)
                if let running = turn.running {
                    Text(running)
                        .font(.orbitLabel)
                        .foregroundStyle(Color.secondary)
                        .lineLimit(1)
                }
                RunnerChevron()
            }
            .foregroundStyle(Color.primary)
            .contentShape(Rectangle())
        }
        .runnerRowButtonStyle()
    }

    @ViewBuilder private func updateSection(_ card: RunnerPageFormat.UpdateCard) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline) {
                    Text(card.title)
                        .fontWeight(.semibold)
                    Spacer(minLength: 8)
                    Text(card.tag)
                        .font(.orbitLabel)
                        .foregroundStyle(card.warn ? RunnerInk.amber : Color.secondary)
                        .lineLimit(1)
                }
                if !card.body.isEmpty {
                    Text(card.body)
                        .foregroundStyle(Color.secondary)
                }
                if let label = card.progressLabel {
                    Text(label)
                        .font(.orbitLabel)
                        .foregroundStyle(Color.secondary)
                        .padding(.top, 4)
                    ProgressView(value: card.progress ?? 0)
                        .tint(RunnerInk.amber)
                }
            }
            .padding(.vertical, 4)
            .listRowBackground(card.warn ? Color.orange.opacity(0.08) : nil)
            // The turns it waits for (board 4): each opens its session.
            ForEach(card.turns, id: \.id) { turn in
                updateTurnRow(turn)
            }
            if card.phase == "available", RunnerUpdateNow.offered(runner) {
                RunnerUpdateNowControl(runnerID: runner.id, machine: RunnerPageFormat.displayName(runner),
                                       onNotice: show)
            }
            if card.phase == "draining" || card.phase == "postponed" {
                HStack(spacing: 8) {
                    RunnerUpdateLaterControl(runnerID: runner.id, version: runner.selfUpdate?.targetVersion,
                                             machine: RunnerPageFormat.displayName(runner),
                                             change: card.phase == "postponed")
                    if RunnerUpdateNow.offered(runner) {
                        RunnerUpdateNowControl(runnerID: runner.id, machine: RunnerPageFormat.displayName(runner),
                                               onNotice: show)
                    } else if card.phase == "postponed" {
                        Button(RunnerPageCopy.RUNNER_UPDATE_NOW) { confirmingUpdateNow = true }
                            .buttonStyle(.bordered)
                            .accessibilityIdentifier("runner-update-now")
                    }
                }
                .orbitConfirmation(RunnerPageCopy.runnerUpdateNowConfirmTitle(version: runner.selfUpdate?.targetVersion ?? ""),
                                   isPresented: $confirmingUpdateNow) {
                    Button(RunnerPageCopy.RUNNER_UPDATE_NOW_CONFIRM) { updateRunner() }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text(RunnerPageCopy.RUNNER_UPDATE_NOW_CONFIRM_BODY)
                }
            }
        }
    }

    /// A turn the Update card names: its conversation, after the Settings sheet comes down.
    private func openSession(_ id: String) {
        model.settingsPresented = false
        model.route(to: .session(id))
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

    /// The machine's CPU, memory and disk, each with its last hour (docs/mocks/runner-resource-monitor):
    /// three tiles side by side, stacked as rows on a phone.
    @ViewBuilder private func resourcesSection(_ workspaces: [Agent], now: Date) -> some View {
        let answer = runners.resources[runner.id]
        let section = MachineResources.section(runner: runner, answer: answer,
                                               workspaceDisk: RunnerAttention.runnerDisk(workspaces), now: now)
        let draw = { (tile: MachineResources.Tile) in
            RunnerResourceTile(tile: tile, line: section.showsLines
                ? MachineResources.line(answer?.samples ?? [], kind: tile.kind, endMs: section.endMs) : nil)
        }
        Section {
            #if os(iOS)
            if hSize == .compact {
                ForEach(section.tiles) { draw($0).padding(.vertical, 6) }
            } else {
                resourceTilesInARow(section, draw)
            }
            #else
            resourceTilesInARow(section, draw)
            #endif
        } header: {
            RunnerResourcesHeader(note: section.note, dot: section.dot)
        }
    }

    private func resourceTilesInARow(_ section: MachineResources.Section,
                                     _ draw: @escaping (MachineResources.Tile) -> RunnerResourceTile) -> some View {
        HStack(alignment: .top, spacing: 16) {
            ForEach(section.tiles) { tile in
                if tile.kind != section.tiles.first?.kind { Divider() }
                draw(tile)
            }
        }
        .padding(.vertical, 6)
    }

    /// How much it is given: slots, saved when the stepper lets go; and the reserve under which task
    /// runs stop being sent here.
    @ViewBuilder private func capacitySection(now: Date) -> some View {
        Section {
            // A meter: the name, `3 of 16 running` and Edit on a line, a bar of the slots
            // taken across the row under them (online only), amber once all are. Edit opens the sheet
            // that changes the limit.
            let slots = RunnerPageFormat.slots(runner, now: now)
            let limit = runner.maxConcurrent ?? 1
            VStack(alignment: .leading, spacing: 9) {
                HStack(alignment: .firstTextBaseline) {
                    Text(RunnerPageCopy.RUNNER_MAX_CONCURRENT)
                    Spacer(minLength: 8)
                    Text(verbatim: slots.map { RunnerPageCopy.runnerRunningOf(active: $0.active, max: $0.max) } ?? "\(limit)")
                        .font(.orbitListSubtitle)
                        .foregroundStyle(Color.secondary)
                        .monospacedDigit()
                    Button(RunnerPageCopy.RUNNER_EDIT) {
                        maxDraft = limit
                        editingMax = true
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("\(RunnerPageCopy.RUNNER_EDIT) \(RunnerPageCopy.RUNNER_MAX_CONCURRENT)")
                }
                if let slots {
                    RunnerGauge(fraction: slots.fraction, tint: slots.full ? RunnerInk.full : Color.accentColor, height: 7)
                }
            }
            .padding(.vertical, slots == nil ? 0 : 4)
            .sheet(isPresented: $editingMax) { maxConcurrentSheet }
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

    /// Max Concurrent's sheet: the limit on a stepper, what it means, and Cancel or Save.
    private var maxConcurrentSheet: some View {
        NavigationStack {
            Form {
                Section {
                    Stepper(value: $maxDraft, in: 1...64) {
                        HStack {
                            Text(RunnerPageCopy.RUNNER_MAX_CONCURRENT)
                            Spacer(minLength: 8)
                            Text(verbatim: "\(maxDraft) \(RunnerPageCopy.RUNNER_MAX_CONCURRENT_UNIT)")
                                .foregroundStyle(Color.secondary)
                                .monospacedDigit()
                        }
                    }
                } footer: {
                    Text(RunnerPageCopy.RUNNER_MAX_CONCURRENT_HINT)
                }
            }
            .formStyle(.grouped)
            .navigationTitle(RunnerPageCopy.RUNNER_MAX_CONCURRENT)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { editingMax = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        editingMax = false
                        saveMaxConcurrent(maxDraft)
                    }
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 380, minHeight: 180)
        #else
        .presentationDetents([.medium])
        #endif
    }

    /// What it runs: each engine — a row that opens the engine's page — and the two presses that act
    /// on all of them.
    @ViewBuilder private func enginesSection(offline: Bool, now: Date) -> some View {
        Section {
            if runner.engines == nil {
                Text("This runner hasn’t reported its engines yet.")
                    .foregroundStyle(Color.secondary)
            }
            // Cursor CLI's row once a runner of the account knows it — on this machine too if it predates it.
            ForEach(RunnerPageFormat.engines(runner, fleet: runners.runners)) { health in
                engineRow(health, offline: offline, now: now)
            }
            if !offline {
                Button(RunnerPageCopy.RUNNER_UPDATE_ENGINES_NOW) { updateEngines() }
                    .disabled(RunnerPageFormat.engineUpdateInFlight(runner.install))
                let relay = RunnerPageFormat.updateRelayLines(runner.install)
                if !relay.isEmpty {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(Array(relay.enumerated()), id: \.offset) { _, line in
                            Text(line.text)
                                .font(.orbitLabel)
                                .foregroundStyle(line.failed ? RunnerInk.red : Color.secondary)
                        }
                    }
                }
                // A failed line: an agent can be sent to fix it, under the report
                // (docs/mocks/engine-update-fix-with-agent/03-mobile.png).
                if let fix = RunnerAgentFixLogic.engineUpdateState(runner) {
                    VStack(alignment: .leading, spacing: 6) {
                        RunnerAgentFixButton(state: fix, pressing: fixPressing) {
                            fixWithAnAgent(RunnerAgentFixTarget(kind: .engineUpdateFailed, engine: nil))
                        }
                        RunnerAgentFixLine(state: fix) { openSession($0) }
                    }
                }
                Button(RunnerPageCopy.RUNNER_REFRESH_MODEL_LISTS) { refreshModels() }
            }
        } header: {
            RunnerSectionHeader(RunnerPageCopy.RUNNER_ENGINES,
                                trailing: RunnerPageFormat.enginesNote(runner, now: now))
        } footer: {
            // A machine blocked for the Claude region says why under its engines, and where Claude's
            // connection came out (board 03's group footnote) — not that a session spends a
            // subscription signed in here, which its Claude ones don't.
            if let region = RunnerPageFormat.claudeRegionNote(runner, now: now) {
                ClaudeRegionNoteView(region: region, offline: offline)
            } else {
                Text(RunnerPageFormat.enginesFooter(runner, fleet: runners.runners, offline: offline))
            }
        }
    }

    /// Where it runs: each workspace and how many of its sessions are running. A row opens the
    /// workspace's sessions; with none yet, the way in is a session (board rule 12).
    @ViewBuilder private func workspacesSection(_ workspaces: [Agent]) -> some View {
        Section {
            if workspaces.isEmpty {
                Text(MachineSetupCopy.machineEmptyHere(machine: RunnerPageFormat.displayName(runner)))
                    .foregroundStyle(Color.secondary)
                Button(MachineSetupCopy.START_A_SESSION) { startSession() }
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
            // One more workspace on this machine (docs/mocks/new-workspace-form/02-apple-entry, owner A). With none yet,
            // Start a session above is the way to its first.
            if !workspaces.isEmpty {
                Button { newWorkspace() } label: {
                    Label(NewWorkspaceCopy.NEW_WORKSPACE, systemImage: "plus.circle")
                        .foregroundStyle(Color.accentColor)
                        .contentShape(Rectangle())
                }
                .runnerRowButtonStyle()
                .accessibilityIdentifier("machine-new-workspace")
            }
        } header: {
            RunnerSectionHeader(RunnerPageCopy.RUNNER_WORKSPACES,
                                trailing: workspaces.isEmpty ? nil : "\(workspaces.count)")
        } footer: {
            if !workspaces.isEmpty {
                Text(MachineSetupCopy.RUNNER_WORKSPACES_TAP)
            }
        }
    }

    /// This machine's approved terminals (docs/mocks/terminals-on-machine-page/01-board.html ②③): the account's
    /// live terminals filtered to it, newest approval first, each with Revoke, which asks first in main's words.
    /// Nothing at all while it has none.
    @ViewBuilder private func terminalsSection(now: Date) -> some View {
        let terminals = Terminals.machineTerminals(model.terminals?.terminals ?? [], on: runner.id)
        if !terminals.isEmpty {
            Section {
                ForEach(terminals) { terminal in
                    terminalRow(terminal, now: now)
                }
            } header: {
                VStack(alignment: .leading, spacing: 4) {
                    RunnerSectionHeader(Terminals.title)
                    Text(Terminals.machineHint)
                        .font(.orbitListSubtitle)
                        .foregroundStyle(Color.secondary)
                        .textCase(nil)
                }
            }
        }
    }

    /// One approved terminal: when it was approved, last used · expires, and Revoke. No machine name —
    /// the page is the machine.
    private func terminalRow(_ terminal: Terminal, now: Date) -> some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(Terminals.approvedLine(terminal))
                Text(Terminals.usedAndExpiresLine(terminal, now: now))
                    .font(.orbitListSubtitle)
                    .foregroundStyle(Color.secondary)
            }
            .accessibilityElement(children: .combine)
            Spacer(minLength: 8)
            Button(Terminals.revoke, role: .destructive) { pendingRevokeTerminal = terminal }
                .controlSize(.small)
                .disabled(model.terminals?.revokingID == terminal.id)
                .orbitConfirmation(Terminals.revokeTitle(terminal),
                                   isPresented: revokeTerminalAsked(terminal)) {
                    Button(Terminals.revoke, role: .destructive) { Task { await revokeTerminal(terminal) } }
                    Button(SharePanelCopy.cancel, role: .cancel) {}
                } message: {
                    Text(Terminals.revokeDetail)
                }
                .accessibilityIdentifier("terminal-revoke-\(terminal.id)")
        }
        .padding(.vertical, 2)
        .opacity(model.terminals?.revokingID == terminal.id ? 0.5 : 1)
    }

    private func revokeTerminalAsked(_ terminal: Terminal) -> Binding<Bool> {
        Binding(get: { pendingRevokeTerminal?.id == terminal.id },
                set: { if !$0 { pendingRevokeTerminal = nil } })
    }

    /// Revoke it, and say what came of it in the page's notice — exactly as main's Settings page did.
    private func revokeTerminal(_ terminal: Terminal) async {
        guard let terminals = model.terminals else { return }
        if let reason = await terminals.revoke(terminal) {
            show(Terminals.notRevoked(reason))
        } else {
            show(Terminals.revoked)
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
                     RunnerPageFormat.versionValue(runner, latest: runners.latestVersion, managed: managedRow != nil))
            // A managed runner never installs a release into itself: Orbit replaces its image.
            aboutRow(RunnerPageCopy.RUNNER_ABOUT_LAST_UPDATE, managedRow == nil ? RunnerPageFormat.lastUpdate(runner) : nil)
            // Only while a release is waiting: a check with nothing newer to install is not offered.
            if RunnerPageFormat.isBehindLatest(runner, latest: runners.latestVersion),
               RunnerAttention.runnerCanUpdateNow(runner, nowMs: RunnerPageFormat.nowMs(now)) {
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
        // Fix with an agent, on an engine not updating and a runner that can't update itself: after the
        // card's own press, before its dismissal; the line under the row says why it is greyed, or which
        // session is fixing it.
        let fix = RunnerAgentFixLogic.attentionState(runner, item: item)
        if let fix, let target = RunnerAgentFixLogic.target(item) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 12) {
                    if let action = item.action {
                        attentionButton(action)
                            .buttonStyle(RunnerCapsuleButtonStyle())
                    }
                    RunnerAgentFixButton(state: fix, pressing: fixPressing) { fixWithAnAgent(target) }
                    if let engine = RunnerPageFormat.updateWarningDismissEngine(item) {
                        Button(RunnerPageCopy.attentionDismissUntilNextRelease(
                            engine: RunnerPageFormat.engineName(engine))) { dismissUpdateWarning(engine) }
                            .linkButtonStyle()
                            .font(.orbitListSubtitle)
                            .padding(.top, 7)
                    }
                }
                RunnerAgentFixLine(state: fix) { openSession($0) }
            }
        } else if let action = item.action {
            // An engine not updating against a known latest can be dismissed until its next release,
            // beside Update Engines Now.
            if let engine = RunnerPageFormat.updateWarningDismissEngine(item) {
                HStack(spacing: 12) {
                    attentionButton(action)
                        .buttonStyle(RunnerCapsuleButtonStyle())
                    Button(RunnerPageCopy.attentionDismissUntilNextRelease(
                        engine: RunnerPageFormat.engineName(engine))) { dismissUpdateWarning(engine) }
                        .linkButtonStyle()
                        .font(.orbitListSubtitle)
                        .padding(.top, 7)
                }
            } else {
                attentionButton(action)
                    .buttonStyle(RunnerCapsuleButtonStyle())
            }
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
        case .checkRegion:
            Button(ClaudeRegionCopy.CLAUDE_REGION_CHECK_AGAIN_TITLE) { checkRegion() }
                .disabled(runners.regionChecking.contains(runner.id))
        }
    }

    /// An engine the machine has opens its page, as does one it lacks whose page installs it; any other is
    /// only a line.
    @ViewBuilder private func engineRow(_ health: RunnerEngineHealth, offline: Bool, now: Date) -> some View {
        let row = RunnerEngineRow(health: health, runner: runner, offline: offline, now: now)
        if RunnerPageFormat.claudeRegionBlocked(runner, engine: health.engine) {
            // Check Again stands where Sign In would (board 03), and is a press of its own: the row's
            // push and the check are siblings, so neither takes the other's tap.
            VStack(alignment: .leading, spacing: 0) {
                if RunnerEngineRow.opensPage(health, runner: runner) {
                    Button { model.push(.runnerEngine(runnerID: runner.id, engine: health.engine)) } label: {
                        row.foregroundStyle(Color.primary)
                            .contentShape(Rectangle())
                    }
                    .runnerRowButtonStyle()
                } else {
                    row
                }
                Button(ClaudeRegionCopy.CLAUDE_REGION_CHECK_AGAIN_TITLE) { checkRegion() }
                    .buttonStyle(RunnerCapsuleButtonStyle())
                    .disabled(offline || runners.regionChecking.contains(runner.id))
                    .padding(.leading, RunnerEngineRow.textInset)
                    .padding(.bottom, 4)
            }
        } else if RunnerEngineRow.opensPage(health, runner: runner) {
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
        keepFree = RunnerPageFormat.keepFreeValue(runner.minFreeDiskMb)
        seeded = true
    }

    private func saveMaxConcurrent(_ value: Int) {
        guard value != (runner.maxConcurrent ?? 1) else { return }
        let id = runner.id
        Task {
            guard let failure = await runners.setMaxConcurrent(id, value) else { return }
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

    private func dismissUpdateWarning(_ engine: String) {
        let id = runner.id
        Task {
            if let failure = await runners.dismissEngineUpdateWarning(id, engine: engine) { show(failure) }
        }
    }

    /// One press, no sheet: the session starts and the list read after it turns the button into the
    /// fixing line; the page stays where it is. A refusal is the server's own sentence.
    private func fixWithAnAgent(_ target: RunnerAgentFixTarget) {
        let id = runner.id
        fixPressing = true
        Task {
            if let failure = await runners.fixAttention(id, target: target) {
                show("\(RunnerPageCopy.AGENT_FIX_FAILED) — \(failure)")
            }
            fixPressing = false
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

    /// Check again (docs/claude-region-check-contract.md §7): the press holds until the check it asked
    /// for has come back (`RunnersModel.checkRegion`).
    private func checkRegion() {
        let id = runner.id
        Task {
            if let failure = await runners.checkRegion(id) {
                show("\(ClaudeRegionCopy.CLAUDE_REGION_CHECK_FAILED) — \(failure)")
            }
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

    /// New workspace on this machine: its new session page with the setup card, after the Settings sheet comes down.
    private func newWorkspace() {
        model.openNewWorkspace(runner.id)
    }

    /// Start a session: this machine's new session page, after the Settings sheet comes down.
    private func startSession() {
        model.settingsPresented = false
        model.startSession(onMachine: runner.id)
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
