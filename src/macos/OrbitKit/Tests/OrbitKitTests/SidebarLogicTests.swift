import XCTest
@testable import OrbitKit

final class SidebarLogicTests: XCTestCase {
    /// The stored value reads the navigation state the way the old computed binding did: a machine
    /// draft page on top wins over the open project's sessions column, which wins over the
    /// Workspace, which wins over the plain section.
    func testTheStoredSelectionReadsTheMachineDraftThenTheProjectThenTheAgentThenTheSection() {
        XCTAssertEqual(SidebarLogic.selection(section: .agents, agentID: "a1",
                                              machineDraftRunnerID: "r1", projectID: "p1"),
                       .machine("r1"))
        XCTAssertEqual(SidebarLogic.selection(section: .agents, agentID: "a1",
                                              machineDraftRunnerID: nil, projectID: "p1"),
                       .project("p1"))
        XCTAssertEqual(SidebarLogic.selection(section: .agents, agentID: "a1",
                                              machineDraftRunnerID: nil, projectID: nil),
                       .agent("a1"))
        XCTAssertEqual(SidebarLogic.selection(section: .agents, agentID: nil,
                                              machineDraftRunnerID: nil, projectID: nil),
                       .section(.agents))
        // A workspace and a project both stay selected while another section is on screen; the
        // section is what shows.
        XCTAssertEqual(SidebarLogic.selection(section: .wiki, agentID: "a1",
                                              machineDraftRunnerID: nil, projectID: "p1"),
                       .section(.wiki))
    }

    /// Every stored value maps to its one navigation action, and nil maps to none.
    func testATargetMapsEveryStoredValueAndNil() {
        XCTAssertEqual(SidebarLogic.target(.section(.tasks)), .section(.tasks))
        XCTAssertEqual(SidebarLogic.target(.agent("a1")), .agent("a1"))
        XCTAssertEqual(SidebarLogic.target(.machine("r1")), .machine("r1"))
        XCTAssertEqual(SidebarLogic.target(.project("p1")), .project("p1"))
        XCTAssertEqual(SidebarLogic.target(nil), .none)
    }

    /// Each stored value, applied the way the view applies it, reads back as itself.
    func testEveryStoredValueRoundTripsThroughTheNavigationState() {
        for stored in [SidebarSelection.section(.tasks), .section(.wiki), .agent("a1"),
                       .machine("r1"), .project("p1"), .guestSession("g1")] {
            var section = AppSection.agents
            var agentID: String?
            var machine: String?
            var project: String?
            var guest: String?
            switch SidebarLogic.target(stored) {
            case .section(let s): section = s
            case .agent(let id): section = .agents; agentID = id
            case .machine(let id): section = .agents; machine = id
            case .project(let id): section = .agents; project = id
            case .guestSession(let id): section = .agents; guest = id
            case .none: break
            }
            XCTAssertEqual(SidebarLogic.selection(section: section, agentID: agentID,
                                                  machineDraftRunnerID: machine,
                                                  projectID: project, guestSessionID: guest), stored)
        }
    }
}
