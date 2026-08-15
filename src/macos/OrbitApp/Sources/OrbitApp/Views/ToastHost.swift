import SwiftUI

/// The app's one session-result surface: a floating card that drops in under the nav bar with the
/// outcome, the session it happened in, and any diagnostic — the native port of web's `sessionNotice`
/// (see `lib/toast.tsx`). Fed by `AppModel.showToast`: row actions directly, worktree outcomes via
/// `ConsoleRegistry.onToast`. Tapping it opens that session; flicking it up gets rid of it early; a
/// reversible action adds Undo; a warning/error stays until its ✕ instead of leaving on a timer.
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

    /// How far the card has to travel before the swipe counts as "get rid of it". Short, because the
    /// gesture only ever goes one way and a tall threshold reads as the card being stuck — but not so
    /// short that the slack in a tap lands in it (see `swipeAway` on why that matters).
    private static let dismissTravel: CGFloat = 32

    /// The card's live travel under the finger. `@GestureState` so it returns to rest on its own,
    /// including when the gesture is cut short by the card being removed — which is what a completed
    /// swipe does.
    @GestureState private var dragY: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .top) {
                // The card's animation belongs to this container, never to `content`.
                // `.animation(_:value:)` animates *everything* the modifier is attached to, so hanging
                // it off the modified content put the whole shell — the section's NavigationSplitView
                // included — under `.snappy` for any change that landed in the same transaction as a
                // toast change. Tapping the card is exactly that transaction: `openToastSession` clears
                // the toast and routes to its session in one go, so the collapsed split's push ran as a
                // SwiftUI implicit animation over a UIKit navigation transition and wedged the stack —
                // the frozen screen showing the list and the console composited on top of each other.
                // An always-present container (empty when there's no toast) keeps the insert/remove
                // transition animated while leaving the shell below on its own transaction.
                ZStack(alignment: .top) {
                    if let toast = model.toast {
                        HStack(spacing: 12) {
                            Image(systemName: toast.icon ?? Self.icon(for: toast.tone))
                                .font(.title3)
                                .foregroundStyle(Self.tint(for: toast.tone))
                                .accessibilityHidden(true)
                            // The copy doubles as the way into the session it reports on. It's the copy
                            // — not the whole card — so Undo and ✕ keep their own targets, and it takes
                            // the full width (see `copy`) so the tap lands anywhere along the row.
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
                        // Cap the card so a long message wraps into a compact block instead of
                        // stretching across an iPad/Mac window (web parity: the 560px notice cap).
                        .frame(maxWidth: 560)
                        .padding(.horizontal, 16)
                        .padding(.top, Self.topInset)
                        .offset(y: dragY)
                        .animation(.interactiveSpring(response: 0.28, dampingFraction: 0.86),
                                   value: dragY)
                        .simultaneousGesture(swipeAway)
                        // A card that names a session is a shortcut into it, so it has to take touches.
                        // One that names none (a draft console's) stays pass-through rather than eating
                        // scrolls and taps on the transcript beneath it for its whole 4s — and, being
                        // pass-through, isn't swipeable either, which is the right trade for a card
                        // that blocks nothing and is gone in 4s anyway.
                        .allowsHitTesting(toast.sessionID != nil)
                        .transition(.move(edge: .top).combined(with: .opacity))
                        .id(toast.id)
                    }
                }
                .animation(.snappy, value: model.toast)
            }
            // A card that only paints is invisible to VoiceOver — announce it as it arrives, with
            // the diagnostic, which on a failure is the part worth hearing.
            .onChange(of: model.toast) { _, new in
                guard let new else { return }
                var spoken = new.message
                if let detail = new.detail { spoken += ". " + detail }
                AccessibilityNotification.Announcement(spoken).post()
            }
    }

    /// Flick the card up and it goes, the way a notification banner does. Without it the only ways
    /// out are the ✕ a warning/error carries and the 4–6s timer everything else leaves on, so a card
    /// that lands over the part of the transcript you're reading just has to be waited out.
    ///
    /// Up only: the card is anchored to the top, so there's nowhere to push it down to — a downward
    /// drag holds it at rest rather than dragging the card over the content it's already covering.
    ///
    /// Two things about the shape of this, both because the copy is a `Button` covering nearly the
    /// whole card. It's a `simultaneousGesture`, since a child button otherwise claims the touch and
    /// the container's drag never starts. And the dismissal fires from `onChanged` the moment the
    /// threshold is crossed, not on release: that takes the Button out of the hierarchy while the
    /// finger is still down, so a swipe can't also land as a tap and open the session behind it.
    /// Below the threshold there's no such protection, which is why it sits above a tap's slack.
    ///
    /// Measured globally, not in the card's own space: the card is `.offset` by the very travel this
    /// sets, and a local translation read from a frame that moves with it feeds each displacement
    /// back into the next reading (the drawer's `closeDrag` documents the stutter that produces).
    private var swipeAway: some Gesture {
        DragGesture(minimumDistance: 10, coordinateSpace: .global)
            .updating($dragY) { value, travel, _ in travel = min(0, value.translation.height) }
            .onChanged { value in
                if value.translation.height < -Self.dismissTravel { model.dismissToast() }
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
