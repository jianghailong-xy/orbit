import XCTest
@testable import OrbitKit

/// What restarts a held row's quiet wait: a put-back that actually moved the list, as web's
/// `keepLanding` restarts it only when `root.scrollTop !== before` and Android's `CardFocus.moved`
/// only after a put-back moved the card. Rows growing above the row move it, so putting it back moves
/// the list. Rows appended at the tail, or growing below it, leave it where it is, so the put-back
/// moves nothing.
final class TranscriptLandingPutBackTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    private func at(_ seconds: TimeInterval) -> Date { t0.addingTimeInterval(seconds) }

    func testAPutBackThatMovedTheCardRestartsTheQuiet() {
        var card = TranscriptLanding(rowID: "card:q1", sessionID: "S1", place: .top, at: t0)
        // At 3 s an image above the card loads: the card is put back from offset 400, and the next
        // reading has the list at 760.
        card.puttingBack(from: 400)
        card.read(offset: 760, at: at(3))
        XCTAssertEqual(card.movedAt, at(3), "the put-back moved the list: the quiet starts again")
        XCTAssertTrue(card.keep(in: "S1", contentHeight: nil, at: at(7.9)))
        XCTAssertFalse(card.keep(in: "S1", contentHeight: nil, at: at(8)), "5 s after it last moved")
    }

    func testAPutBackThatLeftTheListWhereItWasDoesNotRestartIt() {
        var card = TranscriptLanding(rowID: "card:q1", sessionID: "S1", place: .top, at: t0)
        card.puttingBack(from: 400)
        card.read(offset: 400.5, at: at(3))   // within a pixel's rounding
        XCTAssertEqual(card.movedAt, t0, "the card was already in place")
        XCTAssertFalse(card.keep(in: "S1", contentHeight: nil, at: at(5)))
    }

    /// Only the reading that answers a put-back counts. The list moving at any other time is not
    /// the hold's doing (and a reader moving it releases the hold outright).
    func testOnlyTheReadingAfterAPutBackIsAsked() {
        var card = TranscriptLanding(rowID: "card:q1", sessionID: "S1", place: .top, at: t0)
        card.read(offset: 900, at: at(1))
        XCTAssertEqual(card.movedAt, t0, "no put-back was made")
        card.puttingBack(from: 900)
        card.read(offset: 900, at: at(2))
        card.read(offset: 1300, at: at(2.1))
        XCTAssertEqual(card.movedAt, t0, "the reading after the put-back said it moved nothing")
    }

    /// The review's case: a session keeps streaming under a held card. Rows land above it once,
    /// which moves it, and from then on every reading brings a new height from rows appended at the
    /// tail, each put back without moving the list. The hold lets go 5 s after the card last moved.
    func testAStreamingConversationReleasesTheCardFiveSecondsAfterItLastMoved() {
        var card = TranscriptLanding(rowID: "card:q1", sessionID: "S1", place: .top, at: t0)
        var height = 2000.0
        var offset = 0.0

        // 1 s: the rest of the first page lands above the card.
        height += 300
        XCTAssertTrue(card.keep(in: "S1", contentHeight: height, at: at(1)))
        card.puttingBack(from: offset)
        offset += 300
        card.read(offset: offset, at: at(1.05))
        XCTAssertEqual(card.movedAt, at(1.05))

        // Every half second after that a row is appended at the tail.
        var held: [Double] = []
        for step in 3...24 {
            let now = Double(step) / 2
            height += 120
            guard card.keep(in: "S1", contentHeight: height, at: at(now)) else { break }
            held.append(now)
            card.puttingBack(from: offset)
            card.read(offset: offset, at: at(now + 0.05))
        }
        XCTAssertEqual(held.last, 6, "held through 6 s, the last reading inside 1.05 s + 5 s")
        XCTAssertEqual(card.movedAt, at(1.05), "no tail row restarted the wait")
        XCTAssertFalse(card.keep(in: "S1", contentHeight: height + 120, at: at(6.5)), "and let go after it")
    }
}
