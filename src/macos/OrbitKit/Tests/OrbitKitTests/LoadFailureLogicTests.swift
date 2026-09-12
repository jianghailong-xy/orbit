import XCTest
@testable import OrbitKit

final class LoadFailureLogicTests: XCTestCase {

    private enum Step { case begin, succeed, fail }

    /// A list whose fetches went `steps`, in order.
    private func history(_ steps: Step...) -> ListLoadState {
        var state = ListLoadState()
        for step in steps {
            switch step {
            case .begin: state.begin()
            case .succeed: state.succeed()
            case .fail: state.fail()
            }
        }
        return state
    }

    private func presentation(_ state: ListLoadState, isEmpty: Bool) -> ListLoadPresentation {
        LoadFailureLogic.presentation(state, isEmpty: isEmpty)
    }

    // MARK: What a list draws

    func testFirstFetchInFlightShowsLoading() {
        XCTAssertEqual(presentation(history(.begin), isEmpty: true), .loading)
        // Before the list's `.task` has even started the first fetch there is still nothing to say
        // "No runners" about.
        XCTAssertEqual(presentation(ListLoadState(), isEmpty: true), .loading)
    }

    func testFailedFetchWithNothingInHandIsFailedNotEmpty() {
        let offline = history(.begin, .fail)
        XCTAssertEqual(presentation(offline, isEmpty: true), .failed)
        XCTAssertNotEqual(presentation(offline, isEmpty: true), .empty)
        // An earlier empty answer doesn't survive a failed refresh: the server couldn't be asked
        // whether the list is still empty, so the surface says the request failed.
        XCTAssertEqual(presentation(history(.begin, .succeed, .begin, .fail), isEmpty: true), .failed)
    }

    func testFailedFetchKeepsEarlierRowsAndFlagsTheError() {
        let stale = history(.begin, .succeed, .begin, .fail)
        XCTAssertEqual(presentation(stale, isEmpty: false), .content(showsError: true))
    }

    func testSuccessfulEmptyFetchIsEmpty() {
        XCTAssertEqual(presentation(history(.begin, .succeed), isEmpty: true), .empty)
        // A refresh of a list known to be empty keeps saying so rather than flickering to a spinner.
        XCTAssertEqual(presentation(history(.begin, .succeed, .begin), isEmpty: true), .empty)
    }

    func testSuccessfulFetchWithRowsShowsThem() {
        XCTAssertEqual(presentation(history(.begin, .succeed), isEmpty: false), .content(showsError: false))
        // A refresh in flight doesn't hide the rows already in hand.
        XCTAssertEqual(presentation(history(.begin, .succeed, .begin), isEmpty: false),
                       .content(showsError: false))
    }

    func testRetryAfterFailureSpinsThenSettlesOnTheNewAnswer() {
        XCTAssertEqual(presentation(history(.begin, .fail, .begin), isEmpty: true), .loading)
        XCTAssertEqual(presentation(history(.begin, .fail, .begin, .fail), isEmpty: true), .failed)
        XCTAssertEqual(presentation(history(.begin, .fail, .begin, .succeed), isEmpty: true), .empty)
        XCTAssertEqual(presentation(history(.begin, .fail, .begin, .succeed), isEmpty: false),
                       .content(showsError: false))
    }

    func testLoadStateFollowsTheLatestOutcome() {
        let first = history(.begin)
        XCTAssertTrue(first.loading)
        XCTAssertFalse(first.hasLoaded)
        XCTAssertFalse(first.lastLoadFailed)

        let recovered = history(.begin, .fail, .begin, .succeed)
        XCTAssertFalse(recovered.loading)
        XCTAssertTrue(recovered.hasLoaded)
        XCTAssertFalse(recovered.lastLoadFailed)

        let relapsed = history(.begin, .succeed, .begin, .fail)
        XCTAssertFalse(relapsed.loading)
        XCTAssertTrue(relapsed.hasLoaded)
        XCTAssertTrue(relapsed.lastLoadFailed)
    }

    // MARK: Where a cold launch lands

    /// Defaults to the launch default: Workspaces, nothing picked yet.
    private func landing(_ agents: ListLoadState, ids: [String], last: String? = nil,
                         section: AppSection = .agents, agentID: String? = nil,
                         sessionID: String? = nil) -> DefaultLanding {
        LoadFailureLogic.defaultLanding(agents: agents, orderedAgentIDs: ids, lastAgentID: last,
                                        section: section, selectedAgentID: agentID,
                                        selectedSessionID: sessionID)
    }

    func testFailedWorkspaceFetchDecidesNothingAndLeavesTheLandingOpen() {
        // Offline cold launch: the empty starting list is not the server saying "no workspaces".
        let decision = landing(history(.begin, .fail), ids: [], last: "a")
        XCTAssertEqual(decision, .undecided)
        XCTAssertNotEqual(decision, .runners)
        XCTAssertFalse(decision.latches)
        // Still undecided when an earlier fetch said empty: the latest one failed.
        XCTAssertEqual(landing(history(.begin, .succeed, .begin, .fail), ids: []), .undecided)
        // And nothing is decided while the first fetch is out, or before it starts.
        XCTAssertEqual(landing(history(.begin), ids: []), .undecided)
        XCTAssertEqual(landing(ListLoadState(), ids: []), .undecided)
    }

    func testSuccessfulEmptyFetchGoesToRunnersOnboarding() {
        let decision = landing(history(.begin, .succeed), ids: [])
        XCTAssertEqual(decision, .runners)
        XCTAssertTrue(decision.latches)
    }

    func testLandsOnTheRememberedWorkspace() {
        let decision = landing(history(.begin, .succeed), ids: ["a", "b", "c"], last: "b")
        XCTAssertEqual(decision, .agent("b"))
        XCTAssertTrue(decision.latches)
    }

    func testRememberedWorkspaceMatchesAcrossIdSpellings() {
        // The same agent, remembered by one build and listed by another in the other spelling. The
        // landing selects the id as the list spells it, not the remembered string.
        let uuid = "019fcbf3-0fa8-7f83-9302-46b25389cb16"
        let base62 = "341DOGTVEs0Fk0gAn1mje"
        XCTAssertEqual(landing(history(.begin, .succeed), ids: ["a", base62], last: uuid), .agent(base62))
        XCTAssertEqual(landing(history(.begin, .succeed), ids: ["a", uuid], last: base62), .agent(uuid))
    }

    func testWithoutAMatchLandsOnTheFirstWorkspace() {
        XCTAssertEqual(landing(history(.begin, .succeed), ids: ["a", "b"], last: "gone"), .agent("a"))
        XCTAssertEqual(landing(history(.begin, .succeed), ids: ["a", "b"]), .agent("a"))
    }

    func testAnExistingChoiceIsKept() {
        let loaded = history(.begin, .succeed)
        // A deep link or notification into another section — even with no workspaces at all.
        XCTAssertEqual(landing(loaded, ids: ["a"], section: .tasks), .keepCurrent)
        XCTAssertEqual(landing(loaded, ids: [], section: .settings), .keepCurrent)
        // A workspace already picked, or a session still resolving its workspace.
        XCTAssertEqual(landing(loaded, ids: ["a", "b"], last: "a", agentID: "b"), .keepCurrent)
        XCTAssertEqual(landing(loaded, ids: ["a"], sessionID: "s1"), .keepCurrent)
        XCTAssertTrue(DefaultLanding.keepCurrent.latches)
        // A failed fetch still decides nothing, choice or not: the latch waits for a real answer.
        XCTAssertEqual(landing(history(.begin, .fail), ids: [], section: .tasks), .undecided)
    }

    func testOfflineLaunchLandsOnceTheReconnectReloadSucceeds() {
        // Cold launch offline: the drawer's fetch fails — nothing decided, nothing latched, and the
        // list says it couldn't load rather than that there is nothing.
        var agents = ListLoadState()
        agents.begin()
        agents.fail()
        XCTAssertEqual(landing(agents, ids: [], last: "b"), .undecided)
        XCTAssertEqual(presentation(agents, isEmpty: true), .failed)
        // Back online: the control plane reconnects and reloads the list, which now answers.
        agents.begin()
        XCTAssertEqual(presentation(agents, isEmpty: true), .loading)
        agents.succeed()
        XCTAssertEqual(landing(agents, ids: ["a", "b"], last: "b"), .agent("b"))
        XCTAssertEqual(presentation(agents, isEmpty: false), .content(showsError: false))
    }
}
