import Foundation
import XCTest

/// The Claude region check's two wires in OrbitApp that only the macOS and iOS builds compile, asserted over
/// their source (the `ConsoleRunnerRefreshWiringTests` way): a provider picked on a held session is told that
/// nothing is in flight, and the region card's machine lines wrap rather than being cut when the composer
/// band squeezes the card.
final class ClaudeRegionWiringTests: XCTestCase {
    private struct SourceMissing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "\(path) wasn't found above this test. If it moved, point this check at its new home — "
                + "don't delete the check."
        }
    }

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir.deleteLastPathComponent()
        }
        throw SourceMissing(path: relative)
    }

    /// From `start` up to the next `end`, its code lines only (trimmed, joined by spaces): a call commented
    /// out still contains its own words.
    private func code(_ text: String, from start: String, to end: String) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`")
        let upper = try XCTUnwrap(text.range(of: end, range: lower.upperBound..<text.endIndex),
                                  "no `\(end)` after `\(start)`")
        return text[lower.lowerBound..<upper.lowerBound]
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("//") }
            .joined(separator: " ")
    }

    func testAProviderPickOnAHeldSessionIsToldNothingIsInFlight() throws {
        let console = try source("src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift")
        let pick = try code(console, from: "func selectProvider(_ slug: String, account: String? = nil) async {",
                            to: "func pickDraft(engine: String, provider slug: String) {")
        XCTAssertTrue(pick.contains("providerSwitchNote = TaskRunHandoff.providerSwitchNote(from: name(from), "
                                    + "to: name(slug), liveRun: isLive && !regionHeld)"),
                      "selectProvider no longer tells a held session that nothing is in flight")
        XCTAssertFalse(pick.contains("liveRun: isLive)"), "selectProvider still says a turn is in flight on a held session")
        XCTAssertTrue(console.contains("var regionHeld: Bool { ClaudeRegion.held(status: sessionStatus, error: sessionError) }"),
                      "the console's held reading is not the shared rule")
    }

    func testTheRegionCardsLinesWrap() throws {
        let card = try source("src/macos/OrbitApp/Sources/OrbitApp/Views/Console/SessionRunStartCard.swift")
        let lines = try code(card, from: "ForEach(card.lines, id: \\.self) { line in", to: ".textSelection(.enabled)")
        XCTAssertTrue(lines.contains("Text(line).font(.orbitMeta.monospaced()).foregroundStyle(.secondary) "
                                     + ".fixedSize(horizontal: false, vertical: true)"),
                      "the card's machine lines can be cut when the composer band squeezes the card")
    }
}
