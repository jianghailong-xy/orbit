import SwiftUI
import Observation
import OrbitKit

/// The landing session page (contract §2.9 LS1/LS6/LS7; design §3; mockups v4
/// `docs/mocks/landing-session/v4/05-landing-session-page`): a session the platform drives, drawn as
/// its own reader — the status card over the newest attempt, the server's timeline, the check output
/// a line opens, and the owner doors the landing view's facts allow.
///
/// It is a reading surface, not a conversation: no composer, no engine, no model, no rename, fork,
/// share or merge bar (LS6). The one way out that matters — the coordinator, or the merge card that
/// decides a round — is named in the footer.
///
/// Every word and every door condition is `LandingPageCopy`'s, tested on Linux; this view only lays
/// them out. The page reads `GET /sessions/:id` on its own cadence (§2.7a: RUNNING 4 s, QUEUED 15 s,
/// nothing once settled), beside the project's integration, coordinator and promotion reads the head
/// and the gates take their facts from.
struct LandingSessionPageView: View {
    let sessionID: String
    @Environment(AppModel.self) private var app

    @State private var landing: SessionLandingView?
    @State private var rowTitle: String?
    /// When this device last got an answer, and whether that read failed.
    @State private var readAt: Date?
    @State private var readFailed = false
    @State private var integration: ProjectIntegrationView?
    @State private var coordinator: ProjectCoordinatorStatus?
    @State private var promotion: ProjectPromotionView?
    @State private var mergedPromotions: [ProjectPromotionView] = []
    @State private var taskTitle: String?
    @State private var refusal: String?
    @State private var now = Date()
    @State private var openLog: LandingLogSelectors?
    @State private var reviewOpen = false
    @State private var acting = false
    @State private var reviewSource: LandingPromotionSource?

    private var api: APIClient? {
        guard let baseURL = app.baseURL else { return nil }
        return APIClient(baseURL: baseURL, tokenStore: app.tokenStore)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                if let landing {
                    statusCard(landing)
                } else if readFailed {
                    offlineCard
                } else {
                    loadingCard
                }
                if let refusal {
                    Text(refusal)
                        .font(.orbitMeta).foregroundStyle(.red)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if let landing {
                    timeline(landing)
                }
            }
            .padding(16)
            .frame(maxWidth: 760, alignment: .leading)
            .frame(maxWidth: .infinity)
        }

        .safeAreaInset(edge: .bottom, spacing: 0) {
            if let landing { footer(landing) }
        }
        .task(id: sessionID) { await run() }
        .task(id: sessionID) {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                if Task.isCancelled { return }
                now = Date()
            }
        }
        .sheet(isPresented: $reviewOpen) {
            if let source = reviewSource, let promotionID = landing?.promotionId {
                PromotionReviewSheet(source: source, promotionID: promotionID)
            }
        }
    }

    // MARK: - the head

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(LandingPageCopy.headerTitle(landing, rowTitle: rowTitle, taskTitle: taskTitle))
                    .font(.title3.weight(.semibold))
                    .lineLimit(2)
                HStack(spacing: 4) {
                    Image(systemName: "arrow.triangle.2.circlepath")
                    Text(LandingPageCopy.chip)
                }
                .font(.orbitMeta.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8).padding(.vertical, 2)
                .background(Color.secondary.opacity(0.12), in: Capsule())
                Spacer(minLength: 8)
                if let landing, !menuItems(landing).isEmpty {
                    menu(landing)
                }
            }
            Text(LandingPageCopy.headerSub(landing))
                .font(.orbitListSubtitle)
                .foregroundStyle(.secondary)
        }
    }

    private func menuItems(_ landing: SessionLandingView) -> [LandingMenuItem] {
        let gates = LandingPageCopy.gates(landing, now: now, updatedAt: readAt, failed: readFailed)
        let attempt = landing.currentAttempt
        let nothingPushed = attempt.map { attempt in
            attempt.kind == "CHECK_PROMOTION"
                || (attempt.timedOut
                    && LandingPageCopy.pushSentence(landing, attempt: attempt)
                        == LandingPageCopy.nothingPushedSentence)
        } ?? false
        return LandingPageCopy.menuItems(
            landing, gates: gates,
            hasCoordinator: coordinator?.coordination.sessionId != nil,
            hasReview: currentPromotion(landing) != nil,
            nothingPushed: nothingPushed)
    }

    private func menu(_ landing: SessionLandingView) -> some View {
        Menu {
            ForEach(menuItems(landing)) { item in
                Button(role: item.danger ? ButtonRole.destructive : nil) {
                    press(item, landing: landing)
                } label: {
                    if let sub = item.sub {
                        Text("\(item.label) — \(sub)")
                    } else {
                        Text(item.label)
                    }
                }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .font(.orbitGlyph)
        }
        // The board's plain ⋯ rather than macOS's pull-down bezel (iOS's Menu already draws one),
        // and one identifier a screenshot test can press: the console's own session menu is not
        // drawn on a landing session.
        #if os(macOS)
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        #endif
        .fixedSize()
        .accessibilityIdentifier("landing-more")
        .accessibilityLabel("More actions")
    }

    // MARK: - the status card

    @ViewBuilder private func statusCard(_ landing: SessionLandingView) -> some View {
        let card = LandingPageCopy.attemptCard(landing, now: now, updatedAt: readAt,
                                               failed: readFailed, facts: facts(landing))
        let outcome = LandingPageCopy.outcomeCard(landing, promotion: currentPromotion(landing))
        VStack(alignment: .leading, spacing: 8) {
            if let outcome {
                ProjectLandingHead(
                    title: outcome.title,
                    head: ProjectPage.LandingHead(right: outcome.right, isClock: false,
                                                  detail: outcome.detail ?? ""),
                    running: false, timedOut: false, ok: outcome.ok)
                if let heading = outcome.tasksHeading {
                    Text(heading).font(.orbitLabel.weight(.semibold))
                    ForEach(outcome.tasks, id: \.self) { title in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text("•").foregroundStyle(.secondary)
                            Text(title).font(.orbitLabel)
                        }
                    }
                }
                if let checkLine = outcome.checkLine {
                    Text(checkLine).font(.orbitMeta).foregroundStyle(.green)
                }
                if let treeLine = outcome.treeLine {
                    Text(treeLine).font(.orbitMeta).foregroundStyle(.secondary)
                }
            } else if let card {
                ProjectLandingHead(
                    title: card.word,
                    head: ProjectPage.LandingHead(right: card.right, isClock: card.rightIsClock,
                                                  detail: card.detail),
                    running: card.running, timedOut: card.timedOut)
                if let budget = card.budget {
                    Text(budget).font(.orbitMeta).foregroundStyle(.secondary)
                    if let progress = card.progress {
                        budgetMeter(progress: progress, usual: card.usualProgress)
                    }
                }
                if let live = card.live {
                    HStack(spacing: 6) {
                        if card.fresh {
                            Circle().fill(.green).frame(width: 7, height: 7)
                        }
                        Text(live).font(.orbitMeta).foregroundStyle(.secondary)
                    }
                }
                // What the running check leads to, said while it runs (mockup 05 a): the reader
                // learns now whether to wait for a question or walk away. Web: `promotionOnPassLine`.
                if landing.subject == "PROMOTION", landing.settledAt == nil, card.running,
                   landing.currentAttempt?.kind == "CHECK_PROMOTION",
                   let onPass = PromotionCards.onPassLine(currentPromotion(landing)) {
                    Text(onPass).font(.orbitMeta).foregroundStyle(.secondary)
                }
                if card.timedOut, let attempt = landing.currentAttempt {
                    Text(LandingPageCopy.timeoutLine(landing, attempt: attempt,
                                                     main: facts(landing).mainBranch))
                        .font(.orbitMeta).foregroundStyle(.secondary)
                    if let push = LandingPageCopy.pushSentence(landing, attempt: attempt) {
                        Text(push).font(.orbitMeta).foregroundStyle(.secondary)
                    }
                }
                if let failure = card.failure {
                    Text(failure).font(.orbitMeta).foregroundStyle(.secondary)
                }
                if card.timedOut {
                    timedOutDoors(landing)
                }
            } else {
                Text(LandingPageCopy.queued).font(.orbitMeta).foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(background(for: card, outcome: outcome),
                    in: RoundedRectangle(cornerRadius: 14))
        .overlay {
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(stroke(for: card, outcome: outcome), lineWidth: 1)
        }
    }

    private func background(for card: LandingAttemptCard?,
                            outcome: LandingOutcomeCard?) -> Color {
        // A settled success is the board's green card (mockup 05 c); a timed-out attempt amber;
        // everything else the neutral wash the row wears.
        if outcome?.ok == true { return Color.green.opacity(0.08) }
        if card?.timedOut == true { return Color.orange.opacity(0.08) }
        return Color.secondary.opacity(0.1)
    }

    private func stroke(for card: LandingAttemptCard?,
                        outcome: LandingOutcomeCard?) -> Color {
        if outcome?.ok == true { return Color.green.opacity(0.3) }
        return card?.timedOut == true ? Color.orange.opacity(0.3) : Color.clear
    }

    /// The quiet meter under the head: how far the step is through its budget, with the check's
    /// usual duration as the board's little tick.
    private func budgetMeter(progress: Double, usual: Double?) -> some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.secondary.opacity(0.2))
                Capsule().fill(Color.accentColor.opacity(0.6))
                    .frame(width: proxy.size.width * CGFloat(min(1, max(0, progress))))
                if let usual {
                    Rectangle().fill(Color.secondary.opacity(0.6))
                        .frame(width: 1.5, height: proxy.size.height)
                        .offset(x: proxy.size.width * CGFloat(min(1, max(0, usual))))
                }
            }
        }
        .frame(height: 4)
        .accessibilityHidden(true)
    }

    /// The two doors a timed-out attempt offers: the server's Retry, a check's Re-run, and Abandon —
    /// each only where the landing view's facts open it.
    @ViewBuilder private func timedOutDoors(_ landing: SessionLandingView) -> some View {
        let gates = LandingPageCopy.gates(landing, now: now, updatedAt: readAt, failed: readFailed)
        HStack(spacing: 8) {
            if gates.retry {
                Button(LandingPageCopy.retry) { act(.retry, landing) }
                    .buttonStyle(.borderedProminent).controlSize(.small).disabled(acting)
            }
            if gates.recheck {
                Button(LandingPageCopy.rerunTheCheck) { act(.rerunTheCheck, landing) }
                    .buttonStyle(.borderedProminent).controlSize(.small).disabled(acting)
            }
            if gates.abandon {
                // Board 05's light red secondary beside the solid Retry (`cap4.red`), like the web's
                // default danger button. A bordered button takes its fill from the tint: the
                // destructive role alone reddens the word on a grey fill, so the red tint gives the
                // light red wash. A Mac push button keeps the word black unless the label itself is red.
                Button(role: .destructive) { act(.abandon, landing) } label: {
                    Text(LandingPageCopy.abandon)
                        #if os(macOS)
                        .foregroundStyle(.red)
                        #endif
                }
                .buttonStyle(.bordered).tint(.red).controlSize(.small).disabled(acting)
            }
            Spacer(minLength: 0)
        }
    }

    /// The offline page: the last integration snapshot, frozen, and no door — a press against a stale
    /// fact is a decision made on nothing.
    private var offlineCard: some View {
        let placeholder = LandingPageCopy.offlinePlaceholder(
            sessionId: sessionID, projectId: nil,
            inFlight: app.landingInFlightCache[sessionID])
        let card = placeholder.flatMap {
            LandingPageCopy.attemptCard($0, now: now, updatedAt: nil, failed: true)
        }
        return VStack(alignment: .leading, spacing: 8) {
            if let card {
                ProjectLandingHead(
                    title: card.word,
                    head: ProjectPage.LandingHead(right: card.right, isClock: card.rightIsClock,
                                                  detail: card.detail),
                    running: false, timedOut: false)
                if let live = card.live {
                    Text(live).font(.orbitMeta).foregroundStyle(.secondary)
                }
            } else {
                Text(LandingPageCopy.updateUnavailable)
                    .font(.orbitLabel).foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
    }

    private var loadingCard: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text(LandingPageCopy.loadingLanding)
                .font(.orbitLabel).foregroundStyle(.secondary)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
    }

    // MARK: - the timeline

    @ViewBuilder private func timeline(_ landing: SessionLandingView) -> some View {
        if let timeline = landing.timeline,
           !timeline.sections.isEmpty || !timeline.facts.isEmpty {
            VStack(alignment: .leading, spacing: 14) {
                // The current round's state is the status card's to say; the board's timeline does
                // not repeat it as a fact above the sections.
                ForEach(Array(timeline.facts.filter { $0.kind != "PROMOTION_STATE" }.enumerated()),
                        id: \.offset) { _, fact in
                    Text(fact.text).font(.orbitMeta).foregroundStyle(.secondary)
                }
                ForEach(timeline.sections) { section in
                    sectionView(section, landing: landing)
                }
                if timeline.truncated {
                    Text(LandingPageCopy.olderAttemptsHidden)
                        .font(.orbitMeta).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder private func sectionView(_ section: IntegrationTimelineSection,
                                          landing: SessionLandingView) -> some View {
        let current = section.jobId == landing.currentAttempt?.jobId
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(section.title).font(.orbitLabel.weight(.semibold))
                if let state = LandingPageCopy.sectionState(section.state) {
                    Text(state).font(.orbitMeta).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            ForEach(Array(section.entries.enumerated()), id: \.offset) { index, entry in
                entryView(entry, section: section, entries: section.entries, index: index)
            }
            if current, let attempt = landing.currentAttempt,
               attempt.state == "RUNNING", !attempt.timedOut, attempt.check != nil {
                liveCheck(attempt)
            }
            if current, let band = LandingPageCopy.noReportBand(landing) {
                Text(band.text)
                    .font(.orbitMeta).foregroundStyle(.secondary)
                    .padding(.horizontal, 8).padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            }
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func entryView(_ entry: IntegrationTimelineEntry,
                                        section: IntegrationTimelineSection,
                                        entries: [IntegrationTimelineEntry],
                                        index: Int) -> some View {
        let mark = glyph(entry, jobKind: section.kind, entries: entries, index: index)
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if let at = RelativeTime.parse(entry.at) {
                    Text(ProjectPage.landingClockTime(at))
                        .font(.orbitMeta.monospacedDigit())
                        .foregroundStyle(.secondary)
                } else {
                    Text("--:--").font(.orbitMeta.monospacedDigit()).foregroundStyle(.secondary)
                }
                Text(mark.glyph)
                    .font(.orbitMeta.weight(.semibold))
                    .foregroundStyle(mark.color)
                    .frame(width: 16)
                Text(entry.text)
                    .font(.orbitLabel)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                if entry.kind == "CHECK_FINISHED", let check = entry.check {
                    Button("\(LandingPageCopy.log) ›") {
                        let selectors = LandingLogSelectors(jobId: section.jobId, claim: entry.claim,
                                                            round: entry.round, check: check.index)
                        openLog = openLog == selectors ? nil : selectors
                    }
                    .font(.orbitMeta.weight(.semibold))
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.accentColor)
                }
            }
            if let reason = entry.reason, !entry.text.contains(reason) {
                Text(reason).font(.orbitMeta).foregroundStyle(.secondary)
                    .padding(.leading, 24)
            }
            if let openLog, openLog.jobId == section.jobId,
               entry.kind == "CHECK_FINISHED", let check = entry.check,
               openLog.claim == entry.claim, openLog.round == entry.round,
               openLog.check == check.index {
                LandingCheckLogView(sessionID: sessionID, selectors: openLog)
                    .padding(.leading, 24)
            } else if entry.kind == "CHECK_FINISHED", let check = entry.check, !entry.checkPassed {
                // A check that failed shows the tail it died on, inline (mockup 05 g); a passed
                // one keeps its `Log ›` and stays one line.
                LandingInlineOutput(
                    sessionID: sessionID,
                    selectors: LandingLogSelectors(jobId: section.jobId, claim: entry.claim,
                                                   round: entry.round, check: check.index))
                    .padding(.leading, 24)
            }
        }
    }

    private struct Mark {
        let glyph: String
        let color: Color
    }

    /// What a timeline mark says, and the ink it says it in (mockups 05 a/e/i).
    private func glyph(_ entry: IntegrationTimelineEntry, jobKind: String,
                       entries: [IntegrationTimelineEntry], index: Int) -> Mark {
        switch entry.kind {
        case "TAKEN_OVER":
            return Mark(glyph: "↗", color: .accentColor)
        case "CHECK_FINISHED", "RESULT", "RESULT_FALLBACK":
            return entry.succeeded(in: jobKind) ? Mark(glyph: "✓", color: .green) : Mark(glyph: "✗", color: .red)
        case "STOP_REQUESTED", "CANCELLED", "ABANDONED", "TIMED_OUT", "PUSH_REFUSED":
            return Mark(glyph: "✗", color: .red)
        case "ENQUEUED", "REQUEUED", "NEXT_GENERATION", "SKIPPED_CHECK", "FIX_TASK":
            return Mark(glyph: "≡", color: .secondary)
        case "RELEASED":
            return Mark(glyph: "↩", color: .secondary)
        case "STEP":
            let later = entries.dropFirst(index + 1).contains {
                ["STEP", "CHECK_STARTED", "TAKEN_OVER", "RESULT", "CHECK_FINISHED",
                 "CANCELLED", "TIMED_OUT"].contains($0.kind)
            }
            return later ? Mark(glyph: "✓", color: .green) : Mark(glyph: "↻", color: .accentColor)
        default:
            return Mark(glyph: "↻", color: .accentColor)
        }
    }

    /// The check running now, inline: its name, how long it has been live, and the tail of what it
    /// has printed — the same landing-log read `Log ›` opens.
    @ViewBuilder private func liveCheck(_ attempt: SessionLandingAttempt) -> some View {
        if let check = attempt.check {
            LandingLiveCheckView(
                sessionID: sessionID,
                selectors: LandingLogSelectors(jobId: attempt.jobId, claim: attempt.claim,
                                               round: attempt.round, check: check.index),
                title: "\(LandingPageCopy.checkLabel(check.name)) · live "
                    + ProjectPage.landingClock(max(0, now.timeIntervalSince(
                        RelativeTime.parse(check.startedAt) ?? now))))
                .padding(.leading, 24)
        }
    }

    // MARK: - the footer

    @ViewBuilder private func footer(_ landing: SessionLandingView) -> some View {
        let footer = LandingPageCopy.footer(landing, onPass: currentPromotion(landing)?.onPass)
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Text(footer.line).font(.orbitMeta).foregroundStyle(.secondary)
                if let detail = footer.detail {
                    Text(detail).font(.orbitMeta.weight(.semibold)).foregroundStyle(.secondary)
                }
                if let link = footer.link {
                    if link == .coordinator, let session = coordinator?.coordination.sessionId {
                        Button("\(LandingPageCopy.openCoordinatorLink) ›") {
                            if let url = URL(string: "orbit-session:\(PublicID.toPublic(session))") {
                                openURL(url)
                            }
                        }
                        .font(.orbitMeta).buttonStyle(.plain).foregroundStyle(Color.accentColor)
                    } else if link == .reviewCard, currentPromotion(landing) != nil {
                        Button("\(LandingPageCopy.reviewCard) ›") { openReview(landing) }
                            .font(.orbitMeta).buttonStyle(.plain).foregroundStyle(Color.accentColor)
                    }
                }
            }
            if let next = footer.next {
                Text(next).font(.orbitMeta).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16).padding(.vertical, 8)
        .background(.bar)
    }

    @Environment(\.openURL) private var openURL

    // MARK: - the reads

    private func facts(_ landing: SessionLandingView) -> LandingFacts {
        let job = integration?.inFlightJobs?.first { $0.jobId == landing.currentAttempt?.jobId }
        return LandingFacts(stepStartedAt: job?.stepStartedAt, typicalMs: job?.typicalMs,
                            main: RunSettings.mainBranchName(integration?.upstreamRef))
    }

    private func currentPromotion(_ landing: SessionLandingView) -> ProjectPromotionView? {
        guard landing.subject == "PROMOTION" else { return nil }
        if landing.settledAt != nil {
            return mergedPromotions.first { $0.promotionId == landing.promotionId }
        }
        return promotion
    }

    private func run() async {
        while !Task.isCancelled {
            await refresh()
            // §2.7a's cadence once there is an attempt to read; a page with nothing yet, or a read
            // that failed, asks again every 15 s; a settled subject stops.
            let interval: TimeInterval?
            if let landing {
                interval = LandingPageCopy.refetchInterval(landing)
            } else {
                interval = 15
            }
            guard let interval else { return }
            do { try await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000)) }
            catch { return }
        }
    }

    private func refresh() async {
        guard let api else { return }
        rowTitle = app.session(id: sessionID)?.title
        do {
            let detail = try await api.sessionDetail(sessionID)
            landing = detail.landing ?? landing
            if let title = app.session(id: sessionID)?.title { rowTitle = title }
            readAt = Date()
            readFailed = false
        } catch {
            readFailed = true
        }
        guard let landing else { return }
        let projectID = landing.projectId
        if !projectID.isEmpty, landing.settledAt == nil {
            integration = try? await api.projectIntegration(projectID)
            if let integration { app.rememberLandingJobs(integration) }
            coordinator = try? await api.projectCoordinatorStatus(projectID)
            if landing.subject == "PROMOTION" {
                promotion = try? await api.currentPromotion(projectID: projectID)
            }
        }
        if landing.subject == "PROMOTION", landing.settledAt != nil, !projectID.isEmpty {
            mergedPromotions = (try? await api.mergedPromotions(projectID: projectID)) ?? []
        }
        if landing.subject == "TASK", taskTitle == nil, let taskID = landing.taskId {
            taskTitle = (try? await api.taskRow(taskID))?.title
        }
        if promotion != nil || currentPromotion(landing) != nil {
            ensureReviewSource(projectID: projectID)
        }
    }

    private func ensureReviewSource(projectID: String) {
        guard let api else { return }
        if reviewSource == nil { reviewSource = LandingPromotionSource(api: api, projectID: projectID) }
        reviewSource?.promotion = promotion
        reviewSource?.landings = integration?.landTasks ?? []
    }

    private func openReview(_ landing: SessionLandingView) {
        ensureReviewSource(projectID: landing.projectId)
        Task { await reviewSource?.refreshPromotion() }
        reviewOpen = true
    }

    // MARK: - the presses

    private func press(_ item: LandingMenuItem, landing: SessionLandingView) {
        switch item.action {
        case .openTask:
            if let taskID = landing.taskId, let url = URL(string: "orbit-task:\(PublicID.toPublic(taskID))") {
                openURL(url)
            }
        case .openSourceSession:
            if let source = landing.currentAttempt?.sourceSessionId,
               let url = URL(string: "orbit-session:\(PublicID.toPublic(source))") {
                openURL(url)
            }
        case .openCoordinator:
            if let session = coordinator?.coordination.sessionId,
               let url = URL(string: "orbit-session:\(PublicID.toPublic(session))") {
                openURL(url)
            }
        case .reviewCard:
            openReview(landing)
        default:
            act(item.action, landing)
        }
    }

    private func act(_ action: LandingMenuAction, _ landing: SessionLandingView) {
        guard !acting, let api else { return }
        acting = true
        Task {
            defer { acting = false }
            do {
                switch action {
                case .stop:
                    guard let taskID = landing.taskId else { return }
                    try await api.stopTaskIntegration(projectID: landing.projectId, taskID: taskID)
                case .cancel:
                    guard let promotionID = landing.promotionId else { return }
                    _ = try await api.cancelPromotion(projectID: landing.projectId,
                                                      promotionID: promotionID)
                case .abandon:
                    guard let jobID = landing.currentAttempt?.jobId else { return }
                    try await api.abandonIntegrationJob(projectID: landing.projectId, jobID: jobID)
                case .retry:
                    guard let jobID = landing.currentAttempt?.jobId else { return }
                    _ = try await api.retryIntegrationJob(landing.projectId, jobID: jobID)
                case .rerunTheCheck:
                    guard let promotionID = landing.promotionId else { return }
                    try await api.rerunPromotionCheck(projectID: landing.projectId,
                                                      promotionID: promotionID,
                                                      reason: LandingPageCopy.rerunLandingCheckReason)
                default:
                    return
                }
                refusal = nil
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
                refusal = "\(label) — \(reason)."
            }
            // The landing and the project reads are what the card was drawn from; read again.
            readAt = nil
            await refresh()
        }
    }
}

/// One check's output, read when its line is opened: the page of chunks the landing log answers,
/// continued by its cursor. Chunks arrive already redacted; a dropped middle is one line saying how
/// many bytes it took.
private struct LandingCheckLogView: View {
    let sessionID: String
    let selectors: LandingLogSelectors
    @Environment(AppModel.self) private var app
    @State private var page: LandingLogPage?
    @State private var failed: String?

    private var api: APIClient? {
        guard let baseURL = app.baseURL else { return nil }
        return APIClient(baseURL: baseURL, tokenStore: app.tokenStore)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let failed {
                Text("\(LandingPageCopy.logUnavailable) — \(failed)")
                    .font(.orbitMeta).foregroundStyle(.red)
            } else if let page {
                if page.entries.isEmpty {
                    Text(LandingPageCopy.logEmpty)
                        .font(.orbitMeta).foregroundStyle(.secondary)
                } else {
                    ForEach(Array(page.entries.enumerated()), id: \.offset) { _, entry in
                        VStack(alignment: .leading, spacing: 2) {
                            if entry.truncatedBytes > 0 {
                                Text(LandingPageCopy.bytesOmitted(entry.truncatedBytes))
                                    .font(.orbitMeta).foregroundStyle(.secondary)
                            }
                            Text(entry.text)
                                .font(.orbitMono)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
                if page.nextCursor != nil {
                    Button(LandingPageCopy.showMore) { load(more: true) }
                        .font(.orbitMeta.weight(.semibold))
                        .buttonStyle(.plain).foregroundStyle(Color.accentColor)
                }
            } else {
                Text(LandingPageCopy.loadingLog)
                    .font(.orbitMeta).foregroundStyle(.secondary)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
        .task { load() }
    }

    private func load(more: Bool = false) {
        guard let api else { return }
        let from = more ? page?.nextCursor : nil
        Task {
            do {
                let next = try await api.landingLog(sessionID: sessionID, selectors, cursor: from)
                if more, let page {
                    self.page = LandingLogPage(jobId: next.jobId,
                                               entries: page.entries + next.entries,
                                               nextCursor: next.nextCursor)
                } else {
                    page = next
                }
                failed = nil
            } catch {
                failed = APIClient.failureReason(error)
            }
        }
    }
}

/// The check running now, inline: its last few printed lines, polled with the page while it runs.
private struct LandingLiveCheckView: View {
    let sessionID: String
    let selectors: LandingLogSelectors
    let title: String
    @Environment(AppModel.self) private var app
    @State private var text = ""

    private var api: APIClient? {
        guard let baseURL = app.baseURL else { return nil }
        return APIClient(baseURL: baseURL, tokenStore: app.tokenStore)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // The board's own header row over the output block: `Merge check · live 1m 53s`.
            Text(title).font(.orbitMeta).foregroundStyle(.secondary)
            if !text.isEmpty {
                LandingDarkOutput(text: text)
            }
        }
        .task {
            while !Task.isCancelled {
                if let api, let page = try? await api.landingLog(sessionID: sessionID, selectors) {
                    text = tail(page.entries.map(\.text).joined())
                }
                do { try await Task.sleep(nanoseconds: 4_000_000_000) } catch { return }
            }
        }
    }

    private func tail(_ text: String) -> String {
        text.replacingOccurrences(of: "\r", with: "")
            .split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            .suffix(6)
            .joined(separator: "\n")
    }
}

/// One block of check output, as the board draws it (mockups 05 a, b, g, j): a dark panel of the
/// runner's own lines in monospace, under the `<check> · live <elapsed>` row that names it.
private struct LandingDarkOutput: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.orbitMono)
            .foregroundStyle(Color(white: 0.92))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(Color(white: 0.12), in: RoundedRectangle(cornerRadius: 8))
    }
}

/// A finished check's tail, inline, for the check that failed: the failure's own last lines, read
/// once from the same landing log `Log ›` opens (mockup 05 g).
private struct LandingInlineOutput: View {
    let sessionID: String
    let selectors: LandingLogSelectors
    @Environment(AppModel.self) private var app
    @State private var lines: [String] = []

    private var api: APIClient? {
        guard let baseURL = app.baseURL else { return nil }
        return APIClient(baseURL: baseURL, tokenStore: app.tokenStore)
    }

    var body: some View {
        Group {
            if !lines.isEmpty {
                LandingDarkOutput(text: lines.joined(separator: "\n"))
            }
        }
        .task {
            guard let api, let page = try? await api.landingLog(sessionID: sessionID,
                                                                selectors) else { return }
            lines = page.entries.map(\.text).joined()
                .replacingOccurrences(of: "\r", with: "")
                .split(separator: "\n", omittingEmptySubsequences: false)
                .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
                .suffix(6)
                .map(String.init)
        }
    }
}

/// The landing page's own `PromotionReviewSource`: the candidate the round is about, read on the
/// page's cadence, with the two decidable doors going through the same API the review sheet uses.
@MainActor
@Observable
final class LandingPromotionSource: PromotionReviewSource {
    private let api: APIClient
    private let projectID: String
    var promotion: ProjectPromotionView?
    var landings: [ProjectLandTask] = []
    var openItems: ProjectOpenItemsView?
    var criteriaMet: (met: Int, total: Int)? { nil }

    init(api: APIClient, projectID: String) {
        self.api = api
        self.projectID = projectID
    }

    var promotionOpenItems: ProjectOpenItemsView? { openItems }
    var promotionLandings: [ProjectLandTask] { landings }

    func promotionStanding(_ promotionID: String) -> ProjectPromotionView? {
        promotion?.promotionId == promotionID ? promotion : nil
    }

    func refreshPromotion() async {
        promotion = try? await api.currentPromotion(projectID: projectID)
        if let integration = try? await api.projectIntegration(projectID) {
            landings = integration.landTasks
        }
        openItems = try? await api.projectOpenItems(projectID: projectID)
    }

    func confirmMergeToMain(_ view: ProjectPromotionView) async -> String? {
        do {
            promotion = try await api.confirmPromotion(projectID: projectID,
                                                       promotionID: view.promotionId,
                                                       sourceSha: view.sourceSha)
            return nil
        } catch { return APIClient.failureReason(error) }
    }

    func declineMergeToMain(_ view: ProjectPromotionView) async -> String? {
        do {
            promotion = try await api.declinePromotion(projectID: projectID,
                                                       promotionID: view.promotionId)
            return nil
        } catch { return APIClient.failureReason(error) }
    }

    func cancelMergeToMain(_ view: ProjectPromotionView) async -> String? {
        do {
            promotion = try await api.cancelPromotion(projectID: projectID,
                                                      promotionID: view.promotionId)
            return nil
        } catch { return APIClient.failureReason(error) }
    }
}
