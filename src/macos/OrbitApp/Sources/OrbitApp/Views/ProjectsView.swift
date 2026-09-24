import SwiftUI
import OrbitKit

/// Projects: the index (`ProjectsListView`) and one project's page (`ProjectDetailView`), drawn
/// from the same reads as the web's `/projects` and `/projects/:id`. Which lane a project sits in,
/// the order inside it, and every chip and sentence come from OrbitKit (`ProjectAttention`,
/// `ProjectPage`), which ports the web's rules and holds their words to the web sources.

// MARK: - Palette

/// One colour per work lane, and a shape beside every colour: the lanes are told apart without
/// reading hue (Orbit's status colours do not separate under colour-vision deficiency).
enum ProjectPalette {
    static let running = Color.accentColor
    static let ready = Color.orange
    static let waiting = Color.gray
    static let done = Color.green
    static let failed = Color.red
    static let cancelled = Color.secondary.opacity(0.5)
    /// A warning chip's words: the effect mock's amber ink (#B35A00) on light, where system orange
    /// on its own 14% wash reads at about 2:1; system orange on dark, where the ink would sink.
    static let warningInk = Color(light: Color(red: 0.702, green: 0.353, blue: 0), dark: .orange)

    static func color(_ glyph: ProjectPage.Glyph) -> Color {
        switch glyph {
        case .disc, .spinner, .hourglass: return running
        case .triangle: return ready
        case .square: return waiting
        case .check, .branch: return done
        case .cross: return failed
        case .slash: return cancelled
        }
    }

    static func tone(_ tone: ProjectPage.TagTone) -> Color {
        switch tone {
        case .neutral: return .secondary
        case .brand, .verification: return .accentColor
        case .warning: return .orange
        case .danger: return .red
        case .success: return .green
        }
    }
}

/// A lane's shape, drawn small beside its count.
struct ProjectGlyphMark: View {
    let glyph: ProjectPage.Glyph
    var size: CGFloat = 8

    var body: some View {
        let color = ProjectPalette.color(glyph)
        Group {
            switch glyph {
            case .disc:
                Circle().fill(color)
            case .triangle:
                ProjectTriangle().fill(color)
            case .square:
                RoundedRectangle(cornerRadius: 1.5).stroke(color, lineWidth: 1.5)
            case .check:
                Image(systemName: "checkmark").resizable().scaledToFit().foregroundStyle(color)
                    .fontWeight(.bold)
            case .cross:
                Image(systemName: "xmark").resizable().scaledToFit().foregroundStyle(color)
                    .fontWeight(.bold)
            case .slash:
                Image(systemName: "line.diagonal").resizable().scaledToFit().foregroundStyle(color)
            case .hourglass:
                Image(systemName: "hourglass").resizable().scaledToFit().foregroundStyle(color)
            case .spinner:
                Image(systemName: "arrow.triangle.2.circlepath").resizable().scaledToFit()
                    .foregroundStyle(color)
            case .branch:
                Image(systemName: "arrow.triangle.branch").resizable().scaledToFit().foregroundStyle(color)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

private struct ProjectTriangle: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.midX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
        path.closeSubpath()
        return path
    }
}

/// A stacked bar of lanes, each segment as long as its share.
struct ProjectMeter: View {
    let segments: [(value: Int, color: Color)]
    var height: CGFloat = 5

    var body: some View {
        // Only the lanes that have work are drawn, so only the gaps between them come off the width:
        // counting every lane's gap left the bar short of its track by a gap per empty lane.
        let drawn = segments.filter { $0.value > 0 }
        let total = max(1, drawn.reduce(0) { $0 + $1.value })
        let gaps = CGFloat(max(0, drawn.count - 1)) * 1.5
        GeometryReader { geo in
            HStack(spacing: 1.5) {
                ForEach(Array(drawn.enumerated()), id: \.offset) { _, segment in
                    segment.color
                        .frame(width: max(2, (geo.size.width - gaps) * CGFloat(segment.value) / CGFloat(total)))
                }
            }
        }
        .frame(height: height)
        .background(Color.secondary.opacity(0.12))
        .clipShape(Capsule())
        .accessibilityHidden(true)
    }
}

// MARK: - The index

/// The projects index: the web's lanes — Needs attention, Running, Ready, Waiting, Needs
/// definition, Completed (folded) — each in its own order, searchable by title and goal.
struct ProjectsListView: View {
    @Environment(AppModel.self) private var model
    /// How rows navigate: the three-column shells select, the compact stack pushes.
    var rowNavigation: SessionRowNavigation = .selection
    @State private var query = ""
    @State private var showsCompleted = false

    var body: some View {
        @Bindable var model = model
        if let store = model.projects {
            // Waits and "no activity" are relative to now: redraw between fetches.
            TimelineView(.periodic(from: .now, by: 60)) { context in
                let groups = ProjectAttention.sections(filtered(store.projects), now: context.date)
                    .filter { !$0.projects.isEmpty }
                List(selection: rowNavigation == .selection ? $model.selectedProjectID : nil) {
                    ForEach(groups) { group in
                        Section {
                            if !group.section.defaultCollapsed || showsCompleted || !query.isEmpty {
                                ForEach(group.projects) { project in
                                    row(project, now: context.date)
                                }
                            }
                        } header: {
                            header(group)
                        }
                    }
                }
                .orbitRevealSurface()
                #if os(iOS)
                // Plain, like the sessions list: light section headers over full-width rows, not
                // boxed inset-grouped cards.
                .listStyle(.plain)
                #endif
            }
            #if os(iOS)
            // The sessions list's arrangement too: the field held under an inline title, where the
            // system lays it out, rather than floating at the bottom of the phone.
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always),
                        prompt: "Search projects")
            #else
            .searchable(text: $query, prompt: "Search projects")
            #endif
            .overlay {
                ProjectsPlaceholder(store: store,
                                    noMatch: !query.isEmpty && filtered(store.projects).isEmpty)
            }
            .navigationTitle("Projects")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .task { await store.load() }
        } else {
            ProgressView()
        }
    }

    private func filtered(_ projects: [ProjectSummary]) -> [ProjectSummary] {
        let needle = query.trimmingCharacters(in: .whitespaces)
        guard !needle.isEmpty else { return projects }
        return projects.filter {
            $0.title.localizedCaseInsensitiveContains(needle)
                || ($0.goal ?? "").localizedCaseInsensitiveContains(needle)
        }
    }

    private func header(_ group: ProjectAttentionGroup) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            // `Color`s rather than the hierarchical styles, for the same reason as the rows below.
            Text(group.section.title)
                .font(.orbitSubtext.weight(.bold))
                .foregroundStyle(Color.primary)
            Text("\(group.projects.count)")
                .font(.orbitLabel.weight(.semibold))
                .foregroundStyle(Color.secondary)
            Spacer(minLength: 0)
            if group.section.defaultCollapsed, query.isEmpty {
                Button(showsCompleted ? "Hide" : "Show") { showsCompleted.toggle() }
                    .font(.orbitSubtext)
                    .buttonStyle(.borderless)
            }
        }
        .textCase(nil)
    }

    @ViewBuilder private func row(_ project: ProjectSummary, now: Date) -> some View {
        let row = ProjectRow(project: project, now: now)
        switch rowNavigation {
        case .selection:
            row.tag(project.id)
        case .push:
            // A `Button`, not a `NavigationLink(value:)` — see `AppModel.push`. `Color.primary`, not
            // the hierarchical `.primary`: inside a button that resolves against the button's tint,
            // which drew every title in the accent colour (and its grey words at half of it) on a
            // phone.
            Button { model.push(.projectDetail(projectID: project.id)) } label: {
                row.foregroundStyle(Color.primary)
            }
        }
    }
}

/// One project on the index: title and last activity; the chip that says who has to act; the
/// lanes as a meter with their counts; and the line its work lands on.
struct ProjectRow: View {
    let project: ProjectSummary
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(project.title)
                    .lineLimit(1)
                    .foregroundStyle(project.status == .open ? .primary : .secondary)
                Spacer(minLength: 4)
                if let at = project.lastActivityAt, let elapsed = RelativeTime.elapsed(at, now: now) {
                    Text(elapsed).font(.orbitLabel).foregroundStyle(.secondary)
                }
            }
            if let chip = ProjectAttention.chip(of: project, now: now) {
                let warning = chip.tone == .warning
                Text(chip.text)
                    .font(.orbitLabel.weight(.semibold))
                    .lineLimit(1)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .foregroundStyle(warning ? ProjectPalette.warningInk : Color.accentColor)
                    .background((warning ? Color.orange : Color.accentColor).opacity(warning ? 0.14 : 0.12),
                                in: RoundedRectangle(cornerRadius: 7))
            }
            HStack(spacing: 10) {
                ProjectMeter(segments: meterSegments).frame(maxWidth: 110)
                counts
                Spacer(minLength: 0)
                if let line = ProjectAttention.integrationChip(of: project) {
                    Label(line.text, systemImage: line.isBranch ? "arrow.triangle.branch" : "arrow.down.to.line")
                        .labelStyle(.titleAndIcon)
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .padding(.top, 2)
        }
        .padding(.vertical, 3)
    }

    private var meterSegments: [(value: Int, color: Color)] {
        let b = project.buckets
        return [(value: b.running, color: ProjectPalette.running),
                (value: b.ready, color: ProjectPalette.ready),
                (value: b.blocked + b.awaitingVerification, color: ProjectPalette.waiting),
                (value: ProjectAttention.failedTaskCount(project), color: ProjectPalette.failed),
                (value: b.done, color: ProjectPalette.done),
                (value: b.cancelled, color: ProjectPalette.cancelled)]
    }

    private var counts: some View {
        let b = project.buckets
        let lanes: [(ProjectPage.Glyph, Int)] = [
            (.disc, b.running), (.triangle, b.ready), (.square, b.blocked + b.awaitingVerification),
            (.cross, ProjectAttention.failedTaskCount(project)), (.check, b.done),
        ]
        return HStack(spacing: 8) {
            ForEach(Array(lanes.enumerated()), id: \.offset) { _, lane in
                if lane.1 > 0 {
                    HStack(spacing: 3) {
                        ProjectGlyphMark(glyph: lane.0, size: 8)
                        Text(lane.1.formatted()).monospacedDigit()
                    }
                }
            }
        }
        .font(.orbitLabel)
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }
}

/// What stands where the rows would be. Only a fetch that succeeded may say there are none.
private struct ProjectsPlaceholder: View {
    let store: ProjectsModel
    /// A search is on and matched nothing.
    let noMatch: Bool

    var body: some View {
        switch LoadFailureLogic.presentation(store.loadState, isEmpty: store.projects.isEmpty) {
        case .loading:
            ProgressView()
        case .failed:
            ContentUnavailableView {
                Label("Projects couldn't be loaded", systemImage: "square.grid.2x2")
            } description: {
                Text("Check the connection, then try again.")
            } actions: {
                Button("Retry") { Task { await store.load() } }
            }
        case .empty:
            ContentUnavailableView("No projects", systemImage: "square.grid.2x2",
                                   description: Text("Ask an agent in any session to start a project: it files the goal, the criteria and the first tasks, and the project shows up here."))
        case .content:
            if noMatch {
                ContentUnavailableView.search
            }
        }
    }
}

// MARK: - One project

/// The Projects section's detail: the page for whichever project is on top of the section's stack.
struct ProjectDetailPane: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let id = model.selectedProjectID {
            ProjectDetailView(projectID: id).id(id)
        } else {
            ContentUnavailableView("Projects", systemImage: "square.grid.2x2",
                                   description: Text("Select a project to see what it is waiting on."))
        }
    }
}

/// One project's page, card for card the page the web draws on a phone, in the web's order: what is
/// waiting on the reader, where the work stands, who is coordinating it, the goal, the plan as a
/// graph, what is standing in its way, what can start, the criteria, the instructions and the tasks.
struct ProjectDetailView: View {
    @Environment(AppModel.self) private var model
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var hSize
    #endif
    let projectID: String

    @State private var notice: String?
    @State private var confirmingStatus: ProjectStatus?
    @State private var confirmingDelete = false
    @State private var confirmingReplace = false
    @State private var goalExpanded = false
    @State private var instructionsExpanded = false
    @State private var criteriaExpanded = false
    /// Criteria whose "How it's checked" is open.
    @State private var openMethods: Set<String> = []
    /// Folds of the task graph the reader opened.
    @State private var expandedFolds: Set<String> = []
    @State private var blockerToResolve: ProjectBlocker?
    @State private var resolveReason = ""
    @State private var listToResume: ProjectReadyToRun.Item?
    /// The page's own header carries the whole title; the bar takes it once that header scrolls
    /// away, so one title is never drawn twice.
    @State private var headerOnScreen = true

    /// A phone's width: two columns of lanes, four criteria before "View all" — the web's narrow page.
    private var compact: Bool {
        #if os(iOS)
        return hSize == .compact
        #else
        return false
        #endif
    }

    var body: some View {
        if let store = model.projects?.detail(projectID) {
            content(store)
        } else {
            ProgressView()
        }
    }

    @ViewBuilder
    private func content(_ store: ProjectDetailModel) -> some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            Group {
                if store.missing {
                    ContentUnavailableView("This project is gone", systemImage: "square.grid.2x2",
                                           description: Text("It was deleted, or it belongs to another account."))
                } else if let document = store.document {
                    page(store, document, now: context.date)
                } else if store.loadState.lastLoadFailed {
                    ContentUnavailableView {
                        Label("The project couldn't be loaded", systemImage: "exclamationmark.triangle")
                    } actions: {
                        Button("Retry") { Task { await store.load() } }
                    }
                } else {
                    ProgressView().controlSize(.large).frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
        #if os(iOS)
        // The session page's bar: nothing while the page's own header shows the title, then the
        // title over a status line, centred, once it has scrolled away.
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        #else
        .navigationTitle(headerOnScreen && store.document != nil
                         ? "" : (store.document?.title ?? model.projects?.project(projectID)?.title ?? "Project"))
        #endif
        .toolbar {
            #if os(iOS)
            if !headerOnScreen, let document = store.document {
                ToolbarItem(placement: .principal) { ProjectNavTitle(document: document) }
            }
            #endif
            if let document = store.document {
                ToolbarItem(placement: .primaryAction) { menu(store, document) }
            }
        }
        .task {
            store.isVisible = true
            await store.load()
        }
        .onDisappear { store.isVisible = false }
        .refreshable { await store.load() }
        .alert("Couldn't do that", isPresented: Binding(get: { notice != nil },
                                                          set: { if !$0 { notice = nil } })) {
            Button("OK", role: .cancel) { notice = nil }
        } message: {
            Text(notice ?? "")
        }
        .confirmationDialog(confirmTitle, isPresented: Binding(get: { confirmingStatus != nil },
                                                              set: { if !$0 { confirmingStatus = nil } }),
                            titleVisibility: .visible) {
            if let status = confirmingStatus {
                Button(confirmButton(status), role: status == .cancelled ? .destructive : nil) {
                    Task { notice = await store.setStatus(status) }
                }
            }
        } message: {
            Text(confirmMessage(store))
        }
        .confirmationDialog("Delete this project?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete project", role: .destructive) {
                Task { notice = await store.delete() }
            }
        } message: {
            Text("Only a project with no tasks can be deleted.")
        }
    }

    // MARK: page

    private func page(_ store: ProjectDetailModel, _ document: ProjectDocument, now: Date) -> some View {
        List {
            Section {
                header(store, document, now: now)
                    .onAppear { headerOnScreen = true }
                    .onDisappear { headerOnScreen = false }
            }
            .listRowBackground(Color.clear)
            openItemsSection(store, now: now)
            overviewSection(store, document)
            coordinatorSection(store, document, now: now)
            goalSection(document)
            graphSection(store)
            blockersSection(store, document, now: now)
            runQueueSection(store)
            criteriaSection(document)
            instructionsSection(document)
            tasksSection(store, document)
        }
        .projectPageListStyle()
        // Held on the list rather than beside the page's own alert: one view, one alert.
        .alert(ProjectPage.resolveBlockerTitle, isPresented: Binding(get: { blockerToResolve != nil },
                                                                   set: { if !$0 { blockerToResolve = nil } }),
               presenting: blockerToResolve) { blocker in
            TextField(ProjectPage.resolveBlockerQuestion, text: $resolveReason)
            Button("Cancel", role: .cancel) { blockerToResolve = nil }
            Button(ProjectPage.resolveBlockerConfirm) {
                let reason = String(resolveReason.trimmingCharacters(in: .whitespacesAndNewlines)
                    .prefix(ProjectPage.blockerReasonLimit))
                Task { notice = await store.resolveBlocker(blocker.id, reason: reason) }
            }
            .disabled(resolveReason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } message: { blocker in
            Text(ProjectPage.resolveBlockerMessage(blocker))
        }
        .confirmationDialog(listToResume?.pausedList.map(ProjectPage.resumeListQuestion) ?? "",
                            isPresented: Binding(get: { listToResume != nil },
                                                 set: { if !$0 { listToResume = nil } }),
                            titleVisibility: .visible, presenting: listToResume) { item in
            if let list = item.pausedList {
                Button(ProjectPage.resumeListPress) {
                    Task { notice = await store.resumeList(list.id) }
                }
            }
        } message: { item in
            Text(ProjectPage.resumeListDetail(item))
        }
        .confirmationDialog(ProjectPage.replaceCoordinatorQuestion, isPresented: $confirmingReplace,
                            titleVisibility: .visible) {
            Button(ProjectPage.replaceCoordinatorConfirm, role: .destructive) { replaceCoordinator(store) }
            Button(ProjectPage.replaceCoordinatorKeep, role: .cancel) {}
        } message: {
            Text(ProjectPage.replaceCoordinatorDetail)
        }
    }

    private func header(_ store: ProjectDetailModel, _ document: ProjectDocument, now: Date) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(document.title)
                .font(.title2.weight(.bold))
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            HStack(spacing: 8) {
                Text(document.status == .done ? "Completed" : document.status.label)
                    .font(.orbitLabel.weight(.semibold))
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .foregroundStyle(document.status == .open ? Color.accentColor : Color.secondary)
                    .background((document.status == .open ? Color.accentColor : Color.secondary).opacity(0.13),
                                in: RoundedRectangle(cornerRadius: 6))
                Text("\(document.taskCount) task\(document.taskCount == 1 ? "" : "s")")
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
            }
            if let view = store.integration, let facts = ProjectPage.integrationFacts(view, now: now) {
                Label {
                    Text(facts.joined(separator: " · "))
                } icon: {
                    Image(systemName: view.line == .projectBranch ? "arrow.triangle.branch" : "arrow.down.to.line")
                }
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 4))
    }

    // MARK: open items

    @ViewBuilder
    private func openItemsSection(_ store: ProjectDetailModel, now: Date) -> some View {
        let needsYou = store.openItems?.needsYou ?? []
        let withCoordinator = store.openItems?.withCoordinator ?? []
        if !(needsYou.isEmpty && withCoordinator.isEmpty) {
            Section {
                if !needsYou.isEmpty {
                    groupLabel(ProjectPage.needsYouGroup)
                    ForEach(needsYou) { row in openItem(row, store: store, now: now) }
                }
                if !withCoordinator.isEmpty {
                    groupLabel(ProjectPage.withCoordinatorGroup)
                    ForEach(withCoordinator) { row in openItem(row, store: store, now: now) }
                }
            } header: {
                sectionHeader(ProjectPage.openItemsHeading,
                              detail: ProjectPage.openItemsHint(needsYou: needsYou.count,
                                                                withCoordinator: withCoordinator.count))
            }
        }
    }

    private func groupLabel(_ text: String) -> some View {
        Text(text.uppercased())
            .font(.orbitMeta.weight(.semibold))
            .foregroundStyle(.secondary)
    }

    private func openItem(_ row: ProjectOpenItemRow, store: ProjectDetailModel, now: Date) -> some View {
        let owner = row.assignee != .coordinator
        return HStack(alignment: .center, spacing: 10) {
            Circle().fill(owner ? Color.orange : Color.accentColor).frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title).font(.orbitSubtext.weight(.semibold)).lineLimit(3)
                if !row.detailLine.isEmpty {
                    Text(row.detailLine).font(.orbitLabel).foregroundStyle(.secondary).lineLimit(3)
                }
                Text("\(ProjectPage.who(row)) · \(ProjectPage.waitingLabel(row, now: now))")
                    .font(.orbitMeta)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 6)
            if let action = ProjectPage.primaryAction(row), let label = ProjectPage.actionLabel(action) {
                Button(label) { perform(action, on: row, store: store) }
                    .font(.orbitLabel.weight(.semibold))
                    .buttonStyle(.borderedProminent)
                    .tint(owner ? Color.accentColor : Color.secondary)
                    .buttonBorderShape(.capsule)
                    .disabled(store.busy)
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        // The whole card, with every press the item offers, lives in the coordinator conversation.
        .onTapGesture { openCoordinator(store, focus: owner ? row : nil) }
    }

    private func perform(_ action: ProjectOpenItemAction, on row: ProjectOpenItemRow,
                         store: ProjectDetailModel) {
        switch action {
        case .resume:
            guard let episode = row.fuseEpisodeId else { return }
            Task { notice = await store.resumeFuse(episodeID: episode) }
        case .openTaskSession:
            if let session = row.sessionId {
                model.route(to: .session(session))
            } else if let task = row.taskId {
                openTask(task)
            }
        case .review, .answer:
            openCoordinator(store, focus: row)
        case .openCoordinator:
            if let session = row.delivery?.sessionId {
                model.openProjectCoordinator(sessionID: session,
                                             agentID: store.coordinator?.coordination.workspaceId)
            } else {
                openCoordinator(store, focus: nil)
            }
        default:
            openCoordinator(store, focus: row.assignee == .coordinator ? nil : row)
        }
    }

    /// Open (or find) the coordinator conversation, and — for one of the owner's items — land on its
    /// card there: the same press the needs-you banner makes.
    private func openCoordinator(_ store: ProjectDetailModel, focus row: ProjectOpenItemRow?) {
        let item = row.map {
            SessionOwnerItem(itemId: $0.itemId, kind: ProjectPage.ownerItemKind($0), title: $0.title,
                             since: $0.waitingSince)
        }
        Task {
            switch await store.openCoordinator() {
            case .success(let opened):
                model.openProjectCoordinator(sessionID: opened.sessionId,
                                             agentID: opened.workspaceId
                                                ?? store.coordinator?.coordination.workspaceId,
                                             focus: item)
            case .failure(let error):
                notice = error.message
            }
        }
    }

    /// Start the next coordinator and go to it, empty.
    private func replaceCoordinator(_ store: ProjectDetailModel) {
        Task {
            switch await store.replaceCoordinator() {
            case .success(let opened):
                model.openProjectCoordinator(sessionID: opened.sessionId,
                                             agentID: opened.workspaceId
                                                ?? store.coordinator?.coordination.workspaceId)
            case .failure(let error):
                notice = error.message
            }
        }
    }

    // MARK: work overview

    @ViewBuilder
    private func overviewSection(_ store: ProjectDetailModel, _ document: ProjectDocument) -> some View {
        if let panorama = store.panorama {
            let buckets = panorama.buckets
            let cells = ProjectPage.overviewCells(buckets, taskCount: panorama.shape.taskCount,
                                                  line: document.integration?.line)
            let stalled = ProjectPage.stalledOnReady(buckets)
            Section {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12, alignment: .topLeading),
                                         count: compact ? 2 : 3),
                          alignment: .leading, spacing: 16) {
                    ForEach(cells) { cell in
                        overviewCell(cell, attention: stalled && cell.key == "ready")
                    }
                }
                .padding(.vertical, 6)
                ProjectMeter(segments: cells.map { (value: $0.value, color: ProjectPalette.color($0.glyph)) },
                             height: 8)
                    .padding(.vertical, 4)
                if stalled {
                    banner(glyph: .triangle, title: ProjectPage.stalledTitle,
                           text: ProjectPage.stalledSentence(ready: buckets.ready)) {
                        Button(ProjectPage.stalledPress) { model.selectedSection = .runners }
                            .font(.orbitLabel.weight(.semibold))
                            .buttonStyle(.bordered)
                            .buttonBorderShape(.capsule)
                            .controlSize(.small)
                    }
                    .listRowBackground(Color.orange.opacity(0.1))
                }
                if ProjectPage.wrappingUp(status: document.status, buckets) {
                    banner(glyph: .check, title: ProjectPage.wrapUpTitle,
                           text: ProjectPage.wrapUpSentence(settled: buckets.done + buckets.cancelled)) {
                        EmptyView()
                    }
                    .listRowBackground(Color.accentColor.opacity(0.08))
                }
            } header: {
                sectionHeader("Work overview", detail: ProjectPage.overviewSubtitle(panorama.shape))
            }
        }
    }

    /// One lane: its shape and name, the number, and a line saying what the number counts. The one
    /// cell that changes colour is Ready, and only while nothing is picking that work up.
    private func overviewCell(_ cell: ProjectPage.OverviewCell, attention: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 5) {
                ProjectGlyphMark(glyph: cell.glyph, size: 8)
                Text(cell.label)
            }
            .font(.orbitLabel)
            .foregroundStyle(Color.primary)
            Text(cell.value.formatted())
                .font(.title2.weight(.bold))
                .monospacedDigit()
            Text(cell.footnote)
                .font(.orbitMeta)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            if attention {
                RoundedRectangle(cornerRadius: 10).fill(Color.orange.opacity(0.13)).padding(-6)
            }
        }
    }

    /// A banner under the meter: a shape, what is going on, and — when there is one — the press.
    private func banner<Action: View>(glyph: ProjectPage.Glyph, title: String, text: String,
                                      @ViewBuilder action: () -> Action) -> some View {
        HStack(alignment: .top, spacing: 10) {
            ProjectGlyphMark(glyph: glyph, size: 11).padding(.top, 3)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.orbitSubtext.weight(.semibold))
                Text(text).font(.orbitLabel).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                action()
            }
        }
        .padding(.vertical, 4)
    }

    // MARK: coordinator

    @ViewBuilder
    private func coordinatorSection(_ store: ProjectDetailModel, _ document: ProjectDocument,
                                    now: Date) -> some View {
        if let status = store.coordinator {
            let pill = ProjectPage.coordinatorPill(status)
            let coordination = status.coordination
            let finished = ProjectPage.coordinatorFinished(status)
            Section {
                if let session = coordination.session {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(session.title ?? "Coordinator").font(.orbitSubtext.weight(.semibold))
                        Text([ProjectPage.lastActive(session, readAt: status.readAt),
                              ProjectPage.coordinatorOrdinal(coordination.coordinatorGeneration)]
                                .compactMap { $0 }.joined(separator: " · "))
                            .font(.orbitLabel)
                            .foregroundStyle(.secondary)
                        if status.state == .live && finished {
                            Text(ProjectPage.finishedCoordinatorNote)
                                .font(.orbitLabel)
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.top, 4)
                        }
                    }
                }
                if let workspace = coordination.workspaceName {
                    LabeledContent("Workspace", value: workspace)
                }
                if let wakeups = coordination.wakeups {
                    LabeledContent("Wake-ups", value: ProjectPage.wakeupsLine(wakeups, now: now))
                }
                if let fuse = coordination.fuse {
                    VStack(alignment: .leading, spacing: 6) {
                        LabeledContent("Self-started today", value: ProjectPage.selfStartedLine(fuse))
                        if let fraction = ProjectPage.selfStartedFraction(fuse) {
                            ProgressView(value: fraction).tint(fuse.paused ? .orange : .accentColor)
                        }
                    }
                }
                if status.state == .unavailable, let action = status.openability.requiredAction {
                    Text(action).font(.orbitLabel).foregroundStyle(.red)
                }
                if status.state == .live, coordination.session != nil {
                    let note = ProjectPage.dispatchNote(openTaskCount: document.tasksByStatus.map { $0["OPEN"] ?? 0 },
                                                        finished: finished)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(note.heading).font(.orbitMeta).foregroundStyle(.secondary)
                        Text(note.text).font(.orbitLabel).fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
                    // The lead press is the safe one — go to the conversation. Starting the next
                    // coordinator is a one-way door, so it is held behind the press, where it is
                    // chosen rather than hit.
                    Menu {
                        Button {
                            if finished { replaceCoordinator(store) } else { confirmingReplace = true }
                        } label: {
                            Text(ProjectPage.startNewCoordinator)
                            Text(ProjectPage.startNewCoordinatorDetail(finished: finished))
                        }
                    } label: {
                        Text(ProjectPage.coordinatorPress(finished: finished, needsReply: pill.label == "Needs you"))
                            .frame(maxWidth: .infinity)
                    } primaryAction: {
                        openCoordinator(store, focus: nil)
                    }
                    .menuStyle(.button)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(store.busy)
                } else if status.openability.canOpen {
                    Button { openCoordinator(store, focus: nil) } label: {
                        Text(status.state == .neverOpened ? "Start coordinator" : "Start a new coordinator")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                }
                if let enabled = document.coordinatorEnabled {
                    let explanation = ProjectPage.automaticExplanation(
                        on: enabled, line: document.integration?.line, ref: document.integration?.ref,
                        readyTaskCount: store.panorama?.buckets.ready)
                    VStack(alignment: .leading, spacing: 4) {
                        Toggle("Automatic", isOn: Binding(
                            get: { enabled },
                            set: { next in Task { notice = await store.setAutomatic(next) } }))
                            .disabled(store.busy || document.configRevision == nil)
                        Text(explanation.text).font(.orbitLabel).foregroundStyle(.secondary)
                        if let warning = explanation.warning {
                            Text(warning).font(.orbitLabel).foregroundStyle(.orange)
                        }
                    }
                }
            } header: {
                HStack(spacing: 8) {
                    Text("Coordinator")
                    Text(pill.label)
                        .font(.orbitLabel.weight(.semibold))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .foregroundStyle(color(pill.tone))
                        .background(color(pill.tone).opacity(0.13), in: Capsule())
                }
                .textCase(nil)
            }
        }
    }

    private func color(_ tone: ProjectPage.Tone) -> Color {
        switch tone {
        case .neutral: return .secondary
        case .brand: return .accentColor
        case .warning: return .orange
        case .error: return .red
        }
    }

    // MARK: goal

    @ViewBuilder
    private func goalSection(_ document: ProjectDocument) -> some View {
        if let goal = document.goal?.trimmingCharacters(in: .whitespacesAndNewlines), !goal.isEmpty {
            Section {
                folded(goal, expanded: $goalExpanded, height: 132)
            } header: {
                sectionHeader("Goal", detail: nil)
            }
        }
    }

    /// Markdown held to a few lines until More, which is what a long brief costs a phone otherwise.
    private func folded(_ source: String, expanded: Binding<Bool>, height: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            MarkdownView(source: source)
                .font(.orbitProse)
                .frame(maxWidth: .infinity, alignment: .leading)
                .frame(maxHeight: expanded.wrappedValue ? nil : height, alignment: .top)
                .clipped()
            Button(expanded.wrappedValue ? "Less" : "More") { expanded.wrappedValue.toggle() }
                .font(.orbitLabel)
                .buttonStyle(.borderless)
        }
    }

    // MARK: task graph

    @ViewBuilder
    private func graphSection(_ store: ProjectDetailModel) -> some View {
        if let graph = store.graph, !graph.marks.isEmpty {
            Section {
                ProjectGraphCard(graph: graph, expanded: $expandedFolds, onOpenTask: openTask)
            } header: {
                sectionHeader("Task graph", detail: "Prerequisite → dependent")
            }
        }
    }

    // MARK: blockers

    @ViewBuilder
    private func blockersSection(_ store: ProjectDetailModel, _ document: ProjectDocument,
                                 now: Date) -> some View {
        if let blockers = document.blockers, !blockers.open.isEmpty {
            Section {
                ForEach(blockers.open) { blocker in blockerRow(blocker, store: store, now: now) }
                if let summary = ProjectPage.blockersResolvedSummary(blockers) {
                    DisclosureGroup {
                        ForEach(blockers.resolved) { blocker in
                            Text(ProjectPage.blockerResolvedLine(blocker))
                                .font(.orbitLabel)
                                .foregroundStyle(.secondary)
                        }
                    } label: {
                        Text(summary).font(.orbitLabel).foregroundStyle(.secondary)
                    }
                }
            } header: {
                sectionHeader("Blockers", detail: ProjectPage.blockersOpen(blockers.open.count))
            }
        }
    }

    private func blockerRow(_ blocker: ProjectBlocker, store: ProjectDetailModel, now: Date) -> some View {
        let headline = ProjectPage.blockerHeadline(blocker)
        return VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(headline.tag)
                    .font(.orbitMeta.weight(.semibold))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .foregroundStyle(headline.tone == .warning ? ProjectPalette.warningInk : ProjectPalette.tone(headline.tone))
                    .background(ProjectPalette.tone(headline.tone).opacity(0.14), in: RoundedRectangle(cornerRadius: 5))
                Text(headline.title).font(.orbitLabel.weight(.semibold)).lineLimit(1)
                Spacer(minLength: 4)
                Text(ProjectPage.blockerSince(blocker.firstSeenAt, now: now))
                    .font(.orbitMeta)
                    .foregroundStyle(.secondary)
            }
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    if let subject = ProjectPage.blockerSubjectLine(blocker) {
                        Text(subject).font(.orbitSubtext).lineLimit(2)
                    }
                    Text(blocker.requiredAction)
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let paths = ProjectPage.blockerPathsLine(blocker.detail.paths) {
                        Text(paths).font(.orbitMeta.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer(minLength: 6)
                Button(ProjectPage.resolveBlockerPress) {
                    resolveReason = ""
                    blockerToResolve = blocker
                }
                .font(.orbitLabel.weight(.semibold))
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .controlSize(.small)
                .disabled(store.busy)
            }
        }
        .padding(.vertical, 2)
    }

    // MARK: run queue

    @ViewBuilder
    private func runQueueSection(_ store: ProjectDetailModel) -> some View {
        if let queue = store.readyQueue {
            Section {
                if let truncated = queue.impactTruncated {
                    let notice = ProjectPage.queueImpactTruncated(maxTasks: truncated.maxTasks)
                    Label {
                        Text("\(notice.title). \(notice.detail)")
                    } icon: {
                        Image(systemName: "exclamationmark.triangle")
                    }
                    .font(.orbitLabel)
                    .foregroundStyle(.orange)
                }
                if queue.items.isEmpty {
                    Text(ProjectPage.queueEmpty).font(.orbitLabel).foregroundStyle(.secondary)
                } else {
                    ForEach(queue.items) { item in queueRow(item, store: store) }
                }
            } header: {
                sectionHeader("Run queue", detail: ProjectPage.queueSummary(queue))
            } footer: {
                if !queue.items.isEmpty {
                    Text(ProjectPage.queueHelp(queue))
                }
            }
        }
    }

    private func queueRow(_ item: ProjectReadyToRun.Item, store: ProjectDetailModel) -> some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(item.title).font(.orbitSubtext).lineLimit(1)
                HStack(spacing: 5) {
                    queueStateMark(item.runState)
                    Text(ProjectPage.queueRowState(item))
                }
                .font(.orbitMeta)
                .foregroundStyle(.secondary)
                Text(ProjectPage.queueImpact(item))
                    .font(.orbitMeta)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            Spacer(minLength: 6)
            queueAction(item, store: store)
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private func queueStateMark(_ state: ProjectReadyToRun.RunState) -> some View {
        switch state {
        case .ready:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .running:
            ProgressView().controlSize(.mini)
        case .queued:
            Image(systemName: "clock").foregroundStyle(Color.accentColor)
        case .paused:
            Image(systemName: "pause.circle").foregroundStyle(.orange)
        }
    }

    @ViewBuilder
    private func queueAction(_ item: ProjectReadyToRun.Item, store: ProjectDetailModel) -> some View {
        switch item.runState {
        case .ready:
            Button {
                Task { notice = await store.run(item.taskId) }
            } label: {
                Label(store.starting.contains(item.taskId) ? ProjectPage.runPressStarting : ProjectPage.runPress,
                      systemImage: "play.circle")
            }
            .font(.orbitLabel.weight(.semibold))
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.capsule)
            .controlSize(.small)
            .disabled(store.busy)
            .accessibilityLabel("Run \(item.title)")
        case .paused where item.pausedList != nil:
            Button(ProjectPage.resumeListPress) { listToResume = item }
                .font(.orbitLabel.weight(.semibold))
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .controlSize(.small)
                .disabled(store.busy)
        case .running where item.sessionId != nil, .queued where item.sessionId != nil:
            Button(ProjectPage.openRunSession) {
                if let session = item.sessionId { model.route(to: .session(session)) }
            }
            .font(.orbitLabel.weight(.semibold))
            .buttonStyle(.borderless)
        default:
            Text(ProjectPage.queueRowTag(item.runState))
                .font(.orbitMeta.weight(.semibold))
                .padding(.horizontal, 6)
                .padding(.vertical, 1)
                .foregroundStyle(.secondary)
                .background(Color.secondary.opacity(0.13), in: RoundedRectangle(cornerRadius: 5))
        }
    }

    // MARK: criteria

    private var criteriaLimit: Int {
        compact ? ProjectPage.criteriaPreviewCompact : ProjectPage.criteriaPreviewRegular
    }

    private func criteriaSection(_ document: ProjectDocument) -> some View {
        let criteria = document.acceptanceCriteriaItems
        let shown = criteriaExpanded ? criteria : Array(criteria.prefix(criteriaLimit))
        return Section {
            if criteria.isEmpty {
                Text(ProjectPage.noCriteria).font(.orbitLabel).foregroundStyle(.secondary)
            } else {
                Text(ProjectPage.criteriaStanding(count: criteria.count))
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(shown) { criterion in
                    criterionRow(criterion, ref: document.integration?.ref)
                }
                if let disclosure = ProjectPage.criteriaDisclosure(total: criteria.count, limit: criteriaLimit,
                                                                   expanded: criteriaExpanded, compact: compact) {
                    VStack(spacing: 4) {
                        Button {
                            withAnimation { criteriaExpanded.toggle() }
                        } label: {
                            HStack(spacing: 6) {
                                Text(disclosure.press)
                                Image(systemName: criteriaExpanded ? "chevron.up" : "chevron.down")
                                    .font(.orbitMeta.weight(.semibold))
                            }
                            .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        Text(disclosure.meta).font(.orbitMeta).foregroundStyle(.secondary)
                    }
                }
            }
        } header: {
            sectionHeader("Acceptance criteria", detail: nil)
        } footer: {
            if !criteria.isEmpty {
                Text(ProjectPage.criteriaOutcomeNote)
            }
        }
    }

    private func criterionRow(_ criterion: ProjectCriterion, ref: String?) -> some View {
        HStack(alignment: .top, spacing: 10) {
            ordinalMark(criterion)
            VStack(alignment: .leading, spacing: 4) {
                Text(criterion.text).font(.orbitSubtext).fixedSize(horizontal: false, vertical: true)
                if let work = ProjectPage.criterionWork(criterion, integrationRef: ref) {
                    (Text(work.state).fontWeight(.semibold)
                        .foregroundColor(criterion.satisfied == true ? .green : .primary)
                     + Text(work.landing.map { " · \($0)" } ?? "")
                        .foregroundColor(work.landingFlagged ? .primary : .secondary)
                     + Text(work.landingWarning.map { " · \($0)" } ?? "").foregroundColor(.orange))
                        .font(.orbitLabel)
                    ForEach(Array(work.reasons.enumerated()), id: \.offset) { _, reason in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(reason.sentence).font(.orbitLabel).foregroundStyle(.secondary)
                            ForEach(Array(reason.heldUpBy.enumerated()), id: \.offset) { _, held in
                                Button { openTask(held.taskId) } label: {
                                    (Text(held.title).foregroundColor(.accentColor)
                                     + Text(" — \(held.action)").foregroundColor(.secondary))
                                        .font(.orbitLabel)
                                        .multilineTextAlignment(.leading)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
                if let method = criterion.verificationMethod, !method.isEmpty {
                    let open = openMethods.contains(criterion.id)
                    Button {
                        if open { openMethods.remove(criterion.id) } else { openMethods.insert(criterion.id) }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: open ? "chevron.down" : "chevron.right")
                                .font(.orbitMeta.weight(.semibold))
                            Text(ProjectPage.howItsChecked)
                        }
                        .font(.orbitLabel)
                    }
                    .buttonStyle(.borderless)
                    if open {
                        Text(method)
                            .font(.orbitLabel)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .padding(.vertical, 2)
    }

    /// The ordinal is the row's one mark: a filled disc for met, a ring for unmet, a dashed ring for
    /// a criterion the read did not answer. Never red — a criterion nothing has met yet has failed
    /// nothing.
    private func ordinalMark(_ criterion: ProjectCriterion) -> some View {
        let mark = ProjectPage.criterionMark(criterion)
        return ZStack {
            switch mark {
            case .met:
                Circle().fill(Color.green)
            case .unmet:
                Circle().stroke(Color.primary.opacity(0.7), lineWidth: 1.5)
            case .unanswered:
                Circle().stroke(Color.secondary, style: StrokeStyle(lineWidth: 1.2, dash: [2.5, 2]))
            }
            Text("\(criterion.ordinal)")
                .font(.orbitMeta.weight(.bold))
                .foregroundStyle(mark == .met ? Color.white : Color.primary)
        }
        .frame(width: 22, height: 22)
    }

    // MARK: instructions

    private func instructionsSection(_ document: ProjectDocument) -> some View {
        Section {
            if let text = document.instructions?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
                folded(text, expanded: $instructionsExpanded, height: 180)
            } else {
                Text(ProjectPage.noInstructions).font(.orbitLabel).foregroundStyle(.secondary)
            }
        } header: {
            sectionHeader(ProjectPage.instructionsHeading, detail: nil)
        }
    }

    // MARK: tasks

    @ViewBuilder
    private func tasksSection(_ store: ProjectDetailModel, _ document: ProjectDocument) -> some View {
        let groups = ProjectPage.taskGroups(store.tasks)
        Section {
            if groups.isEmpty {
                Text("No tasks yet.").font(.orbitLabel).foregroundStyle(.secondary)
            }
            ForEach(groups) { group in
                groupLabel(group.heading)
                ForEach(group.tasks) { task in
                    taskRow(task, document: document, group: group)
                }
            }
            if store.nextTaskCursor != nil {
                Button {
                    Task { await store.loadMoreTasks() }
                } label: {
                    if store.loadingMoreTasks { ProgressView() } else { Text("Load more tasks") }
                }
                .font(.orbitLabel)
            }
        } header: {
            sectionHeader("Tasks", detail: "\(document.taskCount)")
        }
    }

    private func taskRow(_ task: ProjectTaskRow, document: ProjectDocument,
                         group: ProjectPage.TaskGroup) -> some View {
        let tags = ProjectPage.rowTags(task, heading: group.heading, ref: document.integration?.ref,
                                       upstreamRef: document.integration?.upstreamRef)
        return Button { openTask(task.id) } label: {
            HStack(spacing: 10) {
                ProjectGlyphMark(glyph: ProjectPage.taskGlyph(task), size: 9)
                VStack(alignment: .leading, spacing: 3) {
                    Text(task.title)
                        .font(.orbitSubtext)
                        .lineLimit(2)
                        .foregroundStyle(group.settled ? .secondary : .primary)
                    if !tags.isEmpty || task.unmetCount > 0 || task.blocksCount > 0 {
                        HStack(spacing: 6) {
                            ForEach(Array(tags.enumerated()), id: \.offset) { _, tag in
                                Text(tag.text)
                                    .font(.orbitMeta.weight(.semibold))
                                    .lineLimit(1)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 1)
                                    .foregroundStyle(ProjectPalette.tone(tag.tone))
                                    .background(ProjectPalette.tone(tag.tone).opacity(0.13),
                                                in: RoundedRectangle(cornerRadius: 5))
                            }
                            if task.unmetCount > 0 {
                                Text("waits \(task.unmetCount)").font(.orbitMeta).foregroundStyle(.orange)
                            }
                            if task.blocksCount > 0 {
                                Text("blocks \(task.blocksCount)").font(.orbitMeta).foregroundStyle(Color.accentColor)
                            }
                        }
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.forward")
                    .font(.orbitMeta.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// A task opens where tasks live — the Tasks section — through the app's one door for it.
    private func openTask(_ taskID: String) {
        model.route(to: .task(taskID))
    }

    // MARK: menu

    private func menu(_ store: ProjectDetailModel, _ document: ProjectDocument) -> some View {
        Menu {
            if document.status == .open {
                Button { confirmingStatus = .done } label: {
                    Label("Record as done", systemImage: "checkmark.circle")
                }
                Button { confirmingStatus = .cancelled } label: {
                    Label("Record as cancelled", systemImage: "xmark.circle")
                }
            } else {
                Button { confirmingStatus = .open } label: {
                    Label("Reopen project", systemImage: "arrow.uturn.backward.circle")
                }
            }
            if let url = model.projectWebURL(document.id) {
                ShareLink(item: url) { Label("Share link", systemImage: "square.and.arrow.up") }
            }
            Divider()
            Button(role: .destructive) { confirmingDelete = true } label: {
                Label("Delete project", systemImage: "trash")
            }
            .disabled(document.taskCount > 0)
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .disabled(store.busy)
    }

    private var confirmTitle: String {
        let title = model.projects?.detail(projectID).document?.title ?? "this project"
        switch confirmingStatus {
        case .done?: return "Record “\(title)” as done?"
        case .cancelled?: return "Stop pursuing “\(title)”?"
        case .open?: return "Reopen “\(title)”?"
        default: return ""
        }
    }

    private func confirmButton(_ status: ProjectStatus) -> String {
        switch status {
        case .done: return "Record as done"
        case .cancelled: return "Record as cancelled"
        default: return "Reopen"
        }
    }

    /// The web dialog's own evidence, per press: the criteria tally before recording done, the work
    /// left standing before cancelling, and what reopening does not touch.
    private func confirmMessage(_ store: ProjectDetailModel) -> String {
        switch confirmingStatus {
        case .done?:
            let criteria = store.document?.acceptanceCriteriaItems ?? []
            let settled = criteria.filter { $0.satisfied == true }.count
            let noReceipt = criteria.filter { $0.landing == "UNKNOWN" }.count
            let noun = criteria.count == 1 ? "criterion" : "criteria"
            return "\(criteria.count) stated \(noun) · \(settled) settled by the work filed under them · \(noReceipt) with no merge receipt"
        case .cancelled?:
            var unfinished = 0
            if let b = store.panorama?.buckets {
                unfinished = b.running + b.ready + b.blocked
                unfinished += b.awaitingVerification + b.failed
            }
            let stays = unfinished == 1 ? "task stays" : "tasks stay"
            return "\(unfinished) unfinished \(stays) filed under it."
        default:
            return "Reopening puts this project back to Open and changes nothing else: its tasks, its stated criteria and its history stay as they are."
        }
    }

    private func sectionHeader(_ title: String, detail: String?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(title)
            if let detail {
                Text(detail).font(.orbitLabel).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .textCase(nil)
    }
}

#if os(iOS)
/// The bar's title once the page's own header has scrolled away — the session page's shape: the
/// name over a status line, centred, cut short rather than wrapped.
private struct ProjectNavTitle: View {
    let document: ProjectDocument

    var body: some View {
        VStack(spacing: 1) {
            Text(document.title)
                .font(.headline)
                .lineLimit(1)
                .truncationMode(.tail)
            Text("\(document.status == .done ? "Completed" : document.status.label) · \(document.taskCount) task\(document.taskCount == 1 ? "" : "s")")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(maxWidth: 240)
        .clipped()
    }
}
#endif

private extension View {
    /// Grouped cards on iOS, the platform's plain inset list on macOS.
    @ViewBuilder func projectPageListStyle() -> some View {
        #if os(iOS)
        self.listStyle(.insetGrouped)
            .headerProminence(.increased)
        #else
        self.listStyle(.inset)
        #endif
    }
}
