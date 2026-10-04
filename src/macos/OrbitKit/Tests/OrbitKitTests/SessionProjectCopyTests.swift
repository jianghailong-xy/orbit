import XCTest
@testable import OrbitKit

final class SessionProjectCopyTests: XCTestCase {
    func testProgressAndPageCountsUseTheDesignsWords() {
        XCTAssertEqual(SessionProjectCopy.progress(done: 0, total: 0), "0/0")
        XCTAssertEqual(SessionProjectCopy.progressHint(sessions: 5, running: 2), "5 sessions · 2 running")
        XCTAssertEqual(SessionProjectCopy.pageSubtitle(sessions: 5), "Project · 5 sessions")
        XCTAssertEqual(SessionProjectCopy.pageProgress(done: 3, total: 5, running: 2), "3/5 done · 2 running")
    }

    func testWaitingLinePreservesTheSessionWordsAndTitle() {
        XCTAssertEqual(SessionProjectCopy.waitingSession("Waiting for your confirmation", title: "Retry"),
                       "Waiting for your confirmation · Retry")
    }

    func testUnknownCoordinatorLeadAddsNoInventedPhrase() {
        XCTAssertNil(SessionProjectCopy.coordinatorLead(.unknown))
    }
}
