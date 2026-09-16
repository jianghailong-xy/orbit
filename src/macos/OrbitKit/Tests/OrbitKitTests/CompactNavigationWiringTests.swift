import Foundation
import XCTest

/// SwiftUI doesn't exist on Linux, so nothing here compiles the app shell. These hold the one
/// invariant an iPhone session row depends on to the source instead: **a highlighted row can always
/// be opened**. On the compact shell `selectedAgentSessionID` does two jobs at once — it draws the
/// `List(selection:)` highlight and it pushes the console onto the Agents stack — so a selection that
/// outlives its stack strands the row it points at: highlighted, and deaf to taps, because tapping it
/// writes back the id the binding already holds and SwiftUI reads that as no change.
///
/// Two checks, for the two halves of the repair: switching sections away from Agents drops that
/// section's pushes (the compact shell just threw their stack away) — and only there, since the
/// iPad/macOS three-column shells show the selection in a detail pane that is always on screen; and
/// a tap on the row that is already selected re-arms the selection instead of writing it back, so
/// even a stranding this file didn't foresee costs one tap rather than the row.
/// Each check reads the slice of the file it's about, so a match somewhere else can't pass it.
final class CompactNavigationWiringTests: XCTestCase {
    private struct SourceMissing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "\(path) wasn't found above this test. If it moved, point this check at its new home — "
                + "don't delete the check."
        }
    }

    /// Found by walking up from this file; never a skip, so the check can't go quiet when a file moves.
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

    private func appSource(_ relative: String) throws -> String {
        try source("src/macos/OrbitApp/Sources/OrbitApp/\(relative)")
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

    /// Leaving Agents drops the console/compose pushes whose stack the compact shell just destroyed,
    /// so the section reads as "at root" when you come back to it — nothing highlighted, the left edge
    /// free for the drawer swipe (`sectionAtRoot`), and the next tap a real selection change again.
    func testLeavingAgentsOnTheCompactShellDropsThatSectionsPushes() throws {
        let app = try appSource("AppModel.swift")
        let didSet = code(try slice(app, from: "var selectedSection: AppSection = .agents {",
                                    to: "var usesCompactShell"))
        let guardClause = try XCTUnwrap(didSet.range(of: "if usesCompactShell && selectedSection != .agents {"),
                                        "the Agents pushes are dropped on a section switch")
        for push in ["selectedAgentSessionID = nil", "composingAgentSession = false"] {
            let cleared = try XCTUnwrap(didSet.range(of: push), "\(push) is what a switch away must drop")
            XCTAssertGreaterThan(cleared.lowerBound, guardClause.upperBound,
                                 "\(push) sits outside the compact guard — the three-column shells "
                                    + "would lose the console they keep on screen")
        }
        // One clearing site, inside the guard: a second one outside it is the regression this pins.
        XCTAssertEqual(didSet.components(separatedBy: "selectedAgentSessionID = nil").count - 1, 1)
    }

    /// The guard's two premises. `usesCompactShell` is false unless the iPhone shell wrote it — macOS
    /// never mentions it and iPad regular width sets it false — and every navigation *into* Agents
    /// picks the section before it picks the session, so the guard can never clear the target a deep
    /// link, a notification, a Recents row or a drawer tap just chose.
    func testOnlyTheCompactShellSaysSoAndNavigationIntoAgentsSurvivesIt() throws {
        let app = try appSource("AppModel.swift")
        XCTAssertTrue(code(app).contains("var usesCompactShell = false"),
                      "the flag defaults to the shells that keep a detail pane")

        let root = try slice(try source("src/ios/Sources/OrbitiOSApp.swift"),
                             from: "private struct RootView: View {", to: "LoginView()")
        XCTAssertTrue(code(root).contains("if hSize == .compact { CompactShell() } else { MainView() }"))
        XCTAssertTrue(code(root).contains("model.usesCompactShell = size == .compact"),
                      "the flag tracks the very size class that picks the shell")

        // macOS builds its own root (OrbitApp.swift) and never reaches the compact shell.
        XCTAssertFalse(code(try appSource("Views/MainView.swift")).contains("usesCompactShell"),
                       "the three-column shell must not claim to be the compact one")

        // Section first, selection second — every way into Agents.
        let entries = [
            ("func openAgent(_ id: String) {", "}", "selectedAgentSessionID"),
            ("func openRecentSession(_ s: Session) {", "selectedAgentSessionID = s.id", "selectedAgentSessionID"),
            ("func openNeedsYouSession(_ s: Session) {", "selectedAgentSessionID = s.id", "selectedAgentSessionID"),
            ("func composeWithAgent(_ id: String) {", "composingAgentSession = true", "composingAgentSession = true"),
            ("func newSessionInCurrentAgent() {", "startComposingSession()", "startComposingSession()"),
        ]
        for (start, end, push) in entries {
            let fn = code(try slice(app, from: start, to: end))
            let section = try XCTUnwrap(fn.range(of: "selectedSection = .agents"), "\(start) enters Agents")
            let arms = try XCTUnwrap(fn.range(of: push), "\(start) arms \(push)")
            XCTAssertLessThan(section.lowerBound, arms.lowerBound,
                              "\(start) writes the selection before the section, so the switch-away "
                                + "guard would wipe what it just opened")
        }
        // A route (deep link / notification) is the same shape: the section it resolves to, then the
        // session, both inside one call — `.session` resolves to `.agents` (`AppSection.forRoute`).
        let route = code(try slice(app, from: "func route(to route: Route) {", to: "case .runner(let id):"))
        let resolved = try XCTUnwrap(route.range(of: "selectedSection = AppSection.forRoute(route)"))
        let session = try XCTUnwrap(route.range(of: "case .session(let id): openSession(id)"))
        XCTAssertLessThan(resolved.lowerBound, session.lowerBound)
    }

    /// The backstop: on compact, a tap on the row that is already selected re-arms the selection
    /// (cleared, then the same id a runloop turn later) so the console is pushed, instead of writing
    /// back an id SwiftUI will ignore. Off on every other shell, and off on every row but the selected
    /// one — where the List's own write is the no-op it replaces, so nothing races it.
    func testTappingTheAlreadySelectedRowReopensItsConsoleOnCompact() throws {
        let agents = try appSource("Views/AgentsView.swift")
        let row = code(try slice(agents, from: "private func sessionRow(_ s: Session) -> some View {",
                                 to: "private func tagSectionHeader("))
        XCTAssertTrue(row.contains(".simultaneousGesture(TapGesture().onEnded { _ in reopenSelectedRow(s.id) },"),
                      "the selected row's tap has to reach something other than the List's selection")
        XCTAssertTrue(row.contains("including: rearmsTap(on: s.id) ? .all : .subviews"),
                      "the gesture is masked off unless this row is the selected one")
        XCTAssertTrue(row.contains("app.usesCompactShell && selectedSessionID == id"),
                      "only the compact shell re-arms, and only for the row already selected")

        // Two runloop turns, not one: a cleared selection SwiftUI never sees coalesces back into the
        // id it already held, which is exactly the no-op tap this repairs.
        let reopen = code(try slice(agents, from: "private func reopenSelectedRow(_ id: String) {", to: "\n    }"))
        let cleared = try XCTUnwrap(reopen.range(of: "selectedSessionID = nil"))
        let rearmed = try XCTUnwrap(reopen.range(of: "DispatchQueue.main.async { selectedSessionID = id }"))
        XCTAssertLessThan(cleared.lowerBound, rearmed.lowerBound)
    }
}
