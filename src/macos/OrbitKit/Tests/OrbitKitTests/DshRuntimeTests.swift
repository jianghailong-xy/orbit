import Foundation
import XCTest
@testable import OrbitKit

/// DeepSeek Harness in the native clients: runner readiness, the remedies a failed session earns,
/// the pickers' models/levels/modes, and parity with web and the shared permission table.
final class DshRuntimeTests: XCTestCase {
    private let harness = ConfiguredProvider(slug: "deepseek-harness", label: "DeepSeek Harness", runtime: "dsh",
                                             models: [], defaultModel: nil, presetSlug: "deepseek-harness",
                                             modelsFromRuntime: true)
    private let deepseek = ConfiguredProvider(slug: "deepseek", label: "DeepSeek", runtime: "claude",
                                              models: [ConfiguredProviderModel(value: "deepseek-v4-pro", label: "DeepSeek V4 Pro")],
                                              defaultModel: "deepseek-v4-pro", presetSlug: "deepseek")
    private let token = "[\"deepseek\", \"deepseek-v4-pro\"]"
    private var catalog: RunnerModelCatalog {
        RunnerModelCatalog(claude: [RunnerModelInfo(value: "claude-opus-5", label: "Claude Opus 5")],
                           dsh: [RunnerModelInfo(value: token, label: "DeepSeek V4 Pro",
                                                 reasoningLevels: ["off", "low", "high", "max"]),
                                 RunnerModelInfo(value: "[\"deepseek\", \"deepseek-v4-flash\"]", label: "DeepSeek V4 Flash")])
    }

    private func health(installed: Bool = true, error: String? = nil, compatible: Bool = true) -> RunnerEngineHealth {
        RunnerEngineHealth(engine: "dsh", installed: installed, version: installed ? "0.2.0-rc.2" : nil, auth: "unknown",
                           installationError: error, dsh: DshRuntimeHealth(versionCompatible: compatible))
    }

    func testRunnerStateReadsTheServerGateThenTheEngineReport() {
        XCTAssertEqual(DshRuntime.state(capabilities: nil, engines: [health()]), .updateRunner)
        XCTAssertEqual(DshRuntime.state(capabilities: ["provider:antigravity"], engines: [health()]), .updateRunner)
        let cap = ["provider:dsh"]
        XCTAssertEqual(DshRuntime.state(capabilities: cap, engines: nil), .ready)
        XCTAssertEqual(DshRuntime.state(capabilities: cap, engines: [health()]), .ready)
        XCTAssertEqual(DshRuntime.state(capabilities: cap, engines: [health(installed: false)]), .notInstalled)
        XCTAssertEqual(DshRuntime.state(capabilities: cap, engines: [health(installed: false, error: "DSH_PLATFORM_UNSUPPORTED: darwin")]),
                       .unsupportedPlatform)
        XCTAssertEqual(DshRuntime.state(capabilities: cap, engines: [health(installed: false, error: "DSH_NODE_UNSUPPORTED: 22")]),
                       .unsupportedPlatform)
        XCTAssertEqual(DshRuntime.state(capabilities: cap, engines: [health(compatible: false)]), .unsupportedVersion)
        XCTAssertTrue(DshRuntime.RunnerState.notInstalled.installable)
        XCTAssertFalse(DshRuntime.RunnerState.updateRunner.installable)
    }

    func testEngineHealthDecodesTheHarnessFields() throws {
        let json = """
        {"engine":"dsh","installed":false,"auth":"unknown","installationError":"DSH_PLATFORM_UNSUPPORTED: darwin/arm64",
         "dsh":{"versionCompatible":true,"credentialPresent":false,"modelCatalogReadable":false,
                "requestValidation":"unknown","sandboxEnforcement":"unknown","diagnostic":"DSH_PLATFORM_UNSUPPORTED"}}
        """
        let decoded = try JSONDecoder().decode(RunnerEngineHealth.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.installationError, "DSH_PLATFORM_UNSUPPORTED: darwin/arm64")
        XCTAssertEqual(decoded.dsh?.requestValidation, "unknown")
        let catalog = try JSONDecoder().decode(RunnerModelCatalog.self, from: Data("""
        {"dsh":[{"value":"[\\"deepseek\\", \\"deepseek-v4-pro\\"]","label":"DeepSeek V4 Pro","reasoningLevels":["off","max"]}]}
        """.utf8))
        XCTAssertEqual(catalog.models(for: "dsh")?.map(\.name), ["DeepSeek V4 Pro"])
        XCTAssertEqual(catalog.modelInfo(for: "dsh", model: token)?.reasoningLevels, ["off", "max"])
        XCTAssertNil(catalog.models(for: "claude"))
    }

    func testRepairMapsRunnerCodesAndKeyRejectionOnly() {
        XCTAssertEqual(DshRuntime.repair("DSH_CREDENTIAL_MISSING: configure a DeepSeek Harness API key"), .needsKey)
        XCTAssertEqual(DshRuntime.repair("dsh session/prompt (-32603): Invalid API key"), .invalidKey)
        XCTAssertEqual(DshRuntime.repair("dsh session/prompt (-32603): status 401 authentication_error"), .invalidKey)
        XCTAssertEqual(DshRuntime.repair("DeepSeek Harness requires a newer Orbit runner with dsh support; update this runner first"),
                       .updateRunner)
        XCTAssertEqual(DshRuntime.repair("DSH_NOT_INSTALLED: DeepSeek Harness 0.2.0-rc.2 is not installed"), .notInstalled)
        XCTAssertEqual(DshRuntime.repair("DSH_NODE_UNSUPPORTED: node 22"), .unsupportedPlatform)
        XCTAssertNil(DshRuntime.repair("dsh session/prompt (-32603): rate limit exceeded"))
        XCTAssertNil(DshRuntime.repair("Invalid API key"))
        XCTAssertNil(DshRuntime.repair(nil))
        XCTAssertTrue(DshRuntime.Repair.invalidKey.isKeyProblem)
        XCTAssertFalse(DshRuntime.Repair.notInstalled.isKeyProblem)
    }

    func testHarnessKeysResolveToTheirRuntimeAndModelSpace() {
        let configured = [harness, deepseek]
        XCTAssertEqual(AgentDefaults.runtime(for: "deepseek-harness", configured: configured), "dsh")
        XCTAssertEqual(SessionProviderChoices.executingRuntime("deepseek-harness", configured: configured), "dsh")
        XCTAssertEqual(SessionProviderChoices.executingRuntime("deepseek", configured: configured), "claude")
        XCTAssertEqual(AgentDefaults.models(for: "deepseek-harness", catalog: catalog, configured: configured).map(\.id),
                       [token, "[\"deepseek\", \"deepseek-v4-flash\"]"])
        XCTAssertEqual(AgentDefaults.defaultModel(for: "deepseek-harness", catalog: catalog, configured: configured), token)
        // Never a Claude model while no catalogue is reported: the runtime picks.
        XCTAssertEqual(AgentDefaults.defaultModel(for: "deepseek-harness", catalog: nil, configured: configured), "")
        XCTAssertEqual(AgentDefaults.models(for: "deepseek-harness", catalog: nil, configured: configured), [])
    }

    func testThinkingLevelsAreTheModelsOwn() {
        let configured = [harness]
        XCTAssertEqual(AgentDefaults.efforts(for: "deepseek-harness", model: token, catalog: catalog, configured: configured)
                        .map(\.rawValue), ["", "off", "low", "high", "max"])
        XCTAssertEqual(AgentDefaults.efforts(for: "deepseek-harness", model: "[\"deepseek\", \"deepseek-v4-flash\"]",
                                             catalog: catalog, configured: configured), [.default])
        XCTAssertEqual(AgentDefaults.normalizedEffort(Effort(rawValue: "off")!, for: "deepseek-harness", model: token,
                                                      catalog: catalog, configured: configured).rawValue, "off")
        XCTAssertEqual(AgentDefaults.normalizedEffort(.medium, for: "deepseek-harness", model: token,
                                                      catalog: catalog, configured: configured), .default)
        XCTAssertEqual(Effort(rawValue: "off")!.label, "Off")
    }

    func testOnlyTheModesTheSharedTableHonorsAreSelectable() throws {
        let configured = [harness, deepseek]
        XCTAssertEqual(PermissionMode.allCases.filter { AgentDefaults.isSupported($0, provider: "deepseek-harness", configured: configured) },
                       [.default, .auto, .dontAsk])
        for mode in PermissionMode.allCases {
            XCTAssertTrue(AgentDefaults.isSupported(mode, provider: "deepseek", configured: configured))
            XCTAssertTrue(AgentDefaults.isSupported(mode, provider: "claude", configured: configured))
        }
        XCTAssertEqual(AgentDefaults.clampPermissionMode(.plan, for: token, provider: "deepseek-harness", configured: configured), .default)
        XCTAssertEqual(AgentDefaults.clampPermissionMode(.bypass, for: token, provider: "deepseek-harness", configured: configured), .default)
        XCTAssertEqual(AgentDefaults.clampPermissionMode(.acceptEdits, for: token, provider: "deepseek-harness", configured: configured), .default)
        XCTAssertEqual(AgentDefaults.clampPermissionMode(.auto, for: token, provider: "deepseek-harness", configured: configured), .auto)
        XCTAssertEqual(AgentDefaults.clampPermissionMode(.dontAsk, for: token, provider: "deepseek-harness", configured: configured), .dontAsk)
        XCTAssertEqual(AgentDefaults.clampPermissionMode(.plan, for: "deepseek-v4-pro", provider: "deepseek", configured: configured), .plan)

        // The same three the shared table enforces (enums.ts DSH_PERMISSION_MODES).
        let enums = try source("src/shared/src/enums.ts")
        guard let start = enums.range(of: "export const DSH_PERMISSION_MODES"),
              let end = enums.range(of: "];", range: start.upperBound..<enums.endIndex) else {
            return XCTFail("DSH_PERMISSION_MODES moved")
        }
        let declared = enums[start.upperBound..<end.lowerBound]
        let names: [PermissionMode: String] = [.default: "DEFAULT", .auto: "AUTO", .dontAsk: "DONT_ASK",
                                               .plan: "PLAN", .acceptEdits: "ACCEPT_EDITS", .bypass: "BYPASS"]
        for mode in PermissionMode.allCases {
            XCTAssertEqual(declared.contains("PermissionMode.\(names[mode]!),"), DshRuntime.permissionModes.contains(mode),
                           "\(mode) differs from the shared table")
        }
    }

    func testPickerRowsCarryReadinessAndTheConnectOffer() {
        let configured = [harness, deepseek]
        let ready = SessionProviderChoices.choices(configured: configured, catalog: catalog, dshState: .ready)
        let row = ready.first { $0.slug == "deepseek-harness" }!
        XCTAssertNil(row.unavailable)
        XCTAssertEqual(row.labelDetail, "Harness")
        XCTAssertEqual(row.modelLabel, "DeepSeek V4 Pro")
        XCTAssertEqual(ready.first { $0.slug == "deepseek" }?.labelDetail, "Claude Code")
        XCTAssertFalse(ready.contains { $0.setup })

        for (state, reason) in [(DshRuntime.RunnerState.updateRunner, "Update runner"), (.notInstalled, "Not installed"),
                                (.unsupportedPlatform, "Not supported here"), (.unsupportedVersion, "Unsupported version")] {
            let blocked = SessionProviderChoices.choices(configured: configured, catalog: catalog, dshState: state)
            XCTAssertEqual(blocked.first { $0.slug == "deepseek-harness" }?.unavailable, reason)
            XCTAssertEqual(blocked.first { $0.slug == "deepseek-harness" }?.fixEngine, "dsh")
            XCTAssertNil(blocked.first { $0.slug == "deepseek" }?.unavailable)
        }

        let none = SessionProviderChoices.choices(configured: [deepseek], catalog: catalog, dshState: .ready)
        let setup = none.first { $0.setup }!
        XCTAssertEqual(setup.unavailable, "Add API key")
        XCTAssertEqual(setup.fixEngine, DshRuntime.connectFix)
        XCTAssertFalse(SessionProviderChoices.choices(configured: [deepseek], dshState: .updateRunner).contains { $0.setup })
        XCTAssertFalse(SessionProviderChoices.choices(configured: [deepseek], dshState: nil).contains { $0.setup })
        XCTAssertFalse(SessionProviderChoices.sameRuntime("claude", in: none, configured: [deepseek]).contains { $0.setup })

        let second = ConfiguredProvider(slug: "deepseek-harness-2", label: "Work key", runtime: "dsh", models: [],
                                        defaultModel: nil, presetSlug: "deepseek-harness", modelsFromRuntime: true)
        let all = [harness, second, deepseek]
        XCTAssertEqual(SessionProviderChoices.sameRuntime(
            "deepseek-harness", in: SessionProviderChoices.choices(configured: all, dshState: .ready), configured: all).map(\.slug),
            ["deepseek-harness", "deepseek-harness-2"])
    }

    func testRunnerPageRowAndSlashScope() {
        XCTAssertEqual(RunnerPageFormat.engineName("dsh"), "DeepSeek Harness")
        XCTAssertTrue(RunnerPageFormat.engineOrder.contains("dsh"))
        XCTAssertEqual(RunnerPageFormat.engineStatus(health())?.text, "Uses API keys")
        XCTAssertEqual(RunnerPageFormat.engineStatus(health(installed: false))?.text, "Not installed")
        XCTAssertEqual(RunnerPageFormat.engineStatus(health(compatible: false))?.text, "Unsupported version")
        let items = [SlashCommandInfo(name: "review", description: nil, type: "command", provider: "claude")]
        XCTAssertEqual(ComposerSlash.forProvider(items: items, provider: "dsh"), [])
    }

    /// Native and web say the same things (web `lib/dshRuntime.ts`, `Transcript.tsx`).
    func testCopyMatchesWeb() throws {
        let lib = try source("src/web/src/lib/dshRuntime.ts")
        for state in [DshRuntime.RunnerState.updateRunner, .unsupportedPlatform, .notInstalled, .unsupportedVersion] {
            XCTAssertTrue(lib.contains("'\(state.label!)'"), "web lost \(state.label!)")
            XCTAssertTrue(lib.contains("'\(state.hint!)'"), "web lost \(state.hint!)")
        }
        for phrase in DshRuntime.keyRejected { XCTAssertTrue(lib.contains("'\(phrase)'"), "web lost \(phrase)") }
        let transcript = try source("src/web/src/components/Transcript.tsx")
        for repair in [DshRuntime.Repair.needsKey, .invalidKey, .updateRunner] {
            XCTAssertTrue(transcript.contains("'\(repair.title)'"), "web lost \(repair.title)")
        }
        for repair in [DshRuntime.Repair.needsKey, .invalidKey, .notInstalled] {
            XCTAssertTrue(transcript.contains("'\(repair.detail)'"), "web lost \(repair.detail)")
        }
        let choices = try source("src/web/src/lib/sessionProviderChoices.ts")
        for text in ["'Add API key'", "labelDetail: 'Harness'", "labelDetail: 'Claude Code'"] {
            XCTAssertTrue(choices.contains(text), "web picker lost \(text)")
        }
    }

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
}
