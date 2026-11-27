import Foundation
import XCTest

/// SwiftUI doesn't exist on Linux, so nothing here compiles the app shell — CI's `client.yml` does.
/// These hold the managed runner's wiring in the macOS and iOS shell to the source instead (the iOS
/// app builds these same files): who reads the capability and the status, and how often; that a
/// console shows the state above its composer and acts on `ManagedRunnerLogic`'s answers; that a
/// draft in the managed default workspace shows the state instead of an engine; that Retry calls the
/// server's retry; and that without the capability none of it reads anything. Each check reads the
/// slice of the file it's about, so a match somewhere else can't pass it.
final class ManagedRunnerWiringTests: XCTestCase {
    private struct SourceMissing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "OrbitApp/Sources/OrbitApp/\(path) wasn't found above this test. If it moved, point this check "
                + "at its new home — don't delete the check."
        }
    }

    /// Found by walking up from this file; never a skip, so the check can't go quiet when a file moves.
    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("src/macos/OrbitApp/Sources/OrbitApp")
                .appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir.deleteLastPathComponent()
        }
        throw SourceMissing(path: relative)
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

    /// Whitespace runs as one space, so a call wrapped over two lines reads as written on one.
    private func flat(_ text: String) -> String {
        text.split(whereSeparator: { $0 == " " || $0 == "\n" }).joined(separator: " ")
    }

    // MARK: who reads what

    func testTheCapabilityIsReadFirstAndTheStatusOnlyWhenItOffersManagedRunners() throws {
        let model = code(try source("ManagedRunnerModel.swift"))
        let load = try slice(model, from: "func load(now: Date = Date()) async {", to: "\n    }\n")
        let capability = try XCTUnwrap(load.range(of: "ManagedRunnerLogic.offered(try? await api.serverCapabilities())"))
        let offeredGate = try XCTUnwrap(load.range(of: "guard offered == true else {"))
        let status = try XCTUnwrap(load.range(of: "try await api.managedRunnerStatus()"))
        XCTAssertLessThan(capability.lowerBound, offeredGate.lowerBound)
        XCTAssertLessThan(offeredGate.lowerBound, status.lowerBound, "no status read without the capability")
        // A failed status read is no managed UI, never a wait.
        XCTAssertTrue(load.contains("} catch {\n            adopt(nil)"))
        // The display is the shared one, and the next read follows it: soon while it moves, rarely otherwise.
        let adopt = try slice(model, from: "private func adopt(", to: "\n    }")
        XCTAssertTrue(adopt.contains("display = ManagedRunnerLogic.display(answer)"))
        XCTAssertTrue(adopt.contains("ManagedRunnerLogic.refreshInterval(display)"))
    }

    func testManagedStatusUpdatesTheSetupEntries() throws {
        XCTAssertTrue(try source("ManagedRunnerModel.swift").contains("onStatusChanged(answer)"))
        XCTAssertTrue(try source("AppModel.swift").contains("self?.agents?.adoptManagedStatus(status)"))
        let agents = try source("AgentsModel.swift")
        XCTAssertTrue(agents.contains("managedStatus: managedStatus"))
        XCTAssertTrue(agents.contains("ManagedRunnerLogic.managedSetupState(runnerID: $0.id, status: managedStatus) != nil"))
    }

    func testTheAppBuildsItPollsItAndForgetsItOnSignOut() throws {
        let app = code(try source("AppModel.swift"))
        let configure = try slice(app, from: "sharedPools = SharedPoolsModel(", to: "runnerControl = RunnerControl(")
        XCTAssertTrue(configure.contains("ManagedRunnerModel(baseURL: url, tokenStore: tokenStore)"))
        XCTAssertTrue(configure.contains("consoleRegistry?.managedRunner = managedRunnerModel"))
        // The app's tick reads it among the floors behind the Open list (`pollFloors`).
        let poll = try slice(app, from: "private func pollFloors() async {", to: "\n    }")
        XCTAssertTrue(poll.contains("await managedRunner?.refreshIfDue()"))
        let logout = try slice(app, from: "func logout() {", to: "signedIn = false")
        XCTAssertTrue(logout.contains("managedRunner?.reset()"))
    }

    func testEveryConsoleTheRegistryMakesIsHandedTheManagedRunner() throws {
        let registry = code(try source("ConsoleRegistry.swift"))
        let draft = try slice(registry, from: "func draftModel(for agent: Agent", to: "return model")
        XCTAssertTrue(draft.contains("model.managedRunner = managedRunner"))
        let live = try slice(registry, from: "private func makeModel(", to: "return model")
        XCTAssertTrue(live.contains("model.managedRunner = managedRunner"))
    }

    // MARK: the console

    func testTheConsoleActsOnTheSharedAnswers() throws {
        let console = code(try source("ConsoleModel.swift"))
        let managed = try slice(console, from: "var managed: ManagedRunnerConsole? {", to: "\n    }")
        XCTAssertTrue(managed.contains("managedRunner?.console(runnerID: runnerID ?? draftAgent?.runnerId"))
        let availability = try slice(console, from: "var availability: SendAvailability {", to: "\n    }")
        XCTAssertTrue(availability.contains("isDraft ? .sendNow"))
        XCTAssertTrue(availability.contains("capabilities: sendCapabilities"))
        let lift = try slice(console, from: "private var sendCapabilities: SessionCapabilities? {", to: "\n    }")
        XCTAssertTrue(lift.contains("ManagedRunnerLogic.sendCapabilities(serverCapabilities, acceptsWork: managed?.display.acceptsWork == true)"))
        // Sending decides its refusal and its endpoint from the same capabilities the composer showed.
        let send = try slice(console, from: "let terminalAttempt = ComposerLogic.shouldResume(status: sessionStatus, released: serverReleased)",
                             to: "let accepted = try await postTurn(")
        XCTAssertTrue(flat(send).contains("ComposerLogic.blockedMessage(status: sessionStatus, released: serverReleased, capabilities: sendCapabilities)"))
        XCTAssertTrue(flat(send).contains("ComposerLogic.shouldResume(status: sessionStatus, released: serverReleased, capabilities: sendCapabilities)"))
        XCTAssertFalse(send.contains("capabilities: serverCapabilities"))
    }

    func testWorkSentToAManagedRunnerThatIsNotUpReadsItsStateAtOnce() throws {
        let console = code(try source("ConsoleModel.swift"))
        let wake = try slice(console, from: "private func managedWorkSent() {", to: "\n    }")
        // Not up by the managed status: a runner that has just slept still reads online for a while.
        XCTAssertTrue(wake.contains("guard let managed, managed.display.kind != .available, let managedRunner else { return }"))
        XCTAssertFalse(wake.contains("runnerOnline"), "a just-slept runner's row still reads online")
        XCTAssertTrue(wake.contains("await managedRunner.load()"))
        XCTAssertEqual(console.components(separatedBy: "managedWorkSent()").count - 1, 3,
                       "declared once, called after an accepted turn and after a created session")
    }

    func testTheStateStandsFirstInTheConsolesBandAndStaysWhileYouType() throws {
        let view = code(try source("Views/Console/ConsoleView.swift"))
        let band = try slice(view, from: "ComposerBand {", to: "ComposerView(console: console)")
        let banner = try XCTUnwrap(band.range(of: "if let managed = console.managed, managed.showsBanner {"))
        let errors = try XCTUnwrap(band.range(of: "if let msg = console.statusMessage {"))
        XCTAssertLessThan(banner.lowerBound, errors.lowerBound)
        let folded = try slice(band, from: "VStack(spacing: 0) {", to: ".modifier(TypingFold(folded: foldsChrome(console)))")
        XCTAssertFalse(folded.contains("ManagedRunnerBanner"), "about the runner the message goes to: never folded away")
    }

    func testDraftsKeepTheirEngineAndHaveNoDefaultWorkspaceWelcomeOrSendBlock() throws {
        let view = code(try source("Views/AgentsView.swift"))
        XCTAssertFalse(view.contains("ManagedWelcomeCard"))
        XCTAssertFalse(view.contains("blocksNewSession"))
        XCTAssertTrue(view.contains("ProviderMark(provider: currentEngine.slug"))
        XCTAssertTrue(view.contains("if let managed = draft.managed, managed.showsBanner {"))
    }

    func testManagedSetupUsesTheSharedNoticeAndSkipsProbes() throws {
        let card = try source("Views/MachineSetupCard.swift")
        XCTAssertTrue(card.contains("ManagedRunnerCopy.Setup.Notice.preparing"))
        XCTAssertTrue(card.contains("canAsk: managedState == nil && !disabled"))
        XCTAssertTrue(card.contains("MachineSetup.typedPick(folder: folder, found: found, root: root, machine: machine, managedState: managedState)"),
                      "a name is taken unchecked (MachineSetupFullPathTests pins the rule)")
        XCTAssertFalse(card.contains("RunnerSignInView"))
        XCTAssertFalse(try source("ConsoleModel.swift").contains("machineSetup"))
    }

    // MARK: Machines & models and the actions

    func testMachinesAndModelsOffersTheEntryAndTakesTheAnswerToTheMachine() throws {
        let list = code(try source("Views/SkillsRunnersView.swift"))
        let page = try slice(list, from: "struct RunnersListView: View {", to: ".modifier(RunnersLoadOverlay(")
        XCTAssertTrue(flat(page).contains("let managed = runners.loadState.hasLoaded ? ManagedRunnerLogic.onboarding(model.managedRunner?.display, runnerCount: runners.runners.count) : nil"))
        // In the list on iOS; in room of its own above the list on the Mac, whose table does not
        // follow a row or a top inset that arrives after it has drawn. Both ask first on an
        // established account and take an accepted Set up to the managed runner's own page.
        let ios = try slice(page, from: "#if os(iOS)", to: "#endif")
        XCTAssertTrue(ios.contains("ManagedRunnerBanner(display: managed"))
        XCTAssertTrue(flat(ios).contains("confirmsSetup: confirmsSetup, onEnsured: openManagedRunner"))
        XCTAssertTrue(flat(page).contains(".modifier(ManagedRunnerAboveList(display: managed, runnerID: model.managedRunner?.status?.runnerId, confirmsSetup: confirmsSetup, onEnsured: openManagedRunner))"))
        let above = try slice(list, from: "private struct ManagedRunnerAboveList: ViewModifier {", to: "\n}\n")
        let mac = try slice(above, from: "#if os(macOS)", to: "#else")
        XCTAssertTrue(mac.contains("VStack(spacing: 0) {"))
        XCTAssertTrue(mac.contains("ManagedRunnerBanner(display: display, runnerID: runnerID,"))
        XCTAssertTrue(try slice(above, from: "#else", to: "#endif").contains("content"))
        // The confirmation is the shared one (D3): an alert on the phone, a sheet on the Mac.
        let banner = code(try source("Views/ManagedRunnerBanner.swift"))
        XCTAssertTrue(banner.contains("if confirmsSetup { askingSetup = true } else { ensure() }"))
        XCTAssertTrue(banner.contains("orbitConfirmation(ManagedRunnerCopy.Confirm.title, isPresented: $askingSetup)"))
        XCTAssertTrue(banner.contains("Button(ManagedRunnerCopy.Confirm.action) { ensure() }"))
        XCTAssertTrue(banner.contains("Text(ManagedRunnerCopy.Confirm.body)"))
        // The answer names the runner: the page is pushed on a stack, selected in the three-column pane.
        let open = try slice(list, from: "private func openManagedRunner(", to: "\n    }")
        XCTAssertTrue(open.contains("model.push(.runnerDetail(runnerID: id))"))
        XCTAssertTrue(open.contains("model.selectedRunnerID = id"))
        XCTAssertTrue(open.contains("await model.runners?.load()"))
        // Set up asks first only where the account already has a machine or a workspace.
        let confirm = try slice(list, from: "private var confirmsSetup: Bool {", to: "\n    }")
        XCTAssertTrue(confirm.contains("ManagedRunnerLogic.confirmsSetup(runnerCount: model.runners?.runners.count ?? 0,"))
        XCTAssertTrue(confirm.contains("workspaceCount: model.agents?.items.count ?? 0)"))
        // Its row in the list is the managed one: the shared short label, never Online/Offline (D4).
        XCTAssertTrue(flat(list).contains("managed: ManagedRunnerLogic.row(runnerID: r.id, status: model.managedRunner?.status)"))
        // Needs you does not repeat the heartbeat's "offline" for it — and the terminals asking to be
        // approved lead that section, so its attention lines are read once the lists have settled.
        XCTAssertTrue(flat(page).contains("let attention = lists.settled ? lists.attention.filter { !isManagedOffline($0) && shows($0) } : []"))
        let notOffline = try slice(list, from: "private func isManagedOffline(", to: "\n    }")
        XCTAssertTrue(notOffline.contains("guard case .offline(let runnerID) = item.kind else { return false }"))
        XCTAssertTrue(notOffline.contains("ManagedRunnerLogic.row(runnerID: runnerID, status: model.managedRunner?.status) != nil"))
    }

    func testTheManagedMachinePageShowsItsBannerItsLabelAndNothingBeforeItReports() throws {
        let list = code(try source("Views/SkillsRunnersView.swift"))
        let page = try slice(list, from: "struct RunnerDetailContent: View {", to: "private func statusLine(now: Date)")
        // Its state in the shared words, as one machine: the label, not the heartbeat's Offline.
        XCTAssertTrue(page.contains("let managed = managedRow"))
        XCTAssertTrue(page.contains("private var managedRow: ManagedRunnerRow? {"))
        XCTAssertTrue(page.contains("ManagedRunnerLogic.row(runnerID: runner.id, status: model.managedRunner?.status)"))
        XCTAssertTrue(page.contains("head(now: now)"))
        XCTAssertTrue(page.contains("Text(managed.label)"))
        // The banner sits on its page while it is anything but ready.
        XCTAssertTrue(page.contains("if let managedDisplay, managedDisplay.kind != .available {"))
        XCTAssertTrue(page.contains("ManagedRunnerBanner(display: managedDisplay, runnerID: runner.id)"))
        // Its heartbeat "offline" card is not repeated beside the shared state.
        XCTAssertTrue(flat(page).contains(".filter { !(managed != nil && $0.kind == .offline) }"))
        // Before it reports: no Update card, Resources and Engines each one quiet line, no engine rows.
        XCTAssertTrue(page.contains("if !managedWaiting, let card = RunnerPageFormat.updateCard(runner, now: now) {"))
        XCTAssertTrue(page.contains("managedWaitingSection(RunnerPageCopy.RUNNER_RESOURCES)"))
        XCTAssertTrue(page.contains("managedWaitingSection(RunnerPageCopy.RUNNER_ENGINES)"))
        let waiting = try slice(page, from: "private func managedWaitingSection(", to: "\n    }")
        XCTAssertTrue(waiting.contains("Text(ManagedRunnerCopy.notReported)"))
        let branch = try slice(page, from: "if managedWaiting {", to: "} else {")
        XCTAssertFalse(branch.contains("enginesSection"), "no engine rows before it reports")
        XCTAssertFalse(branch.contains("resourcesSection"), "no readings before it reports")
    }

    func testAsleepIsSaidInTheComposerTheSidebarAndThePicker() throws {
        // The composer of a live session and of a new one: the shared calm line, not the notice.
        for file in ["Views/Console/ConsoleView.swift", "Views/AgentsView.swift"] {
            let view = code(try source(file))
            XCTAssertTrue(view.contains("managed.display.kind == .sleeping"), file)
            XCTAssertTrue(view.contains("ManagedRunnerCopy.Asleep.composer"), file)
        }
        // The sidebar row: the managed runner's shared state in the trailing slot, and no
        // "Runner offline" badge for it.
        let agents = code(try source("Views/AgentsView.swift"))
        let row = try slice(agents, from: "struct WorkspaceNavigationRow: View {", to: "\n}\n")
        XCTAssertTrue(row.contains("ManagedRunnerLogic.row(runnerID: agent.runnerId, status: app.managedRunner?.status)"))
        XCTAssertTrue(row.contains("let offlineNow = offline && managedRow == nil"))
        XCTAssertTrue(row.contains("Text(managedRow.label)"))
        let icon = try slice(agents, from: "struct WorkspaceFolderIcon: View {", to: "\n}\n")
        XCTAssertTrue(icon.contains("managed.asleep ? \"moon.zzz.fill\""))
        XCTAssertTrue(icon.contains(".accessibilityLabel(managed?.label ?? \"Runner offline\")"))
        // The project page's Change workspace picker: Asleep rather than Runner offline.
        let picker = code(try source("Views/CoordinatorChangeSheet.swift"))
        XCTAssertTrue(picker.contains("ManagedRunnerLogic.row(runnerID: runnerID, status: app.managedRunner?.status)"))
        XCTAssertTrue(picker.contains("if let managed, row.runnerOffline {"))
        XCTAssertTrue(picker.contains("Text(managed.label).font(.orbitLabel).foregroundStyle(managed.ink)"))
    }

    func testDraftShowsTheModelInTheComposer() throws {
        let composer = code(try source("Views/ComposerView.swift"))
        let toolbar = try slice(composer, from: "private var toolbar: some View {", to: "sendControls\n")
        XCTAssertTrue(toolbar.contains("modelMenu"))
        XCTAssertFalse(toolbar.contains("blocksNewSession"))
    }

    func testRetryCallsTheServersRetryWithTheRevisionItRead() throws {
        let model = code(try source("ManagedRunnerModel.swift"))
        let retry = try slice(model, from: "func retry() async {", to: "\n    }")
        XCTAssertTrue(retry.contains("guard let status, display?.retry == true, !acting else { return }"))
        XCTAssertTrue(retry.contains("api.retryManagedRunner(revision: status.revision)"))
        let ensure = try slice(model, from: "func ensure(then open:", to: "\n    }")
        XCTAssertTrue(ensure.contains("guard display?.ensure == true, !acting else { return false }"))
        XCTAssertTrue(ensure.contains("api.ensureManagedRunner()"))
        // The accepted answer names the runner, and that is where a caller asked to land.
        XCTAssertTrue(ensure.contains("if let runnerID = status?.runnerId { open?(runnerID) }"))
        let banner = code(try source("Views/ManagedRunnerBanner.swift"))
        XCTAssertTrue(banner.contains("Button(ManagedRunnerCopy.retry) { Task { await model.managedRunner?.retry() } }"))
        XCTAssertTrue(banner.contains("ManagedRunnerCopy.ensure"))
        XCTAssertTrue(banner.contains("Task { await model.managedRunner?.ensure(then: onEnsured) }"))
        XCTAssertTrue(banner.contains("Button(ManagedRunnerCopy.signIn) { model.route(to: .runner(runnerID)) }"))
        // The words are OrbitKit's shared ones, never typed out again here.
        XCTAssertTrue(banner.contains("Text(display.title)"))
        XCTAssertTrue(banner.contains("Text(display.detail)"))
    }
}
