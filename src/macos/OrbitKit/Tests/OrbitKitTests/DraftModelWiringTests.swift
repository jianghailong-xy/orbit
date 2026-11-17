import Foundation
import XCTest

/// SwiftUI doesn't exist on Linux, so nothing here compiles the app shell — CI's `client.yml` does.
/// These hold the new-session draft's model to the source of the macOS and iOS shell (the iOS app
/// builds these same files), per docs/workspace-default-model-design.md: a draft seeds its model from
/// its workspace's `lastModel` (`AgentDefaults.newSessionModel`, tested in AgentDefaultsTests), and a
/// model picked in the composer applies to that session alone — no PATCH /users/me/preferences with
/// `defaultModels`, and nothing reads the account-wide memory either.
final class DraftModelWiringTests: XCTestCase {
    private struct SourceMissing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "OrbitApp/Sources/OrbitApp/\(path) wasn't found above this test. If it moved, point this check "
                + "at its new home — don't delete the check."
        }
    }

    private func appRoot() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("src/macos/OrbitApp/Sources/OrbitApp")
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            dir.deleteLastPathComponent()
        }
        throw SourceMissing(path: "")
    }

    private func source(_ relative: String) throws -> String {
        let url = try appRoot().appendingPathComponent(relative)
        guard FileManager.default.fileExists(atPath: url.path) else { throw SourceMissing(path: relative) }
        return try String(contentsOf: url, encoding: .utf8)
    }

    /// From the first `start` through the next `end` after it.
    private func slice(_ text: String, from start: String, to end: String) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`")
        let upper = try XCTUnwrap(text.range(of: end, range: lower.upperBound..<text.endIndex),
                                  "no `\(end)` after `\(start)`")
        return String(text[lower.lowerBound..<upper.upperBound])
    }

    /// The text without its comment lines, which are free to talk about what the code must not do.
    private func code(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }

    func testNoAppSourceReadsOrWritesTheAccountsDefaultModels() throws {
        let root = try appRoot()
        let files = try XCTUnwrap(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil))
            .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
        XCTAssertFalse(files.isEmpty)
        for file in files {
            let text = code(try String(contentsOf: file, encoding: .utf8))
            XCTAssertFalse(text.contains("defaultModels"), file.lastPathComponent)
            XCTAssertFalse(text.contains("rememberDefaultModel"), file.lastPathComponent)
        }
    }

    func testPickingAModelInTheComposerWritesNoPreference() throws {
        let composer = code(try source("Views/ComposerView.swift"))
        let menu = try slice(composer, from: "ForEach(modelMenuItems) { m in", to: "await console.applyConfig(")
        XCTAssertTrue(menu.contains("console.selectModel(m.id)"))
        XCTAssertFalse(menu.contains("app."), "a model pick touches only its console")
        let cursor = try slice(composer, from: "private func pickCursorSetting(", to: "\n    }")
        XCTAssertTrue(cursor.contains("console.selectModel(model)"))
        XCTAssertFalse(cursor.contains("app."), "a Cursor setting pick touches only its console")
        XCTAssertFalse(composer.contains("updatePreferences"))
    }

    func testEveryDraftSeedReadsItsWorkspace() throws {
        let registry = code(try source("ConsoleRegistry.swift"))
        let draft = try slice(registry, from: "func draftModel(for agent: Agent", to: "return model")
        XCTAssertTrue(draft.contains("workspace: agent, fallback: defaultModel"))
        let console = code(try source("ConsoleModel.swift"))
        let seed = try slice(console, from: "private func draftModelSeed(", to: "\n    }")
        XCTAssertTrue(seed.contains("workspace: draftAgent, fallback: fallback"))
    }
}
