import SwiftUI
import OrbitKit

// The rename editor shared by the two surfaces that name a session: the list row's context menu and
// (on iOS) the console's nav-bar title. Web renames inline in the header (`AgentView.tsx`), but an
// input in place isn't a touch pattern, so the native clients use the platform's rename alert —
// with the same rules (trim, empty or unchanged is a no-op, Cancel drops the draft) stated once.
//
// The draft is the CALLER's state so it can be seeded in the very action that presents the alert:
// SwiftUI builds the alert's content as it presents, so seeding afterwards (from `onChange`) races
// the field being drawn — and seeding it is what makes "rename" an edit rather than a retype.

private struct SessionRenameAlert: ViewModifier {
    @Environment(AppModel.self) private var model
    @Binding var isPresented: Bool
    @Binding var draft: String
    let sessionID: String

    func body(content: Content) -> some View {
        content.alert("Rename Session", isPresented: $isPresented) {
            TextField("Title", text: $draft)
            // Default action, so Return in the field commits (as Enter does in web's inline editor).
            Button("Save") { model.renameSession(sessionID, title: draft) }
                .keyboardShortcut(.defaultAction)
            Button("Cancel", role: .cancel) {}
        }
    }
}

extension View {
    /// Attach the session rename alert. Open it by seeding `draft` with the session's current title
    /// and flipping `isPresented` in the same action.
    func sessionRenameAlert(isPresented: Binding<Bool>, draft: Binding<String>,
                            sessionID: String) -> some View {
        modifier(SessionRenameAlert(isPresented: isPresented, draft: draft, sessionID: sessionID))
    }
}
