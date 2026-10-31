import Foundation
import XCTest
@testable import OrbitKit

/// The delete cards say the web card's words, and the SwiftUI card is drawn from them. There is no
/// compiler between a SwiftUI view and a browser bundle, and SwiftUI does not build on Linux, so both
/// are asserted over the source, as `CreateCardCopyParityTests` and `BatchReviewWiringTests` do.
final class DeleteCardCopyParityTests: XCTestCase {

    private struct SourceMissing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "\(path) wasn't found above this test. If it moved, point this check at its new home — "
                + "don't delete the check."
        }
    }

    /// Found by walking up from this file; never a skip, so the check can't go quiet when a file moves.
    private func source(_ path: String) throws -> String {
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

    func testTheCardSaysTheWordsTheWebCardSays() throws {
        let web = try source("src/web/src/components/ApprovalPanel.tsx")
            .replacingOccurrences(of: "['`]\\s*\\+\\s*['`]", with: "", options: .regularExpression)
        for (what, needle) in [
            ("the yes", "'\(Approvals.deleteAction)'"),
            ("the caption over the workspaces", ">\(Approvals.deleteGoesWith)<"),
            ("the line for a runner with none", ">\(Approvals.deleteNoWorkspaces)<"),
            ("the runner's note", "'\(Approvals.deleteRunnerNote)'"),
            ("the workspace's note", "'\(Approvals.deleteWorkspaceNote)'"),
            ("the decline", "'\(Approvals.decliningPrefix(toolName: "orbit_runner_delete"))'"),
            ("a workspace on no runner", "'On no runner'"),
            ("a workspace's runner", "`On ${hostName}`"),
        ] {
            XCTAssertTrue(web.contains(needle), "\(what) drifted: no \(needle.debugDescription) on the web card")
        }
    }

    func testTheCardKeysTheToolsTheServerFilesTheCardsUnder() throws {
        let server = try source("src/apiserver/src/runner-api/runner-delete-approval.ts")
        XCTAssertTrue(Approvals.isRunnerDelete(toolName: "orbit_runner_delete"))
        XCTAssertTrue(Approvals.isWorkspaceDelete(toolName: "orbit_agent_delete"))
        XCTAssertTrue(server.contains("RUNNER_DELETE_APPROVAL_TOOL_NAME = 'orbit_runner_delete'"))
        XCTAssertTrue(server.contains("WORKSPACE_DELETE_APPROVAL_TOOL_NAME = 'orbit_agent_delete'"))
    }

    func testTheToolCardDrawsThePreviewAndAnswersInItsWords() throws {
        let card = try source("src/macos/OrbitApp/Sources/OrbitApp/Views/ApprovalCards.swift")
        for wire in [
            "Approvals.deletePreview(toolName: approval.toolName ?? \"\", from: $0,",
            "} else if let deleting {",
            "title: deleting.heading",
            "Text(deleting.name)",
            "Text(deleting.status)",
            "if deleting.isRunner { deletedWithIt(deleting.workspaces) }",
            "Text(deleting.note)",
            "Text(Approvals.deleteNoWorkspaces)",
            "Text(Approvals.deleteGoesWith)",
            "if deleting != nil { return Approvals.deleteAction }",
            "if let deleting { return deleting.declineName }",
        ] {
            XCTAssertTrue(card.contains(wire), "ApprovalCards.swift no longer has \(wire.debugDescription)")
        }
    }
}
