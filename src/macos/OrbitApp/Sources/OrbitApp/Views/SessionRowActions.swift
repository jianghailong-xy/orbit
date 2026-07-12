import SwiftUI
import OrbitKit

// Row-level session actions for the session lists (the Active sidebar and each agent's
// Active/Completed/System/Trash list). Two surfaces, deliberately paired:
//   • swipeActions — the iOS accelerator, mapped to the platform convention (NOT the first-draft
//     request, which had them reversed):
//       – leading  (swipe right) → the positive actions: Complete/Pin (Restore on the Completed and
//         Trash tabs)
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
    /// The tab this row is shown under; `nil` for the Active sidebar (always active sessions).
    /// `.completed` and `.trash` swap the positive action from Complete to Restore; `.trash` also
    /// swaps the destructive action from a soft-delete to an irreversible purge (behind a
    /// confirmation) and drops Pin — a trashed session isn't orderable.
    let scope: SessionView?
    /// Gates the irreversible "Delete Permanently" behind a confirmation (Trash only), mirroring
    /// web's modal. Per-row state: only the row whose button was tapped presents the dialog.
    @State private var confirmPurge = false

    private var isCompleted: Bool { scope == .completed }
    private var isTrash: Bool { scope == .trash }
    private var isPinned: Bool { session.pinnedAt != nil }

    func body(content: Content) -> some View {
        content
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                positiveButton
                if !isTrash { pinButton }
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                deleteButton
            }
            .contextMenu {
                if !isTrash { pinButton }
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
    }

    @ViewBuilder private var positiveButton: some View {
        if isCompleted || isTrash {
            Button { model.restoreSession(session.id) } label: {
                Label("Restore", systemImage: "tray.and.arrow.up")
            }
            .tint(.blue)
        } else {
            Button { model.completeSession(session.id) } label: {
                Label("Complete", systemImage: "checkmark")
            }
            .tint(.green)
        }
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
    /// Attach the pin / complete-or-restore / delete actions to a session row (swipe + context menu).
    func sessionRowActions(_ session: Session, scope: SessionView? = nil) -> some View {
        modifier(SessionRowActions(session: session, scope: scope))
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
    /// Floats the "Completed / Deleted … Undo" toast above the shell. Attach once at a root shell.
    func sessionUndoToast() -> some View { modifier(SessionUndoToast()) }
}
