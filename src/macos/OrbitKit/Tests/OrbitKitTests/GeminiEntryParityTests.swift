import Foundation
import XCTest
@testable import OrbitKit

/// Native and web offer the same Antigravity entry and the same remedies. The UI is compiled by
/// client CI; these checks also keep its action wiring visible to Linux's OrbitKit suite.
final class GeminiEntryParityTests: XCTestCase {
    private func source(_ relative: String) throws -> String {
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let file = directory.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: file.path) {
                return try String(contentsOf: file, encoding: .utf8)
            }
            directory.deleteLastPathComponent()
        }
        XCTFail("Missing counterpart: \(relative)")
        throw CocoaError(.fileReadNoSuchFile)
    }

    func testPickerLabelsAndReadinessMatchWeb() throws {
        let web = try source("src/web/src/lib/sessionProviderChoices.ts")
        for text in ["env key", "Antigravity CLI", "Update runner", "Not installed"] {
            XCTAssertTrue(web.contains(text), "web picker lost \(text)")
        }
        XCTAssertTrue(web.contains("PROVIDER_PRESETS"), "the no-catalogue label comes from Gemini's preset")
        XCTAssertTrue(try source("src/shared/src/providerPresets.ts").contains("Gemini 3.8 Flash"))
        XCTAssertTrue(web.contains("antigravityKeyAvailable"))
        XCTAssertTrue(web.contains("antigravityBlocker"))
        let native = try source("src/macos/OrbitApp/Sources/OrbitApp/Views/AgentsView.swift")
        XCTAssertTrue(native.contains("agent.antigravityKeyAvailableByRunner?[draft.runnerID"))
        // How Antigravity signs in is the provider's to say, in the composer's Provider menu — the
        // hero names the engine alone.
        let composer = try source("src/macos/OrbitApp/Sources/OrbitApp/Views/ComposerView.swift")
        XCTAssertTrue(composer.contains("[choice.label, choice.labelDetail]"), "the Provider menu renders the choice's small label")
    }

    func testRepairCopyMatchesWeb() throws {
        let web = try source("src/web/src/components/Transcript.tsx")
        for repair in [EngineAuth.AntigravityRepair.needsKey, .updateRunner] {
            XCTAssertTrue(web.contains(EngineAuth.antigravityTitle(repair, runnerName: nil)))
        }
        XCTAssertTrue(web.contains(EngineAuth.antigravityBody(.needsKey, runnerName: nil, runnerVersion: nil)))
        XCTAssertTrue(web.contains(EngineAuth.antigravityBody(.notInstalled, runnerName: nil, runnerVersion: nil)))
        XCTAssertTrue(web.contains("Antigravity CLI isn't installed on ${machine}"))
        XCTAssertTrue(web.contains("${machine} runs Orbit runner ${help.runnerVersion || 'an unknown version'}; Antigravity needs 0.1.209 or newer. The runner updates itself when no session is running on it, and this session starts then."))
        for label in ["Connect Gemini", "Switch to Gemini", "Install", "Open in Infrastructure"] {
            XCTAssertTrue(web.contains(label))
        }
        XCTAssertTrue(web.contains("export function antigravityRepair"))
    }

    func testNativeRepairsAreWiredToProvidersSwitchAndInstall() throws {
        let native = try source("src/macos/OrbitApp/Sources/OrbitApp/Views/RunnerSignInView.swift")
        XCTAssertTrue(native.contains("openURL(await console.connectGeminiURL())"))
        XCTAssertTrue(native.contains("await console.selectProvider(choice.slug)"))
        XCTAssertTrue(native.contains("await console.installAntigravity()"))
        XCTAssertTrue(native.contains(".disabled(!console.canInstallAntigravity)"))
        // Its machine's Antigravity page, in the app — where the web card goes to that machine's
        // engine row on /infrastructure — rather than the web's old /providers?runner=&engine=.
        XCTAssertTrue(native.contains("Button(\"Open in Infrastructure\") {"))
        XCTAssertTrue(native.contains("app.openRunnerEngine(runnerID, engine: \"antigravity\")"))
        XCTAssertFalse(native.contains("ProvidersURL"))
        XCTAssertTrue(native.contains("EngineAuth.antigravityRepair(message) == .needsKey"))
        XCTAssertTrue(native.contains(".task { await console.refreshAntigravityRepairContext() }"))
        XCTAssertTrue(native.contains("if phase == .active { Task { await console.refreshAntigravityRepairContext() } }"))
        XCTAssertTrue(native.contains(".task(id: console.runnerInstall?.inFlight == true)"))
        XCTAssertTrue(native.contains("await console.refreshAntigravityRunner()"))
        XCTAssertFalse(native.contains("workspace's environment variables"))
        let console = try source("src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift")
        XCTAssertFalse(console.contains("func providersURL"), "no way left to the web's /providers?runner=&engine=")
        XCTAssertTrue(console.contains("providerSwitchChoices.first"))
        XCTAssertTrue(console.contains("api.personalProviders()"))
        XCTAssertTrue(console.contains("providers/new/gemini"))
        XCTAssertTrue(console.contains("api.installAntigravity(runnerID)"))
        XCTAssertTrue(console.contains("runnerInstall = try await api.installAntigravity(runnerID)"))
        XCTAssertTrue(console.contains("showTransientStatus(\"Installing Antigravity CLI…\")"))
        XCTAssertTrue(console.contains("func showTransientStatus(_ msg: String)"),
                      "the install confirmation calls the console's existing toast helper")
        XCTAssertTrue(console.contains("runnerInstall = runner.install"))
        XCTAssertTrue(console.contains("guard let runnerID, canInstallAntigravity else"))
        XCTAssertTrue(console.contains("runnerAntigravity?.supported == true"))
        XCTAssertTrue(console.contains("runnerInstall?.inFlight != true"))
        XCTAssertTrue(console.contains("configured?.presetSlug == \"gemini\" && configured?.runtime == \"antigravity\""),
                      "Switch to Gemini must not select a custom Antigravity endpoint")
        XCTAssertTrue(console.contains("$0.presetSlug == \"gemini\" && $0.runtime == \"antigravity\""),
                      "Connect Gemini opens only an existing Gemini preset's editor")
        let transcript = try source("src/macos/OrbitApp/Sources/OrbitApp/Views/Console/ConsoleView.swift")
        XCTAssertTrue(transcript.contains("console.queuedAntigravityRepair"))
        XCTAssertTrue(transcript.contains("EngineAuth.antigravityRepair(message)"))
        XCTAssertTrue(transcript.contains("console.executesAntigravity"))
    }
}
