import Foundation
import XCTest

/// SwiftUI doesn't exist on Linux, so nothing here compiles the app shells. These hold the Projects
/// section and the drawer that leads to it to the source they are: the section's stack is the only
/// copy of which project is showing, the three-column shells select through a projection of it, and
/// the iPhone drawer leads with the work — Projects, Tasks, Following — above the Workspaces, with
/// the open projects closing the rail where the task lists and Recents used to be.
final class ProjectsWiringTests: XCTestCase {
    private struct SourceMissing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "\(path) wasn't found above this test. If it moved, point this check at its new home — "
                + "don't delete the check."
        }
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
        throw SourceMissing(path: path)
    }

    private func slice(_ text: String, from start: String, to end: String) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`")
        let upper = try XCTUnwrap(text.range(of: end, range: lower.upperBound..<text.endIndex),
                                  "no `\(end)` after `\(start)`")
        return String(text[lower.lowerBound..<upper.upperBound])
    }

    private func code(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }

    func testTheCompactProjectsSectionIsAStackBoundToItsOwnStack() throws {
        let shell = try appSource("Views/CompactShell.swift")
        let projects = code(try slice(shell, from: "case .projects:", to: "case .runners:"))
        XCTAssertTrue(projects.contains("NavigationStack(path: $model.nav.path)"))
        XCTAssertTrue(projects.contains("ProjectsListView(rowNavigation: .push)"))
        XCTAssertTrue(projects.contains("case .projectDetail(let projectID): ProjectDetailView(projectID: projectID)"))
        XCTAssertFalse(projects.contains("TaskDetailPage"),
                       "a project's task opens in Tasks, whose stack its detail store follows")
    }

    func testTheThreeColumnShellsSelectThroughAProjectionOfTheStack() throws {
        let main = code(try appSource("Views/MainView.swift"))
        XCTAssertTrue(main.contains("case .projects:\n            ProjectsListView()"))
        XCTAssertTrue(main.contains("case .projects:\n            ProjectDetailPane()"))
        let app = code(try appSource("AppModel.swift"))
        let selected = try slice(app, from: "var selectedProjectID: String? {", to: "\n    }\n")
        XCTAssertTrue(selected.contains("get { nav.selectedProjectID }"))
        XCTAssertTrue(selected.contains("nav.replaceTop(with: .projectDetail(projectID: id))"))
        let list = code(try appSource("Views/ProjectsView.swift"))
        XCTAssertTrue(list.contains("List(selection: rowNavigation == .selection ? $model.selectedProjectID : nil)"))
        XCTAssertTrue(list.contains("model.push(.projectDetail(projectID: project.id))"))
    }

    func testTheDrawerLeadsWithTheWorkAndClosesWithTheOpenProjects() throws {
        let shell = try appSource("Views/CompactShell.swift")
        let rail = code(try slice(shell, from: "            List {", to: "            .listStyle(.plain)"))
        let order = ["ForEach(AppSection.workSections)", "workspacesHeader", "agentsRows", "projectRows"]
        let positions = order.map { rail.range(of: $0)?.lowerBound }
        XCTAssertFalse(positions.contains(nil), "the rail lost one of \(order)")
        XCTAssertEqual(positions.compactMap { $0 }, positions.compactMap { $0 }.sorted(),
                       "the rail reads work, then Workspaces, then the open projects")
        XCTAssertFalse(rail.contains("recentsRows"), "Recents is not in the drawer")
        XCTAssertFalse(rail.contains("taskRows"), "the task lists are not in the drawer")
        let row = code(try slice(shell, from: "private func projectRow(", to: ".drawerRow()"))
        XCTAssertTrue(row.contains("model.openProject(project.id)"))
    }

    func testAnOwnerItemOpensItsCardInTheCoordinatorConversation() throws {
        let app = code(try appSource("AppModel.swift"))
        let open = try slice(app, from: "func openProjectCoordinator(", to: "\n    }\n")
        XCTAssertTrue(open.contains(".focus(ownerItem: item)"),
                      "a press on an owner item lands on its card, the way the needs-you banner's does")
        XCTAssertTrue(open.contains("show(.console(sessionID: id, origin: .list), agent: agent)"))
    }
}
