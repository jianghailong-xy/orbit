import SwiftUI
import OrbitKit

/// One row of a session list, whichever kind it is. This is the shell every row goes through, so a
/// row feature — the tap wrapper, the swipe actions, the long-press menu, the drag source and the
/// selection tag — is built once instead of once per row kind. What differs is passed in: the
/// content, the actions, and what a tap opens. There is no branch here on whether the subject is a
/// plain session or a project's coordinator; both are sessions, and a project row names its
/// coordinator as the subject.
struct SessionListRow<Content: View, Menu: View>: View {
    @Environment(AppModel.self) private var app
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    #endif
    /// The session behind the row: the session itself, or a project's coordinator. Its id is the
    /// row's selection tag and what a drag carries.
    let subject: Session
    let navigation: SessionRowNavigation
    /// What a tap opens. Nil opens the subject itself: through the `List`'s selection in the
    /// three-column shell, through `AppModel.openSessionRow` in the compact one. A project row passes
    /// its own target — the project's sessions page, or the member waiting on you.
    let onOpen: (() -> Void)?
    let leading: [RowSwipeAction]
    let trailing: [RowSwipeAction]
    /// Whether a full swipe runs the first leading action.
    let leadingFullSwipe: Bool
    /// Whether the row may be picked up and dropped on a folder (the Mac only).
    let draggable: Bool
    let drag: SessionDragState?
    /// The title the drag's preview card shows.
    let dragTitle: String
    let content: Content
    let menu: Menu

    init(subject: Session, navigation: SessionRowNavigation, onOpen: (() -> Void)? = nil,
         leading: [RowSwipeAction] = [], trailing: [RowSwipeAction] = [], leadingFullSwipe: Bool = false,
         draggable: Bool = false, drag: SessionDragState? = nil, dragTitle: String,
         @ViewBuilder content: () -> Content, @ViewBuilder menu: () -> Menu) {
        self.subject = subject
        self.navigation = navigation
        self.onOpen = onOpen
        self.leading = leading
        self.trailing = trailing
        self.leadingFullSwipe = leadingFullSwipe
        self.draggable = draggable
        self.drag = drag
        self.dragTitle = dragTitle
        self.content = content()
        self.menu = menu()
    }

    var body: some View {
        swipeable(wrapped)
            // Both are read off the view the `List` hosts as its row, so they attach here — outside
            // the `Button` where the compact shape has one, never to its label (see `wrapped`).
            .sessionDragSource(subject, enabled: draggable, drag: drag, title: dragTitle)
    }

    /// Who moves the screen: the three-column `List`'s selection, or the compact row's own press.
    /// A row with its own open target is a `Button` in either shape; the project row is the one that
    /// is, so a click still opens the project's sessions page while its tag lets the arrow keys
    /// select the coordinator beside it.
    @ViewBuilder private var wrapped: some View {
        switch navigation {
        case .selection:
            if let onOpen {
                Button(action: onOpen) { label }
                    .buttonStyle(.plain)
                    .tag(subject.id)
            } else {
                label.tag(subject.id)
            }
        case .push:
            // A `Button`, not a `NavigationLink(value:)`: the link's disclosure indicator has no
            // usable hiding place on iOS 17/18 (see `AppModel.push`). `.foregroundStyle(.primary)`:
            // a button's label otherwise inherits the accent tint, and the rows are unchanged by
            // design (only the wrapper is new).
            Button {
                if let onOpen { onOpen() } else { app.openSessionRow(subject) }
            } label: {
                label
            }
        }
    }

    private var label: some View {
        content.foregroundStyle(.primary)
    }

    /// The compact list's rows draw their own circles on iOS 26. The regular-width list keeps the
    /// system's buttons: its rows are selected in place, and the circles draw the row's separators
    /// themselves, which a selected row's would need to follow.
    @ViewBuilder private func swipeable<Row: View>(_ row: Row) -> some View {
        #if os(iOS)
        if #available(iOS 26.0, *),
           SessionListPresentation.resolve(isCompactWidth: horizontalSizeClass == .compact) == .compact {
            row
                .contextMenu { menu }
                .circleSwipeActions(id: subject.id, leading: leading, trailing: trailing,
                                    leadingFullSwipe: leadingFullSwipe)
        } else {
            systemSwipeActions(row)
        }
        #else
        systemSwipeActions(row)
        #endif
    }

    private func systemSwipeActions<Row: View>(_ row: Row) -> some View {
        row
            .swipeActions(edge: .leading, allowsFullSwipe: leadingFullSwipe) {
                ForEach(leading) { $0.menuItem }
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                ForEach(trailing) { $0.menuItem }
            }
            .contextMenu { menu }
    }
}

/// One entry of a session list: a project's row (backed by its coordinator), or a plain session's,
/// both through `SessionListRow`. The workspace list and a folder's page draw every entry through
/// this one builder, so the two shells cannot drift apart.
struct SessionListEntryRow: View {
    @Environment(AppModel.self) private var app
    /// The session the list's grouping produced. For a project entry this is the synthetic session
    /// keyed by the project's id (`SessionProjectEntry.timeGroupingSession`), which is how the
    /// project row is found in `projects`.
    let session: Session
    let projects: [String: SessionProjectRow]
    let marks: [String: SessionProjectMark]
    let view: SessionView
    let agentID: String
    let navigation: SessionRowNavigation
    let drag: SessionDragState
    /// Whether the list offers somewhere to drop a row (folder rows, or a folder's page head).
    let dropTargets: Bool
    let onTag: (Session) -> Void
    let onShare: (Session) -> Void
    let onMove: (Session) -> Void

    var body: some View {
        if let project = projects[session.id] {
            SessionProjectListRow(row: project, view: view, agentID: agentID, navigation: navigation,
                                  drag: drag, dropTargets: dropTargets, onMove: onMove)
        } else {
            let mark = marks[session.id]
            SessionRow(
                session: session, navigation: navigation, scope: view, projectMark: mark,
                onTag: { onTag(session) }, onShare: { onShare(session) }, onMove: { onMove(session) },
                onSessions: mark.map { mark in
                    { app.openProjectSessions(SessionProjectAddress(projectID: mark.projectId,
                                                                    agentID: agentID, view: view)) }
                },
                draggable: SessionFolderDrag.draggable(session, view: view, hasProjectMark: mark != nil,
                                                       dropTargets: dropTargets),
                drag: drag)
        }
    }
}
