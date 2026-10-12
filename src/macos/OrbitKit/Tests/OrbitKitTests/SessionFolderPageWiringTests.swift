import Foundation
import XCTest
@testable import OrbitKit

/// The iOS folders' surfaces (docs/session-folders-move-design.md §3.3–3.4): the folder rows at the
/// top of a workspace's session list — only in Open and Completed, never in Trash or under a tag
/// grouping — the folder page they open (its title, its ⋯ and its ✎), where the new session's
/// `folderId` rides, and the two shells' different ways in and out. All of it is iOS only: macOS
/// shows no folders (§1).
///
/// SwiftUI doesn't exist on Linux, so nothing here compiles the shells. Each check reads the part of
/// the source it is about and asks which `#if` branch that part sits in.
final class SessionFolderPageWiringTests: XCTestCase {
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

    // MARK: the list's folder rows

    /// The folder rows are the list's very first rows, and the sessions filed in a folder are drawn
    /// behind its row rather than in the time sections below (§3.3).
    func testTheFolderRowsLeadTheListAndTakeTheirSessionsOutOfTheTimeSections() throws {
        let agents = code(try appSource("Views/AgentsView.swift"))
        let listing = try slice(agents, from: "private static func folderListing(_ projectListing: SessionProjectListing, _ inputs: SessionListInputs) -> SessionFolderListing {",
                                to: "\n    }")
        XCTAssertTrue(listing.contains("SessionFolderGrouping.listing(inputs.shownSessions,"))
        XCTAssertTrue(listing.contains("folders: inputs.workspaceFolders,"),
                      "this workspace's folders, out of the owner's whole library")
        XCTAssertTrue(listing.contains("view: inputs.view,"))
        XCTAssertTrue(listing.contains("byTag: inputs.byTag,"),
                      "a tag filter or Group by Tag draws no folders: two groupings on one list")
        XCTAssertTrue(listing.contains("runnerOffline: inputs.runnerOffline)"),
                      "an offline Runner silences a folder row's spinner, as the workspace row's")
        let inputs = try slice(agents, from: "private var listInputs: SessionListInputs {", to: "\n    }")
        for part in ["sessions: agents.agentSessions, tagFilter: tagFilter,", "folders: app.sessionFolders,",
                     "view: view, groupByTag: groupByTag,", "runnerOffline: agents.runnerIsOffline(agent.runnerId)"] {
            XCTAssertTrue(inputs.contains(part), "the grouping's inputs carry `\(part)`")
        }

        let sections = try slice(agents, from: "private static func timeSections(_ folderListing: SessionFolderListing, _ inputs: SessionListInputs) -> [SessionTimeSection] {",
                                 to: "\n    }")
        XCTAssertTrue(sections.contains("SessionTimeGrouping.sections(folderListing.sessions,"),
                      "the time sections are built from what the folders left")

        // The folder rows come before the time sections in the list itself, and the whole block is
        // where a folder is drawn at all — the tag-grouped and searching branches are above it.
        let body = try slice(agents, from: "List(selection: listSelection) {", to: "\n        .listStyle(.plain)")
        let order = try [
            XCTUnwrap(body.range(of: "ForEach(Array(folderListing.folders.enumerated())")?.lowerBound),
            XCTUnwrap(body.range(of: "ForEach(Array(timeSections.enumerated())")?.lowerBound),
        ]
        XCTAssertEqual(order, order.sorted(), "folders at the very top, the time sections under them")
        XCTAssertEqual(try branches(of: "SessionFolderGrouping.listing(inputs.shownSessions,", in: agents), ["os(iOS)"])
        XCTAssertEqual(try branches(of: "private func folderRow(_ row: SessionFolderRow)", in: agents), ["os(iOS)"])
    }

    /// A folder row opens the folder's page through the model's one entry point, carrying the
    /// workspace and the scope of the list it was tapped in (§3.3).
    func testAFolderRowOpensThePageThroughTheModelsOneEntryPoint() throws {
        let agents = code(try appSource("Views/AgentsView.swift"))
        let row = try slice(agents, from: "private func folderRow(_ row: SessionFolderRow)", to: "\n    }")
        XCTAssertTrue(row.contains("app.openFolder(SessionFolderAddress(folderID: row.folder.id, agentID: agent.id, view: view))"),
                      "one entry point for both shells, carrying the list's own scope")
        XCTAssertEqual(row.components(separatedBy: "app.openFolder(").count - 1, 1)

        // And the model's entry point is a stack transition — the folder is a frame, not a flag.
        let app = code(try appSource("AppModel.swift"))
        let open = try slice(app, from: "func openFolder(_ address: SessionFolderAddress) {", to: "\n    }")
        XCTAssertTrue(open.contains("nav.enterFolder(address)"))
        let leave = try slice(app, from: "func leaveFolder(_ folderID: String? = nil) {", to: "\n    }")
        XCTAssertTrue(leave.contains("nav.leaveFolder(folderID)"))
    }

    /// The row's long-press menu and the page's ⋯ offer the same two acts, wired to the one place
    /// they are presented from — the rename prompt and the delete confirmation (§3.4).
    func testTheRowsMenuAndThePagesMenuOfferTheSameTwoAsks() throws {
        let agents = code(try appSource("Views/AgentsView.swift"))
        let row = try slice(agents, from: "private func folderRow(_ row: SessionFolderRow)", to: "\n    }")
        let menu = try slice(row, from: ".contextMenu {", to: "\n        }")
        let order = try [
            XCTUnwrap(menu.range(of: "SessionFolderCopy.rename")?.lowerBound),
            XCTUnwrap(menu.range(of: "SessionFolderCopy.delete")?.lowerBound),
        ]
        XCTAssertEqual(order, order.sorted(), "Rename… then Delete Folder…")
        XCTAssertTrue(menu.contains("renamingFolder = row.folder"))
        XCTAssertTrue(menu.contains("deletingFolder = SessionFolderDeletion(folder: row.folder)"),
                      "the confirmation is given the folder alone — its body names no count")
        XCTAssertTrue(agents.contains(".sessionFolderManagement(renaming: $renamingFolder, deleting: $deletingFolder)"))

        // The page's ⋯ is the same two, and the same modifier presents them (`SessionFolderPage`).
        let page = code(try appSource("Views/SessionFolderPage.swift"))
        let pageMenu = try slice(page, from: "private var folderMenu: some View {", to: "\n    }")
        XCTAssertTrue(pageMenu.contains("SessionFolderCopy.rename"))
        XCTAssertTrue(pageMenu.contains("SessionFolderCopy.delete"))
        XCTAssertTrue(pageMenu.contains("app.leaveFolder") == false)
        XCTAssertTrue(page.contains(".sessionFolderManagement(renaming: $renamingFolder, deleting: $deletingFolder)"))

        // The one modifier behind both: the rename prompt (the system's field), the confirmation
        // whose body promises the sessions go back to the list, and the failure alert.
        let management = try slice(page, from: "private struct SessionFolderManagement: ViewModifier {", to: "\n}\n")
        XCTAssertTrue(management.contains(".alert(SessionFolderCopy.renameTitle, isPresented: renamingPresented)"))
        XCTAssertTrue(management.contains("TextField(SessionFolderCopy.namePlaceholder, text: $draft)"))
        XCTAssertTrue(management.contains(".orbitConfirmation(deleteTitle, isPresented: deletingPresented)"))
        XCTAssertTrue(management.contains("Text(SessionFolderCopy.deleteMessage)"))
        XCTAssertTrue(management.contains("Button(SessionFolderCopy.deleteConfirm, role: .destructive) { delete() }"))
        XCTAssertTrue(management.contains("await app.renameSessionFolder(folder.id, to: name)"))
        XCTAssertTrue(management.contains("await app.deleteSessionFolder(deletion.folder.id)"))
        XCTAssertTrue(management.contains("SessionFolderCopy.couldNotRename"))
        XCTAssertTrue(management.contains("SessionFolderCopy.couldNotDelete"))
        XCTAssertTrue(management.contains("SessionMoveLogic.folderName(draft)"),
                      "a name of spaces alone is not saved, as it is not created")
    }

    /// The ≡ menu makes a folder in this workspace without moving a session into it (§3.4), and says
    /// why not, readably, when the name is one the workspace already has.
    func testTheListMenuMakesAFolderAndSaysWhyNotWhenRefused() throws {
        let agents = code(try appSource("Views/AgentsView.swift"))
        let menu = try slice(agents, from: "private func sessionOptionsMenu(includesScope: Bool)", to: "\n    }")
        let item = try slice(menu, from: "if view != .trash {", to: "\n            }")
        XCTAssertTrue(item.contains("Button { namingFolder = true }"))
        XCTAssertTrue(item.contains("Label(SessionFolderCopy.newFolder, systemImage: \"folder.badge.plus\")"))
        XCTAssertTrue(agents.contains(".alert(SessionMoveCopy.newFolderTitle, isPresented: $namingFolder)"),
                      "the system's own name prompt, as the Move panel's New Folder…")
        XCTAssertTrue(agents.contains("Text(SessionFolderCopy.newFolderMessage)"))
        let create = try slice(agents, from: "private func createFolderFromMenu() {", to: "\n    }")
        XCTAssertTrue(create.contains("guard let name = SessionMoveLogic.folderName(newFolderDraft) else { return }"))
        XCTAssertTrue(create.contains("await app.createSessionFolder(named: name, in: agent)"))
        XCTAssertTrue(create.contains("newFolderFailure = refused"))
        XCTAssertTrue(agents.contains(".alert(SessionMoveCopy.couldNotCreate, isPresented: newFolderFailed)"),
                      "a refused name — a 409 — is said in so many words")
    }

    // MARK: the page

    /// The page is the design's (§3.3, mock 02's middle phone): the folder's name over its
    /// workspace's, ⋯ and ✎ at the trailing edge, and — in a wide shell, whose column has no stack —
    /// a back button at the leading one. A phone's page keeps the system back button instead.
    func testThePageCarriesTheFoldersNameOverTheWorkspaces() throws {
        let page = code(try appSource("Views/SessionFolderPage.swift"))
        let title = try slice(page, from: "private var title: some View {", to: "\n    }")
        let order = try [
            XCTUnwrap(title.range(of: "Text(titleText)")?.lowerBound),
            XCTUnwrap(title.range(of: "Text(agent.name)")?.lowerBound),
        ]
        XCTAssertEqual(order, order.sorted(), "the folder's name, with the workspace's under it")
        XCTAssertTrue(title.contains(".foregroundStyle(.secondary)"), "in grey")
        XCTAssertTrue(page.contains("ToolbarItem(placement: .principal) { title }"))

        let back = try slice(page, from: "if rowNavigation == .selection {", to: "\n            }")
        XCTAssertTrue(back.contains("app.leaveFolder(address.folderID)"))
        XCTAssertTrue(back.contains("Label(\"Back\", systemImage: \"chevron.backward\")"))
        XCTAssertTrue(page.contains("if rowNavigation == .selection {"), "only the wide shell gets one")

        XCTAssertTrue(page.contains("ToolbarItem(placement: .topBarTrailing) { folderMenu }"))
        let newSession = try slice(page, from: "app.startComposingSession(inFolder:", to: ")")
        XCTAssertTrue(newSession.contains("address.folderID, of: address.agentID"),
                      "the ✎ composes for the folder's own workspace")

        // The page's list is the list outside: Pinned then the recency sections, the same rows.
        XCTAssertTrue(page.contains("SessionTimeGrouping.sections(sessions, pinnedFirst: inputs.view == .open)"))
        XCTAssertTrue(page.contains("SessionFolderGrouping.sessions(inputs.sessions, inFolder: inputs.folderID ?? \"\","))
    }

    /// The page's rows are the workspace list's rows: the same `AgentSessionRow` wrapped the same
    /// two ways, offering the same actions — so a swipe or a long press there does what it does
    /// outside (§3.3).
    func testThePagesRowsAreTheListsRows() throws {
        let agents = code(try appSource("Views/AgentsView.swift"))
        let listRow = try slice(agents, from: "@ViewBuilder private func sessionRow(_ s: Session)", to: "\n    }")
        let pageRow = try slice(code(try appSource("Views/SessionFolderPage.swift")),
                                from: "@ViewBuilder private func sessionRow(_ s: Session)", to: "\n    }")
        for part in ["AgentSessionRow(session: s, deleted:",
                     "app.push(.console(sessionID: s.id, origin: .list))",
                     "row.sessionRowActions(s, scope:",
                     "onTag: { taggingSession = s }",
                     "onShare: { sharingSession = s }",
                     "onMove: { movingSession = s }",
                     ".tag(s.id)"] {
            XCTAssertTrue(listRow.contains(part), "the list's row draws `\(part)`")
            XCTAssertTrue(pageRow.contains(part), "and so does the page's")
        }
    }

    /// The draft a folder's ✎ opens carries the folder, all the way into the create request: frame →
    /// `NewSessionView` → the registry's draft → the console → `CreateSessionRequest.folderId`.
    func testTheNewSessionsFolderIdRidesFromTheFrameIntoTheCreateRequest() throws {
        let app = code(try appSource("AppModel.swift"))
        let composing = try slice(app, from: "var composingFolderID: String? {", to: "\n    }")
        XCTAssertTrue(composing.contains("if case .compose(_, let folderID) = nav.path.last { return folderID }"))

        let page = code(try appSource("Views/SessionFolderPage.swift"))
        XCTAssertTrue(page.contains("app.startComposingSession(inFolder: address.folderID, of: address.agentID)"))

        let detail = code(try appSource("Views/AgentsView.swift"))
        let draft = try slice(detail, from: "NewSessionView(agent: agent, registry: registry,", to: "folderID: draftFolderID))")
        XCTAssertTrue(draft.contains("folderID: draftFolderID,"))
        XCTAssertTrue(draft.contains(".id(newSessionDraftIdentity(agent, folderID: draftFolderID))"),
                      "the folder is part of the draft's identity")
        // The draft's folder is its frame's; the iPad's frameless draft beside a folder's page takes
        // that page's (`AgentsStackWiringTests`).
        let draftFolder = try slice(detail, from: "private var draftFolderID: String? {", to: "\n    }")
        XCTAssertTrue(draftFolder.contains("return app.composingFolderID"))

        let compact = code(try appSource("Views/CompactShell.swift"))
        let composePage = try slice(compact, from: "NewSessionView(agent: agent, registry: registry,", to: "model.openCreatedAgentSession(session)")
        XCTAssertTrue(composePage.contains("folderID: folderID"),
                      "the phone's page reads the frame it is showing")

        let newSession = try slice(detail, from: "init(agent: Agent, registry: ConsoleRegistry, defaultModel: String,",
                                   to: "var body: some View {")
        XCTAssertTrue(newSession.contains("folderID: folderID,"))

        let registry = code(try appSource("ConsoleRegistry.swift"))
        XCTAssertTrue(registry.contains("folderID: folderID,"), "the registry passes it to the draft console")
        let model = code(try appSource("ConsoleModel.swift"))
        XCTAssertTrue(model.contains("self.draftFolderID = folderID"))
        XCTAssertTrue(model.contains("folderId: draftFolderID))"),
                      "and the create request files the new session there")
        let request = try slice(model, from: "private func createDraftSession() async {", to: "onSessionCreated?(session)")
        XCTAssertTrue(request.contains("folderId: draftFolderID"))
    }

    // MARK: the two shells, and the folder that goes away

    /// A phone pushes the page on the Agents stack (system back and edge swipe come with it); a wide
    /// shell swaps its session column's list for it, with the page's own back button (§3.3).
    func testTheTwoShellsShowThePageTheirOwnWay() throws {
        let compact = code(try appSource("Views/CompactShell.swift"))
        let frames = try slice(compact, from: "case .compose(let agentID, let folderID):", to: "default:")
        XCTAssertTrue(frames.contains("case .folder(let address):       SessionFolderPage(address: address)"),
                      "the phone's folder page is a frame of the Agents stack")

        let agents = code(try appSource("Views/AgentsView.swift"))
        let column = try slice(agents, from: "if let address = app.folderColumn {", to: "} else {")
        XCTAssertTrue(column.contains("SessionFolderPage(address: address, rowNavigation: rowNavigation, searchQuery: $searchQuery)"))
        XCTAssertEqual(try branches(of: "if let address = app.folderColumn {", in: agents), ["os(iOS)"],
                       "macOS draws no folders (§1)")
        XCTAssertTrue(try slice(agents, from: "@ViewBuilder private var workspaceList: some View {", to: "\n    }")
            .contains("AgentPanes(agents: agents"), "the column's own list is still what is under it")
    }

    /// A folder deleted under its page takes the page with it (§3.3) — whether the delete was this
    /// device's or another one's, and only for the folder that is actually open.
    func testAFolderDeletedUnderThePageTakesThePageWithIt() throws {
        let app = code(try appSource("AppModel.swift"))
        let delete = try slice(app, from: "func deleteSessionFolder(_ id: String) async -> String? {", to: "\n    }\n")
        let order = try [
            XCTUnwrap(delete.range(of: "try await api.deleteSessionFolder(id)")?.lowerBound),
            XCTUnwrap(delete.range(of: "sessionFolders.removeAll { $0.id == id }")?.lowerBound),
            XCTUnwrap(delete.range(of: "nav.leaveFolder(id)")?.lowerBound),
        ]
        XCTAssertEqual(order, order.sorted(), "the folder goes from the library, and the page comes down")

        let load = try slice(app, from: "func loadSessionFolders() async {", to: "\n    }")
        XCTAssertTrue(load.contains("guard let folders = try? await api.listSessionFolders() else { return }"),
                      "only an answer that landed can say a folder is gone")
        XCTAssertTrue(load.contains("if let open = nav.folderPage ?? nav.folderColumn,"),
                      "the page on a phone, or the list's page in a wide shell")
        XCTAssertTrue(load.contains("nav.leaveFolder(open.folderID)"))

        // Renaming keeps the folder where it is: the library entry is replaced in place.
        let rename = try slice(app, from: "func renameSessionFolder(_ id: String, to name: String) async -> String? {",
                               to: "\n    }\n")
        XCTAssertTrue(rename.contains("sessionFolders[index] = renamed"))
        XCTAssertTrue(rename.contains("SessionFolderCopy.renameFailure(error, name: name, workspace: workspace)"))
    }

    /// The whole layer is iOS only: the page, the rows' menu modifier and the model's folder page /
    /// rename / delete / create entries compile for iOS alone (§1).
    func testTheFoldersLayerIsCompiledForIOSOnly() throws {
        XCTAssertEqual(try branches(of: "struct SessionFolderPage: View", in: try appSource("Views/SessionFolderPage.swift")),
                       ["os(iOS)"])
        XCTAssertEqual(try branches(of: "struct SessionFolderRowView: View", in: try appSource("Views/SessionFolderPage.swift")),
                       ["os(iOS)"])
        XCTAssertEqual(try branches(of: "private struct SessionFolderManagement: ViewModifier",
                                    in: try appSource("Views/SessionFolderPage.swift")),
                       ["os(iOS)"])

        let agents = code(try appSource("Views/AgentsView.swift"))
        for part in ["@State private var renamingFolder: SessionFolder?",
                     "@State private var deletingFolder: SessionFolderDeletion?",
                     "@State private var namingFolder = false"] {
            XCTAssertEqual(try branches(of: part, in: agents), ["os(iOS)"], "`\(part)` is iOS only")
        }
        // The Mac's rows are untouched: it keeps its own ForEach, with no folder row anywhere.
        let mac = try slice(agents, from: "ForEach(agents.agentSessions) { s in", to: "\n            }")
        XCTAssertFalse(mac.contains("folderRow("))

        let app = code(try appSource("AppModel.swift"))
        for part in ["func openFolder(_ address: SessionFolderAddress)",
                     "func leaveFolder(_ folderID: String? = nil)",
                     "func renameSessionFolder(_ id: String, to name: String)",
                     "func deleteSessionFolder(_ id: String) async -> String?",
                     "func createSessionFolder(named name: String, in workspace: Agent) async -> String?",
                     "var folderPage: SessionFolderAddress? { nav.folderPage }",
                     "var folderColumn: SessionFolderAddress? { nav.folderColumn }"] {
            XCTAssertEqual(try branches(of: part, in: app), ["os(iOS)"], "`\(part)` is iOS only")
        }
    }
}
