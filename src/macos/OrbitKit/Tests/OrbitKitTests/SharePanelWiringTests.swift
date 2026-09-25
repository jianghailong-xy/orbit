import Foundation
import XCTest

/// One Share panel for a session, a task and a project, on iOS and macOS alike, and the ⋯ menus that
/// open it (docs/share-links-design.md §8, docs/mocks/share-links/07-mobile ② ③). What the panel says
/// and sends is `SharePanel`, tested in OrbitKit; these checks read the app's source for what only
/// the views decide: that all three roots open the same view, that it draws the panel's sections in
/// the contract's order and none of its own words, that turning a link off goes through the
/// question, and that each menu offers Copy Link, Share… and Copy as Markdown.
///
/// SwiftUI doesn't exist on Linux, so nothing here compiles the views. Each check reads the part of
/// the source it is about; `#if` branches are read the way `ShareEntriesWiringTests` reads them.
final class SharePanelWiringTests: XCTestCase {
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

    private func slice(_ text: String, from start: String, to end: String,
                       file: StaticString = #filePath, line: UInt = #line) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`", file: file, line: line)
        let upper = try XCTUnwrap(text.range(of: end, range: lower.upperBound..<text.endIndex),
                                  "no `\(end)` after `\(start)`", file: file, line: line)
        return String(text[lower.lowerBound..<upper.upperBound])
    }

    /// The text without its comment lines, which are free to talk about what the code must not do.
    private func code(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }

    /// The conditional-compilation branches `needle` sits in, outermost first. Empty means every
    /// platform compiles it.
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

    /// Where each of `needles` first appears in `text`, failing on one that does not.
    private func positions(_ needles: [String], in text: String,
                           file: StaticString = #filePath, line: UInt = #line) throws -> [String.Index] {
        try needles.map { try XCTUnwrap(text.range(of: $0), "no `\($0)`", file: file, line: line).lowerBound }
    }

    private static let appFiles = ["Views/Console/ConsoleView.swift", "Views/TasksView.swift",
                                   "Views/ProjectsView.swift", "Views/ShareSheet.swift"]

    // MARK: one panel

    func testTheSessionTheTaskAndTheProjectOpenTheSamePanel() throws {
        let opened: [(String, String, String)] = [
            ("Views/Console/ConsoleView.swift", "$showShare",
             "ShareSheet(kind: .session, rootID: sessionID, baseURL: baseURL, tokenStore: appModel.tokenStore)"),
            ("Views/TasksView.swift", "$sharing",
             "ShareSheet(kind: .task, rootID: taskID, baseURL: baseURL, tokenStore: model.tokenStore)"),
            ("Views/ProjectsView.swift", "$sharing",
             "ShareSheet(kind: .project, rootID: projectID, baseURL: baseURL, tokenStore: model.tokenStore)"),
        ]
        var built = 0
        for file in Self.appFiles {
            built += code(try appSource(file)).components(separatedBy: "ShareSheet(").count - 1
        }
        XCTAssertEqual(built, opened.count, "one panel, built once per root and nowhere else")
        for (file, flag, sheet) in opened {
            let view = code(try appSource(file))
            let presented = try slice(view, from: ".sheet(isPresented: \(flag))", to: sheet)
            XCTAssertEqual(presented.components(separatedBy: ".sheet(").count, 2, "\(file): the flag's own sheet")
            XCTAssertFalse(presented.contains("#"), "\(file): the sheet's content isn't gated")
            XCTAssertEqual(try branches(of: ".sheet(isPresented: \(flag))", in: view), [],
                           "\(file): presented on iOS and macOS alike")
        }
        // The two menus keep saying what the panel did, from what it hands back.
        for file in ["Views/TasksView.swift", "Views/ProjectsView.swift"] {
            let view = code(try appSource(file))
            let handed = try slice(view, from: ".sheet(isPresented: $sharing)", to: "shareRead = $0")
            XCTAssertTrue(handed.contains("ShareSheet(kind:"), "\(file) keeps the menu's status in step with the panel")
        }
    }

    func testThePanelIsOneViewOnBothPlatformsAndOnlyItsChromeDiffers() throws {
        let sheet = code(try appSource("Views/ShareSheet.swift"))
        for part in ["struct ShareSheet: View", "private var accessSection: some View",
                     "private func linkSection(_ url: URL) -> some View", "private var includesSection: some View",
                     "private var updatesSection: some View", ".confirmationDialog(SharePanelCopy.turnOffTitle",
                     "api.shareLink(kind, rootID)", "api.putShareLink(kind, rootID, request)",
                     "api.turnOffShareLink(kind, rootID)"] {
            XCTAssertEqual(try branches(of: part, in: sheet), [], "`\(part)` is on both platforms")
        }
        XCTAssertEqual(try branches(of: ".frame(minWidth: 460, minHeight: 560)", in: sheet), ["os(macOS)"],
                       "the Mac sheet only gets a size")
    }

    // MARK: the panel's sections

    func testThePanelDrawsTheContractsSectionsTopToBottom() throws {
        let sheet = code(try appSource("Views/ShareSheet.swift"))
        let ready = try slice(sheet, from: "case .ready:", to: "if let errorText {")
        let order = try positions(["accessSection", "linkSection(url)", "includesSection", "updatesSection"], in: ready)
        XCTAssertEqual(order, order.sorted(), "Access → the link → Includes → Live and Expires")
        XCTAssertTrue(ready.contains("if let url = panel.publicURL(base: baseURL) {"),
                      "only a public link has a link, layers and an expiry to show")

        let access = try slice(sheet, from: "private var accessSection: some View", to: "private func linkSection(")
        for piece in ["Picker(selection: Binding(get: { panel.access }, set: { choose($0) }))",
                      "ForEach(SharePanel.Access.allCases)", "Text(access.label).tag(access)",
                      "Label(SharePanelCopy.access,", "Text(panel.accessDetail)"] {
            XCTAssertTrue(access.contains(piece), "Access: \(piece)")
        }

        let link = try slice(sheet, from: "private func linkSection(", to: "private var includesSection")
        let presses = try positions(["Text(url.absoluteString)",
                                     "Label(copied ? SharePanelCopy.copied : SharePanelCopy.copyLink",
                                     "ShareLink(item: url)", "Label(SharePanelCopy.shareLink"], in: link)
        XCTAssertEqual(presses, presses.sorted(), "the link, then Copy Link, then Share Link…")
        XCTAssertTrue(link.contains("PlatformPasteboard.copyString(url.absoluteString)"))

        let includes = try slice(sheet, from: "private var includesSection: some View", to: "private var updatesSection")
        for piece in ["ForEach(panel.layers)", "Toggle(isOn: Binding(get: { row.isOn }, set: { on in toggle(row, on: on) }))",
                      "Text(row.name)", "Text(row.detail)", "if let count = row.count {", "Text(count)",
                      ".foregroundStyle(row.warns ? Color.orange : Color.secondary)",
                      ".padding(.leading, row.isNested ? 16 : 0)", ".disabled(!row.isEditable || busy)",
                      "Text(SharePanelCopy.includes)"] {
            XCTAssertTrue(includes.contains(piece), "Includes: \(piece)")
        }

        let updates = try slice(sheet, from: "private var updatesSection: some View", to: "private func choose(")
        let rows = try positions(["Text(SharePanelCopy.updates)", "Text(SharePanelCopy.live)",
                                  "Picker(SharePanelCopy.expires, selection: Binding(get: { panel.expirySelection },",
                                  "if let hint = panel.expiryHint { Text(hint) }",
                                  "if let views = panel.viewsLine(now: Date()) { Text(views) }"], in: updates)
        XCTAssertEqual(rows, rows.sorted(), "Live, Expires, then how long it has left and how often it was opened")
        XCTAssertTrue(updates.contains("ForEach(panel.expiryOptions)"))
        XCTAssertTrue(sheet.contains(".navigationTitle(panel.title)"))
    }

    func testTurningTheLinkOffGoesThroughTheQuestion() throws {
        let sheet = code(try appSource("Views/ShareSheet.swift"))
        let choose = try slice(sheet, from: "private func choose(_ access: SharePanel.Access) {", to: "\n    }")
        XCTAssertTrue(choose.contains("case .confirmTurnOff: confirmingTurnOff = true"),
                      "choosing Only you asks; it does not turn the link off")
        XCTAssertFalse(choose.contains("turnOff()"))
        XCTAssertEqual(sheet.components(separatedBy: "await turnOff()").count - 1, 1, "one way to turn it off")
        let question = try slice(sheet, from: ".confirmationDialog(SharePanelCopy.turnOffTitle",
                                 to: "Text(SharePanelCopy.turnOffDetail)")
        XCTAssertTrue(question.contains("Button(SharePanelCopy.turnOff, role: .destructive) { Task { await turnOff() } }"),
                      "and that way is the question's yes")
        XCTAssertTrue(question.contains("Button(SharePanelCopy.cancel, role: .cancel) {}"))
        let turnOff = try slice(sheet, from: "private func turnOff() async {", to: "\n    }")
        XCTAssertTrue(turnOff.contains("try await api.turnOffShareLink(kind, rootID)"))
    }

    /// Every word the panel shows comes from `SharePanelCopy` or `SharePanel`, which
    /// `SharePanelCopyParityTests` holds to the web's. A literal typed into the view would be a word
    /// nothing checks.
    func testThePanelSaysNoWordsOfItsOwn() throws {
        let sheet = code(try appSource("Views/ShareSheet.swift"))
        for literal in ["Text(\"", "Button(\"", "Label(\"", "Picker(\"", "Toggle(\"", ".navigationTitle(\"",
                        ".confirmationDialog(\""] {
            XCTAssertFalse(sheet.contains(literal), "ShareSheet spells a word itself: \(literal)…")
        }
    }

    // MARK: the ⋯ menus

    func testTheProjectMenuOffersCopyLinkShareAndCopyAsMarkdown() throws {
        let view = code(try appSource("Views/ProjectsView.swift"))
        let menu = try slice(view, from: "private func menu(", to: "Image(systemName: \"ellipsis.circle\")")
        let order = try positions(["Label(\"Record as done\"", "Label(SharePanelCopy.copyLink,",
                                   "Label(SharePanelCopy.share,", "Label(SharePanelCopy.copyAsMarkdown,",
                                   "Label(\"Delete project\""], in: menu)
        XCTAssertEqual(order, order.sorted(), "Record… / Copy Link / Share… / Copy as Markdown / Delete")
        try assertShareAndMarkdown(in: menu, markdown: "ShareMarkdown.project(document, link: url.absoluteString,",
                                   file: "Views/ProjectsView.swift")
        XCTAssertTrue(view.contains("shareRead = await readShareLink()"), "the status is read when the page opens")
        XCTAssertTrue(view.contains(".shareLink(.project, projectID)"))
        XCTAssertFalse(menu.contains("#if"), "one menu for both apps")
    }

    func testTheTaskMenuOffersCopyLinkShareCopyAsMarkdownAndDelete() throws {
        let view = code(try appSource("Views/TasksView.swift"))
        let menu = try slice(view, from: "ToolbarItem(placement: .primaryAction) {\n                    Menu {",
                             to: ".accessibilityLabel(\"Task actions\")")
        let order = try positions(["Label(SharePanelCopy.copyLink,", "Label(SharePanelCopy.share,",
                                   "Label(SharePanelCopy.copyAsMarkdown,", "Label(\"Delete task\""], in: menu)
        XCTAssertEqual(order, order.sorted(), "Copy Link / Share… / Copy as Markdown / Delete task")
        let copyLink = try slice(menu, from: "if let url = model.taskWebURL(taskID) {",
                                 to: "Label(SharePanelCopy.copyLink,")
        XCTAssertTrue(copyLink.contains("PlatformPasteboard.copyString(url.absoluteString)"),
                      "Copy Link puts the task's signed-in address on the pasteboard")
        try assertShareAndMarkdown(in: menu, markdown: "ShareMarkdown.task(task, link: url.absoluteString)",
                                   file: "Views/TasksView.swift")
        XCTAssertTrue(view.contains(".shareLink(.task, taskID)"), "the status is read when the task opens")
        XCTAssertFalse(menu.contains("#if"), "one menu for both apps")
        XCTAssertEqual(try branches(of: "ToolbarItem(placement: .primaryAction) {\n                    Menu {", in: view),
                       [], "iOS and macOS show the same menu")
    }

    /// Share… opens the panel and says under itself whether a link is open; Copy as Markdown copies
    /// the page's Markdown; each copy says so in the web's words. Neither link goes to the system
    /// share sheet from here: that is the panel's Share Link….
    private func assertShareAndMarkdown(in menu: String, markdown: String, file: String,
                                        line: UInt = #line) throws {
        let share = try slice(menu, from: "Button { sharing = true } label: {", to: "Label(SharePanelCopy.copyAsMarkdown,")
        XCTAssertTrue(share.contains("if let status = SharePanel.menuStatus(shareRead) { Text(status) }"),
                      "\(file): Share… says whether a public link is open", line: line)
        XCTAssertTrue(menu.contains("PlatformPasteboard.copyString(\(markdown)"), "\(file): Copy as Markdown", line: line)
        XCTAssertTrue(menu.contains("model.showToast(SharePanelCopy.linkCopied)"), file, line: line)
        XCTAssertTrue(menu.contains("model.showToast(SharePanelCopy.markdownCopied)"), file, line: line)
        XCTAssertFalse(menu.contains("ShareLink("), "\(file): the menu hands nothing to the share sheet", line: line)
    }
}
