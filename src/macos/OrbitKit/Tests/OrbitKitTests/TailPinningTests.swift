import XCTest
@testable import OrbitKit

/// The transcript's "am I still following the live tail?" rule. Numbers are an iPhone-sized
/// transcript: a ~700pt viewport over 4000pt of content, with the reader at the very end.
final class TailPinningTests: XCTestCase {
    /// Pinned at the end of 4000pt of content: nothing below the viewport.
    private let atTail = TailScrollSample(offset: 3300, contentHeight: 4000, bottomGap: 0)

    private func pinned(_ current: TailScrollSample,
                        from previous: TailScrollSample? = nil,
                        readerDriven: Bool = false,
                        wasPinned: Bool = true,
                        evidence: TailPinning.ReaderEvidence = .inferred) -> Bool {
        TailPinning.pinned(wasPinned: wasPinned,
                           from: previous ?? atTail,
                           to: current,
                           readerDriven: readerDriven,
                           evidence: evidence)
    }

    // MARK: - The reported bug: a settled stretch of reasoning folds to its summary

    func testAReasoningRowFoldingCannotUnpinTheTail() {
        // The live draft (~180pt of self-scrolling reasoning) becomes a one-line row, so the scroll
        // view is clamped down by what it lost. The frame that reports the clamp still carries the
        // pre-fold gap — the same signature a finger dragging up leaves.
        let folded = TailScrollSample(offset: 3120, contentHeight: 3820, bottomGap: 180)

        XCTAssertTrue(pinned(folded))
    }

    func testTheFoldLandingWithTheNextRowCannotUnpinTheTail() {
        // The fold and the tool card that follows the reasoning arrive together, so the content is
        // NET taller even though the offset was clamped down — a height comparison alone would read
        // this as a reader scrolling up.
        let foldedAndAppended = TailScrollSample(offset: 3120, contentHeight: 4260, bottomGap: 620)

        XCTAssertTrue(pinned(foldedAndAppended))
    }

    func testAnOffsetFallingWhileSwiftUIAnimatesTheFoldCannotUnpinTheTail() {
        // Mid-animation frames: the row is shrinking, the offset follows it down. Not the reader.
        let midFold = TailScrollSample(offset: 3200, contentHeight: 3900, bottomGap: 100)

        XCTAssertTrue(pinned(midFold, readerDriven: false))
    }

    // MARK: - The reported bug, second time round: the fall and the resize in different samples

    /// iOS: the platform reports drags, so a fall nobody is driving is the List's own doing — the
    /// adjustment it makes for a row that changed height under a reader who is behind the tail.
    /// The app is behind its tail whenever a reply streams faster than the follow is reported (its
    /// own note: "each programmatic scroll is reported a frame late, by which time newer rows have
    /// grown the content"), and there the height settles in one sample and the offset moves in the
    /// next. The `!resized` half reads the second sample as a finger on a static list and un-pins.
    func testAFoldWhoseResizeLandedInAnEarlierSampleCannotUnpinTheTailOnAReportingPlatform() {
        let lagging = TailScrollSample(offset: 5400, contentHeight: 6609, bottomGap: 335)
        // The row folded: the height moved (6609 → 6449), the offset did not — the frame that
        // reports the new height is not the frame that reports the list's adjustment for it.
        let resizedOnly = TailScrollSample(offset: 5400, contentHeight: 6449, bottomGap: 175)
        XCTAssertTrue(pinned(resizedOnly, from: lagging, evidence: .reported))

        // …and then the list moves its offset down by what it lost, with nobody touching it.
        let adjusted = TailScrollSample(offset: 5240, contentHeight: 6449, bottomGap: 335)
        XCTAssertTrue(pinned(adjusted, from: resizedOnly, evidence: .reported),
                      "a fall nobody is driving is not a reader on a platform that reports drags")
    }

    /// The same two samples on a platform that reports nothing: there the height test is the only
    /// evidence there is, and it has to keep un-pinning — that is what it is for.
    func testTheSameSamplesStillUnpinWhereNothingReportsDrags() {
        let resizedOnly = TailScrollSample(offset: 5400, contentHeight: 6449, bottomGap: 175)
        let adjusted = TailScrollSample(offset: 5240, contentHeight: 6449, bottomGap: 335)

        // The frame that resizes keeps the tail (the offset did not fall there)…
        XCTAssertTrue(pinned(resizedOnly,
                             from: TailScrollSample(offset: 5400, contentHeight: 6609, bottomGap: 335),
                             evidence: .inferred))
        // …and the frame that moves the offset down does not, where the height is all there is.
        XCTAssertFalse(pinned(adjusted, from: resizedOnly, evidence: .inferred))
    }

    /// What the reporting rule gives up: a programmatic scroll UP (the sticky header's jump to an
    /// earlier question) is no longer read as a reader. It does not have to be — that tap says so
    /// itself (`ConsoleView.stickyQuestion` sets the tail unpinned on iOS) — and this is the test
    /// that records the trade, so nobody re-derives it by accident.
    func testAProgrammaticJumpUpDoesNotUnpinWhereDragsAreReported() {
        let jumped = TailScrollSample(offset: 1200, contentHeight: 4000, bottomGap: 2100)

        XCTAssertTrue(pinned(jumped, readerDriven: false, evidence: .reported),
                      "a jump SwiftUI animates is not a reader where drags are reported")
        XCTAssertFalse(pinned(jumped, readerDriven: true, evidence: .reported),
                       "…but the reader's own drag still un-pins")
    }

    // MARK: - What the rule has to keep doing

    func testAFingerDraggingUpUnpinsTheTail() {
        let draggedUp = TailScrollSample(offset: 2500, contentHeight: 4000, bottomGap: 800)

        XCTAssertFalse(pinned(draggedUp, readerDriven: true))
        XCTAssertFalse(pinned(draggedUp, readerDriven: true, evidence: .reported),
                       "and it must keep doing so where the platform reports the drag")
    }

    func testAFingerDraggingUpWhileTheReplyStreamsStillUnpinsTheTail() {
        // Streaming moves the content height on nearly every frame; the reader must still win, or
        // reading history during a reply would be impossible.
        let draggedUpMidStream = TailScrollSample(offset: 2500, contentHeight: 4400, bottomGap: 1200)

        XCTAssertFalse(pinned(draggedUpMidStream, readerDriven: true))
        XCTAssertFalse(pinned(draggedUpMidStream, readerDriven: true, evidence: .reported))
    }

    func testAJumpBackToAnEarlierQuestionUnpinsTheTail() {
        // The sticky "↑ Your question" header animates the offset up over unchanged content.
        let jumpedToQuestion = TailScrollSample(offset: 1200, contentHeight: 4000, bottomGap: 2100)

        XCTAssertFalse(pinned(jumpedToQuestion, readerDriven: false))
    }

    func testRowsAppendedBelowAPinnedReaderKeepItPinned() {
        // The gap alone is what a position-only test would trip over: the rows are already laid out
        // and the follow-on scroll is still a frame away.
        let grown = TailScrollSample(offset: 3300, contentHeight: 4600, bottomGap: 600)

        XCTAssertTrue(pinned(grown))
    }

    func testComingBackNearTheEndRepins() {
        let nearlyBack = TailScrollSample(offset: 3260, contentHeight: 4000, bottomGap: 40)

        XCTAssertTrue(pinned(nearlyBack,
                             from: TailScrollSample(offset: 2500, contentHeight: 4000, bottomGap: 800),
                             readerDriven: true,
                             wasPinned: false))
    }

    func testTheEndItselfRepinsEvenWhileTheReaderDragsUpward() {
        // 80pt of slack, web's threshold: a small drag inside it doesn't count as leaving the tail.
        let justInsideTheSlack = TailScrollSample(offset: 3240, contentHeight: 4000, bottomGap: 60)

        XCTAssertTrue(pinned(justInsideTheSlack, readerDriven: true))
    }
}
