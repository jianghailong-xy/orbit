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

/// The Machines & models page (docs/mocks/infrastructure-page/03-ios.png): the Machines & models section's list
/// on a Mac and an iPad, the section's own page on a phone, and Settings › Machines & models there — what needs
/// a person, the machines (each opening its record; reordered and removed here), then the account pools
/// and the API keys. Every way out stays in the app: an engine is signed in on its page, a machine on its
/// record, a pool on its page — iOS's own; the Mac has none.
struct RunnersListView: View {
    @Environment(AppModel.self) private var model
    /// How this list's rows navigate. Defaults to the three-column shape; the compact shell and Settings,
    /// whose stacks know their own pushes, pass `.push`.
    var rowNavigation: SessionRowNavigation = .selection
    @State private var addingRunner = false
    @State private var pendingRemoval: Runner?

    var body: some View {
        @Bindable var model = model
        if let runners = model.runners {
            let lists = MachinesAndModelsLists(model)
            // An account with no runner at all, while the server offers managed runners: its managed
            // runner — Set up, or why there is none — above the machines, as the web's default landing
            // shows it (`ManagedRunnerLogic.onboarding`). Add Runner stays where it is.
            let managed = runners.loadState.hasLoaded
                ? ManagedRunnerLogic.onboarding(model.managedRunner?.display, runnerCount: runners.runners.count)
                : nil
            // Runners' stack projection — the record on top — and only where there is a detail
            // column to select into.
            List(selection: rowNavigation == .selection ? $model.selectedRunnerID : nil) {
                #if os(iOS)
                if let managed {
                    Section {
                        ManagedRunnerBanner(display: managed, runnerID: model.managedRunner?.status?.runnerId)
                    }
                }
                #endif
                if lists.settled {
                    let attention = lists.attention
                    if !attention.isEmpty {
                        MachinesAndModelsNeedsYouSection(items: attention, opensPools: opensPools,
                                                      open: openAttention)
                    }
                }
                Section {
                    ForEach(runners.runners) { r in
                        row(r)
                    }
                    .onMove { moveRunners(runners, from: $0, to: $1) }
                    .onDelete { pendingRemoval = runnerToRemove(runners, at: $0) }
                } header: {
                    RunnerSectionHeader(MachinesAndModels.machines,
                                        trailing: MachinesAndModels.machinesCount(runners.runners))
                } footer: {
                    Text(MachinesAndModels.machinesDetail)
                }
                RunnerAddSection { addingRunner = true }
                MachinesAndModelsPoolsSection(memberPools: lists.memberPools, ownPools: lists.ownPools,
                                           open: opensPools ? push : nil)
                MachinesAndModelsKeysSection(keys: lists.keys, balances: model.agents?.deepSeekBalances ?? [:],
                                          cursorModel: MachinesAndModels.cursorModel(lists.runners.filter { $0.online == true }),
                                          open: opensPools ? push : nil)
            }
            .orbitRevealSurface()   // macOS: reveal the unified `orbitSurface`
            .modifier(ManagedRunnerAboveList(display: managed, runnerID: model.managedRunner?.status?.runnerId))
            .modifier(RunnersLoadOverlay(runners: runners, isEmpty: runners.runners.isEmpty,
                                         failedTitle: "Machines couldn't be loaded",
                                         emptyTitle: nil, systemImage: "desktopcomputer"))
            .modifier(RunnerListEditing(runners: runners, addingRunner: $addingRunner,
                                        pendingRemoval: $pendingRemoval))
            .navigationTitle(AppSection.runners.title)
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

    /// A pool's page — and a DeepSeek key's — is pushed where the page is a stack's (iOS); the three-column
    /// pane shows records only.
    private var opensPools: Bool { rowNavigation == .push }

    private func push(_ page: NavNode) { model.push(page) }

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
/// The managed runner above Machines & models' list on the Mac, for an account with no runner
/// (`ManagedRunnerLogic.onboarding`). A Mac list is a table that keeps its rows where they were when
/// a row or a top inset that arrives after it has drawn changes its height, so there the banner takes
/// room of its own above the list; on iOS it is the list's first section.
private struct ManagedRunnerAboveList: ViewModifier {
    let display: ManagedRunnerDisplay?
    let runnerID: String?

    func body(content: Content) -> some View {
        #if os(macOS)
        VStack(spacing: 0) {
            if let display {
                ManagedRunnerBanner(display: display, runnerID: runnerID)
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
                RunnerStatusDot(presence: RunnerPageFormat.presence(runner, now: now), ringed: true)
                    .alignmentGuide(.firstTextBaseline) { d in d[VerticalAlignment.center] + 5 }
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(RunnerPageFormat.displayName(runner))
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        if let slots = RunnerPageFormat.slots(runner, now: now) {
                            RunnerSlotBar(slots: slots)
                                .alignmentGuide(.firstTextBaseline) { d in d[VerticalAlignment.center] + 4 }
                        } else if RunnerPageFormat.isOffline(runner, now: now) {
                            Text(RunnerPageCopy.RUNNER_OFFLINE)
                                .font(.orbitListSubtitle)
                                .foregroundStyle(Color.secondary)
                        }
                    }
                    Text(MachinesAndModels.machineLine(runner, now: now))
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
/// Attention), how much it gets (Capacity), what it runs (Engines), where (Workspaces), what it is
/// (About This Runner) — and the two ways to be done with it, each on a card of its own that asks
/// first. iOS and macOS draw the same grouped form.
struct RunnerDetailContent: View {
    let runners: RunnersModel
    let runner: Runner
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

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
            if let card = RunnerPageFormat.updateCard(runner, now: now) {
                updateSection(card)
            }
            if !items.isEmpty {
                attentionSection(items, now: now)
            }
            capacitySection(workspaces, now: now)
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
        // A machine checks in every 30s: read it again while its page is up, so the page moves with it
        // — while the app can be seen (`ViewPoll`).
        .task(id: runner.id) {
            await ViewPoll.run(model, every: 15, inFlight: { 15 }) {
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

    /// The Update card (board 4): a release this runner is behind, in the phase it reports — amber
    /// while it holds work back or restarts, and Updated for a day after. Later ▾ while draining;
    /// Change ▾ once postponed. Update Now… (`RunnerUpdateNowControl`) while available, draining or
    /// postponed for a runner that declares `self-update-now/v1`; one without it keeps the postponed
    /// card's Update Now…, which asks for Update Runner Now.
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

    /// How much it is given: slots, saved when the stepper lets go; the disk it fills; and the reserve
    /// under which task runs stop being sent here.
    @ViewBuilder private func capacitySection(_ workspaces: [Agent], now: Date) -> some View {
        Section {
            // A meter, as Disk is: the name, `3 of 16 running` and Edit on a line, a bar of the slots
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

    /// Max Concurrent's sheet: the limit on a stepper, what it means, and Cancel or Save.
    private var maxConcurrentSheet: some View {
        NavigationStack {
            Form {
                Section {
                    Stepper(value: $maxDraft, in: 1...64) {
                        HStack {
                            Text(RunnerPageCopy.RUNNER_MAX_CONCURRENT)
                            Spacer(minLength: 8)
                            Text(verbatim: "\(maxDraft)")
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
        } header: {
            RunnerSectionHeader(RunnerPageCopy.RUNNER_WORKSPACES,
                                trailing: workspaces.isEmpty ? nil : "\(workspaces.count)")
        } footer: {
            if !workspaces.isEmpty {
                Text(MachineSetupCopy.RUNNER_WORKSPACES_TAP)
            }
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
        case .checkRegion:
            Button(ClaudeRegionCopy.CLAUDE_REGION_CHECK_AGAIN_TITLE) { checkRegion() }
                .disabled(runners.regionChecking.contains(runner.id))
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
