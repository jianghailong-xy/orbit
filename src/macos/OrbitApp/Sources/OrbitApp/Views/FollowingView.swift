import SwiftUI
import OrbitKit

/// Following: the watches kept on sessions and tasks — yours and your agents' — in the sections
/// `WatchProjection.sections` decides: Needs attention, Active, History. A watch is a row on the
/// control plane, not a process; shells and dev servers stay in each console's Background processes.
struct FollowingListView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        if let store = model.watches {
            // "Last evaluated" and the stale flag are relative to now: redraw between fetches.
            TimelineView(.periodic(from: .now, by: 30)) { context in
                List(selection: $model.selectedWatchID) {
                    ForEach(WatchProjection.sections(store.watches, now: context.date)) { section in
                        Section(section.group.title) {
                            ForEach(section.watches) { watch in
                                FollowingRow(watch: watch, now: context.date)
                                    .tag(watch.id)
                            }
                        }
                    }
                }
                .orbitRevealSurface()
            }
            .overlay { FollowingPlaceholder(store: store) }
            .navigationTitle("Following")
            .task { await store.load() }
        } else {
            ProgressView()
        }
    }
}

/// One watch as a Following row: what it's doing and for what, then how fresh that is — or, once
/// it ended, what its delivery did. A reason it needs attention takes that last line, in orange.
private struct FollowingRow: View {
    @Environment(AppModel.self) private var model
    let watch: Watch
    let now: Date

    var body: some View {
        let attention = WatchProjection.attention(for: watch, now: now)
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: symbol)
                .font(.orbitGlyph)
                .foregroundStyle(attention.isEmpty ? tint : Color.orange)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(WatchProjection.headline(for: watch)).lineLimit(1)
                    if WatchStateMachine.isLive(watch.state) {
                        Text(WatchProjection.progress(for: watch))
                            .font(.orbitListSubtitle)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Text(WatchProjection.condition(watch.predicate, targetCount: WatchProgress(watch.targets).live))
                    .font(.orbitListSubtitle)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                Text(attention.first?.text ?? footnote)
                    .font(.orbitMeta)
                    .foregroundStyle(attention.isEmpty ? Color.secondary : Color.orange)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 3)
    }

    /// What happens when it holds, then a live watch's freshness or deadline, or what an ended one did.
    private var footnote: String {
        let action = WatchProjection.action(for: watch, observerTitle: observerTitle)
        let tail: String?
        switch watch.state {
        case .active: tail = WatchProjection.lastEvaluated(for: watch, now: now)
        case .paused: tail = WatchProjection.deadline(for: watch, now: now)
        default: tail = WatchProjection.deliveryStatus(for: watch) ?? RelativeTime.format(watch.updatedAt, now: now)
        }
        guard let tail else { return action }
        return "\(action) · \(tail)"
    }

    private var observerTitle: String? {
        guard let id = watch.observerSessionId else { return nil }
        return model.session(id: id)?.title
    }

    private var symbol: String {
        switch watch.state {
        case .active, .unknown: return "eye"
        case .paused: return "pause.circle"
        case .matched: return "checkmark.circle"
        case .expired: return "clock.badge.xmark"
        case .cancelled: return "stop.circle"
        case .revoked: return "lock.slash"
        case .unresolvable: return "questionmark.circle"
        }
    }

    private var tint: Color {
        switch watch.state {
        case .active: return .accentColor
        case .matched: return .green
        default: return .secondary
        }
    }
}

/// What stands where the rows would be. Only a fetch that succeeded may say there's nothing to show.
private struct FollowingPlaceholder: View {
    let store: WatchesModel

    var body: some View {
        if store.unsupported {
            ContentUnavailableView("Watches aren't available", systemImage: "eye.slash",
                                   description: Text("This server doesn't serve watches yet."))
        } else {
            switch LoadFailureLogic.presentation(store.loadState, isEmpty: store.watches.isEmpty) {
            case .loading:
                ProgressView()
            case .failed:
                ContentUnavailableView {
                    Label("Watches couldn't be loaded", systemImage: "eye")
                } description: {
                    Text("Check the connection, then try again.")
                } actions: {
                    Button("Retry") { Task { await store.load() } }
                }
            case .empty:
                ContentUnavailableView("Not following anything", systemImage: "eye",
                                       description: Text("When you or an agent watches sessions or tasks, the watch shows up here: what it waits for, how far along it is, and what happens when it holds."))
            case .content:
                EmptyView()
            }
        }
    }
}
