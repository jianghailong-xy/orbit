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
/// Notes (owner, 2026-11-12, docs/mocks/ios-search-mode-like-notes). A scroll or a tap elsewhere only
/// lowers the keyboard: the field stays open at the bottom with its X.
///
/// iOS 26 ends search by itself once an empty field loses focus — the list's scroll, the app's
/// tap-to-lower-the-keyboard (`KeyboardDismissInstaller`), a row's push — and reports that the same
/// way as the X: `isPresented` turns false. What tells them apart is the tap just before it:
/// `SearchCloseTap` remembers whether the last tap landed on the search field's own chrome. Any other
/// ending is undone: search mode comes back without the keyboard, at once if the list is the page on
/// screen, or when it is again (a pushed conversation, Settings).
@available(iOS 26.0, *)
private struct BottomSearchMode: ViewModifier {
    @Binding var text: String
    /// Search mode as the reader left it.
    @State private var presented = false
    /// iOS ended search mode while the list was covered; it comes back when the list does.
    @State private var restoreOnReturn = false
    @FocusState private var focused: Bool
    /// The list is the page on screen — nothing pushed over it, no Settings sheet (`CompactShell`).
    @Environment(\.liveRowCues) private var onScreen

    func body(content: Content) -> some View {
        content
            .searchable(text: $text, isPresented: Binding(get: { presented }, set: setPresented),
                        prompt: "Search sessions")
            .searchFocused($focused)
            .toolbar { DefaultToolbarItem(kind: .search, placement: .bottomBar) }
            .onChange(of: onScreen) { _, shown in
                if shown && restoreOnReturn { restore() }
            }
    }

    private func setPresented(_ on: Bool) {
        // iOS reports one ending more than once (the X: probe round 3). Only a change counts, or
        // the repeat — its tap used up — would read as iOS ending search and put it back.
        guard on != presented else { return }
        presented = on
        // Used up on every change, so the tap that opened the field can't pass for a close later.
        let closed = SearchCloseTap.consume()
        if on || closed {
            restoreOnReturn = false
            return
        }
        if onScreen {
            // The next turn: the system is still taking this search down in this one.
            Task { @MainActor in restore() }
        } else {
            restoreOnReturn = true
        }
    }

    /// Search mode back on, the keyboard down.
    private func restore() {
        restoreOnReturn = false
        presented = true
        focused = false
    }
}

/// Whether the last tap in the app landed on the search field's own chrome — the X beside the
/// bottom field above all, in the floating bar it shares with the field — so `BottomSearchMode` can tell the reader closing search from iOS ending
/// it. Fed by the window's tap recognizer (`KeyboardDismissInstaller`), which sees every tap.
enum SearchCloseTap {
    private static var last: (at: Date, onSearch: Bool)?

    static func record(_ touch: UITouch) {
        var view = touch.view
        var onSearch = false
        while let current = view, !onSearch {
            // The X is not a search view: on iOS 26.5 it is a `_UIButtonBarButton` in the bottom
            // bar's `FloatingBarHostingView`, the same bar as the field (and nothing else there).
            let name = String(describing: type(of: current))
            onSearch = current is UISearchBar || name.contains("Search") || name.contains("FloatingBar")
            view = current.superview
        }
        last = (Date(), onSearch)
    }

    /// True once for a search-chrome tap in the last moment; the answer is used up either way.
    static func consume() -> Bool {
        defer { last = nil }
        guard let last else { return false }
        return last.onSearch && Date().timeIntervalSince(last.at) < 1
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
            // stays — `BottomSearchMode` puts it back when iOS ends it for the lost focus.
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
