import Foundation
import XCTest

/// SwiftUI doesn't exist on Linux, so nothing here compiles the app shells. These hold the Runners
/// list and a runner's pages to the effect mocks they were built from (ios-list.png, ios-detail.png)
/// by reading the source they now *are*: a row whose label is the label colour and which pushes by
/// hand, Add Runner and Edit wired under the rows, the page's sections in the mocks' order, the engine
/// and name pages one push away on whichever stack the record rides — and every word and rule taken
/// from OrbitKit (`RunnerAttention`, `RunnerPageCopy`, `RunnerPageFormat`), where it is tested.
/// Each check reads the slice of the file it is about, so a match somewhere else can't pass it.
final class RunnersPageWiringTests: XCTestCase {
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

    /// Each of `pieces` is in `text`, in this order.
    private func assertInOrder(_ text: String, _ pieces: [String], _ what: String,
                               file: StaticString = #filePath, line: UInt = #line) throws {
        var from = text.startIndex
        for piece in pieces {
            let found = try XCTUnwrap(text.range(of: piece, range: from..<text.endIndex),
                                      "\(what): `\(piece)` is missing or out of order", file: file, line: line)
            from = found.upperBound
        }
    }

    private static let runnersFile = "Views/SkillsRunnersView.swift"
    /// Every file a runner's list and pages are drawn from.
    private static let pageFiles = [runnersFile, "Views/RunnerPageParts.swift", "Views/RunnerEnginePage.swift",
                                    "Views/RunnerNamePage.swift", "Views/AddRunnerSheet.swift"]

    private func runners() throws -> String { try appSource(Self.runnersFile) }

    /// Settings' runners list, and the Runners section's pushing row.
    private func lists() throws -> [(name: String, code: String)] {
        let text = try runners()
        return [
            ("Settings' list", code(try slice(text, from: "struct RunnersSettingsList: View {",
                                               to: "/// How a `RunnersModel` list shows its load outcome"))),
            ("the Runners section", code(try slice(text, from: "struct RunnersListView: View {", to: "#if os(iOS)"))),
        ]
    }

    private func detail() throws -> String {
        code(try slice(try runners(), from: "struct RunnerDetailContent: View {", to: "// MARK: presses"))
    }

    // MARK: the list (ios-list.png)

    /// ① A `Button` row hands its label the tint, and inside one `.primary` resolves to the tint too
    /// (the owner's phone: title in the tint, subtitle at half of it) — so the label says
    /// `Color.primary`, and the row still pushes through `AppModel.push`, never a link.
    func testARowsLabelIsTheLabelColourAndItPushesByHand() throws {
        for list in try lists() {
            XCTAssertTrue(list.code.contains("Button { model.push(.runnerDetail(runnerID: r.id)) } label: {"),
                          "\(list.name): the row carries its destination and pushes it by hand")
            XCTAssertTrue(list.code.contains(".foregroundStyle(Color.primary)"),
                          "\(list.name): the label is the label colour")
            XCTAssertFalse(list.code.contains(".foregroundStyle(.primary)"),
                           "\(list.name): `.primary` in a button's label is the tint")
        }
    }

    /// One push mechanism per stack (scripts/ci/nav-push-gate.sh): nothing a runner's list or pages
    /// draw is a link.
    func testNoRunnerPageDrawsANavigationLink() throws {
        for file in Self.pageFiles {
            XCTAssertFalse(code(try appSource(file)).contains("NavigationLink"),
                           "\(file) draws a NavigationLink — push a NavNode through AppModel.push")
        }
    }

    /// ②–⑤ Dot, name, `N/M` and its bar, the second line, and the third line only when something needs
    /// a person — every word of it `RunnerAttention`'s.
    func testTheRowIsTheMocksRow() throws {
        let row = code(try slice(try runners(), from: "struct RunnerRow: View {", to: "struct RunnerDetailView: View {"))
        for piece in ["RunnerStatusDot(presence: RunnerPageFormat.presence(runner, now: now))",
                      "if let slots = RunnerPageFormat.slots(runner, now: now) {",
                      "RunnerSlotBar(slots: slots)",
                      "Text(RunnerAttention.runnerListSubtitle(runner, nowMs: nowMs))",
                      "if let line = RunnerAttention.listAttentionLine(items) {",
                      "Image(systemName: \"exclamationmark.triangle.fill\")",
                      "RunnerInk.attention(RunnerPageFormat.listTone(items) ?? .warn)",
                      "RunnerChevron()"] {
            XCTAssertTrue(row.contains(piece), "the row lost \(piece)")
        }
        let bar = code(try slice(try appSource("Views/RunnerPageParts.swift"),
                                 from: "struct RunnerSlotBar: View {", to: "/// The disclosure a pushing row draws"))
        XCTAssertTrue(bar.contains(".frame(width: 44)"), "the web card's 44pt slot bar")
        XCTAssertTrue(bar.contains("slots.full ? RunnerInk.full : Color.accentColor"), "amber once every slot is taken")
    }

    /// ⑥ Add Runner is the list's last card, with its footer, and opens the sheet — which is where
    /// adding a machine lives now, not a runner's own page.
    func testAddRunnerIsTheListsLastCardAndOpensItsSheet() throws {
        let text = try runners()
        for list in try lists() {
            XCTAssertTrue(list.code.contains("RunnerAddSection { addingRunner = true }"),
                          "\(list.name) has Add Runner under its rows")
        }
        let card = code(try slice(text, from: "private struct RunnerAddSection: View {",
                                  to: "private struct RunnerListEditing: ViewModifier {"))
        XCTAssertTrue(card.contains("Button(RunnerPageCopy.RUNNER_ADD, action: add)"))
        XCTAssertTrue(card.contains("Text(RunnerPageCopy.RUNNER_ADD_FOOTER)"))
        let editing = code(try slice(text, from: "private struct RunnerListEditing: ViewModifier {",
                                     to: "/// A drag in Edit"))
        XCTAssertTrue(editing.contains(".sheet(isPresented: $addingRunner) { AddRunnerSheet() }"))

        let everything = code(text) + code(try appSource("RunnersModel.swift"))
        XCTAssertFalse(everything.contains("Create enrollment token"), "the old enrollment button is gone")
        XCTAssertFalse(everything.contains("createEnrollmentToken"), "and so is what it called")
    }

    /// ⑨ The sheet: the web guide's command from this instance's origin, to copy or share; the web
    /// guide's wait on the list; and a machine with no browser approved by its code, after its name
    /// and hostname show.
    func testTheAddRunnerSheetInstallsWaitsAndApproves() throws {
        let sheet = code(try appSource("Views/AddRunnerSheet.swift"))
        for piece in ["RunnerPageFormat.installCommand(platform, origin: model.baseURL.map(RunnerPageFormat.origin)",
                      "ForEach(RunnerPageFormat.Platform.allCases)",
                      ".pickerStyle(.segmented)",
                      "PlatformPasteboard.copyString(command)",
                      "SwiftUI.ShareLink(item: command)",
                      "Text(RunnerPageCopy.RUNNER_WAITING_FOR_NEW)",
                      "arrived = RunnerPageFormat.newlyOnline(runners.runners, baseline: baseline)",
                      "try? await Task.sleep(for: .seconds(5))",
                      "model.push(.runnerDetail(runnerID: runner.id))",
                      "RunnerSectionHeader(RunnerPageCopy.RUNNER_NO_BROWSER)",
                      "TextField(RunnerPageCopy.RUNNER_DEVICE_CODE_PLACEHOLDER, text: $code)",
                      "RunnerPageFormat.deviceCode(typed)",
                      "let result = await runners.device(userCode)",
                      "LabeledContent(RunnerPageCopy.RUNNER_ABOUT_HOSTNAME, value: host)",
                      "if device.nameConflict == true {",
                      "let failure = await runners.approveDevice(userCode)"] {
            XCTAssertTrue(sheet.contains(piece), "the sheet lost \(piece)")
        }
        try assertInOrder(sheet, ["commandSection", "waitSection", "deviceSection"], "the sheet's order")
        let model = code(try appSource("RunnersModel.swift"))
        XCTAssertTrue(model.contains("api.deviceEnrollment(userCode: userCode)"))
        XCTAssertTrue(model.contains("self.api.approveDevice(userCode: userCode)"))
    }

    /// ⑦ Edit: the list's own move and delete, a move saved as the web list's drag order is, and a
    /// delete that asks first.
    func testEditReordersAndRemovesAfterAsking() throws {
        let text = try runners()
        for list in try lists() {
            XCTAssertTrue(list.code.contains(".onMove { moveRunners(runners, from: $0, to: $1) }"), list.name)
            XCTAssertTrue(list.code.contains(".onDelete { pendingRemoval = runnerToRemove(runners, at: $0) }"),
                          "\(list.name): a delete only names the runner to ask about")
            XCTAssertTrue(list.code.contains(".modifier(RunnerListEditing("), list.name)
        }
        let editing = try slice(text, from: "private struct RunnerListEditing: ViewModifier {", to: "/// A drag in Edit")
        try assertInOrder(editing, ["#if os(iOS)", "ToolbarItem(placement: .topBarTrailing) { EditButton() }", "#endif"],
                          "Edit is iOS's")
        let asked = code(editing)
        XCTAssertTrue(asked.contains(".confirmationDialog(removalTitle, isPresented: removalAsked"))
        XCTAssertTrue(asked.contains("Text(RunnerPageCopy.RUNNER_REMOVE_FOOTER)"))
        XCTAssertTrue(asked.contains("await runners.delete(runner.id)"))
        let move = code(try slice(text, from: "@MainActor private func moveRunners(", to: "/// The row a delete"))
        XCTAssertTrue(move.contains("order.move(fromOffsets: source, toOffset: destination)"))
        XCTAssertTrue(move.contains("await runners.reorder(ids)"))
        XCTAssertTrue(code(try appSource("RunnersModel.swift")).contains("runners = try await api.reorderRunners(ids)"))
    }

    // MARK: a runner's page (ios-detail.png)

    /// The questions in the order they come: head → Needs Attention (only when there is something)
    /// → Capacity → Engines → Workspaces → About → Rotate Token… → Remove Runner.
    func testTheSectionsComeInTheMocksOrder() throws {
        let page = try detail()
        let body = try slice(page, from: "Form {", to: ".formStyle(.grouped)")
        try assertInOrder(body, ["head(now: now)", "if !items.isEmpty {", "attentionSection(items, now: now)",
                                 "capacitySection(workspaces)", "enginesSection(offline: offline, now: now)",
                                 "workspacesSection(workspaces)", "aboutSection(now: now)", "rotateSection",
                                 "removeSection"], "the page's sections")
        let sections = try slice(page, from: "private func head(now: Date) -> some View {", to: "private func statusLine(")
        try assertInOrder(sections, ["RunnerSectionHeader(RunnerPageCopy.RUNNER_NEEDS_ATTENTION)",
                                     "RunnerSectionHeader(RunnerPageCopy.RUNNER_CAPACITY)",
                                     "RunnerSectionHeader(RunnerPageCopy.RUNNER_ENGINES,",
                                     "RunnerSectionHeader(RunnerPageCopy.RUNNER_WORKSPACES,",
                                     "RunnerSectionHeader(RunnerPageCopy.RUNNER_ABOUT)",
                                     "Button(RunnerPageCopy.RUNNER_ROTATE_TOKEN)",
                                     "Text(RunnerPageCopy.RUNNER_REMOVE)"], "each section's header")
        XCTAssertTrue(page.contains(".formStyle(.grouped)"), "one grouped form, iOS and macOS alike")
    }

    /// ① The head: the machine with its status dot, the name, `Online · 4 of 12 running`, and the
    /// hostname and version — the Codex pool page's head, with a machine for its mark.
    func testTheHeadSaysWhereTheMachineStands() throws {
        let head = try slice(try detail(), from: "private func head(now: Date) -> some View {",
                             to: "private func attentionSection(")
        for piece in ["RunnerMachineTile(presence: RunnerPageFormat.presence(runner, now: now))",
                      "Text(statusLine(now: now))", "let host = RunnerPageFormat.hostLine(runner)",
                      ".listRowBackground(Color.clear)"] {
            XCTAssertTrue(head.contains(piece), "the head lost \(piece)")
        }
    }

    /// ② Needs Attention is `RunnerAttention`'s list, and each item's action is on it.
    func testNeedsAttentionIsTheRulesAndEachItemCarriesItsAction() throws {
        let page = try detail()
        XCTAssertTrue(page.contains("RunnerAttention.runnerAttention(runner: runner, workspaces: workspaces,"))
        let actions = try slice(page, from: "private func attentionButton(", to: "private func diskRow(")
        for action in ["case .signIn:", "case .repair:", "case .setReserve:", "case .copyCommand:", "case .updateEngines:"] {
            XCTAssertTrue(actions.contains(action), "no press for \(action)")
        }
        XCTAssertTrue(actions.contains("Button(RunnerPageCopy.RUNNER_SET_A_RESERVE) { choosingReserve = true }"),
                      "Set a Reserve… opens Keep Free's choices")
        XCTAssertTrue(actions.contains("Label(RunnerPageCopy.RUNNER_COPY_COMMAND, systemImage: \"doc.on.doc\")"))
        XCTAssertTrue(page.contains("RunnerPageFormat.attentionDetail(item, now: now)"),
                      "a quota's reset is said in the reader's time zone")
    }

    /// ③ Capacity saves as it changes: the stepper when the press lets go, Keep Free as it is picked —
    /// no Save button left.
    func testCapacitySavesAsItChanges() throws {
        let page = try detail()
        let capacity = try slice(page, from: "private func capacitySection(", to: "private func enginesSection(")
        for piece in ["Stepper(value: $maxConc, in: 1...64, onEditingChanged: steppingChanged)",
                      "if let disk = RunnerAttention.runnerDisk(workspaces) {",
                      "Picker(RunnerPageCopy.RUNNER_KEEP_FREE, selection: $keepFree)",
                      "RunnerPageFormat.keepFreeChoices(runner.minFreeDiskMb)", ".pickerStyle(.menu)",
                      "Text(RunnerPageCopy.RUNNER_CAPACITY_FOOTER)"] {
            XCTAssertTrue(capacity.contains(piece), "Capacity lost \(piece)")
        }
        let text = code(try runners())
        XCTAssertFalse(text.contains("Button(\"Save\")"), "the stepper saves on release, not on a button")
        XCTAssertTrue(text.contains("if !editing { saveMaxConcurrent(maxConc) }"))
        XCTAssertTrue(text.contains("await runners.setMaxConcurrent(id, value)"))
        XCTAssertTrue(text.contains("await runners.setKeepFree(id, value)"))
        XCTAssertTrue(code(try appSource("RunnersModel.swift")).contains("UpdateRunnerRequest(minFreeDiskMb: floor)"))
    }

    /// ④ Each engine the machine has installed opens its page; Update Engines Now and Refresh Model
    /// Lists act on all of them.
    func testTheEnginePageIsOnePushFromEachEngineRow() throws {
        let page = try detail()
        XCTAssertTrue(page.contains("Button { model.push(.runnerEngine(runnerID: runner.id, engine: health.engine)) } label: {"))
        XCTAssertTrue(page.contains("model.push(.runnerEngine(runnerID: runner.id, engine: action.engine ?? \"\"))"),
                      "a signed-out engine's Sign In goes to its page, where signing in lives")
        XCTAssertTrue(page.contains("Button(RunnerPageCopy.RUNNER_UPDATE_ENGINES_NOW) { updateEngines() }"))
        XCTAssertTrue(page.contains("Button(RunnerPageCopy.RUNNER_REFRESH_MODEL_LISTS) { refreshModels() }"))
        let model = code(try appSource("RunnersModel.swift"))
        XCTAssertTrue(model.contains("_ = try await self.api.startEngineUpdate(id)"))
        XCTAssertTrue(model.contains("_ = try await self.api.refreshRunnerModels(id)"))

        let row = code(try slice(try appSource("Views/RunnerPageParts.swift"),
                                 from: "struct RunnerEngineRow: View {", to: "struct RunnerWorkspaceRow: View {"))
        for piece in ["ProviderMark(provider: health.engine, size: 28", "RunnerPageFormat.engineStatus(health)",
                      "RunnerPageFormat.updateFailedLine(health, now: now)", "RunnerPageFormat.needsSignIn(health)",
                      "RunnerPageFormat.engineWindows(runner, engine: health.engine)",
                      "RunnerWindowRow(row: row, resets: RunnerPageFormat.resetsLine(row, now: now))"] {
            XCTAssertTrue(row.contains(piece), "the engine row lost \(piece)")
        }
    }

    /// The engine and name pages are frames of whichever stack the record rides — Settings' on iOS,
    /// the Runners section's in the compact shell — and fill the three-column pane in its place.
    func testTheRecordsOwnPagesAreFramesOnEveryStack() throws {
        let sheet = code(try appSource("Views/SettingsSheet.swift"))
        let compact = code(try slice(try appSource("Views/CompactShell.swift"), from: "case .runners:", to: "// FOLLOWING"))
        for (name, stack) in [("Settings", sheet), ("the compact Runners stack", compact)] {
            XCTAssertTrue(stack.contains("case .runnerEngine(let runnerID, let engine): RunnerEnginePage(runnerID: runnerID, engine: engine)"),
                          "\(name) renders the engine page")
            XCTAssertTrue(stack.contains("case .runnerName(let runnerID):   RunnerNamePage(runnerID: runnerID)"),
                          "\(name) renders the name page")
        }
        let pane = code(try slice(try runners(), from: "struct RunnerDetailView: View {", to: "struct RunnerDetailContent: View {"))
        XCTAssertTrue(pane.contains("switch runnerID == nil ? model.nav.path.last : nil {"),
                      "the three-column pane reads the page on top of the section's stack")
        XCTAssertTrue(pane.contains("case .runnerEngine(let id, let engine)?:"))
        XCTAssertTrue(pane.contains("case .runnerName(let id)?:"))
        XCTAssertTrue(pane.contains("Button { model.nav.pop() } label: {"), "with its own way back to the record")

        // Selecting a runner — a three-column row, a deep link — takes the old record's own pages off
        // before the record is replaced, so what lands is the new record alone.
        let select = code(try slice(try appSource("AppModel.swift"), from: "var selectedRunnerID: String? {",
                                    to: "var selectedWatchID: String? {"))
        try assertInOrder(select, ["nav.popRunnerPages()", "nav.replaceTop(with: .runnerDetail(runnerID: id))"],
                          "a new selection starts from the record")
    }

    /// The engine page: each account's own sign-in state and quota, signing in with `RunnerSignInView`
    /// for that account, Add Account under a name, an added account swiped off after asking — and
    /// nothing sent to a machine that is offline.
    func testTheEnginePageSignsInEachAccount() throws {
        let page = code(try appSource("Views/RunnerEnginePage.swift"))
        for piece in ["RunnerPageFormat.accountLines(health)",
                      "RunnerPageFormat.accountWindows(runner, engine: engine, account: line.id)",
                      "RunnerSignInView(runnerID: runner.id, engine: login, account: line.signInAccount)",
                      "Button(\"Add Account\")",
                      // The press starts the sign-in under a name the page picks; the name typed over it
                      // is saved as Rename… saves one, once the runner reports the account — and once
                      // that account is signed in and named, the card folds back into Add Account.
                      "newAccountPicked = RunnerPageFormat.defaultAccountName(accounts)",
                      "RunnerSignInView(runnerID: runner.id, engine: login, accountName: newAccountName, autoStart: true)",
                      ".focused($newAccountFocused)",
                      ".onSubmit { newAccountFocused = false }",
                      "if !focused { saveNewAccountName(health) }",
                      ".onDisappear { saveNewAccountName(health) }",
                      "await runners.renameAccount(id, engine: login, account: account.id, name: name)",
                      ".onChange(of: newAccountDone(health)) { _, done in",
                      "if done { closeSignIn() }",
                      "guard let added = newAccount(health), added.auth == \"yes\" else { return false }",
                      "return !newAccountFocused && newAccountWaiting == nil && !newAccountRenaming",
                      ".swipeActions(edge: .trailing, allowsFullSwipe: false) {",
                      "if !line.isDefault {",
                      "Button(role: .destructive) { pendingRemoval = line } label: {",
                      ".confirmationDialog(removalTitle, isPresented: removalAsked",
                      "await runners.removeAccount(id, engine: login, account: line.id)",
                      ".disabled(offline || removal?.pending == true)",
                      "Text(RunnerPageCopy.RUNNER_ENGINES_OFFLINE_FOOTER)",
                      "RunnerAttention.updateNoteOf(health.update, nowMs: RunnerPageFormat.nowMs(now))"] {
            XCTAssertTrue(page.contains(piece), "the engine page lost \(piece)")
        }
        // Any account — Default too — is renamed from its long-press menu, never from the swipe, and
        // with the session rename's rules; the row says what a renamed Default still is.
        for piece in [".contextMenu {",
                      "renameDraft = line.name",
                      "Label(\"Rename…\", systemImage: \"pencil\")",
                      ".alert(\"Rename Account\", isPresented: renameAsked, presenting: renaming) { line in",
                      "TextField(line.isDefault ? \"Default\" : \"Name\", text: $renameDraft)",
                      "guard !name.isEmpty, name != line.name else { return }",
                      "await runners.renameAccount(id, engine: login, account: line.id, name: name)",
                      "if let subtitle = line.subtitle {"] {
            XCTAssertTrue(page.contains(piece), "the engine page lost \(piece)")
        }
        try assertInOrder(page, [".contextMenu {", ".swipeActions(edge: .trailing, allowsFullSwipe: false) {"],
                          "Rename is the menu's, not the swipe's")
        let swipe = try slice(page, from: ".swipeActions(edge: .trailing, allowsFullSwipe: false) {", to: "addAccountRow(health, login: login")
        XCTAssertFalse(swipe.contains("Rename"), "a swipe performs; it does not open an editor")
        let runnersModel = code(try appSource("RunnersModel.swift"))
        XCTAssertTrue(runnersModel.contains("api.renameRunnerAccount(id, engine: engine, account: account, name: name)"))

        let signIn = code(try appSource("Views/RunnerSignInView.swift"))
        XCTAssertTrue(signIn.contains("var account: String? = nil"), "the sign-in card takes an account")
        XCTAssertTrue(signIn.contains("var accountName: String? = nil"), "or a new account's name")
        XCTAssertTrue(signIn.contains("Task { await model.begin(accountName: accountName) }"))
        XCTAssertTrue(signIn.contains("var autoStart = false"), "or starts as it appears")
        try assertInOrder(code(signIn), ["let fresh = model == nil", "if autoStart, fresh {",
                                         "await m.begin(accountName: accountName)", "await m.refresh()"],
                          "an Add Account card starts its sign-in on its first appearance only")
        let model = code(try appSource("RunnerSignInModel.swift"))
        XCTAssertTrue(model.contains("api.startRunnerLogin(runnerID, engine: engine, account: account, accountName: name)"))
        XCTAssertTrue(model.contains("if adding { return startedHere }"),
                      "a card adding an account owns only the sign-in it started")
    }

    /// ⑤ A workspace row says how many of its sessions run, and opens them — after the Settings sheet
    /// comes down, the way its drawer row opens it.
    func testAWorkspaceRowOpensItsSessionsAfterSettingsComesDown() throws {
        let page = try detail()
        let section = try slice(page, from: "private func workspacesSection(", to: "private func aboutSection(")
        XCTAssertTrue(section.contains("RunnerPageFormat.runningCount(workspace,"))
        XCTAssertTrue(section.contains("Text(RunnerPageCopy.RUNNER_WORKSPACES_FOOTER)"))
        let open = try slice(code(try runners()), from: "private func openWorkspace(_ id: String) {", to: "private func copy(")
        try assertInOrder(open, ["model.settingsPresented = false", "model.openAgent(id)"],
                          "the sheet comes down before the workspace opens")
        XCTAssertTrue(code(try appSource("RunnersModel.swift")).contains("try? await api.sessionCounts()"))
    }

    /// ⑥ About: Name is a page of its own — no text field and Rename button on the record — and the
    /// read-only facts, with root's footer.
    func testAboutsNameIsAPageOfItsOwn() throws {
        let page = try detail()
        let about = try slice(page, from: "private func aboutSection(", to: "private var rotateSection: some View {")
        XCTAssertTrue(about.contains("Button { model.push(.runnerName(runnerID: runner.id)) } label: {"))
        for field in ["RUNNER_ABOUT_HOSTNAME", "RUNNER_ABOUT_VERSION", "RUNNER_ABOUT_RUNS_AS", "RUNNER_ABOUT_REPOS_FOLDER",
                      "RUNNER_ABOUT_LAST_CHECK_IN", "RUNNER_ABOUT_REGISTERED"] {
            XCTAssertTrue(about.contains("aboutRow(RunnerPageCopy.\(field),"), "About lost \(field)")
        }
        try assertInOrder(about, ["if runner.runsAsRoot == true {", "Text(RunnerPageCopy.RUNNER_ROOT_NO_BYPASS)"],
                          "root's footer")
        let text = code(try runners())
        XCTAssertFalse(text.contains("TextField(\"Display name\""), "the record no longer edits the name in place")
        XCTAssertFalse(text.contains("Button(\"Rename\")"))
        XCTAssertTrue(code(try appSource("Views/RunnerNamePage.swift")).contains("await runners.rename(id, typed)"))
    }

    /// ⑦ Rotate Token… and Remove Runner: each a card of its own, each asking first; a new token is
    /// shown once, to copy, and gone with the page.
    func testDangerousPressesAskFirstOnCardsOfTheirOwn() throws {
        let page = try detail()
        XCTAssertTrue(page.contains("Button(RunnerPageCopy.RUNNER_ROTATE_TOKEN) { confirmingRotate = true }"))
        XCTAssertTrue(page.contains("Button(role: .destructive) { confirmingRemove = true } label: {"))
        XCTAssertTrue(page.contains("isPresented: $confirmingRotate, titleVisibility: .visible) {"))
        XCTAssertTrue(page.contains("isPresented: $confirmingRemove, titleVisibility: .visible) {"))
        XCTAssertTrue(page.contains("if let token = rotatedToken {"))
        XCTAssertTrue(page.contains("Button(RunnerPageCopy.RUNNER_COPY) { copy(token) }"))
        XCTAssertFalse(code(try appSource("RunnersModel.swift")).contains("revealedToken"),
                       "the token lives on the page that minted it, not on a model every runner shares")
    }
}
