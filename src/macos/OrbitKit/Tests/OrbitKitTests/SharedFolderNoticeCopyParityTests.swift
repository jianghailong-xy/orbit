import Foundation
import XCTest
@testable import OrbitKit

/// The worktree bar's notice for a session without a worktree says what web's says: the notice and
/// Initialize git…'s confirmation (`SessionOutputs.tsx`'s `SharedFolderNotice` and
/// `InitializeGitSteps`), and the toasts its two answers end in (`WorkspaceView.tsx`'s `enableIsoMut`
/// and `keepSharedMut`). The clients share no compiler, so this reads web's source. A missing
/// counterpart is a FAILURE, never an `XCTSkip`.
final class SharedFolderNoticeCopyParityTests: XCTestCase {

    private static let outputs = "src/web/src/components/SessionOutputs.tsx"
    private static let workspace = "src/web/src/components/WorkspaceView.tsx"

    private typealias Notice = WorktreeBarLogic.SharedFolderNotice

    private struct Missing: Error, CustomStringConvertible {
        let file: String
        var description: String {
            "\(file) was not found above this test file. The native notice is one half of a pair; if the "
                + "other half moved, move this check with it rather than deleting it."
        }
    }

    /// The source with every run of whitespace read as one space, `<code>` tags dropped and the space
    /// around the other tags trimmed: a rich text's words are the contract, not its markup or wrapping.
    private func web(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
                    .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
                    .replacingOccurrences(of: "</?code>", with: "", options: .regularExpression)
                    .replacingOccurrences(of: ">\\s+", with: ">", options: .regularExpression)
                    .replacingOccurrences(of: "\\s+<", with: "<", options: .regularExpression)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw Missing(file: relative)
    }

    private func assertSays(_ web: String, _ literal: String, in file: String, line: UInt = #line) {
        XCTAssertTrue(web.contains(literal), "\(file) no longer says \(literal)", line: line)
    }

    /// The headlines are web's templates with the folder in its place, and in web's words without one.
    func testTheHeadlinesAreWebs() throws {
        let web = try web(Self.outputs)

        let notGit = Notice.notGit.headline(workDir: "/Users/alex/notes")
        assertSays(web, "<>\(notGit.lead){folder}\(notGit.tail)</>", in: Self.outputs)
        assertSays(web, "'This folder'", in: Self.outputs)
        let unnamed = Notice.notGit.headline(workDir: nil)
        XCTAssertEqual(unnamed.lead + unnamed.tail, notGit.lead + "This folder" + notGit.tail)

        let noBranch = Notice.noBranch.headline(workDir: "/Users/alex/new-app")
        assertSays(web, "<>\(noBranch.lead){path ? folder : 'the folder'}\(noBranch.tail)</>", in: Self.outputs)
        let unnamedRepo = Notice.noBranch.headline(workDir: nil)
        XCTAssertEqual(unnamedRepo.lead + unnamedRepo.tail, noBranch.lead + "the folder" + noBranch.tail)
    }

    func testTheSecondLineButtonAndCloseAreWebs() throws {
        let web = try web(Self.outputs)
        assertSays(web, "notGit ? '\(Notice.notGit.detail)' : '\(Notice.noBranch.detail)'", in: Self.outputs)
        assertSays(web, ">\(WorktreeBarLogic.initializeGit)</button>", in: Self.outputs)
        assertSays(web, "aria-label={notGit ? '\(Notice.notGit.closeLabel)' : '\(Notice.noBranch.closeLabel)'}",
                   in: Self.outputs)
        assertSays(web, "content={notGit ? '\(Notice.notGit.closeHelp)' : '\(Notice.noBranch.closeHelp)'}",
                   in: Self.outputs)
    }

    /// The confirmation is `InitializeGitSteps` in plain text: the folder, the sentence that names the
    /// workspace, the three steps as bullets and the closing paragraph.
    func testTheConfirmationIsWebsStepsInPlainText() throws {
        let steps = try web(Self.outputs)
        let lines = WorktreeBarLogic.initializeGitMessage(workDir: "/Users/alex/notes", workspaceName: "notes")
            .split(separator: "\n").map(String.init)
        XCTAssertEqual(lines.first, "/Users/alex/notes")

        let place = "{workspace ? `“${workspace}”` : 'this workspace'}"
        assertSays(steps, "<p>When the next session starts in \(place), Orbit will:</p>", in: Self.outputs)
        XCTAssertEqual(lines[1], "When the next session starts in “notes”, Orbit will:")
        XCTAssertEqual(WorktreeBarLogic.initializeGitMessage(workDir: nil, workspaceName: nil)
            .split(separator: "\n").first.map(String.init),
                       "When the next session starts in this workspace, Orbit will:")

        let bullets = lines.filter { $0.hasPrefix("• ") }.map { String($0.dropFirst(2)) }
        XCTAssertEqual(bullets.count, 3)
        for step in bullets { assertSays(steps, "<li>\(step)</li>", in: Self.outputs) }
        assertSays(steps, "<p>\(lines.last ?? "")</p>", in: Self.outputs)

        let view = try web(Self.workspace)
        assertSays(view, "title: '\(WorktreeBarLogic.initializeGitTitle)'", in: Self.workspace)
        assertSays(view, "confirmText: '\(WorktreeBarLogic.initializeGitConfirm)'", in: Self.workspace)
    }

    func testTheToastsAreWebs() throws {
        let web = try web(Self.workspace)
        assertSays(web, "'\(WorktreeBarLogic.gitSetupQueued)'", in: Self.workspace)
        assertSays(web, "\"\(WorktreeBarLogic.gitSetupFailed)\"", in: Self.workspace)

        assertSays(web, "`Worktree isolation is off for ${ws?.name ? `“${ws.name}”` : 'this workspace'}`",
                   in: Self.workspace)
        XCTAssertEqual(WorktreeBarLogic.worktreeIsolationOff(workspaceName: "notes"), "Worktree isolation is off for “notes”")
        XCTAssertEqual(WorktreeBarLogic.worktreeIsolationOff(workspaceName: nil), "Worktree isolation is off for this workspace")
        assertSays(web, "detail: '\(WorktreeBarLogic.worktreeIsolationOffDetail)'", in: Self.workspace)

        // The ✕'s own failure, and its Undo's.
        assertSays(web, "on ? \"\(WorktreeBarLogic.worktreeIsolationOnFailed)\" : \"\(WorktreeBarLogic.worktreeIsolationOffFailed)\"",
                   in: Self.workspace)
    }
}
