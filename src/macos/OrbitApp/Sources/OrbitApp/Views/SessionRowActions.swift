import SwiftUI
import OrbitKit

// Row-level session actions for each agent's Open/Archived/Trash lists. Two surfaces,
// deliberately paired:
//   • swipeActions — the iOS accelerator, mapped to the platform convention (NOT the first-draft
//     request, which had them reversed):
//       – leading  (swipe right) → the positive actions: Archive/Pin (Move to Open in Archived and
//         Trash)
//       – trailing (swipe left)  → Delete, red, destructive, and `allowsFullSwipe: false` so a
//         stray full swipe can't fire it — the user must tap the revealed button.
//   • contextMenu — the cross-platform "source of truth": the same actions on a long-press (iOS) or
//     right-click (macOS), so they're discoverable and reachable by VoiceOver, and so macOS (where
//     row swiping is awkward) still has them.
// Delete is a soft-delete to the trash and offers Undo (see `AppModel`), so both swipe and menu are
// safe. The Trash tab's Delete is instead a permanent purge — irreversible, so it's gated behind a
// confirmation and offers no Undo.

private struct SessionRowActions: ViewModifier {
    @Environment(AppModel.self) private var model
    let session: Session
    /// The tab this row is shown under; `nil` means an Open-list surface.
    /// `.archived` and `.trash` swap the positive action from Archive to Move to Open; `.trash` also
    /// swaps the destructive action from a soft-delete to an irreversible purge (behind a
    /// confirmation) and drops Pin — a trashed session isn't orderable.
    let scope: SessionView?
    /// Opens the tag picker for this row (set by the list, which owns the sheet). `nil` on surfaces
    /// without a tag library on hand, where the "Tags…" item is hidden.
    let onTag: (() -> Void)?
    /// Gates the irreversible "Delete Permanently" behind a confirmation (Trash only), mirroring
    /// web's modal. Per-row state: only the row whose button was tapped presents the dialog.
    @State private var confirmPurge = false
    /// Archiving an in-flight run also ends it, so require an explicit second step.
    @State private var confirmArchive = false

    private var isArchived: Bool { scope == .archived }
    private var isTrash: Bool { scope == .trash }
    private var isOpen: Bool { scope == nil || scope == .open }
    private var isLive: Bool {
        isOpen && SessionArchivePresentation.requiresConfirmation(for: session.effectiveRunState)
    }
    private var canArchive: Bool { session.capabilities?.canArchive ?? true }
    private var canRestore: Bool { session.capabilities?.canRestore ?? true }
    private var canPerformPositiveAction: Bool {
        isArchived || isTrash ? canRestore : canArchive
    }
    private var isPinned: Bool { session.pinnedAt != nil }

    func body(content: Content) -> some View {
        content
            .swipeActions(edge: .leading, allowsFullSwipe: canPerformPositiveAction && !isLive) {
                positiveButton
                if !isTrash { pinButton }
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                deleteButton
            }
            .contextMenu {
                if !isTrash { pinButton }
                if !isTrash, let onTag {
                    Button { onTag() } label: { Label("Tags…", systemImage: "tag") }
                }
                positiveButton
                Divider()
                deleteButton
            }
            .confirmationDialog("Delete permanently?", isPresented: $confirmPurge, titleVisibility: .visible) {
                Button("Delete Permanently", role: .destructive) { model.purgeSession(session.id) }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This session and its full transcript will be permanently deleted. This can't be undone.")
            }
            .confirmationDialog("End and archive this session?", isPresented: $confirmArchive,
                                titleVisibility: .visible) {
                Button("End & Archive", role: .destructive) { model.archiveSession(session.id) }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This ends the current run and moves the session to Archived.")
            }
    }

    @ViewBuilder private var positiveButton: some View {
        if isArchived || isTrash {
            Button { model.moveSessionToOpen(session.id) } label: {
                Label("Move to Open", systemImage: "tray.and.arrow.up")
            }
            .tint(.blue)
            .disabled(!canRestore)
        } else {
            Button { requestArchive() } label: {
                Label(SessionArchivePresentation.actionTitle(for: session.effectiveRunState),
                      systemImage: "archivebox")
            }
            .tint(.green)
            .disabled(!canArchive)
        }
    }

    private func requestArchive() {
        guard canArchive else { return }
        if isLive { confirmArchive = true }
        else { model.archiveSession(session.id) }
    }

    private var pinButton: some View {
        Button { model.setPinned(session, pinned: !isPinned) } label: {
            Label(isPinned ? "Unpin" : "Pin", systemImage: isPinned ? "pin.slash" : "pin")
        }
        .tint(.indigo)
    }

    @ViewBuilder private var deleteButton: some View {
        if isTrash {
            Button(role: .destructive) { confirmPurge = true } label: {
                Label("Delete Permanently", systemImage: "trash.slash")
            }
        } else {
            Button(role: .destructive) { model.deleteSession(session.id) } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }
}

extension View {
    /// Attach the pin / archive-or-move-to-open / delete actions to a session row.
    /// `onTag`, when provided, adds a "Tags…" context-menu item that opens the list-owned tag picker.
    func sessionRowActions(_ session: Session, scope: SessionView? = nil,
                           onTag: (() -> Void)? = nil) -> some View {
        modifier(SessionRowActions(session: session, scope: scope, onTag: onTag))
    }
}

// MARK: - Undo toast

private struct SessionUndoToast: ViewModifier {
    @Environment(AppModel.self) private var model

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .bottom) {
                if let undo = model.sessionUndo {
                    HStack(spacing: 12) {
                        Text(undo.message).foregroundStyle(.white)
                        Spacer(minLength: 12)
                        Button("Undo") { model.undoSessionAction() }
                            .font(.body.weight(.semibold))
                    }
                    .padding(.horizontal, 18)
                    .padding(.vertical, 12)
                    .background(.black.opacity(0.85), in: Capsule())
                    .padding(.horizontal, 20)
                    .padding(.bottom, 24)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .id(undo.id)
                }
            }
            .animation(.snappy, value: model.sessionUndo)
    }
}

extension View {
    /// Floats the "Archived / Deleted … Undo" toast above the shell. Attach once at a root shell.
    func sessionUndoToast() -> some View { modifier(SessionUndoToast()) }
}
