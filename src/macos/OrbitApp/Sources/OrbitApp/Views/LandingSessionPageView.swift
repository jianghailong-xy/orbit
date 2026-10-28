import SwiftUI
import Observation
import OrbitKit

// One landing in a project's Landings window (contract §2.9 LS1/LS6/LS7, revision 28; design §3;
// mockups v4 `docs/mocks/landing-session/v4/05-landing-session-page` and
// `docs/mocks/landings-one-window`): the single landing page these pieces were drawn on is now the
// window focused on that landing (`ProjectLandingsWindowView`), and the page's body is reused there —
// its status card is a landing's card under `Now`, its timeline the record a landing opens to.
//
// Every word and every door condition is `LandingPageCopy`'s, tested on Linux; these views only lay
// them out.

/// A landing's status card (mockup 05's head over the newest attempt, board 02 d): V6's step clock,
/// budget bar and liveness while it is in hand, what stopped it and the doors to the people who
/// decide while it waits, the outcome once it settled. The window adds the task's name under the head.
struct LandingStatusCardView: View {
    let sessionID: String
    let landing: SessionLandingView?
    /// The task's name (a round's own title): the one line the window adds under the head.
    let title: String?
    let now: Date
    /// When this device last got an answer, and whether that read failed.
    let readAt: Date?
    let readFailed: Bool
    let facts: LandingFacts
    /// The candidate a round is about: on offer while it runs, its merged record once it settled.
    let promotion: ProjectPromotionView?
    /// The doors a landing that waits for a decision carries (board 02 d): the coordinator, and the
    /// task or the round's own card.
    let waitDoors: [LandingMenuAction]
    let acting: Bool
    let act: (LandingMenuAction) -> Void
    @Environment(AppModel.self) private var app

    var body: some View {
        if let landing {
            statusCard(landing)
        } else if readFailed {
            offlineCard
        } else {
            loadingCard
        }
    }

    @ViewBuilder private var titleLine: some View {
        if let title, !title.isEmpty {
            Text(title)
                .font(.orbitLabel)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder private func statusCard(_ landing: SessionLandingView) -> some View {
        let card = LandingPageCopy.attemptCard(landing, now: now, updatedAt: readAt,
                                               failed: readFailed, facts: facts)
        let outcome = LandingPageCopy.outcomeCard(landing, promotion: promotion)
        VStack(alignment: .leading, spacing: 8) {
            if let outcome {
                ProjectLandingHead(
                    title: outcome.title,
                    head: ProjectPage.LandingHead(right: outcome.right, isClock: false,
                                                  detail: outcome.detail ?? ""),
                    running: false, timedOut: false, ok: outcome.ok)
                titleLine
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
                    running: card.running, timedOut: card.timedOut, failed: card.stoppedOnFailure)
                titleLine
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
                   let onPass = PromotionCards.onPassLine(promotion) {
                    Text(onPass).font(.orbitMeta).foregroundStyle(.secondary)
                }
                if card.timedOut, let attempt = landing.currentAttempt {
                    Text(LandingPageCopy.timeoutLine(landing, attempt: attempt,
                                                     main: facts.mainBranch))
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
                titleLine
            }
            if !waitDoors.isEmpty {
                waitingDoors
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
                Button(LandingPageCopy.retry) { act(.retry) }
                    .buttonStyle(.borderedProminent).controlSize(.small).disabled(acting)
            }
            if gates.recheck {
                Button(LandingPageCopy.rerunTheCheck) { act(.rerunTheCheck) }
                    .buttonStyle(.borderedProminent).controlSize(.small).disabled(acting)
            }
            if gates.abandon {
                // Board 05's light red secondary beside the solid Retry (`cap4.red`), like the web's
                // default danger button. A bordered button takes its fill from the tint: the
                // destructive role alone reddens the word on a grey fill, so the red tint gives the
                // light red wash. A Mac push button keeps the word black unless the label itself is red.
                Button(role: .destructive) { act(.abandon) } label: {
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

    /// The offline card: the last integration snapshot, frozen, and no door — a press against a stale
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
                titleLine
                if let live = card.live {
                    Text(live).font(.orbitMeta).foregroundStyle(.secondary)
                }
            } else {
                Text(LandingPageCopy.updateUnavailable)
                    .font(.orbitLabel).foregroundStyle(.secondary)
                titleLine
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
    }

    private var loadingCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(LandingPageCopy.loadingLanding)
                    .font(.orbitLabel).foregroundStyle(.secondary)
            }
            titleLine
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
    }

    /// The doors a landing that waits for a decision carries (board 02 d): the first is the solid
    /// one, as the board draws Open Coordinator beside a plain Open Task.
    private var waitingDoors: some View {
        HStack(spacing: 8) {
            ForEach(Array(waitDoors.enumerated()), id: \.offset) { index, action in
                if index == 0 {
                    Button(Self.doorLabel(action)) { act(action) }
                        .buttonStyle(.borderedProminent).controlSize(.small)
                } else {
                    Button(Self.doorLabel(action)) { act(action) }
                        .buttonStyle(.bordered).controlSize(.small)
                }
            }
            Spacer(minLength: 0)
        }
    }

    static func doorLabel(_ action: LandingMenuAction) -> String {
        switch action {
        case .openCoordinator: return LandingPageCopy.openCoordinator
        case .openTask: return LandingPageCopy.openTask
        default: return LandingPageCopy.reviewCard
        }
    }
}

/// A landing's record (mockups 05 a/e/g/i): the server's timeline, one section per attempt, with the
/// check a finished line names opening its output. In the Landings window it is what a landing opens
/// to, under its card or its row.
struct LandingTimelineView: View {
    let sessionID: String
    let landing: SessionLandingView
    let now: Date
    @State private var openLog: LandingLogSelectors?

    var body: some View {
        timeline(landing)
    }

    @ViewBuilder private func timeline(_ landing: SessionLandingView) -> some View {
        if let timeline = landing.timeline,
           !timeline.sections.isEmpty || !timeline.facts.isEmpty {
            VStack(alignment: .leading, spacing: 14) {
                // The current round's state is the card's or the row's to say; the board's timeline
                // does not repeat it as a fact above the sections.
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
        // The read hangs on a stack that is there before it has lines: a `Group` holding only the
        // `if` is no view at all until then, so its task never ran and the tail never came. A read
        // that fails or finds nothing draws nothing here, as on web; `Log ›` still opens the log.
        VStack(alignment: .leading, spacing: 0) {
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
