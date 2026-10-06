import SwiftUI

/// How a confirmation is asked, by the width it is asked on.
///
/// **A phone gets an alert**: centred, the screen dimmed behind it, Cancel beside the destructive
/// press — the shape iOS products ask a destructive question in, ChatGPT's own log out among them.
/// A `confirmationDialog` on iOS 26 is the other thing: a glass panel the system anchors to the view
/// it is declared on, which is what a swipe or a ⋯ offers to *choose* an action from.
///
/// **A tablet keeps the panel**, anchored to whatever raised it — where the question is one of several
/// things a big screen is showing at once, and a centred alert would cover the work it is about.
///
/// Declared once per confirmation so the two widths cannot drift into two different questions, and so
/// a new confirmation gets the right shape for both by construction rather than by remembering to
/// branch. macOS reads regular width and keeps the dialog it always had.
extension View {
    /// The plain shape: one question, one binding, actions and a message.
    func orbitConfirmation<Actions: View, Message: View>(
        _ title: String,
        isPresented: Binding<Bool>,
        @ViewBuilder actions: @escaping () -> Actions,
        @ViewBuilder message: @escaping () -> Message
    ) -> some View {
        modifier(OrbitConfirmation(title: title, isPresented: isPresented,
                                   actions: actions, message: message))
    }

    /// The shape with nothing to add under the question — the title and the buttons say it all.
    func orbitConfirmation<Actions: View>(
        _ title: String,
        isPresented: Binding<Bool>,
        @ViewBuilder actions: @escaping () -> Actions
    ) -> some View {
        modifier(OrbitConfirmation<Actions, EmptyView>(title: title, isPresented: isPresented,
                                                      actions: actions, message: { EmptyView() }))
    }

    /// The shape that carries what it is about — the link, the key, the row — so the question names it
    /// and the buttons act on it. `title` is read only while something is being asked about.
    func orbitConfirmation<Payload, Actions: View, Message: View>(
        _ title: @escaping (Payload) -> String,
        isPresented: Binding<Bool>,
        presenting payload: Payload?,
        @ViewBuilder actions: @escaping (Payload) -> Actions,
        @ViewBuilder message: @escaping (Payload) -> Message
    ) -> some View {
        modifier(OrbitConfirmationPresenting(title: title, isPresented: isPresented, payload: payload,
                                             actions: actions, message: message))
    }
}

private struct OrbitConfirmation<Actions: View, Message: View>: ViewModifier {
    let title: String
    let isPresented: Binding<Bool>
    @ViewBuilder let actions: () -> Actions
    @ViewBuilder let message: () -> Message

    @Environment(\.horizontalSizeClass) private var hSize

    func body(content: Content) -> some View {
        if hSize == .compact {
            content.alert(title, isPresented: isPresented, actions: actions, message: message)
        } else {
            content.confirmationDialog(title, isPresented: isPresented, titleVisibility: .visible,
                                       actions: actions, message: message)
        }
    }
}

private struct OrbitConfirmationPresenting<Payload, Actions: View, Message: View>: ViewModifier {
    let title: (Payload) -> String
    let isPresented: Binding<Bool>
    let payload: Payload?
    @ViewBuilder let actions: (Payload) -> Actions
    @ViewBuilder let message: (Payload) -> Message

    @Environment(\.horizontalSizeClass) private var hSize

    func body(content: Content) -> some View {
        if hSize == .compact {
            content.alert(payload.map(title) ?? "", isPresented: isPresented, presenting: payload,
                          actions: actions, message: message)
        } else {
            content.confirmationDialog(payload.map(title) ?? "", isPresented: isPresented,
                                       titleVisibility: .visible, presenting: payload,
                                       actions: actions, message: message)
        }
    }
}
