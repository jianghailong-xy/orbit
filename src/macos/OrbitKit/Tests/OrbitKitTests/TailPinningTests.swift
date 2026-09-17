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
                        wasPinned: Bool = true) -> Bool {
        TailPinning.pinned(wasPinned: wasPinned,
                           from: previous ?? atTail,
                           to: current,
                           readerDriven: readerDriven)
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

    // MARK: - What the rule has to keep doing

    func testAFingerDraggingUpUnpinsTheTail() {
        let draggedUp = TailScrollSample(offset: 2500, contentHeight: 4000, bottomGap: 800)

        XCTAssertFalse(pinned(draggedUp, readerDriven: true))
    }

    func testAFingerDraggingUpWhileTheReplyStreamsStillUnpinsTheTail() {
        // Streaming moves the content height on nearly every frame; the reader must still win, or
        // reading history during a reply would be impossible.
        let draggedUpMidStream = TailScrollSample(offset: 2500, contentHeight: 4400, bottomGap: 1200)

        XCTAssertFalse(pinned(draggedUpMidStream, readerDriven: true))
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
