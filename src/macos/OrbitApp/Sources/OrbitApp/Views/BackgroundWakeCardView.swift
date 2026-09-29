import SwiftUI
import OrbitKit

/// A turn the control plane opened because a background job had news, or because a wakeup came due
/// (OrbitKit's `BackgroundWakeText.parse`), drawn as one event line in the agent's stream — the
/// grammar the transcript's "Interrupted" line already uses — rather than as a card on the reader's
/// side of the conversation. The card it replaced sat where the person's own messages sit, in a
/// tint, so a run of wakes read as somebody cutting in and split one answer into pieces; after
/// nearly all of them the agent simply carries on with the same work.
///
/// The line says what happened, which job, how it came out and when; tapping it opens the rest — a
/// row per job or wakeup, who queued the turn, and what the agent actually read. A failure stays
/// loud: the line takes the error tone and the output's tail stays out of the fold. It is no anchor
/// for the sticky bar (`StickySummary.isAnchor`), which keeps naming the question.
///
/// The same line draws a wake still waiting behind the running turn, dashed, with the queue's own
/// line under it, so it keeps its shape when a runner takes it. Web parity: `BackgroundWakeCard.tsx`,
/// drawn from `Transcript.tsx`'s `NodeView` once delivered and from `WorkspaceView.tsx`'s queued
/// tail until then. The words are OrbitKit's `BackgroundWakeCard`, which
/// `BackgroundWakeCopyParityTests` holds to the web's.
struct BackgroundWakeCardView: View {
    let wake: BackgroundWake
    var ts: String?
    var undelivered: Bool = false
    /// Whatever else the same note carried, as its own folded entry.
    ///
    /// It rides in the fold because nobody typed this turn: delivery appends to a turn whose content
    /// is empty, so handing the leftover block back to a user bubble drew an empty bubble under the
    /// wake — a message with no words in it, signed with the reader's own name.
    var attached: (kind: String, text: String)?
    /// Cancels a wake that is still queued. Nil once a runner has taken it, and on every settled
    /// line. Unlike a watch's wake this is an ordinary cancel — nothing ever re-sends it — so it
    /// asks nothing first and uses the words a queued message already uses.
    var onCancelQueued: (() -> Void)?

    @State private var open = false
    @State private var showingRaw = false

    private var queued: Bool { onCancelQueued != nil }
    private var failed: Bool { wake.jobs.contains(where: BackgroundWakeCard.isFailed) }
    private var several: Bool { wake.jobs.count > 1 }
    /// The tails a failure leaves out of the fold: why it failed is what woke anybody.
    private var failedTails: [BackgroundWakeJob] {
        wake.jobs.filter { BackgroundWakeCard.isFailed($0) && !$0.outputTail.isEmpty }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            line
            if open { fold }
            ForEach(failedTails, id: \.id) { job in
                VStack(alignment: .leading, spacing: 2) {
                    if several {
                        Text(BackgroundWakeCard.name(job))
                            .font(.orbitMeta).foregroundStyle(Color.secondary)
                    }
                    BackgroundWakeOutput(text: job.outputTail)
                }
                .padding(.leading, 20)
            }
            if undelivered {
                // Amber, not red: the turn was queued and the session simply hasn't confirmed it.
                Text(BackgroundWakeCard.undelivered)
                    .font(.orbitMeta).foregroundStyle(.orange)
                    .padding(.leading, 20)
            }
            if let onCancelQueued { queuedFoot(onCancelQueued).padding(.leading, 20) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The one line. Everything on it when it fits; where it does not — a phone, beside a long
    /// description — the name takes a line of its own under the title (web's `max-width: 600px` rule)
    /// rather than being cut to a few letters.
    private var line: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                mark
                title
                if let name = BackgroundWakeCard.lineName(wake) { nameText(name).fixedSize() }
                closing
            }
            VStack(alignment: .leading, spacing: 1) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    mark
                    title
                    closing
                }
                if let name = BackgroundWakeCard.lineName(wake) {
                    nameText(name).lineLimit(1).truncationMode(.tail).padding(.leading, 20)
                }
            }
        }
        .font(.orbitLabel)
        .padding(.horizontal, 4).padding(.vertical, 3)
        // Dashed while it is still queued — the browser's `.bgwake.is-queued` row, so the one line
        // reads as two states rather than as two things.
        .overlay {
            if queued {
                RoundedRectangle(cornerRadius: 6)
                    .strokeBorder(Color.secondary.opacity(0.5), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { withAnimation(.easeOut(duration: 0.15)) { open.toggle() } }
    }

    /// Green where it came out clean, red where it did not, the clock where nothing has come out yet.
    @ViewBuilder
    private var mark: some View {
        if failed {
            Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
        } else if BackgroundWakeCard.isPending(wake) {
            Image(systemName: "clock").foregroundStyle(Color.secondary)
        } else {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        }
    }

    private var title: some View {
        Text(BackgroundWakeCard.title(wake))
            .foregroundStyle(failed ? Color.red : Color.secondary)
            .lineLimit(1)
            .fixedSize()
    }

    private func nameText(_ name: String) -> some View {
        let isCommand = wake.jobs.count == 1 && wake.jobs.first?.description?.isEmpty != false
        return Text(name)
            .font(isCommand ? Font.orbitMono : Font.orbitLabel)
            .foregroundStyle(Color.primary.opacity(0.75))
    }

    /// How it came out, when, and the chevron that opens the rest — never squeezed.
    @ViewBuilder
    private var closing: some View {
        if let status = BackgroundWakeCard.lineStatus(wake) {
            Text(status)
                .font(.orbitMonoFine).foregroundStyle(Color.secondary)
                .fixedSize()
                .padding(.horizontal, 5).padding(.vertical, 1)
                .background(Color.gray.opacity(0.14), in: RoundedRectangle(cornerRadius: 4))
        }
        if let ts, let when = RelativeTime.format(ts) {
            Text(when).font(.orbitMeta).foregroundStyle(Color.secondary).fixedSize()
        }
        // One glyph turned, never two swapped (`ToolCardView`'s chevron, for the same reason).
        Image(systemName: "chevron.right")
            .font(.orbitMeta.weight(.semibold)).foregroundStyle(.tertiary)
            .rotationEffect(.degrees(open ? 90 : 0))
    }

    /// What the line carried, opened: hung under its title off a rule, like a tool card's detail.
    private var fold: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(wake.jobs, id: \.id) { jobRow($0) }
            ForEach(Array(wake.wakeups.enumerated()), id: \.offset) { _, wakeup in
                wakeupRow(wakeup)
            }
            Text(BackgroundWakeCard.meta(wake))
                .font(.orbitMeta).foregroundStyle(Color.secondary)
            raw
            if let attached { AttachedNoteEntry(attached: attached) }
        }
        .padding(.leading, 10)
        .overlay(alignment: .leading) {
            Rectangle().fill(Color.secondary.opacity(0.25)).frame(width: 2)
        }
        .padding(.leading, 20)
    }

    /// One job in the fold. A lone job is the line itself, so its row here names it in full only
    /// where a description did the naming; several each name themselves, with how they ended. The
    /// command shows wherever the row above did not already spell it out.
    private func jobRow(_ job: BackgroundWakeJob) -> some View {
        let described = job.description?.isEmpty == false
        return VStack(alignment: .leading, spacing: 2) {
            if several || described {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if several { jobMark(job) }
                    Text(BackgroundWakeCard.name(job))
                        .font(.orbitLabel).foregroundStyle(Color.primary.opacity(0.75))
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if several, let status = BackgroundWakeCard.status(job) {
                        Text(status)
                            .font(.orbitMonoFine).foregroundStyle(Color.secondary)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 4))
                    }
                }
            }
            if described || !several {
                Text(job.command)
                    .font(.orbitMono).foregroundStyle(Color.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(BackgroundWakeCard.jobMeta(job))
                .font(.orbitMonoFine).foregroundStyle(Color.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// One wakeup in the fold: why it was asked for, when it was asked and came due, and whatever the
    /// agent left for this turn to read.
    private func wakeupRow(_ wakeup: ScheduledWakeup) -> some View {
        let meta = BackgroundWakeCard.wakeupMeta(wakeup)
        return VStack(alignment: .leading, spacing: 4) {
            if let reason = wakeup.reason, !reason.isEmpty {
                Text(reason).font(.orbitLabel).foregroundStyle(Color.primary.opacity(0.75))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !meta.isEmpty {
                Text(meta).font(.orbitMeta).foregroundStyle(Color.secondary)
            }
            if !wakeup.prompt.isEmpty {
                BackgroundWakeOutput(text: wakeup.prompt)
            }
        }
    }

    /// What the agent read, exactly as it read it — one more tap away and folded by default.
    private var raw: some View {
        DisclosureGroup(isExpanded: $showingRaw) {
            Text(wake.text)
                .font(.orbitMono)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 4)
        } label: {
            Text(BackgroundWakeCard.rawSummary)
                .font(.orbitMeta)
                .foregroundStyle(.secondary)
        }
    }

    /// The queue's own line under the wake's, in the words a queued message already uses: this one
    /// is withdrawn by an ordinary cancel, so unlike a watch's wake it asks nothing first.
    private func queuedFoot(_ cancel: @escaping () -> Void) -> some View {
        HStack(spacing: 8) {
            Text("Queued").font(.orbitMeta).foregroundStyle(.secondary)
            Button("Cancel") { cancel() }
                .buttonStyle(.plain)
                .font(.orbitMeta)
                .foregroundStyle(.tint)
                .contentShape(Rectangle())
        }
    }

    /// The glyph a job's row in the fold opens on: green where it exited cleanly, red where it did
    /// not, and the clock for a wake its new output opened rather than its exit.
    @ViewBuilder
    private func jobMark(_ job: BackgroundWakeJob) -> some View {
        if BackgroundWakeCard.isFailed(job) {
            Image(systemName: "xmark.circle.fill").font(.orbitLabel).foregroundStyle(.red)
        } else if job.ended {
            Image(systemName: "checkmark.circle.fill").font(.orbitLabel).foregroundStyle(.green)
        } else {
            Image(systemName: "clock").font(.orbitLabel).foregroundStyle(Color.secondary)
        }
    }
}

/// A block of the output a wake carried, folded past the few lines the line shows — web's `Pre` at
/// the line's own threshold (`BackgroundWakeCard.tailLines`), in the words a tool card's output
/// already folds behind.
private struct BackgroundWakeOutput: View {
    let text: String
    @State private var open = false

    private var lines: [String] { text.components(separatedBy: "\n") }
    private var hidden: Int { max(0, lines.count - BackgroundWakeCard.tailLines) }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(open || hidden == 0
                 ? text
                 : lines.prefix(BackgroundWakeCard.tailLines).joined(separator: "\n"))
                .font(.orbitMono)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            if hidden > 0 {
                Button(open ? "Show less" : "Show \(hidden) more \(hidden == 1 ? "line" : "lines")") {
                    open.toggle()
                }
                .buttonStyle(.plain).font(.orbitLabel).foregroundStyle(.tint)
            }
        }
    }
}
