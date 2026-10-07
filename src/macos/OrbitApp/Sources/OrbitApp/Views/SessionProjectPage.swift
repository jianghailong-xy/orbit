#if os(iOS)
import SwiftUI
import OrbitKit

/// The project occupies its coordinator's place, with the same two scan lines as a session row.
/// A tap opens the project's sessions; Open Session in the menu reaches the grouping target.
struct SessionProjectRowView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    let row: SessionProjectRow
    let onOpen: () -> Void

    private var regular: Bool {
        SessionListPresentation.resolve(isCompactWidth: horizontalSizeClass == .compact) == .regular
    }

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
            Text(row.title)
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
                    .lineLimit(1)
                    .fixedSize()
            }
        }
    }

    private var secondLine: some View {
        HStack(spacing: 7) {
            progressChip
            Text(row.line.text)
                .font(.orbitListSubtitle)
                .foregroundStyle(lineColor)
                .lineLimit(1)
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
    let onOpen: () -> Void
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
        Button(action: onOpen) {
            Label(SessionProjectCopy.openSession, systemImage: "bubble.left")
        }
        .disabled(!canOpenSession)
        Button(action: onSessions) { Label(SessionProjectCopy.sessions, systemImage: "list.bullet") }
        Button(action: onProject) { Label(SessionProjectCopy.openProject, systemImage: "square.grid.2x2") }
        Divider()
        actionButton(pinAction)
        Button(action: onMove) { Label(SessionProjectCopy.move, systemImage: "folder") }
            .disabled(row.coordinator == nil)
    }

    private var canOpenSession: Bool {
        if case .session = row.target { return true }
        return false
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
    func sessionProjectRowActions(_ row: SessionProjectRow, onOpen: @escaping () -> Void,
                                  onSessions: @escaping () -> Void, onProject: @escaping () -> Void,
                                  onMove: @escaping () -> Void) -> some View {
        modifier(SessionProjectRowActions(row: row, onOpen: onOpen, onSessions: onSessions,
                                          onProject: onProject, onMove: onMove))
    }
}

/// The same page is pushed on iPhone and replaces the session column on iPad.
struct SessionProjectPage: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let address: SessionProjectAddress
    var rowNavigation: SessionRowNavigation = .push

    @State private var rowSwipe = RowSwipeState()
    @State private var taggingSession: Session?
    @State private var sharingSession: Session?
    @State private var movingSession: Session?
    @State private var promotionReview: PromotionReviewTarget?
    @State private var promotionQueue: PromotionQueueTarget?
    @State private var promotionReceipt: PromotionReceiptTarget?
    @State private var startSheet: StartSheet?

    /// Which start card the start row opened over the page.
    private enum StartSheet: String, Identifiable {
        /// The coordinator's request, answered here (`RequestedStartProjectSheet`).
        case asked
        /// The owner's own start, set by the default rule (`OwnerStartProjectSheet`).
        case own

        var id: String { rawValue }
    }

    /// This page's members — never what the model still holds for another address. Its first frame
    /// comes before its load has begun, and the load opens on what the app already holds.
    private var sessions: [Session] { app.projectSessionsAddress == address ? app.projectSessions : [] }
    /// Nothing has been read for this page until its own load has begun.
    private var loading: Bool { app.projectSessionsLoading || app.projectSessionsAddress != address }
    /// This project's merge into main — never another project's, which the model still holds for
    /// the moment between an address change and its first read.
    private var merge: ProjectMergeModel? {
        app.projectSessionsMerge.flatMap { $0.projectID == address.projectID ? $0 : nil }
    }
    private var runningCount: Int {
        sessions.filter { session in
            if case .spinner = SessionStatusGlyph.make(for: session, watching: app.watches?.summary(for: session.id)).shape {
                return true
            }
            return false
        }.count
    }
    private var project: ProjectSummary? {
        app.projects?.sidebarProjects.first { $0.id == address.projectID } ?? app.projects?.project(address.projectID)
    }
    private var coordinator: Session? {
        sessions.first { $0.projectMembership?.role == .coordinator }
    }
    /// A project nobody has started, as its sidebar row says: the progress line says so.
    private var notStarted: Bool {
        project?.status == .open && project?.started == false
    }
    /// The start row (docs/mocks/project-start-sessions-page), by the project page's own rule: the
    /// coordinator's request, the owner's own Start…, or nothing — nothing, too, until the open
    /// items have answered, so the row never shows one press and then the other.
    private var startRow: StartProject.PageRow? {
        guard let project else { return nil }
        return StartProject.pageRow(status: project.status, started: project.started,
                                    openItems: app.projectSessionsOpenItems)
    }
    private var titleText: String {
        project?.title ?? sessions.first?.projectMembership?.projectTitle ?? "Project"
    }
    /// The member sessions by recency, with the merges into main already made drawn among them at
    /// their own instant (owner decision 2026-10-06). No Pinned section: the page has none.
    private var timeSections: [ProjectTimelineSection] {
        ProjectTimeline.sections(sessions: sessions.filter { $0.projectMembership?.role != .coordinator },
                                 merges: merge?.receipts ?? [])
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
            progressCard
                .listRowSeparator(.hidden)
            mergeCard
                .listRowSeparator(.hidden)
            if let coordinator {
                Section(SessionProjectCopy.coordinatorSection) { sessionRow(coordinator) }
            }
            ForEach(timeSections) { section in
                Section {
                    ForEach(section.items) { item in
                        switch item {
                        case .session(let session): sessionRow(session)
                        case .merge(let receipt): mergeRow(receipt)
                        }
                    }
                } header: {
                    Text(section.title).textCase(nil)
                }
            }
        }
        .listStyle(.plain)
        .navigationBarTitleDisplayMode(.inline)
        .rowSwipeList(rowSwipe)
        .refreshable {
            await withTaskGroup(of: Void.self) { group in
                group.addTask { @MainActor in await app.loadProjectSessions(address) }
                group.addTask { @MainActor in await app.loadProjectIntegration(address) }
                group.addTask { @MainActor in await app.loadProjectMerge(address, force: true) }
                group.addTask { @MainActor in await app.loadProjectStart(address) }
            }
        }
        .overlay {
            // A failure stays up while the next poll is in flight, rather than blinking out every 4s.
            if sessions.isEmpty, app.projectSessionsAddress == address, let failure = app.projectSessionsError {
                ContentUnavailableView {
                    Label("Couldn't load sessions", systemImage: "exclamationmark.bubble")
                } description: {
                    Text(CodexSignIn.sentence(failure))
                } actions: {
                    Button("Retry") { Task { await app.loadProjectSessions(address) } }
                }
            } else if sessions.isEmpty && !loading {
                ContentUnavailableView("No sessions", systemImage: "bubble.left.and.bubble.right")
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
            ToolbarItem(placement: .topBarTrailing) { openProjectButton }
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
        // Hosted here rather than by the card or the row, so a poll redrawing either cannot dismiss
        // what the owner is reading. The review is the coordinator conversation's own sheet.
        .sheet(item: $promotionReview) { target in
            if let merge { PromotionReviewSheet(source: merge, promotionID: target.id) }
        }
        // The queue a waiting merge is in (§2.2 J1): what the card's "queued 70m 55s" meant, and
        // who is ahead of it. Opened by tapping the landing row while the merge waits its turn.
        .sheet(item: $promotionQueue) { _ in
            if let merge, let view = merge.current {
                IntegrationQueueSheet(model: merge, promotion: view)
            }
        }
        .sheet(item: $promotionReceipt) { PromotionReceiptSheet(promotion: $0.promotion) }
        // The start card over this page, from the project page's own store, read afresh as it opens:
        // this page holds none of the criteria, the plan or the line it is set from.
        .sheet(item: $startSheet) { sheet in
            if let store = app.projects?.detail(address.projectID) {
                Group {
                    switch sheet {
                    case .asked: RequestedStartProjectSheet(store: store, onViewTasks: { viewStartTasks() })
                    case .own: OwnerStartProjectSheet(store: store, onViewTasks: { viewStartTasks() })
                    }
                }
                .task { await store.load() }
            }
        }
        // Side by side, each on its own 4-second poll: the landing line, the merge card and the start
        // row never wait behind the member lists, the slowest reads the page makes, and a poll of the
        // members asks for neither list again unless something moved (`pollProjectSessions`).
        .task(id: address) {
            await withTaskGroup(of: Void.self) { group in
                group.addTask { @MainActor in
                    await app.loadProjectSessions(address)
                    await Self.poll { await app.pollProjectSessions(address) }
                }
                group.addTask { @MainActor in
                    await app.loadProjectIntegration(address)
                    await Self.poll { await app.loadProjectIntegration(address) }
                }
                group.addTask { @MainActor in
                    await app.loadProjectMerge(address)
                    await Self.poll { await app.loadProjectMerge(address) }
                }
                group.addTask { @MainActor in
                    await app.projects?.load()
                    await app.loadProjectStart(address)
                    await Self.poll { await app.loadProjectStart(address) }
                }
            }
        }
    }

    /// `read` again 4 seconds after each one ends, until the page's task is cancelled: the page
    /// went, or its address changed.
    private static func poll(_ read: () async -> Void) async {
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(4))
            if Task.isCancelled { break }
            await read()
        }
    }

    private var title: some View {
        VStack(spacing: 1) {
            Text(titleText).font(.headline).lineLimit(1)
            // No count while no member is known yet, from the app's lists or the read: "0 sessions"
            // would be a claim nobody checked.
            Text(loading && sessions.isEmpty
                 ? SessionProjectCopy.pageSubtitleLoading
                 : SessionProjectCopy.pageSubtitle(sessions: sessions.count))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: 240)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    private var progressCard: some View {
        VStack(spacing: 0) {
            progressLine
            startLine
            landingLine
        }
        .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
        .padding(.vertical, 4)
    }

    private var progressLine: some View {
        HStack(spacing: 10) {
            if let counts = project?.taskCounts {
                SessionProjectProgressBar(counts: counts, running: runningCount)
                    .frame(width: 66)
                Text(notStarted ? SessionProjectCopy.pageNotStarted(tasks: counts.total)
                                : SessionProjectCopy.pageProgress(done: counts.done, total: counts.total,
                                                                  running: runningCount))
                    .font(.orbitMeta)
                    .foregroundStyle(.secondary)
            } else {
                Text(project?.status.label ?? sessions.first?.projectMembership?.projectStatus.label ?? "Project")
                    .font(.orbitMeta)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(12)
    }

    /// The start, under the progress line, while nobody has started the project
    /// (docs/mocks/project-start-sessions-page): the coordinator's request — Ready to start, since
    /// when, what it suggests, and Review and start — or, with none, the owner's own Start…, quiet.
    /// Either opens the start card over this page, and only that card's Start the project starts
    /// anything. Not counted as needing the reader, as a start request is counted nowhere.
    @ViewBuilder private var startLine: some View {
        if let row = startRow {
            VStack(alignment: .leading, spacing: 10) {
                switch row {
                case .asked(let item):
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 7) {
                            Circle().fill(Color.orange).frame(width: 8, height: 8)
                            Text(StartProject.readyToStart).font(.orbitLabel.weight(.semibold))
                            Spacer(minLength: 8)
                            if let ago = RelativeTime.format(item.waitingSince) {
                                Text(SessionProjectCopy.startAsked(ago))
                                    .font(.orbitMeta).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                        if let settings = item.startRequest?.settings {
                            Text(SessionProjectCopy.startSuggestion(settings))
                                .font(.orbitMeta).foregroundStyle(.secondary)
                                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
                                .padding(.leading, 15)
                        }
                    }
                    .accessibilityElement(children: .combine)
                    Button { openStart(.asked) } label: {
                        Text(SessionProjectCopy.startReview).font(.orbitLabel.weight(.semibold))
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityHint(SessionProjectCopy.startHint)
                case .own:
                    HStack(spacing: 7) {
                        Circle().fill(Color.secondary.opacity(0.45)).frame(width: 8, height: 8)
                        Text(SessionProjectCopy.startNotAsked).font(.orbitMeta).foregroundStyle(.secondary)
                    }
                    Button { openStart(.own) } label: {
                        Text(StartProject.rowOwn).font(.orbitLabel.weight(.semibold))
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .accessibilityHint(SessionProjectCopy.startHint)
                }
            }
            .buttonBorderShape(.capsule)
            .controlSize(.large)
            .tint(Color.accentColor)
            .padding(.horizontal, 12)
            .padding(.bottom, 12)
        }
    }

    private func openStart(_ sheet: StartSheet) {
        PlatformHaptics.tap()
        startSheet = sheet
    }

    /// The start card's "View tasks ›": the project's page, where its task list is.
    private func viewStartTasks() {
        startSheet = nil
        openProject()
    }

    /// The project page's landing line, drawn only while something is in flight; a tap opens the
    /// project page, whose Work overview carries the same row. A merge job's line is the merge
    /// card's (`mergeCard`), so this one stays about tasks landing on the project branch.
    @ViewBuilder private var landingLine: some View {
        if let integration = app.projectSessionsIntegration, integration.inFlight != nil,
           !ProjectMergeCard.isMergeJob(integration.inFlight) {
            Divider().padding(.leading, 12)
            TimelineView(.periodic(from: .now, by: 1)) { context in
                if let line = ProjectMergeCard.progressLandingLine(integration, now: context.date,
                                                     updatedAt: app.projectSessionsIntegrationReadAt,
                                                     refreshFailed: app.projectSessionsIntegrationReadFailed) {
                    Button { app.openProject(address.projectID) } label: {
                        HStack(spacing: 8) {
                            ProjectLandingRow(line: line)
                            Image(systemName: "chevron.right")
                                .font(.orbitMeta.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                }
            }
        }
    }

    /// The merge into main, under the progress card (owner decision 2026-10-06): the candidate's
    /// card while it asks, merges or is blocked, and the merge check's live line before that. Absent
    /// otherwise — a merge already made is a row on the timeline instead.
    @ViewBuilder private var mergeCard: some View {
        if let merge, let shape = ProjectMergeCard.shape(promotion: merge.current,
                                                         integration: app.projectSessionsIntegration) {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                ProjectMergeCardView(
                    merge: merge, shape: shape,
                    landing: app.projectSessionsIntegration.flatMap {
                        ProjectMergeCard.mergeLandingLine($0, now: context.date,
                                                          updatedAt: app.projectSessionsIntegrationReadAt,
                                                          refreshFailed: app.projectSessionsIntegrationReadFailed)
                    },
                    now: context.date,
                    onDetails: { promotionReview = PromotionReviewTarget(id: $0) },
                    onQueue: { promotionQueue = PromotionQueueTarget(id: $0) },
                    onCoordinator: coordinator.map { coordinator in
                        { app.openProjectMember(coordinator, push: rowNavigation == .push) }
                    })
            }
        }
    }

    /// A merge already made, on the timeline at its own instant. Not a session: it has no selection,
    /// swipe or menu, and a tap opens its receipt.
    private func mergeRow(_ receipt: PromotionCards.Receipt) -> some View {
        ProjectMergeTimelineRow(promotion: receipt.promotion) {
            promotionReceipt = PromotionReceiptTarget(promotion: receipt.promotion)
        }
    }

    /// On a phone the project's page is pushed over this one, so back returns here and the drawer
    /// keeps this project selected; the iPad opens it in the Projects section.
    private func openProject() {
        app.openProjectFromConversation(address.projectID, overConsole: rowNavigation == .push)
    }

    private var openProjectButton: some View {
        Button { openProject() } label: {
            Image(systemName: "square.grid.2x2")
        }
        .accessibilityLabel(SessionProjectCopy.openProject)
    }

    @ViewBuilder private func sessionRow(_ session: Session) -> some View {
        let scope: SessionView = session.effectiveLifecycleState == .completed ? .completed : .open
        let row = AgentSessionRow(session: session, showsPin: scope == .open)
        switch rowNavigation {
        case .selection:
            row.sessionRowActions(session, scope: scope, onTag: { taggingSession = session },
                                  onShare: { sharingSession = session }, onMove: { movingSession = session })
                .tag(session.id)
        case .push:
            Button { app.openProjectMember(session, push: true) } label: { row.foregroundStyle(.primary) }
                .sessionRowActions(session, scope: scope, onTag: { taggingSession = session },
                                   onShare: { sharingSession = session }, onMove: { movingSession = session })
        }
    }
}
/// The merge into main as the project's sessions page draws it, under the progress card (owner
/// decision 2026-10-06, mocks in docs/mocks/project-merge-sessions-page). One card at four moments:
/// the merge check running, the candidate asking, merging, or blocked. Its presses are the review
/// sheet's — both ask `ProjectMergeModel` — and Details opens that sheet for the whole of it.
///
/// Only the asking card is orange: it is the one thing on the page waiting on the reader.
private struct ProjectMergeCardView: View {
    let merge: ProjectMergeModel
    let shape: ProjectMergeCard.Shape
    /// The merge job's live line, drawn inside the card while one is in flight.
    let landing: ProjectPage.LandingLine?
    let now: Date
    let onDetails: (String) -> Void
    /// Opens the queue sheet, for the landing row while the merge waits its turn (J1).
    let onQueue: (String) -> Void
    /// Opens the coordinator, for a blocked candidate; nil when the page has no coordinator row.
    let onCoordinator: (() -> Void)?
    @State private var acting = false
    @State private var actionError: String?

    private var tint: Color {
        switch shape {
        case .checking: return .secondary
        case .asking, .blocked: return .orange
        case .merging: return .accentColor
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            switch shape {
            case .checking:
                if let landing { ProjectLandingRow(line: landing) }
            case .asking:
                if let view = merge.current { asking(view) }
            case .merging:
                if let view = merge.current { merging(view) }
            case .blocked:
                if let view = merge.current { blocked(view) }
            }
            if let actionError {
                Text(actionError)
                    .font(.orbitMeta).foregroundStyle(.red).lineLimit(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(shape == .checking ? Color.secondary.opacity(0.1) : tint.opacity(0.08),
                    in: RoundedRectangle(cornerRadius: 14))
        .overlay {
            if shape != .checking {
                RoundedRectangle(cornerRadius: 14).strokeBorder(tint.opacity(0.3), lineWidth: 1)
            }
        }
        .padding(.vertical, 4)
    }

    private func header(_ title: String, symbol: String, badge: String? = nil) -> some View {
        HStack(spacing: 8) {
            Image(systemName: symbol)
                .font(.orbitLabel.weight(.semibold))
                .foregroundStyle(tint)
                .frame(width: 26, height: 26)
                .background(tint.opacity(0.15), in: RoundedRectangle(cornerRadius: 7))
            Text(title).font(.headline).foregroundStyle(shape == .asking ? Color.primary : tint)
                .lineLimit(2)
            Spacer(minLength: 6)
            if let badge {
                Text(badge)
                    .font(.caption2.weight(.semibold)).foregroundStyle(.white)
                    .padding(.horizontal, 8).padding(.vertical, 2)
                    .background(Color.orange, in: Capsule())
            }
        }
    }

    /// A: what would land, the proof it was checked, and the two presses — the full review is a
    /// tap away for anyone who wants every row before pressing.
    @ViewBuilder private func asking(_ view: ProjectPromotionView) -> some View {
        header(PromotionCards.pageTitle(view), symbol: "arrow.triangle.merge", badge: PromotionCards.needsYouBadge)
        Text(PromotionCards.branchLine(view))
            .font(.orbitMeta).foregroundStyle(.secondary)
            .lineLimit(1).truncationMode(.middle)
        Divider()
        Text(PromotionCards.pageCounts(view)).font(.orbitLabel.weight(.semibold))
        let tasks = PromotionCards.taskTitles(view)
        ForEach(Array(tasks.shown.enumerated()), id: \.offset) { _, title in
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("•").foregroundStyle(.secondary)
                Text(title).lineLimit(1)
            }
            .font(.orbitLabel)
        }
        if let more = PromotionCards.moreTasks(tasks.more) {
            Text(more).font(.orbitMeta).foregroundStyle(.secondary)
        }
        Text("\(PromotionCards.previewChecks(view)) · \(PromotionCards.upstreamLine(view))")
            .font(.orbitMeta.weight(.semibold))
            .foregroundStyle(!view.checks.isEmpty && view.checks.allSatisfy(\.passed) && view.conflicts.isEmpty
                             ? Color.green : Color.primary)
        if let met = merge.criteriaMet, let line = PromotionCards.criteriaLine(met: met.met, of: met.total) {
            Text(line).font(.orbitMeta).foregroundStyle(.secondary)
        }
        HStack(spacing: 8) {
            Button { act { await merge.confirmMergeToMain(view) } } label: {
                Text(PromotionCards.mergeToMain).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(acting || !PromotionCards.confirmable(view))
            Button { act { await merge.declineMergeToMain(view) } } label: {
                Text(PromotionCards.notNow)
            }
            .buttonStyle(.bordered)
            .disabled(acting)
        }
        .padding(.top, 2)
        footer(left: PromotionCards.askedLine(view, now: now), view: view)
    }

    /// B: under way, and the reader may walk away; Cancel until the push begins.
    ///
    /// The head carries the same merge mark in its tile as A and D, rather than a spinner (owner
    /// decision 2026-10-07): the card has one moving mark and it is the landing row's ring — the
    /// project page's Integrating mark, sitting beside the word `fetching`. A spinner here said
    /// "work is happening" a fourth time, in a mark neither this card nor this app uses elsewhere.
    @ViewBuilder private func merging(_ view: ProjectPromotionView) -> some View {
        header(PromotionCards.pageTitle(view), symbol: "arrow.triangle.merge")
        Text(PromotionCards.mergingStatusLine(view)).font(.orbitLabel)
        // Who is ahead of it, once the queue has been read: the same sentence the sheet's rows are
        // drawn from, amber when the head has gone quiet past the claim's lease window (§2.2 J1).
        if let queue = merge.queue, let jobId = merge.myQueueJobID,
           let wait = PromotionQueueCards.waitLine(jobId, in: queue) {
            Text(wait)
                .font(.orbitMeta)
                .foregroundStyle(queue.jobs.first?.stale == true ? Color.orange : Color.secondary)
        }
        if let landing {
            // While it waits its turn the row is a door onto the queue it waits in (§2.2 J1): the
            // chevron is the sessions page's own mark for a row that opens something. A claimed
            // job's row stays as it was — its phases are answered by the line itself.
            if view.execution?.state == "QUEUED" {
                Button { onQueue(view.promotionId) } label: {
                    HStack(spacing: 8) {
                        ProjectLandingRow(line: landing)
                        Image(systemName: "chevron.right")
                            .font(.orbitMeta.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            } else {
                ProjectLandingRow(line: landing)
            }
        }
        Text(PromotionCards.pageNothingToDo).font(.orbitMeta).foregroundStyle(.secondary)
        HStack {
            Spacer()
            Button { act { await merge.cancelMergeToMain(view) } } label: {
                Text(PromotionCards.cancel)
            }
            .buttonStyle(.bordered)
            .disabled(acting || view.execution?.phase == "PUSH")
        }
    }

    /// D: why it cannot merge, and who has it — the coordinator, until the clock hands it over.
    @ViewBuilder private func blocked(_ view: ProjectPromotionView) -> some View {
        let item = merge.promotionItems.first { $0.promotionId == view.promotionId }
        header(PromotionCards.pageTitle(view), symbol: "exclamationmark.triangle.fill")
        Text(PromotionCards.blockedLine(view)).font(.orbitLabel)
        HStack(spacing: 6) {
            if PromotionCards.resolvingSpins(item) { ProgressView().controlSize(.mini) }
            Text(PromotionCards.resolvingLine(item, now: now))
        }
        .font(.orbitMeta.weight(.semibold))
        .foregroundStyle(item?.assignee == .owner ? Color.orange : Color.secondary)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 7)
        .background(Color.secondary.opacity(0.12), in: Capsule())
        HStack {
            Spacer()
            if let onCoordinator {
                Button(action: onCoordinator) {
                    HStack(spacing: 2) {
                        Text(PromotionCards.openCoordinator)
                        Image(systemName: "chevron.right")
                    }
                }
                .buttonStyle(.borderless)
            }
        }
        .font(.orbitMeta.weight(.semibold))
    }

    private func footer(left: String?, view: ProjectPromotionView) -> some View {
        HStack {
            if let left { Text(left).foregroundStyle(.secondary) }
            Spacer(minLength: 8)
            Button { onDetails(view.promotionId) } label: {
                HStack(spacing: 2) {
                    Text(PromotionCards.details)
                    Image(systemName: "chevron.right")
                }
            }
            .buttonStyle(.borderless)
        }
        .font(.orbitMeta.weight(.semibold))
    }

    private func act(_ run: @escaping () async -> String?) {
        guard !acting else { return }
        PlatformHaptics.tap()
        acting = true
        actionError = nil
        Task {
            actionError = await run()
            acting = false
        }
    }
}

/// A merge already made, as a row on the project's timeline: what went onto main and who merged it,
/// at the instant it happened. Shaped unlike a session row (the mark, no status line) because it is
/// not one, and a tap opens its receipt.
private struct ProjectMergeTimelineRow: View {
    let promotion: ProjectPromotionView
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 11) {
                Image(systemName: "arrow.triangle.merge")
                    .font(.orbitGlyph.weight(.semibold))
                    .foregroundStyle(.green)
                    .frame(width: 30, height: 30)
                    .background(Color.green.opacity(0.15), in: Circle())
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        Text(PromotionCards.timelineTitle(promotion))
                            .fontWeight(.semibold).lineLimit(1)
                        Spacer(minLength: 8)
                        if let at = promotion.merged?.at, let relative = RelativeTime.format(at) {
                            Text(relative).font(.orbitMeta).foregroundStyle(.secondary).fixedSize()
                        }
                    }
                    Text(PromotionCards.timelineDetail(promotion))
                        .font(.orbitListSubtitle).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Opens the merge's receipt")
    }
}

/// "Review and start" — the coordinator's request to start, opened over the project's sessions page
/// (docs/mocks/project-start-sessions-page): the card the conversation draws, from the same request
/// — its suggestion, its reason and Orbit's ready check — pressed at the same door with the request
/// named. Chat about this stays the conversation's: the coordinator's row is under this sheet.
///
/// The card keeps the request it was first drawn for, as the conversation's does, so a request that
/// stops standing is said on the card (dimmed, Start dead) rather than replaced by a blank; and a
/// press that went through holds it live while the sheet goes down, since the read the press makes
/// has already answered that nobody is asked any more.
private struct RequestedStartProjectSheet: View {
    let store: ProjectDetailModel
    /// Where the card's "View tasks ›" goes: the project's page.
    let onViewTasks: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var held: ProjectOpenItemRow?
    @State private var edited: StartSettingsDraft?
    @State private var pressed = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                card
                    .padding()
                    .frame(maxWidth: 640)
                    .frame(maxWidth: .infinity)
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .task { await store.loadStartCard() }
    }

    @ViewBuilder
    private var card: some View {
        let live = store.document.flatMap { StartProject.live(openItems: store.openItems, started: $0.started) }
        if let document = store.document, let confirmation = store.confirmation,
           let row = live ?? held, let request = row.startRequest {
            let draft = edited ?? StartSettingsDraft(request.settings)
            StartProjectCard(
                projectID: document.id,
                projectTitle: document.title,
                askedAt: row.waitingSince,
                request: request,
                criteria: document.acceptanceCriteriaItems.sorted { $0.ordinal < $1.ordinal }.map {
                    ProjectCriteriaDocument.Item(id: $0.id, ordinal: $0.ordinal, text: $0.text,
                                                 satisfied: $0.satisfied)
                },
                plan: StartProject.planView(graph: store.graph, request: request,
                                            fallbackCount: document.taskCount),
                draft: draft,
                standing: pressed ? .live : StartProject.standing(itemID: row.itemId, request: request,
                                                                  openItems: store.openItems,
                                                                  confirmation: confirmation,
                                                                  started: document.started),
                onDraft: { edited = $0 },
                onStart: { await start(request, draft, itemID: row.itemId) },
                onViewTasks: onViewTasks,
                error: error)
            .onAppear { if held == nil { held = row } }
        } else if store.document != nil, store.confirmation != nil, store.openItems != nil {
            // The request stopped standing before this sheet could draw it: said, not drawn blank.
            Text(StartProject.requestGone)
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else if store.confirmationUnread {
            Text(AcceptanceConfirmations.staleExplanation(nil) ?? "")
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            ProgressView().frame(maxWidth: .infinity)
        }
    }

    /// One press, one write, answering the request — and the card gives way once it went through.
    private func start(_ request: ProjectStartRequest, _ draft: StartSettingsDraft, itemID: String) async {
        guard draft.complete else { return }
        pressed = true
        if let refused = await store.startProject(StartProject.body(request: request, draft: draft,
                                                                    requestId: itemID)) {
            pressed = false
            error = refused
        } else {
            dismiss()
        }
    }
}

#endif
