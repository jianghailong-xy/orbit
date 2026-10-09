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

    func testTheAppBuildsItPollsItAndForgetsItOnSignOut() throws {
        let app = code(try source("AppModel.swift"))
        let configure = try slice(app, from: "sharedPools = SharedPoolsModel(", to: "runnerControl = RunnerControl(")
        XCTAssertTrue(configure.contains("ManagedRunnerModel(baseURL: url, tokenStore: tokenStore)"))
        XCTAssertTrue(configure.contains("consoleRegistry?.managedRunner = managedRunnerModel"))
        let poll = try slice(app, from: "func startPolling() {", to: "try? await Task.sleep(nanoseconds: 4_000_000_000)")
        XCTAssertTrue(poll.contains("await self.managedRunner?.refreshIfDue()"))
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
        XCTAssertTrue(availability.contains("isDraft ? (managed?.blocksNewSession == true ? .blocked : .sendNow)"))
        XCTAssertTrue(availability.contains("capabilities: sendCapabilities"))
        let lift = try slice(console, from: "private var sendCapabilities: SessionCapabilities? {", to: "\n    }")
        XCTAssertTrue(lift.contains("ManagedRunnerLogic.sendCapabilities(serverCapabilities, acceptsWork: managed?.display.acceptsWork == true)"))
        // Sending decides its refusal and its endpoint from the same capabilities the composer showed.
        let send = try slice(console, from: "let terminalAttempt = ComposerLogic.shouldResume(status: sessionStatus)",
                             to: "let accepted = try await postTurn(")
        XCTAssertTrue(flat(send).contains("ComposerLogic.blockedMessage(status: sessionStatus, capabilities: sendCapabilities)"))
        XCTAssertTrue(send.contains("ComposerLogic.shouldResume(status: sessionStatus, capabilities: sendCapabilities)"))
        XCTAssertFalse(send.contains("capabilities: serverCapabilities"))
    }

    func testWorkSentToAManagedRunnerThatIsNotUpReadsItsStateAtOnce() throws {
        let console = code(try source("ConsoleModel.swift"))
        let wake = try slice(console, from: "private func managedWorkSent() {", to: "\n    }")
        XCTAssertTrue(wake.contains("guard managed != nil, runnerOnline != true, let managedRunner else { return }"))
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

    func testADraftThatCannotStartShowsTheStateInsteadOfAnEngine() throws {
        let views = code(try source("Views/AgentsView.swift"))
        let draft = try slice(views, from: "struct NewSessionView: View {", to: "ComposerView(console: draft, autoFocus: focusesComposer)")
        let blocked = try XCTUnwrap(draft.range(of: "if let managed = draft.managed, managed.blocksNewSession {"))
        let hero = try XCTUnwrap(draft.range(of: "} else if draft.localStatusCards.isEmpty {"))
        let engine = try XCTUnwrap(draft.range(of: "ProviderMark(provider: currentEngine.slug"))
        XCTAssertLessThan(blocked.lowerBound, hero.lowerBound)
        XCTAssertLessThan(hero.lowerBound, engine.lowerBound, "the engine is drawn only on the other branch")
        XCTAssertTrue(draft.contains("if let managed = draft.managed, managed.showsBanner, !managed.blocksNewSession {"))
    }

    // MARK: Infrastructure and the actions

    func testInfrastructureShowsItOnlyToAnAccountWithNoRunner() throws {
        let list = code(try source("Views/SkillsRunnersView.swift"))
        let page = try slice(list, from: "struct RunnersListView: View {", to: ".modifier(RunnersLoadOverlay(")
        XCTAssertTrue(flat(page).contains("let managed = runners.loadState.hasLoaded ? ManagedRunnerLogic.onboarding(model.managedRunner?.display, runnerCount: runners.runners.count) : nil"))
        // In the list on iOS; above it on the Mac, whose table rows do not follow the banner's height.
        let ios = try slice(page, from: "#if os(iOS)", to: "#endif")
        XCTAssertTrue(ios.contains("ManagedRunnerBanner(display: managed"))
        let mac = try slice(page, from: "#if os(macOS)", to: "#endif")
        XCTAssertTrue(mac.contains(".safeAreaInset(edge: .top, spacing: 0) {"))
        XCTAssertTrue(mac.contains("ManagedRunnerBanner(display: managed"))
    }

    func testABlockedDraftShowsNoModelInTheComposer() throws {
        let composer = code(try source("Views/ComposerView.swift"))
        let toolbar = try slice(composer, from: "private var toolbar: some View {", to: "sendControls\n")
        XCTAssertTrue(toolbar.contains("if console.managed?.blocksNewSession != true { modelMenu }"))
    }

    func testRetryCallsTheServersRetryWithTheRevisionItRead() throws {
        let model = code(try source("ManagedRunnerModel.swift"))
        let retry = try slice(model, from: "func retry() async {", to: "\n    }")
        XCTAssertTrue(retry.contains("guard let status, display?.retry == true, !acting else { return }"))
        XCTAssertTrue(retry.contains("api.retryManagedRunner(revision: status.revision)"))
        let ensure = try slice(model, from: "func ensure() async {", to: "\n    }")
        XCTAssertTrue(ensure.contains("guard display?.ensure == true, !acting else { return }"))
        XCTAssertTrue(ensure.contains("api.ensureManagedRunner()"))
        let banner = code(try source("Views/ManagedRunnerBanner.swift"))
        XCTAssertTrue(banner.contains("Button(ManagedRunnerCopy.retry) { Task { await model.managedRunner?.retry() } }"))
        XCTAssertTrue(banner.contains("Button(ManagedRunnerCopy.ensure) { Task { await model.managedRunner?.ensure() } }"))
        XCTAssertTrue(banner.contains("Button(ManagedRunnerCopy.signIn) { model.route(to: .runner(runnerID)) }"))
        // The words are OrbitKit's shared ones, never typed out again here.
        XCTAssertTrue(banner.contains("Text(display.title)"))
        XCTAssertTrue(banner.contains("Text(display.detail)"))
    }
}
