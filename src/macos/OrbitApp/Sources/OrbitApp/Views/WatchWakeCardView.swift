import SwiftUI
import OrbitKit

/// A turn a watch queued into this session, drawn as the watch's own rather than as a message the
/// user typed: what happened in plain words, which targets moved, and a way to the watch — with the
/// text the agent actually received folded away instead of filling the screen with a UUID and a
/// block of JSON.
///
/// The same card draws a wake still waiting behind the running turn, with the queue's status line at
/// its foot, so it keeps its shape when a runner takes it. Web parity: `WatchWakeCard.tsx`, drawn
/// from `Transcript.tsx`'s `NodeView` once delivered and from `WorkspaceView.tsx`'s queued tail until
/// then. The words are OrbitKit's `WatchWakeCard`, which `WatchWakeCopyParityTests` holds to the web's.
struct WatchWakeCardView: View {
    @Environment(AppModel.self) private var model
    let wake: WatchWake
    /// Exactly what the agent received, kept for the fold — never re-derived from the card.
    let text: String
    var ts: String?
    var undelivered: Bool = false
    /// Withdraws a wake that is still queued. Nil once a runner has taken it, and on every settled
    /// card: by then there is nothing to take back.
    var onWithdraw: (() -> Void)?

    @State private var showingRaw = false
    @State private var confirmingWithdraw = false

    private var queued: Bool { onWithdraw != nil }

    var body: some View {
        let changes = WatchWakeCard.changes(wake)
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "eye").font(.orbitMeta).foregroundStyle(.secondary)
                Text(WatchWakeCard.title(wake.kind))
                    .font(.orbitLabel.weight(.semibold))
                    .lineLimit(1)
            }
            Text(WatchWakeCard.why(wake))
                .font(.orbitProse)
                .fixedSize(horizontal: false, vertical: true)
            if !changes.shown.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(changes.shown.indices, id: \.self) { index in
                        changedRow(changes.shown[index])
                    }
                    if changes.more > 0 {
                        Text(WatchProjection.moreTargets(changes.more))
                            .font(.orbitMeta).foregroundStyle(.secondary)
                    }
                }
            }
            Text(WatchWakeCard.meta(wake, ts: ts))
                .font(.orbitMeta).foregroundStyle(.secondary)
                .lineLimit(2)
            if undelivered {
                // Amber, not red: the wake was queued and the session simply hasn't confirmed it.
                Text(WatchWakeCard.undelivered)
                    .font(.orbitMeta).foregroundStyle(.orange)
            }
            Button(WatchWakeCard.viewWatch) { model.route(to: .watch(wake.watchId)) }
                .buttonStyle(.plain)
                .font(.orbitLabel)
                .foregroundStyle(.tint)
            raw
            if let onWithdraw { queuedFoot(onWithdraw) }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
        // Dashed while it is still queued — the browser's `.watch-wake.is-queued` border, so the
        // one card reads as two states rather than as two cards.
        .overlay(
            RoundedRectangle(cornerRadius: 8).strokeBorder(
                Color.primary.opacity(0.1),
                style: StrokeStyle(lineWidth: 1, dash: queued ? [4, 3] : []))
        )
    }

    /// What the agent read, exactly as it read it — one tap away and folded by default.
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

    /// One target the wake reports moved, by the name this client holds for it, opening it.
    @ViewBuilder
    private func changedRow(_ target: WatchWakeTarget) -> some View {
        let line = WatchWakeCard.changedLine(target, name: name(of: target))
        if let destination = route(for: target) {
            Button { model.route(to: destination) } label: {
                Text(line).font(.orbitMeta).foregroundStyle(.tint).lineLimit(1)
            }
            .buttonStyle(.plain)
        } else {
            Text(line).font(.orbitMeta).foregroundStyle(.secondary).lineLimit(1)
        }
    }

    /// The queue's own line at the card's foot: what the wake is waiting for, what taking it back
    /// costs, and the way to do it. It asks first because withdrawing is not Cancel — nobody typed
    /// these words, so nothing folds back into the composer and nothing sends them again.
    private func queuedFoot(_ withdraw: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Divider().opacity(0.5)
            HStack(spacing: 8) {
                Text(WatchWakeQueue.status).font(.orbitMeta).foregroundStyle(.secondary)
                Button(WatchWakeQueue.withdraw) { confirmingWithdraw = true }
                    .buttonStyle(.plain)
                    .font(.orbitMeta)
                    .foregroundStyle(.tint)
                    .contentShape(Rectangle())
            }
            Text(WatchWakeQueue.consequence)
                .font(.orbitMeta)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .confirmationDialog(WatchWakeQueue.confirmTitle, isPresented: $confirmingWithdraw,
                            titleVisibility: .visible) {
            Button(WatchWakeQueue.withdraw, role: .destructive) { withdraw() }
            Button(WatchWakeQueue.keep, role: .cancel) {}
        } message: {
            Text(WatchWakeQueue.consequence)
        }
    }

    private func name(of target: WatchWakeTarget) -> String? {
        switch target.kind {
        case .session: return model.session(id: target.id)?.title
        case .task: return model.tasks?.item(target.id)?.title
        case .unknown: return nil
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
