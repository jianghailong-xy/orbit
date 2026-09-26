import SwiftUI
import OrbitKit

/// What this session is waiting on, in the console above the composer: the live watches that will
/// resume it. This is what a monitoring session shows instead of the "Background process running" a
/// polling shell used to leave behind; the Background processes tray below keeps the real shells and
/// dev servers (contract §9.2). Drawn as the band's other cards are (`BackgroundTrayView`,
/// `CreatedTasksCard`): one line, and opened, a list.
///
/// The line names a lone target with where it stands, in its own list's pill, or states what several
/// need beside Tasks created here's sentence over where they stand. Opened, each watch is one
/// sentence — what it waits for, and the deadline that resumes this session anyway — over the targets
/// it waits on, each opening its page; a lone target is on the line already, so the foot leads to it
/// instead. Read-only: a wait is changed by talking to the agent, and Pause/Stop live on the Following
/// page. The browser's `SessionWatchStrip` says the same words (`WatchStripCopyParityTests`,
/// `src/shared/src/watch-strip.fixture.json`).
struct WatchingCardStack: View {
    @Environment(AppModel.self) private var model
    /// In a phone's conversation, the pages this card opens are pushed over it (see `opensPagesOverConsole`).
    @Environment(\.opensPagesOverConsole) private var overConsole
    let sessionID: String
    @State private var open = false

    /// Tasks created here's row: the pill column, so the titles start under each other, and its height.
    private static let statusColumn: CGFloat = 70
    private static let rowHeight: CGFloat = 31
    /// Past about five rows and a sentence the list stops and scrolls inside, so opening it never
    /// pushes the conversation off…
    private static let listCap: CGFloat = 190
    /// …and however little room the band leaves — a card opened below takes its share too — a
    /// sentence and a row stay on screen: every scrolling list in the band keeps a floor.
    private static let listFloor: CGFloat = 60

    var body: some View {
        if let store = model.watches, let summary = store.summary(for: sessionID) {
            // The deadline and "Not checked for" are relative to now: redraw between fetches so they
            // don't freeze.
            TimelineView(.periodic(from: .now, by: 30)) { context in
                VStack(spacing: 0) {
                    header(summary)
                    if open {
                        Divider().opacity(0.5)
                        list(summary, now: context.date)
                        Divider().opacity(0.5)
                        footer(summary)
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

    // MARK: - the line

    /// The one line the card always reads as; all of it opens and closes the list.
    private func header(_ summary: WatchSessionSummary) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "eye").font(.orbitMeta).foregroundStyle(.secondary)
            if let target = summary.lineTarget {
                Text(WatchProjection.stripLabel)
                    .font(.orbitLabel.weight(.semibold))
                    .lineLimit(1)
                    .layoutPriority(1)
                // Enough of the name to tell which it is; where it stands keeps its size.
                Text(name(target))
                    .font(.orbitMeta)
                    .foregroundStyle(.tint)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                TargetStanding(target: target).fixedSize()
            } else {
                Text(WatchProjection.stripLabel)
                    .font(.orbitLabel.weight(.semibold))
                    .lineLimit(1)
                    .layoutPriority(1)
                Text(summary.lineTargetWord)
                    .font(.orbitMeta)
                    .foregroundStyle(.tint)
                    .lineLimit(1)
                    .truncationMode(.tail)
                // The sentence is what the line is for: when it grows, what the wait needs yields.
                countText(summary.lineParts)
                    .font(.orbitMeta)
                    .lineLimit(1)
                    .layoutPriority(1)
                Spacer(minLength: 4)
            }
            Image(systemName: open ? "chevron.down" : "chevron.right")
                .font(.orbitMeta.weight(.semibold))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10).padding(.vertical, 3).frame(minHeight: 30)
        .contentShape(Rectangle())
        .onTapGesture { withAnimation(.easeOut(duration: 0.12)) { open.toggle() } }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityHint(open ? "Hides what this session waits on" : "Shows what this session waits on")
    }

    /// Tasks created here's sentence, secondary, with its failed part red (`CreatedTasksCard`).
    private func countText(_ parts: [SessionCreatedTasksCopy.CountPart]) -> Text {
        var text = Text(verbatim: "")
        for (index, part) in parts.enumerated() {
            if index > 0 {
                text = text + Text(SessionCreatedTasksCopy.separator).foregroundStyle(.secondary)
            }
            text = text + Text(part.text).foregroundStyle(part.failed ? Color.red : Color.secondary)
        }
        return text
    }

    // MARK: - opened

    /// Each watch's sentence and targets. Natural height where the band has room; where it hasn't, a
    /// capped list that scrolls inside and never shrinks below its floor.
    private func list(_ summary: WatchSessionSummary, now: Date) -> some View {
        ViewThatFits(in: .vertical) {
            watches(summary, now: now)
            ScrollView { watches(summary, now: now) }
                .frame(minHeight: Self.listFloor, maxHeight: Self.listCap)
        }
    }

    private func watches(_ summary: WatchSessionSummary, now: Date) -> some View {
        // The line above names a lone target already; the list names targets only when it doesn't.
        let listsTargets = summary.lineTarget == nil
        return VStack(spacing: 0) {
            ForEach(Array(summary.watches.enumerated()), id: \.element.id) { index, watch in
                if index > 0 {
                    Divider().opacity(0.5)
                }
                watchBlock(watch, now: now, listsTargets: listsTargets)
            }
        }
    }

    /// One watch: its sentence, the line it adds while nobody is checking it, and its targets.
    private func watchBlock(_ watch: Watch, now: Date, listsTargets: Bool) -> some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 3) {
                Text(WatchProjection.stripSentence(for: watch, now: now))
                    .font(.orbitMeta)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let stale = WatchProjection.stripStaleLine(for: watch, now: now) {
                    Text(stale)
                        .font(.orbitMeta)
                        .foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            if listsTargets {
                ForEach(WatchProjection.stripTargets(of: watch), id: \.targetResourceId) { target in
                    Divider().opacity(0.5)
                    targetRow(target)
                }
            }
        }
    }

    /// One target: where it stands in a column of its own, and its name. A tap opens its page.
    private func targetRow(_ target: WatchTarget) -> some View {
        Button { openTarget(target) } label: {
            HStack(spacing: 8) {
                TargetStanding(target: target)
                    .fixedSize()
                    .frame(minWidth: Self.statusColumn, alignment: .leading)
                // The primary colour — a concrete colour, so a button's tint can't bleed into it.
                Text(name(target))
                    .font(.orbitLabel)
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.right").font(.orbitMeta).foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 12)
            .frame(minHeight: Self.rowHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(route(for: target) == nil)
        .accessibilityHint("Opens it")
    }

    // MARK: - the ways out

    /// The lone target's page, when the line names one, and the Following page, where Pause and Stop
    /// live. In a phone's conversation both are pushed over it, so the back swipe returns here.
    private func footer(_ summary: WatchSessionSummary) -> some View {
        HStack(spacing: 18) {
            if let target = summary.lineTarget, route(for: target) != nil {
                footerLink(target.targetKind == .session ? WatchProjection.stripOpenSession
                                                         : WatchProjection.stripOpenTask) {
                    openTarget(target)
                }
            }
            footerLink(WatchProjection.stripManage) {
                if overConsole { model.push(.watches) } else { model.selectedSection = .following }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .frame(minHeight: 32)
    }

    /// A link in Tasks created here's `View all in Tasks ›` style.
    private func footerLink(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.orbitMeta)
                .foregroundStyle(.tint)
                .lineLimit(1)
                .padding(.vertical, 8)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func openTarget(_ target: WatchTarget) {
        guard let destination = route(for: target) else { return }
        model.openFromConversation(destination, overConsole: overConsole)
    }

    private func route(for target: WatchTarget) -> Route? {
        guard target.state != .gone else { return nil }
        switch target.targetKind {
        case .session: return .session(target.targetResourceId)
        case .task: return .task(target.targetResourceId)
        case .unknown: return nil
        }
    }

    /// A target by the name the watch carries for it, else the one this client holds, else by kind
    /// and short id: a card that can't name what it waits on leaves several watches looking alike.
    private func name(_ target: WatchTarget) -> String {
        WatchProjection.targetTitle(kind: target.targetKind,
                                    id: target.targetResourceId,
                                    name: target.targetTitle ?? targetName(target, model: model))
    }
}

/// A target's name where this model holds it — the session's title or the task's — for a server that
/// sends none with the watch.
@MainActor
private func targetName(_ target: WatchTarget, model: AppModel) -> String? {
    switch target.targetKind {
    case .session: return model.session(id: target.targetResourceId)?.title
    case .task: return model.tasks?.item(target.targetResourceId)?.title
    case .unknown: return nil
    }
}

/// Where a target itself stands, in its own list's pill: a task's `TaskStatusPill` — the word and
/// colour the task list, Tasks created here and the Orbit link card give it — and a session's glyph
/// for its run state, as its header draws it. Nothing when the watch carries no standing for it.
private struct TargetStanding: View {
    let target: WatchTarget

    var body: some View {
        if let pill = WatchProjection.stripPill(target) {
            TaskStatusPill(pill: pill)
        } else if let glyph = WatchProjection.stripGlyph(target) {
            SessionStatusPill(glyph: glyph)
        }
    }
}
