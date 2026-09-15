import SwiftUI
import OrbitKit

/// What this session is waiting on, in the console above the composer: the live watches that will
/// resume it. This is what a monitoring session shows instead of the "Background process running" a
/// polling shell used to leave behind. It sits above the Background processes tray, which keeps the
/// real shells and dev servers (contract §9.2).
///
/// Several watches fold behind one line until it is opened — the browser's `SessionWatchStrip` —
/// because N watches used to mean N cards permanently spread across the composer. A single watch is
/// simply its card: here the strip IS the thing, and a fold over one card hides all of it.
struct WatchingCardStack: View {
    @Environment(AppModel.self) private var model
    let sessionID: String
    @State private var open = false

    var body: some View {
        if let store = model.watches, let summary = store.summary(for: sessionID) {
            // "checked …" is relative to now: redraw between fetches so it doesn't freeze.
            TimelineView(.periodic(from: .now, by: 30)) { context in
                VStack(spacing: 0) {
                    if summary.collapses {
                        stripRow(summary)
                    }
                    if open || !summary.collapses {
                        ForEach(summary.watches) { watch in
                            if summary.collapses || watch.id != summary.watches.first?.id {
                                Divider().opacity(0.5)
                            }
                            WatchingCard(store: store, watch: watch, now: context.date)
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

    /// The one line the strip reads as while it is closed: what is being waited on, the conditions
    /// behind it, and the caret that opens them.
    private func stripRow(_ summary: WatchSessionSummary) -> some View {
        Button { open.toggle() } label: {
            HStack(spacing: 6) {
                Image(systemName: "eye").font(.orbitMeta).foregroundStyle(.secondary)
                Text(summary.waitingOn)
                    .font(.orbitLabel.weight(.semibold))
                    .lineLimit(1)
                Text(summary.conditions)
                    .font(.orbitMeta)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Image(systemName: open ? "chevron.down" : "chevron.right")
                    .font(.orbitMeta)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(summary.waitingOn)
    }
}

/// One watch, answering what the browser's card answers with nothing opened: what it watches — by
/// name, so two watches are never the same card — how far along it is, how fresh that reading is,
/// what happens when the condition holds, and when it runs out. With View, Edit, Pause (or Resume)
/// and Stop, which are the moves its state actually has (`WatchStateMachine.controls`).
private struct WatchingCard: View {
    @Environment(AppModel.self) private var model
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
            watching
            ForEach(WatchProjection.facts(for: watch, observerTitle: observerTitle, now: now)) { fact in
                factRow(fact.label) {
                    Text(fact.value)
                        .font(.orbitMeta)
                        .foregroundStyle(tone(of: fact))
                        .lineLimit(2)
                }
            }
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
            Text(WatchProjection.condition(watch.predicate, targetCount: liveTargets))
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

    /// The targets themselves, named and openable. Without this every watch on the strip was the
    /// same card and the only way to tell two apart was to open the detail sheet.
    private var watching: some View {
        let shown = Array(watch.targets.prefix(WatchProjection.shownTargets))
        let hidden = watch.targets.count - shown.count
        return factRow(WatchRowLabel.watching) {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(shown.indices, id: \.self) { index in
                    targetRow(shown[index])
                }
                if hidden > 0 {
                    Text(WatchProjection.moreTargets(hidden))
                        .font(.orbitMeta)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder
    private func targetRow(_ target: WatchTarget) -> some View {
        // A one-line name, however long the title: this row sits above the composer, and a title
        // that wraps pushes the thing the person is typing into off the screen.
        let title = WatchProjection.targetTitle(kind: target.targetKind,
                                                id: target.targetResourceId,
                                                name: name(of: target))
        if let destination = route(for: target) {
            Button { model.route(to: destination) } label: {
                Text(title).font(.orbitMeta).foregroundStyle(.tint).lineLimit(1)
            }
            .buttonStyle(.plain)
        } else {
            Text(title).font(.orbitMeta).foregroundStyle(.secondary).lineLimit(1)
        }
    }

    /// One labelled row. The label goes beside the value where it fits and above it where it
    /// doesn't — the same narrow-screen fallback the headline and its controls use.
    private func factRow<Content: View>(_ label: String,
                                        @ViewBuilder _ value: () -> Content) -> some View {
        let caption = Text(label.uppercased())
            .font(.orbitMeta)
            .foregroundStyle(.secondary)
        return ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                caption.frame(width: 64, alignment: .leading)
                value()
                Spacer(minLength: 0)
            }
            VStack(alignment: .leading, spacing: 2) {
                caption
                value()
            }
        }
    }

    /// An evaluator that isn't keeping up is the one fact on the card worth colouring: everything
    /// else it says is only as fresh as that look.
    private func tone(of fact: WatchFact) -> Color {
        guard fact.label == WatchRowLabel.updated,
              WatchFreshness.of(watch, now: now) == .stale else { return .secondary }
        return .orange
    }

    private var liveTargets: Int { WatchProgress(watch.targets).live }

    private var observerTitle: String? {
        watch.observerSessionId.flatMap { model.session(id: $0)?.title }
    }

    private func name(of target: WatchTarget) -> String? {
        switch target.targetKind {
        case .session: return model.session(id: target.targetResourceId)?.title
        case .task: return model.tasks?.item(target.targetResourceId)?.title
        case .unknown: return nil
        }
    }

    private func route(for target: WatchTarget) -> Route? {
        guard target.state != .gone else { return nil }
        switch target.targetKind {
        case .session: return .session(target.targetResourceId)
        case .task: return .task(target.targetResourceId)
        case .unknown: return nil
        }
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
