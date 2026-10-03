import Foundation
import XCTest
@testable import OrbitKit

/// The iOS Move panel's second group, Move to Another Workspace (docs/session-folders-move-design.md
/// §4, §5.2–5.4): the panel reads the server's answer and draws a row per other workspace — greyed
/// with the server's reason where the session can't go, the whole group greyed when it can't leave —
/// a workspace opens its page in the panel's own stack, a folder there asks Move to <workspace>? with
/// Move or End and Move, and the app runs End and Move's steps, takes the row out of the list and
/// says where it went. All of it iOS only, like the rest of the panel.
///
/// SwiftUI doesn't exist on Linux, so nothing here compiles the shells: each check reads the part of
/// the source it is about. What the words say and how End and Move steps are tested in
/// `SessionWorkspaceMoveTests`; this pins that the shells use them.
final class SessionWorkspaceMoveWiringTests: XCTestCase {
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

    /// The conditional-compilation branches `needle` sits in, outermost first.
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

    // MARK: the panel's second group

    /// Under the folders, Move to Another Workspace: the server's answer, read when the panel opens,
    /// put into rows by OrbitKit. A row the session can go to is a navigation link — the chevron is
    /// its own — and one it can't is the same row, greyed, with no way in; the group's footer says
    /// why the session can't leave at all. A server without the door (404) shows no group.
    func testThePanelListsTheOtherWorkspacesAsTheServerAnswers() throws {
        let sheet = code(try appSource("Views/SessionMoveSheet.swift"))
        let list = try slice(sheet, from: "List {", to: ".navigationTitle(SessionMoveCopy.title)")
        let order = try positions(["Text(SessionMoveCopy.folderGroup(workspace: workspace.name))",
                                   "workspaceGroup", ".task { await loadTargets() }"], in: list)
        XCTAssertEqual(order, order.sorted(), "the folders first, then the other workspaces")

        let group = try slice(sheet, from: "@ViewBuilder private var workspaceGroup: some View {",
                              to: "private func targetRow(")
        XCTAssertTrue(group.contains("ForEach(SessionWorkspaceMoveLogic.rows(targets, providerName: providerName)) { row in"))
        let open = try slice(group, from: "if row.isEnabled {", to: "} else {")
        XCTAssertTrue(open.contains("NavigationLink(value: row.target) { targetRow(row) }"))
        let greyed = try slice(group, from: "} else {", to: "}")
        XCTAssertTrue(greyed.contains("targetRow(row)"))
        XCTAssertFalse(greyed.contains("NavigationLink"), "only a row the session can go to opens")
        XCTAssertTrue(group.contains("Text(SessionMoveCopy.anotherWorkspaceGroup)"))
        XCTAssertTrue(group.contains("if let reason = SessionWorkspaceMoveLogic.groupReason(targets) { Text(reason) }"),
                      "the group says why the session can't leave, under it")
        XCTAssertTrue(group.contains("if !targets.targets.isEmpty {"), "no other workspace, no group")
        XCTAssertTrue(group.contains("Text(targetsFailure)"))
        XCTAssertTrue(group.contains("Text(SessionMoveCopy.loadingWorkspaces)"))

        // The row: brand mark, name, and the grey line — greyed whole where the session can't go.
        let drawn = try slice(sheet, from: "private func targetRow(_ row: SessionMoveTargetRow) -> some View {",
                              to: "\n    }\n")
        let parts = try positions(["ProviderMark(provider: row.target.provider, size: 30)",
                                   ".opacity(row.isEnabled ? 1 : 0.45)", "Text(row.target.name)",
                                   ".foregroundStyle(row.isEnabled ? .primary : .secondary)", "Text(row.detail)"],
                                  in: drawn)
        XCTAssertEqual(parts, parts.sorted())
        XCTAssertTrue(sheet.contains("AgentDefaults.providerName(slug, configured: app.agents?.configuredProviders)"),
                      "`<provider>` spelled as the workspace switcher spells it")

        let load = try slice(sheet, from: "private func loadTargets() async {", to: "\n    }\n")
        XCTAssertTrue(load.contains("targets = try await app.sessionMoveTargets(session.id)"))
        XCTAssertTrue(load.contains("} catch APIError.http(let status, _) where status == 404 {"))
        XCTAssertTrue(load.contains("targetsUnsupported = true"))
        XCTAssertTrue(load.contains("if targets == nil { targetsFailure = SessionMoveCopy.targetsFailed(error) }"))
    }

    /// A workspace opens its page in the panel's own stack, handed the panel's latest answer, a way to
    /// close the whole panel, and a way to read the answer again.
    func testAWorkspaceOpensItsPageInThePanelsStack() throws {
        let sheet = code(try appSource("Views/SessionMoveSheet.swift"))
        let destination = try slice(sheet, from: ".navigationDestination(for: SessionMoveTarget.self) { target in",
                                    to: "reload: { await loadTargets() })")
        XCTAssertTrue(destination.contains("SessionMoveTargetPage(session: session, workspace: workspace, target: target,"))
        XCTAssertTrue(destination.contains("close: { dismiss() }"), "the panel's own dismiss, not the page's pop")
        XCTAssertEqual(sheet.components(separatedBy: "NavigationStack {").count - 1, 1, "one stack: the panel's")
    }

    // MARK: the workspace's page

    /// Mock 03 ①: the workspace's name over the session's title, Done, the folders there — No Folder,
    /// each folder with its count, New Folder… — and the sentence about the runner and the
    /// conversation under them. Nothing is ticked: the session isn't there yet.
    func testThePageOffersTheFoldersThereAndSaysHowTheConversationCarriesOver() throws {
        let page = code(try appSource("Views/SessionMoveTargetPage.swift"))
        XCTAssertEqual(try branches(of: "struct SessionMoveTargetPage: View", in: page), ["os(iOS)"])
        let body = try slice(page, from: "var body: some View {", to: "\n    }\n")
        let rows = try positions(["Button { picked = Pick(folder: nil) } label: { row(nil) }",
                                  "ForEach(SessionWorkspaceMoveLogic.folders(of: current, adding: made)) { folder in",
                                  "Button { picked = Pick(folder: folder) } label: { row(folder) }",
                                  "Button { naming = true } label: {", "Text(SessionMoveCopy.newFolder)",
                                  "Text(SessionMoveCopy.folderGroup(workspace: current.name))",
                                  "Text(blocked ?? SessionMoveCopy.targetFooter(current))"], in: body)
        XCTAssertEqual(rows, rows.sorted())
        XCTAssertTrue(body.contains(".navigationTitle(current.name)"))
        XCTAssertTrue(body.contains("ToolbarItem(placement: .principal) { title }"))
        XCTAssertTrue(body.contains("Button(SessionMoveCopy.done) { close() }"))
        let row = try slice(page, from: "private func row(_ folder: SessionMoveFolder?) -> some View {", to: "\n    }\n")
        XCTAssertTrue(row.contains("Text(\"\\(folder.sessionCount)\")"))
        XCTAssertFalse(row.contains("checkmark"), "nothing is ticked on another workspace's page")

        // The page follows the panel's latest answer: a move that didn't go through reads it again,
        // and a workspace the session can no longer go to greys its folders and says why.
        XCTAssertTrue(page.contains("answer.targets.first { $0.workspaceId == target.workspaceId } ?? target"))
        XCTAssertTrue(page.contains("answer.reason ?? current.reason"))
        XCTAssertTrue(body.contains(".disabled(blocked != nil)"))
    }

    /// A tap always asks (§5.3): Move to <workspace>?, the body OrbitKit puts together from the
    /// server's answer, Cancel and Move — or End and Move for a session that has to end first.
    func testATapAsksMoveToTheWorkspace() throws {
        let page = code(try appSource("Views/SessionMoveTargetPage.swift"))
        let alert = try slice(page, from: ".alert(SessionMoveCopy.confirmTitle(current), isPresented: confirming, presenting: picked) { pick in",
                              to: "Text(SessionMoveCopy.confirmMessage(answer, to: current, from: workspace.name))")
        let order = try positions(["Button(SessionMoveCopy.cancel, role: .cancel) {}",
                                   "Button(SessionMoveCopy.confirmAction(answer)) { move(pick) }",
                                   ".keyboardShortcut(.defaultAction)"], in: alert)
        XCTAssertEqual(order, order.sorted())

        // New Folder… there makes the folder in that workspace, then asks to move the session into it.
        let create = try slice(page, from: "private func create() {", to: "\n    }\n")
        let steps = try positions(["guard let name = SessionMoveLogic.folderName(draft) else { return }",
                                   "try await app.createTargetFolder(named: name, inWorkspace: current.workspaceId)",
                                   "made.append(filed)", "picked = Pick(folder: filed)",
                                   "createFailure = SessionMoveCopy.createFailure(error, name: name, workspace: current.name)"],
                                  in: create)
        XCTAssertEqual(steps, steps.sorted())
    }

    /// Confirmed, the app moves the session; the page says which step it is on and can't be left
    /// meanwhile, closes the panel once the session is there, and otherwise says why in an alert and
    /// reads the server's answer again.
    func testTheConfirmedMoveRunsInTheAppAndTheOutcomeIsSaid() throws {
        let page = code(try appSource("Views/SessionMoveTargetPage.swift"))
        let move = try slice(page, from: "private func move(_ pick: Pick) {", to: "\n    }\n")
        let order = try positions(["phase = answer.needsEnd ? .ending : .moving",
                                   "await app.moveSession(session.id, to: current, folder: pick.folder?.id,",
                                   "endingFirst: answer.needsEnd) { phase = $0 }",
                                   "phase = nil", "if let refused {", "failure = refused", "await reload()",
                                   "} else {", "close()"], in: move)
        XCTAssertEqual(order, order.sorted())

        let body = try slice(page, from: "var body: some View {", to: "\n    }\n")
        for part in [".disabled(creating || phase != nil)", ".navigationBarBackButtonHidden(phase != nil)",
                     ".interactiveDismissDisabled(phase != nil)", "Text(SessionMoveCopy.progress(phase))",
                     ".alert(SessionMoveCopy.couldNotMove, isPresented: failed) {", ".disabled(phase != nil)"] {
            XCTAssertTrue(body.contains(part), "the page has `\(part)`")
        }
    }

    // MARK: the app

    /// End and Move is OrbitKit's `SessionWorkspaceMove.run` over the real doors: end the session,
    /// read its status until the run is over, then move it. Moved, every loaded copy of the row names
    /// the new workspace before the toast says where it went; either way the lists are read again.
    func testTheAppRunsEndAndMoveOverTheRealDoors() throws {
        let app = code(try appSource("AppModel.swift"))
        let move = try slice(app, from: "func moveSession(_ id: String, to target: SessionMoveTarget, folder folderID: String?,",
                             to: "\n    }\n")
        let steps = try positions(["SessionWorkspaceMove.run(", "endingFirst: endingFirst,",
                                   "end: { try await api.endSession(id) },",
                                   "status: { try await api.session(id).effectiveRunStatus },",
                                   "move: { try await api.moveSession(id, toWorkspace: target.workspaceId, folderID: folderID) },",
                                   "phase: { phase($0) })",
                                   "defer { Task { await reloadSessionLists() } }",
                                   "case .moved:", "patchSessionWorkspace(id, to: target, folder: folderID)",
                                   "showToast(SessionMoveCopy.movedToWorkspace(target.name),",
                                   "return nil", "case .failed(let reason):", "return reason"], in: move)
        XCTAssertEqual(steps, steps.sorted())

        // Every loaded copy: the Open snapshot — whose agent filter takes the row out of the
        // workspace's Open list — the pane's Completed rows, and the detail cache.
        let patch = try slice(app, from: "private func patchSessionWorkspace(", to: "\n    }\n")
        for part in ["row.settingWorkspace(id: target.workspaceId, name: target.name, model: workspace?.model,",
                     "list[index] = moved(list[index])", "applySessionSnapshot(list)",
                     "sessionDetails.store(moved(cached))",
                     "agents?.applyMovedSession(id, toWorkspace: target.workspaceId)"] {
            XCTAssertTrue(patch.contains(part), "the patch writes `\(part)`")
        }
        let model = code(try appSource("AgentsModel.swift"))
        let drop = try slice(model, from: "func applyMovedSession(_ id: String, toWorkspace workspaceID: String) {",
                             to: "\n    }\n")
        XCTAssertTrue(drop.contains("guard lastSessionQuery?.agentID != workspaceID else { return }"))
        XCTAssertTrue(drop.contains("agentSessions = SessionFilter.removing(id, from: agentSessions)"))
    }

    /// The whole second group compiles for iOS alone, like the rest of the panel: the Mac has no Move.
    func testTheWorkspaceMoveIsCompiledForIOSOnly() throws {
        let app = code(try appSource("AppModel.swift"))
        for part in ["func sessionMoveTargets(_ id: String) async throws -> SessionMoveTargets",
                     "func createTargetFolder(named name: String, inWorkspace workspaceID: String)",
                     "func moveSession(_ id: String, to target: SessionMoveTarget, folder folderID: String?,",
                     "private func patchSessionWorkspace("] {
            XCTAssertEqual(try branches(of: part, in: app), ["os(iOS)"], "`\(part)` is iOS only")
        }
        let model = code(try appSource("AgentsModel.swift"))
        XCTAssertEqual(try branches(of: "func applyMovedSession(_ id: String, toWorkspace workspaceID: String)", in: model),
                       ["os(iOS)"])
        let sheet = code(try appSource("Views/SessionMoveSheet.swift"))
        XCTAssertEqual(try branches(of: "@ViewBuilder private var workspaceGroup: some View {", in: sheet), ["os(iOS)"])
    }
}
