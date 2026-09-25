import SwiftUI
import OrbitKit

/// The tasks this session's agent created, above the composer between the Background processes tray
/// and the branch bar: the session's two kinds of output, tasks and code, side by side
/// (`docs/mocks/session-created-tasks-strip-ios.png`; the web draws the same card).
///
/// Collapsed it is one line in the tray's language — `Tasks created here` and the sentence
/// `2 running · 1 failed · 4/8 done`, its failed part red — or, with one task, that task's name and
/// pill, as the Watching row names its one target. Opened, it lists the rows exactly as the server
/// sent them (already in order, a replaced task already drawn as the one that took it over), each
/// opening its task, then `View all in Tasks ›` and an `Open project ›` for each project. There is no
/// card while the session has created nothing. The words are OrbitKit's `SessionCreatedTasksCopy`,
/// proved against the browser's in `SessionCreatedTasksCopyParityTests`.
struct CreatedTasksCard: View {
    @Environment(AppModel.self) private var app
    let console: ConsoleModel
    @State private var open = false

    /// The pill column, so the titles start under each other; a longer word widens its own row.
    private static let statusColumn: CGFloat = 70
    /// Up to five rows show whole. Past that the list stops at about five and a half — the half row
    /// is what says it scrolls — and scrolls inside, so opening it never pushes the conversation off.
    private static let rowsShownWhole = 5
    private static let listCap: CGFloat = 170

    var body: some View {
        if let tasks = console.createdTasks.snapshot {
            let line = SessionCreatedTasksCopy.line(tasks)
            if line != .hidden {
                VStack(spacing: 0) {
                    header(line)
                    if open {
                        Divider().opacity(0.5)
                        list(tasks.items)
                        Divider().opacity(0.5)
                        footer(tasks.projects)
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
    }

    // MARK: - the line

    /// The one line the card always reads as; all of it opens and closes the list.
    private func header(_ line: SessionCreatedTasksCopy.Line) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark.square").font(.orbitMeta).foregroundStyle(.secondary)
            switch line {
            case .single(let row):
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
                TaskStatusPill(pill: row.pill).fixedSize()
            case .counted(let parts):
                Text(SessionCreatedTasksCopy.title)
                    .font(.orbitLabel.weight(.semibold))
                    .lineLimit(1)
                // The count is what the line is for: when it grows, the title yields and it doesn't.
                countText(parts)
                    .font(.orbitMeta)
                    .lineLimit(1)
                    .layoutPriority(1)
                Spacer(minLength: 4)
            case .hidden:
                EmptyView()
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
    private func list(_ items: [SessionCreatedTaskRow]) -> some View {
        if items.count > Self.rowsShownWhole {
            ScrollView { rows(items) }.frame(maxHeight: Self.listCap)
        } else {
            // A short list keeps its natural height and scrolls inside only where the screen can't
            // fit it — `BackgroundTrayView`'s arrangement.
            ViewThatFits(in: .vertical) {
                rows(items)
                ScrollView { rows(items) }.frame(maxHeight: Self.listCap)
            }
        }
    }

    private func rows(_ items: [SessionCreatedTaskRow]) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, row in
                if index > 0 {
                    Divider().opacity(0.5)
                }
                taskRow(row)
            }
        }
    }

    /// One task: its pill in a column of its own, its title (and the task it took over), when it was
    /// created. A tap opens the task — where an Orbit link to it goes.
    private func taskRow(_ row: SessionCreatedTaskRow) -> some View {
        Button { app.route(to: .task(row.id)) } label: {
            HStack(spacing: 8) {
                TaskStatusPill(pill: row.pill)
                    .fixedSize()
                    .frame(minWidth: Self.statusColumn, alignment: .leading)
                rowTitle(row)
                    .font(.orbitLabel)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let age = RelativeTime.format(row.createdAt) {
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

    /// The title in the primary colour — a concrete colour, so a button's tint can't bleed into it —
    /// and, for a task that took another over, `· Replaces ‹that task›` after it.
    private func rowTitle(_ row: SessionCreatedTaskRow) -> Text {
        let title = Text(row.title).foregroundStyle(Color.primary)
        guard let replaced = row.replaces else { return title }
        let suffix = SessionCreatedTasksCopy.separator + SessionCreatedTasksCopy.replaces(replaced.title)
        return title + Text(suffix).foregroundStyle(.secondary)
    }

    // MARK: - the ways out

    /// Every task the session created, on the Tasks page; and each project the rows belong to.
    private func footer(_ projects: [SessionCreatedTasks.Named]) -> some View {
        HStack(spacing: 18) {
            footerLink(SessionCreatedTasksCopy.viewAll) {
                app.showTasksCreated(inSession: console.sessionID, title: sessionTitle)
            }
            ForEach(projects) { project in
                footerLink(SessionCreatedTasksCopy.openProject) { app.openProject(project.id) }
                    .help(project.title)
                    .accessibilityLabel("Open project \(project.title)")
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .frame(minHeight: 32)
    }

    /// A link in the Watching card's `Manage in Watches ›` style.
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

    /// What the Tasks page's chip calls the session: its title, as the console's own header says it.
    private var sessionTitle: String {
        SessionHeader.title(for: app.session(id: console.sessionID), fallbackAgent: console.agentName)
    }
}
