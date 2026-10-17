import SwiftUI
import OrbitKit

/// The session's Tasks card, above the composer between the Background processes tray and the branch
/// bar: the tasks this session's agent created and the tasks its live watches wait on, one row each —
/// the session's two kinds of output, tasks and code, side by side
/// (`docs/mocks/session-tasks-watch-merge-ios.png`; the web draws the same card).
///
/// Collapsed it is one line in the tray's language — `Tasks`, an eye with how many rows the session
/// waits on, and the sentence `2 running · 1 failed · 4/8 done`, its failed part red — or, with one
/// task, that task's name and pill. Opened, it lists the rows: the watched ones first, each with an
/// eye (orange while its watch goes unchecked), then the rest exactly as the server sent them
/// (already in order, a replaced task already drawn as the one that took it over), each opening its
/// task. A watched task created elsewhere says so where its age would be. There is no card while the
/// session has created and waits on nothing. The rows are OrbitKit's `SessionTaskCard` and the words
/// `SessionCreatedTasksCopy`, both proved against the browser's in
/// `SessionCreatedTasksCopyParityTests`.
struct CreatedTasksCard: View {
    @Environment(AppModel.self) private var app
    @Environment(\.opensPagesOverConsole) private var overConsole
    let console: ConsoleModel
    @State private var open = false

    /// The pill column, so the titles start under each other; a longer word widens its own row.
    private static let statusColumn: CGFloat = 70
    /// The eye's column, empty where nothing waits, so the titles still start under each other.
    private static let eyeColumn: CGFloat = 14
    /// Up to five rows show whole. Past that the list stops at about five and a half — the half row
    /// is what says it scrolls — and scrolls inside, so opening it never pushes the conversation off.
    private static let rowsShownWhole = 5
    private static let listCap: CGFloat = 170
    /// However little room the band leaves — a Watching strip opened above takes it first — an open
    /// list keeps two rows on screen (its one, if that is all it has), so it never draws as a header
    /// with no rows below it.
    private static let rowHeight: CGFloat = 31
    private static func listFloor(_ items: [SessionTaskCard.Row]) -> CGFloat {
        CGFloat(min(items.count, 2)) * rowHeight
    }

    var body: some View {
        // The unchecked reminder is relative to now: redraw between fetches so it doesn't freeze.
        TimelineView(.periodic(from: .now, by: 30)) { context in
            let summary = app.watches?.summary(for: console.sessionID)
            let watched = summary?.watchedTasks(now: context.date) { app.tasks?.item($0.targetResourceId)?.title }
            if let card = SessionTaskCard(created: console.createdTasks.snapshot, watched: watched ?? []) {
                VStack(spacing: 0) {
                    header(card)
                    if open {
                        Divider().opacity(0.5)
                        list(card, staleLines: summary?.taskStaleLines(now: context.date) ?? [])
                    }
                }
                // The tray's floating-card language, so the stack above the composer reads as one
                // system (`BackgroundTrayView`).
                .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.primary.opacity(0.1)))
                .padding(.bottom, .composerBandGap)
            }
        }
        // Opened from elsewhere in the conversation: the start card's "View tasks ›" names
        // the plan's tasks, and this is the list they are in (web's `openRequest`).
        .onChange(of: console.createdTasksOpenTick) { _, _ in open = true }
    }

    // MARK: - the line

    /// The one line the card always reads as; all of it opens and closes the list.
    private func header(_ card: SessionTaskCard) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark.square").font(.orbitMeta).foregroundStyle(.secondary)
            if let row = card.single {
                Text(SessionCreatedTasksCopy.title)
                    .font(.orbitLabel.weight(.semibold))
                    .lineLimit(1)
                    .layoutPriority(1)
                // Enough of the name to tell which task it is; the pill keeps its size.
                Text(row.title)
                    .font(.orbitMeta)
                    .foregroundStyle(.tint)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if row.watched { eye(stale: row.stale) }
                if let pill = row.pill { TaskStatusPill(pill: pill).fixedSize() }
            } else {
                Text(SessionCreatedTasksCopy.title)
                    .font(.orbitLabel.weight(.semibold))
                    .lineLimit(1)
                if card.watching > 0 {
                    // How many rows the session waits on; the eye and the number keep their size.
                    HStack(spacing: 3) {
                        Image(systemName: "eye")
                        Text("\(card.watching)")
                    }
                    .font(.orbitMeta)
                    .foregroundStyle(card.stale ? AnyShapeStyle(Color.orange) : AnyShapeStyle(.tint))
                    .fixedSize()
                }
                // The count is what the line is for: when it grows, the title yields and it doesn't.
                countText(card.countParts)
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
        .accessibilityHint(open ? "Hides the tasks" : "Shows the tasks")
    }

    /// A watched row's eye: the session waits on the task; orange while that watch goes unchecked.
    private func eye(stale: Bool) -> some View {
        Image(systemName: "eye")
            .font(.orbitMeta)
            .foregroundStyle(stale ? AnyShapeStyle(Color.orange) : AnyShapeStyle(.tint))
            .accessibilityLabel("Watching")
    }

    /// The sentence, secondary, with its failed part red.
    private func countText(_ parts: [SessionCreatedTasksCopy.CountPart]) -> Text {
        var text = Text(verbatim: "")
        for (index, part) in parts.enumerated() {
            if index > 0 {
                text = text + Text(SessionCreatedTasksCopy.separator).foregroundStyle(.secondary)
            }
            let tone: Color = part.failed ? .red : .secondary
            text = text + Text(part.text).foregroundStyle(tone)
        }
        return text
    }

    // MARK: - the rows

    @ViewBuilder
    private func list(_ card: SessionTaskCard, staleLines: [String]) -> some View {
        let items = card.rows
        if items.count > Self.rowsShownWhole {
            ScrollView { rows(items, staleLines: staleLines) }
                .frame(minHeight: Self.listFloor(items), maxHeight: Self.listCap)
        } else {
            // A short list keeps its natural height and scrolls inside only where the screen can't
            // fit it — `BackgroundTrayView`'s arrangement.
            ViewThatFits(in: .vertical) {
                rows(items, staleLines: staleLines)
                ScrollView { rows(items, staleLines: staleLines) }
                    .frame(minHeight: Self.listFloor(items), maxHeight: Self.listCap)
            }
        }
    }

    private func rows(_ items: [SessionTaskCard.Row], staleLines: [String]) -> some View {
        VStack(spacing: 0) {
            // A watch the Watching card doesn't draw says here when nobody is checking it.
            ForEach(staleLines, id: \.self) { line in
                Text(line)
                    .font(.orbitMeta)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                Divider().opacity(0.5)
            }
            ForEach(Array(items.enumerated()), id: \.element.id) { index, row in
                if index > 0 {
                    Divider().opacity(0.5)
                }
                taskRow(row)
            }
        }
    }

    /// One task: its pill and its eye in columns of their own, its title (and the task it took
    /// over), when it was created — or `elsewhere`. A tap opens the task (see `openPage`).
    private func taskRow(_ row: SessionTaskCard.Row) -> some View {
        Button { openPage(.taskDetail(taskID: row.id)) { app.route(to: .task(row.id)) } } label: {
            HStack(spacing: 6) {
                Group {
                    if let pill = row.pill { TaskStatusPill(pill: pill).fixedSize() }
                }
                .frame(minWidth: Self.statusColumn, alignment: .leading)
                Group {
                    if row.watched { eye(stale: row.stale) }
                }
                .frame(width: Self.eyeColumn)
                rowTitle(row)
                    .font(.orbitLabel)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let age = age(row) {
                    Text(age)
                        .font(.orbitMeta)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .layoutPriority(1)
                }
                Image(systemName: "chevron.right").font(.orbitMeta).foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 31)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Opens the task")
    }

    /// When the row's task was created, or `elsewhere` for a watched task this session didn't create.
    private func age(_ row: SessionTaskCard.Row) -> String? {
        guard let createdAt = row.createdAt else { return SessionCreatedTasksCopy.elsewhere }
        return RelativeTime.format(createdAt)
    }

    /// The title in the primary colour — a concrete colour, so a button's tint can't bleed into it —
    /// and, for a task that took another over, `· Replaces ‹that task›` after it.
    private func rowTitle(_ row: SessionTaskCard.Row) -> Text {
        let title = Text(row.title).foregroundStyle(Color.primary)
        guard let replaced = row.replaces else { return title }
        let suffix = SessionCreatedTasksCopy.separator + SessionCreatedTasksCopy.replaces(replaced.title)
        return title + Text(suffix).foregroundStyle(.secondary)
    }

    // MARK: - the ways out

    /// Where a press on the card goes. On a phone the page opens over this console — pushed on the
    /// console's own stack — so the back swipe comes straight back to the conversation; a move to the
    /// section the page belongs to would leave the swipe that section's list. The three-column shells
    /// keep that move: their sidebar is the way back, and the page belongs in the section's pane.
    /// The console's environment says which (`opensPagesOverConsole`); the model is told only the page.
    private func openPage(_ page: NavNode, elsewhere: () -> Void) {
        if overConsole { app.push(page) } else { elsewhere() }
    }
}
