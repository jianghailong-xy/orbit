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
    let address: SessionProjectAddress
    var rowNavigation: SessionRowNavigation = .push

    @State private var rowSwipe = RowSwipeState()
    @State private var taggingSession: Session?
    @State private var sharingSession: Session?
    @State private var movingSession: Session?
    @State private var promotionReview: PromotionReviewTarget?
    @State private var promotionReceipt: PromotionReceiptTarget?

    private var sessions: [Session] { app.projectSessions }
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
            await app.loadProjectSessions(address)
            await app.loadProjectMerge(address, force: true)
        }
        .overlay {
            if sessions.isEmpty && !app.projectSessionsLoading {
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
        .sheet(item: $promotionReceipt) { PromotionReceiptSheet(promotion: $0.promotion) }
        .task(id: address) {
            await app.loadProjectSessions(address)
            await app.loadProjectMerge(address)
            await app.projects?.load()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(4))
                if Task.isCancelled { break }
                await app.loadProjectSessions(address)
                await app.loadProjectMerge(address)
            }
        }
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
        VStack(spacing: 0) {
            progressLine
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
                Text(SessionProjectCopy.pageProgress(done: counts.done, total: counts.total,
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

    private func header(_ title: String, symbol: String?, badge: String? = nil) -> some View {
        HStack(spacing: 8) {
            if let symbol {
                Image(systemName: symbol)
                    .font(.orbitLabel.weight(.semibold))
                    .foregroundStyle(tint)
                    .frame(width: 26, height: 26)
                    .background(tint.opacity(0.15), in: RoundedRectangle(cornerRadius: 7))
            } else {
                ProgressView().controlSize(.small).tint(tint)
            }
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
    @ViewBuilder private func merging(_ view: ProjectPromotionView) -> some View {
        header(PromotionCards.pageTitle(view), symbol: nil)
        Text(PromotionCards.mergingStatusLine(view)).font(.orbitLabel)
        if let landing { ProjectLandingRow(line: landing) }
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

#endif
