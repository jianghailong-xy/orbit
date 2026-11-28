import Foundation
import XCTest

/// SwiftUI doesn't exist on Linux, so nothing here compiles the app shells. These hold a machine's first
/// workspace to the source: which entries lead to the machine's new session page, that its card alone makes
/// the workspace there, and that nothing is left greyed out or sending anyone to the web. The behaviour is
/// `MachineSetupTests`' and the pictures' (docs/evidence/first-workspace-native); this is that the shells
/// reach it. Each check reads the slice of the file it is about.
final class MachineSetupWiringTests: XCTestCase {
    private struct SourceMissing: Error { let path: String }

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

    private func app(_ relative: String) throws -> String {
        code(try source("src/macos/OrbitApp/Sources/OrbitApp/\(relative)"))
    }

    private func slice(_ text: String, from start: String, to end: String) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`")
        let upper = try XCTUnwrap(text.range(of: end, range: lower.upperBound..<text.endIndex),
                                  "no `\(end)` after `\(start)`")
        return String(text[lower.lowerBound..<upper.upperBound])
    }

    private func code(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }

    private func assertInOrder(_ text: String, _ pieces: [String], _ what: String) throws {
        var from = text.startIndex
        for piece in pieces {
            let found = try XCTUnwrap(text.range(of: piece, range: from..<text.endIndex),
                                      "\(what): `\(piece)` is missing or out of order")
            from = found.upperBound
        }
    }

    // MARK: the rows

    /// Rule 9: after every workspace, and the row's destination is the machine.
    func testTheDrawerDrawsTheRowAfterEveryWorkspace() throws {
        let shell = try app("Views/CompactShell.swift")
        let rows = try slice(shell, from: "private var agentsRows: some View {", to: "private func unreachableRow(")
        try assertInOrder(rows, ["ForEach(agents.orderedItems)", "ForEach(agents.machinesToSetUp)", "setUpRow(machine, separates:"],
                          "the Set up rows come last")
        try assertInOrder(rows, ["model.drawerDestination == .machine(runnerID: machine.id)",
                                 "open(.machine(runnerID: machine.id))", "Image(systemName: machine.isManaged ? \"cloud\" : \"folder.badge.plus\")",
                                 "MachineSetupCopy.setupTitle(machine: machine.name)", ".foregroundStyle(Color.accentColor)"],
                          "the row is board 03's")
    }

    /// The Mac: the drawer's flat order, the Set up rows after every workspace, selected through the
    /// source list's one selection (docs/mocks/macos-sidebar, 01).
    func testTheMacsSidebarListsTheSetUpRowsLast() throws {
        let main = try app("Views/MainView.swift")
        let sidebar = try slice(main, from: "private func workspaceRows(", to: "struct AccountFooter")
        // One flat ForEach over `AgentListLogic.sidebarRows` (whose order AgentListLogicTests pins): an
        // if/else or a second ForEach under the section is the row shape the outline list's reload aborted on.
        let rows = try slice(sidebar, from: "private func workspaceRows(", to: "private func setUpRow(")
        try assertInOrder(rows, ["ForEach(AgentListLogic.sidebarRows(agents?.orderedItems ?? [], machines: agents?.machinesToSetUp ?? []))",
                                 "case .agent(let agent):", "case .setUp(let machine):", "setUpRow(machine, separates:",
                                 ".tag(SidebarSelection.machine(machine.id))", "case .placeholder:"],
                          "the workspaces, then the machines to set up")
        XCTAssertEqual(rows.components(separatedBy: "ForEach(").count - 1, 1, "one ForEach under the section")
        XCTAssertFalse(rows.contains("} else {"), "no if/else swapping the placeholder for the rows")
        let row = try slice(main, from: "private func setUpRow(_ machine: MachineToSetUp, separates: Bool) -> some View {", to: "\n    }\n")
        try assertInOrder(row, ["model.machineDraftRunnerID == machine.id ? AnyShapeStyle(.primary) : AnyShapeStyle(Color.accentColor)",
                                "MachineSetupCopy.setupTitle(machine: machine.name)",
                                "Image(systemName: machine.isManaged ? \"cloud\" : \"folder.badge.plus\")"],
                          "tinted, until it is the row selected")
        // The selection is ONE stored value; its actions run in `.onChange`, after the List's update.
        XCTAssertTrue(main.contains("SidebarLogic.selection(section: model.selectedSection, agentID: model.selectedAgentID,"),
                      "the stored value reads the page on screen")
        let onChange = try slice(main, from: ".onChange(of: selection) { _, now in", to: ".onChange(of: modelSelection")
        try assertInOrder(onChange, ["case .machine(let runnerID):", "model.openMachineDraft(runnerID)"],
                          "the machine row's one action")
        XCTAssertTrue(main.contains(".onChange(of: modelSelection, initial: true)"),
                      "a deep link or shortcut brings the list's stored value along")
    }

    /// The page is the same one on every shell.
    func testEveryShellDrawsTheSamePage() throws {
        let shell = try app("Views/CompactShell.swift")
        XCTAssertTrue(shell.contains("case .machineDraft(let runnerID):\n                                MachineDraftPage(runnerID: runnerID)"),
                      "the phone's stack")
        let detail = try slice(try app("Views/AgentsView.swift"), from: "struct AgentConsoleDetail: View {", to: "NewSessionView(agent: agent")
        try assertInOrder(detail, ["if let runnerID = app.machineDraftRunnerID {", "MachineDraftPage(runnerID: runnerID)"],
                          "the wide shells' detail pane, before any draft")
    }

    // MARK: New session, ⌘N and File ▸ New Session

    /// Grey only while the workspace list can't say: with no workspace they lead to the machine.
    func testNewSessionIsNoLongerGreyWithNoWorkspace() throws {
        let shell = try app("Views/CompactShell.swift")
        let bar = try slice(shell, from: "private var actionBar: some View {", to: "private func pill(")
        XCTAssertTrue(bar.contains("let canCompose = model.newSessionTarget != nil"))
        XCTAssertFalse(bar.contains("Add a workspace to start a session"), "the sentence with no way to do it")
        XCTAssertTrue(bar.contains("New sessions need a connection to Orbit."), "a list that can't be read still says so")

        let menu = try app("OrbitApp.swift")
        let item = try slice(menu, from: "CommandGroup(replacing: .newItem) {", to: "}\n            CommandGroup(after: .newItem)")
        XCTAssertTrue(item.contains(".disabled(!model.signedIn || model.newSessionTarget == nil)"))
        XCTAssertFalse(item.contains("orderedAgents.isEmpty"))

        let model = try app("AppModel.swift")
        let target = try slice(model, from: "private func newSessionWithNoWorkspace() {", to: "\n    }\n")
        try assertInOrder(target, ["case .machine(let id)?: openMachineDraft(id)", "case .machines?:", "selectedSection = .runners"],
                          "with no workspace, the first online machine, else Machines & models")
    }

    /// Rule 11, and the one-shot landing's own door.
    func testAnEmptyAccountLandsOnItsFirstOnlineMachine() throws {
        let model = try app("AppModel.swift")
        let landing = try slice(model, from: "private func resolveDefaultLanding() {", to: "provisionalLandingAgentID = nil\n    }")
        XCTAssertTrue(landing.contains("firstOnlineMachine: agents.firstOnlineMachine"))
        XCTAssertTrue(landing.contains("case .machine(let id): openMachineDraft(id)"))
    }

    // MARK: Create workspace (owner 2026-11-16, docs/mocks/new-folder-in-home/workspace-card-with-name)

    /// The page is the card alone: no composer under it, no message waiting there, no sign-in on it.
    func testThePageIsTheCardAlone() throws {
        let page = try app("Views/MachineSetupCard.swift")
        let content = try slice(page, from: "private struct MachineDraftContent: View {", to: "private struct MachineSetupCard: View {")
        XCTAssertTrue(content.contains("MachineSetupCard(setup: setup, welcome: welcome, addsWorkspace: addsWorkspace)"))
        for gone in ["ComposerView", "ComposerBand", "HeldFirstMessageView", "WelcomeExamplesStep"] {
            XCTAssertFalse(content.contains(gone), "the page still draws \(gone)")
        }
        for gone in ["RunnerSignInView", "SETUP_USE_FOLDER", "SETUP_FOOT", "setupReady(", "HeldMessage", "SETUP_CHANGE"] {
            XCTAssertFalse(page.contains(gone), "the card still has \(gone)")
        }
        let console = try app("ConsoleModel.swift")
        XCTAssertFalse(console.contains("machineSetup"), "a composer's send no longer asks a card")
        let request = try slice(console, from: "private func draftRequest(", to: "private func draftSessionCreated(")
        XCTAssertFalse(request.contains("newWorkspace"), "no session makes its workspace from these clients")
    }

    /// Create workspace makes the workspace alone, then the page moves on to its new session page; a refusal
    /// stays on the card.
    func testCreateWorkspaceMakesItAloneAndMovesOn() throws {
        let model = try app("AppModel.swift")
        let create = try slice(model, from: "func createMachineWorkspace(", to: "func machineGotWorkspace(")
        try assertInOrder(create, ["api.createAgent(MachineSetup.createRequest(folder: folder, name: name,",
                                   "await agents?.load()",
                                   "if machineDraftRunnerID == runnerID { show(.compose(agentID: made.id, folderID: nil), agent: made.id) }",
                                   "return nil", "return APIClient.failureReason(error)"],
                          "the create, the list, the new session page")
        let setup = try app("MachineSetupModel.swift")
        let press = try slice(setup, from: "func create(", to: "\n    }\n")
        try assertInOrder(press, ["guard !creating else { return }", "creating = true", "createError = nil",
                                  "await app.createMachineWorkspace(runnerID: runnerID, folder: pick,",
                                  "name: name.name(folder: followed))", "creating = false", "createError = why"],
                          "one at a time, and a refusal kept")
        XCTAssertTrue(setup.contains("var busy: Bool { creating }"), "the page doesn't move on under a create still out")
    }

    // MARK: the card while its machine connects, and the folder questions

    /// A machine approved a moment ago is waited for, not called too old, and read more often until it beats.
    func testTheCardWaitsForAMachineStillConnectingAndReadsItMoreOften() throws {
        let page = try app("Views/MachineSetupCard.swift")
        let notice = try slice(page, from: "private var notice: String? {", to: "private func noticeLine(")
        try assertInOrder(notice, ["if offline {", "MachineSetup.isConnecting(runner) ? MachineSetupCopy.setupConnectingCreate(machine: machine)",
                                   ": MachineSetupCopy.setupOfflineCreate(machine: machine)", "guard !checksFolders else { return nil }",
                                   "MachineSetupCopy.setupUpdatingCreate(machine: machine)",
                                   "MachineSetupCopy.setupNeedsUpdate(machine: machine)"],
                          "connecting before offline, and only a machine that is here is said to update itself")
        let loop = try slice(page, from: ".task(id: runnerID) {", to: ".onChange(of: runner, initial: true)")
        XCTAssertTrue(loop.contains("await VisibilityGate.app.pause(MachineSetup.refreshSeconds(for: runner))"),
                      "its own beat, and none while the app cannot be seen")
        XCTAssertFalse(loop.contains(".seconds(5)"), "a fixed beat would hold a connecting machine's folder step back")
    }

    /// The folder is one name in the machine's home: asked about where it would go, and made into the workspace's
    /// folder on the answer. The name follows it until it is edited, and Create workspace stands beside the name.
    func testTheCardIsAFolderAndANameAskedAboutWhereItWouldGo() throws {
        let page = try app("Views/MachineSetupCard.swift")
        let card = try slice(page, from: "private struct MachineSetupCard: View {", to: "private func noAnswer(again:")
        XCTAssertTrue(card.contains("private var root: String { MachineSetup.setupFolderRoot(runner, managedState: managedState) }"))
        XCTAssertTrue(card.contains("private var disabled: Bool { managedState == nil && (offline || !checksFolders) }"),
                      "a machine that can't make a folder can't be typed into")
        XCTAssertTrue(card.contains("MachineSetup.folderQuestion(folder: folder, root: root, canAsk: managedState == nil && !disabled)"),
                      "a name's question, or a full path's as typed")
        try assertInOrder(card, ["guard let answer, let question, answer.path == question else { return nil }",
                                 "case .answered(let probe)? = current",
                                 "MachineSetup.typedPick(folder: folder, found: found, root: root, machine: machine, managedState: managedState)",
                                 "MachineSetup.canCreate(pick: candidate, name: setup.name.name(folder: followed), online: !offline,"],
                          "the folder is picked on the machine's answer to this name")
        try assertInOrder(card, [".task(id: Question(path: question, attempt: attempt)) {",
                                 "await app.probeDir(runnerID: runner.id, path: asked, ask: true)",
                                 "if !fullPath {", "Text(MachineSetup.newFolderPath(root: root, name: \"\"))",
                                 ".onSubmit { create() }", ".accessibilityLabel(MachineSetupCopy.SETUP_FOLDER)",
                                 ".disabled(disabled || setup.creating)",
                                 "MachineSetup.folderLine(folder: folder, createError: setup.createError, found: found,",
                                 "noAnswer { attempt += 1 }"],
                          "the field after its fixed root, and what it says")
        try assertInOrder(card, ["Text(MachineSetupCopy.SETUP_NAME)", "WorkspaceNameField.placeholder(folder: followed)",
                                 "setup.name.shown(folder: followed)", "setup.name.edit($0, folder: followed)",
                                 ".onSubmit { create() }", ".accessibilityLabel(MachineSetupCopy.SETUP_NAME)",
                                 ".disabled((fromGithub ? offline : disabled) || setup.creating)", "Button(action: create)",
                                 "if setup.creating { ProgressView()", "Text(MachineSetupCopy.SETUP_CREATE)",
                                 ".disabled(!canCreate)", "setup.name.line(folder: followed)"],
                          "the name, with Create workspace beside it")
        for gone in ["SETUP_REGISTER_DIR", "setupOtherFolder", "FolderChoice", "registerDir", "FolderName("] {
            XCTAssertFalse(page.contains(gone), "the card still has \(gone)")
        }
    }

    /// Board 04 A on the one-field card: under the folder and its Name, an "or" rule and the From GitHub row, locked only
    /// offline; pressing it swaps the folder field for the repository picker, whose pick the Name follows and Create
    /// workspace sends; "Type a folder name instead" swaps back. Which is open is kept with the page.
    func testFromGithubIsARowUnderTheNameThatSwapsTheFolderFieldForThePicker() throws {
        let page = try app("Views/MachineSetupCard.swift")
        XCTAssertTrue(page.contains("private var github: GithubIntegration? { app.github?.available == true ? app.github : nil }"),
                      "offered only where the deployment has a GitHub App")
        let card = try slice(page, from: "private struct MachineSetupCard: View {", to: "private func noAnswer(again:")
        try assertInOrder(card, ["if fromGithub { return setup.repository }", "checksFolders: fromGithub || checksFolders"],
                          "the picked repository is what Create workspace makes, locked only offline")
        try assertInOrder(card, ["if let github, setup.githubOpen { githubField(github) } else { folderField }", "nameField",
                                 "if github != nil, !setup.githubOpen {", "githubRow"],
                          "the picker in the folder field's place, and the row under the Name")
        let row = try slice(card, from: "@ViewBuilder private var githubRow: some View {", to: "private func githubField(")
        try assertInOrder(row, ["MachineSetupCopy.SETUP_OR", "setup.githubOpen = true", "MachineSetupCopy.SETUP_FROM_GITHUB",
                                "SetupNewTag()", "MachineSetupCopy.SETUP_GITHUB_META", ".disabled(offline || setup.creating)"],
                          "the or rule, then the row")
        let field = try slice(card, from: "private func githubField(", to: "private func noAnswer(again:")
        try assertInOrder(field, ["MachineSetupCopy.SETUP_FOLDER", "MachineSetupCopy.SETUP_FROM_GITHUB", "SetupNewTag()",
                                  "GithubFolderOption(runner: runner, integration: integration,",
                                  "onCandidate: { setup.repository = $0 }, onEnter: { create() })",
                                  "MachineSetupCopy.setupGithubDonePath(", "MachineSetupCopy.SETUP_GITHUB_DONE",
                                  "MachineSetupCopy.SETUP_FOLDER_NAME_INSTEAD", "setup.githubOpen = false", "setup.repository = nil"],
                          "the picker, what it makes, and the way back")
        XCTAssertFalse(page.contains("SETUP_USE_REPOSITORY"), "Create workspace sends the clone: no Use button of its own")
        let model = try app("MachineSetupModel.swift")
        XCTAssertTrue(model.contains("var githubOpen = false"), "kept with the page, so GitHub's sign-in comes back to it")
        try assertInOrder(model, ["var followed: String {", "if case .github(let pick)? = repository { return pick.name }",
                                  "name: name.name(folder: followed)"], "the Name follows the picked repository's folder")
    }

    // MARK: New workspace on a machine that has one (docs/mocks/new-workspace-form/02-apple-entry, owner A)

    /// The + on the Workspaces group, in the phone's drawer and the Mac's sidebar, and a row at the end of the machine
    /// page's Workspaces: all three open the machine's page as New workspace.
    func testNewWorkspaceIsTheGroupsPlusAndTheMachinePagesRow() throws {
        let drawer = try slice(try app("Views/CompactShell.swift"), from: "private var workspacesHeader: some View {", to: "\n    }\n")
        try assertInOrder(drawer, ["Text(AppSection.agents.title)",
                                   "NewWorkspaceButton(machines: model.agents?.newWorkspaceMachines ?? []) { runnerID in",
                                   "model.openNewWorkspace(runnerID)", "close()"], "the drawer's +")
        let sidebar = try slice(try app("Views/MainView.swift"), from: "Section(isExpanded: $workspacesExpanded) {", to: "if !projects.isEmpty {")
        try assertInOrder(sidebar, ["workspaceRows(", "} header: {", "Text(AppSection.agents.title)",
                                    "NewWorkspaceButton(machines: model.agents?.newWorkspaceMachines ?? []) { model.openNewWorkspace($0) }"],
                          "the sidebar's +")
        let page = try slice(try app("Views/SkillsRunnersView.swift"), from: "private func workspacesSection(", to: "} header: {")
        try assertInOrder(page, ["ForEach(workspaces)", "if !workspaces.isEmpty {", "Button { newWorkspace() }",
                                 "NewWorkspaceCopy.NEW_WORKSPACE"], "the machine page's row, after its workspaces")
        XCTAssertTrue(try app("Views/SkillsRunnersView.swift").contains("model.openNewWorkspace(runner.id)"))
        let button = try app("Views/NewWorkspaceButton.swift")
        try assertInOrder(button, ["if machines.count == 1, let only = machines.first {", "open(only.id)", "Menu {",
                                   "NewWorkspaceCopy.NEW_WORKSPACE_ON", "ForEach(machines)", "open(machine.id)"],
                          "one machine goes straight to its page, more are a menu")
    }

    /// The page opened as New workspace makes one more: it doesn't move on to the first, its hint says a full path,
    /// the phone's card has no head under a title bar naming the machine, and Create opens the new workspace.
    func testThePageOpenedAsNewWorkspaceMakesOneMore() throws {
        let model = try app("AppModel.swift")
        let open = try slice(model, from: "func openNewWorkspace(_ runnerID: String) {", to: "\n    }\n")
        try assertInOrder(open, ["settingsPresented = false", "if agents?.firstWorkspace(onRunner: runnerID) != nil {",
                                 "newWorkspaceRunners.insert(key)", "newWorkspaceRunners.remove(key)", "openMachineDraft(runnerID)"],
                          "a machine with a workspace is marked; one without gets its Set up page")
        let moved = try slice(model, from: "func machineGotWorkspace(", to: "\n    }\n")
        XCTAssertTrue(moved.contains("!addsWorkspace(on: runnerID)"), "New workspace doesn't move on to the first")
        let page = try app("Views/MachineSetupCard.swift")
        XCTAssertTrue(page.contains("guard !addsWorkspace, app.agents?.firstWorkspace(onRunner: runnerID) != nil else { return false }"))
        XCTAssertTrue(page.contains("Text(addsWorkspace ? NewWorkspaceCopy.NEW_WORKSPACE : MachineSetupCopy.SETUP_PAGE_TITLE)"))
        XCTAssertTrue(page.contains("pathHintRoot: addsWorkspace ? root : nil"))
        try assertInOrder(page, ["private var headless: Bool {", "#if os(iOS)", "addsWorkspace", "#else", "false"],
                          "headless only under the phone's title bar")
        XCTAssertTrue(page.contains("if welcome { WelcomeHead() } else if !headless { head }"))
    }

    // MARK: the line a created workspace opens with

    func testTheConversationOpensWithWhatItMade() throws {
        let view = try app("Views/Console/ConsoleView.swift")
        XCTAssertTrue(view.contains("createdWorkspace: console.createdWorkspaceLine,"))
        XCTAssertTrue(view.contains("case .createdWorkspace(let line):\n            CreatedWorkspaceLineView(line: line, console: console)"))
        let model = try app("ConsoleModel.swift")
        XCTAssertTrue(model.contains("if session.createdWorkspace == true {\n            madeWorkspace = session.agent\n            madeWorkspaceReadAt = Date()"),
                      "only the detail moves it: a list row's nil says nothing; when it was read weighs a clone frame against it")
        let line = try slice(try app("Views/MachineSetupCard.swift"), from: "struct CreatedWorkspaceLineView: View {", to: "private var made: AttributedString")
        try assertInOrder(line, ["if line.live {", "MachineSetupCopy.CREATED_RENAME", "MachineSetupCopy.CREATED_SETTINGS"],
                          "Rename and Settings, while there is a workspace to change")
        XCTAssertTrue(line.contains("AgentSettingsSheet(agents: agents, agent: agent)"))
    }

    // MARK: rule 12

    /// Add Runner's next step is the same as the machine page's: a session.
    func testNothingSendsAnyoneToTheWeb() throws {
        for file in ["Views/SkillsRunnersView.swift", "Views/CompactShell.swift", "Views/MachineSetupCard.swift"] {
            XCTAssertFalse(try app(file).contains("RUNNER_WORKSPACES_FOOTER"), "\(file) still says on the web")
        }
    }

    /// The page reads the machine again while it is up, on both platforms.
    func testTheRunnerRowsStayCurrentOnEveryPlatform() throws {
        let model = try app("AppModel.swift")
        let poll = try slice(model, from: "private func pollFloors() async {", to: "refreshFocusedSessionDetailIfNeeded()")
        XCTAssertTrue(poll.contains("await refreshRunnerSnapshotIfDue()"))
        XCTAssertFalse(poll.contains("#if os(iOS)"), "a Mac's Set up row comes and goes too")
    }

    /// Reset with the account: what one owner left isn't the next one's.
    func testTheSetupStateLeavesWithTheAccount() throws {
        let model = try app("AppModel.swift")
        let logout = try slice(model, from: "func logout() {", to: "private func resetNavigation() {")
        XCTAssertTrue(logout.contains("machineSetups = [:]"))
        let configure = try slice(model, from: "private func configure(_ url: URL) {", to: "func logout() {")
        XCTAssertTrue(configure.contains("machineSetups = [:]"))
    }
}
