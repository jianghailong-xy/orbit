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

    /// Whether the platform says who moved the transcript, which decides what a fallen offset has to
    /// explain before it may un-pin the tail.
    ///
    /// The distinction is not cosmetic. A fall with the content unchanged is *evidence* of a reader
    /// only where the platform reports nothing about drags: on iOS the List reports them (measured
    /// with a synthesized drag on iOS 26.5: `interacting` → `decelerating` → `idle`, with the offset
    /// following the finger), so there a fall nobody is driving is the LIST's own doing — its
    /// adjustment for a row that changed height under a reader who is behind the tail, which is the
    /// app's normal state while a reply streams. Reading that as a reader is how the transcript
    /// stopped following a reply that was still being written, once in every turn that thinks.
    public enum ReaderEvidence: Equatable, Sendable {
        /// The platform reports the reader's own drags and coasts, so a reader-driven fall is a
        /// fact rather than an inference.
        case reported
        /// The platform reports nothing usable, so geometry is the only evidence there is: a fall
        /// over content that did not resize in the same breath.
        case inferred
    }

    /// The pinned state `current` implies, given the sample before it.
    ///
    /// `readerDriven` is whether the reader was moving the scroll view — a finger on it or the
    /// momentum of one — as against it sitting still, or animating to an offset of its own, while
    /// the content was re-laid-out underneath. An offset that falls in that second case is the
    /// clamp, not a reader, so long as the content height moved in the same breath.
    ///
    /// Where the platform reports drags (`.reported`), that is the whole test: a fall nobody is
    /// driving keeps the tail pinned, whatever the content did in between — including a resize that
    /// was reported in an EARLIER sample than the offset movement it caused, which is the hole the
    /// height test cannot see (`!resized` reads that as a reader). Where it reports nothing
    /// (`.inferred`), the height test has to carry the case by itself, which is why a fall with the
    /// content unchanged still un-pins whoever caused it. Callers that pass no evidence get the
    /// inferred rule, which is the behaviour both clients had before this axis existed.
    public static func pinned(wasPinned: Bool,
                              from previous: TailScrollSample,
                              to current: TailScrollSample,
                              readerDriven: Bool,
                              evidence: ReaderEvidence = .inferred) -> Bool {
        if current.bottomGap <= nearBottom { return true }
        guard current.offset < previous.offset - 1 else { return wasPinned }
        switch evidence {
        case .reported:
            return readerDriven ? false : wasPinned
        case .inferred:
            return (readerDriven || current.contentHeight == previous.contentHeight) ? false : wasPinned
        }
    }
}
