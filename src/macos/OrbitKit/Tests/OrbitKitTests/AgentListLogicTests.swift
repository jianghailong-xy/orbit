import XCTest
@testable import OrbitKit

final class AgentListLogicTests: XCTestCase {

    private func agent(_ json: String) -> Agent {
        try! JSONDecoder().decode(Agent.self, from: Data(json.utf8))
    }

    func testGroupsByRunnerHostLast() {
        let agents = [
            agent(#"{"id":"1","name":"a","runnerId":"r1"}"#),
            agent(#"{"id":"2","name":"b"}"#),                      // host-level
            agent(#"{"id":"3","name":"c","runnerId":"r2"}"#),
            agent(#"{"id":"4","name":"d","runnerId":"r1"}"#),
        ]
        let groups = AgentListLogic.grouped(agents)
        XCTAssertEqual(groups.map(\.runnerId), ["r1", "r2", nil])  // first-seen runner order, host last
        XCTAssertEqual(groups.first?.agents.map(\.id), ["1", "4"]) // r1 keeps both, in order
        XCTAssertEqual(groups.last?.agents.map(\.id), ["2"])       // host group
    }

    func testOrderedMatchesSidebarWithHostLast() {
        let agents = [
            agent(#"{"id":"1","name":"a","runnerId":"r1"}"#),
            agent(#"{"id":"2","name":"b"}"#),                      // host-level
            agent(#"{"id":"3","name":"c","runnerId":"r2"}"#),
            agent(#"{"id":"4","name":"d","runnerId":"r1"}"#),
            agent(#"{"id":"5","name":"e"}"#),
        ]
        #if os(macOS)
        // The macOS sidebar still groups by runner; shortcuts follow those rows.
        XCTAssertEqual(AgentListLogic.ordered(agents).map(\.id), ["1", "4", "3", "2", "5"])
        #else
        // The iOS drawer follows the server's workspace order, even across runners. Only
        // runner-less workspaces move to the bottom, retaining their relative order too.
        XCTAssertEqual(AgentListLogic.ordered(agents).map(\.id), ["1", "3", "4", "2", "5"])
        #endif
        XCTAssertEqual(AgentListLogic.ordered([]).map(\.id), [])
    }

    func testRunnerOrderMatchesPersistedOrderWithHostLast() {
        let agents = [
            agent(#"{"id":"1","name":"a","runnerId":"workstation"}"#),
            agent(#"{"id":"2","name":"b"}"#),                              // host-level
            agent(#"{"id":"3","name":"c","runnerId":"wikova"}"#),
            agent(#"{"id":"4","name":"d","runnerId":"macbook"}"#),
        ]
        // The macOS sidebar orders runner groups by the persisted runner order.
        let groups = AgentListLogic.grouped(agents, runnerOrder: ["wikova", "macbook", "workstation"])
        XCTAssertEqual(groups.map(\.runnerId), ["wikova", "macbook", "workstation", nil])
        #if os(macOS)
        XCTAssertEqual(AgentListLogic.ordered(agents, runnerOrder: ["wikova", "macbook", "workstation"]).map(\.id),
                       ["3", "4", "1", "2"])
        #else
        // A runner refresh must not reshuffle the iOS workspace list, including when the
        // directory has not loaded yet or omits a runner.
        for runnerOrder in [[], ["wikova", "macbook", "workstation"], ["macbook", "wikova"]] {
            XCTAssertEqual(AgentListLogic.ordered(agents, runnerOrder: runnerOrder).map(\.id),
                           ["1", "3", "4", "2"])
        }
        #endif
    }

    func testUnknownRunnersStayStableAfterKnownOnes() {
        let agents = [
            agent(#"{"id":"1","name":"a","runnerId":"stale-a"}"#),
            agent(#"{"id":"2","name":"b","runnerId":"second"}"#),
            agent(#"{"id":"3","name":"c","runnerId":"stale-b"}"#),
            agent(#"{"id":"4","name":"d","runnerId":"first"}"#),
        ]
        let groups = AgentListLogic.grouped(agents, runnerOrder: ["first", "second"])
        XCTAssertEqual(groups.map(\.runnerId), ["first", "second", "stale-a", "stale-b"])
    }
}
