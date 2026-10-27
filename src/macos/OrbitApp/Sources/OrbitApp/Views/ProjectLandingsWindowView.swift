import SwiftUI
import Observation
import OrbitKit

/// What a project's Landings window has read (owner 2026-10-27, docs/mocks/landings-one-window;
/// contract §2.9 LS6 and §3.6, revision 28): the two reads the project's sessions page already makes —
/// its LANDING rows (`includeLanding=1`, open and completed) and its merges into main — the
/// coordinator, and each landing's own view where one is drawn: every card's on §2.7a's cadence, a
/// settled row's once, when it is first drawn, and never again.
@MainActor
@Observable
final class ProjectLandingsModel {
    let projectID: String
    private let api: APIClient
    private(set) var rows: [Session] = []
    private(set) var merges: [ProjectPromotionView] = []
    private(set) var coordinatorID: String?
    private(set) var projectTitle: String?
    private(set) var integration: ProjectIntegrationView?
    private(set) var promotion: ProjectPromotionView?
    /// Each landing's own view (`GET /sessions/:id`), when this device last got one, and whether its
    /// last read failed.
    private(set) var details: [String: SessionLandingView] = [:]
    private(set) var readAt: [String: Date] = [:]
    private(set) var readFailed: Set<String> = []
    /// The server's own sentence for a door it refused, under that landing.
    private(set) var refusals: [String: String] = [:]
    private(set) var acting: Set<String> = []
    /// The first read round has answered — lists, and each card's own view — so the window has the
    /// height it opens with and can be placed (at its bottom, or on its landing).
    private(set) var loaded = false
    private(set) var listFailed = false
    /// The landing the window was opened on, from its own read: a landing whose row has not been
    /// inserted yet (LS1's pre-generated id) is in no list, and still has its place in the window.
    private(set) var focusRow: Session?
    private var asked: Set<String> = []
    private var reviewSource: LandingPromotionSource?

    init(projectID: String, api: APIClient) {
        self.projectID = projectID
        self.api = api
    }

    /// The window as it stands: days of settled rows, and `Now`.
    var window: LandingsWindow {
        var listed = rows
        if let focusRow, !listed.contains(where: { $0.id == focusRow.id }) { listed.append(focusRow) }
        return SessionProjectLandings.window(listed, merges: merges)
    }

    /// §2.7a's cadence while a card is in hand: four seconds while one runs, fifteen otherwise.
    var interval: TimeInterval {
        window.now.contains { details[$0.sessionId]?.currentAttempt?.state == "RUNNING" } ? 4 : 15
    }

    /// One read of the window: its two lists, its merges, the coordinator and — while a landing is
    /// in hand — each card's own view and the project facts its head and doors take.
    func refresh(app: AppModel, focusID: String?) async {
        await readLists()
        if let merged = try? await api.mergedPromotions(projectID: projectID) { merges = merged }
        if let status = try? await api.projectCoordinatorStatus(projectID) {
            coordinatorID = status.coordination.sessionId
        }
        if projectTitle == nil {
            projectTitle = app.projects?.sidebarProjects.first { $0.id == projectID }?.title
                ?? app.projects?.project(projectID)?.title
        }
        if projectTitle == nil, let document = try? await api.project(projectID) {
            projectTitle = document.title
        }
        if let focusID, focusRow == nil,
           !rows.contains(where: { PublicID.storageKey($0.id) == PublicID.storageKey(focusID) }) {
            await readFocus(focusID, title: app.session(id: focusID)?.title)
        }
        let cards = window.now
        for card in cards { await read(card.sessionId) }
        if !cards.isEmpty, let integration = try? await api.projectIntegration(projectID) {
            self.integration = integration
            app.rememberLandingJobs(integration)
        }
        if cards.contains(where: { $0.subject == "PROMOTION" }) {
            promotion = try? await api.currentPromotion(projectID: projectID)
        }
        // A card whose own read says it settled moves into its day now, not at the next read.
        if cards.contains(where: { details[$0.sessionId]?.settledAt != nil }) {
            await readLists()
            if let merged = try? await api.mergedPromotions(projectID: projectID) { merges = merged }
        }
        loaded = true
    }

    private func readLists() async {
        do {
            let open = try await api.listSessions(view: .open, projectId: projectID, includeLanding: true)
            let completed = try await api.listSessions(view: .completed, projectId: projectID,
                                                       includeLanding: true)
            var seen = Set<String>()
            rows = (open + completed).filter {
                $0.isLanding && $0.landing != nil && $0.effectiveLifecycleState != .trash
                    && seen.insert($0.id).inserted
            }
            listFailed = false
        } catch {
            listFailed = true
        }
    }

    private func readFocus(_ id: String, title: String?) async {
        guard let detail = try? await api.sessionDetail(id), let view = detail.landing,
              PublicID.storageKey(view.projectId) == PublicID.storageKey(projectID) else { return }
        details[id] = view
        readAt[id] = Date()
        focusRow = Session(
            id: id, title: LandingPageCopy.headerTitle(view, rowTitle: title),
            status: .succeeded, agentId: nil, assignedRunnerId: nil, pendingApprovals: nil,
            branch: nil, updatedAt: nil, createdAt: view.openedAt, sessionKind: "LANDING",
            landing: SessionLandingView(subject: view.subject, settledAt: view.settledAt,
                                        settledAs: view.settledAs,
                                        state: view.settledAt == nil ? "IN_FLIGHT" : "SETTLED"))
    }

    /// One landing's own view.
    func read(_ id: String) async {
        do {
            let detail = try await api.sessionDetail(id)
            if let landing = detail.landing { details[id] = landing }
            readAt[id] = Date()
            readFailed.remove(id)
        } catch {
            readFailed.insert(id)
        }
    }

    /// A settled row's record, read once — when the row is first drawn — and never polled: a settled
    /// landing does not move.
    func readOnce(_ id: String) async {
        guard !asked.contains(id) else { return }
        asked.insert(id)
        await read(id)
    }

    /// The V6 facts the landing view does not carry: the in-flight job's step start and usual
    /// duration, and the project's main branch.
    func facts(_ landing: SessionLandingView?) -> LandingFacts {
        let job = integration?.inFlightJobs?.first { $0.jobId == landing?.currentAttempt?.jobId }
        return LandingFacts(stepStartedAt: job?.stepStartedAt, typicalMs: job?.typicalMs,
                            main: RunSettings.mainBranchName(integration?.upstreamRef))
    }

    /// The candidate a round is about: the one on offer while the round runs, its merged record once
    /// it settled. A task's landing has none.
    func promotion(for landing: SessionLandingView?, row: LandingsWindowRow? = nil) -> ProjectPromotionView? {
        guard let landing else { return row?.promotion }
        guard landing.subject == "PROMOTION" else { return nil }
        if landing.settledAt != nil {
            return row?.promotion ?? merges.first { $0.promotionId == landing.promotionId }
        }
        return promotion?.promotionId == landing.promotionId ? promotion : nil
    }

    /// The round's own review source, for the merge card a round still in hand opens.
    func review() -> LandingPromotionSource {
        let source = reviewSource ?? LandingPromotionSource(api: api, projectID: projectID)
        reviewSource = source
        source.promotion = promotion
        source.landings = integration?.landTasks ?? []
        Task { await source.refreshPromotion() }
        return source
    }

    /// One of a landing's owner doors (LS6): the press, the server's own sentence when it refuses,
    /// and a read of the landing again once it has answered.
    func act(_ action: LandingMenuAction, sessionID: String, landing: SessionLandingView) async {
        guard !acting.contains(sessionID) else { return }
        acting.insert(sessionID)
        do {
            switch action {
            case .stop:
                guard let taskID = landing.taskId else { break }
                try await api.stopTaskIntegration(projectID: landing.projectId, taskID: taskID)
            case .cancel:
                guard let promotionID = landing.promotionId else { break }
                _ = try await api.cancelPromotion(projectID: landing.projectId,
                                                  promotionID: promotionID)
            case .abandon:
                guard let jobID = landing.currentAttempt?.jobId else { break }
                try await api.abandonIntegrationJob(projectID: landing.projectId, jobID: jobID)
            case .retry:
                guard let jobID = landing.currentAttempt?.jobId else { break }
                _ = try await api.retryIntegrationJob(landing.projectId, jobID: jobID)
            case .rerunTheCheck:
                guard let promotionID = landing.promotionId else { break }
                try await api.rerunPromotionCheck(projectID: landing.projectId, promotionID: promotionID, reason: LandingPageCopy.rerunLandingCheckReason)
            default:
                break
            }
            refusals[sessionID] = nil
        } catch {
            let label: String
            switch action {
            case .stop: label = LandingPageCopy.stopFailed
            case .cancel: label = LandingPageCopy.cancelFailed
            case .abandon: label = LandingPageCopy.abandonFailed
            case .retry: label = LandingPageCopy.retryFailed
            default: label = LandingPageCopy.rerunFailed
            }
            var reason = APIClient.failureReason(error)
            while reason.hasSuffix(".") { reason.removeLast() }
            refusals[sessionID] = "\(label) — \(reason)."
        }
        // The landing and the project reads are what its card was drawn from; read again.
        await read(sessionID)
        acting.remove(sessionID)
    }
}

/// A project's Landings window (owner 2026-10-27, docs/mocks/landings-one-window; contract §2.9 LS6
/// and §3.6, revision 28): every landing the project has had, read like a conversation — the settled
/// ones by day, oldest at the top, and the ones still in hand under `Now` at the bottom, where the
/// window opens. A landing session id opens it on that landing (`focusID`): scrolled to, opened and
/// outlined for a moment.
///
/// The window is the old landing session page's shell — `Landings`, `Run by Orbit · <project>`, a ⋯
/// with the coordinator and the project, the read-only footer and no composer (LS6) — and each landing
/// in it carries what that page drew: a card still in hand is its status card, a settled row opens in
/// place to its timeline. The doors the page's ⋯ held are each landing's own: a long press on it.
struct ProjectLandingsWindowView: View {
    /// The project whose landings these are; nil when the window was opened on a landing whose
    /// project this device has not read yet, which its own read names.
    let projectID: String?
    /// The landing to scroll to, open and outline: the id the window was opened on.
    var focusID: String? = nil
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    @State private var model: ProjectLandingsModel?
    @State private var expanded: Set<String> = []
    @State private var outlined: String?
    @State private var placed = false
    @State private var review: PromotionReviewTarget?
    @State private var reviewSource: LandingPromotionSource?
    @State private var receipt: PromotionReceiptTarget?

    private static let bottom = "landings-window-bottom"

    private var api: APIClient? {
        guard let baseURL = app.baseURL else { return nil }
        return APIClient(baseURL: baseURL, tokenStore: app.tokenStore)
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if let model {
                        content(model)
                    } else {
                        ProgressView().frame(maxWidth: .infinity).padding(.vertical, 24)
                    }
                    Color.clear.frame(height: 1).id(Self.bottom)
                }
                .padding(.horizontal, 16)
                .frame(maxWidth: 760, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .onChange(of: model?.loaded ?? false) { _, _ in place(proxy) }
            .onChange(of: entryIDs) { _, _ in place(proxy) }
            // Another landing of the same project opened over this one: the window stays, and is
            // placed again on that landing.
            .onChange(of: focusID) { _, _ in
                placed = false
                place(proxy)
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) { header }
        .safeAreaInset(edge: .bottom, spacing: 0) { footer }
        .task(id: "\(projectID ?? "")|\(focusID ?? "")") { await run() }
        .task(id: outlined) {
            // The landing it was opened on is outlined for a moment (board 03 f), then stays open.
            guard outlined != nil else { return }
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            if !Task.isCancelled { withAnimation { outlined = nil } }
        }
        .sheet(item: $review) { target in
            if let reviewSource { PromotionReviewSheet(source: reviewSource, promotionID: target.id) }
        }
        .sheet(item: $receipt) { PromotionReceiptSheet(promotion: $0.promotion) }
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    /// Every entry's id in the window's order — what the placement waits on.
    private var entryIDs: [String] {
        guard let window = model?.window else { return [] }
        return window.days.flatMap { $0.rows.map(\.id) } + window.now.map(\.id)
    }

    // MARK: - the shell

    /// The old landing page's head, for the whole project: `Landings`, run by Orbit, and the window's
    /// own ⋯ — the coordinator and the project, nothing else (LS6).
    private var header: some View {
        HStack(alignment: .center, spacing: 8) {
            Color.clear.frame(width: 28, height: 1)
            VStack(spacing: 2) {
                Text(SessionLandingsCopy.title)
                    .font(.title3.weight(.semibold))
                Text(subtitle)
                    .font(.orbitListSubtitle)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity)
            windowMenu
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
        .background(.bar)
    }

    private var subtitle: String {
        guard let title = model?.projectTitle, !title.isEmpty else { return LandingPageCopy.runByOrbit }
        return "\(LandingPageCopy.runByOrbit) · \(title)"
    }

    private var windowMenu: some View {
        Menu {
            if let coordinator = model?.coordinatorID {
                Button(LandingPageCopy.openCoordinator) { open("orbit-session", coordinator) }
            }
            if let projectID = model?.projectID ?? projectID {
                Button(SessionProjectCopy.openProject) { open("orbit-project", projectID) }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .font(.orbitGlyph)
        }
        // The board's plain ⋯ rather than macOS's pull-down bezel (iOS's Menu already draws one).
        #if os(macOS)
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        #endif
        .fixedSize()
        .frame(width: 28)
        .accessibilityIdentifier("landings-more")
        .accessibilityLabel("More actions")
    }

    /// What this window is, who decides, and the way to them: nothing to type here (LS6).
    private var footer: some View {
        let parts = SessionLandingsCopy.orbitRunsTheseLandings.components(separatedBy: " — ")
        return VStack(alignment: .leading, spacing: 2) {
            (Text("\(parts.first ?? "") — ").foregroundStyle(.secondary)
                + Text(parts.dropFirst().joined(separator: " — ")).fontWeight(.semibold))
                .font(.orbitMeta)
            HStack(spacing: 4) {
                Text(LandingPageCopy.decisionsTheCoordinator).font(.orbitMeta).foregroundStyle(.secondary)
                if let coordinator = model?.coordinatorID {
                    Text("·").font(.orbitMeta).foregroundStyle(.secondary)
                    Button("\(LandingPageCopy.openCoordinatorLink) ›") { open("orbit-session", coordinator) }
                        .font(.orbitMeta).buttonStyle(.plain).foregroundStyle(Color.accentColor)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16).padding(.vertical, 8)
        .background(.bar)
        .accessibilityIdentifier("landings-footer")
    }

    // MARK: - the window

    @ViewBuilder private func content(_ model: ProjectLandingsModel) -> some View {
        let window = model.window
        if window.days.isEmpty && window.now.isEmpty && model.listFailed {
            Text(LandingPageCopy.updateUnavailable)
                .font(.orbitLabel).foregroundStyle(.secondary)
                .padding(.vertical, 24)
        }
        ForEach(window.days) { day in
            dayHead(day.title)
            ForEach(day.rows) { row in rowView(row, model: model) }
        }
        if !window.now.isEmpty {
            dayHead(SessionLandingsCopy.now, now: true)
            ForEach(window.now) { card in cardView(card, model: model) }
        }
    }

    private func dayHead(_ title: String, now: Bool = false) -> some View {
        Text(title)
            .font(.orbitMeta.weight(.semibold))
            .foregroundStyle(now ? Color.accentColor : Color.secondary)
            .frame(maxWidth: .infinity)
            .padding(.top, 14).padding(.bottom, 6)
            .accessibilityAddTraits(.isHeader)
    }

    /// One settled landing: the merged line's head — the mark that says how it ended, the task's name,
    /// the moment it settled and one line under them — that opens in place to its record.
    @ViewBuilder private func rowView(_ row: LandingsWindowRow, model: ProjectLandingsModel) -> some View {
        let id = row.id
        let open = expanded.contains(id)
        let landing = row.sessionId.flatMap { model.details[$0] }
        VStack(alignment: .leading, spacing: 10) {
            Button {
                PlatformHaptics.tap()
                toggle(id)
            } label: {
                LandingsWindowRowHead(row: row, open: open)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("landings-row:\(id)")
            .contextMenu { menu(landing: landing, row: row, sessionID: row.sessionId, model: model) }
            if open {
                record(row, landing: landing, model: model)
            }
        }
        .padding(.vertical, 8).padding(.horizontal, 6)
        .background(open ? Color.secondary.opacity(0.06) : Color.clear, in: RoundedRectangle(cornerRadius: 12))
        .overlay { outline(id) }
        .id(id)
        .task(id: row.sessionId ?? "") {
            if let sessionID = row.sessionId { await model.readOnce(sessionID) }
        }
    }

    /// What a settled row opens to: a merge's receipt first (board 03 e), then the landing's own
    /// timeline, and a task's two ways out.
    @ViewBuilder private func record(_ row: LandingsWindowRow, landing: SessionLandingView?,
                                     model: ProjectLandingsModel) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if row.tone == .merge {
                receiptView(LandingPageCopy.mergeReceipt(promotion: row.promotion, landing: landing))
            }
            if let refusal = row.sessionId.flatMap({ model.refusals[$0] }) {
                Text(refusal).font(.orbitMeta).foregroundStyle(.red)
            }
            if let sessionID = row.sessionId {
                if let landing {
                    LandingTimelineView(sessionID: sessionID, landing: landing, now: Date())
                    entryLinks(landing)
                } else {
                    Text(model.readFailed.contains(sessionID)
                         ? LandingPageCopy.updateUnavailable : LandingPageCopy.loadingLanding)
                        .font(.orbitMeta).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.leading, 41)
    }

    /// The receipt a merge row opens to: what is now on main, the check and the tree.
    private func receiptView(_ receipt: LandingMergeReceipt) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(receipt.heading).font(.orbitLabel.weight(.semibold))
            ForEach(receipt.tasks, id: \.self) { title in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("•").foregroundStyle(.secondary)
                    Text(title).font(.orbitLabel)
                }
            }
            if let checkLine = receipt.checkLine {
                Text(checkLine).font(.orbitMeta).foregroundStyle(.green)
            }
            if let treeLine = receipt.treeLine {
                Text(treeLine).font(.orbitMeta).foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.green.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
        .overlay { RoundedRectangle(cornerRadius: 14).strokeBorder(Color.green.opacity(0.3), lineWidth: 1) }
        .accessibilityIdentifier("landings-receipt")
    }

    /// `Open Task ›` and `Open Source Session ›`, under a task segment's open record (board 03 f).
    @ViewBuilder private func entryLinks(_ landing: SessionLandingView) -> some View {
        if landing.subject == "TASK" {
            HStack(spacing: 14) {
                if let taskID = landing.taskId, !taskID.isEmpty {
                    Button("\(LandingPageCopy.openTask) ›") { open("orbit-task", taskID) }
                }
                if let source = landing.currentAttempt?.sourceSessionId, !source.isEmpty {
                    Button("\(LandingPageCopy.openSourceSession) ›") { open("orbit-session", source) }
                }
            }
            .font(.orbitMeta.weight(.semibold))
            .buttonStyle(.plain)
            .foregroundStyle(Color.accentColor)
        }
    }

    /// One landing still in hand, under `Now`: the old landing page's status card with the task's name
    /// under its head. Pressing it opens its record under it; a long press holds its doors.
    @ViewBuilder private func cardView(_ card: LandingsWindowCard, model: ProjectLandingsModel) -> some View {
        let id = card.sessionId
        let open = expanded.contains(id)
        let landing = model.details[id]
        let promotion = model.promotion(for: landing)
        VStack(alignment: .leading, spacing: 10) {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                LandingStatusCardView(
                    sessionID: id, landing: landing, title: card.title, now: context.date,
                    readAt: model.readAt[id], readFailed: model.readFailed.contains(id),
                    facts: model.facts(landing), promotion: promotion,
                    waitDoors: waitDoors(card, landing: landing, promotion: promotion, model: model),
                    acting: model.acting.contains(id),
                    act: { action in press(action, sessionID: id, landing: landing, row: nil, model: model) })
            }
            .contentShape(Rectangle())
            .onTapGesture { toggle(id) }
            .contextMenu { menu(landing: landing, row: nil, sessionID: id, model: model) }
            .accessibilityIdentifier("landings-card:\(id)")
            if let refusal = model.refusals[id] {
                Text(refusal).font(.orbitMeta).foregroundStyle(.red)
            }
            if open, let landing {
                LandingTimelineView(sessionID: id, landing: landing, now: Date())
                entryLinks(landing)
            }
        }
        .padding(.vertical, 6)
        .overlay { outline(id) }
        .id(id)
    }

    /// A landing that waits for a decision carries the doors to the people who decide (board 02 d):
    /// the coordinator, and the task — or the round's own card. A timed-out one has its own doors.
    private func waitDoors(_ card: LandingsWindowCard, landing: SessionLandingView?,
                           promotion: ProjectPromotionView?, model: ProjectLandingsModel) -> [LandingMenuAction] {
        guard card.state == "AWAITING_DECISION", let landing, landing.settledAt == nil else { return [] }
        if let attempt = landing.currentAttempt, attempt.timedOut || attempt.liveness == "LEASE_EXPIRED" {
            return []
        }
        var doors: [LandingMenuAction] = []
        if model.coordinatorID != nil { doors.append(.openCoordinator) }
        if landing.subject == "TASK", let taskID = landing.taskId, !taskID.isEmpty { doors.append(.openTask) }
        if landing.subject == "PROMOTION", promotion != nil { doors.append(.reviewCard) }
        return doors
    }

    /// The long-press menu: the old landing page's ⋯, row for row (`LandingPageCopy.menuItems`). A
    /// merge older than landing sessions has no view to read, and keeps its round's two ways in.
    @ViewBuilder private func menu(landing: SessionLandingView?, row: LandingsWindowRow?, sessionID: String?,
                                   model: ProjectLandingsModel) -> some View {
        ForEach(menuItems(landing: landing, row: row, sessionID: sessionID, model: model)) { item in
            Button(role: item.danger ? ButtonRole.destructive : nil) {
                press(item.action, sessionID: sessionID, landing: landing, row: row, model: model)
            } label: {
                if let sub = item.sub {
                    #if os(iOS)
                    Text(item.label)
                    Text(sub)
                    #else
                    Text("\(item.label) — \(sub)")
                    #endif
                } else {
                    Text(item.label)
                }
            }
        }
    }

    private func menuItems(landing: SessionLandingView?, row: LandingsWindowRow?, sessionID: String?,
                           model: ProjectLandingsModel) -> [LandingMenuItem] {
        if let landing, let sessionID {
            let gates = LandingPageCopy.gates(landing, now: Date(), updatedAt: model.readAt[sessionID],
                                              failed: model.readFailed.contains(sessionID))
            let nothingPushed = landing.currentAttempt.map { attempt in
                attempt.kind == "CHECK_PROMOTION"
                    || (attempt.timedOut
                        && LandingPageCopy.pushSentence(landing, attempt: attempt)
                            == LandingPageCopy.nothingPushedSentence)
            } ?? false
            return LandingPageCopy.menuItems(
                landing, gates: gates,
                hasCoordinator: model.coordinatorID != nil,
                hasReview: model.promotion(for: landing, row: row) != nil,
                nothingPushed: nothingPushed)
        }
        guard let row, row.sessionId == nil else { return [] }
        var items: [LandingMenuItem] = []
        if model.coordinatorID != nil {
            items.append(LandingMenuItem(key: "coordinator", action: .openCoordinator,
                                         label: LandingPageCopy.openCoordinator))
        }
        if row.promotion != nil {
            items.append(LandingMenuItem(key: "review", action: .reviewCard, label: LandingPageCopy.reviewCard))
        }
        return items
    }

    // MARK: - the presses

    private func press(_ action: LandingMenuAction, sessionID: String?, landing: SessionLandingView?,
                       row: LandingsWindowRow?, model: ProjectLandingsModel) {
        switch action {
        case .openTask:
            if let taskID = landing?.taskId { open("orbit-task", taskID) }
        case .openSourceSession:
            if let source = landing?.currentAttempt?.sourceSessionId { open("orbit-session", source) }
        case .openCoordinator:
            if let coordinator = model.coordinatorID { open("orbit-session", coordinator) }
        case .reviewCard:
            guard let promotion = model.promotion(for: landing, row: row) else { return }
            if landing?.settledAt != nil || landing == nil {
                receipt = PromotionReceiptTarget(promotion: promotion)
            } else {
                reviewSource = model.review()
                review = PromotionReviewTarget(id: promotion.promotionId)
            }
        default:
            guard let sessionID, let landing else { return }
            Task { await model.act(action, sessionID: sessionID, landing: landing) }
        }
    }

    private func open(_ scheme: String, _ id: String) {
        if let url = URL(string: "\(scheme):\(PublicID.toPublic(id))") { openURL(url) }
    }

    private func toggle(_ id: String) {
        withAnimation(.easeInOut(duration: 0.2)) {
            if expanded.contains(id) { expanded.remove(id) } else { expanded.insert(id) }
        }
    }

    /// The landing the window was opened on wears the accent outline for a moment (board 03 f).
    private func outline(_ id: String) -> some View {
        RoundedRectangle(cornerRadius: 12)
            .strokeBorder(Color.accentColor, lineWidth: 2)
            .opacity(outlined == id ? 1 : 0)
            .allowsHitTesting(false)
    }

    // MARK: - the reads

    /// Where the window opens: at its bottom, like a conversation — or, opened on a landing, on that
    /// landing: opened, scrolled to and outlined.
    private func place(_ proxy: ScrollViewProxy) {
        guard !placed, let model, model.loaded else { return }
        if let focusID {
            // The id the window holds for it, however the link spelled it.
            guard let entry = entryIDs.first(where: { PublicID.storageKey($0) == PublicID.storageKey(focusID) })
            else { return }
            placed = true
            expanded.insert(entry)
            outlined = entry
            DispatchQueue.main.async { proxy.scrollTo(entry, anchor: .top) }
        } else {
            placed = true
            DispatchQueue.main.async { proxy.scrollTo(Self.bottom, anchor: .bottom) }
        }
    }

    private func run() async {
        guard let api else { return }
        var projectID = self.projectID
        if projectID == nil, let focusID {
            projectID = app.session(id: focusID)?.landing.flatMap { $0.projectId.isEmpty ? nil : $0.projectId }
                ?? app.session(id: focusID)?.projectMembership?.projectId
            if projectID == nil {
                projectID = (try? await api.sessionDetail(focusID))?.landing?.projectId
            }
        }
        guard let projectID, !projectID.isEmpty else { return }
        let model = self.model?.projectID == projectID ? self.model! : ProjectLandingsModel(projectID: projectID, api: api)
        self.model = model
        while !Task.isCancelled {
            await model.refresh(app: app, focusID: focusID)
            do { try await Task.sleep(nanoseconds: UInt64(model.interval * 1_000_000_000)) } catch { return }
        }
    }
}

/// A settled row's head: the mark that says how it ended (✓ landed, ⇢ merged into main, ◌ nothing to
/// land), its title, the moment it settled with the up arrow of an open row, and one line under them.
private struct LandingsWindowRowHead: View {
    let row: LandingsWindowRow
    let open: Bool

    private var mark: String {
        switch row.tone {
        case .ok: return "✓"
        case .merge: return "⇢"
        case .quiet: return "◌"
        }
    }

    private var ink: Color {
        switch row.tone {
        case .ok: return .green
        case .merge: return .accentColor
        case .quiet: return .secondary
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 11) {
            Text(mark)
                .font(.orbitGlyph.weight(.semibold))
                .foregroundStyle(ink)
                .frame(width: 30, height: 30)
                .background(ink.opacity(0.14), in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Text(row.title).fontWeight(.semibold).lineLimit(1)
                    Spacer(minLength: 8)
                    if !row.time.isEmpty {
                        Text(row.time)
                            .font(.orbitListSubtitle.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    if open {
                        Image(systemName: "chevron.up")
                            .font(.orbitMeta.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                }
                Text(row.detail)
                    .font(.orbitListSubtitle)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .contentShape(Rectangle())
    }
}
