import XCTest
@testable import OrbitKit

/// The reconnect decision core extracted from ConsoleModel.run() — the ramp, the resets, and the
/// stop condition, checked against the loop's original inline behavior.
final class ReconnectPolicyTests: XCTestCase {

    func testCancelledStops() {
        var p = ReconnectPolicy()
        XCTAssertEqual(p.next(after: .cancelled), .stop)
    }

    func testFailureRampIsCappedExponential() {
        var p = ReconnectPolicy()
        // 1st..4th failures double from 1s; 5th hits the 15s cap and stays there.
        XCTAssertEqual(p.next(after: .failed), .reconnect(afterMs: 1_000))
        XCTAssertEqual(p.next(after: .failed), .reconnect(afterMs: 2_000))
        XCTAssertEqual(p.next(after: .failed), .reconnect(afterMs: 4_000))
        XCTAssertEqual(p.next(after: .failed), .reconnect(afterMs: 8_000))
        XCTAssertEqual(p.next(after: .failed), .reconnect(afterMs: 15_000))
        XCTAssertEqual(p.next(after: .failed), .reconnect(afterMs: 15_000))   // never exceeds the cap
    }

    func testHealthyEventResetsTheRamp() {
        var p = ReconnectPolicy()
        _ = p.next(after: .failed)
        _ = p.next(after: .failed)
        p.noteHealthy()
        XCTAssertEqual(p.attempt, 0)
        XCTAssertEqual(p.next(after: .failed), .reconnect(afterMs: 1_000))   // ramp restarts from the bottom
    }

    func testKickReconnectsImmediatelyAndResets() {
        var p = ReconnectPolicy()
        _ = p.next(after: .failed)
        _ = p.next(after: .failed)
        XCTAssertEqual(p.next(after: .kicked), .reconnect(afterMs: 0))
        XCTAssertEqual(p.next(after: .failed), .reconnect(afterMs: 1_000))   // reset took effect
    }

    func testCleanCloseWaitsABeatAndResets() {
        var p = ReconnectPolicy()
        _ = p.next(after: .failed)
        p.noteHealthy()   // the connection that is now closing delivered a message
        XCTAssertEqual(p.next(after: .ended), .reconnect(afterMs: 300))
        XCTAssertEqual(p.attempt, 0)
    }

    // MARK: health is the first message, never the connection (docs/list-freshness-design.md §4 R4)

    /// A proxy that accepts the stream and closes it before anything arrives. Closing cleanly used to
    /// count as health — the ramp reset and the loop came back every 300 ms, forever.
    func testAConnectionThatClosesBeforeItsFirstMessageIsAFailedAttempt() {
        var p = ReconnectPolicy()
        XCTAssertEqual(p.next(after: .ended), .reconnect(afterMs: 1_000))
        XCTAssertEqual(p.next(after: .ended), .reconnect(afterMs: 2_000))
        XCTAssertEqual(p.next(after: .ended), .reconnect(afterMs: 4_000))
        XCTAssertEqual(p.attempt, 3, "no message arrived, so nothing was healthy")
    }

    /// Only a message resets the ramp: connections that fail before one keep backing off, and the
    /// first message — on whichever connection — brings it back to the bottom.
    func testOnlyTheFirstMessageResetsTheRamp() {
        var p = ReconnectPolicy()
        XCTAssertEqual(p.next(after: .failed), .reconnect(afterMs: 1_000))
        XCTAssertEqual(p.next(after: .ended), .reconnect(afterMs: 2_000), "accepted, then closed: no message")
        XCTAssertEqual(p.next(after: .failed), .reconnect(afterMs: 4_000))
        p.noteHealthy()
        XCTAssertEqual(p.attempt, 0)
        XCTAssertEqual(p.next(after: .failed), .reconnect(afterMs: 1_000), "a message, then a drop: from the bottom")
    }

    /// Health belongs to one connection: the next one has to earn it again.
    func testHealthIsPerConnection() {
        var p = ReconnectPolicy()
        p.noteHealthy()
        XCTAssertEqual(p.next(after: .ended), .reconnect(afterMs: 300))
        XCTAssertEqual(p.next(after: .ended), .reconnect(afterMs: 1_000), "the next connection sent nothing")
    }

    /// A `resync` reconnects (the caller re-seeds in between) without touching the ramp: re-seeding
    /// spends the same retry budget, so a stream that only ever answers `resync` still backs off.
    func testResyncReconnectsWithoutResettingTheRamp() {
        var p = ReconnectPolicy()
        _ = p.next(after: .failed)
        _ = p.next(after: .failed)
        XCTAssertEqual(p.next(after: .resync), .reconnect(afterMs: 300))
        XCTAssertEqual(p.attempt, 2, "re-seeding is not a sign of health")
        XCTAssertEqual(p.next(after: .failed), .reconnect(afterMs: 4_000))   // ramp carried on
    }

    func testFailuresNeverStop() {
        var p = ReconnectPolicy()
        for _ in 0..<100 {
            guard case .reconnect = p.next(after: .failed) else {
                return XCTFail("a failure must always retry — an outage can outlast any attempt count")
            }
        }
    }
}
