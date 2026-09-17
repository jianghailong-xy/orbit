import Foundation

/// One reading of the transcript scroll view's geometry. SwiftUI's `ScrollGeometry` is Apple-only
/// and these three numbers are all the tail-pinning rule needs, so the decision itself lives here —
/// in the package that builds and tests on Linux.
public struct TailScrollSample: Equatable, Sendable {
    /// Vertical content offset.
    public let offset: Double
    /// Height of the whole content — every laid-out row together.
    public let contentHeight: Double
    /// How much content sits below the viewport's bottom edge. Zero at the live tail.
    public let bottomGap: Double

    public init(offset: Double, contentHeight: Double, bottomGap: Double) {
        self.offset = offset
        self.contentHeight = contentHeight
        self.bottomGap = bottomGap
    }
}

/// Whether the transcript is still following its live tail.
///
/// The gap under the viewport can't answer that on its own: a long transcript replays as a flood of
/// one-event-at-a-time renders and each programmatic scroll is reported a frame late, by which time
/// newer rows have grown the content — so a position-only test reads a large gap and strands the
/// reader above the bottom (web carries the same note in `measure()`). Hence the rule both clients
/// share: a small gap re-pins, and only a scroll UP un-pins.
///
/// What that rule alone misses is content getting SHORTER under a pinned reader: a stretch of
/// reasoning folds to its one-line summary the instant it settles, and a scroll view clamped by
/// content that shrank reports exactly what a finger dragging up reports — an offset that fell. So
/// the transcript stopped following a reply that was still being written, once in every turn that
/// thinks. Telling the two apart needs one more fact per sample (below).
public enum TailPinning {
    /// Within this many points of the end still reads as pinned (web uses the same 80px).
    public static let nearBottom: Double = 80

    /// The pinned state `current` implies, given the sample before it.
    ///
    /// `readerDriven` is whether the reader was moving the scroll view — a finger on it or the
    /// momentum of one — as against it sitting still, or animating to an offset of its own, while
    /// the content was re-laid-out underneath. An offset that falls in that second case is the
    /// clamp, not a reader, so long as the content height moved in the same breath. The height test
    /// has to carry the case by itself on a platform whose scroll gestures report no phase, which
    /// is why a fall with the content unchanged still un-pins whoever caused it.
    public static func pinned(wasPinned: Bool,
                              from previous: TailScrollSample,
                              to current: TailScrollSample,
                              readerDriven: Bool) -> Bool {
        if current.bottomGap <= nearBottom { return true }
        let resized = current.contentHeight != previous.contentHeight
        if current.offset < previous.offset - 1, readerDriven || !resized { return false }
        return wasPinned
    }
}
