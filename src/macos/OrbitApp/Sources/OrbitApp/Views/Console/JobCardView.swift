import SwiftUI
import OrbitKit

// A `bg_run` job as one card from start to end (the owner's job-card board, choices A1 B1 C1 D1 E1 F1,
// rulings R1-R4 of 2026-11-21), in OrbitKit's `BgJobCard` words. It stands where the call was: the
// terminal icon, the job's description, its kind and how long it has run; folded, a spinner and the
// newest output line while it runs, then how it ended and its last lines. Opened: the command, where it
// ran, the last 40 lines and every time it woke the agent. The turns those wakes opened draw nothing
// (`BgJobCard.drawsNothing`): the card says it. Web parity: `JobCard.tsx`.

/// Where a Job card asks about its job: the session it runs in. Absent where no console sets it.
struct JobCardHost {
    /// The session's bg_run jobs as the Background list holds them, by job id.
    let procs: [String: BackgroundProc]
    /// The wake turns loaded in this transcript, by job id, oldest first (`BgJobCard.wakes`).
    let wakes: [String: [BgJobCard.WakeSeen]]
    /// The wake turns still on the queue, by job id: each one's `Don't send` (board E1).
    let dontSend: [String: @MainActor () -> Void]
    /// The session is live: a job nothing says ended is still running.
    let live: Bool
    /// Where the session runs, named on an opened card's metadata line.
    let place: String?
    /// GET …/background/jobs/:jobId/tail (R2).
    let tail: @MainActor (String) async throws -> BackgroundJobTail
    /// POST …/background/jobs/:jobId/stop (R3).
    let stop: @MainActor (String) async throws -> Void
}

private struct JobCardHostKey: EnvironmentKey {
    static let defaultValue: JobCardHost? = nil
}

extension EnvironmentValues {
    var jobCardHost: JobCardHost? {
        get { self[JobCardHostKey.self] }
        set { self[JobCardHostKey.self] = newValue }
    }
}

struct JobCardView: View {
    let card: ToolCard
    @Environment(\.jobCardHost) private var host
    @Environment(\.scenePhase) private var scenePhase
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var hSize
    #endif
    @State private var open: Bool
    @State private var allLines = false
    @State private var asking = false
    @State private var stopFailed: String?
    /// The tail read's newest answer (R2), and whether the output proved unreadable (404/409).
    @State private var tail: BackgroundJobTail?
    @State private var gone = false
    @State private var onScreen = false
    @State private var polled = false

    /// `startsOpen` draws it opened from the first frame (a picture of the opened card); the transcript
    /// always starts it folded.
    init(card: ToolCard, startsOpen: Bool = false) {
        self.card = card
        _open = State(initialValue: startsOpen)
    }

    private var jobId: String? { BgJobCard.receipt(card.result)?.jobId }
    private var proc: BackgroundProc? { jobId.flatMap { host?.procs[$0] } }
    private var wakes: [BgJobCard.WakeSeen] { jobId.flatMap { host?.wakes[$0] } ?? [] }
    private var dontSend: (@MainActor () -> Void)? { jobId.flatMap { host?.dontSend[$0] } }

    /// R4: at iPhone width the kind chip and elapsed time move to a second, grey line.
    private var phone: Bool {
        #if os(iOS)
        return hSize == .compact
        #else
        return false
        #endif
    }

    private func look(now: Date) -> BgJobCard.Look {
        BgJobCard.look(input: card.input, jobId: jobId, startedAt: BgJobCard.receipt(card.result)?.startedAt,
                       proc: proc, wakes: wakes, tail: tail, live: host?.live ?? false,
                       canStop: host != nil, where: host?.place, now: now)
    }

    var body: some View {
        // A first guess without the tail read, so the read itself knows whether the job runs.
        let known = look(now: Date())
        let running = known.phase == .running
        TimelineView(.periodic(from: .now, by: running ? 1 : 3600)) { context in
            content(look(now: context.date))
        }
        .onAppear { onScreen = true }
        .onDisappear { onScreen = false }
        .task(id: TailKey(jobId: jobId, polls: BgJobCard.pollsTail(
            running: running, onScreen: onScreen, appActive: scenePhase == .active, gone: gone,
            canRead: host != nil && jobId != nil))) {
            await pollTail(running: running)
        }
        // The job's end arrived from elsewhere (its report, its wake): one more read for the lines it ended on.
        .onChange(of: running) { was, now in
            guard was, !now, polled, !gone, tail?.status == "running", let jobId, let host else { return }
            Task { if let last = try? await host.tail(jobId) { tail = last } }
        }
        .orbitConfirmation(BgJobCard.stopConfirm, isPresented: $asking) {
            Button(BgJobCard.stop, role: .destructive) { stopJob() }
            Button("Cancel", role: .cancel) {}
        }
    }

    private struct TailKey: Hashable {
        let jobId: String?
        let polls: Bool
    }

    /// At the route's pace while it polls: at once, then 5 s after each answer, one request at a time;
    /// 30 s after the runner was away; never again once the output proved unreadable, and no line or
    /// error then — the spinner stays.
    private func pollTail(running: Bool) async {
        guard running, let jobId, let host else { return }
        while !Task.isCancelled {
            var answer: BackgroundJobTail?
            var status: Int?
            do {
                answer = try await host.tail(jobId)
            } catch APIError.http(let code, _) {
                status = code
            } catch {}
            if Task.isCancelled { return }
            if let answer { tail = answer; polled = true }
            switch BgJobCard.tailNext(answer: answer, httpStatus: status) {
            case .after(let seconds): try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            case .ended: return
            case .gone: gone = true; return
            }
        }
    }

    private func stopJob() {
        guard let jobId, let host else { return }
        Task {
            do { try await host.stop(jobId); stopFailed = nil } catch { stopFailed = APIClient.failureReason(error) }
        }
    }

    // MARK: the card

    private func content(_ look: BgJobCard.Look) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            row(look)
            if phone {
                HStack(spacing: 6) { kindChip(look); elapsedText(look) }
                    .padding(.leading, 42)
            }
            if open {
                detail(look)
            } else {
                foldedBody(look).padding(.leading, 42)
            }
            if let stopFailed {
                Text(stopFailed).font(.orbitMeta).foregroundStyle(.red).padding(.leading, 42)
            }
            // Its wake still on the queue: the agent has not read it, and the reader can keep it back (E1).
            if let dontSend {
                SubagentWakeQueuedLine(onDontSend: dontSend).padding(.leading, 42)
            }
        }
        .padding(.leading, 11)
        .padding(.trailing, 10)
        .padding(.vertical, 6)
        .background(open ? Color.gray.opacity(0.06) : Color.clear)
        .overlay(alignment: .leading) { Rectangle().fill(ToolTone.exec.color).frame(width: 3) }
        .clipShape(RoundedRectangle(cornerRadius: open ? 8 : 0))
        .overlay {
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color.primary.opacity(0.12), lineWidth: 1)
                .opacity(open ? 1 : 0)
        }
        .animation(nil, value: open)
        // The folded card's Stop: its long-press (iOS) or right-click (macOS) menu.
        .contextMenu {
            if look.stoppable {
                Button(BgJobCard.stop, systemImage: "stop.circle") { asking = true }
            }
        }
        .accessibilityIdentifier("job-card")
    }

    /// `>_ Wait for CI JavaScript job on 4c8f5a8a1b  watch  12m 40s  exit 1 ✕` — and never the word "Job" (R4).
    private func row(_ look: BgJobCard.Look) -> some View {
        HStack(spacing: 7) {
            Image(systemName: "chevron.right")
                .font(.orbitMeta.weight(.semibold)).foregroundStyle(.tertiary)
                .rotationEffect(.degrees(open ? 90 : 0))
            Image(systemName: "apple.terminal")
                .font(.orbitMeta).foregroundStyle(ToolTone.exec.color)
                .frame(width: 20, height: 20)
                .background(ToolTone.exec.color.opacity(0.14), in: RoundedRectangle(cornerRadius: 5))
            Text(look.title)
                .font(.orbitLabel.weight(.semibold))
                .foregroundStyle(.primary)
                .lineLimit(1).truncationMode(.tail)
            if !phone {
                kindChip(look)
                elapsedText(look)
            }
            if let quiet = look.quietChip {
                chip(quiet, fg: .orange, bg: Color.orange.opacity(0.14))
            }
            if let end = look.endChip {
                look.phase == .killed
                    ? chip(end, fg: .secondary, bg: Color.gray.opacity(0.14))
                    : chip(end, fg: .red, bg: Color.red.opacity(0.1))
            }
            Spacer(minLength: 0)
            mark(look.phase)
        }
        .contentShape(Rectangle())
        .onTapGesture { open.toggle() }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }

    private func kindChip(_ look: BgJobCard.Look) -> some View {
        chip(look.kind, fg: ToolTone.exec.color, bg: ToolTone.exec.color.opacity(0.12))
    }

    @ViewBuilder private func elapsedText(_ look: BgJobCard.Look) -> some View {
        if let elapsed = look.elapsed {
            chip(elapsed, fg: .secondary, bg: Color.gray.opacity(0.12))
        }
    }

    private func chip(_ text: String, fg: Color, bg: Color) -> some View {
        Text(text)
            .font(.orbitMonoFine).foregroundStyle(fg)
            .lineLimit(1).fixedSize()
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(bg, in: RoundedRectangle(cornerRadius: 4))
    }

    /// A spinner while it runs, then how it ended.
    @ViewBuilder private func mark(_ phase: BgJobCard.Phase) -> some View {
        switch phase {
        case .running: ProgressView().controlSize(.small).accessibilityLabel("running")
        case .done: Image(systemName: "checkmark.circle.fill").font(.orbitLabel).foregroundStyle(.green)
        case .failed: Image(systemName: "xmark.circle.fill").font(.orbitLabel).foregroundStyle(.red)
        case .killed: Image(systemName: "stop.circle.fill").font(.orbitLabel).foregroundStyle(.gray)
        case .unknown: Image(systemName: "minus.circle").font(.orbitLabel).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private func foldedBody(_ look: BgJobCard.Look) -> some View {
        switch look.folded {
        case .none:
            EmptyView()
        case .live(let line):
            Text(line)
                .font(.orbitMonoFine).foregroundStyle(.secondary)
                .lineLimit(1).truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("job-live-line")
        case .killedBy(let line):
            // The card's second-level size and grey (web `.chat-job-ending`), as the lines under the other ends.
            Text(line)
                .font(.orbitLabel).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .ending(let lines, let failed):
            VStack(alignment: .leading, spacing: 2) {
                Text(lines.joined(separator: "\n"))
                    .font(.orbitMonoFine)
                    .foregroundStyle(failed ? AnyShapeStyle(Color.red) : AnyShapeStyle(.secondary))
                    .lineLimit(2).truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button(BgJobCard.showFullOutput) { open = true }
                    .buttonStyle(.plain).font(.orbitMeta).foregroundStyle(.tint)
            }
        }
    }

    // MARK: opened

    private func detail(_ look: BgJobCard.Look) -> some View {
        let shown = allLines ? look.lines : Array(look.lines.suffix(BgJobCard.openLines))
        return VStack(alignment: .leading, spacing: 8) {
            if !look.command.isEmpty { ToolBodyView(kind: .command(look.command)) }
            Text(look.meta)
                .font(.orbitMeta).foregroundStyle(.tertiary)
                .textSelection(.enabled)
            if let killedBy = look.killedBy {
                Text(killedBy).font(.orbitLabel).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !shown.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text(shown.joined(separator: "\n"))
                        .font(.orbitMono)
                        // Output's own colour whatever the end: only the folded card's last lines turn red (web
                        // `.chat-job-output .chat-pre`).
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if shown.count < look.lines.count {
                        Button(BgJobCard.showAll(look.lines.count)) { allLines = true }
                            .buttonStyle(.plain).font(.orbitMeta).foregroundStyle(.tint)
                    }
                }
                .padding(8)
                .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
            }
            if look.stoppable {
                Button(BgJobCard.stop) { asking = true }
                    .buttonStyle(.plain).font(.orbitLabel).foregroundStyle(.tint)
                    .accessibilityIdentifier("job-stop")
            }
            if !wakes.isEmpty { wakeBlock }
        }
        .padding(.leading, 31)
    }

    /// `Woke the agent 1 time`, one row per wake with what the agent read behind it.
    private var wakeBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(BgJobCard.wokeHead(wakes.count)).font(.orbitSubtext).foregroundStyle(.secondary)
            ForEach(Array(wakes.enumerated()), id: \.offset) { _, wake in
                JobWakeRow(wake: wake)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 6))
    }
}

/// One time the job woke its agent: when, what it said, when the agent read it, and what it read.
private struct JobWakeRow: View {
    let wake: BgJobCard.WakeSeen
    @State private var showingRaw = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(BgJobCard.wakeLine(wake)).font(.orbitSubtext).foregroundStyle(.primary.opacity(0.8))
            DisclosureGroup(isExpanded: $showingRaw) {
                Text(wake.text)
                    .font(.orbitMonoFine).foregroundStyle(.tertiary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 2)
            } label: {
                Text(BgJobCard.rawSummary).font(.orbitMeta).foregroundStyle(.secondary)
            }
        }
    }
}
