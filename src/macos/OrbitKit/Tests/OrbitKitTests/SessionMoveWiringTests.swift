import Foundation
import XCTest
@testable import OrbitKit

/// The iOS session list's Move (docs/session-folders-move-design.md §2 and §4): swiped left, a row
/// reads Share · Move · Delete from left to right, with Delete outermost and never fired by a full
/// swipe; the long-press menu has Move… after Share…; Move opens the Move panel, a native sheet the
/// list holds; and the app files the row at once, puts it back when the server refuses, and keeps
/// the folder library fresh. All of it is iOS only — the Mac shows no folders (§1).
///
/// SwiftUI doesn't exist on Linux, so nothing here compiles the shells. Each check reads the part of
/// the source it is about and asks which `#if` branch that part sits in: the branch is what decides
/// whether a platform gets the code at all.
final class SessionMoveWiringTests: XCTestCase {
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

    /// Where each of `needles` first appears in `text`, failing on one that does not.
    private func positions(_ needles: [String], in text: String,
                           file: StaticString = #filePath, line: UInt = #line) throws -> [String.Index] {
        try needles.map { try XCTUnwrap(text.range(of: $0), "no `\($0)`", file: file, line: line).lowerBound }
    }

    /// The title a row action property gives its action outside Trash — the last `RowSwipeAction` its
    /// body builds, after any Trash early return — e.g. `moveAction` → "Move". Read from the
    /// property's own body, so the order check below follows the actions, not their names.
    private func title(of property: String, in actions: String,
                       file: StaticString = #filePath, line: UInt = #line) throws -> String {
        let body = try slice(actions, from: "private var \(property): RowSwipeAction", to: "\n    }",
                             file: file, line: line)
        let marker = "RowSwipeAction(title: \""
        let made = try XCTUnwrap(body.range(of: marker, options: .backwards), "`\(property)` builds no action",
                                 file: file, line: line)
        let rest = body[made.upperBound...]
        let end = try XCTUnwrap(rest.firstIndex(of: "\""), file: file, line: line)
        return String(rest[..<end])
    }

    // MARK: the left swipe

    /// Left to right, Share · Move · Delete. A side lists its actions from the screen edge inward, as
    /// `.swipeActions` does, and the circles lay the trailing side out reversed — so the trailing list
    /// read backwards is the row left to right.
    func testTheLeftSwipeReadsShareMoveDeleteFromLeftToRight() throws {
        let actions = code(try appSource("Views/SessionRowActions.swift"))
        let trailing = try slice(actions, from: "private var trailingActions: [RowSwipeAction] {", to: "\n    }")
        let expression = "[deleteAction] + [moveAction, shareAction].compactMap { $0 }"
        XCTAssertTrue(trailing.contains(expression), "Delete outermost, then Move, then Share")

        let inward = try NSRegularExpression(pattern: "\\b(\\w+Action)\\b")
            .matches(in: expression, range: NSRange(expression.startIndex..., in: expression))
            .map { String(expression[Range($0.range(at: 1), in: expression)!]) }
        XCTAssertEqual(inward, ["deleteAction", "moveAction", "shareAction"])
        let leftToRight = try inward.reversed().map { try title(of: $0, in: actions) }
        XCTAssertEqual(leftToRight, ["Share", "Move", "Delete"])

        // The circles (iOS 26's compact list) and the system's buttons draw that one list, and the
        // circles reverse the trailing side to lay it out left to right.
        XCTAssertTrue(actions.contains("trailing: trailingActions"))
        let system = try slice(actions, from: ".swipeActions(edge: .trailing, allowsFullSwipe: false) {", to: "}")
        XCTAssertTrue(system.contains("ForEach(trailingActions) { button($0) }"))
        let circles = code(try appSource("Views/RowSwipeActions.swift"))
        XCTAssertTrue(circles.contains("let laidOut: [RowSwipeAction] = edge == .leading ? actions : actions.reversed()"),
                      "the trailing side is laid out from its innermost action, left to right")

        // Move is indigo with a folder; Share stays blue, Delete red and destructive.
        let move = try slice(actions, from: "private var moveAction: RowSwipeAction? {", to: "\n    }")
        XCTAssertTrue(move.contains("RowSwipeAction(title: \"Move\", systemImage: \"folder\", tint: .indigo, perform: onMove)"))
        let delete = try slice(actions, from: "private var deleteAction: RowSwipeAction {", to: "\n    }")
        XCTAssertTrue(delete.contains("RowSwipeAction(title: \"Delete\", systemImage: \"trash\", tint: .red,"))
        XCTAssertTrue(delete.contains("role: .destructive) { model.deleteSession(session.id) }"))
    }

    /// Delete is outermost and still can't be fired by a full swipe: the system's trailing side says
    /// so, and the circles have no full swipe on that side at all — only the first leading action
    /// runs from one.
    func testDeleteCannotBeFiredByAFullSwipe() throws {
        let actions = code(try appSource("Views/SessionRowActions.swift"))
        XCTAssertTrue(actions.contains(".swipeActions(edge: .trailing, allowsFullSwipe: false) {"))
        XCTAssertFalse(actions.contains(".swipeActions(edge: .trailing, allowsFullSwipe: true"))
        XCTAssertTrue(actions.contains(
            ".circleSwipeActions(id: session.id, leading: leadingActions, trailing: trailingActions,"))

        let circles = code(try appSource("Views/RowSwipeActions.swift"))
        let spaced = circles.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        XCTAssertTrue(spaced.contains("func circleSwipeActions(id: AnyHashable, leading: [RowSwipeAction], "
                                      + "trailing: [RowSwipeAction], leadingFullSwipe: Bool)"),
                      "a full swipe is the leading side's alone")
        let fullSwipe = try slice(circles, from: "case .fullSwipe:", to: "action.perform()")
        XCTAssertTrue(fullSwipe.contains("let action = leading[0]"), "and it runs the first leading action")

        // Three trailing buttons — Share, Move, Delete — open 220pt; however far and fast the row is
        // pulled past that, it gives grudgingly and comes to rest open, never firing anything.
        let width = RowSwipeGeometry.openWidth(slots: [RowSwipeGeometry.slot, RowSwipeGeometry.slot,
                                                       RowSwipeGeometry.slot])
        XCTAssertEqual(width, 220)
        let geometry = RowSwipeGeometry(leadingWidth: 150, trailingWidth: width, rowWidth: 393,
                                        leadingFullSwipe: true)
        for pull in [-250.0, -393, -800] {
            let offset = geometry.dragged(pull)
            XCTAssertGreaterThan(offset, pull, "past the buttons the row resists")
            XCTAssertFalse(geometry.isFullSwipe(offset))
            XCTAssertEqual(geometry.rest(offset: offset, velocity: -3000), .trailing)
            XCTAssertEqual(geometry.rest(offset: offset, velocity: 0), .trailing)
        }
    }

    // MARK: the long-press menu

    /// Move… follows Share…, so the menu's tail runs Share… · Move… · Delete as the swipe does, and
    /// it's there only where the swipe has Move.
    func testTheMenuHasMoveAfterShare() throws {
        let actions = code(try appSource("Views/SessionRowActions.swift"))
        let menu = try slice(actions, from: "@ViewBuilder private var menu: some View {", to: "\n    }")
        let order = try positions(["Label(SharePanelCopy.share, systemImage: shareAction.systemImage)",
                                   "if let moveAction {", "Label(\"Move…\", systemImage: moveAction.systemImage)",
                                   "Divider()", "button(deleteAction)"], in: menu)
        XCTAssertEqual(order, order.sorted(), "Share… · Move… · — · Delete")
        let item = try slice(menu, from: "if let moveAction {", to: "Divider()")
        XCTAssertTrue(item.contains("Button(action: moveAction.perform)"), "the menu runs the swipe's own action")
    }

    // MARK: iOS only

    /// The swipe's Move, the menu's Move…, the panel and the list's sheet for it compile for iOS
    /// alone, and Trash has none of them.
    func testTheNewEntriesAreCompiledForIOSOnly() throws {
        let actions = code(try appSource("Views/SessionRowActions.swift"))
        let made = "RowSwipeAction(title: \"Move\", systemImage: \"folder\", tint: .indigo, perform: onMove)"
        XCTAssertEqual(try branches(of: made, in: actions), ["os(iOS)"], "the Mac's rows have no Move")
        XCTAssertEqual(actions.components(separatedBy: "RowSwipeAction(title: \"Move\"").count - 1, 1,
                       "the swipe and the menu draw the same one")
        let move = try slice(actions, from: "private var moveAction: RowSwipeAction? {", to: "\n    }")
        XCTAssertTrue(move.contains("guard !isTrash, let onMove else { return nil }"), "nothing to file in Trash")
        XCTAssertTrue(try slice(move, from: "#else", to: "#endif").contains("return nil"))
        // The Mac's share entry is unchanged too: still iOS only, and also out of Trash.
        XCTAssertEqual(try branches(of: "RowSwipeAction(title: \"Share\"", in: actions), ["os(iOS)"])

        let agents = code(try appSource("Views/AgentsView.swift"))
        for part in ["@State private var movingSession: Session?", ".sheet(item: $movingSession)",
                     "onMove: { movingSession = s }", "await app.loadSessionFolders()"] {
            XCTAssertEqual(try branches(of: part, in: agents), ["os(iOS)"], "`\(part)` is iOS only")
        }
        let row = try slice(agents, from: "@ViewBuilder private func sessionRow(", to: "private func tagSectionHeader(")
        XCTAssertEqual(row.components(separatedBy: "onMove: { movingSession = s }").count - 1, 2,
                       "both of the iOS list's row shapes hand their session over")
        let projectRow = try slice(agents, from: "private func projectRow(_ row: SessionProjectRow)", to: "\n    }")
        XCTAssertEqual(projectRow.components(separatedBy: "onMove:").count - 1, 1,
                       "the project row has one Move callback, acting on its coordinator")
        let projectMove = "onMove: { if let coordinator = row.coordinator { movingSession = coordinator } }"
        XCTAssertTrue(projectRow.contains(projectMove))
        XCTAssertEqual(try branches(of: projectMove, in: agents), ["os(iOS)"])
        XCTAssertEqual(agents.components(separatedBy: "onMove:").count - 1, 3,
                       "two ordinary row shapes and one project coordinator hand a session over")
        let mac = try slice(agents, from: "ForEach(agents.agentSessions) { s in", to: "\n            }")
        XCTAssertEqual(try branches(of: "ForEach(agents.agentSessions) { s in", in: agents), ["!os(iOS)"])
        XCTAssertTrue(mac.contains(".sessionRowActions(s, scope: view, onTag: { taggingSession = s })"),
                      "the Mac's rows offer no Move")

        let sheet = code(try appSource("Views/SessionMoveSheet.swift"))
        XCTAssertEqual(try branches(of: "struct SessionMoveSheet: View", in: sheet), ["os(iOS)"])

        let app = code(try appSource("AppModel.swift"))
        for part in ["var sessionFolders: [SessionFolder] = []", "func loadSessionFolders() async",
                     "func moveSession(_ id: String, toFolder folderID: String?)",
                     "func createSessionFolder(named name: String, in workspace: Agent, moving sessionID: String)",
                     "private func patchSessionFolder(", "case .folderChanged:"] {
            XCTAssertEqual(try branches(of: part, in: app), ["os(iOS)"], "`\(part)` is iOS only")
        }
        let model = code(try appSource("AgentsModel.swift"))
        XCTAssertEqual(try branches(of: "func applyMovedSession(_ id: String, folderID: String?)", in: model),
                       ["os(iOS)"])
    }

    // MARK: the panel

    /// A native sheet in the workspace switcher's shape: its own navigation stack, Move over the
    /// session's title, Done at the top right, medium and large detents. One group — the folders of
    /// the session's workspace — whose rows file the session and close the panel.
    func testTheMovePanelIsANativeSheetLikeTheWorkspaceSwitcher() throws {
        let sheet = code(try appSource("Views/SessionMoveSheet.swift"))
        let switcher = code(try slice(try appSource("Views/AgentIdentity.swift"),
                                      from: "struct AgentSwitchSheet: View {", to: "\n}\n"))
        for part in ["NavigationStack {", ".navigationBarTitleDisplayMode(.inline)",
                     "ToolbarItem(placement: .topBarTrailing) {", ".presentationDetents([.medium, .large])"] {
            XCTAssertTrue(sheet.contains(part), "the panel has `\(part)`")
            XCTAssertTrue(switcher.contains(part), "as the workspace switcher does")
        }
        XCTAssertTrue(sheet.contains("Button(SessionMoveCopy.done) { dismiss() }"))
        XCTAssertTrue(sheet.contains(".navigationTitle(SessionMoveCopy.title)"))
        let title = try slice(sheet, from: "private var title: some View {", to: "\n    }")
        let order = try positions(["Text(SessionMoveCopy.title)",
                                   "Text(SessionHeader.title(for: session, fallbackAgent: workspace.name))",
                                   ".foregroundStyle(.secondary)"], in: title)
        XCTAssertEqual(order, order.sorted(), "Move, and the session's title under it in grey")
        XCTAssertTrue(sheet.contains("ToolbarItem(placement: .principal) { title }"))

        // The group: the workspace's folders as OrbitKit lists them, under "Folder in <workspace>",
        // then New Folder…. A tap closes the panel and files the session; the ticked row only closes.
        XCTAssertTrue(sheet.contains("Text(SessionMoveCopy.folderGroup(workspace: workspace.name))"))
        XCTAssertTrue(sheet.contains("SessionMoveLogic.folderOptions(for: session, workspaceID: workspace.id,"))
        XCTAssertTrue(sheet.contains("folders: app.sessionFolders, listed: listed)"))
        let choose = try slice(sheet, from: "private func choose(_ option: SessionMoveFolderOption) {", to: "\n    }")
        let steps = try positions(["dismiss()", "guard !option.isCurrent else { return }",
                                   "app.moveSession(session.id, toFolder: option.folder?.id)"], in: choose)
        XCTAssertEqual(steps, steps.sorted())

        // New Folder…: the system's prompt names it; the folder is made and the session moved into it,
        // and a refusal stays on the panel as an alert with the reason.
        let prompt = try slice(sheet, from: ".alert(SessionMoveCopy.newFolderTitle, isPresented: $naming) {",
                               to: "Text(SessionMoveCopy.newFolderMessage)")
        XCTAssertTrue(prompt.contains("TextField(SessionMoveCopy.folderNamePlaceholder, text: $draft)"))
        XCTAssertTrue(prompt.contains("Button(SessionMoveCopy.create) { create() }"))
        let create = try slice(sheet, from: "private func create() {", to: "\n    }")
        XCTAssertTrue(create.contains("guard let name = SessionMoveLogic.folderName(draft) else { return }"))
        XCTAssertTrue(create.contains("await app.createSessionFolder(named: name, in: workspace, moving: session.id)"))
        XCTAssertTrue(create.contains("if let refused { failure = refused } else { dismiss() }"))
        XCTAssertTrue(sheet.contains(".alert(SessionMoveCopy.couldNotCreate, isPresented: failed) {"))

        // The list holds one sheet. A project's coordinator may be in another workspace, so the
        // panel resolves the handed session's workspace and counts its folders over the full list.
        let agents = code(try appSource("Views/AgentsView.swift"))
        let presented = try slice(agents, from: ".sheet(item: $movingSession) { s in",
                                  to: "SessionMoveSheet(session: s, workspace: workspace, listed: agents.allSessions)")
        XCTAssertTrue(presented.contains("if let workspace = agents.agent(s.agent?.id ?? s.agentId ?? agent.id)"),
                      "the moved session owns the workspace, with the current workspace as a legacy fallback")
        XCTAssertEqual(presented.components(separatedBy: ".sheet(").count, 2, "one sheet, the list's own")
        XCTAssertEqual(agents.components(separatedBy: "SessionMoveSheet(").count - 1, 1)
    }

    // MARK: the app

    /// A move is drawn before the server answers — the folder written into every loaded copy of the
    /// row — put back as it was when the server refuses, and settled by re-reading the lists either
    /// way. The toast names where the session went only once the server has it there.
    func testTheRowMovesAtOnceAndGoesBackWhenRefused() throws {
        let app = code(try appSource("AppModel.swift"))
        let move = try slice(app, from: "func moveSession(_ id: String, toFolder folderID: String?) {",
                             to: "\n    }\n")
        let order = try positions(["let origin = row.folderId", "patchSessionFolder(id, to: folderID)",
                                   "try await api.moveSession(id, folderID: folderID)", "showToast(moved,",
                                   "} catch {", "patchSessionFolder(id, to: origin)",
                                   "showToast(SessionMoveCopy.moveFailed,", "await reloadSessionLists()"], in: move)
        XCTAssertEqual(order, order.sorted())
        XCTAssertTrue(move.contains("SessionMoveCopy.moved(to: sessionFolder(folderID), from: sessionFolder(origin))"))

        // Every loaded copy: the Open snapshot (and through it the pane's Open list), the pane's own
        // Completed rows, and the detail cache.
        let patch = try slice(app, from: "private func patchSessionFolder(", to: "\n    }\n")
        for part in ["list[index] = list[index].settingFolder(folderID)", "applySessionSnapshot(list)",
                     "sessionDetails.store(cached.settingFolder(folderID))",
                     "agents?.applyMovedSession(id, folderID: folderID)"] {
            XCTAssertTrue(patch.contains(part), "the patch writes `\(part)`")
        }

        // New Folder… makes the folder known before it moves the session into it, so the toast can
        // name it; a refusal is the sentence OrbitKit spells.
        let create = try slice(app, from: "func createSessionFolder(named name: String,", to: "\n    }\n")
        let steps = try positions(["api.createSessionFolder(workspaceID: workspace.id, name: name)",
                                   "sessionFolders.append(folder)", "moveSession(sessionID, toFolder: folder.id)",
                                   "SessionMoveCopy.createFailure(error, name: name, workspace: workspace.name)"],
                                  in: create)
        XCTAssertEqual(steps, steps.sorted())
    }

    /// The folder library is read when a workspace's list appears and again on `folder.changed` —
    /// its own branch, which re-reads the folders rather than the Open list — and after a reconnect,
    /// since the stream replays nothing missed.
    func testTheFolderLibraryLoadsWithTheListAndOnEveryFolderChange() throws {
        let agents = code(try appSource("Views/AgentsView.swift"))
        let task = try slice(agents, from: ".task {\n            await app.loadSessionTags()", to: "}")
        XCTAssertTrue(task.contains("await app.loadSessionFolders()"))

        let app = code(try appSource("AppModel.swift"))
        let apply = try slice(app, from: "private func apply(_ ev: ControlEvent) {", to: "\n    }\n")
        let branch = try slice(apply, from: "case .folderChanged:", to: "#endif")
        XCTAssertTrue(branch.contains("Task { await loadSessionFolders() }"))
        XCTAssertFalse(branch.contains("scheduleControlRefresh()"), "a folder change refetches no list")

        let connected = try slice(app, from: "case .connected:", to: "case .event(let ev):")
        XCTAssertTrue(connected.contains("Task { await loadSessionFolders() }"))

        let load = try slice(app, from: "func loadSessionFolders() async {", to: "\n    }")
        XCTAssertTrue(load.contains("guard let folders = try? await api.listSessionFolders() else { return }"),
                      "best-effort, like the tag library: an older server leaves it empty")
        XCTAssertTrue(load.contains("sessionFolders = folders"),
                      "an answer that landed replaces the library")
    }
}
