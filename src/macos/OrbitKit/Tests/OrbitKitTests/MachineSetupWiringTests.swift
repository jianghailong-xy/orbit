import Foundation
import XCTest

/// SwiftUI doesn't exist on Linux, so nothing here compiles the app shells. These hold a machine's first
/// workspace to the source: which entries lead to the machine's new session page, what a composer's send
/// does there, and that nothing is left greyed out or sending anyone to the web. The behaviour is
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
        try assertInOrder(rows, ["ForEach(agents.orderedItems)", "ForEach(agents.machinesToSetUp)", "setUpRow(machine)"],
                          "the Set up rows come last")
        try assertInOrder(rows, ["model.drawerDestination == .machine(runnerID: machine.id)",
                                 "open(.machine(runnerID: machine.id))", "Image(systemName: \"folder.badge.plus\")",
                                 "MachineSetupCopy.setupTitle(machine: machine.name)", ".foregroundStyle(Color.accentColor)"],
                          "the row is board 03's")
    }

    /// The Mac: the drawer's flat order, the Set up rows after every workspace, selected through the
    /// source list's one selection (docs/mocks/macos-sidebar, 01).
    func testTheMacsSidebarListsTheSetUpRowsLast() throws {
        let main = try app("Views/MainView.swift")
        let sidebar = try slice(main, from: "private func workspaceRows(", to: "struct AccountFooter")
        try assertInOrder(sidebar, ["ForEach(agents.orderedItems)", "ForEach(agents.machinesToSetUp)", "setUpRow(machine)",
                                    ".tag(SidebarSelection.machine(machine.id))"],
                          "the workspaces, then the machines to set up")
        let row = try slice(main, from: "private func setUpRow(_ machine: MachineToSetUp) -> some View {", to: "\n    }\n")
        try assertInOrder(row, ["model.machineDraftRunnerID == machine.id ? AnyShapeStyle(.primary) : AnyShapeStyle(Color.accentColor)",
                                "MachineSetupCopy.setupTitle(machine: machine.name)", "Image(systemName: \"folder.badge.plus\")"],
                          "tinted, until it is the row selected")
        XCTAssertTrue(main.contains("if let runnerID = model.machineDraftRunnerID { return .machine(runnerID) }"),
                      "the selection reads the page on screen")
        XCTAssertTrue(main.contains("case .machine(let runnerID):\n                    model.openMachineDraft(runnerID)"))
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

    // MARK: what a send does

    func testTheComposersSendAsksTheCardFirst() throws {
        let model = try app("ConsoleModel.swift")
        let create = try slice(model, from: "private func createDraftSession() async {", to: "func sendHeld(")
        try assertInOrder(create, ["switch machineSetup.composerSend() {", "case .alreadyWaiting:", "case .hold:",
                                   "machineSetup.hold(heldMessage(text, shell: shell))", "composerText = \"\"",
                                   "pendingAttachments = []", "return", "case .create(let folder):", "newWorkspace = folder",
                                   "api.createSession(draftRequest("],
                          "the composer's send on a machine's page")
        let request = try slice(model, from: "private func draftRequest(", to: "private func draftSessionCreated(")
        for piece in ["agentId: newWorkspace == nil ? agent.id : nil", "assignedRunnerId: newWorkspace == nil ? nil : agent.runnerId",
                      "engine: newWorkspace == nil ? draftPick?.engine : engine",
                      "provider: newWorkspace == nil ? draftPick?.provider : provider", "newWorkspace: newWorkspace)"] {
            XCTAssertTrue(request.contains(piece), "the create lost \(piece)")
        }
    }

    // MARK: the card while its machine connects, and the folder questions

    /// A machine approved a moment ago is waited for, not called too old, and read more often until it beats.
    func testTheCardWaitsForAMachineStillConnectingAndReadsItMoreOften() throws {
        let page = try app("Views/MachineSetupCard.swift")
        let notice = try slice(page, from: "private var notice: String? {", to: "private func noticeLine(")
        try assertInOrder(notice, ["if offline {", "MachineSetup.isConnecting(runner) ? MachineSetupCopy.setupConnecting(machine: machine)",
                                   ": MachineSetupCopy.setupOffline(machine: machine)", "guard !probes else { return nil }",
                                   "MachineSetupCopy.setupUpdating(machine: machine)"],
                          "connecting before offline, and only a machine that is here is said to update itself")
        let loop = try slice(page, from: ".task(id: runnerID) {", to: ".onChange(of: runner, initial: true)")
        XCTAssertTrue(loop.contains("try? await Task.sleep(for: .seconds(MachineSetup.refreshSeconds(for: runner)))"))
        XCTAssertFalse(loop.contains(".seconds(5)"), "a fixed beat would hold a connecting machine's folder step back")
    }

    /// A new folder's name is asked about where it would go, and the register directory's question, taken by
    /// another, is asked again.
    func testTheFolderQuestionsShareTheMachinesOneSlot() throws {
        let page = try app("Views/MachineSetupCard.swift")
        let options = try slice(page, from: "private struct FolderOptions: View {", to: "private func row(")
        try assertInOrder(options, ["case .new:", "case .answered(let probe)? = newAnswer",
                                    "MachineSetup.newFolderPick(probe, name: name, reposRoot: runner.reposRoot ?? \"\", machine: machine)"],
                          "a new folder is picked on the machine's answer")
        XCTAssertTrue(options.contains("return MachineSetup.newFolderPath(reposRoot: runner.reposRoot ?? \"\", name: name)"))
        try assertInOrder(options, ["attempt: online ? 1 + registerAttempt : 0)) {",
                                    ".onChange(of: DirProbeRelay.asksAgain(registered, online: online, otherWaiting: waiting)) { _, again in",
                                    "if again { registerAttempt += 1 }",
                                    ".task(id: Question(path: newFolderQuestion, attempt: newAttempt)) {",
                                    "await app.probeDir(runnerID: runner.id, path: asked, ask: true)"],
                          "the register question asked again, and the name's own")
        let line = try slice(page, from: "@ViewBuilder private var newFolderLine: some View {", to: "private var otherRow: some View {")
        try assertInOrder(line, ["MachineSetupCopy.SETUP_NEW_FOLDER_INVALID", "MachineSetup.newFolderVerdict(probe, machine: machine)",
                                 "noAnswer { newAttempt += 1 }", "checking"],
                          "what the name says as it is checked")
    }

    func testTheWaitingMessageGoesByItselfAndARefusalStaysOnIt() throws {
        let page = try app("Views/MachineSetupCard.swift")
        try assertInOrder(page, [".onChange(of: Send(ready: ready, held: setup.state.held, busy: draft.sending), initial: true)",
                                 "setup.sendHeldIfReady()"], "both steps done, it goes")
        let model = try app("MachineSetupModel.swift")
        let send = try slice(model, from: "func sendHeldIfReady() {", to: "func retryHeld()")
        try assertInOrder(send, ["state.takeHeldToSend(ready: ready, busy: draft.sending)", "await draft.sendHeld(message, folder: folder)",
                                 "state.failHeld(why)"], "once, and a refusal stays")
    }

    // MARK: the line a created workspace opens with

    func testTheConversationOpensWithWhatItMade() throws {
        let view = try app("Views/Console/ConsoleView.swift")
        XCTAssertTrue(view.contains("createdWorkspace: console.createdWorkspaceLine)"))
        XCTAssertTrue(view.contains("case .createdWorkspace(let line):\n            CreatedWorkspaceLineView(line: line, console: console)"))
        let model = try app("ConsoleModel.swift")
        XCTAssertTrue(model.contains("if session.createdWorkspace == true { madeWorkspace = session.agent }"),
                      "only the detail moves it: a list row's nil says nothing")
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
