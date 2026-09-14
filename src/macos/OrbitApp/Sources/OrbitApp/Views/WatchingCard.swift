import SwiftUI
import OrbitKit

/// What this session is waiting on, in the console above the composer: one card per live watch that
/// will resume it. This is what a monitoring session shows instead of the "Background process
/// running" a polling shell used to leave behind — how many targets, how far along, how fresh that
/// reading is, the condition — with View, Edit, Pause (or Resume) and Stop. It sits above the
/// Background processes tray, which keeps the real shells and dev servers (contract §9.2).
struct WatchingCardStack: View {
    @Environment(AppModel.self) private var model
    let sessionID: String

    var body: some View {
        if let store = model.watches, let summary = store.summary(for: sessionID) {
            // "Last evaluated" is relative to now: redraw between fetches so it doesn't freeze.
            TimelineView(.periodic(from: .now, by: 30)) { context in
                VStack(spacing: 0) {
                    ForEach(summary.watches) { watch in
                        WatchingCard(store: store, watch: watch, now: context.date)
                        if watch.id != summary.watches.last?.id {
                            Divider().opacity(0.5)
                        }
                    }
                }
            }
            // The tray's floating-card language, so the stack above the composer reads as one system.
            .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.primary.opacity(0.1)))
            .padding(.bottom, .composerBandGap)
        }
    }
}

private struct WatchingCard: View {
    let store: WatchesModel
    let watch: Watch
    let now: Date
    @State private var busy = false
    @State private var errorText: String?
    @State private var viewing = false
    @State private var editing = false
    @State private var confirmingStop = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Controls beside the headline when they fit (macOS, iPad), under it when they don't (iPhone).
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    headline
                    Spacer(minLength: 8)
                    controls
                }
                VStack(alignment: .leading, spacing: 6) {
                    headline
                    controls
                }
            }
            Text(detail)
                .font(.orbitMeta)
                .foregroundStyle(WatchFreshness.of(watch, now: now) == .stale ? Color.orange : Color.secondary)
                .lineLimit(2)
            if let errorText {
                Text(errorText)
                    .font(.orbitMeta)
                    .foregroundStyle(.red)
                    .lineLimit(3)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .sheet(isPresented: $viewing) {
            WatchDetailSheet(store: store, watch: watch)
        }
        .sheet(isPresented: $editing) {
            WatchEditSheet(store: store, watch: watch)
        }
        .confirmationDialog("Stop watching?", isPresented: $confirmingStop, titleVisibility: .visible) {
            Button("Stop", role: .destructive) { run(.stop) }
        } message: {
            Text(WatchProjection.stopWarning(for: watch))
        }
    }

    private var headline: some View {
        HStack(spacing: 6) {
            Image(systemName: watch.state == .paused ? "pause.circle" : "eye")
                .font(.orbitMeta)
                .foregroundStyle(.secondary)
            Text(WatchProjection.headline(for: watch))
                .font(.orbitLabel.weight(.semibold))
                .lineLimit(1)
            Text(WatchProjection.progress(for: watch))
                .font(.orbitMeta)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }

    private var controls: some View {
        HStack(spacing: 6) {
            ForEach(WatchStateMachine.controls(for: watch.state), id: \.self) { control in
                Button(control.title) { tap(control) }
                    .font(.orbitLabel)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(busy && control != .view)
            }
        }
    }

    /// The condition, then how fresh the progress is — or, paused, when the watch runs out.
    private var detail: String {
        let condition = WatchProjection.condition(watch.predicate, targetCount: WatchProgress(watch.targets).live)
        let timing: String? = watch.state == .active
            ? WatchProjection.lastEvaluated(for: watch, now: now)
            : WatchProjection.deadline(for: watch, now: now)
        guard let timing else { return condition }
        return "\(condition) · \(timing)"
    }

    private func tap(_ control: WatchControl) {
        switch control {
        case .view: viewing = true
        case .edit: editing = true
        case .stop: confirmingStop = true
        case .pause, .resume: run(control)
        }
    }

    private func run(_ control: WatchControl) {
        busy = true
        errorText = nil
        Task {
            errorText = await store.perform(control, on: watch)
            busy = false
        }
    }
}
