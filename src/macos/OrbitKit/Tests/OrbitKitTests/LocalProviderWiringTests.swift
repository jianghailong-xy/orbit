import Foundation
import XCTest
@testable import OrbitKit

/// The app-side halves of phase 4B: every entry point that offers an engine, a provider or a model —
/// the composer (a new session and a resumed one), a workspace's hero, and a task's Runs-with form —
/// reads the local provider's row and refuses a run before it is submitted. The pure rules are held
/// by `LocalProviderChoiceTests` and the shared fixtures; this holds the wiring to them, so a later
/// refactor cannot quietly offer a choice the runner cannot run.
final class LocalProviderWiringTests: XCTestCase {
    private func source(_ relative: String) throws -> String {
        var root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let url = root.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: url.path) {
                return try String(contentsOf: url, encoding: .utf8)
            }
            root.deleteLastPathComponent()
        }
        throw CocoaError(.fileReadNoSuchFile)
    }

    func testTheComposerSaysTheStatusAndGatesAModelAndTheSend() throws {
        let composer = try source("src/macos/OrbitApp/Sources/OrbitApp/Views/ComposerView.swift")
        // A local row's status, sentence and Manage entry.
        XCTAssertTrue(composer.contains("let local = choice.local"))
        XCTAssertTrue(composer.contains("local.refusal?.message ?? local.stateLabel"))
        // The one target answer, shared with the hero and the task pins: a provider page or the
        // runner the row is BOUND to (ELSEWHERE included), never a fallback to console.runnerID.
        XCTAssertTrue(composer.contains("SessionProviderChoices.localFixTarget(choice)"))
        XCTAssertTrue(composer.contains("app.route(to: .runner(runnerID))"))
        XCTAssertTrue(composer.contains("console.webProviderURL(slug)"))
        // A model the instance cannot run is listed with the reason and cannot be picked.
        XCTAssertTrue(composer.contains("let blocked = console.localModelRefusal(m.id)"))
        XCTAssertTrue(composer.contains(".disabled(!console.providerCapabilitiesResolved || console.localModelRefusal(m.id) != nil)"))
        // And the same sentence stands beside the composer, with its own pressable fix target.
        XCTAssertTrue(composer.contains("if let local = console.localStartNotice"))
        XCTAssertTrue(composer.contains("if let target = console.localStartFixTarget"))
        XCTAssertTrue(composer.contains("Button(target.actionTitle)"))

        let console = try source("src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift")
        // A new session or the resume of an ended one does not send onto a local row that refuses.
        XCTAssertTrue(console.contains("if !isLive, localStartRefusal != nil { return false }"))
        XCTAssertTrue(console.contains("var localStartRefusal: LocalProviderRefusal? { localProviderStatus?.refusal }"))
        XCTAssertTrue(console.contains("func localModelRefusal(_ id: String) -> LocalProviderRefusal?"))
        // The choice sources carry the runner the session would be on, and the model it would run.
        XCTAssertTrue(console.contains("runnerID: runnerID ?? draftAgent?.runnerId"))
        XCTAssertTrue(console.contains("runnerCapabilities: runnerCapabilities, sessionModel: modelID"))
    }

    func testTheWorkspaceHeroOffersOnlyTheFixThatClearsALocalRefusal() throws {
        let agents = try source("src/macos/OrbitApp/Sources/OrbitApp/Views/AgentsView.swift")
        // Manage (the provider page) and the runner page are both real buttons; the runner one is
        // the bound runner from `localFixTarget`, not `agent.runnerId`.
        XCTAssertTrue(agents.contains("case .providerPage(let slug)? = SessionProviderChoices.localFixTarget(currentProviderChoice)"))
        XCTAssertTrue(agents.contains("draft.webProviderURL(slug)"))
        XCTAssertTrue(agents.contains("case .runner(let runnerID)? = SessionProviderChoices.localFixTarget(currentProviderChoice)"))
        XCTAssertTrue(agents.contains("Text(\"\\(blocker) · Open runner\")"))
        XCTAssertTrue(agents.contains("app.route(to: .runner(runnerID))"))
    }

    func testATasksProviderAndModelAndStartReadTheSameRule() throws {
        let tasks = try source("src/macos/OrbitApp/Sources/OrbitApp/Views/TasksView.swift")
        // The pins are judged on the assignee's runner and the task's own model.
        XCTAssertTrue(tasks.contains("runnerID: runner?.id"))
        XCTAssertTrue(tasks.contains("runnerCapabilities: runner?.capabilities"))
        XCTAssertTrue(tasks.contains("sessionModel: task.model"))
        // A blocked local pin is not written; it opens the row's own fix target — its provider page,
        // or the bound runner, not the assignee's machine.
        XCTAssertTrue(tasks.contains("switch SessionProviderChoices.localFixTarget(row)"))
        XCTAssertTrue(tasks.contains("case .runner(let boundRunnerID)?"))
        XCTAssertTrue(tasks.contains("model.route(to: .runner(boundRunnerID))"))
        // A pressable fix beside the Provider field even when it already shows the blocked value.
        XCTAssertTrue(tasks.contains("blockedPinFixRow(task)"))
        XCTAssertTrue(tasks.contains("Text(target.actionTitle)"))
        XCTAssertTrue(tasks.contains("func providerPinLabel(_ row: ProviderChoice) -> String"))
        // A model the instance cannot run is not a pin, and says why.
        XCTAssertTrue(tasks.contains("if let id, localModelRefusal(task, model: id, provider: runProvider, sources: sources) != nil"))
        // The start button waits on the same refusal.
        XCTAssertTrue(tasks.contains("guard localStartRefusal(task) == nil else { return false }"))
    }

    func testOllamaWearsItsOwnPresetBrandInBothClients() throws {
        let brands = try source("src/macos/OrbitApp/Sources/OrbitApp/Views/BrandMarks.swift")
        XCTAssertTrue(brands.contains("case \"ollama\":") && brands.contains("return .ollama"))
        XCTAssertTrue(brands.contains("case .ollama: return (Color(red: 0.247, green: 0.247, blue: 0.275), Color(red: 0.039, green: 0.039, blue: 0.039))"))
        // The preset table the two clients share carries the same tile the native one draws.
        let presets = try source("src/shared/src/providerPresets.ts")
        XCTAssertTrue(presets.contains("slug: 'ollama'"))
        XCTAssertTrue(presets.contains("brand: { mono: 'O', from: '#3f3f46', to: '#0a0a0a' }"))
    }
}
