import Foundation
import XCTest

/// SwiftUI doesn't exist on Linux, so nothing here compiles the app shells. These hold the Agents
/// section's navigation to the source it now *is*: **the section's stack in `NavState` is the only
/// copy**. The compact shell binds a `NavigationStack(path:)` to that stack and every row carries its
/// own destination value; the three-column shells keep their `List(selection:)`, but it is a
/// projection onto the same stack, so selecting swaps the page the detail pane shows.
///
/// This is the invariant the dead row came from. While a flat `selectedAgentSessionID` sat beside the
/// stack, a selection could outlive its push: the row drew as selected, the console it named was
/// never pushed, and tapping it wrote back the id the binding already held — which SwiftUI reads as
/// no change, so the row could not be opened until the selection moved elsewhere. Each check reads
/// the slice of the file it is about, so a match somewhere else can't pass it.
final class AgentsStackWiringTests: XCTestCase {
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

    /// The compact Agents section is a `NavigationStack` whose path IS the section's stack, and its
    /// rows push their own destinations onto it. The collapsed `NavigationSplitView` it replaced is
    /// gone from this case, and with it the last `isPresented` push on the Agents stack — the second
    /// navigation mechanism the compose race needed two of.
    func testTheCompactAgentsSectionIsAStackBoundToTheSectionsStack() throws {
        let agents = code(try slice(try appSource("Views/CompactShell.swift"),
                                    from: "case .agents:", to: "// RUNNERS"))
        XCTAssertTrue(agents.contains("NavigationStack(path: $model.nav.path)"),
                      "the stack SwiftUI moves is the one NavState keeps for this section")
        XCTAssertTrue(agents.contains("AgentContentColumn(rowNavigation: .push)"),
                      "and the column's rows are the shape that pushes")
        XCTAssertTrue(agents.contains("navigationDestination(for: NavNode.self)"),
                      "each frame type renders one page, keyed by the value that was pushed")
        XCTAssertFalse(agents.contains("NavigationSplitView"),
                       "a collapsed split cannot push a value: it only ever had a selection")
        XCTAssertFalse(agents.contains("navigationDestination(isPresented:"),
                       "no boolean push left on the Agents stack")
    }

    /// One row, two containers. The row view is built once — what differs is who moves the screen:
    /// the three-column `List`'s selection, or the compact row's own destination value. Neither
    /// shape draws a highlight it cannot open, because both read the same stack.
    func testOneRowInTwoContainersAndOnlyTheCompactOnePushes() throws {
        let agentsSource = try appSource("Views/AgentsView.swift")
        let row = code(try slice(agentsSource, from: "@ViewBuilder private func sessionRow(",
                                 to: "private func tagSectionHeader("))
        let selectionBranch = try XCTUnwrap(row.range(of: "case .selection:"))
        let pushBranch = try XCTUnwrap(row.range(of: "case .push:"), "the compact branch")
        let tag = try XCTUnwrap(row.range(of: ".tag(s.id)"), "the three-column row stays tag-driven")
        let pushed = try XCTUnwrap(
            row.range(of: "Button { app.push(.console(sessionID: s.id, origin: .list)) } label: {"),
            "the compact row carries its destination")
        XCTAssertLessThan(tag.lowerBound, pushBranch.lowerBound,
                          "`.tag` belongs to the selection branch, not the pushing one")
        XCTAssertLessThan(pushBranch.lowerBound, pushed.lowerBound,
                          "and the push belongs to the pushing branch")
        XCTAssertFalse(row.contains("NavigationLink"),
                       "the compact row is not a link: the disclosure indicator a "
                       + "`NavigationLink(value:)` draws cannot be hidden on iOS 17/18, so the row "
                       + "pushes its frame through `AppModel.push` instead")
        XCTAssertLessThan(selectionBranch.lowerBound, pushBranch.lowerBound)
        XCTAssertEqual(row.components(separatedBy: "AgentSessionRow(session: s").count - 1, 1,
                       "the row itself is built once and shared by both branches")

        // ...and its actions attach to the row, never to what the row is made of. `.swipeActions`
        // and `.contextMenu` are read off the view the `List` hosts as its row; a `Button` does not
        // pass them up from its label, so holding them inside that label — which is where the
        // compact row carried them — leaves a session row that cannot be swiped or long-pressed.
        // The actions therefore follow the `Button`'s closing brace, at the row's own level.
        let push = code(String(row[pushBranch.lowerBound...]))
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        let actions = try XCTUnwrap(push.firstIndex(
            of: ".sessionRowActions(s, scope: view, onTag: { taggingSession = s })"),
            "the compact row attaches its own actions")
        XCTAssertGreaterThan(actions, 0)
        XCTAssertTrue(push[actions - 1].hasSuffix("}"),
                      "attached to the row from outside the `Button`'s label, not nested inside it")

        // Who gets which shape: the compact shell asks for the pushing one, and the three-column
        // shell takes the default. `MainView` reaches the column through `SectionContent`, so the
        // default is what it gets.
        XCTAssertTrue(code(try appSource("Views/CompactShell.swift"))
            .contains("AgentContentColumn(rowNavigation: .push)"))
        let main = code(try appSource("Views/MainView.swift"))
        XCTAssertFalse(main.contains("rowNavigation:"),
                       "the three-column shell keeps the List's selection")
        XCTAssertTrue(main.contains("AgentContentColumn()"),
                      "and reaches the column with its default shape")

        // The projection those three-column rows select through: it reads the top of the stack and
        // writes through `replaceTop`, so the detail pane can never show something else.
        let projection = code(try slice(try appSource("AppModel.swift"),
                                        from: "var selectedAgentSessionID: String? {",
                                        to: "var composingAgentSession: Bool {"))
        XCTAssertTrue(projection.contains("get { nav.focusedConsoleSessionID }"),
                      "the selection IS the console on top of the stack")
        XCTAssertTrue(projection
            .contains("nav.replaceTop(with: .console(sessionID: id, origin: .list))"),
                      "and selecting replaces the page the detail pane shows")
    }

    /// Every fact the shells read is a read of the stack, and every write is a stack transition:
    /// nothing here keeps a copy that could disagree with what SwiftUI has pushed.
    func testTheModelKeepsNoCopyOfWhatTheStackAlreadySays() throws {
        // Sliced from the raw file (its end anchors are the comments that follow each block), then
        // stripped, so a comment can't stand in for the code a check is about.
        let app = try appSource("AppModel.swift")
        let model = code(app)

        XCTAssertTrue(model.contains("focusedConsoleSessionID: String? { nav.focusedConsoleSessionID }"))
        XCTAssertTrue(model.contains("consoleFromRecents: Bool { nav.consoleFromRecents }"))

        let root = code(try slice(app, from: "var sectionAtRoot: Bool {",
                                  to: "/// ⌘D: complete the open"))
        XCTAssertTrue(root.contains("case .agents:  return nav.sectionAtRoot"),
                      "at root is an empty stack, not two fields that could disagree with it")

        // The four ways into a console pick the frame they push, and how it was opened rides that
        // frame instead of a shadow variable with an assignment-ordering convention. Each one hands
        // its frame to `show` now; that the entries write nothing else, and that `show` is the one
        // place the transition happens, is `NavigationEntrancesWiringTests`'.
        let entries = [
            ("func openRecentSession(_ s: Session) {", "\n    }",
             "show(.console(sessionID: s.id, origin: .drawer)"),
            ("func openNeedsYouSession(_ s: Session) {", "\n    }",
             "show(.console(sessionID: s.id, origin: .banner)"),
            ("func openAgent(_ id: String) {", "\n    }", "nav.popToRoot()"),
        ]
        for (start, end, transition) in entries {
            let fn = code(try slice(app, from: start, to: end))
            XCTAssertTrue(fn.contains(transition), "\(start) navigates by \(transition)")
        }
        let route = code(try slice(app, from: "private func openSession(_ id: String) {",
                                   to: "guard !sessions.contains(where:"))
        XCTAssertTrue(route.contains("show(.console(sessionID: id, origin: .deepLink), agent: agentID(for: id))"),
                      "a deep link / search hit is the same 'select this session' act")
        let drop = code(try slice(app, from: "private func dropIfOpen(_ id: String) {",
                                  to: "/// Remove every local fallback"))
        XCTAssertTrue(drop.contains("nav.removeConsole(id)"),
                      "completing a session takes its console off the stack")
        let reset = code(try slice(app, from: "private func resetNavigation() {",
                                   to: "/// Wire up notifications."))
        XCTAssertTrue(reset.contains("nav = NavState()"),
                      "signing out drops every section's stack")
    }

    /// The draft and a console are two frames of one stack, so creating a session from the draft
    /// replaces the page you are on — in both shells, through one model call. The compact compose
    /// page no longer hosts the created console in local state beside a second mechanism's push.
    func testTheDraftAndItsConsoleAreTwoFramesOfOneStack() throws {
        // Raw for the blocks whose end anchor is the comment that follows them, stripped for the
        // checks themselves (so a comment can't stand in for the code).
        let raw = try appSource("Views/CompactShell.swift")
        let frames = code(try slice(raw, from: "case .compose(let agentID):", to: "default:"))
        XCTAssertTrue(frames.contains("AgentComposePage(agentID: agentID)"))
        XCTAssertTrue(frames.contains("AgentConsolePage(sessionID: sessionID)"))

        let page = code(try slice(raw, from: "private struct AgentComposePage: View {",
                                  to: "private struct AgentConsolePage: View {"))
        XCTAssertFalse(page.contains("@State"), "no local copy of the created session")
        XCTAssertFalse(page.contains("ConsoleView("), "the page does not host a console itself")
        XCTAssertTrue(page.contains("model.openCreatedAgentSession(session)"),
                      "creating the session is the one navigation both shells take")

        let created = code(try slice(try appSource("AppModel.swift"),
                                     from: "func openCreatedAgentSession(_ session: Session) {",
                                     to: "\n    }"))
        XCTAssertTrue(created
            .contains("nav.replaceTop(with: .console(sessionID: session.id, origin: .list))"),
                      "and it swaps the draft's frame for that session's console, in place")

        // The Recents origin is what frees the compact left edge; it rides the frame, so the page
        // reads it instead of a marker that had to be written before the selection.
        let console = code(try slice(raw, from: "private struct AgentConsolePage: View {",
                                     to: "/// Toggles the enclosing"))
        XCTAssertTrue(console.contains("SwipeBackGestureToggle(enabled: !model.consoleFromRecents)"))
    }

    /// The two things the compact shell used to keep *about itself*, and the tap that repaired the
    /// tear between them, are gone — from the code and from the comments, since the acceptance for
    /// this step is a plain `grep` over these directories.
    func testTheStrandedSelectionAndItsRepairsAreGone() throws {
        let sources = [
            "src/macos/OrbitApp/Sources/OrbitApp/AppModel.swift",
            "src/macos/OrbitApp/Sources/OrbitApp/Views/AgentsView.swift",
            "src/macos/OrbitApp/Sources/OrbitApp/Views/CompactShell.swift",
            "src/macos/OrbitApp/Sources/OrbitApp/Views/MainView.swift",
            "src/ios/Sources/OrbitiOSApp.swift",
        ]
        // Spelled in halves on purpose: the names this list guards against are themselves grepped
        // for across `src/macos` and `src/ios` (that is a criterion of the step that closed this
        // out), so the guard must not be a hit of its own. They are joined at run time, which keeps
        // the comparison exact.
        let staleNames = ["usesCompact" + "Shell",
                          "recentsConsole" + "SessionID",
                          "composedConsole" + "SessionID",
                          "reopen" + "SelectedRow",
                          "rearms" + "Tap",
                          "$model.composing" + "AgentSession"]
        for stale in staleNames {
            for path in sources {
                XCTAssertFalse(try source(path).contains(stale),
                               "\(path) still mentions \(stale)")
            }
        }
        // The section-switch cleanup that flag guarded: switching sections must not clear Agents'
        // pushes any more — the stack survives the switch, that being the point of keeping one per
        // section. A second clearing site is what used to strand the row.
        let setter = code(try slice(try appSource("AppModel.swift"),
                                    from: "var selectedSection: AppSection {",
                                    to: "/// Latches the one-shot default-landing"))
        XCTAssertFalse(setter.contains("selectedAgentSessionID"),
                       "a section switch leaves the Agents stack alone")
    }
}
