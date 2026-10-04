import Foundation
import XCTest

/// Two words, two meanings. The project menu's link is the signed-in app address — something you
/// copy for yourself, so it reads `Copy Link` and goes to the pasteboard, not to the system share
/// sheet. `Share` is the public, read-only link, and the session page offers it on both platforms:
/// one sheet, opened from the nav-bar menu on iOS and from the window toolbar on macOS. On iOS the
/// session list's rows offer it as well.
///
/// SwiftUI doesn't exist on Linux, so nothing here compiles the shells. Each check reads the part of
/// the source it is about and asks which `#if` branch that part sits in: the branch is what decides
/// whether a platform gets the code at all.
final class ShareEntriesWiringTests: XCTestCase {
    private struct SourceMissing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "\(path) wasn't found above this test. If it moved, point this check at its new home — "
                + "don't delete the check."
        }
    }

    private func appSource(_ relative: String) throws -> String {
        let path = "src/macos/OrbitApp/Sources/OrbitApp/\(relative)"
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

    /// The conditional-compilation branches `needle` sits in, outermost first: `os(iOS)` inside an
    /// `#if os(iOS)`, `!os(iOS)` inside its `#else`. Empty means every platform compiles it.
    private func branches(of needle: String, in text: String,
                          file: StaticString = #filePath, line: UInt = #line) throws -> [String] {
        let at = try XCTUnwrap(text.range(of: needle), "no `\(needle)`", file: file, line: line)
        var stack: [String] = []
        for row in text[..<at.lowerBound].split(separator: "\n", omittingEmptySubsequences: false) {
            let directive = row.components(separatedBy: "//")[0].trimmingCharacters(in: .whitespaces)
            if directive.hasPrefix("#if ") {
                stack.append(String(directive.dropFirst(4)))
            } else if directive.hasPrefix("#elseif "), !stack.isEmpty {
                stack[stack.count - 1] = String(directive.dropFirst(8))
            } else if directive == "#else", let open = stack.popLast() {
                stack.append("!" + open)
            } else if directive == "#endif" {
                _ = stack.popLast()
            }
        }
        return stack
    }

    func testTheProjectMenuCopiesTheSignedInAddressInsteadOfSharingIt() throws {
        let view = code(try appSource("Views/ProjectsView.swift"))
        let menu = try slice(view, from: "private func menu(", to: "Image(systemName: \"ellipsis.circle\")")
        let item = try slice(menu, from: "if let url = model.projectWebURL(document.id) {",
                             to: "Label(SharePanelCopy.copyLink, systemImage: \"link\")")
        XCTAssertTrue(item.contains("Button {"), "Copy Link is a plain menu button")
        XCTAssertTrue(item.contains("PlatformPasteboard.copyString(url.absoluteString)"),
                      "Copy Link puts the project's app address on the pasteboard")
        XCTAssertFalse(menu.contains("ShareLink("),
                       "the signed-in address no longer goes to the system share sheet")
        XCTAssertFalse(menu.contains("\"Share link\""), "nor borrows the public link's word")
        // One menu for both apps: nothing in it, or around the toolbar item carrying it, is gated.
        XCTAssertFalse(menu.contains("#if"))
        XCTAssertEqual(try branches(of: "private func menu(", in: view), [])
        XCTAssertEqual(try branches(of: "ToolbarItem(placement: .primaryAction) { menu(store, document) }",
                                    in: view), [], "iOS and macOS show the same menu")
    }

    func testTheShareSheetIsCompiledForMacAsWellAsIOS() throws {
        let sheet = code(try appSource("Views/ShareSheet.swift"))
        XCTAssertEqual(try branches(of: "struct ShareSheet: View", in: sheet), [],
                       "the sheet is built for every platform, not for iOS only")
        // Open or change / Copy / Share / Turn off — the same four on both platforms, none behind a
        // branch.
        for action in ["api.putShareLink(kind, rootID, request)", "PlatformPasteboard.copyString(url.absoluteString)",
                       "ShareLink(item: url)", "api.turnOffShareLink(kind, rootID)"] {
            XCTAssertEqual(try branches(of: action, in: sheet), [], "`\(action)` is on both platforms")
        }
        // Only the chrome differs: the phone's inline title and nav-bar Done, the Mac's Done button.
        XCTAssertEqual(try branches(of: ".navigationBarTitleDisplayMode(.inline)", in: sheet), ["os(iOS)"])
        XCTAssertEqual(try branches(of: "ToolbarItem(placement: .topBarTrailing)", in: sheet), ["os(iOS)"])
        XCTAssertEqual(try branches(of: "ToolbarItem(placement: .confirmationAction)", in: sheet), ["!os(iOS)"])
    }

    func testTheMacSessionPageOpensTheSameSheetFromItsWindowToolbar() throws {
        // The Mac's session page is the console in the Agents detail pane.
        let agents = code(try appSource("Views/AgentsView.swift"))
        XCTAssertEqual(try branches(of: "ConsoleView(sessionID: sid, agentID:", in: agents), [])

        let console = code(try appSource("Views/Console/ConsoleView.swift"))
        XCTAssertEqual(try branches(of: "@State private var showShare = false", in: console), [],
                       "the flag the sheet reads exists on both platforms")
        let body = try slice(console, from: "private func consoleBody(", to: "private struct ConsoleNavTitle")

        let mac = try slice(body, from: "ToolbarItem(placement: .primaryAction) {", to: ".help(")
        XCTAssertEqual(try branches(of: "ToolbarItem(placement: .primaryAction) {", in: console), ["!os(iOS)"],
                       "the window toolbar's button is the macOS half of the nav bar's")
        XCTAssertTrue(mac.contains("Button { showShare = true }"))
        XCTAssertTrue(mac.contains("Label(\"Share session\", systemImage: \"square.and.arrow.up\")"))

        let phone = try slice(body, from: "ToolbarItem(placement: .topBarTrailing) {",
                              to: ".sessionRenameAlert(")
        XCTAssertEqual(try branches(of: "ToolbarItem(placement: .topBarTrailing) {", in: console), ["os(iOS)"])
        XCTAssertTrue(phone.contains("if let session = appModel.session(id: sessionID)"))
        XCTAssertTrue(phone.contains("sessionMenu(session)"))
        let menu = try slice(console, from: "private func sessionMenu(", to: "\n    }")
        XCTAssertEqual(try branches(of: "private func sessionMenu(", in: console), ["os(iOS)"])
        XCTAssertTrue(menu.contains("Menu {"))
        XCTAssertTrue(menu.contains("Button { showShare = true }"))
        XCTAssertTrue(menu.contains(".accessibilityLabel(\"Session actions\")"))

        // One sheet, presented on both platforms by whichever button set the flag, and it is the
        // ShareSheet: nothing else is presented between the flag's sheet and the ShareSheet it builds.
        XCTAssertEqual(try branches(of: ".sheet(isPresented: $showShare)", in: console), [])
        let presented = try slice(body, from: ".sheet(isPresented: $showShare)",
                                  to: "ShareSheet(kind: .session, rootID: sessionID, baseURL: baseURL, tokenStore: appModel.tokenStore)")
        XCTAssertEqual(presented.components(separatedBy: ".sheet(").count, 2, "one sheet, the flag's own")
        XCTAssertFalse(presented.contains("#"), "the sheet's content isn't gated either")
        XCTAssertEqual(console.components(separatedBy: "ShareSheet(").count, 2, "one place builds the sheet")
    }

    func testTheIOSSessionMenuKeepsTrashAndPermanentDeletionSeparate() throws {
        let console = code(try appSource("Views/Console/ConsoleView.swift"))
        let menu = try slice(console, from: "private func sessionMenu(", to: "\n    }")
        let trash = try slice(menu, from: "if session.effectiveLifecycleState == .trash {", to: "} else {")
        XCTAssertTrue(trash.contains("appModel.moveSessionToOpen(session.id)"))
        XCTAssertTrue(trash.contains("canRestore"))
        XCTAssertTrue(trash.contains("confirmPurge = true"))
        for action in ["showShare = true", "appModel.deleteSession(", "appModel.completeSession("] {
            XCTAssertFalse(trash.contains(action), "Trash cannot offer \(action)")
        }
        XCTAssertFalse(menu.contains("appModel.purgeSession("), "the menu only requests confirmation")
        let confirmation = try slice(console, from: ".confirmationDialog(\"Delete permanently?\"",
                                     to: "} message: {")
        XCTAssertTrue(confirmation.contains("appModel.purgeSession(sessionID)"))
        XCTAssertTrue(confirmation.contains("role: .destructive"))
        XCTAssertEqual(console.components(separatedBy: "appModel.purgeSession(").count - 1, 1,
                       "permanent deletion has no path outside its confirmation")
    }

    func testTheIOSSessionMenuUsesSessionCapabilitiesAndPreservesConversationNavigation() throws {
        let console = code(try appSource("Views/Console/ConsoleView.swift"))
        let menu = try slice(console, from: "private func sessionMenu(", to: "\n    }")
        let complete = try slice(menu, from: "appModel.completeSession(session.id)", to: "canComplete")
        XCTAssertTrue(complete.contains(".disabled("), "Complete follows the server's capability")
        XCTAssertTrue(menu.contains("appModel.deleteSession(session.id)"), "Delete remains a soft delete")
        XCTAssertTrue(menu.contains("openFromConversation(.task(taskID), overConsole: opensPagesOverConsole)"))
        XCTAssertTrue(menu.contains("openProjectFromConversation(projectID, overConsole: opensPagesOverConsole)"))
        XCTAssertFalse(menu.contains("appModel.route("), "opening related work must retain the phone's way back")
        XCTAssertFalse(menu.contains("setStatus("), "filing a session must not declare its task done")
    }

    func testTheIOSSessionMenuCopiesTheSignedInLinkWithoutPublishing() throws {
        let console = code(try appSource("Views/Console/ConsoleView.swift"))
        let menu = try slice(console, from: "private func sessionMenu(", to: "\n    }")
        let copy = try slice(menu, from: "if let url = appModel.sessionWebURL(session.id) {",
                             to: "Label(SharePanelCopy.copyLink,")
        XCTAssertTrue(copy.contains("PlatformPasteboard.copyString(url.absoluteString)"))
        XCTAssertFalse(copy.contains("showShare = true"))
        XCTAssertFalse(menu.contains("ShareLink("))
        XCTAssertFalse(menu.contains("putShareLink("), "only the Share panel may publish a link")
        let model = code(try appSource("AppModel.swift"))
        let address = try slice(model, from: "func sessionWebURL(", to: "\n    }")
        XCTAssertTrue(address.contains("appendingPathComponent(\"sessions\")"))
        XCTAssertTrue(address.contains("PublicID.toPublic("))
    }

    func testTheIOSSessionMoveUsesTheNestedWorkspaceRelationFromCurrentAPIs() throws {
        let console = code(try appSource("Views/Console/ConsoleView.swift"))
        let workspace = try slice(console, from: "private func sessionWorkspace(", to: "\n    }")
        XCTAssertTrue(workspace.contains("session.agent?.id ?? session.agentId"),
                      "current list/detail payloads send agent.id without a flat agentId")
        XCTAssertEqual(console.components(separatedBy: "($0.agent?.id ?? $0.agentId)").count - 1, 2,
                       "both the cached and fetched folder counts use the same nested relation")
        XCTAssertFalse(console.contains("$0.agentId =="), "a flat-only filter silently loses current API rows")
    }

    /// The iOS session list offers Share on each row too: swiped left, just inside Delete, and as
    /// Share… in the long-press menu (docs/session-folders-move-design.md §2). It opens the session
    /// page's panel from a sheet the list holds, as it holds the tag picker's; the row only hands its
    /// session over. iOS only — the Mac's rows have none — and never in Trash, whose sessions can't
    /// be shared (docs/share-links-design.md §3).
    func testTheIOSSessionListSharesARowFromItsSwipeAndItsMenu() throws {
        let actions = code(try appSource("Views/SessionRowActions.swift"))

        // One action, compiled for iOS alone, and none in Trash.
        let share = try slice(actions, from: "private var shareAction: RowSwipeAction? {", to: "\n    }")
        let made = "RowSwipeAction(title: \"Share\", systemImage: \"square.and.arrow.up\", tint: .blue, perform: onShare)"
        XCTAssertTrue(share.contains(made), "blue, square.and.arrow.up, running what the list handed over")
        XCTAssertEqual(try branches(of: made, in: actions), ["os(iOS)"], "the Mac's rows have no Share")
        XCTAssertTrue(share.contains("guard !isTrash, let onShare else { return nil }"),
                      "a trashed session can't be shared")
        XCTAssertEqual(actions.components(separatedBy: "RowSwipeAction(title: \"Share\"").count - 1, 1,
                       "the swipe and the menu draw the same one")

        // Swiped left it sits inside Delete and Move: a side lists its actions from the screen edge
        // inward, so Delete stays outermost, and the trailing side has no full swipe. The circles and
        // the system's buttons draw the same list. (`SessionMoveWiringTests` holds the whole order.)
        let trailing = try slice(actions, from: "private var trailingActions: [RowSwipeAction] {", to: "\n    }")
        XCTAssertTrue(trailing.contains("[deleteAction] + [moveAction, shareAction].compactMap { $0 }"),
                      "Delete first and alone where there's no Share")
        XCTAssertTrue(actions.contains("trailing: trailingActions"))
        let system = try slice(actions, from: ".swipeActions(edge: .trailing, allowsFullSwipe: false) {", to: "}")
        XCTAssertTrue(system.contains("ForEach(trailingActions) { button($0) }"))

        // The long-press menu has it too, as Share…, only where the swipe has it.
        let menu = try slice(actions, from: "@ViewBuilder private var menu: some View {", to: "\n    }")
        let item = try slice(menu, from: "if let shareAction {", to: "Divider()")
        XCTAssertTrue(item.contains("Button(action: shareAction.perform)"))
        XCTAssertTrue(item.contains("Label(SharePanelCopy.share, systemImage: shareAction.systemImage)"))

        // The list holds the sheet, iOS only like the action, and builds the session page's panel for
        // the row it was handed. Only the iOS list's rows hand one over.
        let agents = code(try appSource("Views/AgentsView.swift"))
        XCTAssertEqual(try branches(of: "@State private var sharingSession: Session?", in: agents), ["os(iOS)"])
        XCTAssertEqual(try branches(of: ".sheet(item: $sharingSession)", in: agents), ["os(iOS)"])
        let presented = try slice(agents, from: ".sheet(item: $sharingSession)",
                                  to: "ShareSheet(kind: .session, rootID: s.id, baseURL: baseURL, tokenStore: app.tokenStore)")
        XCTAssertEqual(presented.components(separatedBy: ".sheet(").count, 2, "one sheet, the list's own")
        let row = try slice(agents, from: "@ViewBuilder private func sessionRow(", to: "private func tagSectionHeader(")
        XCTAssertEqual(row.components(separatedBy: "onShare: { sharingSession = s }").count - 1, 2,
                       "both of the iOS list's row shapes hand their session over")
        XCTAssertEqual(agents.components(separatedBy: "onShare:").count - 1, 2, "and nothing else does")
        XCTAssertEqual(try branches(of: "onShare: { sharingSession = s }", in: agents), ["os(iOS)"])
    }
}
