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

    /// With the needs-you bar over the Sessions list, the soft edge carries on under the bar
    /// (iOS 26) rather than the bar standing on the page's colour, which cut the rows off at its
    /// lower edge (the owner, 2026-11-12, option B of 02-board.html).
    func testTheNeedsYouBarOverTheListStandsOnTheSoftEdge() throws {
        let sessions = section(try source(views + "AgentsView.swift"),
                               from: ".topInsetClearOfRefresh {", to: "#endif")
        XCTAssertTrue(sessions.contains("overList: true"), "the Sessions list mounts it over the list")
        let banner = try source(views + "NeedsYouBannerView.swift")
        let surface = section(banner, from: "@ViewBuilder private var surface", to: "private var listSoftEdge")
        XCTAssertTrue(surface.contains("else if overList {"))
        XCTAssertTrue(surface.contains("listSoftEdge"))
        let edge = section(banner, from: "private var listSoftEdge: some View {", to: "\n}")
        XCTAssertTrue(edge.contains(".ignoresSafeArea(edges: .top)"), "up behind the nav bar")
        XCTAssertTrue(edge.contains(".padding(.bottom, -20)"), "fading out 20pt below the bar")
        XCTAssertTrue(edge.contains(".allowsHitTesting(false)"), "taking no touches")
    }

    /// The iPhone drawer, the same treatment (the owner, 2026-11-12, 03-board.html, D1–D3 = A): its
    /// header floats over the rail on a soft edge instead of sitting above it on a solid strip, the
    /// action bar stands on the same edge from the bottom up, and the title stays bold.
    func testTheDrawerHeaderAndActionBarStandOnSoftEdges() throws {
        let shell = try source(views + "CompactShell.swift")
        let drawer = section(shell, from: "struct NavigationDrawer: View {", to: "private var drawerTitle: some View {")
        XCTAssertFalse(drawer.contains("if !inSidebarColumn {\n                HStack {"),
                       "the header no longer sits above the list")
        XCTAssertTrue(drawer.contains(".safeAreaInset(edge: .top, spacing: 0) {\n                if !inSidebarColumn { drawerHeader }"))
        XCTAssertTrue(drawer.contains("SoftEdgeLayer(solidAt: .bottom, color: drawerSurface)"), "under the action bar")
        let header = section(drawer, from: "private var drawerHeader: some View {", to: "\n    }\n")
        XCTAssertTrue(header.contains("SoftEdgeLayer(solidAt: .top, color: drawerSurface)"))
        XCTAssertTrue(header.contains(".ignoresSafeArea(edges: .top)"), "up behind the status bar")
        XCTAssertTrue(header.contains(".allowsHitTesting(false)"))
        let title = section(shell, from: "private var drawerTitle: some View {", to: "}")
        XCTAssertTrue(title.contains(".font(.title2.weight(.bold))"), "the drawer's title stays bold")
    }

    func testTheNeedsYouBarAndTheDrawerShareOneSoftEdge() throws {
        let banner = try source(views + "NeedsYouBannerView.swift")
        XCTAssertTrue(banner.contains("SoftEdgeLayer(solidAt: .top, color: Color(uiColor: .systemBackground))"))
        let identity = try source(views + "AgentIdentity.swift")
        let layer = section(identity, from: "struct SoftEdgeLayer: View {", to: "\n}\n")
        XCTAssertTrue(layer.contains("Rectangle().fill(.ultraThinMaterial)"), "a blur")
        XCTAssertTrue(layer.contains("color.opacity(0)"), "fading to nothing")
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
