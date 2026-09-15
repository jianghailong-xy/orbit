import SwiftUI
import OrbitKit

/// A turn the control plane opened because a background job had news, or because a wakeup came due
/// (OrbitKit's `BackgroundWakeText.parse`), drawn as the control plane's rather than as a message
/// the user typed — which is what it looked like while the whole block sat unrecognised in a bubble
/// behind a grey strip calling it "context".
///
/// Built like the card a watch's wake gets (`WatchWakeCardView`), down to the two tones: the brand
/// tint for a job that finished, the warning tint for one that failed or was killed, as Watch
/// triggered and Watch expired take them. What the agent actually read stays one disclosure away.
///
/// The same card draws a wake still waiting behind the running turn, with the queue's own line at
/// its foot, so it keeps its shape when a runner takes it. Web parity: `BackgroundWakeCard.tsx`,
/// drawn from `Transcript.tsx`'s `NodeView` once delivered and from `WorkspaceView.tsx`'s queued
/// tail until then. The words are OrbitKit's `BackgroundWakeCard`, which
/// `BackgroundWakeCopyParityTests` holds to the web's.
struct BackgroundWakeCardView: View {
    let wake: BackgroundWake
    var ts: String?
    var undelivered: Bool = false
    /// Cancels a wake that is still queued. Nil once a runner has taken it, and on every settled
    /// card. Unlike a watch's wake this is an ordinary cancel — nothing ever re-sends it — so it
    /// asks nothing first and uses the words a queued message already uses.
    var onCancelQueued: (() -> Void)?

    @State private var showingRaw = false

    private var queued: Bool { onCancelQueued != nil }
    private var failed: Bool { wake.jobs.contains(where: BackgroundWakeCard.isFailed) }
    /// The card's one tone: brand where everything finished, warning where something did not.
    private var tone: Color { failed ? .orange : .accentColor }
    /// A wakeup's own reason is already the result line when it is all this turn carries.
    private var showsWakeupReason: Bool { !wake.jobs.isEmpty || wake.wakeups.count > 1 }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: wake.jobs.isEmpty ? "clock" : "terminal")
                    .font(.orbitMeta).foregroundStyle(tone)
                Text(BackgroundWakeCard.title(wake))
                    .font(.orbitLabel.weight(.semibold)).foregroundStyle(tone)
                    .lineLimit(1)
            }
            summary
                .font(.orbitProse)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(wake.jobs, id: \.id) { jobRow($0) }
            ForEach(Array(wake.wakeups.enumerated()), id: \.offset) { _, wakeup in
                wakeupRow(wakeup)
            }
            Text(BackgroundWakeCard.meta(wake, ts: ts))
                .font(.orbitMeta).foregroundStyle(.secondary)
                .lineLimit(2)
            if undelivered {
                // Amber, not red: the turn was queued and the session simply hasn't confirmed it.
                Text(BackgroundWakeCard.undelivered)
                    .font(.orbitMeta).foregroundStyle(.orange)
            }
            raw
            if let onCancelQueued { queuedFoot(onCancelQueued) }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tone.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
        // Dashed while it is still queued — the browser's `.bgwake.is-queued` border, so the one
        // card reads as two states rather than as two cards.
        .overlay(
            RoundedRectangle(cornerRadius: 8).strokeBorder(
                tone.opacity(0.35),
                style: StrokeStyle(lineWidth: 1, dash: queued ? [4, 3] : []))
        )
    }

    /// The one line under the title that says how it came out — the same sentence OrbitKit's
    /// `summary` spells, with the job's own name carrying the weight when there is only one of them
    /// (web's `<strong>`).
    @ViewBuilder
    private var summary: some View {
        if wake.jobs.count == 1, let only = wake.jobs.first {
            Text(BackgroundWakeCard.name(only)).bold()
                + Text(" \(BackgroundWakeCard.outcome(only)).")
        } else {
            Text(BackgroundWakeCard.summary(wake))
        }
    }

    /// One job's row, raised off the card: what it was, how it exited, the command where the
    /// description already named it, and — where it failed — the tail that says why.
    private func jobRow(_ job: BackgroundWakeJob) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                mark(job)
                Text(BackgroundWakeCard.name(job))
                    .font(.orbitProse)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let exit = BackgroundWakeCard.exitLabel(job) {
                    Text(exit)
                        .font(.orbitMonoFine).foregroundStyle(.secondary)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 4))
                }
            }
            // The command, the tail and the id line up under the description that named the row,
            // not under its glyph.
            VStack(alignment: .leading, spacing: 4) {
                if job.description?.isEmpty == false {
                    Text(job.command)
                        .font(.orbitMono).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                // Why it failed is the whole reason this turn woke anybody: the tail comes out of
                // the fold, collapsed past a few lines like any other block of output.
                if BackgroundWakeCard.isFailed(job), !job.outputTail.isEmpty {
                    BackgroundWakeOutput(text: job.outputTail)
                }
                Text(BackgroundWakeCard.jobMeta(job))
                    .font(.orbitMonoFine).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.leading, 20)
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))
    }

    /// One wakeup's row: why it was asked for, when it was asked and came due, and whatever the
    /// agent left for this turn to read.
    private func wakeupRow(_ wakeup: ScheduledWakeup) -> some View {
        let meta = BackgroundWakeCard.wakeupMeta(wakeup)
        return VStack(alignment: .leading, spacing: 4) {
            if showsWakeupReason, let reason = wakeup.reason, !reason.isEmpty {
                Text(reason).font(.orbitProse)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !meta.isEmpty {
                Text(meta).font(.orbitMeta).foregroundStyle(.secondary)
            }
            if !wakeup.prompt.isEmpty {
                BackgroundWakeOutput(text: wakeup.prompt)
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))
    }

    /// What the agent read, exactly as it read it — one tap away and folded by default.
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

    /// The queue's own line at the card's foot, in the words a queued message already uses: this
    /// one is withdrawn by an ordinary cancel, so unlike a watch's wake it asks nothing first.
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

    /// The glyph a job's row opens on: green where it exited cleanly, red where it did not, and the
    /// clock for a wake its new output opened rather than its exit.
    @ViewBuilder
    private func mark(_ job: BackgroundWakeJob) -> some View {
        if BackgroundWakeCard.isFailed(job) {
            Image(systemName: "xmark.circle.fill").font(.orbitLabel).foregroundStyle(.red)
        } else if job.ended {
            Image(systemName: "checkmark.circle.fill").font(.orbitLabel).foregroundStyle(.green)
        } else {
            Image(systemName: "clock").font(.orbitLabel).foregroundStyle(.secondary)
        }
    }
}

/// A block of the output a wake carried, folded past the few lines the card shows — web's `Pre` at
/// the card's own threshold (`BackgroundWakeCard.tailLines`), in the words a tool card's output
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
