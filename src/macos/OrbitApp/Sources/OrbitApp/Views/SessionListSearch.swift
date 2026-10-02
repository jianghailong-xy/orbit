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
    func sessionListSearch(text: Binding<String>, fromBottom: Bool) -> some View {
        if #available(iOS 26.0, *), fromBottom {
            searchable(text: text, prompt: "Search sessions")
                .toolbar { DefaultToolbarItem(kind: .search, placement: .bottomBar) }
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
