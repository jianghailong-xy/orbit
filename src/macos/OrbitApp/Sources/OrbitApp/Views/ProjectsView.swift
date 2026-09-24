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
        let total = max(1, segments.reduce(0) { $0 + $1.value })
        GeometryReader { geo in
            HStack(spacing: 1.5) {
                ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                    if segment.value > 0 {
                        segment.color
                            .frame(width: max(2, (geo.size.width - CGFloat(segments.count) * 1.5)
                                            * CGFloat(segment.value) / CGFloat(total)))
                    }
                }
                Spacer(minLength: 0)
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
            }
            .searchable(text: $query, prompt: "Search projects")
            .overlay {
                ProjectsPlaceholder(store: store,
                                    noMatch: !query.isEmpty && filtered(store.projects).isEmpty)
            }
            .navigationTitle("Projects")
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
        HStack(spacing: 6) {
            Text(group.section.title)
            Text("\(group.projects.count)").foregroundStyle(.secondary)
            Spacer(minLength: 0)
            if group.section.defaultCollapsed, query.isEmpty {
                Button(showsCompleted ? "Hide" : "Show") { showsCompleted.toggle() }
                    .font(.orbitLabel)
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
            // A `Button`, not a `NavigationLink(value:)` — see `AppModel.push`.
            Button { model.push(.projectDetail(projectID: project.id)) } label: {
                row.foregroundStyle(.primary)
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
                Text(chip.text)
                    .font(.orbitLabel.weight(.semibold))
                    .lineLimit(1)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .foregroundStyle(chip.tone == .warning ? Color.orange : Color.accentColor)
                    .background((chip.tone == .warning ? Color.orange : Color.accentColor).opacity(0.13),
                                in: RoundedRectangle(cornerRadius: 6))
            }
            HStack(spacing: 10) {
                ProjectMeter(segments: meterSegments).frame(maxWidth: 110)
                counts
                Spacer(minLength: 0)
                if let line = ProjectAttention.integrationChip(of: project) {
                    Label(line.text, systemImage: line.isBranch ? "arrow.triangle.branch" : "arrow.down.to.line")
                        .labelStyle(.titleAndIcon)
                        .font(.orbitMeta)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
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
                        ProjectGlyphMark(glyph: lane.0, size: 7)
                        Text(lane.1.formatted()).monospacedDigit()
                    }
                }
            }
        }
        .font(.orbitMeta)
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

/// One project's page, in the order a reader on a phone needs it: what is waiting on them, where
/// the work stands, who is coordinating it, and then the goal, the criteria and the tasks.
struct ProjectDetailView: View {
    @Environment(AppModel.self) private var model
    let projectID: String

    @State private var notice: String?
    @State private var confirmingStatus: ProjectStatus?
    @State private var confirmingDelete = false
    @State private var goalExpanded = false
    /// The page's own header carries the whole title; the bar takes it once that header scrolls
    /// away, so one title is never drawn twice.
    @State private var headerOnScreen = true

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
        .navigationTitle(headerOnScreen && store.document != nil
                         ? "" : (store.document?.title ?? model.projects?.project(projectID)?.title ?? "Project"))
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
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
            criteriaSection(document)
            tasksSection(store, document)
        }
        .projectPageListStyle()
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

    // MARK: work overview

    @ViewBuilder
    private func overviewSection(_ store: ProjectDetailModel, _ document: ProjectDocument) -> some View {
        if let panorama = store.panorama {
            let cells = ProjectPage.overviewCells(panorama.buckets, taskCount: panorama.shape.taskCount,
                                                  line: document.integration?.line)
            Section {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), alignment: .topLeading), count: 3),
                          alignment: .leading, spacing: 12) {
                    ForEach(cells) { cell in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 4) {
                                ProjectGlyphMark(glyph: cell.glyph, size: 8)
                                Text(cell.label).lineLimit(1).minimumScaleFactor(0.8)
                            }
                            .font(.orbitMeta)
                            .foregroundStyle(.secondary)
                            Text(cell.value.formatted())
                                .font(.title2.weight(.bold))
                                .monospacedDigit()
                            Text(cell.footnote)
                                .font(.orbitMeta)
                                .foregroundStyle(.tertiary)
                                .lineLimit(2)
                        }
                    }
                }
                .padding(.vertical, 4)
                ProjectMeter(segments: cells.map { (value: $0.value, color: ProjectPalette.color($0.glyph)) },
                             height: 7)
                    .padding(.vertical, 4)
            } header: {
                sectionHeader("Work overview", detail: ProjectPage.overviewSubtitle(panorama.shape))
            }
        }
    }

    // MARK: coordinator

    @ViewBuilder
    private func coordinatorSection(_ store: ProjectDetailModel, _ document: ProjectDocument,
                                    now: Date) -> some View {
        if let status = store.coordinator {
            let pill = ProjectPage.coordinatorPill(status)
            let coordination = status.coordination
            Section {
                if let session = coordination.session {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(session.title ?? "Coordinator").font(.orbitSubtext.weight(.semibold))
                        Text([ProjectPage.lastActive(session, readAt: status.readAt),
                              ProjectPage.coordinatorOrdinal(coordination.coordinatorGeneration)]
                                .compactMap { $0 }.joined(separator: " · "))
                            .font(.orbitLabel)
                            .foregroundStyle(.secondary)
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
                if status.openability.canOpen || status.state == .live {
                    Button { openCoordinator(store, focus: nil) } label: {
                        Text(coordinatorButton(status, pill: pill)).frame(maxWidth: .infinity)
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

    private func coordinatorButton(_ status: ProjectCoordinatorStatus, pill: ProjectPage.Pill) -> String {
        switch status.state {
        case .neverOpened: return "Start coordinator"
        case .trashed: return "Start a new coordinator"
        default: return pill.label == "Needs you" ? "Reply to coordinator" : "Open conversation"
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

    // MARK: goal and criteria

    @ViewBuilder
    private func goalSection(_ document: ProjectDocument) -> some View {
        if let goal = document.goal?.trimmingCharacters(in: .whitespacesAndNewlines), !goal.isEmpty {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    MarkdownView(source: goal)
                        .font(.orbitProse)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .frame(maxHeight: goalExpanded ? nil : 96, alignment: .top)
                        .clipped()
                    Button(goalExpanded ? "Less" : "More") { goalExpanded.toggle() }
                        .font(.orbitLabel)
                        .buttonStyle(.borderless)
                }
            } header: {
                sectionHeader("Goal", detail: nil)
            }
        }
    }

    @ViewBuilder
    private func criteriaSection(_ document: ProjectDocument) -> some View {
        if !document.acceptanceCriteriaItems.isEmpty {
            Section {
                ForEach(document.acceptanceCriteriaItems) { criterion in
                    criterionRow(criterion, ref: document.integration?.ref)
                }
            } header: {
                sectionHeader("Acceptance criteria", detail: nil)
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
                    taskRow(task, document: document, settled: group.settled)
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

    private func taskRow(_ task: ProjectTaskRow, document: ProjectDocument, settled: Bool) -> some View {
        let tags = [ProjectPage.workTag(task),
                    ProjectPage.integrationTag(task, ref: document.integration?.ref,
                                               upstreamRef: document.integration?.upstreamRef)]
            .compactMap { $0 }
        return Button { openTask(task.id) } label: {
            HStack(spacing: 10) {
                ProjectGlyphMark(glyph: ProjectPage.taskGlyph(task), size: 9)
                VStack(alignment: .leading, spacing: 3) {
                    Text(task.title)
                        .font(.orbitSubtext)
                        .lineLimit(2)
                        .foregroundStyle(settled ? .secondary : .primary)
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
            return "\(criteria.count) stated \(criteria.count == 1 ? "criterion" : "criteria") · "
                + "\(settled) settled by the work filed under them · \(noReceipt) with no merge receipt"
        case .cancelled?:
            let unfinished = (store.panorama?.buckets).map {
                $0.running + $0.ready + $0.blocked + $0.awaitingVerification + $0.failed
            } ?? 0
            return "\(unfinished) unfinished \(unfinished == 1 ? "task stays" : "tasks stay") filed under it."
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
