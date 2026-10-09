import Foundation
import XCTest

/// SwiftUI doesn't exist on Linux, so nothing here compiles the app shells. These hold the
/// Infrastructure page and a machine's pages to the effect mocks they were built from
/// (docs/mocks/infrastructure-page/03-ios.png, ios-detail.png) by reading the source they now *are*:
/// the page's blocks in the mock's order, a row whose label is the label colour and which pushes by
/// hand, Add Runner wired under the rows, the record's sections in the mocks' order, the engine and
/// name pages one push away on whichever stack the record rides — and every word and rule taken from
/// OrbitKit (`Infrastructure`, `RunnerAttention`, `RunnerPageCopy`, `RunnerPageFormat`), where it is
/// tested. Each check reads the slice of the file it is about, so a match somewhere else can't pass it.
final class InfrastructurePageWiringTests: XCTestCase {
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
    private static let sectionsFile = "Views/InfrastructureSections.swift"
    /// Every file the Infrastructure page and a machine's pages are drawn from.
    private static let pageFiles = [runnersFile, sectionsFile, "Views/RunnerPageParts.swift",
                                    "Views/RunnerEnginePage.swift", "Views/RunnerNamePage.swift",
                                    "Views/AddRunnerSheet.swift"]

    private func runners() throws -> String { try appSource(Self.runnersFile) }

    /// The Infrastructure page: the section's list on every shell, and Settings' page on a phone.
    private func lists() throws -> [(name: String, code: String)] {
        let text = try runners()
        return [
            ("the Infrastructure page", code(try slice(text, from: "struct RunnersListView: View {",
                                                       to: "/// How a `RunnersModel` list shows its load outcome"))),
        ]
    }

    // MARK: the page (03-ios.png)

    /// Top to bottom: Needs you — only while something does — and what each engine can run on, both once
    /// every list has answered; the machines, Add Runner, the account pools, the API keys. Its title is
    /// the section's, and it reads each of its lists side by side.
    func testThePageHoldsTheMocksBlocksInOrder() throws {
        let page = try XCTUnwrap(try lists().first?.code)
        let body = try slice(page, from: "List(selection:", to: ".orbitRevealSurface()")
        try assertInOrder(body, ["if lists.settled {", "if !attention.isEmpty {", "InfrastructureNeedsYouSection(",
                                 "InfrastructureEnginesSection(engines: lists.engines, install: install)",
                                 "ForEach(runners.runners)", "RunnerSectionHeader(Infrastructure.machines,",
                                 "Text(Infrastructure.machinesDetail)", "RunnerAddSection { addingRunner = true }",
                                 "InfrastructurePoolsSection(memberPools: lists.memberPools, ownPools: lists.ownPools,",
                                 "InfrastructureKeysSection(keys: lists.keys, balances: model.agents?.deepSeekBalances ?? [:],"],
                          "the page's blocks")
        XCTAssertTrue(page.contains(".navigationTitle(AppSection.runners.title)"))
        // The machines are read again while the page is up, so a row's Offline and its "N / M running"
        // never come from two different reads' worth of time.
        try assertInOrder(page, ["await runners.load()", "while !Task.isCancelled {",
                                 "try? await Task.sleep(for: .seconds(15))", "await runners.load()"],
                          "the page's machines, read again while it is up")
        for read in [".task { await self.model.agents?.reloadPools() }",
                     ".task { await self.model.agents?.loadOwnKeys() }", ".task { await self.model.sharedPools?.load() }",
                     "await self.model.sharedPools?.loadAccess(id)",
                     // A DeepSeek key's row ends with its account's balance (936ebbd3c's Providers rows).
                     ".task { await self.model.agents?.loadDeepSeekBalances() }"] {
            XCTAssertTrue(page.contains(read), "the page reads \(read)")
        }
    }

    /// A DeepSeek key's row ends with its account's balance and, where the page is a stack's (iOS), opens
    /// the key's page — from Settings' stack and from the Infrastructure section's own — as the row of
    /// Settings → Providers did before the two pages became one (936ebbd3c).
    func testADeepSeekKeysRowEndsWithItsBalanceAndOpensItsPage() throws {
        let sections = code(try appSource(Self.sectionsFile))
        let keys = try slice(sections, from: "struct InfrastructureKeysSection: View {", to: "\n}\n")
        for piece in ["var balances: [String: ProviderBalanceReading] = [:]",
                      "if let id = DeepSeekBalance.key(for: key, mine: keys)?.providerID {",
                      "Button { open(.providerDetail(providerID: id)) } label: {",
                      "} else if let balance, let value = DeepSeekBalance.rowValue(DeepSeekBalance.state(balance)) {"] {
            XCTAssertTrue(keys.contains(piece), "the API keys section lost `\(piece)`")
        }
        for stack in ["Views/SettingsSheet.swift", "Views/CompactShell.swift"] {
            XCTAssertTrue(code(try appSource(stack))
                .contains("case .providerDetail(let providerID): ProviderDetailSettingsPage(providerID: providerID)"),
                          "\(stack) has no destination for a DeepSeek key's page")
        }
    }

    /// The two blocks at the top are OrbitKit's rules over the page's own lists — the account's own keys
    /// (GET /providers/mine) among them — and wait for every list's answer, as the web's do.
    func testTheTopBlocksAreTheWebsRulesOverThePagesLists() throws {
        let sections = code(try appSource(Self.sectionsFile))
        let read = try slice(sections, from: "struct InfrastructureLists {", to: "struct InfrastructureNeedsYouSection: View {")
        for piece in ["keys = model.agents?.ownKeys ?? []", "SharedPools.ownPoolWithAccess(pool, access)",
                      "settled = states.allSatisfy { state in state.map { $0.hasLoaded || $0.lastLoadFailed } ?? false }",
                      "Infrastructure.attention(runners: runners, memberPools: memberPools.map(SharedPools.asProviderPool),",
                      "Infrastructure.engines(runners: runners, keys: keys,"] {
            XCTAssertTrue(read.contains(piece), "the page's lists lost \(piece)")
        }
        let agents = code(try appSource("AgentsModel.swift"))
        XCTAssertTrue(agents.contains("ownKeys = try await api.personalProviders()"),
                      "the keys are the account's own, as the web page reads them")
        // Every press stays in the app: an engine's page, a machine's record, a pool's page.
        let page = try XCTUnwrap(try lists().first?.code)
        let presses = try slice(page, from: "private func openAttention(",
                                to: "model.push(.runnerEngine(runnerID: runnerID, engine: engine))")
        for piece in ["openEngine(runnerID, engine.rawValue)", "model.selectedRunnerID = runnerID",
                      "model.push(.runnerDetail(runnerID: runnerID))",
                      "model.push(own ? .accountPool(poolID: poolID) : .sharedPool(poolID: poolID))",
                      "guard let runner = Infrastructure.installTarget(model.runners?.runners ?? []) else {",
                      "addingRunner = true", "openEngine(runner.id, engine.rawValue)"] {
            XCTAssertTrue(presses.contains(piece), "the page's presses lost \(piece)")
        }
        XCTAssertFalse(page.contains("openURL"), "nothing on the page opens the web")
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

    /// ②–⑤ Dot, name, the slots' bar — or Offline — then "2 / 4 running · 1 engine signed out" in amber
    /// (03-ios.png), and the third line only when something needs a person — `RunnerAttention`'s.
    func testTheRowIsTheMocksRow() throws {
        let row = code(try slice(try runners(), from: "struct RunnerRow: View {", to: "struct RunnerDetailView: View {"))
        for piece in ["RunnerStatusDot(presence: RunnerPageFormat.presence(runner, now: now))",
                      "if let slots = RunnerPageFormat.slots(runner, now: now) {",
                      "RunnerSlotBar(slots: slots)",
                      "Text(RunnerPageCopy.RUNNER_OFFLINE)",
                      "Text(Infrastructure.machineLine(runner, now: now))",
                      "let signedOut = !Infrastructure.signedOutEngines(runner).isEmpty",
                      ".foregroundStyle(signedOut ? RunnerInk.amber : Color.secondary)",
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

    /// The list's own move and delete, a move saved as the web list's drag order is, and a delete
    /// that asks first. The list does not show an Edit button.
    func testListReordersAndRemovesAfterAsking() throws {
        let text = try runners()
        for list in try lists() {
            XCTAssertTrue(list.code.contains(".onMove { moveRunners(runners, from: $0, to: $1) }"), list.name)
            XCTAssertTrue(list.code.contains(".onDelete { pendingRemoval = runnerToRemove(runners, at: $0) }"),
                          "\(list.name): a delete only names the runner to ask about")
            XCTAssertTrue(list.code.contains(".modifier(RunnerListEditing("), list.name)
        }
        let editing = try slice(text, from: "private struct RunnerListEditing: ViewModifier {", to: "/// A drag in Edit")
        XCTAssertFalse(code(text).contains("EditButton("), "Runners lists do not show an Edit button")
        let asked = code(editing)
        XCTAssertTrue(asked.contains(".orbitConfirmation({ _ in removalTitle },"))
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
        for piece in ["ProviderMark(provider: health.engine, size: 28", "RunnerPageFormat.engineStatus(health, runner: runner)",
                      "RunnerPageFormat.updateFailedLine(health, now: now)", "RunnerPageFormat.needsSignIn(health)",
                      "RunnerPageFormat.engineWindows(runner, engine: health.engine)",
                      "RunnerPageFormat.engineNextAccount(runner, engine: health.engine)",
                      "Text(RunnerPageCopy.runnerEngineNext(account: next))",
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
                      "RunnerSignInView(runnerID: runner.id, engine: login, account: line.signInAccount, autoStart: true,",
                      "onClose: { closeSignIn() }, onSignedIn: { landed(line.id) })",
                      "Button(\"Add Account\")",
                      // The press starts the sign-in under a name the page picks; the name typed over it
                      // is saved as Rename… saves one, once the runner reports the account — and once
                      // that account is signed in and named, the card folds back into Add Account.
                      "newAccountPicked = RunnerPageFormat.defaultAccountName(accounts)",
                      "RunnerSignInView(runnerID: runner.id, engine: login, accountName: newAccountName, autoStart: true,",
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
                      ".orbitConfirmation({ _ in removalTitle },",
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
        let swipe = try slice(page, from: "private func trailingActions(", to: "private func accountMenu(")
        XCTAssertFalse(swipe.contains("Rename"), "a swipe performs; it does not open an editor")
        let runnersModel = code(try appSource("RunnersModel.swift"))
        XCTAssertTrue(runnersModel.contains("api.renameRunnerAccount(id, engine: engine, account: account, name: name)"))

        let signIn = code(try appSource("Views/RunnerSignInView.swift"))
        XCTAssertTrue(signIn.contains("var account: String? = nil"), "the sign-in card takes an account")
        XCTAssertTrue(signIn.contains("var accountName: String? = nil"), "or a new account's name")
        XCTAssertTrue(signIn.contains("Task { await model.begin(accountName: accountName) }"))
        XCTAssertTrue(signIn.contains("var autoStart = false"), "or starts as it appears")
        try assertInOrder(code(signIn), ["let fresh = model == nil", "if autoStart, fresh, engine != .kimi {",
                                         "if accountName == nil { await m.refresh() }",
                                         "if m.status?.inFlight != true { await m.begin(accountName: accountName) }",
                                         "} else {", "await m.refresh()"],
                          "a card its press raised starts its sign-in on its first appearance only — and one for an "
                              + "account the runner has follows a sign-in already under way for it instead")
        let model = code(try appSource("RunnerSignInModel.swift"))
        // …and, for Kimi, the site the card's press picked (KimiSite).
        XCTAssertTrue(model.contains("api.startRunnerLogin(runnerID, engine: engine, account: account, accountName: name, region: site?.rawValue)"))
        XCTAssertTrue(model.contains("if adding { return startedHere }"),
                      "a card adding an account owns only the sign-in it started")
    }

    /// On a phone an account's row says only where it stands, and its presses are on its left swipe
    /// and its long-press menu (docs/mocks/account-pause-swipe-ios.html): Pause — Resume while it is
    /// paused — inside Remove on the swipe, drawn as the session list's circles on iOS 26; Rename…,
    /// Sign In Again, the pause and Remove… in the menu. A Mac keeps the presses on the row.
    func testAnAccountsPressesAreOnItsSwipeAndMenu() throws {
        let page = code(try appSource("Views/RunnerEnginePage.swift"))
        let swipe = try slice(page, from: "private func trailingActions(", to: "private func accountMenu(")
        try assertInOrder(swipe, ["RowSwipeAction(title: \"Remove\", systemImage: \"trash\", tint: .red, role: .destructive,",
                                  "RowSwipeAction(title: \"Resume\", systemImage: \"play\", tint: .green,",
                                  "RowSwipeAction(title: \"Pause\", systemImage: \"pause\", tint: .orange,"],
                          "Remove outermost on the swipe, then Pause or Resume")
        XCTAssertTrue(swipe.contains("perform: { pausing = line }"), "Pause opens the Pause Account sheet")
        XCTAssertTrue(swipe.contains("perform: { resume(line) }"), "Resume resumes at once")
        XCTAssertFalse(swipe.contains("Sign In Again"), "a swipe performs; signing in again opens a card")
        XCTAssertTrue(page.contains("AccountPauseSheet(name: line.name, scope: Self.pauseScope) { minutes in"))

        let actions = try slice(page, from: "private func withActions<", to: "private func systemSwipeActions<")
        XCTAssertTrue(actions.contains("if #available(iOS 26.0, *), horizontalSizeClass == .compact, !trailing.isEmpty {"))
        XCTAssertTrue(actions.contains(".circleSwipeActions(id: id, leading: [], trailing: trailing, leadingFullSwipe: false)"))
        XCTAssertTrue(page.contains("trailing: signingIn == line.id ? []"), "a row whose sign-in card is open has no swipe")

        let menu = try slice(page, from: "private func accountMenu(", to: "private func addAccountRow(")
        try assertInOrder(menu, ["Label(\"Rename…\", systemImage: \"pencil\")",
                                 "Label(\"Sign In Again\", systemImage: \"arrow.clockwise\")",
                                 "Label(\"Resume Now\", systemImage: \"play.fill\")",
                                 "Label(\"Change Duration…\", systemImage: \"clock\")",
                                 "Label(\"Pause…\", systemImage: \"pause.fill\")",
                                 "Label(\"Remove…\", systemImage: \"trash\")"],
                          "the menu holds everything the row and its swipe offer")

        let row = try slice(page, from: "private func accountRow(", to: "private func withActions<")
        XCTAssertTrue(row.contains("AccountPauseLine(pausedUntil: line.pausedUntil)"), "Paused stays, as a line")
        XCTAssertTrue(row.contains("RunnerPageFormat.loginExpiresLine(line, now: now)"))
        XCTAssertTrue(row.contains("Button(RunnerPageCopy.RUNNER_ENGINE_RENEW) { signingIn = line.id }"))
        XCTAssertTrue(row.contains("RunnerPageFormat.signedOutNote(line, alone: alone, engine: engine)"))
        XCTAssertTrue(row.contains("&& (Self.pressesOnRow || line.auth != \"yes\") {"),
                      "on a phone a signed-in account is signed in again from its menu, not its row")
        XCTAssertTrue(row.contains("} else if Self.pressesOnRow && canPause"), "a Mac keeps the pause on the row")
    }

    /// The sign-in card has one way out at a time — Cancel while a sign-in runs, Close otherwise — so the
    /// page draws none of its own; a pasted code goes at once; a device code comes first, under the one
    /// press that copies it and opens its page; and a card whose sign-in landed folds back once the
    /// runner reports the account signed in (docs/mocks/account-sign-in-ios.html ④–⑧).
    func testTheSignInCardOffersOneWayOutAndPastesInOneTap() throws {
        let signIn = code(try appSource("Views/RunnerSignInView.swift"))
        XCTAssertTrue(signIn.contains("var onClose: (() -> Void)? = nil"))
        let cancel = try slice(signIn, from: "private func cancelButton(", to: "private var closeButton")
        try assertInOrder(cancel, ["await model.cancel()", "if model.errorText == nil { onClose?() }"],
                          "Cancel cancels the sign-in, then puts the card away")
        let paste = try slice(signIn, from: "private struct PasteBackForm: View {", to: "struct AuthErrorCardView: View {")
        XCTAssertTrue(paste.contains("PasteButton(payloadType: String.self) { pasted in"))
        try assertInOrder(paste, ["model.code = code", "await model.submitCode()"], "a pasted code is sent at once")
        XCTAssertTrue(paste.contains("if phase == .active, opened { returned = true }"),
                      "back from the page it opened, Paste is the prominent press")
        let device = try slice(signIn, from: "private func deviceFlow(", to: "private func idle(")
        try assertInOrder(device, ["Text((model.adding ? site?.enterCodeAdding : site?.enterCode) ?? \"Enter this one-time code on the sign-in page:\")",
                                   "Text(code)",
                                   "PlatformPasteboard.copyString(code)", "openURL(url)",
                                   "Label(site?.copyCodeAndOpen ?? \"Copy Code & Open Sign-In Page\", systemImage: \"doc.on.doc\")"],
                          "the code first, then the press that copies it and opens its page")

        let page = code(try appSource("Views/RunnerEnginePage.swift"))
        XCTAssertFalse(page.contains("Button(\"Close\") { closeSignIn() }"), "the card's own Cancel or Close is the way out")
        try assertInOrder(page, ["private func foldsBack(",
                                 "signingIn == line.id && landedHere == line.id && line.auth == \"yes\"",
                                 "&& RunnerPageFormat.loginExpiresLine(line, now: now) == nil"],
                          "a card folds back once the row it folds into says the account is signed in")
    }

    /// An account's row wears NEXT beside its name where Automatic starts the next session — the account
    /// pools' chip, on every engine's page — and its line under the name gives up its middle, never the
    /// site that leads a Kimi account's or the id that ends its directory (docs/mocks/kimi-accounts/02-ios).
    /// The section is Sign-In where the runner keeps one login of the engine.
    func testAnAccountsRowWearsNextAndKeepsBothEndsOfItsLine() throws {
        let page = code(try appSource("Views/RunnerEnginePage.swift"))
        let row = try slice(page, from: "private func accountRow(", to: "private func withActions<")
        try assertInOrder(row, ["Text(line.name)",
                                "if RunnerPageFormat.marksNext(runner, engine: engine, account: line.id, now: now) {",
                                "PoolChip(text: SharedPoolPage.nextChip)",
                                "if let subtitle = line.subtitle {", ".lineLimit(1)", ".truncationMode(.middle)"],
                          "NEXT beside the name, then the line under it")
        XCTAssertTrue(page.contains("RunnerSectionHeader(RunnerPageFormat.accountsTitle(runner, engine: engine))"))
        // The pools' chip is the page's to wear too — on the Mac as well, so not in the pool pages'
        // iOS-only file.
        let chip = code(try appSource("Views/PoolChip.swift"))
        XCTAssertTrue(chip.contains("struct PoolChip: View {"))
        XCTAssertFalse(chip.contains("#if os(iOS)"), "PoolChip is iOS-only")
        XCTAssertFalse(code(try appSource("Views/ProviderPoolViews.swift")).contains("struct PoolChip"))
    }

    /// Kimi's Add Account names the account first and the site second: neither site can be pressed
    /// without a name, the press signs in under it — as does starting over on the other site — and
    /// Current marks only the site of the account being signed in again (02-ios ② ⑫).
    func testKimisAddAccountNamesTheAccountThenItsSite() throws {
        let signIn = code(try appSource("Views/RunnerSignInView.swift"))
        let sites = try slice(signIn, from: "private func kimiSites(", to: "private func signInButton(")
        try assertInOrder(sites, ["Task { await model.begin(accountName: accountName, site: KimiSite.named(site, on: model.runner)) }",
                                  "if model.currentSite == site {",
                                  ".disabled(model.busy || !model.runnerRead || !nameReady)"],
                          "a site press signs the named account in on that site")
        let device = try slice(signIn, from: "private func deviceFlow(", to: "private func idle(")
        XCTAssertTrue(device.contains(
            "Task { await model.begin(accountName: accountName, site: KimiSite.named(site.other, on: model.runner)) }"),
            "the other site starts over under the same name")
        let model = code(try appSource("RunnerSignInModel.swift"))
        XCTAssertTrue(model.contains("var currentSite: KimiSite? { KimiSite.current(on: runner, account: account, adding: adding) }"))
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
        XCTAssertTrue(page.contains("orbitConfirmation(\"Rotate token for"),
                      "the token card asks first, in the shape the width calls for")
        XCTAssertTrue(page.contains("orbitConfirmation(\"Remove "),
                      "and so does the remove card")
        XCTAssertTrue(page.contains("if let token = rotatedToken {"))
        XCTAssertTrue(page.contains("Button(RunnerPageCopy.RUNNER_COPY) { copy(token) }"))
        XCTAssertFalse(code(try appSource("RunnersModel.swift")).contains("revealedToken"),
                       "the token lives on the page that minted it, not on a model every runner shares")
    }
}
