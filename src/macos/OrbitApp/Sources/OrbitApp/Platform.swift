import SwiftUI
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

// Cross-platform shims so the shared SwiftUI layer compiles for both the macOS shell (this SPM
// package) and the iOS shell (the src/ios Xcode target, which references these same files). Only
// the handful of AppKit/UIKit touch-points differ — images, the pasteboard, a dynamic colour, and
// one macOS-only menu style — so they live here behind a single alias/helper instead of being
// scattered as `#if os(...)` islands across every view.

#if os(macOS)
/// The platform bitmap image type: `NSImage` on macOS, `UIImage` on iOS. Both expose `init?(data:)`.
typealias PlatformImage = NSImage
#elseif os(iOS)
typealias PlatformImage = UIImage
#endif

extension Image {
    /// `Image(nsImage:)` / `Image(uiImage:)` behind one name.
    init(platformImage: PlatformImage) {
        #if os(macOS)
        self.init(nsImage: platformImage)
        #elseif os(iOS)
        self.init(uiImage: platformImage)
        #endif
    }
}

extension PlatformImage {
    /// Re-encode to PNG. The clipboard/screenshot bytes commonly arrive as TIFF or JPEG, neither of
    /// which the server accepts as an inline image; PNG is in `Attachments.allowedImageTypes`.
    func orbitPNGData() -> Data? {
        #if os(macOS)
        guard let tiff = tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { return nil }
        return rep.representation(using: .png, properties: [:])
        #elseif os(iOS)
        return pngData()
        #endif
    }
}

/// Copy plain text to the system pasteboard — `NSPasteboard` on macOS, `UIPasteboard` on iOS.
enum PlatformPasteboard {
    static func copyString(_ s: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s, forType: .string)
        #elseif os(iOS)
        UIPasteboard.general.string = s
        #endif
    }
}

/// Fire a one-shot success haptic on iOS (e.g. to confirm a copy, where there's no hover/tooltip to
/// lean on); a no-op on macOS, which has no haptic engine on the app surface.
enum PlatformHaptics {
    static func success() {
        #if os(iOS)
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        #endif
    }
}

extension Color {
    /// A colour that resolves to `light` or `dark` per the active appearance. SwiftUI has no
    /// built-in light/dark `Color`, so this bridges through the platform colour's dynamic provider.
    init(light: Color, dark: Color) {
        #if os(macOS)
        self.init(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? NSColor(dark) : NSColor(light)
        })
        #elseif os(iOS)
        self.init(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark ? UIColor(dark) : UIColor(light)
        })
        #endif
    }

    /// The editor/text-field surface: macOS's `.textBackgroundColor`, iOS's system background.
    /// Used for the composer's rounded field so it reads as a distinct surface (with its border
    /// and shadow) on both platforms.
    static var editorSurface: Color {
        #if os(macOS)
        Color(nsColor: .textBackgroundColor)
        #else
        Color(uiColor: .systemBackground)
        #endif
    }

    /// The unified content backdrop for the middle + detail panes: a soft off-white (light) / soft
    /// near-black (dark), deliberately *not* the flat system `windowBackgroundColor` (a colder grey).
    /// The sidebar keeps its native translucency, so this calm solid tone behind the content lets
    /// the frosted sidebar read by contrast — the restrained "ChatGPT" look (vibrant rail + soft
    /// content) rather than a whole-window desktop blur.
    static var orbitSurface: Color {
        Color(light: Color(red: 0.965, green: 0.965, blue: 0.957),
              dark:  Color(red: 0.12,  green: 0.12,  blue: 0.13))
    }

    /// The transcript's floating scroll-to-latest puck. Light: plain white, lifted off the near-white
    /// transcript by its shadow alone. Dark: deliberately *not* the transcript's own near-black — an
    /// opaque black disc on a black backdrop, edged by a black shadow, is invisible — but a raised grey
    /// that reads as a disc unaided. Lighter than both dark backdrops it sits on (iOS's black system
    /// background and macOS's `orbitSurface`).
    static var floatingDiscSurface: Color {
        Color(light: .white, dark: Color(red: 0.18, green: 0.18, blue: 0.19))
    }
}

extension View {
    /// The composer's borderless menu chrome. macOS has `BorderlessButtonMenuStyle`; iOS has no
    /// equivalent, so there it falls back to the default menu style (a plain tappable label).
    @ViewBuilder func borderlessMenuStyle() -> some View {
        #if os(macOS)
        self.menuStyle(.borderlessButton)
        #else
        self
        #endif
    }

    /// macOS: paint the unified soft `orbitSurface` behind a content/detail pane, so the panes read
    /// as one calm surface and the translucent sidebar stands out by contrast. No-op on iOS/iPadOS,
    /// which keep their own native pane backgrounds — this unification is macOS-only.
    @ViewBuilder func orbitPaneBackground() -> some View {
        #if os(macOS)
        self.background(Color.orbitSurface)
        #else
        self
        #endif
    }

    /// macOS: hide a `List`/`Form`'s own scroll background so the `orbitPaneBackground` behind it
    /// shows through, unifying the pane surface. No-op on iOS/iPadOS.
    @ViewBuilder func orbitRevealSurface() -> some View {
        #if os(macOS)
        self.scrollContentBackground(.hidden)
        #else
        self
        #endif
    }

    /// Pin a `Menu`'s label to a neutral tint on iOS. Because `borderlessMenuStyle()` is a no-op there
    /// (iOS has no borderless menu style), the fallback tints the whole label with the accent color
    /// like a button — which turned the composer's footer pickers and the `+` into a patchwork of
    /// accent-blue controls jammed beside the neutral agent-name / usage metadata, and silently
    /// diverged from macOS (where `.borderlessButton` honors the label's own `.foregroundStyle`). A
    /// label-level `.foregroundStyle` can't override the menu's tint on iOS, so set the tint itself.
    /// Keeping these neutral reserves the accent for the one primary action (send) and the usage bar.
    @ViewBuilder func neutralMenuTint(_ tint: Color = .primary) -> some View {
        #if os(iOS)
        self.tint(tint)
        #else
        self
        #endif
    }

    /// Shared chrome for the three composer-footer pickers (permission / model / effort). Factored
    /// out so the iOS-only rendering fix lives in one place: on iOS the `Menu` deliberately OMITS
    /// `.fixedSize()`. `.fixedSize()` on a `Menu` whose label is content-sized triggers a SwiftUI bug
    /// — after the menu is opened and dismissed the control collapses to zero width (its label stops
    /// repainting), leaving a blank gap where the picker was until some unrelated later re-render
    /// repaints it (the reported "the picker vanishes for a few seconds after I open it"). The `+`
    /// menu is immune because its label carries an explicit 34×34 frame, so it never measures zero;
    /// these labels are content-sized, so `.fixedSize()` pins them to a momentarily-zero measurement.
    /// Without it the `Menu` is content-sized normally; a high layout priority keeps the short labels
    /// from truncating under pressure (the flexible agent name beside them yields first). macOS keeps
    /// `.fixedSize()` — its `.borderlessButton` style relies on it and the bug doesn't occur there.
    @ViewBuilder func footerMenuChrome() -> some View {
        #if os(iOS)
        self.borderlessMenuStyle().menuIndicator(.hidden).neutralMenuTint().layoutPriority(1)
        #else
        self.borderlessMenuStyle().menuIndicator(.hidden).fixedSize()
        #endif
    }

    /// iOS: install the "tap outside a text field lowers the keyboard" convention the transcript was
    /// missing. A SwiftUI `simultaneousGesture` on the `List` is unreliable — the collection view's
    /// own recognizers swallow taps that land on a row, so tapping a message never fired one. A
    /// `UITapGestureRecognizer` on the host window is reliable where the SwiftUI gesture isn't. Attach
    /// once at the app root; no-op on macOS (no software keyboard). See `KeyboardDismissInstaller`.
    @ViewBuilder func dismissesKeyboardOnBackgroundTap() -> some View {
        #if os(iOS)
        self.background(KeyboardDismissInstaller())
        #else
        self
        #endif
    }

    /// A link-style button — borderless blue text. macOS has `.link`; iOS has no `LinkButtonStyle`,
    /// so it approximates with a plain button tinted to the accent colour.
    @ViewBuilder func linkButtonStyle() -> some View {
        #if os(macOS)
        self.buttonStyle(.link)
        #else
        self.buttonStyle(.plain).foregroundStyle(Color.accentColor)
        #endif
    }

    /// Drop the hairline macOS draws under the title bar / toolbar once content scrolls beneath it,
    /// so the top chrome reads as a single seamless bar floating over the content (ChatGPT-style)
    /// instead of a boxed row with a hard rule under it. It's a window property, so setting it once
    /// at the root covers every section's toolbar. No-op on iOS (no window titlebar there).
    @ViewBuilder func hidesTitlebarSeparator() -> some View {
        #if os(macOS)
        self.background(TitlebarSeparatorRemover())
        #else
        self
        #endif
    }
}

#if os(macOS)
/// Reaches the hosting `NSWindow` to clear its title-bar separator. `viewDidMoveToWindow` is the
/// reliable hook — the window isn't attached yet inside `makeNSView`.
private struct TitlebarSeparatorRemover: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { HookView() }
    func updateNSView(_ nsView: NSView, context: Context) {}

    private final class HookView: NSView {
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            window?.titlebarSeparatorStyle = .none
        }
    }
}
#endif

#if os(iOS)
/// Adds a single window-level tap recognizer that lowers the keyboard on a tap outside any text
/// input — the iOS convention the transcript needs (a SwiftUI gesture on the `List` doesn't fire on
/// row taps). The backing view exists only to reach the `UIWindow`; the recognizer, owned by the
/// coordinator (retained for the representable's lifetime), does the work.
private struct KeyboardDismissInstaller: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> InstallerView { InstallerView(coordinator: context.coordinator) }
    func updateUIView(_ uiView: InstallerView, context: Context) {}

    /// Installs on `didMoveToWindow` — the reliable hook: the window is nil during init/makeUIView but
    /// set the moment the view joins the hierarchy. (Doing it in `updateUIView` could miss if the
    /// first update fires before the window is attached.)
    final class InstallerView: UIView {
        private let coordinator: Coordinator
        init(coordinator: Coordinator) {
            self.coordinator = coordinator
            super.init(frame: .zero)
            isUserInteractionEnabled = false   // never intercept touches itself
        }
        required init?(coder: NSCoder) { fatalError("not used") }
        override func didMoveToWindow() {
            super.didMoveToWindow()
            if let window { coordinator.install(on: window) }
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        private static let recognizerName = "orbit.keyboardDismissTap"

        func install(on window: UIWindow) {
            // Idempotent: re-joining a window must not stack duplicate recognizers.
            if window.gestureRecognizers?.contains(where: { $0.name == Self.recognizerName }) == true { return }
            let tap = UITapGestureRecognizer(target: self, action: #selector(dismiss))
            tap.name = Self.recognizerName
            tap.cancelsTouchesInView = false   // the same tap still reaches buttons, list rows, scrolling
            tap.delegate = self
            window.addGestureRecognizer(tap)
        }

        @objc private func dismiss() {
            UIApplication.shared.sendAction(
                #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        }

        // Never block another recognizer (scroll, buttons, the drawer's swipes) — only observe taps.
        func gestureRecognizer(_ g: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

        // Ignore taps that land inside a text input, so tapping the composer field to move the cursor
        // keeps focus instead of dismissing-then-refocusing (a keyboard flicker).
        func gestureRecognizer(_ g: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            var view = touch.view
            while let current = view {
                if current is UITextField || current is UITextView { return false }
                view = current.superview
            }
            return true
        }
    }
}
#endif
