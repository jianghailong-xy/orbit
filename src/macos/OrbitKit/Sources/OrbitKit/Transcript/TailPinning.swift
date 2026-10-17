import Foundation

/// One reading of the transcript scroll view's geometry. SwiftUI's `ScrollGeometry` is Apple-only
/// and these five numbers are all the tail-pinning rules need, so the decisions themselves live
/// here — in the package that builds and tests on Linux.
public struct TailScrollSample: Equatable, Sendable {
    /// Vertical content offset.
    public let offset: Double
    /// Height of the whole content — every laid-out row together.
    public let contentHeight: Double
    /// How much content sits below the viewport's bottom edge. Zero at the live tail.
    public let bottomGap: Double
    /// How far the content is inset from the viewport's top edge: the bars laid over the list, the
    /// sticky "↑ Your question" header among them. A bar that arrives pushes the rows down by what
    /// it adds here, and the tail with them, without anybody scrolling.
    public let topInset: Double
    /// How far the content is inset from the viewport's bottom edge: what floats over the list's
    /// bottom — the composer band where it floats (iOS 26), and the keyboard under it. Zero where the
    /// list ends at its band. A bar that grows there lifts the floor the tail rests on.
    public let bottomInset: Double

    public init(offset: Double, contentHeight: Double, bottomGap: Double, topInset: Double = 0,
                bottomInset: Double = 0) {
        self.offset = offset
        self.contentHeight = contentHeight
        self.bottomGap = bottomGap
        self.topInset = topInset
        self.bottomInset = bottomInset
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

    /// Whether a pinned transcript should be carried back to its tail because the VIEWPORT changed
    /// size under it — the keyboard rising and covering the last line, the composer growing a line,
    /// a phone's chrome folding away.
    ///
    /// `pinned` answers "did the reader leave the tail?" and says nothing about the other direction:
    /// the tail leaving the reader. A pinned transcript whose container shrinks keeps its content
    /// offset — nothing in a `List` re-anchors the bottom on a resize — so the last line ends up
    /// below the fold and stays there until the next publish happens to re-pin it, which in a quiet
    /// session is never. The owner's report: focus the composer and the conversation is no longer at
    /// the bottom.
    ///
    /// Web decides this with a `ResizeObserver` on the scroller (`WorkspaceView.tsx`: "Re-pin to the
    /// tail on any such resize while the user is still at the bottom"), off the same pin. Kept here
    /// beside it so a client whose platform reports the viewport's height asks the same question —
    /// and so what "the viewport moved" means has one definition. 0 is "not measured yet", which no
    /// real viewport is: an unknown is never a resize.
    public static func followsResize(wasPinned: Bool,
                                     from previousHeight: Double,
                                     to currentHeight: Double) -> Bool {
        guard wasPinned, previousHeight > 0, currentHeight > 0 else { return false }
        return currentHeight != previousHeight
    }

    /// Points of play in where the offset ends up: this far from where the geometry carried it is
    /// still the geometry's doing. A push is not exactly the inset it answers to once both are
    /// rounded to the screen's pixels (measured on a Mac: a 30pt header moved the offset 29).
    static let slop: Double = 2

    /// Under a pixel at any scale the clients draw at (a third of a point on a 3x phone): a tail this
    /// close is in place, and no rounding error reads as a gap. Anything more is followed to the
    /// point — the last frame of the header's push moved a Mac's offset 2pt (274 against a tail at
    /// 276), and a tail left that short stays short.
    static let subpixel: Double = 0.25

    /// Whether a pinned transcript should be carried back to its tail because the scroll GEOMETRY
    /// changed under it while nothing was moving it: the content measured to a new height, or a bar
    /// arriving over the list — the sticky "↑ Your question" header — and pushing its rows down.
    ///
    /// Neither is the viewport resizing (`followsResize`) or the reader leaving the tail (`pinned`),
    /// and together they left a long conversation opened at its tail short of it, its last line in
    /// the composer's fade. On an iPhone the header arrives after the first pin and pushes the rows
    /// down by its height (measured: offset 692 against a tail at 724, every time); on a Mac the
    /// rows start at estimated heights, the pin lands on the estimate, the content grows as the rows
    /// on screen are measured (44pt), and then the header pushes it 30 more. Each of those gaps is
    /// inside `nearBottom`, so the transcript still counted as pinned and the jump-to-latest disc
    /// never showed. Re-pinning when the header appears is too early: the push lands after the
    /// re-scroll, and over several frames, as the header animates in. So the answer is asked of
    /// every reading instead, and the push is followed frame by frame.
    ///
    /// `pinned` is the pin as `pinned(...)` decided it for `current`. `moving` is whether anything
    /// was moving the list that the platform reported: a finger or its coast, or a scroll SwiftUI
    /// says it is animating.
    ///
    /// The offset may move only as far as the geometry carried it: not at all while rows grow under
    /// the viewport, and down by what a bar added while it pushes. A movement past that is a scroll,
    /// and a scroll is never followed — whoever made it — so a reader who scrolled up stays where
    /// they are even where the platform does not report the scroll and the rows it uncovered were
    /// measured in the same breath. The one other movement allowed is this rule's own re-pin landing
    /// in the same reading as the next frame of a push: what is left out of view then is no more
    /// than that frame pushed.
    ///
    /// And only a tail within the pin's own slack is followed. Further than that, the transcript was
    /// carried off by a scroll or a jump, and the pin is no evidence otherwise: a List animating a
    /// jump reports no phase of its own (measured on iOS 26: the jump-to-latest disc's glide read
    /// `idle` from its first frame to its last, and its steps began at 1.6, 4.7, 7.7pt), so a jump up
    /// from the tail lands its first reading inside the slack and pins the transcript again — and
    /// nothing later in the jump has to un-pin it. A pinned transcript left out of view that way is
    /// `stranded`, and the jump-to-latest disc is the way back.
    ///
    /// The one larger gap followed is the floor rising: a bar floating over the list's bottom grew —
    /// the keyboard arriving under a floating composer band, the composer growing a line — and took
    /// the tail under it. Nobody scrolled; the tail is as far below the new floor as the floor rose,
    /// and no more than that past the slack, which no jump can arrange (a jump moves no inset).
    /// Measured on iOS 26: the keyboard snapped the list from a 427.6pt frame back to 874 with 436pt
    /// floating over its bottom, the content kept its place against the frame (offset 1090.3 to
    /// 644), and the tail sat 436 below the composer; the composer then grew a line at a time
    /// (insets 458, 480, 502) under an offset nothing moved again.
    public static func followsGeometry(pinned: Bool,
                                       from previous: TailScrollSample,
                                       to current: TailScrollSample,
                                       moving: Bool) -> Bool {
        guard pinned, !moving, current.bottomGap > subpixel else { return false }
        let lifted = current.bottomInset - previous.bottomInset
        if lifted > subpixel, current.bottomGap <= lifted + nearBottom { return true }
        guard current.bottomGap <= nearBottom else { return false }
        let resized = current.contentHeight != previous.contentHeight
        let pushed = current.topInset - previous.topInset
        guard resized || pushed != 0 else { return false }
        // The offset's movement that the push does not explain: zero when the geometry alone moved.
        let carried = current.offset - previous.offset + pushed
        return abs(carried) <= slop || current.bottomGap <= pushed + slop
    }

    /// Room past the pin's slack a folded band leaves the reader, so a rounding error at the
    /// boundary can't pin them again.
    public static let foldMargin: Double = 16

    /// Whether a phone's composer band folds to its one-line bar: the reader has gone back through
    /// the history (the owner, 2026-10-16: the parking strip and the composer give the conversation
    /// their room while it is being read back).
    ///
    /// Not as soon as the pin lets go, which is the first point of a scroll up: the band floats over
    /// the list, so folding it lowers the floor the tail rests on by everything it gives back. A
    /// reader still that close to the tail is then past the end — the list springs back into the
    /// room, under their finger — or back inside the pin's slack, which pins them again and opens the
    /// band again, and so on while they scroll. So the band folds once the reader is far enough back
    /// for the folded band to leave them clear of the pin: once the last row has gone below the
    /// list's bottom edge, give or take what the folded band keeps there. That reading is the rows
    /// against the list's own frame, whatever floats over it, so the band folding or opening cannot
    /// answer its own question; and it is the same line on the way back, where the band opens as the
    /// tail comes up to the bottom edge and the reader carries on into it.
    ///
    /// `foldedInset` is the bottom inset the list has with the band folded: the bar and its foot,
    /// over the screen's own bottom inset.
    public static func foldsBand(pinned: Bool, sample: TailScrollSample, foldedInset: Double) -> Bool {
        guard !pinned else { return false }
        // How far the last row sits below the list's bottom edge: the gap the pin reads, without
        // whatever floats over the list.
        let depth = sample.bottomGap - sample.bottomInset
        return depth + foldedInset > nearBottom + foldMargin
    }
}
