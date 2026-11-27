import SwiftUI
import OrbitKit

// Row-level session actions for each agent's Open/Completed/Trash lists. Two surfaces,
// deliberately paired:
//   • swipeActions — the iOS accelerator, mapped to the platform convention (NOT the first-draft
//     request, which had them reversed):
//       – leading  (swipe right) → the positive actions: Complete/Pin (Move to Open in Completed and
//         Trash)
//       – trailing (swipe left)  → Delete, red, destructive, and `allowsFullSwipe: false` so a
//         stray full swipe can't fire it — the user must tap the revealed button. On iOS, Share
//         (blue) and Move (indigo) sit inside it, so the row reads Share · Move · Delete from left
//         to right: Share opens the session page's share panel, Move the Move panel
//         (docs/session-folders-move-design.md §2). Trash has neither, since a trashed session can't
//         be shared (docs/share-links-design.md §3) or filed.
//     On iOS 26 the compact list's rows draw these themselves as circles (`circleSwipeActions`):
//     the system draws its own at this row's height as squashed capsules. Both are drawn from the
//     same action lists.
//   • contextMenu — the cross-platform "source of truth": the same actions on a long-press (iOS) or
//     right-click (macOS), so they're discoverable and reachable by VoiceOver, and so macOS (where
//     row swiping is awkward) still has them.
// Delete is a soft-delete to the trash and offers Undo (see `AppModel`), so both swipe and menu are
// safe. The Trash tab's Delete is instead a permanent purge — irreversible, so it's gated behind a
// confirmation and offers no Undo.

/// The Pin and Move a session row and a project's row both draw: a project row's subject is its
/// coordinator, so the one implementation acts on whatever session the row is backed by.
@MainActor
enum SessionRowAction {
    static func pin(_ session: Session, in model: AppModel) -> RowSwipeAction {
        let pinned = session.pinnedAt != nil
        return RowSwipeAction(title: pinned ? "Unpin" : "Pin",
                              systemImage: pinned ? "pin.slash" : "pin", tint: .indigo) {
            model.setPinned(session, pinned: !pinned)
        }
    }

    static func move(_ perform: @escaping () -> Void) -> RowSwipeAction {
        RowSwipeAction(title: "Move", systemImage: "folder", tint: .indigo, perform: perform)
    }
}

/// A plain session's row: `AgentSessionRow` through the shared shell (`SessionListRow`), with this
/// session's actions. The rename editor and the purge confirmation live here, at the row's level.
struct SessionRow: View {
    @Environment(AppModel.self) private var model
    let session: Session
    /// How this row's container navigates (see `SessionRowNavigation`).
    var navigation: SessionRowNavigation = .selection
    /// The tab this row is shown under; `nil` means an Open-list surface.
    /// `.completed` and `.trash` swap the positive action from Complete to Move to Open; `.trash` also
    /// swaps the destructive action from a soft-delete to an irreversible purge (behind a
    /// confirmation) and drops Pin — a trashed session isn't orderable.
    var scope: SessionView? = nil
    /// The project this row belongs to where the list has no row for that project (owner 2026-11-07,
    /// option A): its progress leads the second line, as it leads a project row's.
    var projectMark: SessionProjectMark? = nil
    /// Opens the tag picker for this row (set by the list, which owns the sheet). `nil` on surfaces
    /// without a tag library on hand, where the "Tags…" item is hidden.
    var onTag: (() -> Void)? = nil
    /// Hands this row to the list, which owns the share panel's sheet. Read on iOS only — see
    /// `shareAction`.
    var onShare: (() -> Void)? = nil
    /// Hands this row to the list, which owns the Move panel's sheet — see `moveAction`.
    var onMove: (() -> Void)? = nil
    /// Opens the sessions page of the project this row belongs to, where the list has no row for that
    /// project: a member in a workspace its coordinator does not run in (owner 2026-11-07,
    /// docs/mocks/project-rows-by-workspace, option A). The long press's Sessions, since the progress
    /// mark that says so is too small to press on a phone. Such a member is a row of its own, so it also
    /// moves on its own. `nil` everywhere else.
    var onSessions: (() -> Void)? = nil
    /// What a tap opens; nil opens this session itself.
    var onOpen: (() -> Void)? = nil
    /// Whether the row may be dragged onto a folder (the Mac only).
    var draggable = false
    var drag: SessionDragState? = nil
    /// Gates the irreversible "Delete Permanently" behind a confirmation (Trash only), mirroring
    /// web's modal. Per-row state: only the row whose button was tapped presents the dialog.
    @State private var confirmPurge = false
    /// The rename alert and its draft, seeded from the row's current title when the menu item fires.
    @State private var renaming = false
    @State private var renameDraft = ""
    private var isCompleted: Bool { scope == .completed }
    private var isTrash: Bool { scope == .trash }
    private var canComplete: Bool { session.capabilities?.canComplete ?? true }
    private var canRestore: Bool { session.capabilities?.canRestore ?? true }
    private var canPerformPositiveAction: Bool {
        isCompleted || isTrash ? canRestore : canComplete
    }
    private var isPinned: Bool { session.pinnedAt != nil }

    var body: some View {
        SessionListRow(
            subject: session, navigation: navigation, onOpen: onOpen,
            leading: leadingActions, trailing: trailingActions,
            leadingFullSwipe: canPerformPositiveAction,
            draggable: draggable, drag: drag,
            dragTitle: session.title ?? "Untitled session",
            content: { AgentSessionRow(session: session, deleted: isTrash, projectMark: projectMark) },
            menu: { menu })
            .sessionRenameAlert(isPresented: $renaming, draft: $renameDraft, sessionID: session.id)
            .orbitConfirmation("Delete permanently?", isPresented: $confirmPurge) {
                Button("Delete Permanently", role: .destructive) { model.purgeSession(session.id) }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This session and its full transcript will be permanently deleted. This can't be undone.")
            }
    }

    @ViewBuilder private var menu: some View {
        // The project's sessions, in a group of their own above this session's actions.
        if let onSessions {
            Section {
                Button(action: onSessions) { Label(SessionProjectCopy.sessions, systemImage: "list.bullet") }
            }
        }
        // Rename stays out of the swipe actions — it opens an editor rather than performing
        // the action, which is not what a swipe promises. Trash matches web, where the
        // header title isn't editable for a trashed session.
        if !isTrash { renameButton }
        if !isTrash { pinAction.menuItem }
        if !isTrash, let onTag {
            Button { onTag() } label: { Label("Tags…", systemImage: "tag") }
        }
        positiveAction.menuItem
        // Share…, as the task and project menus spell the item that opens this same panel.
        if let shareAction {
            Button(action: shareAction.perform) {
                Label(SharePanelCopy.share, systemImage: shareAction.systemImage)
            }
        }
        // Move… after it, so the menu's tail runs Share… · Move… · Delete as the swipe does.
        if let moveAction {
            Button(action: moveAction.perform) {
                Label("Move…", systemImage: moveAction.systemImage)
            }
        }
        Divider()
        deleteAction.menuItem
    }

    /// Each side's swipe actions from the screen edge inward; the first leading one is what a full
    /// swipe performs.
    private var leadingActions: [RowSwipeAction] {
        isTrash ? [positiveAction] : [positiveAction, pinAction]
    }

    /// Delete outermost, then Move, then Share: left to right the row reads Share · Move · Delete.
    private var trailingActions: [RowSwipeAction] {
        [deleteAction] + [moveAction, shareAction].compactMap { $0 }
    }

    /// The session page's share panel, which the list presents for this row. iOS only — the Mac
    /// shares from the session page's window toolbar — and never in Trash.
    private var shareAction: RowSwipeAction? {
        #if os(iOS)
        guard !isTrash, let onShare else { return nil }
        return RowSwipeAction(title: "Share", systemImage: "square.and.arrow.up", tint: .blue, perform: onShare)
        #else
        return nil
        #endif
    }

    /// The Move panel, which the list presents for this row (docs/session-folders-move-design.md §4).
    /// Every platform's, as the folders are; never in Trash.
    private var moveAction: RowSwipeAction? {
        guard !isTrash, let onMove else { return nil }
        // A member moves with its project's row, unless the list has no row for that project here.
        if onSessions == nil, let membership = session.projectMembership, membership.role != .coordinator { return nil }
        return SessionRowAction.move(onMove)
    }

    private var positiveAction: RowSwipeAction {
        if isCompleted || isTrash {
            return RowSwipeAction(title: "Move to Open", systemImage: "tray.and.arrow.up", tint: .blue,
                                  isEnabled: canRestore) { model.moveSessionToOpen(session.id) }
        }
        return RowSwipeAction(title: SessionCompletionPresentation.actionTitle,
                              systemImage: "checkmark.circle", tint: .green,
                              isEnabled: canComplete) { model.completeSession(session.id) }
    }

    private var renameButton: some View {
        Button {
            renameDraft = session.title ?? ""
            renaming = true
        } label: {
            Label("Rename…", systemImage: "pencil")
        }
    }

    private var pinAction: RowSwipeAction {
        SessionRowAction.pin(session, in: model)
    }

    private var deleteAction: RowSwipeAction {
        if isTrash {
            return RowSwipeAction(title: "Delete Permanently", systemImage: "trash.slash", tint: .red,
                                  role: .destructive) { confirmPurge = true }
        }
        return RowSwipeAction(title: "Delete", systemImage: "trash", tint: .red,
                              role: .destructive) { model.deleteSession(session.id) }
    }
}
