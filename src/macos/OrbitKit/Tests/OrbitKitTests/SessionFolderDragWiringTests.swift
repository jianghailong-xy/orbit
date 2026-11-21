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
        for relative in ["Views/AgentsView.swift", "Views/SessionFolderPage.swift"] {
            let source = try appSource(relative)
            let row = try slice(source, from: "@ViewBuilder private func sessionRow(_ s: Session", to: "case .push:")
            XCTAssertTrue(row.contains("SessionFolderDrag.draggable("), relative)
            XCTAssertTrue(row.contains(".sessionDragSource(s, enabled: draggable, drag: drag)"), relative)
        }
        // A project's row is picked up by its coordinator, as its Move files it.
        for relative in ["Views/AgentsView.swift", "Views/SessionFolderPage.swift"] {
            let source = try appSource(relative)
            let row = try slice(source, from: "private func projectRow(_ row: SessionProjectRow)", to: "movingSession = coordinator } })")
            XCTAssertTrue(row.contains("SessionFolderDrag.draggable("), relative)
            XCTAssertTrue(row.contains("projectCoordinator: row.coordinator"), relative)
            XCTAssertTrue(row.contains(".sessionDragSource(row.coordinator, enabled: draggable, drag: drag)"), relative)
        }
        let page = try appSource("Views/SessionFolderPage.swift")
        let back = try slice(page, from: "if rowNavigation == .selection {", to: "\n            }")
        XCTAssertTrue(back.contains(".modifier(noFolderDropTarget)"), "the back button means No Folder")
        let title = try slice(page, from: "private var title: some View {", to: "\n    }")
        XCTAssertTrue(title.contains(".modifier(noFolderDropTarget)"), "and so does the title")
        XCTAssertTrue(page.contains("NoFolderDropTarget(enabled: !address.isScheduledRuns"))
        XCTAssertTrue(page.contains("content.sessionFolderDropTarget(folderID: nil,"))
    }

    func testOnlyTheMacDrawsIt() throws {
        let drop = try appSource("Views/SessionFolderDrop.swift")
        for body in ["func sessionDragSource(", "func sessionFolderDropTarget("] {
            let part = try slice(drop, from: body, to: "#else\n        self\n        #endif")
            XCTAssertTrue(part.contains("#if os(macOS)"), "\(body) draws nothing on the phone")
        }
    }
}
