import SwiftUI

/// The app's one session-result surface: a floating card that drops in under the nav bar with the
/// outcome, the session it happened in, and any diagnostic — the native port of web's `sessionNotice`
/// (see `lib/toast.tsx`). Fed by `AppModel.showToast`: row actions directly, worktree outcomes via
/// `ConsoleRegistry.onToast`. Tapping it opens that session; a reversible action adds Undo; a
/// warning/error stays until its ✕ instead of leaving on a timer.
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
                        Image(systemName: toast.icon ?? Self.icon(for: toast.tone))
                            .font(.title3)
                            .foregroundStyle(Self.tint(for: toast.tone))
                            .accessibilityHidden(true)
                        // The copy doubles as the way into the session it reports on. It's the copy —
                        // not the whole card — so Undo and ✕ keep their own targets, and it takes the
                        // full width (see `copy`) so the tap lands anywhere along the row.
                        if toast.sessionID != nil {
                            Button { model.openToastSession() } label: { copy(toast) }
                                .buttonStyle(.plain)
                                .accessibilityHint("Opens the session")
                        } else {
                            copy(toast)
                        }
                        if toast.canUndo {
                            Button("Undo") { model.undoSessionAction() }
                                .font(.body.weight(.semibold))
                        }
                        // A persistent card needs a way out; a self-dismissing one would just be
                        // offering to race its own timer.
                        if toast.tone.isPersistent {
                            Button { model.dismissToast() } label: {
                                Image(systemName: "xmark")
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(.secondary)
                            .accessibilityLabel("Dismiss")
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
                    // A card that names a session is a shortcut into it, so it has to take touches.
                    // One that names none (a draft console's) stays pass-through rather than eating
                    // scrolls and taps on the transcript beneath it for its whole 4s.
                    .allowsHitTesting(toast.sessionID != nil)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .id(toast.id)
                }
            }
            .animation(.snappy, value: model.toast)
            // A card that only paints is invisible to VoiceOver — announce it as it arrives, with
            // the diagnostic, which on a failure is the part worth hearing.
            .onChange(of: model.toast) { _, new in
                guard let new else { return }
                var spoken = new.message
                if let detail = new.detail { spoken += ". " + detail }
                AccessibilityNotification.Announcement(spoken).post()
            }
    }

    /// The card's copy, in web's reading order: the outcome, the session it happened in, then any
    /// diagnostic. Leading, not centred — a centred block reads badly the moment it wraps. It claims
    /// the full width so Undo and ✕ sit at the trailing edge, and so the tappable run covers the
    /// empty space beside a short message instead of just the glyphs.
    private func copy(_ toast: AppModel.Toast) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(toast.message)
            if let title = toast.sessionTitle {
                Text(title)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            if let detail = toast.detail {
                Text(detail)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(4)
            }
        }
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    /// Tone → glyph, matching what web's card shows for the same outcome.
    private static func icon(for tone: ToastTone) -> String {
        switch tone {
        case .success: return "checkmark.circle.fill"
        case .neutral: return "info.circle.fill"
        case .info:    return "info.circle.fill"
        case .warning: return "exclamationmark.circle.fill"
        case .error:   return "xmark.circle.fill"
        }
    }

    private static func tint(for tone: ToastTone) -> Color {
        switch tone {
        case .success: return .green
        case .neutral: return .secondary
        case .info:    return .accentColor
        case .warning: return .orange
        case .error:   return .red
        }
    }
}

extension View {
    /// Floats the app's transient toasts ("Completed … Undo", "Merged into main") under the nav bar.
    /// Attach once at a root shell.
    func toastHost() -> some View { modifier(ToastHost()) }
}
