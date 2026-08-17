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

    func testOrderedFlattensGroupsHostLast() {
        let agents = [
            agent(#"{"id":"1","name":"a","runnerId":"r1"}"#),
            agent(#"{"id":"2","name":"b"}"#),                      // host-level
            agent(#"{"id":"3","name":"c","runnerId":"r2"}"#),
            agent(#"{"id":"4","name":"d","runnerId":"r1"}"#),
        ]
        // The ⌘1…⌘9 index order: r1 group (1,4), then r2 (3), then host (2) — i.e. exactly the
        // order the sidebar renders its grouped rows.
        XCTAssertEqual(AgentListLogic.ordered(agents).map(\.id), ["1", "4", "3", "2"])
        XCTAssertEqual(AgentListLogic.ordered([]).map(\.id), [])
    }

    func testRunnerOrderMatchesPersistedOrderWithHostLast() {
        let agents = [
            agent(#"{"id":"1","name":"a","runnerId":"workstation"}"#),
            agent(#"{"id":"2","name":"b"}"#),                              // host-level
            agent(#"{"id":"3","name":"c","runnerId":"wikova"}"#),
            agent(#"{"id":"4","name":"d","runnerId":"macbook"}"#),
        ]
        // The web sidebar orders runner groups by the persisted runner order, not by whichever
        // runner an agent happened to mention first.
        let groups = AgentListLogic.grouped(agents, runnerOrder: ["wikova", "macbook", "workstation"])
        XCTAssertEqual(groups.map(\.runnerId), ["wikova", "macbook", "workstation", nil])
        XCTAssertEqual(AgentListLogic.ordered(agents, runnerOrder: ["wikova", "macbook", "workstation"]).map(\.id),
                       ["3", "4", "1", "2"])
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
