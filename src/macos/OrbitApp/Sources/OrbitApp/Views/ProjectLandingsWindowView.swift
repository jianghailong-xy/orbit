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
///
/// It reads as a chat (owner 2026-11-02, docs/mocks/landings-chat-bubbles, option C): each settled
/// landing is a message from Orbit in a bubble, with Orbit's avatar beside the first of each group
/// sent close together (`LandingsWindowDay.groups`); the day sections are chips; the cards in hand are
/// Orbit's last messages; and the footer stands in the composer's place and shape, read only.
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
        windowAndBar
        .safeAreaInset(edge: .top, spacing: 0) { header }
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

    /// The window and the read-only bar in the composer's place under it. On iOS 26 the bar floats
    /// over the window as the console's band floats over its transcript: the messages run on under its
    /// glass, and the system's scroll-edge effect softens what passes beneath. Elsewhere it stands
    /// under the window, which fades into it.
    @ViewBuilder private var windowAndBar: some View {
        #if os(iOS)
        if #available(iOS 26.0, *) {
            scroller.safeAreaBar(edge: .bottom, spacing: 0) { footer }
        } else {
            VStack(spacing: 0) {
                scroller.fadesIntoComposerBand()
                footer
            }
        }
        #else
        VStack(spacing: 0) {
            scroller.fadesIntoComposerBand()
            footer
        }
        #endif
    }

    private var scroller: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if let model {
                        content(model)
                    } else {
                        ProgressView().frame(maxWidth: .infinity).padding(.vertical, 24)
                    }
                    Color.clear.frame(height: .composerBandFade).id(Self.bottom)
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

    /// What this window is, who decides, and the way to them, in the composer's place and shape — read
    /// only, nothing to type here (LS6). The board's bar (docs/mocks/landings-chat-bubbles, ① 5): the
    /// sentence where the words would go, `Decisions: the coordinator` on the toolbar, and
    /// `Open coordinator` where the send button stands.
    private var footer: some View {
        let parts = SessionLandingsCopy.orbitRunsTheseLandings.components(separatedBy: " — ")
        return ComposerBand {
            VStack(alignment: .leading, spacing: 0) {
                (Text("\(parts.first ?? "") — ").foregroundStyle(.secondary)
                    + Text(parts.dropFirst().joined(separator: " — ")).fontWeight(.semibold))
                    .font(.orbitSubtext)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 6)
                HStack(spacing: 8) {
                    Text(LandingPageCopy.decisionsTheCoordinator)
                        .font(.orbitLabel).foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    if let coordinator = model?.coordinatorID {
                        Button { open("orbit-session", coordinator) } label: {
                            Label(LandingPageCopy.openCoordinatorLink, systemImage: "person")
                                .font(.orbitLabel.weight(.semibold))
                        }
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.capsule)
                        .controlSize(.small)
                        .accessibilityIdentifier("landings-open-coordinator")
                    }
                }
                .frame(minHeight: 40)
                .padding(.leading, 16).padding(.trailing, 8).padding(.bottom, 6)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .composerBandCard(cornerRadius: 24)
        }
        .frame(maxWidth: 760)
        .frame(maxWidth: .infinity)
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
        // Every message is its own child of the lazy stack — a group is drawn, not nested — so each
        // keeps the id the placement scrolls to.
        ForEach(window.days) { day in
            dayChip(day.title)
            ForEach(day.groups) { group in
                ForEach(Array(group.rows.enumerated()), id: \.element.id) { index, row in
                    rowView(row, leads: index == 0, ends: index == group.rows.count - 1, model: model)
                }
            }
        }
        if !window.now.isEmpty {
            dayChip(SessionLandingsCopy.now, now: true)
            // What is still in hand is Orbit's last group of messages: one avatar beside the first card.
            ForEach(Array(window.now.enumerated()), id: \.element.id) { index, card in
                cardView(card, leads: index == 0, ends: index == window.now.count - 1, model: model)
            }
        }
    }

    /// A day of the session list's sections, or `Now`, as a chat's day chip: the word on a capsule in
    /// the middle of the window.
    private func dayChip(_ title: String, now: Bool = false) -> some View {
        Text(title)
            .font(.orbitLabel.weight(.semibold))
            .foregroundStyle(now ? Color.accentColor : Color.secondary)
            .padding(.horizontal, 11).padding(.vertical, 4)
            .background((now ? Color.accentColor : Color.secondary).opacity(0.12), in: Capsule())
            .frame(maxWidth: .infinity)
            .padding(.top, 14).padding(.bottom, 10)
            .accessibilityAddTraits(.isHeader)
    }

    /// One message's line: Orbit's avatar beside the first message of a group — room for it beside the
    /// rest — then the message, and the gap a group ends with.
    private func messageLine<Content: View>(leads: Bool, ends: Bool,
                                            @ViewBuilder _ message: () -> Content) -> some View {
        HStack(alignment: .top, spacing: 8) {
            ZStack(alignment: .top) {
                if leads { OrbitAppIcon(size: 32) }
            }
            .frame(width: 32)
            .accessibilityHidden(true)
            message()
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.bottom, ends ? 14 : 4)
    }

    /// One settled landing as Orbit's message: its bubble — the task's name, and a foot with the mark
    /// that says how it ended, its line and the moment it settled — that opens to its record under it.
    @ViewBuilder private func rowView(_ row: LandingsWindowRow, leads: Bool, ends: Bool,
                                      model: ProjectLandingsModel) -> some View {
        let id = row.id
        let open = expanded.contains(id)
        let landing = row.sessionId.flatMap { model.details[$0] }
        messageLine(leads: leads, ends: ends) {
            VStack(alignment: .leading, spacing: 4) {
                Button {
                    PlatformHaptics.tap()
                    toggle(id)
                } label: {
                    LandingsWindowBubble(row: row)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("landings-row:\(id)")
                #if os(iOS)
                .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: 16, style: .continuous))
                #endif
                .contextMenu { menu(landing: landing, row: row, sessionID: row.sessionId, model: model) }
                .overlay { outline(id, radius: 16) }
                if open {
                    record(row, landing: landing, model: model)
                }
            }
            // An incoming message's gutter: a bubble never runs to the window's far edge.
            .padding(.trailing, 44)
        }
        .id(id)
        .task(id: row.sessionId ?? "") {
            if let sessionID = row.sessionId { await model.readOnce(sessionID) }
        }
    }

    /// The quiet panel a message opens to, under it: the panel the person's own message opens what
    /// Orbit attached to (`AttachedNoteBody`).
    private func recordPanel<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content()
            .padding(.horizontal, 10).padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
    }

    /// What a settled row opens to: a merge's receipt first (board 03 e), then the landing's own
    /// timeline, and a task's two ways out.
    @ViewBuilder private func record(_ row: LandingsWindowRow, landing: SessionLandingView?,
                                     model: ProjectLandingsModel) -> some View {
        recordPanel {
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
        }
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

    /// One landing still in hand, under `Now`, as one of Orbit's last messages: the old landing page's
    /// status card with the task's name under its head, across the whole column (a card is wider than
    /// a bubble). Pressing it opens its record under it; a long press holds its doors.
    @ViewBuilder private func cardView(_ card: LandingsWindowCard, leads: Bool, ends: Bool,
                                       model: ProjectLandingsModel) -> some View {
        let id = card.sessionId
        let open = expanded.contains(id)
        let landing = model.details[id]
        let promotion = model.promotion(for: landing)
        messageLine(leads: leads, ends: ends) {
            VStack(alignment: .leading, spacing: 8) {
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
                .overlay { outline(id) }
                if let refusal = model.refusals[id] {
                    Text(refusal).font(.orbitMeta).foregroundStyle(.red)
                }
                if open, let landing {
                    recordPanel {
                        VStack(alignment: .leading, spacing: 12) {
                            LandingTimelineView(sessionID: id, landing: landing, now: Date())
                            entryLinks(landing)
                        }
                    }
                }
            }
        }
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
    private func outline(_ id: String, radius: CGFloat = 12) -> some View {
        RoundedRectangle(cornerRadius: radius, style: .continuous)
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

/// A settled landing as Orbit's message (owner 2026-11-02, docs/mocks/landings-chat-bubbles): the
/// task's name, whole, as a message reads, and a foot with the mark that says how it ended (✓ landed,
/// ⇢ merged into main, ◌ nothing to land and every other quiet ending), the row's own line and the
/// moment it settled. The bubble is as wide as its widest line and no wider than the column.
private struct LandingsWindowBubble: View {
    let row: LandingsWindowRow

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
        LandingsBubbleLayout(spacing: 4) {
            Text(row.title)
                .font(.orbitProse)
                .foregroundStyle(.primary)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(mark).fontWeight(.semibold).foregroundStyle(ink)
                Text(row.detail).foregroundStyle(.secondary).lineLimit(2)
                Spacer(minLength: 14)
                if !row.time.isEmpty {
                    Text(row.time).monospacedDigit().foregroundStyle(.secondary)
                }
            }
            .font(.orbitLabel)
        }
        .padding(.horizontal, 13).padding(.top, 9).padding(.bottom, 8)
        .background { fill }
        .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    /// The bubble's quiet grey. On iOS it stands on the window's own colour: a long press lifts the
    /// bubble out of the window, and a bare tint would show the dimmed screen through it.
    private var fill: some View {
        let shape = RoundedRectangle(cornerRadius: 16, style: .continuous)
        return ZStack {
            #if os(iOS)
            shape.fill(Color(uiColor: .systemBackground))
            #endif
            shape.fill(Color.primary.opacity(0.055))
        }
    }
}

/// A bubble's lines: as wide as the widest of them — the words wrapped at the room there is, the foot
/// at its natural width — and never wider than the room offered; every line then takes that width, so
/// the foot's time stands at the bubble's trailing edge. A plain stack takes all the room the row
/// offers, because the foot's spacer is flexible, and every bubble would be the column's width.
private struct LandingsBubbleLayout: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = bubbleWidth(for: proposal, subviews)
        let heights = subviews.map { $0.sizeThatFits(ProposedViewSize(width: width, height: nil)).height }
        return CGSize(width: width, height: heights.reduce(0, +) + spacing * CGFloat(max(subviews.count - 1, 0)))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for subview in subviews {
            let height = subview.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil)).height
            subview.place(at: CGPoint(x: bounds.minX, y: y), anchor: .topLeading,
                          proposal: ProposedViewSize(width: bounds.width, height: height))
            y += height + spacing
        }
    }

    /// Each line at the room there is, or at its natural width where that is less: wrapped words
    /// report the width they took, and a line with a spacer, which would take all of it, its own.
    private func bubbleWidth(for proposal: ProposedViewSize, _ subviews: Subviews) -> CGFloat {
        let room = proposal.width ?? .infinity
        let widest = subviews.map { subview -> CGFloat in
            let natural = subview.sizeThatFits(.unspecified).width
            guard room.isFinite else { return natural }
            return min(natural, subview.sizeThatFits(ProposedViewSize(width: room, height: nil)).width)
        }.max() ?? 0
        return room.isFinite ? min(widest, room) : widest
    }
}
