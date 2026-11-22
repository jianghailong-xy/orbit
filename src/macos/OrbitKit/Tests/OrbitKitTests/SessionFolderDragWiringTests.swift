import Foundation
import XCTest
@testable import OrbitKit

/// Dragging a session row onto a folder on the Mac (`Views/SessionFolderDrop.swift`): the folder
/// rows and a folder page's head take the drop, the drop is the Move panel's own
/// `AppModel.moveSession` (so the same request and the same toast), the drag carries the app's own
/// type rather than text, and only the Mac draws any of it.
///
/// SwiftUI doesn't exist on Linux, so these read the sources, as the other wiring checks do.
final class SessionFolderDragWiringTests: XCTestCase {
    private struct SourceMissing: Error, CustomStringConvertible {
        let path: String
        var description: String { "\(path) wasn't found above this test. If it moved, point this check at its new home." }
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

    private func slice(_ text: String, from start: String, to end: String,
                       file: StaticString = #filePath, line: UInt = #line) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`", file: file, line: line)
        let upper = try XCTUnwrap(text.range(of: end, range: lower.upperBound..<text.endIndex),
                                  "no `\(end)` after `\(start)`", file: file, line: line)
        return String(text[lower.lowerBound..<upper.upperBound])
    }

    func testTheDropIsTheMovePanelsOwnMoveAndOnlyWhereItWouldMove() throws {
        let drop = try appSource("Views/SessionFolderDrop.swift")
        let perform = try slice(drop, from: "func performDrop(info: DropInfo) -> Bool {", to: "\n    }")
        XCTAssertTrue(perform.contains("guard takes(info), let session = drag.session else { return false }"))
        XCTAssertTrue(perform.contains("app.moveSession(session.id, toFolder: target.folderID)"),
                      "the panel's request and toast, no second move path")
        let takes = try slice(drop, from: "private func takes(_ info: DropInfo) -> Bool {", to: "\n    }")
        XCTAssertTrue(takes.contains("info.hasItemsConforming(to: [.orbitSessionRow])"))
        XCTAssertTrue(takes.contains("== .move"), "its own folder and another workspace's take nothing")
        XCTAssertTrue(drop.contains("UTType(exportedAs: \"app.orbit.session-row\", conformingTo: .data)"),
                      "the app's own type, not text the composer would take")
        XCTAssertFalse(drop.contains("NSItemProvider(object:"), "nothing readable as a string")
    }

    func testFolderRowsAndAFolderPagesHeadTakeTheDropAndTheRowsArePickedUpByTheRules() throws {
        let agents = try appSource("Views/AgentsView.swift")
        let folderRow = try slice(agents, from: "private func folderRow(_ row: SessionFolderRow)", to: ".contextMenu {")
        XCTAssertTrue(folderRow.contains(".sessionFolderDropTarget(folderID: row.folder.id, workspaceID: agent.id"))
        // Both lists draw their entries through the one builder, which asks the drag's own rules.
        let shell = try appSource("Views/SessionListRow.swift")
        for relative in ["Views/AgentsView.swift", "Views/SessionFolderPage.swift"] {
            XCTAssertTrue(try appSource(relative).contains("SessionListEntryRow("), relative)
        }
        XCTAssertTrue(shell.contains("SessionFolderDrag.draggable(session, view: view, hasProjectMark: mark != nil,"),
                      "a plain row is picked up by the session's own rules")
        XCTAssertTrue(shell.contains(".sessionDragSource(subject, enabled: draggable, drag: drag, title: dragTitle)"),
                      "the shell owns the drag source, so both row kinds get it")
        XCTAssertFalse(agents.contains(".sessionDragSource("), "the list does not wire a second one")
        XCTAssertFalse(try appSource("Views/SessionFolderPage.swift").contains(".sessionDragSource("),
                       "and neither does the folder page")

        // A project's row is picked up by its coordinator, as its Move files it — once, in the
        // project variant, never as a second `.sessionDragSource(row.coordinator, …)` wiring.
        let project = try appSource("Views/SessionProjectPage.swift")
        let row = try slice(project, from: "struct SessionProjectListRow: View {", to: "\n}\n")
        XCTAssertTrue(row.contains("SessionFolderDrag.draggable("), "in the project's row")
        XCTAssertTrue(row.contains("projectCoordinator: coordinator"), "its coordinator is what is dragged")
        XCTAssertTrue(row.contains("SessionListRow("), "through the same shell")
        for source in [agents, try appSource("Views/SessionFolderPage.swift"), project] {
            XCTAssertFalse(source.contains(".sessionDragSource(row.coordinator"),
                           "the shell's one drag source carries the coordinator row too")
        }
        let page = try appSource("Views/SessionFolderPage.swift")
        let back = try slice(page, from: "if rowNavigation == .selection {", to: "\n            }")
        XCTAssertTrue(back.contains(".modifier(noFolderDropTarget)"), "the back button means No Folder")
        let title = try slice(page, from: "private var title: some View {", to: "\n    }")
        XCTAssertTrue(title.contains(".modifier(noFolderDropTarget)"), "and so does the title")
        XCTAssertTrue(page.contains("NoFolderDropTarget(enabled: !address.isScheduledRuns"))
        XCTAssertTrue(page.contains("content.sessionFolderDropTarget(folderID: nil,"))
    }

    /// Both row kinds go through the one shell, so the drag source is wired once; and the drag
    /// carries its own title card instead of a snapshot of the whole row (owner 2026-11-21).
    func testBothRowKindsShareTheOneShellAndTheDragCarriesItsPreview() throws {
        let shell = try appSource("Views/SessionListRow.swift")
        let project = try appSource("Views/SessionProjectPage.swift")
        let session = try appSource("Views/SessionRowActions.swift")
        XCTAssertTrue(session.contains("SessionListRow("), "a plain session's row is the shell")
        XCTAssertTrue(project.contains("SessionListRow("), "and so is a project's")
        for source in [shell, project, session, try appSource("Views/AgentsView.swift"),
                       try appSource("Views/SessionFolderPage.swift")] {
            XCTAssertFalse(source.contains(".sessionDragSource(row.coordinator"),
                           "no second drag wiring, and never the project's own")
        }

        let drop = try appSource("Views/SessionFolderDrop.swift")
        XCTAssertTrue(drop.contains("} preview: {"), "onDrag gives the drag its own preview")
        XCTAssertTrue(drop.contains("SessionDragPreview(title: title)"))
        let preview = try slice(drop, from: "struct SessionDragPreview: View {", to: "\n}\n")
        XCTAssertTrue(preview.contains("Text(title)"), "the card shows only the title")
        XCTAssertTrue(preview.contains(".lineLimit(1)"))
        XCTAssertTrue(preview.contains("static let width: CGFloat = 200"), "about 200pt at most")
        XCTAssertTrue(preview.contains(".background(") && preview.contains("in: Capsule()"),
                      "a small rounded pill")
        XCTAssertTrue(preview.contains(".strokeBorder("), "thin outline")
        XCTAssertTrue(preview.contains(".shadow("), "light shadow")
        XCTAssertTrue(preview.contains("static let offset: CGFloat = 16"),
                      "its top-left lands below-right of the pointer")
    }

    func testOnlyTheMacDrawsIt() throws {
        let drop = try appSource("Views/SessionFolderDrop.swift")
        for body in ["func sessionDragSource(", "func sessionFolderDropTarget("] {
            let part = try slice(drop, from: body, to: "#else\n        self\n        #endif")
            XCTAssertTrue(part.contains("#if os(macOS)"), "\(body) draws nothing on the phone")
        }
    }
}
