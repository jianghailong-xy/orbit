import SwiftUI

/// The app's one transient-message surface: a floating card that drops in under the nav bar, carrying
/// an inline Undo when the message reports a reversible row action ("Completed", "Deleted"). Fed by
/// `AppModel.showToast` — row actions directly, console confirmations ("Merged into main",
/// "Committed changes") via `ConsoleRegistry.onToast`.
///
/// Top-anchored deliberately. It used to float at the *bottom*, 24pt above the safe area, which on
/// iPhone is squarely inside the composer: the card covered the input row and the model/effort pills,
/// and — being hit-testable, with its own Undo button — swallowed the taps meant for the field for as
/// long as it showed. The keyboard doesn't save it either, since avoidance lifts the toast and the
/// composer together. Web had the same defect and fixed it the same way (see `main.tsx`'s
/// `TOAST_TOP`). Attach once at a root shell; it floats over pushed pages too.
private struct ToastHost: ViewModifier {
    @Environment(AppModel.self) private var model

    /// Clearance for the chrome the toast tucks under. On iOS this modifier sits at the shell root,
    /// *outside* the NavigationStack, so its safe area covers the status bar only and the compact nav
    /// bar (44pt, fixed by UIKit — the console's two-line inline title fits inside it) has to be
    /// cleared by hand. That's measured against the *inline* bar: on a large-title root (the session
    /// list, scrolled to the very top) the card overlaps the big title for the few seconds it shows,
    /// which is the better trade — clearing 96pt everywhere would strand it mid-transcript on the
    /// console, where the toast matters most. On macOS the window's safe area already excludes the
    /// toolbar, so it only needs air.
    #if os(iOS)
    private static let topInset: CGFloat = 52
    #else
    private static let topInset: CGFloat = 12
    #endif

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .top) {
                if let toast = model.toast {
                    HStack(spacing: 12) {
                        // Leading, not centred: a centred label reads badly the moment it wraps
                        // (web parity — `.ant-message-notice-content`). The card spans the full
                        // width (up to the cap below) rather than hugging its text, so the action
                        // always sits at the trailing edge — one predictable target, wherever the
                        // message length lands.
                        Text(toast.message)
                            .multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if toast.undoSessionID != nil {
                            Button("Undo") { model.undoSessionAction() }
                                .font(.body.weight(.semibold))
                        }
                    }
                    .padding(.horizontal, 18)
                    .padding(.vertical, 12)
                    .background {
                        let shape = RoundedRectangle(cornerRadius: 18, style: .continuous)
                        shape.fill(.regularMaterial)
                            // Hairline edge so the card still reads as a distinct surface where the
                            // material lands on a same-toned background. `.primary` so it inverts
                            // with the appearance instead of staying a dark line in dark mode.
                            .overlay(shape.strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.7))
                            .shadow(color: .black.opacity(0.18), radius: 12, y: 4)
                    }
                    // Cap the card so a long message wraps into a compact block instead of stretching
                    // across an iPad/Mac window (web parity: the 560px notice cap).
                    .frame(maxWidth: 560)
                    .padding(.horizontal, 16)
                    .padding(.top, Self.topInset)
                    // Only an actionable toast takes touches. A bare confirmation must stay
                    // pass-through, or it would eat scrolls and taps on the transcript beneath it
                    // (including the sticky "↑ Your question" header it lands on).
                    .allowsHitTesting(toast.undoSessionID != nil)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .id(toast.id)
                }
            }
            .animation(.snappy, value: model.toast)
            // A toast that only paints is invisible to VoiceOver — announce it as it arrives.
            .onChange(of: model.toast) { _, new in
                if let new { AccessibilityNotification.Announcement(new.message).post() }
            }
    }
}

extension View {
    /// Floats the app's transient toasts ("Completed … Undo", "Merged into main") under the nav bar.
    /// Attach once at a root shell.
    func toastHost() -> some View { modifier(ToastHost()) }
}
