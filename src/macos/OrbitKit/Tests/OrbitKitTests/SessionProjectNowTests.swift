import Foundation
import XCTest
@testable import OrbitKit

/// The project sessions page's Now section: which members it lifts out of the time sections.
final class SessionProjectNowTests: XCTestCase {
    private func session(_ id: String, role: SessionProjectMembership.Role = .task,
                         state: SessionRunState = .awaitingInput, approvals: Int = 0,
                         engineTurnActive: Bool = false, bg: Int = 0) -> Session {
        Session(id: id, title: id, status: .awaitingInput, runState: state,
                agentId: "w1", assignedRunnerId: nil, pendingApprovals: approvals,
                branch: nil, updatedAt: nil,
                projectId: role == .coordinator ? "p1" : nil,
                projectTitle: role == .coordinator ? "Project one" : nil,
                lastAssistantText: "Last reply", lastToolUse: nil, lastUserText: nil,
                runningBgCount: bg, engineTurnActive: engineTurnActive,
                projectMembership: SessionProjectMembership(projectId: "p1", projectTitle: "Project one",
                                                            projectStatus: .open, role: role))
    }

    func testWorkingAndWaitingMembersAreNowInTheirOrder() {
        let sessions = [
            session("idle"),
            session("running", state: .running),
            session("approval", approvals: 1),
            session("engine-turn", engineTurnActive: true),
            session("ended", state: .ended),
            session("background-only", bg: 1),
        ]
        XCTAssertEqual(SessionProjectGrouping.nowSessions(sessions).map(\.id),
                       ["running", "approval", "engine-turn"])
    }

    func testTheCoordinatorKeepsItsOwnSection() {
        let sessions = [session("coordinator", role: .coordinator, state: .running),
                        session("judgment", role: .judgment, state: .running)]
        XCTAssertEqual(SessionProjectGrouping.nowSessions(sessions).map(\.id), ["judgment"])
    }

    private func appSource(_ relative: String) throws -> String {
        let path = "src/macos/OrbitApp/Sources/OrbitApp/\(relative)"
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(path)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir.deleteLastPathComponent()
        }
        throw CocoaError(.fileNoSuchFile)
    }

    /// SwiftUI does not compile on Linux, so the page's wiring is checked in its source.
    func testThePageDrawsNowAboveTheCoordinatorAndKeepsItOutOfTheTimeSections() throws {
        let page = try appSource("Views/SessionProjectPage.swift")
        XCTAssertTrue(page.contains("SessionProjectGrouping.nowSessions(sessions,"))
        XCTAssertTrue(page.contains("!now.contains($0.id)"), "a member in Now is not repeated under Today")
        let body = try XCTUnwrap(page.range(of: "progressCard\n                .listRowSeparator(.hidden)\n            nowSection\n            if let coordinator {"))
        XCTAssertFalse(body.isEmpty)
        XCTAssertTrue(page.contains("ProjectPage.landingLine(integration, now: context.date,"))
        XCTAssertTrue(page.contains("ProjectLandingRow(line: line)"), "a landing uses the project page's own row")
        XCTAssertTrue(page.contains("Text(SessionProjectCopy.nothingRunning)"))
        let app = try appSource("AppModel.swift")
        XCTAssertTrue(app.contains("api.projectIntegration(address.projectID)"))
    }

    func testTheSectionHasItsOwnWords() {
        XCTAssertEqual(SessionProjectCopy.nowSection, "Now")
        XCTAssertEqual(SessionProjectCopy.nothingRunning, "Nothing running")
    }
}
