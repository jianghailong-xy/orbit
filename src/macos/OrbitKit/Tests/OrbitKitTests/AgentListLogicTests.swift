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

    // MARK: a machine with no workspace (board rules 9 and 11)

    private func runner(_ id: String, online: Bool?, displayName: String? = nil, status: String? = nil) -> Runner {
        var fields = [#""id":"\#(id)""#, #""name":"\#(id)@host""#]
        if let online { fields.append(#""online":\#(online)"#) }
        if let displayName { fields.append(#""displayName":"\#(displayName)""#) }
        if let status { fields.append(#""status":"\#(status)""#) }
        return try! JSONDecoder().decode(Runner.self, from: Data("{\(fields.joined(separator: ","))}".utf8))
    }

    func testAnOnlineMachineWithNoWorkspaceGetsARow() {
        let machines = AgentListLogic.machinesToSetUp(
            runners: [runner("austin", online: true), runner("hpc", online: true)],
            agents: [agent(#"{"id":"w","name":"a","runnerId":"hpc"}"#)])
        XCTAssertEqual(machines, [MachineToSetUp(id: "austin", name: "austin@host")])
    }

    func testNotOneThatIsOfflineWhateverItHolds() {
        XCTAssertEqual(AgentListLogic.machinesToSetUp(runners: [runner("gone", online: false)], agents: []), [])
    }

    func testAMachineNobodyHasSaidIsOnlineIsNotOne() {
        XCTAssertEqual(AgentListLogic.machinesToSetUp(runners: [runner("older", online: nil)], agents: []), [])
        // An older server's row with no `online` is read by its status, as the rail reads it.
        XCTAssertEqual(AgentListLogic.machinesToSetUp(runners: [runner("older", online: nil, status: "ONLINE")], agents: []).map(\.id),
                       ["older"])
    }

    func testAConfigOnlyWorkspaceIsOnNoMachine() {
        let machines = AgentListLogic.machinesToSetUp(runners: [runner("austin", online: true)],
                                                      agents: [agent(#"{"id":"w","name":"a"}"#)])
        XCTAssertEqual(machines.map(\.id), ["austin"])
    }

    func testRowsKeepTheRunnerListsOrder() {
        let machines = AgentListLogic.machinesToSetUp(
            runners: [runner("hpc", online: true), runner("gone", online: false), runner("austin", online: true)],
            agents: [])
        XCTAssertEqual(machines.map(\.id), ["hpc", "austin"])
    }

    func testAMachineIsNamedTheWayTheAppNamesIt() {
        XCTAssertEqual(AgentListLogic.machinesToSetUp(runners: [runner("r", online: true, displayName: "HPC")], agents: [])
            .map(\.name), ["HPC"])
    }

    /// The Mac's sidebar: a group per machine, with the empty ones after every workspace, Shared included.
    func testTheMacsGroupsPutEmptyMachinesAfterEveryWorkspace() {
        let groups = AgentListLogic.sidebarGroups(
            [agent(#"{"id":"1","name":"a","runnerId":"r1"}"#), agent(#"{"id":"2","name":"b"}"#)],
            machines: [MachineToSetUp(id: "austin", name: "orbit@austin")])
        XCTAssertEqual(groups.map(\.runnerId), ["r1", nil, "austin"])
        XCTAssertEqual(groups.last?.setUp, MachineToSetUp(id: "austin", name: "orbit@austin"))
        XCTAssertEqual(groups.last?.agents, [])
        XCTAssertNil(groups.first?.setUp)
    }

    func testAnEmptyAccountsGroupsAreItsMachines() {
        let groups = AgentListLogic.sidebarGroups([], machines: [MachineToSetUp(id: "austin", name: "orbit@austin")])
        XCTAssertEqual(groups.map(\.id), ["austin"])
    }

    func testNewSessionStaysInTheWorkspaceInView() {
        XCTAssertEqual(AgentListLogic.newSessionTarget(currentAgentID: "w", list: .content(showsError: false),
                                                       firstOnlineMachine: "austin"), .workspace("w"))
    }

    func testWithNoWorkspaceNewSessionOpensTheFirstOnlineMachine() {
        XCTAssertEqual(AgentListLogic.newSessionTarget(currentAgentID: nil, list: .empty, firstOnlineMachine: "austin"),
                       .machine("austin"))
    }

    func testWithNoMachineToOpenNewSessionGoesToMachinesAndModels() {
        XCTAssertEqual(AgentListLogic.newSessionTarget(currentAgentID: nil, list: .empty, firstOnlineMachine: nil), .machines)
    }

    func testAListThatHasntAnsweredIsNoReasonToGoAnywhere() {
        for list: ListLoadPresentation? in [.loading, .failed, nil] {
            XCTAssertNil(AgentListLogic.newSessionTarget(currentAgentID: nil, list: list, firstOnlineMachine: "austin"))
        }
    }
}
