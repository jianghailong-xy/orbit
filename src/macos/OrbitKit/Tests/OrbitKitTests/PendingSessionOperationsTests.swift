import XCTest
@testable import OrbitKit

final class PendingSessionOperationsTests: XCTestCase {
    private func detail(merge: String? = nil, commit: String? = nil) -> SessionDetail {
        SessionDetail(id: "s1", mergeStatus: merge, commitStatus: commit)
    }

    func testAMergeSettlesOnceTheRunnerAnswersAndIsReportedOnce() {
        var pending = PendingSessionOperations()
        let merge = pending.track(.merge, sessionID: "s1")

        XCTAssertNil(pending.settle(merge, with: detail(merge: "pending")), "still waiting on the runner")
        XCTAssertEqual(pending.operations, [merge])

        XCTAssertEqual(pending.settle(merge, with: detail(merge: "merged")), merge)
        XCTAssertTrue(pending.isEmpty)
        XCTAssertNil(pending.settle(merge, with: detail(merge: "merged")),
                     "the console's poll and the app's both read the result; only the first reports it")
    }

    func testEachKindWaitsOnItsOwnStatus() {
        var pending = PendingSessionOperations()
        let commit = pending.track(.commit, sessionID: "s1")

        XCTAssertNil(pending.settle(commit, with: detail(merge: "merged", commit: "pending")),
                     "a merge status says nothing about a commit")
        XCTAssertEqual(pending.settle(commit, with: detail(merge: "pending", commit: "error")), commit)
    }

    /// Web drops these silently: a Resume clears the status, and the request it superseded has no
    /// result coming. Left in, it would be polled forever.
    func testAClearedStatusSettlesTheRequest() {
        var pending = PendingSessionOperations()
        let merge = pending.track(.merge, sessionID: "s1")

        XCTAssertEqual(pending.settle(merge, with: detail()), merge)
        XCTAssertTrue(pending.isEmpty)
    }

    /// A retry after a conflict: a read still answering the first request carries its `conflict`,
    /// which must not end the retry before the runner has even seen it.
    func testAReadForAReplacedRequestCannotSettleTheNewOne() {
        var pending = PendingSessionOperations()
        let first = pending.track(.merge, sessionID: "s1")
        let retry = pending.track(.merge, sessionID: "s1")

        XCTAssertNotEqual(first, retry)
        XCTAssertNil(pending.settle(first, with: detail(merge: "conflict")))
        XCTAssertEqual(pending.operations, [retry])
        XCTAssertEqual(pending.settle(retry, with: detail(merge: "merged")), retry)
    }

    func testAReadTakenAnywayAnswersWhateverIsPendingThere() {
        var pending = PendingSessionOperations()
        XCTAssertNil(pending.settle(sessionID: "s1", with: detail(merge: "merged")),
                     "a merge nobody here asked for is the bar's to show, not a card's")

        let merge = pending.track(.merge, sessionID: "s1")
        let other = pending.track(.commit, sessionID: "s2")
        XCTAssertEqual(pending.settle(sessionID: "s1", with: detail(merge: "merged")), merge)
        XCTAssertEqual(pending.operations, [other])
    }

    func testDropForgetsOnlyThatRequest() {
        var pending = PendingSessionOperations()
        let first = pending.track(.merge, sessionID: "s1")
        let retry = pending.track(.merge, sessionID: "s1")

        pending.drop(first)
        XCTAssertEqual(pending.operations, [retry], "a read for the first can't drop the one that replaced it")
        pending.drop(retry)
        XCTAssertTrue(pending.isEmpty)
    }
}
