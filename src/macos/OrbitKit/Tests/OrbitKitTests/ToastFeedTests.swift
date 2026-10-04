import Foundation
import XCTest
@testable import OrbitKit

/// The toast system's rules (docs/mocks/toast-system, board ④): what a toast asks of you decides its
/// level, a failure is never displaced, and one operation is one toast from start to finish.
final class ToastFeedTests: XCTestCase {

    private let t0 = Date(timeIntervalSince1970: 1_000_000)

    // MARK: levels

    func testWhatAToastAsksOfYouDecidesItsLevel() {
        XCTAssertEqual(ToastItem(message: "Link copied").level, .confirm)
        XCTAssertEqual(ToastItem(message: "Accepted", subtitle: "Use pnpm for workspace installs").level, .confirm,
                       "naming its entry doesn't make a confirmation a card")
        XCTAssertEqual(ToastItem(message: "Merged into main", sessionID: "s1").level, .confirm,
                       "a toast you can tap into its session is still a pill")
        XCTAssertEqual(ToastItem(message: "Merging into main…", inProgress: true).level, .progress)
        XCTAssertEqual(ToastItem(message: "Session completed", sessionID: "s1", canUndo: true).level, .result)
        XCTAssertEqual(ToastItem(message: "Changes committed", detail: "1 file changed").level, .result)
        XCTAssertEqual(ToastItem(message: "Couldn't merge into main", tone: .error).level, .attention)
        XCTAssertEqual(ToastItem(message: "Waiting for your approval", tone: .warning, awaitsApproval: true).level,
                       .attention)
        XCTAssertEqual(ToastItem(message: "Couldn't merge into main", tone: .error, inProgress: true).level, .attention,
                       "a failure waits for you whatever else it carries")
    }

    func testOnlyTheOnesThatWaitForYouStayWithoutATimer() {
        XCTAssertEqual(ToastItem(message: "Link copied").dwell, 3)
        XCTAssertEqual(ToastItem(message: "Session completed", canUndo: true).dwell, 6)
        XCTAssertNil(ToastItem(message: "Couldn't commit", tone: .error).dwell)
        XCTAssertNotNil(ToastItem(message: "Merging into main…", inProgress: true).dwell,
                        "a progress pill has a net under a result that never comes")
    }

    // MARK: the slots

    func testTheNewestTransientToastWins() {
        var feed = ToastFeed()
        feed.post(ToastItem(message: "Session completed", sessionID: "s1", canUndo: true), at: t0)
        feed.post(ToastItem(message: "Link copied"), at: t0.addingTimeInterval(1))
        XCTAssertEqual(feed.transient?.message, "Link copied")
        XCTAssertTrue(feed.pinned.isEmpty)
    }

    func testAFailureIsNeverDisplacedByWhatComesAfterIt() {
        var feed = ToastFeed()
        feed.post(ToastItem(message: "Couldn't merge into main", tone: .error), at: t0)
        feed.post(ToastItem(message: "Link copied"), at: t0.addingTimeInterval(1))
        XCTAssertEqual(feed.pinned.map(\.message), ["Couldn't merge into main"])
        XCTAssertEqual(feed.transient?.message, "Link copied")
    }

    func testANewFailureOpensAndTheNewestIsInFront() throws {
        var feed = ToastFeed()
        let first = try XCTUnwrap(feed.post(ToastItem(message: "Couldn't save the schedule", tone: .error), at: t0))
        XCTAssertEqual(feed.expanded, first)
        let second = try XCTUnwrap(feed.post(ToastItem(message: "Couldn't merge into main", tone: .error),
                                             at: t0.addingTimeInterval(1)))
        XCTAssertEqual(feed.expanded, second)
        XCTAssertEqual(feed.front?.id, second)
        XCTAssertEqual(feed.behindFront, 1)
    }

    func testFoldingAndUnfoldingAPinnedCard() throws {
        var feed = ToastFeed()
        let id = try XCTUnwrap(feed.post(ToastItem(message: "Couldn't merge into main", tone: .error), at: t0))
        feed.fold(id)
        XCTAssertNil(feed.expanded)
        XCTAssertEqual(feed.pinned.count, 1, "folding keeps it on screen as a pill")
        feed.unfold(id)
        XCTAssertEqual(feed.expanded, id)
        feed.dismiss(id)
        XCTAssertTrue(feed.pinned.isEmpty)
        XCTAssertNil(feed.expanded)
    }

    func testATimerOnlyTakesDownTheToastItWasStartedFor() throws {
        var feed = ToastFeed()
        let old = try XCTUnwrap(feed.post(ToastItem(message: "Session completed", canUndo: true), at: t0))
        feed.post(ToastItem(message: "Link copied"), at: t0.addingTimeInterval(1))
        feed.expire(old)
        XCTAssertEqual(feed.transient?.message, "Link copied")
    }

    func testTwoTapsOnCopyAreOneToast() {
        var feed = ToastFeed()
        XCTAssertNotNil(feed.post(ToastItem(message: "Link copied"), at: t0))
        XCTAssertNil(feed.post(ToastItem(message: "Link copied"), at: t0.addingTimeInterval(0.5)))
        XCTAssertNotNil(feed.post(ToastItem(message: "Link copied"), at: t0.addingTimeInterval(3)))
    }

    // MARK: one operation, one toast

    func testAResultTakesItsProgressPillsPlace() throws {
        var feed = ToastFeed()
        let pill = try XCTUnwrap(feed.post(ToastItem(message: "Merging into main…", key: "merge:s1", inProgress: true),
                                           at: t0))
        let result = feed.post(ToastItem(message: "Merged into main", sessionID: "s1", key: "merge:s1"),
                               at: t0.addingTimeInterval(20))
        XCTAssertEqual(result, pill, "same toast, new content — not a second arrival")
        XCTAssertEqual(feed.transient?.message, "Merged into main")
        XCTAssertEqual(feed.transient?.level, .confirm)
    }

    func testAFailedOperationsPillTurnsIntoAPinnedCard() {
        var feed = ToastFeed()
        feed.post(ToastItem(message: "Merging into main…", key: "merge:s1", inProgress: true), at: t0)
        feed.post(ToastItem(message: "Couldn't merge into main", detail: "CONFLICT", tone: .error, key: "merge:s1"),
                  at: t0.addingTimeInterval(20))
        XCTAssertNil(feed.transient, "the spinner goes")
        XCTAssertEqual(feed.pinned.map(\.message), ["Couldn't merge into main"])
        XCTAssertEqual(feed.expanded, feed.pinned.first?.id)
    }

    func testARetrysSuccessClearsTheFailureItAnswered() {
        var feed = ToastFeed()
        feed.post(ToastItem(message: "Couldn't merge into main", tone: .error, key: "merge:s1"), at: t0)
        feed.post(ToastItem(message: "Merged into main", key: "merge:s1"), at: t0.addingTimeInterval(60))
        XCTAssertTrue(feed.pinned.isEmpty)
        XCTAssertNil(feed.expanded)
        XCTAssertEqual(feed.transient?.message, "Merged into main")
    }

    func testTheSameFailureAgainUpdatesItsCard() throws {
        var feed = ToastFeed()
        let id = try XCTUnwrap(feed.post(ToastItem(message: "Couldn't merge into main", detail: "first", tone: .error,
                                                   key: "merge:s1"), at: t0))
        feed.fold(id)
        let again = feed.post(ToastItem(message: "Couldn't merge into main", detail: "second", tone: .error,
                                        key: "merge:s1"), at: t0.addingTimeInterval(30))
        XCTAssertEqual(again, id)
        XCTAssertEqual(feed.pinned.map(\.detail), ["second"])
        XCTAssertEqual(feed.expanded, id, "a new failure opens again")
    }

    func testKeysBelongToOneOperation() {
        var feed = ToastFeed()
        feed.post(ToastItem(message: "Merging into main…", key: "merge:s1", inProgress: true), at: t0)
        feed.post(ToastItem(message: "Merged into main", key: "merge:s2"), at: t0.addingTimeInterval(1))
        XCTAssertEqual(feed.transient?.message, "Merged into main", "another session's result is its own toast")
    }

    // MARK: approvals

    func testAnApprovalAnsweredAnywhereLeaves() {
        var feed = ToastFeed()
        feed.post(ToastItem(message: "Deploy staging is waiting", tone: .warning, sessionID: "s1", awaitsApproval: true),
                  at: t0)
        feed.post(ToastItem(message: "P1 fix is waiting", tone: .warning, sessionID: "s2", awaitsApproval: true),
                  at: t0.addingTimeInterval(1))
        feed.post(ToastItem(message: "Couldn't commit", tone: .error, sessionID: "s1"), at: t0.addingTimeInterval(2))
        feed.clearApprovals(stillWaiting: ["s2"])
        XCTAssertEqual(feed.pinned.map(\.message), ["P1 fix is waiting", "Couldn't commit"],
                       "only the answered approval goes; a failure about the same session stays")
    }
}
