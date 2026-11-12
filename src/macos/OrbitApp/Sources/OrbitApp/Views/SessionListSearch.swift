import SwiftUI
import OrbitKit

#if os(iOS)
extension View {
    /// The session list's search field. On the phone it sits in the bottom toolbar, where a thumb
    /// reaches it, and `revealsBottomSearchOnScroll` on the list moves it out of the way while the
    /// list is read downward. iOS 26 is the first to draw a search field there; before it, and in the
    /// iPad's column, the field keeps the drawer under the navigation bar (see `AgentContentColumn`
    /// for why that drawer is `.always`).
    @ViewBuilder
    func sessionListSearch(text: Binding<String>, fromBottom: Bool, isEnabled: Bool = true) -> some View {
        if !isEnabled {
            self
        } else if #available(iOS 26.0, *), fromBottom {
            modifier(BottomSearchMode(text: text))
        } else {
            searchable(text: text, placement: .navigationBarDrawer(displayMode: .always),
                       prompt: "Search sessions")
        }
    }

    /// Hides the bottom search field while the list scrolls down and brings it back as soon as the
    /// list heads up again (`BottomSearchReveal`). Applied to the scrolling list itself, and a no-op
    /// wherever the field isn't at the bottom — pass the same `fromBottom` as `sessionListSearch`.
    @ViewBuilder
    func revealsBottomSearchOnScroll(query: String, enabled: Bool) -> some View {
        if #available(iOS 26.0, *), enabled {
            modifier(BottomSearchScrollReveal(query: query))
        } else {
            self
        }
    }
}

/// The bottom field's search mode, which ends only at its close button (the X beside it), as in
/// Notes (owner, 2026-11-12, docs/mocks/ios-search-mode-like-notes). A scroll, a tap elsewhere or a
/// pushed page only lowers the keyboard: the field stays open at the bottom with its X.
///
/// Measured on the iOS 26.5 simulator (probe rounds 1–5): with `isPresented` held here, iOS no longer
/// ends search when the field loses focus — that was the reported bug, under a bare `searchable`. But
/// the X then ends it only while the keyboard is down; with the keyboard up the X merely lowers it,
/// and iOS writes `isPresented = true` twice. So a press of the X (`SearchCloseTap`) ends search mode
/// whatever iOS writes, and clears the query as the X does with the keyboard down.
@available(iOS 26.0, *)
private struct BottomSearchMode: ViewModifier {
    @Binding var text: String
    @State private var presented = false

    func body(content: Content) -> some View {
        content
            .searchable(text: $text, isPresented: Binding(get: { presented }, set: setPresented),
                        prompt: "Search sessions")
            .toolbar { DefaultToolbarItem(kind: .search, placement: .bottomBar) }
    }

    private func setPresented(_ on: Bool) {
        if SearchCloseTap.recent() {
            presented = false
            text = ""
        } else {
            presented = on
        }
    }
}

/// Whether the reader just pressed the X beside the bottom search field (`BottomSearchMode`). Fed by
/// the window's tap recognizer (`KeyboardDismissInstaller`), which sees every tap.
///
/// On iOS 26.5 the X is a `_UIButtonBarButton` in the bottom bar's `FloatingBarHostingView`, the
/// bar it shares with the field and nothing else; a tap in that bar outside the text field is the X.
/// Any other tap forgets it, so tapping the field again right after the X opens search as usual.
enum SearchCloseTap {
    private static var lastClose: Date?

    static func record(_ touch: UITouch) {
        var view = touch.view
        var inBar = false
        var inField = false
        while let current = view {
            inField = inField || current is UITextField
            let name = String(describing: type(of: current))
            inBar = inBar || current is UISearchBar || name.contains("FloatingBar")
            view = current.superview
        }
        lastClose = inBar && !inField ? Date() : nil
    }

    /// The X was pressed in the last moment: what iOS writes right after it is the X's doing.
    static func recent() -> Bool {
        guard let lastClose else { return false }
        return Date().timeIntervalSince(lastClose) < 1.5
    }
}

/// The scroll side of the bottom search field. The rule is the tested `BottomSearchReveal`; this only
/// feeds it the list's movement and shows or hides the bottom toolbar the field is in.
///
/// The field stays put whatever the scroll says while it is in use — focused, or holding a query
/// whose hits are on screen — and while VoiceOver runs, which can't find a control that comes and
/// goes with a scroll (Material's hide-on-scroll bar stands still under TalkBack for the same reason).
/// The system draws the change itself, and on the iOS 26.5 simulator that is a dissolve: the glass
/// blurs and fades where it stands rather than sliding off, so Reduce Motion needs no path of its own.
@available(iOS 26.0, *)
private struct BottomSearchScrollReveal: ViewModifier {
    let query: String
    @Environment(\.isSearching) private var isSearching
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    /// What the rule last decided — the one fact here that redraws anything.
    @State private var revealed = true
    /// The rule and the scroll phase it reads. Both change on every frame of a scroll, so they live
    /// in a reference nothing observes, as the transcript's `QuestionRuler` does.
    @State private var tracker = Tracker()

    private final class Tracker {
        var rule = BottomSearchReveal()
        /// A finger on the list, or the momentum of one. `.animating` is SwiftUI moving it and
        /// `.idle` is rows re-laid-out under a still list: neither says where the reader is heading.
        var readerDriven = false
    }

    func body(content: Content) -> some View {
        content
            // As in Notes: reading on lowers the keyboard (a List alone keeps it up), and search mode
            // stays (`BottomSearchMode`).
            .scrollDismissesKeyboard(.immediately)
            .onScrollPhaseChange { _, phase in
                tracker.readerDriven = phase != .idle && phase != .animating
            }
            .onScrollGeometryChange(for: ListScrollSample.self) { geo in
                ListScrollSample(offset: Double(geo.contentOffset.y + geo.contentInsets.top),
                                 contentHeight: Double(geo.contentSize.height),
                                 visibleBottom: Double(geo.visibleRect.maxY))
            } action: { _, sample in
                tracker.rule.scrolled(to: sample, readerDriven: tracker.readerDriven)
                show(tracker.rule.isShown)
            }
            // Back from a session the list is where it was left, and the field comes back with it.
            .onAppear { reveal() }
            // A search that just ended leaves the field showing until the list is read on.
            .onChange(of: isSearching) { _, searching in
                if !searching { reveal() }
            }
            .toolbarVisibility(revealed || isSearching || !query.isEmpty || voiceOver ? .visible : .hidden,
                               for: .bottomBar)
    }

    private func reveal() {
        tracker.rule.reveal()
        show(true)
    }

    private func show(_ shown: Bool) {
        guard shown != revealed else { return }
        withAnimation { revealed = shown }
    }
}
#endif
