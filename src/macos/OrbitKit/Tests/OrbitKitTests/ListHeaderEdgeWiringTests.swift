import Foundation
import XCTest

/// The bar over the iOS Sessions and Tasks lists, after Gemini's (the owner, 2026-11-12;
/// docs/mocks/ios-header-soft-edge/01-board.html): the soft top scroll-edge effect instead of the
/// hard frosted strip and hairline iOS 26 picks by itself, and the bare title one weight lighter.
/// SwiftUI is not compiled on Linux, so the wiring is asserted over the source, as
/// `TailPinningWiringTests` does for the transcript, which keeps no effect at all.
final class ListHeaderEdgeWiringTests: XCTestCase {

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        XCTFail("\(relative) not found")
        return ""
    }

    private func section(_ source: String, from: String, to: String) -> String {
        guard let start = source.range(of: from),
              let end = source.range(of: to, range: start.upperBound..<source.endIndex) else {
            XCTFail("\(from) … \(to) not found; move this check with the code rather than delete it")
            return ""
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    private let views = "src/macos/OrbitApp/Sources/OrbitApp/Views/"

    func testTheSoftEdgeModifierAsksForTheSoftStyleAtTheTop() throws {
        let identity = try source(views + "AgentIdentity.swift")
        let edge = section(identity, from: "@ViewBuilder func softTopEdgeEffect()", to: "#else")
        XCTAssertTrue(edge.contains("scrollEdgeEffectStyle(.soft, for: .top)"))
    }

    func testBothListsUseTheSoftEdge() throws {
        let sessions = section(try source(views + "AgentsView.swift"),
                               from: "List(selection: listSelection) {", to: ".rowSwipeList(rowSwipe)")
        XCTAssertTrue(sessions.contains(".softTopEdgeEffect()"), "the Sessions list")
        let tasks = section(try source(views + "TasksView.swift"),
                            from: "private func taskList(", to: ".overlay { emptyOverlay(tasks) }")
        XCTAssertTrue(tasks.contains(".softTopEdgeEffect()"), "the Tasks list")
    }

    func testTheTranscriptStillHasNoEdgeEffect() throws {
        let console = try source(views + "Console/ConsoleView.swift")
        XCTAssertFalse(console.contains("softTopEdgeEffect"), "the transcript keeps the 11-11 rule")
    }

    func testBareBarTitlesAreBodyMedium() throws {
        let identity = try source(views + "AgentIdentity.swift")
        XCTAssertTrue(identity.contains("static let barTitle = Font.body.weight(.medium)"))
        let title = section(identity, from: "struct WorkspaceTitle: View {", to: "struct WorkspaceTitleSwitcher")
        XCTAssertTrue(title.contains(".font(.barTitle)"), "WorkspaceTitle")
        let switcher = section(identity, from: "struct WorkspaceTitleSwitcher: View {", to: "struct AgentSwitchSheet")
        XCTAssertTrue(switcher.contains(".font(.barTitle)"), "WorkspaceTitleSwitcher")
    }
}
