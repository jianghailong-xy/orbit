import SwiftUI
import OrbitKit

/// A turn the control plane opened because a wakeup came due (OrbitKit's `BackgroundWakeText.parse`),
/// drawn as one event line in the agent's stream — the grammar the transcript's "Interrupted" line
/// already uses — rather than as a card on the reader's side of the conversation.
///
/// The line says a wakeup came due, why and when; tapping it opens the rest — a row per wakeup, who
/// queued the turn, and what the agent actually read. It is no anchor for the sticky bar
/// (`StickySummary.isAnchor`), which keeps naming the question.
///
/// A background job's end, new output or stall draws no line here any more (board C1): the job is one
/// card from start to end (`JobCardView`), and only a wakeup that came due beside it is drawn
/// (`BgJobCard.wakeupsOnly`).
///
/// The same line draws a wake still waiting behind the running turn, dashed, with the queue's own
/// line under it, so it keeps its shape when a runner takes it. Web parity: `BackgroundWakeCard.tsx`.
/// The words are OrbitKit's `BackgroundWakeCard`, which `BackgroundWakeCopyParityTests` holds to the
/// web's. A wake written into a running turn (a steer) says how far it got (`steerState`) — and, while
/// it waits for the runner, offers no Cancel.
struct BackgroundWakeCardView: View {
    let wake: BackgroundWake
    var ts: String?
    var undelivered: Bool = false
    /// Cancels a wake that is still queued. Nil once a runner has taken it, on every settled line,
    /// and on a steer, which is not the queue's to cancel. Unlike a watch's wake this is an ordinary
    /// cancel — nothing ever re-sends it — so it asks nothing first and uses the words a queued
    /// message already uses.
    var onCancelQueued: (() -> Void)?
    /// How far a wake written into the running turn has got (`BackgroundWakeCard.steerState`), said
    /// under the line — in place of a queued wake's Cancel while it still waits for the runner.
    var steerState: String?
    /// Still waiting for a runner rather than an event yet: drawn dashed, the browser's
    /// `.bgwake.is-queued`.
    var queued: Bool = false

    @State private var open = false
    @State private var showingRaw = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            line
            if open { fold }
            if undelivered {
                // Amber, not red: the turn was queued and the session simply hasn't confirmed it.
                Text(BackgroundWakeCard.undelivered)
                    .font(.orbitMeta).foregroundStyle(.orange)
                    .padding(.leading, 20)
            }
            if let steerState {
                // A steer's progress, in the words and tone its bubble uses (`UserBubbleView`).
                Text(steerState)
                    .font(.orbitMeta).foregroundStyle(.secondary)
                    .padding(.leading, 20)
            }
            if let onCancelQueued { queuedFoot(onCancelQueued).padding(.leading, 20) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Everything stays on one line when it fits; on a phone or beside a long description, the name
    /// and closing metadata each take a line under the title so the details label cannot crowd it.
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
                }
                if let name = BackgroundWakeCard.lineName(wake) {
                    nameText(name).lineLimit(1).truncationMode(.tail).padding(.leading, 20)
                }
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    closing
                }
                .padding(.leading, 20)
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

    /// The clock: nothing has come out of a wakeup, it only came due.
    private var mark: some View {
        Image(systemName: "clock").foregroundStyle(Color.secondary)
    }

    private var title: some View {
        Text(BackgroundWakeCard.title(wake))
            .foregroundStyle(Color.secondary)
            .lineLimit(1)
            .fixedSize()
    }

    private func nameText(_ name: String) -> some View {
        Text(name).font(.orbitLabel).foregroundStyle(Color.primary.opacity(0.75))
    }

    /// When, and the chevron that opens the rest — never squeezed.
    @ViewBuilder
    private var closing: some View {
        if let ts, let when = RelativeTime.format(ts) {
            Text(when).font(.orbitMeta).foregroundStyle(Color.secondary).fixedSize()
        }
        Text("Details")
            .font(.orbitMeta).foregroundStyle(Color.secondary).fixedSize()
        // One glyph turned, never two swapped (`ToolCardView`'s chevron, for the same reason).
        Image(systemName: "chevron.right")
            .font(.orbitMeta.weight(.semibold)).foregroundStyle(.tertiary)
            .rotationEffect(.degrees(open ? 90 : 0))
    }

    /// What the line carried, opened: hung under its title off a rule, like a tool card's detail.
    private var fold: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(wake.wakeups.enumerated()), id: \.offset) { _, wakeup in
                wakeupRow(wakeup)
            }
            Text(BackgroundWakeCard.meta)
                .font(.orbitMeta).foregroundStyle(Color.secondary)
            raw
        }
        .padding(.leading, 10)
        .overlay(alignment: .leading) {
            Rectangle().fill(Color.secondary.opacity(0.25)).frame(width: 2)
        }
        .padding(.leading, 20)
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
            QueuedWord()
            Button("Cancel") { cancel() }
                .buttonStyle(.plain)
                .font(.orbitMeta)
                .foregroundStyle(.tint)
                .contentShape(Rectangle())
        }
    }
}

/// A scheduled wakeup's prompt, retaining the logical-line fold shared with web's `Pre`.
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
