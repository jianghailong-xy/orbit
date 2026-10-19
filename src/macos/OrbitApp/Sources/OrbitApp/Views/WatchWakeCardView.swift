import SwiftUI
import OrbitKit

/// A turn a watch queued into this session, drawn as one event line in the agent's stream — the
/// grammar a background job's news already uses (`BackgroundWakeCardView`) — rather than as a card
/// between two halves of the answer. The card sat in its own tinted box, so the reply the agent
/// carried on with read as two answers with somebody cutting in between them.
///
/// The line says what happened, which target moved, how it came out and when; tapping it opens the
/// rest — why the watch fired, each target that moved (tappable), who queued the turn, the way to
/// the watch, and what the agent actually read. A target that failed stays loud: the line takes the
/// error tone, and where several moved, the failed ones stay out of the fold. It is no anchor for
/// the sticky bar (`StickySummary.isAnchor`), which keeps naming the question.
///
/// The same line draws a wake still waiting behind the running turn, dashed, with the queue's own
/// line under it, so it keeps its shape when a runner takes it. Web parity: `WatchWakeCard.tsx`,
/// drawn from `Transcript.tsx`'s `NodeView` once delivered and from `WorkspaceView.tsx`'s queued
/// tail until then. The words are OrbitKit's `WatchWakeCard`, which `WatchWakeCopyParityTests` holds
/// to the web's.
struct WatchWakeCardView: View {
    @Environment(AppModel.self) private var model
    /// The session's Tasks card, which names the tasks this conversation filed — set by the console.
    @Environment(CreatedTasksModel.self) private var createdTasks: CreatedTasksModel?
    let wake: WatchWake
    /// Exactly what the agent received, kept for the fold — never re-derived from the line.
    let text: String
    var ts: String?
    var undelivered: Bool = false
    /// Withdraws a wake that is still queued. Nil once a runner has taken it, and on every settled
    /// line: by then there is nothing to take back.
    var onWithdraw: (() -> Void)?
    /// Still waiting for a runner rather than an event yet: drawn dashed, the browser's
    /// `.bgwake.is-queued`.
    var queued: Bool = false

    @State private var open = false
    @State private var showingRaw = false
    @State private var confirmingWithdraw = false

    private var failed: Bool { WatchWakeCard.isFailed(wake) }

    var body: some View {
        let failures = WatchWakeCard.failures(wake)
        VStack(alignment: .leading, spacing: 4) {
            line
            if open { fold }
            // The fold lists every target, these among them; closed, the failures stay in view.
            if !open && !failures.shown.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(failures.shown.indices, id: \.self) { changedRow(failures.shown[$0]) }
                    if failures.more > 0 {
                        Text(WatchProjection.moreTargets(failures.more))
                            .font(.orbitMeta).foregroundStyle(.secondary)
                    }
                }
                .padding(.leading, 20)
            }
            if undelivered {
                // Amber, not red: the wake was queued and the session simply hasn't confirmed it.
                Text(WatchWakeCard.undelivered)
                    .font(.orbitMeta).foregroundStyle(.orange)
                    .padding(.leading, 20)
            }
            if let onWithdraw { queuedFoot(onWithdraw).padding(.leading, 20) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Everything stays on one line when it fits; on a phone or beside a long name, the name and the
    /// closing metadata each take a line under the title, as the background line's do.
    private var line: some View {
        let name = lineName
        return ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                mark
                title
                if let name { nameText(name).fixedSize() }
                closing
            }
            VStack(alignment: .leading, spacing: 1) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    mark
                    title
                }
                if let name {
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

    /// The watch's own eye, or the red mark a failed background job's line opens on.
    @ViewBuilder
    private var mark: some View {
        if failed {
            Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
        } else {
            Image(systemName: "eye").foregroundStyle(Color.secondary)
        }
    }

    private var title: some View {
        Text(WatchWakeCard.title(wake.kind))
            .foregroundStyle(failed ? Color.red : Color.secondary)
            .lineLimit(1)
            .fixedSize()
    }

    private func nameText(_ name: String) -> some View {
        Text(name).foregroundStyle(Color.primary.opacity(0.75))
    }

    /// How it came out, when, and the chevron that opens the rest — never squeezed.
    @ViewBuilder
    private var closing: some View {
        if let status = WatchWakeCard.lineStatus(wake) {
            Text(status)
                .font(.orbitMonoFine).foregroundStyle(Color.secondary)
                .fixedSize()
                .padding(.horizontal, 5).padding(.vertical, 1)
                .background(Color.gray.opacity(0.14), in: RoundedRectangle(cornerRadius: 4))
        }
        if let ts, let when = RelativeTime.format(ts) {
            Text(when).font(.orbitMeta).foregroundStyle(Color.secondary).fixedSize()
        }
        Text(WatchWakeCard.details)
            .font(.orbitMeta).foregroundStyle(Color.secondary).fixedSize()
        // One glyph turned, never two swapped (`ToolCardView`'s chevron, for the same reason).
        Image(systemName: "chevron.right")
            .font(.orbitMeta.weight(.semibold)).foregroundStyle(.tertiary)
            .rotationEffect(.degrees(open ? 90 : 0))
    }

    /// What the line carried, opened: hung under its title off a rule, like a tool card's detail —
    /// in the order the card it replaced read in.
    private var fold: some View {
        let changes = WatchWakeCard.changes(wake)
        return VStack(alignment: .leading, spacing: 6) {
            Text(WatchWakeCard.why(wake))
                .font(.orbitLabel).foregroundStyle(Color.primary.opacity(0.75))
                .fixedSize(horizontal: false, vertical: true)
            if !changes.shown.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(changes.shown.indices, id: \.self) { changedRow(changes.shown[$0]) }
                    if changes.more > 0 {
                        Text(WatchProjection.moreTargets(changes.more))
                            .font(.orbitMeta).foregroundStyle(.secondary)
                    }
                }
            }
            Text(WatchWakeCard.meta(wake))
                .font(.orbitMeta).foregroundStyle(Color.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button(WatchWakeCard.viewWatch) { model.route(to: .watch(wake.watchId)) }
                .buttonStyle(.plain)
                .font(.orbitLabel)
                .foregroundStyle(.tint)
            raw
        }
        .padding(.leading, 10)
        .overlay(alignment: .leading) {
            Rectangle().fill(Color.secondary.opacity(0.25)).frame(width: 2)
        }
        .padding(.leading, 20)
    }

    /// What the agent read, exactly as it read it — one more tap away and folded by default.
    private var raw: some View {
        DisclosureGroup(isExpanded: $showingRaw) {
            Text(text)
                .font(.orbitMono)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 4)
        } label: {
            Text(WatchWakeCard.rawSummary)
                .font(.orbitMeta)
                .foregroundStyle(.secondary)
        }
    }

    /// One target the wake reports moved, by the name this client holds for it, opening it. A failed
    /// one keeps the line's error tone.
    @ViewBuilder
    private func changedRow(_ target: WatchWakeTarget) -> some View {
        let line = WatchWakeCard.changedLine(target, name: name(of: target))
        let tone = WatchWakeCard.isFailed(target) ? AnyShapeStyle(.red) : AnyShapeStyle(.tint)
        if let destination = route(for: target) {
            Button { model.route(to: destination) } label: {
                Text(line).font(.orbitMeta).foregroundStyle(tone).lineLimit(1)
            }
            .buttonStyle(.plain)
        } else {
            Text(line).font(.orbitMeta).foregroundStyle(.secondary).lineLimit(1)
        }
    }

    /// The queue's own line under the wake's: what it is waiting for, and the way to take it back. It
    /// asks first, and the asking says what that costs, because withdrawing is not Cancel — nobody
    /// typed these words, so nothing folds back into the composer and nothing sends them again.
    private func queuedFoot(_ withdraw: @escaping () -> Void) -> some View {
        HStack(spacing: 8) {
            Text(WatchWakeQueue.status).font(.orbitMeta).foregroundStyle(.secondary)
            Button(WatchWakeQueue.withdraw) { confirmingWithdraw = true }
                .buttonStyle(.plain)
                .font(.orbitMeta)
                .foregroundStyle(.tint)
                .contentShape(Rectangle())
        }
        .orbitConfirmation(WatchWakeQueue.confirmTitle, isPresented: $confirmingWithdraw) {
            Button(WatchWakeQueue.withdraw, role: .destructive) { withdraw() }
            Button(WatchWakeQueue.keep, role: .cancel) {}
        } message: {
            Text(WatchWakeQueue.consequence)
        }
    }

    /// What the line names: the one target by the name this client holds for it, or how many moved.
    private var lineName: String? {
        let only = wake.changedTargets.count == 1 ? wake.changedTargets.first : nil
        return WatchWakeCard.lineName(wake, name: only.flatMap(name(of:)))
    }

    /// A target's title, by either spelling of its id — the wake names it by its UUID, the lists this
    /// client holds by its public id. The watch's own record of its targets first, which the server
    /// fills in for every target it can read; then the session list or the tasks this client has
    /// loaded, and this conversation's own Tasks card.
    private func name(of target: WatchWakeTarget) -> String? {
        let key = PublicID.storageKey(target.id)
        if let title = model.watches?.watch(wake.watchId)?.targets
            .first(where: { PublicID.storageKey($0.targetResourceId) == key })?.targetTitle,
            !title.isEmpty {
            return title
        }
        switch target.kind {
        case .session:
            return model.session(id: target.id)?.title
                ?? model.sessions.first { PublicID.storageKey($0.id) == key }?.title
        case .task:
            return model.tasks?.items.first { PublicID.storageKey($0.id) == key }?.title
                ?? createdTasks?.snapshot?.items.first { PublicID.storageKey($0.id) == key }?.title
        case .unknown:
            return nil
        }
    }

    private func route(for target: WatchWakeTarget) -> Route? {
        switch target.kind {
        case .session: return .session(target.id)
        case .task: return .task(target.id)
        case .unknown: return nil
        }
    }
}
