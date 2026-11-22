import SwiftUI
import OrbitKit

// A session held by its runner's self-update (queuedReason `runner_updating`), drawn as board 5 of
// docs/mocks/runner-update-drain draws it on a phone: the queued page — why, the turns it waits for
// and how long — while the conversation is empty, and otherwise `Queued · runner updating` on the
// foot row of the reader's last message. The words are `RunnerUpdating`'s, which are the web's
// (`runnerSlots.ts`). Both offer Later (`RunnerUpdateLaterControl`) and, for a runner that declares
// `self-update-now/v1`, Update Now… (`RunnerUpdateNowControl`) for the session's runner (board 5).
// A runner that is stopping rather than updating (docs/mocks/runner-stopping) says "stopping" and
// offers neither: it has no release to postpone or install.

/// What the foot-row tag needs: which bubble carries it, the session it explains and its runner.
struct RunnerUpdatingFoot: Equatable {
    let bubbleID: String
    let session: Session
    let machine: String?
    /// The runner Later postpones; nil until the console has read it, which draws no Later.
    var runnerID: String? = nil
}

private struct RunnerUpdatingFootKey: EnvironmentKey {
    static let defaultValue: RunnerUpdatingFoot? = nil
}

private struct HeldCancelKey: EnvironmentKey {
    static let defaultValue: ((UserBubble) -> Void)? = nil
}

private struct RunnerUpdatingQueuedKey: EnvironmentKey {
    static let defaultValue: RunnerUpdatingFoot? = nil
}

extension EnvironmentValues {
    /// Set by `TranscriptView`: the held tag's Cancel under a message no runner has taken yet
    /// (`HeldCancel.offers`). Nil where there is no console to act through.
    var heldCancel: ((UserBubble) -> Void)? {
        get { self[HeldCancelKey.self] }
        set { self[HeldCancelKey.self] = newValue }
    }
    /// Set by `TranscriptView` while the session is held by its runner's update.
    var runnerUpdatingFoot: RunnerUpdatingFoot? {
        get { self[RunnerUpdatingFootKey.self] }
        set { self[RunnerUpdatingFootKey.self] = newValue }
    }
    /// Set on a queued-tail row the update holds (`RunnerUpdating.holdsQueued`): its queued line reads
    /// `Queued · runner updating` (docs/mocks/queued-card-runner-updating ②⑤).
    var runnerUpdatingQueued: RunnerUpdatingFoot? {
        get { self[RunnerUpdatingQueuedKey.self] }
        set { self[RunnerUpdatingQueuedKey.self] = newValue }
    }
}

/// The word a queued turn's line opens with — `Queued`, or the label a card names — and, where its
/// runner's update holds the turn, `Queued · runner updating` in its place, opening to why. Every
/// card's queued line draws it, so a card says what holds it exactly as a message does.
struct QueuedWord: View {
    var label: String = RunnerUpdating.queuedWord
    @Environment(\.runnerUpdatingQueued) private var held

    var body: some View {
        if let held {
            RunnerUpdatingTagView(foot: held)
        } else {
            Text(label).font(.orbitMeta).foregroundStyle(.secondary)
        }
    }
}

/// The queued page (web `RunnerUpdatingQueued`): the title, the explanation with the turns it waits
/// for as links, and the wait, which moves once a minute.
struct RunnerUpdatingQueuedView: View {
    let session: Session
    let machine: String?
    var runnerID: String? = nil
    var onOpenSession: (String) -> Void = { _ in }
    /// The turns' links, which the page opens in place rather than handing to the system.
    private static let turnScheme = "orbit-turn:"

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            VStack(spacing: 10) {
                Text(RunnerUpdating.title(session))
                    .font(.headline)
                Text(description)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .environment(\.openURL, OpenURLAction { url in
                        let link = url.absoluteString
                        // The only links in this text are the turns: nothing here leaves the app.
                        guard link.hasPrefix(Self.turnScheme) else { return .discarded }
                        onOpenSession(String(link.dropFirst(Self.turnScheme.count)))
                        return .handled
                    })
                if let waited = RunnerUpdating.waited(session, now: context.date) {
                    Text(waited).font(.footnote).foregroundStyle(.tertiary)
                }
                if let runnerID, !RunnerUpdating.stopping(session) {
                    RunnerUpdateLaterControl(runnerID: runnerID, version: session.queuedRunnerUpdate?.targetVersion,
                                             machine: machine)
                        .padding(.top, 8)
                    RunnerUpdateNowControl(runnerID: runnerID, machine: machine)
                }
            }
            .padding(.horizontal, 32)
            .frame(maxWidth: 420)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("runner-updating-queued")
    }

    /// The parts as one text, each turn a link the page opens in place.
    private var description: AttributedString {
        var out = AttributedString()
        for part in RunnerUpdating.description(session, machine: machine) {
            switch part {
            case .text(let words):
                out += AttributedString(words)
            case .turn(let id, let title):
                var link = AttributedString(title)
                link.link = URL(string: Self.turnScheme + id)
                out += link
            }
        }
        return out
    }
}

/// The foot-row tag under the message the update holds (web `RunnerUpdatingTag`): `Queued · runner
/// updating`, the reason underlined because a press opens why. A session a full runner, run or batch
/// holds is drawn the same way with `QueuedCapacity`'s words (`Queued · runner full`, web
/// `CapacityHeldTag`, docs/mocks/queued-card-runner-full), and its popover offers nothing to press.
/// A new session Keep Free holds reads `Queued · low disk space` (`QueuedDiskLow`), likewise.
struct RunnerUpdatingTagView: View {
    let foot: RunnerUpdatingFoot
    /// ` · Cancel` after the tag, under a message no runner has taken yet (`HeldCancel`): in the
    /// tint, the tag staying muted. Nil draws the tag alone.
    var onCancel: (() -> Void)? = nil
    @State private var open = false

    private var full: Bool { QueuedCapacity.holds(foot.session) }
    private var disk: Bool { QueuedDiskLow.holds(foot.session) }

    var body: some View {
        HStack(spacing: 4) {
            Text(RunnerUpdating.queuedWord)
            Text("·")
            Button { open = true } label: {
                Text(disk ? QueuedDiskLow.tag : full ? QueuedCapacity.tag(foot.session) : RunnerUpdating.tag(foot.session))
                    .underline(pattern: .dot)
            }
            .buttonStyle(.plain)
            .popover(isPresented: $open) { pop }
            if let onCancel {
                Text("·")
                Button { onCancel() } label: {
                    Text(HeldCancel.label)
                }
                .buttonStyle(.plain).foregroundStyle(.tint)
                .contentShape(Rectangle())
                .accessibilityIdentifier("held-cancel")
            }
        }
        .font(.orbitMeta)
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("runner-updating-tag")
    }

    private var pop: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            VStack(alignment: .leading, spacing: 6) {
                Text(disk ? QueuedDiskLow.title : full ? QueuedCapacity.title(foot.session) : RunnerUpdating.title(foot.session))
                    .font(.headline)
                Text(disk ? QueuedDiskLow.wait : full ? QueuedCapacity.messageText(foot.session, machine: foot.machine)
                     : RunnerUpdating.messageText(foot.session, machine: foot.machine))
                    .font(.callout)
                // Keep Free's wait counts from when the session went PENDING, as a full runner's does.
                if let waited = full || disk ? QueuedCapacity.waited(foot.session, now: context.date)
                    : RunnerUpdating.waited(foot.session, now: context.date) {
                    Text("\(waited).").font(.callout).foregroundStyle(.secondary)
                }
                if let runnerID = foot.runnerID, !full, !disk, !RunnerUpdating.stopping(foot.session) {
                    RunnerUpdateLaterControl(runnerID: runnerID,
                                             version: foot.session.queuedRunnerUpdate?.targetVersion,
                                             machine: foot.machine)
                        .padding(.top, 4)
                    RunnerUpdateNowControl(runnerID: runnerID, machine: foot.machine)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .frame(idealWidth: 300, maxWidth: 320, alignment: .leading)
            .padding(14)
        }
        .presentationCompactAdaptation(.popover)
    }
}

/// The waiting card of a session held by its GitHub workspace's clone (web `CloneWaitNotice`, board
/// docs/mocks/clone-progress-wait-card ②): what is cloning, git's percentage once the stream has relayed one, and
/// where. `compact` is the one under a transcript; the full-height one stands alone on an empty conversation. Neither
/// has a waiting animation of its own, so the spinner shows while there is no percentage.
struct CloneWaitCardView: View {
    let card: QueuedClone.Card
    let machine: String?
    var compact = false

    var body: some View {
        VStack(spacing: compact ? 4 : 10) {
            HStack(spacing: 6) {
                if card.progress == nil { ProgressView().controlSize(.small) }
                Text(card.title).font(compact ? .subheadline.weight(.semibold) : .headline)
            }
            if let progress = card.progress {
                HStack(spacing: 8) {
                    Capsule().fill(.quaternary).frame(width: 160, height: 4)
                        .overlay(alignment: .leading) {
                            Capsule().fill(Color.accentColor).frame(width: 160 * CGFloat(progress) / 100, height: 4)
                        }
                        .accessibilityElement()
                        .accessibilityLabel(card.title)
                        .accessibilityValue("\(progress)%")
                    Text(verbatim: "\(progress)%").font(.footnote).monospacedDigit().foregroundStyle(.secondary)
                }
            }
            Text(QueuedClone.sentence(machine: machine))
                .font(compact ? .footnote : .callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, compact ? 16 : 32)
        .padding(.vertical, compact ? 10 : 0)
        .frame(maxWidth: compact ? .infinity : 420)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(compact ? "clone-wait-compact" : "clone-wait")
    }
}
