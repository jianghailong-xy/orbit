import Foundation
import XCTest
@testable import OrbitKit

/// The line under the iPhone list's workspace name (docs/mocks/ios-launch-updating, board 02).
final class OpenListFreshnessTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000_000)
    private func at(_ s: TimeInterval) -> Date { t0.addingTimeInterval(s) }

    func testNothingUntilARoundBegins() {
        let f = OpenListFreshness()
        XCTAssertNil(f.status(at: at(0)))
        XCTAssertNil(f.nextChange(after: at(0)))
    }

    func testAQuickReadNeverShowsTheLine() {
        var f = OpenListFreshness()
        f.begin(at: at(0))
        XCTAssertNil(f.status(at: at(0.39)))
        f.finish(round: f.round, ok: true, at: at(0.3))
        XCTAssertNil(f.status(at: at(0.4)))
        XCTAssertNil(f.status(at: at(5)))
        XCTAssertNil(f.nextChange(after: at(0.3)))
    }

    func testUpdatingThenConnectingThenOffline() {
        var f = OpenListFreshness()
        f.begin(at: at(0))
        XCTAssertEqual(f.nextChange(after: at(0)), at(0.4))
        XCTAssertEqual(f.status(at: at(0.4)), .updating)
        XCTAssertEqual(f.nextChange(after: at(0.4)), at(4))
        XCTAssertEqual(f.status(at: at(4)), .connecting)
        XCTAssertEqual(f.nextChange(after: at(4)), at(15))
        XCTAssertEqual(f.status(at: at(15)), .offline)
        XCTAssertNil(f.nextChange(after: at(15)))
    }

    func testALineShownStaysUpForItsMinimumThenGoes() {
        var f = OpenListFreshness()
        f.begin(at: at(0))
        f.finish(round: f.round, ok: true, at: at(0.5))
        XCTAssertEqual(f.status(at: at(0.9)), .updating)
        XCTAssertEqual(f.nextChange(after: at(0.5))!.timeIntervalSince(t0), 1.0, accuracy: 1e-6)
        XCTAssertNil(f.status(at: at(1.01)))
        XCTAssertNil(f.nextChange(after: at(1.01)))
    }

    func testAReadLongAfterTheLineShowedTakesItDownAtOnce() {
        var f = OpenListFreshness()
        f.begin(at: at(0))
        f.finish(round: f.round, ok: true, at: at(6))
        XCTAssertNil(f.status(at: at(6)))
    }

    func testAFailedReadIsOfflineAtOnceUntilAReadGetsThrough() {
        var f = OpenListFreshness()
        f.begin(at: at(0))
        f.finish(round: f.round, ok: false, at: at(0.2))
        XCTAssertEqual(f.status(at: at(0.2)), .offline)
        XCTAssertEqual(f.status(at: at(60)), .offline)
        XCTAssertNil(f.nextChange(after: at(0.2)))
        // The poll's next read, in the same round, gets through.
        f.finish(round: f.round, ok: true, at: at(30))
        XCTAssertNil(f.status(at: at(30)))
    }

    func testAReadFromBeforeTheRoundSaysNothingAboutIt() {
        var f = OpenListFreshness()
        let before = f.round
        f.begin(at: at(0))
        f.finish(round: before, ok: false, at: at(0.1))
        f.finish(round: before, ok: true, at: at(0.2))
        XCTAssertEqual(f.status(at: at(0.5)), .updating)
    }

    func testBeginningAgainMidRoundKeepsTheRound() {
        var f = OpenListFreshness()
        f.begin(at: at(0))
        let round = f.round
        f.begin(at: at(3))
        XCTAssertEqual(f.round, round)
        XCTAssertEqual(f.status(at: at(4)), .connecting)
    }

    func testRetryFromOfflineShowsUpdatingAtOnce() {
        var f = OpenListFreshness()
        f.begin(at: at(0))
        f.finish(round: f.round, ok: false, at: at(1))
        f.begin(at: at(20))
        XCTAssertEqual(f.status(at: at(20)), .updating)
        XCTAssertEqual(f.status(at: at(24)), .connecting)
    }

    func testANewRoundAfterAQuietOneWaitsAgain() {
        var f = OpenListFreshness()
        f.begin(at: at(0))
        f.finish(round: f.round, ok: true, at: at(0.1))
        f.begin(at: at(100))
        XCTAssertNil(f.status(at: at(100.39)))
        XCTAssertEqual(f.status(at: at(100.41)), .updating)
    }
}
