import SwiftUI
import OrbitKit
#if os(iOS)
import UIKit
import UIKit.UIGestureRecognizerSubclass
#endif

/// The app's one toast surface (docs/mocks/toast-system): the toasts that wait for you, pinned, and
/// the one transient toast under them, ruled by `ToastFeed` and fed by `AppModel.showToast` — row
/// actions directly, worktree outcomes via `ConsoleRegistry.onToast`.
///
/// The shape follows what a toast asks of you (`ToastLevel`). A confirmation or a progress line is a
/// pill that hugs its words; a toast with an Undo to decide on or a diagnostic to read is a card as
/// wide as the content; a failure or an approval is a tinted card that stays until it's dealt with
/// and that nothing posted after it can replace. On a phone that tinted card folds into a pill after
/// six seconds, so it stops covering the page while staying one tap away; wide layouts (iPad, Mac)
/// stack every toast at the top trailing corner instead, as web does, and keep the card open.
/// Tapping a toast that names a session opens it; flicking it up gets rid of it early.
///
/// Top-anchored deliberately. It used to float at the *bottom*, 24pt above the safe area, which on
/// iPhone is squarely inside the composer: the card covered the input row and the model/effort pills,
/// and — being hit-testable, with its own Undo button — swallowed the taps meant for the field for as
/// long as it showed. The keyboard doesn't save it either, since avoidance lifts the toast and the
/// composer together. Web had the same defect and fixed it the same way (see `main.tsx`'s
/// `TOAST_TOP`). Attach once at a root shell; it floats over pushed pages too.
private struct ToastHost: ViewModifier {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    #endif

    /// Clearance for the chrome the toast tucks under. On iOS this modifier sits at the shell root,
    /// *outside* the NavigationStack, so its safe area covers the status bar only and the compact nav
    /// bar (44pt, fixed by UIKit — the console's two-line inline title fits inside it) has to be
    /// cleared by hand. That's measured against the *inline* bar: on a large-title root the pill sits
    /// over the top of the header for the few seconds it shows, which is the better trade — clearing
    /// 96pt everywhere would strand it mid-transcript on the console, where the toast matters most.
    /// On macOS the window's safe area already excludes the toolbar, so it only needs air.
    #if os(iOS)
    private static let topInset: CGFloat = 52
    #else
    private static let topInset: CGFloat = 12
    #endif

    /// How far a toast has to travel before the swipe counts as "get rid of it". Short, because the
    /// gesture only ever goes one way and a tall threshold reads as the toast being stuck — but not
    /// so short that the slack in a tap lands in it (see `swipeAway` on why that matters).
    private static let dismissTravel: CGFloat = 32

    /// The toast under the finger and its live travel. `@GestureState` so it returns to rest on its
    /// own, including when the gesture is cut short by the toast being removed — which is what a
    /// completed swipe does. Keyed by toast, because a pinned card and the transient pill can be on
    /// screen together and only the one being dragged should move.
    @GestureState private var drag: (id: ToastItem.ID?, y: CGFloat) = (nil, 0)

    /// Wide layouts list every pinned card once "+N more" is tapped; otherwise only the newest.
    @State private var allPinned = false

    /// iPad at full width and the Mac: the corner stack. An iPhone, or an iPad split down to compact
    /// width: the centred column with the folding pinned card.
    private var wide: Bool {
        #if os(iOS)
        return sizeClass == .regular
        #else
        return true
        #endif
    }

    func body(content: Content) -> some View {
        content
            .overlay(alignment: wide ? .topTrailing : .top) {
                // The toasts' animation belongs to this container, never to `content`.
                // `.animation(_:value:)` animates *everything* the modifier is attached to, so hanging
                // it off the modified content put the whole shell — the section's NavigationSplitView
                // included — under `.snappy` for any change that landed in the same transaction as a
                // toast change. Tapping a toast is exactly that transaction: `openToastSession` clears
                // the toast and routes to its session in one go, so the collapsed split's push ran as a
                // SwiftUI implicit animation over a UIKit navigation transition and wedged the stack —
                // the frozen screen showing the list and the console composited on top of each other.
                // An always-present container (empty when there's no toast) keeps the insert/remove
                // transitions animated while leaving the shell below on its own transaction.
                ZStack(alignment: wide ? .topTrailing : .top) {
                    VStack(alignment: wide ? .trailing : .center, spacing: 8) {
                        pinned
                        if let toast = model.toasts.transient {
                            transient(toast)
                                .transition(entrance)
                                .id(toast.id)
                        }
                    }
                    .frame(maxWidth: wide ? 360 : 560)
                    .padding(.horizontal, 16)
                    .padding(.top, Self.topInset)
                }
                .animation(reduceMotion ? Animation.easeInOut(duration: 0.2) : Animation.snappy, value: model.toasts)
            }
            #if os(iOS)
            // A failure or an approval arriving is worth feeling; a confirmation of a tap isn't — the
            // tap already said so. Only a newly pinned toast: dismissing one to reveal the next is not
            // news.
            .sensoryFeedback(trigger: model.toasts.pinned.count) { old, new in
                guard new > old, let toast = model.toasts.front else { return nil }
                return toast.tone == .error ? SensoryFeedback.error : SensoryFeedback.warning
            }
            #endif
    }

    /// Slides down from under the bar; with Reduce Motion on, only fades.
    private var entrance: AnyTransition {
        reduceMotion ? AnyTransition.opacity : AnyTransition.move(edge: .top).combined(with: .opacity)
    }

    // MARK: pinned — the toasts that wait for you

    @ViewBuilder private var pinned: some View {
        let feed = model.toasts
        if wide {
            let shown = allPinned ? Array(feed.pinned.reversed()) : Array(feed.pinned.suffix(1))
            ForEach(shown) { toast in
                attentionCard(toast)
                    .offset(y: drag.id == toast.id ? drag.y : 0)
                    .simultaneousGesture(swipeAway(toast.id))
                    .transition(entrance)
            }
            if feed.pinned.count > 1 {
                Button {
                    allPinned.toggle()
                } label: {
                    Text(allPinned ? "Show less" : "+\(feed.pinned.count - 1) more")
                        .font(.footnote.weight(.semibold))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 5)
                        .toastGlass(Capsule(), tint: .red)
                }
                .buttonStyle(.plain)
            }
        } else if let front = feed.front {
            Group {
                if feed.expanded == front.id {
                    attentionCard(front)
                } else {
                    Button { model.unfoldToast(front.id) } label: {
                        ToastPill(toast: front, behind: feed.behindFront, opens: true)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Shows the whole message")
                }
            }
            .offset(y: drag.id == front.id ? drag.y : 0)
            .simultaneousGesture(swipeAway(front.id))
            .transition(entrance)
        }
    }

    /// ③ open: what failed or waits, what it's about, the diagnostic to read or paste, and what to do.
    private func attentionCard(_ toast: ToastItem) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                ToastIcon(toast: toast, card: true)
                ToastCopy(toast: toast, showsDetail: false)
                Button { model.dismissToast(toast.id) } label: {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.secondary)
                        .frame(width: 28, height: 28)
                        .background(Color.primary.opacity(0.08), in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss")
            }
            if let detail = toast.detail {
                // The server's own words, in full and selectable: a failure is usually the thing you
                // want to read twice and paste somewhere.
                Text(detail)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(6)
                    .textSelection(.enabled)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .padding(.leading, 38)
            }
            if toast.opens || toast.detail != nil {
                HStack(spacing: 8) {
                    if toast.opens {
                        if toast.mergeConflict != nil {
                            Button("Resolve in session") { model.resolveToastConflict(toast.id) }
                                .buttonStyle(.borderedProminent)
                        } else {
                            Button(toast.awaitsApproval ? "Review" : "Open session") { model.openToastSession(toast.id) }
                                .buttonStyle(.borderedProminent)
                        }
                    }
                    if let detail = toast.detail {
                        Button("Copy error") { PlatformPasteboard.copyString(detail) }
                            .buttonStyle(.bordered)
                    }
                }
                .buttonBorderShape(.capsule)
                .controlSize(.small)
                .padding(.leading, 38)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .toastGlass(RoundedRectangle(cornerRadius: 22, style: .continuous), tint: ToastStyle.tint(for: toast.tone))
    }

    // MARK: transient — ①, ② and progress

    @ViewBuilder private func transient(_ toast: ToastItem) -> some View {
        Group {
            if toast.level == .result {
                resultCard(toast)
            } else if toast.opens {
                // A confirmation that names a session is the way into it: the pill takes the tap.
                Button { model.openToastSession(toast.id) } label: { ToastPill(toast: toast, opens: true) }
                    .buttonStyle(.plain)
                    .accessibilityHint("Opens the session")
            } else {
                ToastPill(toast: toast, opens: false)
            }
        }
        .offset(y: drag.id == toast.id ? drag.y : 0)
        .simultaneousGesture(swipeAway(toast.id))
        // A pill that names nothing stays pass-through rather than eating scrolls and taps on the page
        // beneath it for its three seconds — and, being pass-through, isn't swipeable either, which is
        // the right trade for a toast that blocks nothing and is gone in three seconds anyway.
        .allowsHitTesting(toast.level == .result || toast.opens)
        .onHover { hovering in hovering ? model.holdToast(toast.id) : model.releaseToast(toast.id) }
        #if os(iOS)
        .background {
            ToastTouchHold { holding in
                holding ? model.holdToast(toast.id) : model.releaseToast(toast.id)
            }
        }
        #endif
    }

    /// ② A card: the outcome, what it was about, and the one thing you might do about it.
    private func resultCard(_ toast: ToastItem) -> some View {
        HStack(spacing: 12) {
            ToastIcon(toast: toast, card: true)
            // The copy doubles as the way into the session it reports on. It's the copy — not the
            // whole card — so Undo keeps its own target, and it takes the full width so the tap lands
            // anywhere along the row.
            if toast.opens {
                Button { model.openToastSession(toast.id) } label: { ToastCopy(toast: toast, showsDetail: true) }
                    .buttonStyle(.plain)
                    .accessibilityHint("Opens the session")
            } else {
                ToastCopy(toast: toast, showsDetail: true)
            }
            if toast.canUndo {
                Button("Undo") { model.undoSessionAction(toast.id) }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .controlSize(.small)
            }
        }
        .padding(.vertical, 12)
        .padding(.leading, 14)
        .padding(.trailing, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .toastGlass(RoundedRectangle(cornerRadius: 22, style: .continuous), tint: nil)
    }

    // MARK: swipe

    /// Flick a toast up and it goes, the way a notification banner does. Without it the only ways out
    /// are a ③'s ✕ and the 3–6s timer everything else leaves on, so a toast that lands over the part
    /// of the page you're reading just has to be waited out.
    ///
    /// Up only: toasts are anchored to the top, so there's nowhere to push one down to — a downward
    /// drag holds it at rest rather than dragging it over the content it's already covering.
    ///
    /// Two things about the shape of this, both because the copy is a `Button` covering nearly the
    /// whole toast. It's a `simultaneousGesture`, since a child button otherwise claims the touch and
    /// the container's drag never starts. And the dismissal fires from `onChanged` the moment the
    /// threshold is crossed, not on release: that takes the Button out of the hierarchy while the
    /// finger is still down, so a swipe can't also land as a tap and open the session behind it.
    /// Below the threshold there's no such protection, which is why it sits above a tap's slack.
    ///
    /// Measured globally, not in the toast's own space: the toast is `.offset` by the very travel this
    /// sets, and a local translation read from a frame that moves with it feeds each displacement back
    /// into the next reading (the drawer's `closeDrag` documents the stutter that produces).
    private func swipeAway(_ id: ToastItem.ID) -> some Gesture {
        DragGesture(minimumDistance: 10, coordinateSpace: .global)
            .updating($drag) { value, state, _ in state = (id: id, y: min(0, value.translation.height)) }
            .onChanged { value in
                if value.translation.height < -Self.dismissTravel { model.dismissToast(id) }
            }
    }
}

#if os(iOS)
/// Observes touch-down without claiming a gesture: the pill's tap and swipe still belong to SwiftUI,
/// and a confirmation without a session keeps passing taps through to the page underneath it.
private struct ToastTouchHold: UIViewRepresentable {
    let onHoldingChanged: (Bool) -> Void

    func makeUIView(context: Context) -> ToastTouchView { ToastTouchView() }

    func updateUIView(_ view: ToastTouchView, context: Context) {
        view.observer.onHoldingChanged = onHoldingChanged
    }

    static func dismantleUIView(_ view: ToastTouchView, coordinator: ()) { view.detach() }

    final class ToastTouchView: UIView {
        let observer = TouchObserver(target: nil, action: nil)
        private weak var observedWindow: UIWindow?

        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
            observer.toastView = self
            observer.cancelsTouchesInView = false
            observer.delaysTouchesBegan = false
            observer.delaysTouchesEnded = false
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            detach()
            observedWindow = window
            window?.addGestureRecognizer(observer)
        }

        func detach() {
            observer.release()
            observedWindow?.removeGestureRecognizer(observer)
            observedWindow = nil
        }
    }

    final class TouchObserver: UIGestureRecognizer {
        weak var toastView: UIView?
        var onHoldingChanged: (Bool) -> Void = { _ in }
        private var heldTouch: UITouch?

        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
            guard heldTouch == nil, let view = toastView,
                  let touch = touches.first(where: { view.point(inside: $0.location(in: view), with: event) }) else { return }
            heldTouch = touch
            onHoldingChanged(true)
        }

        override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
            guard let heldTouch, touches.contains(heldTouch) else { return }
            release()
            // Never recognize: observing the finger must not take a tap away from the toast's Button.
            state = .failed
        }

        override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
            release()
            state = .failed
        }

        override func reset() {
            super.reset()
            release()
        }

        override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool { false }
        override func canBePrevented(by preventingGestureRecognizer: UIGestureRecognizer) -> Bool { false }

        func release() {
            guard heldTouch != nil else { return }
            heldTouch = nil
            onHoldingChanged(false)
        }
    }
}
#endif

// MARK: - The pieces

/// A pill: one line — two when it names what it happened to — hugging its words. ① a confirmation,
/// a progress line with its spinner, or a folded ③ with the count of the others behind it.
private struct ToastPill: View {
    let toast: ToastItem
    /// How many pinned toasts wait behind this one (a folded ③ only).
    var behind: Int = 0
    /// Whether a tap does something: draws the chevron that says so.
    var opens: Bool

    var body: some View {
        HStack(spacing: 8) {
            ToastIcon(toast: toast, card: false)
            VStack(alignment: .leading, spacing: 1) {
                Text(toast.message)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                if let line = toast.subtitle {
                    Text(line)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            if behind > 0 {
                Text("+\(behind)")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.red)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 1)
                    .background(Color.red.opacity(0.14), in: Capsule())
            }
            if opens {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.leading, 10)
        .padding(.trailing, 16)
        .frame(minHeight: toast.subtitle == nil ? 40 : 52)
        .frame(maxWidth: 300)
        .fixedSize(horizontal: false, vertical: true)
        .toastGlass(Capsule(), tint: toast.level == .attention ? ToastStyle.tint(for: toast.tone) : nil)
        .contentShape(Capsule())
    }
}

/// The outcome, what it happened to, and — on a card — the diagnostic: web's reading order. Leading,
/// not centred — a centred block reads badly the moment it wraps — and as wide as the card allows,
/// so a trailing button sits at the edge and a tap lands anywhere along the row.
private struct ToastCopy: View {
    let toast: ToastItem
    let showsDetail: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(toast.message)
                .font(.subheadline.weight(.semibold))
            if let line = toast.subtitle {
                Text(line)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            if showsDetail, let detail = toast.detail {
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(4)
            }
        }
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

/// The tone's glyph — or the caller's own, so "Moved to Trash" still shows the trash it came from —
/// and the system spinner while work is under way.
private struct ToastIcon: View {
    let toast: ToastItem
    let card: Bool

    var body: some View {
        if toast.level == .progress {
            ProgressView()
                .controlSize(.small)
                .frame(width: card ? 26 : 22, height: card ? 26 : 22)
        } else {
            Image(systemName: toast.icon ?? ToastStyle.icon(for: toast.tone))
                .font(card ? Font.title2 : Font.title3)
                .foregroundStyle(ToastStyle.color(for: toast.tone))
                .accessibilityHidden(true)
        }
    }
}

private enum ToastStyle {
    /// Tone → glyph, matching what web's card shows for the same outcome.
    static func icon(for tone: ToastTone) -> String {
        switch tone {
        case .success: return "checkmark.circle.fill"
        case .neutral: return "info.circle.fill"
        case .info:    return "info.circle.fill"
        case .warning: return "exclamationmark.circle.fill"
        case .error:   return "xmark.circle.fill"
        }
    }

    static func color(for tone: ToastTone) -> Color {
        switch tone {
        case .success: return .green
        case .neutral: return .secondary
        case .info:    return .accentColor
        case .warning: return .orange
        case .error:   return .red
        }
    }

    /// The tint a ③ card's glass takes: red for a failure, orange for something waiting on you.
    static func tint(for tone: ToastTone) -> Color? {
        switch tone {
        case .error:   return .red
        case .warning: return .orange
        default:       return nil
        }
    }
}

private extension View {
    /// iOS 26's Liquid Glass — the toolbar's own material — so a toast reads as chrome over the page
    /// rather than as a grey slab of it, tinted for a ③. Earlier systems get the regular material with
    /// a tint wash, a hairline edge (`.primary`, so it inverts with the appearance) and a soft shadow.
    @ViewBuilder func toastGlass<S: InsettableShape>(_ shape: S, tint: Color?) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            glassEffect(Glass.regular.tint(tint?.opacity(0.22)), in: shape)
        } else {
            background {
                shape.fill(.regularMaterial)
                    .overlay(shape.fill((tint ?? .clear).opacity(0.12)))
                    .overlay(shape.strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.7))
                    .shadow(color: .black.opacity(0.16), radius: 12, y: 4)
            }
        }
    }
}

extension View {
    /// Floats the app's toasts ("Session completed … Undo", "Merged into main", a failure that waits
    /// for you) under the nav bar. Attach once at a root shell.
    func toastHost() -> some View { modifier(ToastHost()) }
}
