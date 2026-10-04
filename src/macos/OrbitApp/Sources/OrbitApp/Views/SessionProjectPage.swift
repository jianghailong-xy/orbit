#if os(iOS)
import SwiftUI
import OrbitKit

/// The project occupies its coordinator's place, with the same two scan lines as a session row.
/// The progress chip is a sibling button: its full-height hit area opens the project's sessions.
struct SessionProjectRowView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    let row: SessionProjectRow
    let onOpen: () -> Void
    let onSessions: () -> Void

    private var regular: Bool {
        SessionListPresentation.resolve(isCompactWidth: horizontalSizeClass == .compact) == .regular
    }
    private var verticalPadding: CGFloat { regular ? 5 : 2 }

    var body: some View {
        Button(action: onOpen) {
            Group {
                if regular { regularIOSRow } else { compactRow }
            }
            .contentShape(Rectangle())
            .accessibilityElement(children: .combine)
            .accessibilityValue(statusWords)
        }
        .buttonStyle(.plain)
        .overlay(alignment: .leading) { progressTap }
    }

    private var compactRow: some View {
        VStack(alignment: .leading, spacing: 3) {
            firstLine
            secondLine
        }
        .padding(.vertical, 2)
    }

    private var regularIOSRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            firstLine
            secondLine
        }
        .padding(.vertical, 5)
    }

    private var firstLine: some View {
        HStack(spacing: 8) {
            Image(systemName: "square.grid.2x2")
                .font(.orbitMeta)
                .foregroundStyle(.blue)
                .accessibilityHidden(true)
            Text(row.title)
                .bold()
                .foregroundStyle(.primary)
                .lineLimit(1)
                .layoutPriority(1)
            Spacer(minLength: 8)
            liveIndicator
            if let timestamp = row.lastTurnAt ?? row.createdAt,
               let relative = RelativeTime.format(timestamp) {
                Text(relative)
                    .font(.orbitMeta)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: regular, vertical: false)
            }
        }
    }

    private var secondLine: some View {
        HStack(spacing: 7) {
            // Reserve exactly the visible chip's width; the sibling button draws it over this slot.
            progressChip.hidden()
            Text(row.line.text)
                .font(.orbitListSubtitle)
                .foregroundStyle(lineColor)
                .lineLimit(1)
        }
    }

    private var progressTap: some View {
        GeometryReader { proxy in
            Button(action: onSessions) {
                VStack(spacing: 0) {
                    Spacer(minLength: 0)
                    progressChip
                }
                .padding(.bottom, verticalPadding)
                .frame(height: proxy.size.height)
                // Include the List's top and bottom cell insets without changing its row height.
                .padding(.vertical, 15)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .offset(y: -15)
            .accessibilityLabel(SessionProjectCopy.sessions)
            .accessibilityValue(SessionProjectCopy.progressHint(sessions: row.sessionCount,
                                                                 running: row.runningCount))
        }
    }

    private var progressChip: some View {
        SessionProjectProgressChip(counts: row.taskCounts, running: row.runningCount, status: row.status)
    }

    @ViewBuilder private var liveIndicator: some View {
        switch row.indicator {
        case .needsYou:
            Circle().fill(.orange).frame(width: 7, height: 7)
        case .running:
            SpinnerGlyph(color: .secondary)
        case .jobs:
            BreathingGlyph(systemImage: "terminal")
        case nil:
            EmptyView()
        }
    }

    private var lineColor: Color {
        switch row.line.tone {
        case .approval: return .orange
        case .running: return .blue
        case .preview, .queued, .background, .watching, .review: return .secondary
        }
    }

    private var statusWords: String {
        switch row.indicator {
        case .needsYou: return "Waiting for you"
        case .running: return "Session running"
        case .jobs: return "Background job running"
        case nil: return row.status.label
        }
    }
}

private struct SessionProjectProgressChip: View {
    let counts: ProjectSidebarTaskCounts?
    let running: Int
    let status: ProjectStatus

    var body: some View {
        HStack(spacing: 4) {
            if let counts {
                SessionProjectProgressBar(counts: counts, running: running)
                    .frame(width: 26)
                Text(SessionProjectCopy.progress(done: counts.done, total: counts.total))
            } else {
                Text(status.label)
            }
        }
        .font(.caption2.weight(.semibold))
        .monospacedDigit()
        .foregroundStyle(status == .done ? Color.green : .secondary)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(status == .done ? Color.green.opacity(0.14) : Color.secondary.opacity(0.14),
                    in: RoundedRectangle(cornerRadius: 5))
        .fixedSize(horizontal: true, vertical: false)
    }
}

private struct SessionProjectProgressBar: View {
    let counts: ProjectSidebarTaskCounts
    let running: Int

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Color.secondary.opacity(0.3)
                if counts.total > 0 {
                    HStack(spacing: 0) {
                        Color.green.frame(width: proxy.size.width * CGFloat(counts.done) / CGFloat(counts.total))
                        Color.blue.frame(width: proxy.size.width * CGFloat(running) / CGFloat(counts.total))
                        Color.red.frame(width: proxy.size.width * CGFloat(counts.failed) / CGFloat(counts.total))
                    }
                }
            }
        }
        .frame(height: 4)
        .clipShape(Capsule())
        .accessibilityHidden(true)
    }
}

/// Pin and Move affect the coordinator; the project has no completion, sharing or deletion action.
private struct SessionProjectRowActions: ViewModifier {
    @Environment(AppModel.self) private var app
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    let row: SessionProjectRow
    let onCoordinator: () -> Void
    let onSessions: () -> Void
    let onProject: () -> Void
    let onMove: () -> Void

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *), horizontalSizeClass == .compact {
            content
                .contextMenu { menu }
                .circleSwipeActions(id: "project-\(row.projectId)", leading: leadingActions,
                                    trailing: trailingActions, leadingFullSwipe: row.coordinator != nil)
        } else {
            content
                .swipeActions(edge: .leading, allowsFullSwipe: row.coordinator != nil) {
                    ForEach(leadingActions) { actionButton($0) }
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    ForEach(trailingActions) { actionButton($0) }
                }
                .contextMenu { menu }
        }
    }

    @ViewBuilder
    private var menu: some View {
        Button(action: onCoordinator) {
            Label(SessionProjectCopy.openCoordinator, systemImage: "bubble.left")
        }
        .disabled(row.coordinator == nil)
        Button(action: onSessions) { Label(SessionProjectCopy.sessions, systemImage: "list.bullet") }
        Button(action: onProject) { Label(SessionProjectCopy.openProject, systemImage: "square.grid.2x2") }
        Divider()
        actionButton(pinAction)
        Button(action: onMove) { Label(SessionProjectCopy.move, systemImage: "folder") }
            .disabled(row.coordinator == nil)
    }

    private var leadingActions: [RowSwipeAction] { row.coordinator == nil ? [] : [pinAction] }
    private var trailingActions: [RowSwipeAction] {
        row.coordinator == nil ? [] : [RowSwipeAction(title: "Move", systemImage: "folder", tint: .indigo,
                                                    perform: onMove)]
    }
    private var pinAction: RowSwipeAction {
        let pinned = row.coordinator?.pinnedAt != nil
        return RowSwipeAction(title: pinned ? SessionProjectCopy.unpin : SessionProjectCopy.pin,
                              systemImage: pinned ? "pin.slash" : "pin", tint: .indigo,
                              isEnabled: row.coordinator != nil) {
            if let coordinator = row.coordinator { app.setPinned(coordinator, pinned: !pinned) }
        }
    }
    private func actionButton(_ action: RowSwipeAction) -> some View {
        Button(action: action.perform) { Label(action.title, systemImage: action.systemImage) }
            .tint(action.tint)
            .disabled(!action.isEnabled)
    }
}

extension View {
    func sessionProjectRowActions(_ row: SessionProjectRow, onCoordinator: @escaping () -> Void,
                                  onSessions: @escaping () -> Void, onProject: @escaping () -> Void,
                                  onMove: @escaping () -> Void) -> some View {
        modifier(SessionProjectRowActions(row: row, onCoordinator: onCoordinator, onSessions: onSessions,
                                          onProject: onProject, onMove: onMove))
    }
}

/// The same page is pushed on iPhone and replaces the session column on iPad.
struct SessionProjectPage: View {
    @Environment(AppModel.self) private var app
    let address: SessionProjectAddress
    var rowNavigation: SessionRowNavigation = .push
    var searchQuery: Binding<String>? = nil

    @State private var rowSwipe = RowSwipeState()
    @State private var taggingSession: Session?
    @State private var sharingSession: Session?
    @State private var movingSession: Session?
    @State private var hits: [SessionSearchHit] = []
    @State private var hitsQuery = ""
    @State private var contentSearched = true
    @State private var searching = false
    @AppStorage("sessionList.pinnedCollapsed") private var pinnedCollapsed = false

    private var sessions: [Session] { app.projectSessions }
    private var project: ProjectSummary? {
        app.projects?.sidebarProjects.first { $0.id == address.projectID } ?? app.projects?.project(address.projectID)
    }
    private var coordinator: Session? {
        sessions.first { $0.projectMembership?.role == .coordinator }
    }
    private var availableCoordinator: Session? {
        coordinator ?? app.sessions.first {
            $0.projectMembership?.projectId == address.projectID && $0.projectMembership?.role == .coordinator
        }
    }
    private var titleText: String {
        project?.title ?? sessions.first?.projectMembership?.projectTitle ?? "Project"
    }
    private var query: String {
        searchQuery?.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }
    private var isSearching: Bool { !query.isEmpty }
    private var timeSections: [SessionTimeSection] {
        SessionTimeGrouping.sections(sessions.filter { $0.projectMembership?.role != .coordinator },
                                     pinnedFirst: address.view == .open)
    }
    private var selection: Binding<String?>? {
        guard rowNavigation == .selection else { return nil }
        return Binding(get: { app.selectedAgentSessionID }, set: { id in
            if let session = sessions.first(where: { $0.id == id }) {
                app.openProjectMember(session, push: false)
            }
        })
    }

    var body: some View {
        List(selection: selection) {
            if isSearching {
                searchResults
            } else {
                progressCard
                    .listRowSeparator(.hidden)
                if let coordinator {
                    Section(SessionProjectCopy.coordinatorSection) { sessionRow(coordinator) }
                }
                ForEach(timeSections) { section in
                    if section.title == "Pinned" {
                        Section {
                            if !pinnedCollapsed {
                                ForEach(section.sessions) { sessionRow($0) }
                            }
                        } header: {
                            pinnedSectionHeader
                        }
                    } else {
                        Section {
                            ForEach(section.sessions) { sessionRow($0) }
                        } header: {
                            Text(section.title).textCase(nil)
                        }
                    }
                }
            }
        }
        .listStyle(.plain)
        .navigationBarTitleDisplayMode(.inline)
        .rowSwipeList(rowSwipe)
        .refreshable { await app.loadProjectSessions(address) }
        .overlay {
            if isSearching {
                if hits.isEmpty && !searching && !hitsQuery.isEmpty {
                    ContentUnavailableView("No matches", systemImage: "magnifyingglass",
                                           description: Text("Nothing matches \u{201C}\(hitsQuery)\u{201D}."))
                }
            } else if sessions.isEmpty && !app.projectSessionsLoading {
                if let failure = app.projectSessionsError {
                    ContentUnavailableView("Couldn't load sessions", systemImage: "exclamationmark.bubble",
                                           description: Text(failure))
                } else {
                    ContentUnavailableView("No sessions", systemImage: "bubble.left.and.bubble.right")
                }
            }
        }
        .toolbar {
            if rowNavigation == .selection {
                ToolbarItem(placement: .topBarLeading) {
                    Button { app.leaveProjectSessions(address.projectID) } label: {
                        Label("Back", systemImage: "chevron.backward")
                    }
                    .accessibilityLabel("Back to the workspace's sessions")
                }
            }
            ToolbarItem(placement: .principal) { title }
            ToolbarItem(placement: .topBarTrailing) { projectMenu }
        }
        .sheet(item: $taggingSession) { SessionTagSheet(session: $0).environment(app) }
        .sheet(item: $sharingSession) { session in
            if let baseURL = app.baseURL {
                ShareSheet(kind: .session, rootID: session.id, baseURL: baseURL, tokenStore: app.tokenStore)
            }
        }
        .sheet(item: $movingSession) { session in
            if let agent = app.agents?.agent(session.agent?.id ?? session.agentId ?? address.agentID) {
                SessionMoveSheet(session: session, workspace: agent, listed: sessions).environment(app)
            }
        }
        .task(id: address) {
            await app.loadProjectSessions(address)
            await app.projects?.load()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(4))
                if Task.isCancelled { break }
                await app.loadProjectSessions(address)
            }
        }
        .task(id: query) { await runSearch() }
    }

    private var title: some View {
        VStack(spacing: 1) {
            Text(titleText).font(.headline).lineLimit(1)
            Text(SessionProjectCopy.pageSubtitle(sessions: sessions.count))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: 240)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    private var progressCard: some View {
        HStack(spacing: 10) {
            if let counts = project?.taskCounts {
                SessionProjectProgressBar(counts: counts, running: project?.buckets.running ?? 0)
                    .frame(width: 66)
                Text(SessionProjectCopy.pageProgress(done: counts.done, total: counts.total,
                                                     running: project?.buckets.running ?? 0))
                    .font(.orbitMeta)
                    .foregroundStyle(.secondary)
            } else {
                Text(project?.status.label ?? sessions.first?.projectMembership?.projectStatus.label ?? "Project")
                    .font(.orbitMeta)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 4)
            Button { app.openProject(address.projectID) } label: {
                HStack(spacing: 4) {
                    Text("Project")
                    Image(systemName: "chevron.right")
                }
                .font(.orbitMeta.weight(.semibold))
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.accentColor)
        }
        .padding(12)
        .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
        .padding(.vertical, 4)
    }

    private var projectMenu: some View {
        Menu {
            Button { app.openProject(address.projectID) } label: {
                Label(SessionProjectCopy.openProject, systemImage: "square.grid.2x2")
            }
            Button {
                if let coordinator = availableCoordinator {
                    app.openProjectMember(coordinator, push: rowNavigation == .push)
                }
            } label: {
                Label(SessionProjectCopy.openCoordinator, systemImage: "bubble.left")
            }
            .disabled(availableCoordinator == nil)
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("Project actions")
    }

    @ViewBuilder private func sessionRow(_ session: Session) -> some View {
        let row = AgentSessionRow(session: session, showsPin: address.view == .open)
        switch rowNavigation {
        case .selection:
            row.sessionRowActions(session, scope: address.view, onTag: { taggingSession = session },
                                  onShare: { sharingSession = session }, onMove: { movingSession = session })
                .tag(session.id)
        case .push:
            Button { app.openProjectMember(session, push: true) } label: { row.foregroundStyle(.primary) }
                .sessionRowActions(session, scope: address.view, onTag: { taggingSession = session },
                                   onShare: { sharingSession = session }, onMove: { movingSession = session })
        }
    }

    private var pinnedSectionHeader: some View {
        Button {
            withAnimation { pinnedCollapsed.toggle() }
        } label: {
            HStack {
                Text("Pinned").textCase(nil)
                Spacer()
                Image(systemName: "chevron.right")
                    .rotationEffect(.degrees(pinnedCollapsed ? 0 : 90))
                    .accessibilityHidden(true)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(.isHeader)
    }

    private var searchResults: some View {
        Section {
            ForEach(hits) { hit in
                Button { app.route(to: .session(hit.id)) } label: {
                    SessionSearchRow(hit: hit, query: hitsQuery)
                }
                .buttonStyle(.plain)
            }
        } header: {
            Text(contentSearched ? "All sessions" : "Matching names only — type more to search message text.")
                .textCase(nil)
        }
    }

    /// The wide column keeps the same global session search as the folder and workspace pages.
    private func runSearch() async {
        let q = query
        guard !q.isEmpty else {
            hits = []
            hitsQuery = ""
            return
        }
        try? await Task.sleep(for: sessionSearchDebounce)
        guard !Task.isCancelled else { return }
        searching = true
        defer { searching = false }
        guard let result = await app.searchSessions(q), !Task.isCancelled else { return }
        hits = result.hits
        contentSearched = result.contentSearched
        hitsQuery = result.q
    }
}
#endif
