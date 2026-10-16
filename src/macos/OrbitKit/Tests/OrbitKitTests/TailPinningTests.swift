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

    // MARK: - The reported bug, third time round: the viewport changes size under a pinned reader

    /// A phone's composer focused on a transcript at the tail: the keyboard rises and the viewport
    /// shrinks by ~200pt (measured on an iPhone: 643 → 445, in steps, as the chrome folds and the
    /// keyboard lands) — and typing a third line takes another ~70 off it. The offset does not move
    /// and nothing removed content, so the `pinned` rule above keeps the pin, which is right: the
    /// reader *is* still at the tail. What is not right is where the tail ended up — below the fold,
    /// with the last line cut in half.
    private let beforeKeyboard: Double = 643
    private let underKeyboard: Double = 445

    func testAShrinkingViewportUnderAPinnedTranscriptAsksForItsTail() {
        XCTAssertTrue(TailPinning.followsResize(wasPinned: true, from: beforeKeyboard, to: underKeyboard))
        // …and the pin rule itself keeps saying pinned through it, which is why this rule has to
        // exist beside it: nothing about the scroll reading says the tail moved.
        let before = TailScrollSample(offset: 9084, contentHeight: 9727, bottomGap: 0)
        let under = TailScrollSample(offset: 9084, contentHeight: 9727, bottomGap: 160)

        XCTAssertTrue(pinned(under, from: before))
    }

    func testAGrowingViewportAsksForTheTailToo() {
        // The keyboard going away: the viewport grows back and the tail is left sitting mid-screen
        // with a keyboard's worth of nothing under it.
        XCTAssertTrue(TailPinning.followsResize(wasPinned: true, from: underKeyboard, to: beforeKeyboard))
    }

    func testAReaderAwayFromTheTailIsNotCarriedBackByAResize() {
        // Rotating the phone, or focusing the composer, while the reader is reading history: the
        // viewport moved, their place did not move with it, and the jump-to-latest disc is the way
        // back — never a resize.
        XCTAssertFalse(TailPinning.followsResize(wasPinned: false, from: beforeKeyboard, to: underKeyboard))
    }

    func testAnUnchangedViewportIsNotAResize() {
        // Every other sample the transcript reports — a scroll, a publish that grew the rows — comes
        // with the viewport it already had, and must not be read as one.
        XCTAssertFalse(TailPinning.followsResize(wasPinned: true, from: underKeyboard, to: underKeyboard))
    }

    func testAViewportThatWasNeverMeasuredIsNotAResize() {
        // 0 is the first reading, before a layout has happened: an unknown is not a resize, or the
        // transcript would ask for its tail on the frame it appears.
        XCTAssertFalse(TailPinning.followsResize(wasPinned: true, from: 0, to: underKeyboard))
        XCTAssertFalse(TailPinning.followsResize(wasPinned: true, from: beforeKeyboard, to: 0))
    }

    // MARK: - The reported bug, fourth time round: the geometry moves the tail under a pinned reader

    /// An iPhone opening a long conversation, as measured: 1463pt of content in a 739pt list under a
    /// 116pt bar, pinned at offset 724. Then the sticky "↑ Your question" header arrives and the top
    /// inset grows to 148 — and the rows are pushed down with it, to 692, every time.
    private let opened = TailScrollSample(offset: 724, contentHeight: 1463, bottomGap: 0, topInset: 116)
    private let pushed = TailScrollSample(offset: 692, contentHeight: 1463, bottomGap: 32, topInset: 148)

    private func follows(_ current: TailScrollSample, from previous: TailScrollSample,
                         pinned: Bool = true, moving: Bool = false) -> Bool {
        TailPinning.followsGeometry(pinned: pinned, from: previous, to: current, moving: moving)
    }

    func testTheStickyHeaderPushingAPinnedTranscriptOffItsTailIsFollowed() {
        XCTAssertTrue(follows(pushed, from: opened))
        // …which nothing else answers: the 32pt left below is inside the pin's slack, so the pin
        // holds and the jump-to-latest disc never shows. The last line just sits in the fade.
        XCTAssertTrue(pinned(pushed, from: opened, evidence: .reported))
        XCTAssertTrue(pinned(pushed, from: opened, evidence: .inferred))
    }

    func testEveryFrameOfTheHeaderAnimatingInIsFollowed() {
        // The header animates in, and the push lands a frame at a time (measured mid-flight: inset
        // 126.9 with the offset at 713). Asked once, the tail is reached and then pushed off again.
        let firstFrame = TailScrollSample(offset: 713, contentHeight: 1463, bottomGap: 11, topInset: 126.9)
        XCTAssertTrue(follows(firstFrame, from: opened))

        // The re-pin lands in the same reading as the next frame: back at 724, then pushed 20.7 down.
        // The offset moved by more than the push this time — it was ours — and what is left below is
        // that frame's push alone.
        let nextFrame = TailScrollSample(offset: 703.3, contentHeight: 1463, bottomGap: 20.7, topInset: 147.6)
        XCTAssertTrue(follows(nextFrame, from: firstFrame))
    }

    func testRowsMeasuredTallerUnderAPinnedTranscriptAreFollowed() {
        // A Mac's List, as measured: the pin lands on rows of estimated height (offset 638 over 1174pt
        // of content), the rows on screen are measured, and the content is 44pt taller under an
        // offset that did not move.
        let estimated = TailScrollSample(offset: 638, contentHeight: 1174, bottomGap: 0, topInset: 77)
        let measured = TailScrollSample(offset: 638, contentHeight: 1218, bottomGap: 44, topInset: 77)

        XCTAssertTrue(follows(measured, from: estimated))
    }

    func testAPushThatIsNotExactlyItsInsetIsStillThePush() {
        // The same Mac, the header arriving: a 30pt inset moved the offset 29 once both were rounded
        // to the screen's pixels.
        let atTail = TailScrollSample(offset: 276, contentHeight: 832, bottomGap: 0, topInset: 77)
        let underHeader = TailScrollSample(offset: 247, contentHeight: 832, bottomGap: 29, topInset: 107)

        XCTAssertTrue(follows(underHeader, from: atTail))
    }

    func testTheLastFramesOfThePushAreFollowedToThePoint() {
        // A Mac, measured frame by frame: the header's push ended with an inset of 105 → 107 that
        // moved the offset 2pt. Left there, the transcript opened 2pt short of its tail.
        let almostIn = TailScrollSample(offset: 276, contentHeight: 832, bottomGap: 0, topInset: 105)
        let lastFrame = TailScrollSample(offset: 274, contentHeight: 832, bottomGap: 2, topInset: 107)

        XCTAssertTrue(follows(lastFrame, from: almostIn))
    }

    func testAGeometryChangeThatLeftTheTailInPlaceAsksForNothing() {
        // A streamed reply grew the rows and the follow on its publish landed in the same reading:
        // nothing is out of view, so nothing is asked — a reply streams with no second scroll.
        let followed = TailScrollSample(offset: 812, contentHeight: 1551, bottomGap: 0, topInset: 148)

        XCTAssertFalse(follows(followed, from: TailScrollSample(offset: 724, contentHeight: 1463,
                                                                bottomGap: 0, topInset: 148)))
    }

    // MARK: - …and what following the geometry must never do: pull a reader back

    func testAReaderWhoScrolledUpIsNotCarriedBackByTheGeometry() {
        // Reading history, un-pinned: rows measured or a header arriving leave them where they are.
        let reading = TailScrollSample(offset: 400, contentHeight: 1463, bottomGap: 324, topInset: 116)
        let measured = TailScrollSample(offset: 400, contentHeight: 1507, bottomGap: 368, topInset: 116)
        let underHeader = TailScrollSample(offset: 368, contentHeight: 1463, bottomGap: 356, topInset: 148)

        XCTAssertFalse(follows(measured, from: reading, pinned: false))
        XCTAssertFalse(follows(underHeader, from: reading, pinned: false))
    }

    func testNothingIsFollowedWhileTheListIsMoving() {
        // A finger on the list, its coast, or a scroll the platform says SwiftUI is animating:
        // whatever the geometry did meanwhile, the movement decides where the list ends up.
        XCTAssertFalse(follows(pushed, from: opened, moving: true))
        let measured = TailScrollSample(offset: 724, contentHeight: 1507, bottomGap: 44, topInset: 116)
        XCTAssertFalse(follows(measured, from: opened, moving: true))
    }

    func testAScrollUpIsNeverFollowed() {
        // Inside the pin's slack, a reader 40pt up still counts as pinned — but nothing about the
        // geometry changed, so there is nothing to follow.
        let peeked = TailScrollSample(offset: 684, contentHeight: 1463, bottomGap: 40, topInset: 116)

        XCTAssertTrue(pinned(peeked, from: opened, readerDriven: false))
        XCTAssertFalse(follows(peeked, from: opened))
    }

    func testAScrollUpThatUncoveredARowMeasuredInTheSameReadingIsNotFollowed() {
        // Where the scroll goes unreported — a Mac infers its reader from geometry — the row a scroll
        // up uncovers can be measured in that same reading: 76pt taller than estimated, with the list
        // holding the reader's place, so a 40pt scroll up leaves the offset 36pt HIGHER and the
        // content taller. Geometry changed and the pin held (40pt is inside its slack) — but the
        // offset moved past anything the geometry carried, and that is a scroll.
        let scrolledAndMeasured = TailScrollSample(offset: 760, contentHeight: 1539, bottomGap: 40, topInset: 116)

        XCTAssertTrue(pinned(scrolledAndMeasured, from: opened))
        XCTAssertFalse(follows(scrolledAndMeasured, from: opened))
    }

    func testAScrollUpAsTheHeaderArrivesIsNotFollowed() {
        // The push and a 50pt scroll up in one reading: more is out of view than the push accounts for.
        let scrolledAndPushed = TailScrollSample(offset: 642, contentHeight: 1463, bottomGap: 82, topInset: 148)

        XCTAssertFalse(follows(scrolledAndPushed, from: opened))
    }

    func testAJumpAwayWhosePinSurvivedIsNotFollowed() {
        // The sticky header's jump to a question un-pins the tail on its tap, but the List animates
        // the jump with no phase of its own and starts it slowly (1.6pt in its first frame), so that
        // first reading is inside the slack and pins the transcript again — and nothing later in the
        // jump un-pins it where drags are reported.
        let atTail = TailScrollSample(offset: 724, contentHeight: 1463, bottomGap: 0, topInset: 148)
        let firstFrame = TailScrollSample(offset: 722.4, contentHeight: 1463, bottomGap: 1.6, topInset: 148)
        let atQuestion = TailScrollSample(offset: 300, contentHeight: 1463, bottomGap: 424, topInset: 148)
        XCTAssertTrue(pinned(firstFrame, from: atTail, wasPinned: false, evidence: .reported))
        XCTAssertTrue(pinned(atQuestion, from: firstFrame, evidence: .reported))

        // So a pinned reading that far from the tail says nothing about where the reader is: a row
        // measured under the question leaves them at it.
        let measured = TailScrollSample(offset: 300, contentHeight: 1507, bottomGap: 468, topInset: 148)
        XCTAssertFalse(follows(measured, from: atQuestion))
    }

    // MARK: - The floor rising under a composer band that floats over the list (iOS 26)

    /// The keyboard arriving, as measured on the iOS 26 simulator: the list snapped from a 427.6pt
    /// frame back to 874 with 436pt floating over its bottom, the content kept its place against the
    /// frame (offset 1090.3 to 644), and the last answer sat 436 below the top of the composer.
    private let keyboardRising = TailScrollSample(offset: 1090.3, contentHeight: 1518, bottomGap: 0,
                                                  topInset: 62, bottomInset: 0)
    private let underTheComposer = TailScrollSample(offset: 644, contentHeight: 1518, bottomGap: 436,
                                                    topInset: 62, bottomInset: 436)

    func testTheKeyboardLiftingAFloatingBandIsFollowed() {
        XCTAssertTrue(pinned(underTheComposer, from: keyboardRising, evidence: .reported),
                      "nobody scrolled, so the pin holds — and the tail is out of view")
        XCTAssertTrue(follows(underTheComposer, from: keyboardRising))
    }

    func testTheComposerGrowingALineUnderAFloatingBandIsFollowed() {
        // Each line the draft wraps onto lifts the floor 22pt under an offset nothing moves.
        let atTail = TailScrollSample(offset: 1080, contentHeight: 1518, bottomGap: 0, topInset: 62, bottomInset: 436)
        let grown = TailScrollSample(offset: 1080, contentHeight: 1518, bottomGap: 22, topInset: 62, bottomInset: 458)
        XCTAssertTrue(follows(grown, from: atTail))
    }

    func testARisingFloorCarriesOnlyAReaderAtTheTail() {
        XCTAssertFalse(follows(underTheComposer, from: keyboardRising, pinned: false),
                       "a reader who had scrolled up keeps their place")
        XCTAssertFalse(follows(underTheComposer, from: keyboardRising, moving: true),
                       "and nothing is followed while the list moves")
        // …and no further than the floor rose, past the slack: a pinned reading that far up is a
        // jump that kept its pin (see above), and a floor rising under it doesn't make it the tail.
        let farUp = TailScrollSample(offset: 300, contentHeight: 1518, bottomGap: 780, topInset: 62, bottomInset: 436)
        XCTAssertFalse(follows(farUp, from: keyboardRising))
    }

    // MARK: - The composer band folding to its bar while the reader goes back (iOS 26 phones)

    /// The owner's phone: a 956pt list over 4000pt of content. Open, the band and its foot float
    /// 214pt over the list's bottom, over the screen's 34; folded, its 36pt bar and the same foot do.
    private let openInset = 248.0
    private let foldedInset = 80.0

    /// The reader `up` points back from the tail, read with the band open or folded over the list.
    private func back(_ up: Double, folded: Bool = false) -> TailScrollSample {
        let inset = folded ? foldedInset : openInset
        let offset = 4000 + openInset - 956 - up
        let gap = 4000 + inset - (offset + 956)
        return TailScrollSample(offset: offset, contentHeight: 4000, bottomGap: gap, topInset: 116,
                                bottomInset: inset)
    }

    private func folds(_ sample: TailScrollSample, pinned: Bool = false) -> Bool {
        TailPinning.foldsBand(pinned: pinned, sample: sample, foldedInset: foldedInset)
    }

    func testTheBandStaysOpenAtTheTail() {
        XCTAssertFalse(folds(back(0), pinned: true))
        XCTAssertFalse(folds(back(0, folded: true), pinned: true))
    }

    /// The pin lets go at the first point of a scroll up, but the band gives back 168pt when it
    /// folds: this close to the tail the reader would be past the end, the list springing back into
    /// the room — or, a little further, back inside the pin's slack, which opens the band again.
    func testAShortScrollUpLeavesTheBandOpen() {
        XCTAssertFalse(folds(back(120)), "folded, the reader would be 48pt past the end")
        XCTAssertFalse(folds(back(200)))
        XCTAssertTrue(pinned(back(200, folded: true), from: back(200), wasPinned: false, evidence: .reported),
                      "folded there, the reader would be 32pt from the tail: pinned again")
    }

    func testAReaderFarEnoughBackFoldsTheBand() {
        XCTAssertTrue(folds(back(300)))
        // …and the folded band leaves them where the pin cannot reach them: nothing moved, and the
        // tail is further off than the pin's slack.
        XCTAssertFalse(pinned(back(300, folded: true), from: back(300), wasPinned: false, evidence: .reported))
        XCTAssertTrue(folds(back(300, folded: true)), "and it stays folded")
    }

    /// The reading is the rows against the list's own frame, so the band folding or opening — which
    /// moves only the inset — cannot change the answer and set it flapping.
    func testFoldingTheBandCannotAnswerItsOwnQuestion() {
        for up in stride(from: 0.0, through: 600, by: 4) {
            XCTAssertEqual(folds(back(up)), folds(back(up, folded: true)), "\(up)pt back")
        }
    }

    /// On the way down the band opens where it folded: as the tail comes up to the list's bottom
    /// edge, before the pin catches it. Nothing is followed — the reader carries on into the room.
    func testTheBandOpensAsTheTailComesBackUpToTheBottomEdge() {
        XCTAssertTrue(folds(back(280, folded: true)), "112pt from the folded tail")
        XCTAssertFalse(folds(back(260, folded: true)), "92pt from it: the band opens")
        XCTAssertFalse(pinned(back(260), from: back(260, folded: true), wasPinned: false, evidence: .reported))
        XCTAssertFalse(follows(back(260), from: back(260, folded: true), pinned: false))
    }

    /// A phone with no home indicator keeps less under a folded bar, so its reader goes further back
    /// before the band folds.
    func testTheFoldedInsetDecidesHowFarBackTheBandFolds() {
        let noIndicator = 46.0
        let sample = back(270)
        XCTAssertTrue(TailPinning.foldsBand(pinned: false, sample: sample, foldedInset: foldedInset))
        XCTAssertFalse(TailPinning.foldsBand(pinned: false, sample: sample, foldedInset: noIndicator))
    }
}
