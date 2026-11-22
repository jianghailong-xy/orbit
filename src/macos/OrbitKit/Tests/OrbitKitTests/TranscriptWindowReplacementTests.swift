import XCTest
@testable import OrbitKit

/// A window the stream cannot resume (the server's `resync`, or a reconnect's catch-up that ran out
/// of budget) is kept under a reader who scrolled up, its bottom a gap at the last seq. A reader at
/// the tail gets a fresh tail page as before (web `replaceWindow`; Android `ReadingWindow.live`). The
/// console's half, which asks this with `readingHistory`, is pinned in
/// `TranscriptWindowReplacementWiringTests`.
final class TranscriptWindowReplacementTests: XCTestCase {
    private func ev(_ seq: Int, _ type: RunEventType, _ payload: [String: JSONValue], turn: String? = "t1") -> RunEvent {
        RunEvent(seq: seq, type: type, turnId: turn, payload: .object(payload))
    }

    /// A loaded window from seq 401 to 404: what the reader has on screen.
    private func loadedWindow() -> TranscriptReducer {
        var r = TranscriptReducer()
        r.applyTailPage(EventPage(events: [
            ev(401, .user, ["text": .string("Why did the deploy fail?")]),
            ev(402, .assistant, ["text": .string("The migration timed out.")]),
            ev(403, .user, ["text": .string("And the retry?")], turn: "t2"),
            ev(404, .assistant, ["text": .string("It went through.")], turn: "t2"),
        ], hasMore: true, before: 401))
        return r
    }

    func testAResyncUnderAReaderInHistoryKeepsTheLoadedRowsAndLeavesTheWindowDetachedAtTheLastSeq() {
        var r = loadedWindow()
        let before = r.state

        let gap = r.replaceWindow(readerAtTail: false)

        XCTAssertEqual(gap, 404, "the window's bottom becomes a gap at its last seq, the cursor paged forward from")
        XCTAssertEqual(r.state, before, "every row the reader had stays exactly as it was")
        XCTAssertEqual(r.state.maxSeq, 404)
        XCTAssertEqual(r.state.oldestSeq, 401, "and the way back up is unchanged")
        XCTAssertTrue(r.state.hasMoreOlder)

        // Scrolling down pages forward across the gap, as in a window opened at a record.
        r.appendNewer(EventPage(events: [ev(1700, .assistant, ["text": .string("Later reply.")], turn: "t9")],
                                hasMore: false))
        XCTAssertEqual(r.state.maxSeq, 1700)
        XCTAssertEqual(r.state.items.count, before.items.count + 1, "the newer page lands below the kept rows")
    }

    /// An exhausted catch-up goes the same way as a `resync`: it is the same call.
    func testAnExhaustedCatchUpUnderAReaderInHistoryKeepsTheWindowToo() {
        var r = loadedWindow()
        // The catch-up folded what it could before its budget ran out.
        r.appendNewer(EventPage(events: [ev(405, .user, ["text": .string("Next?")], turn: "t3")], hasMore: true, after: 405))
        let before = r.state

        XCTAssertEqual(r.replaceWindow(readerAtTail: false), 405)
        XCTAssertEqual(r.state, before)
    }

    func testAResyncAtTheTailStillReseedsFromATailPage() {
        var r = loadedWindow()

        XCTAssertNil(r.replaceWindow(readerAtTail: true), "nothing kept: the caller seeds a tail page")
        XCTAssertTrue(r.state.items.isEmpty, "the window is dropped")
        XCTAssertEqual(r.state.maxSeq, 0, "so the tail seed's `where maxSeq == 0` takes the page")
        XCTAssertNil(r.state.oldestSeq)

        r.applyTailPage(EventPage(events: [
            ev(2001, .user, ["text": .string("Fresh tail")], turn: "t10"),
            ev(2002, .assistant, ["text": .string("Here.")], turn: "t10"),
        ], hasMore: true, before: 2001))
        XCTAssertEqual(r.state.maxSeq, 2002)
        XCTAssertEqual(r.state.oldestSeq, 2001, "the window is the fresh page alone")
    }

    func testAnEmptyWindowHasNothingToKeep() {
        var r = TranscriptReducer()
        XCTAssertNil(r.replaceWindow(readerAtTail: false))
    }
}
