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

private struct SessionRowActions: ViewModifier {
    @Environment(AppModel.self) private var model
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    #endif
    let session: Session
    /// The tab this row is shown under; `nil` means an Open-list surface.
    /// `.completed` and `.trash` swap the positive action from Complete to Move to Open; `.trash` also
    /// swaps the destructive action from a soft-delete to an irreversible purge (behind a
    /// confirmation) and drops Pin — a trashed session isn't orderable.
    let scope: SessionView?
    /// Opens the tag picker for this row (set by the list, which owns the sheet). `nil` on surfaces
    /// without a tag library on hand, where the "Tags…" item is hidden.
    let onTag: (() -> Void)?
    /// Hands this row to the list, which owns the share panel's sheet. Read on iOS only — see
    /// `shareAction`.
    let onShare: (() -> Void)?
    /// Hands this row to the list, which owns the Move panel's sheet. Read on iOS only — see
    /// `moveAction`.
    let onMove: (() -> Void)?
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

    func body(content: Content) -> some View {
        swipeable(content)
            .sessionRenameAlert(isPresented: $renaming, draft: $renameDraft, sessionID: session.id)
            .confirmationDialog("Delete permanently?", isPresented: $confirmPurge, titleVisibility: .visible) {
                Button("Delete Permanently", role: .destructive) { model.purgeSession(session.id) }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This session and its full transcript will be permanently deleted. This can't be undone.")
            }
    }

    /// The compact list's rows draw their own circles on iOS 26. The regular-width list keeps the
    /// system's buttons: its rows are selected in place, and the circles draw the row's separators
    /// themselves, which a selected row's would need to follow.
    @ViewBuilder private func swipeable(_ content: Content) -> some View {
        #if os(iOS)
        if #available(iOS 26.0, *),
           SessionListPresentation.resolve(isCompactWidth: horizontalSizeClass == .compact) == .compact {
            content
                .contextMenu { menu }
                .circleSwipeActions(id: session.id, leading: leadingActions, trailing: trailingActions,
                                    leadingFullSwipe: canPerformPositiveAction)
        } else {
            systemSwipeActions(content)
        }
        #else
        systemSwipeActions(content)
        #endif
    }

    private func systemSwipeActions(_ content: Content) -> some View {
        content
            .swipeActions(edge: .leading, allowsFullSwipe: canPerformPositiveAction) {
                ForEach(leadingActions) { button($0) }
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                ForEach(trailingActions) { button($0) }
            }
            .contextMenu { menu }
    }

    @ViewBuilder private var menu: some View {
        // Rename stays out of the swipe actions — it opens an editor rather than performing
        // the action, which is not what a swipe promises. Trash matches web, where the
        // header title isn't editable for a trashed session.
        if !isTrash { renameButton }
        if !isTrash { button(pinAction) }
        if !isTrash, let onTag {
            Button { onTag() } label: { Label("Tags…", systemImage: "tag") }
        }
        button(positiveAction)
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
        button(deleteAction)
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
    /// iOS only, as Share is — the Mac shows no folders — and never in Trash.
    private var moveAction: RowSwipeAction? {
        #if os(iOS)
        guard !isTrash, let onMove else { return nil }
        if let membership = session.projectMembership, membership.role != .coordinator { return nil }
        return RowSwipeAction(title: "Move", systemImage: "folder", tint: .indigo, perform: onMove)
        #else
        return nil
        #endif
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
        RowSwipeAction(title: isPinned ? "Unpin" : "Pin", systemImage: isPinned ? "pin.slash" : "pin",
                       tint: .indigo) { model.setPinned(session, pinned: !isPinned) }
    }

    private var deleteAction: RowSwipeAction {
        if isTrash {
            return RowSwipeAction(title: "Delete Permanently", systemImage: "trash.slash", tint: .red,
                                  role: .destructive) { confirmPurge = true }
        }
        return RowSwipeAction(title: "Delete", systemImage: "trash", tint: .red,
                              role: .destructive) { model.deleteSession(session.id) }
    }

    /// An action as a system button: a swipe button (a destructive one is the system's red) or a
    /// context-menu item.
    private func button(_ action: RowSwipeAction) -> some View {
        Button(role: action.role, action: action.perform) {
            Label(action.title, systemImage: action.systemImage)
        }
        .tint(action.role == .destructive ? nil : action.tint)
        .disabled(!action.isEnabled)
    }
}

extension View {
    /// Attach the pin / complete-or-move-to-open / delete actions to a session row.
    /// `onTag`, when provided, adds a "Tags…" context-menu item that opens the list-owned tag picker.
    /// `onShare`, when provided, adds Share to the swipe and the menu on iOS, outside Trash; it hands
    /// the row to the list that presents the share panel. `onMove` does the same for Move and the
    /// Move panel.
    func sessionRowActions(_ session: Session, scope: SessionView? = nil,
                           onTag: (() -> Void)? = nil, onShare: (() -> Void)? = nil,
                           onMove: (() -> Void)? = nil) -> some View {
        modifier(SessionRowActions(session: session, scope: scope, onTag: onTag, onShare: onShare,
                                   onMove: onMove))
    }
}
