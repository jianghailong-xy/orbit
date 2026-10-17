import XCTest
@testable import OrbitKit

final class SessionProjectCopyTests: XCTestCase {
    func testRowMenuOpensTheSession() {
        XCTAssertEqual(SessionProjectCopy.openSession, "Open Session")
        XCTAssertEqual(SessionProjectCopy.openCoordinator, "Open Coordinator")
    }

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

    /// What a start request suggests, directly into the main branch the start card opens with — the
    /// sessions page passes `StartProject.mainBranch(suggested:standing:)` off the integration read it
    /// holds — or, with none at hand, the one the request names; main for a request that names none.
    /// Web: `sessionProjects.test.ts` › "says what a start request suggests directly into the main
    /// branch it names, main as before".
    func testTheSuggestionSaysDirectlyIntoTheMainBranchTheStartOpensWith() {
        let suggested = ProjectStartSettings(line: .main, upstreamRef: "refs/heads/master", automatic: true,
                                             maxConcurrentTasks: 2)
        XCTAssertEqual(SessionProjectCopy.startSuggestion(suggested), "Directly into master · Automatic on · 2 at a time")
        // The owner's own choice for this project outranks the suggestion, as on the start card.
        let chosen = ProjectIntegrationView(upstreamRef: "trunk", upstreamChosenAt: "2026-10-10T00:00:00Z",
                                            repository: "acme/payments")
        let main = StartProject.mainBranch(suggested: suggested.upstreamRef, standing: chosen)
        XCTAssertEqual(SessionProjectCopy.startSuggestion(suggested, main: main),
                       "Directly into trunk · Automatic on · 2 at a time")
        XCTAssertEqual(SessionProjectCopy.startSuggestion(ProjectStartSettings(line: .main, automatic: false,
                                                                               maxConcurrentTasks: 1)),
                       "Directly into main · Automatic off · 1 at a time")
        // A project branch names no main branch.
        XCTAssertEqual(SessionProjectCopy.startSuggestion(ProjectStartSettings(line: .projectBranch,
                                                                               upstreamRef: "refs/heads/master",
                                                                               automatic: true, maxConcurrentTasks: 3),
                                                          main: "master"),
                       "Project branch · Automatic on · 3 at a time")
    }
}
