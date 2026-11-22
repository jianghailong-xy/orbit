import XCTest
@testable import OrbitKit

/// The row a transcript was opened at (a waiting card, a record a link named) is held in place
/// while the rest of the conversation lands, until the reader takes over or nothing has moved it for
/// `quiet`. A request to open at a waiting card lapses after 10 s (web `landingRef`/`keepLanding`,
/// `LANDING_QUIET_MS`, `WAITING_REVEAL_EXPIRES_MS`). Where the transcript drops the hold on reader
/// input, a jump, a send or a session switch is pinned in `TranscriptLandingWiringTests`.
final class TranscriptLandingTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    private func at(_ seconds: TimeInterval) -> Date { t0.addingTimeInterval(seconds) }

    func testAHeldWaitingCardIsPutBackWhenRowsLandOrGrowAboveItWithinTheQuietWindow() {
        var card = TranscriptLanding(rowID: "card:q1", sessionID: "S1", place: .top, at: t0)

        // The rest of the first page lands above it: the content takes a new height.
        XCTAssertTrue(card.keep(in: "S1", contentHeight: 2400, at: at(1)))
        // An image above it loads 4 s later. Still inside the quiet window, because the landing
        // above restarted it.
        XCTAssertTrue(card.keep(in: "S1", contentHeight: 2760, at: at(5.5)), "the row that grew is put back")
        XCTAssertEqual(card.movedAt, at(5.5), "and the quiet wait starts again from it")
        // A publish with nothing resized still puts the card back, without restarting the wait.
        XCTAssertTrue(card.keep(in: "S1", contentHeight: nil, at: at(9)))
        XCTAssertEqual(card.movedAt, at(5.5))
    }

    func testARecordJumpIsHeldTheSameWay() {
        var record = TranscriptLanding(rowID: "row-42", sessionID: "S1", place: .center, at: t0)
        XCTAssertEqual(record.place, .center, "a record is held in the middle of the view, where it was jumped to")
        XCTAssertTrue(record.keep(in: "S1", contentHeight: 1800, at: at(2)))
        XCTAssertTrue(record.keep(in: "S1", contentHeight: 1950, at: at(6)), "a translation above it moved it: put back")
        XCTAssertFalse(record.keep(in: "S1", contentHeight: nil, at: at(11)), "and let go once nothing moved it for 5 s")
    }

    func testTheHoldIsReleasedAfterTheQuietTimeout() {
        var card = TranscriptLanding(rowID: "card:q1", sessionID: "S1", place: .top, at: t0)
        // Publishes that resize nothing do not restart the wait: a card already in place under a
        // conversation that keeps publishing is not held for ever.
        XCTAssertTrue(card.keep(in: "S1", contentHeight: nil, at: at(2)))
        XCTAssertTrue(card.keep(in: "S1", contentHeight: nil, at: at(4.9)))
        XCTAssertFalse(card.keep(in: "S1", contentHeight: nil, at: at(5)), "5 s with nothing moving it")
        XCTAssertFalse(card.keep(in: "S1", contentHeight: 3000, at: at(5.1)),
                       "once let go, a later landing does not move the reader")
    }

    func testTheHoldBelongsToTheSessionItWasOpenedIn() {
        var card = TranscriptLanding(rowID: "card:q1", sessionID: "S1", place: .top, at: t0)
        XCTAssertFalse(card.keep(in: "S2", contentHeight: 900, at: at(1)))
    }

    func testAnOpenAtWaitingCardRequestLapsesAfterTenSeconds() {
        XCTAssertTrue(TranscriptLanding.waitingRequestStands(askedAt: t0, now: at(0)))
        XCTAssertTrue(TranscriptLanding.waitingRequestStands(askedAt: t0, now: at(9.9)))
        XCTAssertFalse(TranscriptLanding.waitingRequestStands(askedAt: t0, now: at(10)),
                       "a card drawn 10 s after the open does not move the reader")
        XCTAssertFalse(TranscriptLanding.waitingRequestStands(askedAt: t0, now: at(59)),
                       "it used to stand for 60 s")
    }

    /// The two clocks are web's: the clients agree on how long a card is held and a request stands.
    func testTheClocksAreWebs() throws {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        var web: String?
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("src/web/src/components/WorkspaceView.tsx")
            if FileManager.default.fileExists(atPath: candidate.path) {
                web = try String(contentsOf: candidate, encoding: .utf8)
                break
            }
            dir.deleteLastPathComponent()
        }
        let source = try XCTUnwrap(web, "WorkspaceView.tsx was not found above this test")
        XCTAssertTrue(source.contains("const LANDING_QUIET_MS = 5000;"))
        XCTAssertEqual(TranscriptLanding.quiet, 5)
        XCTAssertTrue(source.contains("const WAITING_REVEAL_EXPIRES_MS = 10_000;"))
        XCTAssertEqual(TranscriptLanding.waitingRequestLifetime, 10)
    }
}
