import Foundation
import XCTest

/// Two words, two meanings. The project menu's link is the signed-in app address — something you
/// copy for yourself, so it reads `Copy Link` and goes to the pasteboard, not to the system share
/// sheet. `Share` is the public, read-only link, and the session page offers it on both platforms:
/// one sheet, opened from the nav bar on iOS and from the window toolbar on macOS.
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
                             to: "Label(\"Copy Link\", systemImage: \"link\")")
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
        // Create / Copy / Share / Revoke — the same four on both platforms, none behind a branch.
        for action in ["api.enableShare(sessionID)", "PlatformPasteboard.copyString(url.absoluteString)",
                       "ShareLink(item: url)", "api.disableShare(sessionID)"] {
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
                              to: ".accessibilityLabel(\"Share session\")")
        XCTAssertEqual(try branches(of: "ToolbarItem(placement: .topBarTrailing) {", in: console), ["os(iOS)"])
        XCTAssertTrue(phone.contains("Button { showShare = true }"))

        // One sheet, presented on both platforms by whichever button set the flag, and it is the
        // ShareSheet: nothing else is presented between the flag's sheet and the ShareSheet it builds.
        XCTAssertEqual(try branches(of: ".sheet(isPresented: $showShare)", in: console), [])
        let presented = try slice(body, from: ".sheet(isPresented: $showShare)",
                                  to: "ShareSheet(sessionID: sessionID, baseURL: baseURL, tokenStore: appModel.tokenStore)")
        XCTAssertEqual(presented.components(separatedBy: ".sheet(").count, 2, "one sheet, the flag's own")
        XCTAssertFalse(presented.contains("#"), "the sheet's content isn't gated either")
        XCTAssertEqual(console.components(separatedBy: "ShareSheet(").count, 2, "one place builds the sheet")
    }
}
