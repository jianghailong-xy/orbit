import Foundation
import XCTest
@testable import OrbitKit

/// A workspace write's card says the web card's words, and the SwiftUI card is drawn from them. There is
/// no compiler between a SwiftUI view and a browser bundle, and SwiftUI does not build on Linux, so both
/// are asserted over the source, as `DeleteCardCopyParityTests` does.
final class WorkspaceWriteCardCopyParityTests: XCTestCase {

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
            .replacingOccurrences(of: "['`]\\s*\\+\\s*\\n?\\s*['`]", with: "", options: .regularExpression)
        for (what, needle) in [
            ("the yes on a change", "'\(Approvals.workspaceSaveAction)'"),
            ("the yes on a create", "'\(Approvals.workspaceCreateAction)'"),
            ("the caption over the variables", ">\(Approvals.workspaceVariables)<"),
            ("the line for none", ">\(Approvals.workspaceNoVariables)<"),
            ("the caption over what goes", ">\(Approvals.workspaceVariablesRemoved)<"),
            ("the note", "'\(Approvals.workspaceWriteNote)'"),
            ("the decline", "'\(Approvals.decliningPrefix(toolName: "orbit_agent_update"))'"),
            ("a cleared field", "'Cleared'"),
            ("the folder", "'Working directory'"),
            ("the prompt", "'System prompt'"),
            ("the appended prompt", "'Appended system prompt'"),
            ("the runner", "'Runner'"),
            ("the worktree", "'Worktree'"),
            ("a worktree on", "'Each session gets its own git worktree'"),
            ("a worktree off", "'Sessions run in the shared folder'"),
            ("the name", "'Name'"),
            ("the description", "'Description'"),
            ("the merge target", "'Merge target'"),
        ] {
            XCTAssertTrue(web.contains(needle), "\(what) drifted: no \(needle.debugDescription) on the web card")
        }
    }

    func testTheCardKeysTheToolsTheServerFilesTheCardsUnder() throws {
        let server = try source("src/apiserver/src/sessions/workspace-write-card-values.ts")
        XCTAssertTrue(Approvals.isWorkspaceCreate(toolName: "orbit_agent_create"))
        XCTAssertTrue(Approvals.isWorkspaceUpdate(toolName: "orbit_agent_update"))
        XCTAssertTrue(server.contains("WORKSPACE_CREATE_APPROVAL_TOOL_NAME = 'orbit_agent_create'"))
        XCTAssertTrue(server.contains("WORKSPACE_UPDATE_APPROVAL_TOOL_NAME = 'orbit_agent_update'"))
    }

    func testTheToolCardDrawsThePreviewAndAnswersInItsWords() throws {
        let card = try source("src/macos/OrbitApp/Sources/OrbitApp/Views/ApprovalCards.swift")
        for wire in [
            "Approvals.workspaceWritePreview(toolName: approval.toolName ?? \"\", from: $0)",
            "} else if let writing {",
            "title: writing.heading",
            "Text(writing.name)",
            "Text(writing.status)",
            "workspaceWriteBlock(workDir)",
            "ForEach(env) { workspaceWriteBlock($0.line) }",
            "Text(Approvals.workspaceVariables)",
            "Text(Approvals.workspaceNoVariables)",
            "Text(Approvals.workspaceVariablesRemoved)",
            "ForEach(writing.fields)",
            "Text(Approvals.workspaceWriteNote)",
            "if let writing { return writing.action }",
            "if let writing { return writing.declineName }",
            "Approvals.workspaceWriteRawInput(toolName: approval.toolName ?? \"\", from: $0)",
        ] {
            XCTAssertTrue(card.contains(wire), "ApprovalCards.swift no longer has \(wire.debugDescription)")
        }
    }
}
