import Foundation

/// One reading of the session list's scroll position, in points. SwiftUI's `ScrollGeometry` is
/// Apple-only and these three numbers are all `BottomSearchReveal` needs, so the rule lives here — in
/// the package that builds and tests on Linux, as `TailPinning` does for the transcript.
public struct ListScrollSample: Equatable, Sendable {
    /// How far the list has scrolled from its top: 0 there, negative while it is pulled past it.
    public let offset: Double
    /// Height of the whole content.
    public let contentHeight: Double
    /// The viewport's bottom edge in content coordinates — content that reaches it is on screen,
    /// even if a bar is floating over it.
    public let visibleBottom: Double

    public init(offset: Double, contentHeight: Double, visibleBottom: Double) {
        self.offset = offset
        self.contentHeight = contentHeight
        self.visibleBottom = visibleBottom
    }
}

/// Whether the phone's session list shows its bottom search field.
///
/// The field sits at the bottom where a thumb reaches it, but one that never leaves covers the last
/// rows on every screen. So it gets out of the way while you read down the list and comes back the
/// moment you head back up, as Safari's toolbar, iOS 26's minimizing tab bar and Material's
/// hide-on-scroll bottom bar do. It is always there where there is nothing to get out of the way
/// of — at the top, at the end, and on a list too short to scroll, which is both and which no scroll
/// could otherwise bring it back to.
public struct BottomSearchReveal: Equatable, Sendable {
    /// A run down the list this long hides the field: about a third of a row, so a nudge doesn't.
    public static let hideAfter = 24.0
    /// A run back up this long brings it back. Shorter than `hideAfter`: getting the field back is
    /// the point of heading up, getting rid of it only a side effect of reading.
    public static let showAfter = 12.0
    /// This close to the top or to the end counts as being there.
    public static let edge = 1.0

    public private(set) var isShown = true
    /// The offset of the sample before, where the next one's movement is measured from.
    private var lastOffset: Double?
    /// How far the list has moved in the direction it is going now: positive down, negative up.
    private var run = 0.0

    public init() {}

    /// Take the next sample. `readerDriven` is whether someone is moving the list — a finger on it,
    /// or the momentum of one. An offset that moves without that is the list's own doing (rows
    /// re-laid-out, a programmatic scroll) and says nothing about where the reader is heading.
    public mutating func scrolled(to sample: ListScrollSample, readerDriven: Bool) {
        defer { lastOffset = sample.offset }
        if sample.offset <= Self.edge || sample.visibleBottom >= sample.contentHeight - Self.edge {
            isShown = true
            run = 0
            return
        }
        guard readerDriven, let lastOffset else {
            run = 0
            return
        }
        let moved = sample.offset - lastOffset
        guard moved != 0 else { return }
        run = (moved > 0) == (run > 0) ? run + moved : moved
        if run >= Self.hideAfter {
            isShown = false
        } else if run <= -Self.showAfter {
            isShown = true
        }
    }

    /// Show the field wherever the list is — coming back to it from a session, or after a search.
    public mutating func reveal() {
        isShown = true
        run = 0
    }
}
