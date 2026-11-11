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
    /// The task's name (a round's own title), whole: what the window adds under the head.
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
    /// Whether what the card carries is open under its line: its caret's turn.
    var open: Bool = true
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

    /// The card's head as the chat's background-job line (owner 2026-11-11,
    /// docs/mocks/landings-chat-tools-native): how it stands, a round's word, the task, its clock.
    private func line(kind: LandingLineView.Kind, title: String, word: String? = nil,
                      status: String? = nil) -> some View {
        let name = [word, self.title].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        return LandingLineView(kind: kind, title: title, name: name.isEmpty ? nil : name, status: status,
                               time: nil, open: open)
    }

    @ViewBuilder private func statusCard(_ landing: SessionLandingView) -> some View {
        let card = LandingPageCopy.attemptCard(landing, now: now, updatedAt: readAt,
                                               failed: readFailed, facts: facts)
        let outcome = LandingPageCopy.outcomeCard(landing, promotion: promotion)
        // A round's word (Merge check, Merge to main) says which of its jobs this is.
        let word = landing.subject == "PROMOTION" && card?.rightIsClock == false ? card?.word : nil
        // No card of its own: the line, and what it carries hung under the line's mark, as the chat
        // hangs a job line's fold.
        VStack(alignment: .leading, spacing: 6) {
            if let outcome {
                line(kind: outcome.ok ? .ok : .quiet, title: outcome.title, status: outcome.right)
            } else if let card {
                line(kind: card.stoppedOnFailure || card.timedOut ? .failed : .running,
                     title: card.rightIsClock ? card.word : card.right, word: word,
                     status: card.rightIsClock ? card.right : nil)
            } else {
                line(kind: .running, title: LandingPageCopy.queued)
            }
            VStack(alignment: .leading, spacing: 8) {
                if let outcome {
                    if let detail = outcome.detail, !detail.isEmpty {
                        Text(detail).font(.orbitMeta).foregroundStyle(.secondary)
                    }
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
                    if !card.detail.isEmpty {
                        Text(card.detail).font(.orbitMeta).foregroundStyle(.tertiary)
                    }
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
                }
                if !waitDoors.isEmpty {
                    waitingDoors
                }
            }
            .padding(.leading, LandingLineView.indent)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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

    /// The offline line: the last integration snapshot, frozen, and no door — a press against a stale
    /// fact is a decision made on nothing.
    private var offlineCard: some View {
        let placeholder = LandingPageCopy.offlinePlaceholder(
            sessionId: sessionID, projectId: nil,
            inFlight: app.landingInFlightCache[sessionID])
        let card = placeholder.flatMap {
            LandingPageCopy.attemptCard($0, now: now, updatedAt: nil, failed: true)
        }
        return VStack(alignment: .leading, spacing: 6) {
            if let card {
                line(kind: .running, title: card.rightIsClock ? card.word : card.right,
                     status: card.rightIsClock ? card.right : nil)
                if let live = card.live {
                    Text(live).font(.orbitMeta).foregroundStyle(.secondary)
                        .padding(.leading, LandingLineView.indent)
                }
            } else {
                line(kind: .running, title: LandingPageCopy.updateUnavailable)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var loadingCard: some View {
        line(kind: .running, title: LandingPageCopy.loadingLanding)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The doors a landing that waits for a decision carries (board 02 d): the first is the solid
    /// one, as the board draws Open Coordinator beside a plain Open Task.
    private var waitingDoors: some View {
        VStack(alignment: .leading, spacing: 9) {
            if waitDoors.contains(.openCoordinator) {
                Label(LandingPageCopy.decisionsTheCoordinator, systemImage: "person")
                    .font(.orbitMeta).foregroundStyle(.secondary)
            }
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
        .padding(.horizontal, 12).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 10))
    }

    static func doorLabel(_ action: LandingMenuAction) -> String {
        switch action {
        case .openCoordinator: return LandingPageCopy.openCoordinator
        case .openTask: return LandingPageCopy.openTask
        default: return LandingPageCopy.reviewCard
        }
    }
}

/// A landing's record (mockups 05 a/e/g/i), drawn as the session chat draws a turn's tools (owner
/// 2026-11-11, docs/mocks/landings-chat-tools-native): one section per attempt — its heading only when
/// there are several — and each attempt's lines gathered into its steps (`LandingSteps`), each one of
/// the chat's tool rows. A step opens to its own lines, the server's sentences as they were; a check's
/// to its output too. A step that failed, or runs now, starts open. In the Landings window it is what a
/// landing opens to, under its line.
struct LandingTimelineView: View {
    let sessionID: String
    let landing: SessionLandingView
    let now: Date
    @State private var openLog: LandingLogSelectors?
    /// The steps the reader opened or folded, by section and step; the rest keep their default.
    @State private var pressed: [String: Bool] = [:]

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
        let steps = LandingSteps.steps(LandingCheckCopy.scopedEntries(section.entries, landing: landing, jobID: section.jobId), kind: section.kind)
        let live = current && landing.currentAttempt?.state == "RUNNING" && landing.currentAttempt?.timedOut == false
        VStack(alignment: .leading, spacing: 3) {
            if (landing.timeline?.sections.count ?? 0) > 1 {
                HStack(spacing: 8) {
                    Text(section.title).font(.orbitLabel.weight(.semibold))
                    if let state = LandingPageCopy.sectionState(section.state) {
                        Text(state).font(.orbitMeta).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                }
            }
            ForEach(Array(steps.enumerated()), id: \.element.key) { index, step in
                let last = index == steps.count - 1
                let status: StepStatus = LandingSteps.failed(step, kind: section.kind) ? .failed
                    : last && live ? .running
                    : last && current && landing.currentAttempt?.state == "QUEUED" ? .pending : .ok
                stepRow(step, status: status, section: section)
            }
            // A check streaming before its attempt wrote any line has no step to sit in.
            if steps.isEmpty, live, let attempt = landing.currentAttempt, attempt.check != nil {
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

    enum StepStatus { case ok, failed, running, pending }

    private static func icon(_ key: String) -> String {
        switch key {
        case "queue": return "list.bullet"
        case "claim": return "arrow.down.to.line"
        case "sync": return "arrow.triangle.branch"
        case "push": return "icloud.and.arrow.up"
        default: return "terminal"
        }
    }

    private static func tone(_ key: String) -> Color {
        switch key {
        case "queue": return .gray
        case "claim", "sync": return .blue
        case "push": return .orange
        default: return .teal
        }
    }

    /// One step as the chat's tool row (`ToolCardView`'s row): the tone bar, the caret, the icon tile,
    /// its name in the mono face, its summary line and its mark. No time on a phone's row; the lines it
    /// opens to carry theirs.
    @ViewBuilder private func stepRow(_ step: LandingStep, status: StepStatus,
                                      section: IntegrationTimelineSection) -> some View {
        let key = "\(section.jobId)|\(step.key)"
        let open = pressed[key] ?? (status == .failed || status == .running)
        let tone = Self.tone(step.key)
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 7) {
                Image(systemName: "chevron.right")
                    .font(.orbitMeta.weight(.semibold)).foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(open ? 90 : 0))
                Image(systemName: Self.icon(step.key))
                    .font(.orbitMeta).foregroundStyle(tone)
                    .frame(width: 20, height: 20)
                    .background(tone.opacity(0.14), in: RoundedRectangle(cornerRadius: 5))
                Text(step.name)
                    .font(.orbitMono.weight(.semibold)).foregroundStyle(.primary)
                    .lineLimit(1).fixedSize()
                Text(LandingCheckCopy.timelineText(step.summary))
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 4)
                switch status {
                case .failed: Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
                case .running: ProgressView().controlSize(.mini)
                case .pending: Image(systemName: "clock").foregroundStyle(.secondary)
                case .ok: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { withAnimation(.easeOut(duration: 0.15)) { pressed[key] = !open } }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            if open {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(step.entries.map { $0.index }, id: \.self) { index in
                        entryView(section.entries[index], section: section, entries: section.entries, index: index)
                    }
                    if status == .running, let attempt = landing.currentAttempt, attempt.check != nil {
                        liveCheck(attempt)
                    }
                }
                .padding(.leading, 17)
            }
        }
        .padding(.leading, 11).padding(.trailing, 8).padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(open ? Color.primary.opacity(0.04) : Color.clear)
        .overlay(alignment: .leading) { Rectangle().fill(tone).frame(width: 3) }
        .clipShape(RoundedRectangle(cornerRadius: open ? 8 : 0))
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
                Text(LandingCheckCopy.timelineText(entry))
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
        if entry.data?["skipped"]?.stringValue == "PATHS_EXEMPT" { return Mark(glyph: "≡", color: .secondary) }
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
                            Text(LandingCheckCopy.timelineText(entry))
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
                // The live tail of a running step: read every 4 s while the app can be seen
                // (docs/list-freshness-design.md §4 R3), as no event carries it.
                if app.appVisible, let api, let page = try? await api.landingLog(sessionID: sessionID, selectors) {
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

/// A landing as the session chat's background-job line (owner 2026-11-11,
/// docs/mocks/landings-chat-tools-native; `BackgroundWakeCardView`'s line), on two lines as a phone
/// has room for: the mark, how it ended (red when it failed), a short fact on a chip, when, and
/// `Details ›`; under them the task's name, up to two lines. Web: `LandingLine` in
/// ProjectLandingsWindow.tsx, one line on a wide window.
struct LandingLineView: View {
    enum Kind { case ok, merge, quiet, failed, running }

    /// Where what a line carries hangs: under its title, off its mark.
    static let indent: CGFloat = 22

    let kind: Kind
    let title: String
    let name: String?
    let status: String?
    let time: String?
    let open: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                mark.frame(width: 16)
                Text(title)
                    .foregroundStyle(kind == .failed ? Color.red : Color.secondary)
                    .lineLimit(1)
                if let status, !status.isEmpty {
                    Text(status)
                        .font(.orbitMonoFine).foregroundStyle(.secondary)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Color.gray.opacity(0.14), in: RoundedRectangle(cornerRadius: 4))
                        .lineLimit(1).fixedSize()
                }
                if let time, !time.isEmpty {
                    Text(time).font(.orbitMeta.monospacedDigit()).foregroundStyle(.secondary)
                        .lineLimit(1).fixedSize()
                }
                HStack(spacing: 3) {
                    Text(LandingStepCopy.details)
                    Image(systemName: "chevron.right")
                        .font(.orbitMeta.weight(.semibold))
                        .rotationEffect(.degrees(open ? 90 : 0))
                }
                .font(.orbitMeta).foregroundStyle(.tertiary)
                .fixedSize()
                Spacer(minLength: 0)
            }
            .font(.orbitLabel)
            if let name, !name.isEmpty {
                Text(name)
                    .font(.orbitLabel)
                    .foregroundStyle(kind == .merge ? Color.secondary : Color.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .padding(.leading, Self.indent)
            }
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    @ViewBuilder private var mark: some View {
        switch kind {
        case .ok: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .failed: Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
        case .quiet: Image(systemName: "minus.circle").foregroundStyle(.secondary)
        case .running: Image(systemName: "clock").foregroundStyle(.secondary)
        case .merge: Text("⇢").fontWeight(.semibold).foregroundStyle(Color.accentColor)
        }
    }
}
