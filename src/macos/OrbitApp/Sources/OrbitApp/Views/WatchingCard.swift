import SwiftUI
import OrbitKit

/// What this session is waiting on, in the console above the composer: the live watches that will
/// resume it. This is what a monitoring session shows instead of the "Background process running" a
/// polling shell used to leave behind. It sits above the Background processes tray, which keeps the
/// real shells and dev servers (contract §9.2).
///
/// Always one line first — the same language as the tray beside it — naming the single target a
/// lone watch waits on, or counting the targets several watches cover, with the soonest deadline.
/// Opened, each watch reads as read-only rows and the only action is the way to the Following page:
/// a wait is changed by talking to the agent, and Pause/Stop live on the detail page (the web's
/// `SessionWatchStrip`).
struct WatchingCardStack: View {
    @Environment(AppModel.self) private var model
    let sessionID: String
    @State private var open = false

    var body: some View {
        if let store = model.watches, let summary = store.summary(for: sessionID) {
            // "checked …" and the deadline are relative to now: redraw between fetches so they
            // don't freeze.
            TimelineView(.periodic(from: .now, by: 30)) { context in
                VStack(spacing: 0) {
                    stripRow(summary, now: context.date)
                    if open {
                        Divider().opacity(0.5)
                        ForEach(Array(summary.watches.enumerated()), id: \.element.id) { index, watch in
                            if index > 0 {
                                Divider().opacity(0.5)
                            }
                            WatchingCard(watch: watch, now: context.date, showsThen: index == 0)
                        }
                        Divider().opacity(0.5)
                        manageRow
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

    /// The one line the strip always reads as: Watching, the single target by name or the targets
    /// by count, how long the soonest deadline has left, and the caret that opens the facts.
    private func stripRow(_ summary: WatchSessionSummary, now: Date) -> some View {
        Button { open.toggle() } label: {
            HStack(spacing: 6) {
                Image(systemName: "eye").font(.orbitMeta).foregroundStyle(.secondary)
                Text(WatchProjection.stripLabel)
                    .font(.orbitLabel.weight(.semibold))
                    .lineLimit(1)
                Text(stripTarget(summary))
                    .font(.orbitMeta)
                    .foregroundStyle(.tint)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                // Where that one target stands, so the folded line answers "is it even running"
                // without being opened. Only when the line names one target: several of them have
                // no one status, and the count beside it is what the line says instead.
                if let target = summary.lineTarget, let pill = targetPill(target, model: model) {
                    TaskStatusPill(pill: pill)
                }
                if let time = summary.lineTime(now: now) {
                    Text(time)
                        .font(.orbitMeta)
                        .foregroundStyle(.secondary)
                }
                Image(systemName: open ? "chevron.down" : "chevron.right")
                    .font(.orbitMeta)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(WatchProjection.stripLabel)
    }

    /// One target by name; otherwise what the wait is for — a lone watch's own threshold, or the
    /// targets several watches cover between them. A target this client holds no name for falls
    /// back to its short id, never "Task <id>": two nameless watches used to look identical, which
    /// is what sent the account owner into the detail sheet to tell them apart.
    private func stripTarget(_ summary: WatchSessionSummary) -> String {
        if let target = summary.lineTarget {
            return WatchProjection.targetTitle(kind: target.targetKind,
                                               id: target.targetResourceId,
                                               name: targetName(target, model: model))
        }
        return summary.lineTargetWord
    }

    /// The way to the Following page, where Pause and Stop live: the strip itself is read-only.
    private var manageRow: some View {
        Button { model.selectedSection = .following } label: {
            HStack {
                Text(WatchProjection.stripManage)
                    .font(.orbitMeta)
                    .foregroundStyle(.tint)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// A target's name where this model holds it: the session's title or the task's.
@MainActor
private func targetName(_ target: WatchTarget, model: AppModel) -> String? {
    switch target.targetKind {
    case .session: return model.session(id: target.targetResourceId)?.title
    case .task: return model.tasks?.item(target.targetResourceId)?.title
    case .unknown: return nil
    }
}

/// Where a target itself stands, as the task list says it (`TaskListLogic.pill`) — one task reads
/// the same word and colour wherever it is shown, and the browser's strip says it in the same place
/// (`WatchTargetLink`'s status chip). Nothing for a task this model has not listed, and nothing for
/// a session: the strip names what it holds rather than guessing at it.
@MainActor
private func targetPill(_ target: WatchTarget, model: AppModel) -> TaskPill? {
    guard target.targetKind == .task,
          let task = model.tasks?.item(target.targetResourceId) else { return nil }
    return TaskListLogic.pill(task)
}

/// One watch's facts in the opened strip, read-only: Until / Progress / Watching / Then / Expires,
/// the browser's rows in the browser's order (`WatchStripCopyParityTests`) — the condition first, so
/// a reader with several watches open reads what each is waiting for before the names it is over.
/// Progress carries the evaluator's last look so the strip keeps one fewer row than a card does, and
/// Then — a constant for every strip watch, since all of them resume this session — is said once, on
/// the first.
private struct WatchingCard: View {
    @Environment(AppModel.self) private var model
    let watch: Watch
    let now: Date
    let showsThen: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            factRow(WatchRowLabel.until) {
                Text(WatchProjection.condition(watch.predicate, targetCount: liveTargets))
                    .font(.orbitMeta)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            factRow(WatchRowLabel.progress) {
                Text("\(WatchProjection.progress(for: watch)) · \(WatchProjection.checked(for: watch, now: now))")
                    .font(.orbitMeta)
                    .foregroundStyle(tone)
                    .lineLimit(2)
            }
            watching
            if showsThen {
                factRow(WatchRowLabel.then) {
                    Text(WatchProjection.stripThen)
                        .font(.orbitMeta)
                        .foregroundStyle(.secondary)
                }
            }
            if let expires = WatchProjection.expiresIn(for: watch, now: now) {
                factRow(WatchRowLabel.expires) {
                    Text(expires)
                        .font(.orbitMeta)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
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
                                                name: targetName(target, model: model))
        HStack(spacing: 6) {
            if let destination = route(for: target) {
                Button { model.route(to: destination) } label: {
                    Text(title).font(.orbitMeta).foregroundStyle(.tint).lineLimit(1)
                }
                .buttonStyle(.plain)
            } else {
                Text(title).font(.orbitMeta).foregroundStyle(.secondary).lineLimit(1)
            }
            // One word per target, and it is the task's own. What the evaluator last recorded about
            // it is not said per row: the Progress row above counts what has been met.
            if let pill = targetPill(target, model: model) {
                TaskStatusPill(pill: pill)
            }
        }
    }

    /// One labelled row. The label goes beside the value where it fits and above it where it
    /// doesn't — the same narrow-screen fallback the browser's card uses.
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
    private var tone: Color {
        WatchFreshness.of(watch, now: now) == .stale ? .orange : .secondary
    }

    private var liveTargets: Int { WatchProgress(watch.targets).live }

    private func route(for target: WatchTarget) -> Route? {
        guard target.state != .gone else { return nil }
        switch target.targetKind {
        case .session: return .session(target.targetResourceId)
        case .task: return .task(target.targetResourceId)
        case .unknown: return nil
        }
    }
}
