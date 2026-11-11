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

    /// Whether a card in hand runs. No event reports a landing as it moves (contract §2.7a), so while
    /// one runs the window reads every 4 s — only while it can be seen; otherwise it follows the control
    /// stream like any page (`ViewPoll`, docs/list-freshness-design.md §4 R6): the project's hints and
    /// a minute's safety read while the stream is live, every 15 s while it is down.
    var cardRunning: Bool {
        window.now.contains { details[$0.sessionId]?.currentAttempt?.state == "RUNNING" }
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
/// The window is the old landing session page's shell — `Landings` over the project's name, a ⋯
/// with the coordinator and the project, the read-only footer and no composer (LS6) — and each landing
/// in it carries what that page drew: a card still in hand is its status card, a settled row opens in
/// place to its timeline. The doors the page's ⋯ held are each landing's own: a long press on it.
///
/// It reads as a chat (owner 2026-11-02, docs/mocks/landings-chat-bubbles, option C): each settled
/// landing is a message from Orbit in a bubble, grouped with those sent close together
/// (`LandingsWindowDay.groups`); the day sections are chips; the cards in hand are Orbit's last
/// messages. Polished on the phone (owner 2026-11-10, docs/mocks/landings-ui-polish): no avatars, a
/// merge into main is a centred event line, the head is the navigation bar's one row, and the
/// read-only footer is one opaque line on the bottom edge.
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
        #if os(iOS)
        // The phone's head is the navigation bar's one row (owner 2026-11-10, docs/mocks/landings-ui-polish
        // ⑤): back, `Landings` over the project's name, and the ⋯ — not a second head under an empty bar.
        .toolbar {
            ToolbarItem(placement: .principal) { titleBlock }
            ToolbarItem(placement: .topBarTrailing) { windowMenu }
        }
        #else
        .safeAreaInset(edge: .top, spacing: 0) { header }
        #endif
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

    /// The window and the read-only bar under it (owner 2026-11-10, docs/mocks/landings-ui-polish ③):
    /// one opaque line on the bottom edge, so no message runs on beneath or below it.
    private var windowAndBar: some View {
        VStack(spacing: 0) {
            scroller
            footer
        }
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
                    Color.clear.frame(height: 8).id(Self.bottom)
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

    #if os(iOS)
    /// The navigation bar's title: `Landings` over the project's name.
    private var titleBlock: some View {
        VStack(spacing: 1) {
            Text(SessionLandingsCopy.title).font(.headline).lineLimit(1)
            Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
        .frame(maxWidth: 260)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
    #else
    /// The Mac window's head, for the whole project: `Landings`, the project's name, and the window's
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
    #endif

    /// The project's name; `Run by Orbit` until it is known. The bar at the bottom already says Orbit
    /// runs these landings, so the name has the whole line.
    private var subtitle: String {
        guard let title = model?.projectTitle, !title.isEmpty else { return LandingPageCopy.runByOrbit }
        return title
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
            #if os(iOS)
            Image(systemName: "ellipsis")
            #else
            Image(systemName: "ellipsis.circle")
                .font(.orbitGlyph)
            #endif
        }
        // The board's plain ⋯ rather than macOS's pull-down bezel (iOS's Menu already draws one).
        #if os(macOS)
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .frame(width: 28)
        #endif
        .accessibilityIdentifier("landings-more")
        .accessibilityLabel("More actions")
    }

    /// What this window is and the way to who decides, read only — nothing to type here (LS6): a lock
    /// and the sentence's first half, `Open coordinator` at the trailing edge. One line, on the bar's
    /// own colour, pinned to the bottom edge (owner 2026-11-10, docs/mocks/landings-ui-polish ③).
    private var footer: some View {
        let words = SessionLandingsCopy.orbitRunsTheseLandings.components(separatedBy: " — ").first ?? ""
        return HStack(spacing: 10) {
            Label(words, systemImage: "lock")
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
                // One line, never `fixedSize`: a Mac window measures its minimum at zero width, where a
                // vertically fixed sentence stands one glyph to a line and the window's floor grows past
                // the screen, pushing this bar off its bottom edge (probe run 41370339640).
                .lineLimit(1)
                .accessibilityLabel(SessionLandingsCopy.orbitRunsTheseLandings)
            Spacer(minLength: 8)
            if let coordinator = model?.coordinatorID {
                Button { open("orbit-session", coordinator) } label: {
                    Label(LandingPageCopy.openCoordinatorLink, systemImage: "person")
                        .font(.orbitLabel.weight(.semibold))
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .controlSize(.small)
                .accessibilityHint(LandingPageCopy.decisionsTheCoordinator)
                .accessibilityIdentifier("landings-open-coordinator")
            }
        }
        .frame(minHeight: 34)
        .padding(.leading, 18).padding(.trailing, 12).padding(.vertical, 8)
        .frame(maxWidth: 760)
        .frame(maxWidth: .infinity)
        .background(alignment: .top) {
            Rectangle().fill(.bar).ignoresSafeArea(edges: .bottom)
                .overlay(alignment: .top) { Divider() }
        }
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
                    rowView(row, ends: index == group.rows.count - 1, model: model)
                }
            }
        }
        if !window.now.isEmpty {
            dayChip(SessionLandingsCopy.now, now: true)
            // What is still in hand is Orbit's last group of messages.
            ForEach(Array(window.now.enumerated()), id: \.element.id) { index, card in
                cardView(card, ends: index == window.now.count - 1, model: model)
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

    /// One message's line, and the gap a group ends with. No avatar: every message here is Orbit's,
    /// and the head says so (owner 2026-11-10, docs/mocks/landings-ui-polish ①).
    private func messageLine<Content: View>(ends: Bool, @ViewBuilder _ message: () -> Content) -> some View {
        message()
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, ends ? 14 : 6)
    }

    /// One settled landing as the session chat's background-job line (owner 2026-11-11,
    /// docs/mocks/landings-chat-tools-native): the mark, how it ended, how long its checks took, the
    /// moment it settled and `Details ›`, the task's name under them; it opens to its steps under it. A
    /// merge into main is the same line, and opens to its receipt first.
    @ViewBuilder private func rowView(_ row: LandingsWindowRow, ends: Bool,
                                      model: ProjectLandingsModel) -> some View {
        let id = row.id
        let open = expanded.contains(id)
        let landing = row.sessionId.flatMap { model.details[$0] }
        let merge = row.tone == .merge
        // How long the checks took: the round's merged record, else the landing's own read.
        let checkMs = (merge ? LandingSteps.checksDurationMs((row.promotion?.checks ?? []).map(\.durationMs)) : nil)
            ?? LandingSteps.checksDurationMs((landing?.checks ?? []).map(\.durationMs))
        messageLine(ends: ends) {
            VStack(alignment: .leading, spacing: 4) {
                Button {
                    PlatformHaptics.tap()
                    toggle(id)
                } label: {
                    LandingLineView(
                        kind: merge ? .merge : row.tone == .ok ? .ok : .quiet,
                        title: merge ? row.title : row.detail,
                        name: merge ? row.detail : row.title,
                        status: checkMs.map { "\(LandingStepCopy.check) \(LandingPageCopy.duration(ms: $0))" },
                        time: row.time, open: open)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("landings-row:\(id)")
                #if os(iOS)
                .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: 8, style: .continuous))
                #endif
                .contextMenu { menu(landing: landing, row: row, sessionID: row.sessionId, model: model) }
                .overlay { outline(id, radius: 8) }
                if open {
                    record(row, landing: landing, model: model)
                }
            }
        }
        .id(id)
        .task(id: row.sessionId ?? "") {
            if let sessionID = row.sessionId { await model.readOnce(sessionID) }
        }
    }

    /// What a line opens to hangs under it, off its mark, as the chat hangs a job line's fold.
    private func recordPanel<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content()
            .padding(.leading, LandingLineView.indent).padding(.bottom, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
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
    @ViewBuilder private func cardView(_ card: LandingsWindowCard, ends: Bool,
                                       model: ProjectLandingsModel) -> some View {
        let id = card.sessionId
        let landing = model.details[id]
        let promotion = model.promotion(for: landing)
        let attempt = landing?.currentAttempt
        let settled = landing?.settledAt != nil
        let running = !settled && attempt?.state == "RUNNING" && attempt?.timedOut == false
        let timedOut = !settled && attempt?.timedOut == true
        let waiting = !settled && card.state == "AWAITING_DECISION"
        // What needs a look stays open: a landing that runs, waits for a decision or timed out
        // (docs/mocks/landings-chat-tools-native d).
        let open = expanded.contains(id) || running || waiting || timedOut
        messageLine(ends: ends) {
            VStack(alignment: .leading, spacing: 8) {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    VStack(alignment: .leading, spacing: 4) {
                        // A landing that runs is the chat's turn in hand: its Working for head over it.
                        if running, let started = attempt.flatMap({ RelativeTime.parse($0.startedAt) }) {
                            Text("\(LandingStepCopy.workingFor) \(ProjectPage.landingClock(max(0, context.date.timeIntervalSince(started))))")
                                .font(.orbitMeta).foregroundStyle(.secondary)
                        }
                        LandingStatusCardView(
                            sessionID: id, landing: landing, title: card.title, now: context.date,
                            readAt: model.readAt[id], readFailed: model.readFailed.contains(id),
                            facts: model.facts(landing), promotion: promotion,
                            waitDoors: waitDoors(card, landing: landing, promotion: promotion, model: model),
                            acting: model.acting.contains(id),
                            act: { action in press(action, sessionID: id, landing: landing, row: nil, model: model) },
                            open: open)
                    }
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
        await model.refresh(app: app, focusID: focusID)
        await ViewPoll.run(app, every: 15, hints: { app.projectHints }, inFlight: { model.cardRunning ? 4 : nil }) {
            await model.refresh(app: app, focusID: focusID)
        }
    }
}
