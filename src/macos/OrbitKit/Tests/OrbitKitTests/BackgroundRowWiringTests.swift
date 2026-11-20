import Foundation
import XCTest

/// SwiftUI doesn't compile on Linux, so these hold the folded Background row's view to its source:
/// it draws `BackgroundRowRule`'s row, rotates by a push (a crossfade with Reduce Motion), pauses while
/// the list is open, the app is not active or the band is folded, speaks the rule's label and hides
/// the rotating text from VoiceOver. A file that moved is a failure, never a skip.
final class BackgroundRowWiringTests: XCTestCase {
    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("src/macos/OrbitApp/Sources/OrbitApp").appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
                    .split(separator: "\n", omittingEmptySubsequences: false)
                    .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
                    .joined(separator: "\n")
            }
            dir.deleteLastPathComponent()
        }
        XCTFail("OrbitApp/Sources/OrbitApp/\(relative) wasn't found above this test")
        throw CocoaError(.fileNoSuchFile)
    }

    private func slice(_ text: String, from start: String, to end: String) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`")
        let upper = try XCTUnwrap(text.range(of: end, range: lower.upperBound..<text.endIndex), "no `\(end)`")
        return String(text[lower.lowerBound..<upper.upperBound])
    }

    func testTheTrayDrawsTheRulesRowAndRotatesByIt() throws {
        let tray = try slice(try source("Views/WorktreeBar.swift"),
                             from: "struct BackgroundTrayView: View {", to: "private struct BackgroundRowMarkView")
        for use in ["if let row {", "Text(row.label).font(.orbitLabel.weight(.semibold))", ".foregroundStyle(.tint)",
                    ".transition(reduceMotion ? .opacity : .push(from: .bottom))",
                    "@Environment(\\.accessibilityReduceMotion)", "@Environment(\\.scenePhase)",
                    "open || paused || scenePhase != .active",
                    "BackgroundRowRule.rotatePerNameMs", "BackgroundRowRule.rotateChangeMs",
                    ".accessibilityLabel(row.accessibilityLabel)", ".accessibilityHidden(true)",
                    "BackgroundRowMarkView(mark: item.mark)"] {
            XCTAssertTrue(tray.contains(use), "the tray no longer says \(use)")
        }
    }

    /// As AgentsBandRow ends: the name takes the free space, then the count, the mark and the chevron
    /// sit at the right edge, the count first, the mark just before the chevron.
    func testTheFoldedRowEndsCountThenMarkThenChevron() throws {
        let folded = try slice(try source("Views/WorktreeBar.swift"),
                               from: "private func folded(", to: "private struct RotationKey")
        let order = [".frame(maxWidth: .infinity, alignment: .leading)", "row.countParts.enumerated()",
                     "BackgroundRowMarkView(mark: item.mark)", "Image(systemName: \"chevron.right\")"]
        let at = try order.map { piece in
            try XCTUnwrap(folded.range(of: piece), "the folded row no longer says \(piece)").lowerBound
        }
        XCTAssertEqual(at, at.sorted(), "the folded row is no longer name, count, mark, chevron")
    }

    func testTheConsoleHandsTheTrayTheRuleAndTheFold() throws {
        let console = try source("Views/Console/ConsoleView.swift")
        let call = try slice(console, from: "BackgroundTrayView(procs: console.state.background", to: "CreatedTasksCard(")
        for use in ["BackgroundRowRule.row(console.state.background, items: console.state.items",
                    "sessionLive: console.isLive", "paused: foldsChrome(console)"] {
            XCTAssertTrue(call.contains(use), "the console no longer hands the tray \(use)")
        }
        let pill = try source("Views/Console/FoldedBandBar.swift")
        XCTAssertTrue(pill.contains("FoldedBand.processes(console.state.background,"))
        XCTAssertTrue(pill.contains("sessionLive: console.isLive"))
    }
}
