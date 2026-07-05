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
        XCTAssertEqual(p.next(after: .ended), .reconnect(afterMs: 300))
        XCTAssertEqual(p.attempt, 0)
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
