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

    /// D2: the real DeepSeek 401 (P6) is a bad key; a rate limit, a 5xx or a dropped connection is not.
    func testRepairReadsTheRealDeepSeekKeyRejection() {
        let real = "dsh session/prompt (-32603): Internal error: turn failed: Authentication Fails, Your api key: ****0000 is invalid (request_id: 64d2f58d-15e2-4744-aafd-d463abb21741) "
        XCTAssertEqual(DshRuntime.repair("DSH_CREDENTIAL_INVALID: " + real), .invalidKey)
        XCTAssertEqual(DshRuntime.repair(real), .invalidKey)
        XCTAssertEqual(DshRuntime.repair("dsh session/prompt (-32603): Internal error: turn failed: Your API key: sk-****abcd is invalid"),
                       .invalidKey)
        for message in [
            "dsh session/prompt (-32603): Internal error: turn failed: Rate Limit Reached",
            "dsh session/prompt (-32603): Internal error: turn failed: synthetic-429",
            "dsh session/prompt (-32603): Internal error: turn failed: 503 Service Unavailable",
            "dsh session/prompt (-32603): Internal error: turn failed: Insufficient Balance",
            "dsh session/prompt (-32603): Internal error: turn failed: fetch failed: socket hang up (ECONNRESET)",
            "dsh ACP transport closed: EOF",
            "DSH_REQUEST_FAILED: dsh session/prompt (-32603): Internal error: turn failed: invalid api key? {\"error\":{\"statusCode\":503}}",
        ] {
            XCTAssertNil(DshRuntime.repair(message), message)
        }
    }

    /// The pattern is the same text in web and the runner.
    func testKeyRejectedPatternMatchesWebAndRunner() throws {
        XCTAssertTrue(try source("src/web/src/lib/dshRuntime.ts").contains("/\(DshRuntime.keyRejectedPattern)/"))
        XCTAssertTrue(try source("src/runner-go/dsh_health.go").contains("`\(DshRuntime.keyRejectedPattern)`"))
    }

    /// The model space is the (engine, key) pair's (docs/provider-engine-contract.md §2.2): DeepSeek
    /// Harness reads its runner's ACP catalogue whichever DeepSeek key it spends — a row still on the
    /// retired `dsh` runtime or the DeepSeek key Claude Code runs too — and the same key on Claude Code
    /// reads its own table.
    func testHarnessReadsItsCatalogueWhicheverDeepSeekKeyItSpends() {
        let configured = [harness, deepseek]
        // A row from before the merge still starts sessions on Harness by default.
        XCTAssertEqual(AgentDefaults.runtime(for: "deepseek-harness", configured: configured), "dsh")
        XCTAssertEqual(ProviderEngines.defaultEngine(ofProvider: "deepseek", configured: configured), "claude")
        for key in ["deepseek-harness", "deepseek"] {
            XCTAssertEqual(AgentDefaults.models(engine: "dsh", provider: key, catalog: catalog, configured: configured)
                .map(\.id), [token, "[\"deepseek\", \"deepseek-v4-flash\"]"], key)
            XCTAssertEqual(AgentDefaults.defaultModel(engine: "dsh", provider: key, catalog: catalog,
                                                      configured: configured), token, key)
            // Never a Claude model while no catalogue is reported: the runtime picks.
            XCTAssertEqual(AgentDefaults.defaultModel(engine: "dsh", provider: key, catalog: nil,
                                                      configured: configured), "", key)
            XCTAssertEqual(AgentDefaults.friendlyName("", engine: "dsh", provider: key, catalog: nil,
                                                      configured: configured), "Picked by DeepSeek Harness")
            XCTAssertEqual(AgentDefaults.models(engine: "dsh", provider: key, catalog: nil, configured: configured), [])
        }
        // The same DeepSeek key on Claude Code is Claude Code's: DeepSeek's own models, not the ACP tokens.
        XCTAssertEqual(AgentDefaults.models(engine: "claude", provider: "deepseek", catalog: catalog,
                                            configured: configured).map(\.id), ["deepseek-v4-pro"])
        XCTAssertEqual(AgentDefaults.friendlyName(token, catalog: catalog), "DeepSeek V4 Pro")
    }

    func testThinkingLevelsAreTheModelsOwn() {
        let configured = [harness, deepseek]
        for key in ["deepseek-harness", "deepseek"] {
            XCTAssertEqual(AgentDefaults.efforts(for: "dsh", provider: key, model: token, catalog: catalog,
                                                 configured: configured).map(\.rawValue), ["", "off", "low", "high", "max"])
            XCTAssertEqual(AgentDefaults.efforts(for: "dsh", provider: key, model: "[\"deepseek\", \"deepseek-v4-flash\"]",
                                                 catalog: catalog, configured: configured), [.default])
            XCTAssertEqual(AgentDefaults.normalizedEffort(Effort(rawValue: "off")!, for: "dsh", provider: key, model: token,
                                                          catalog: catalog, configured: configured).rawValue, "off")
            XCTAssertEqual(AgentDefaults.normalizedEffort(.medium, for: "dsh", provider: key, model: token,
                                                          catalog: catalog, configured: configured), .default)
        }
        XCTAssertEqual(Effort(rawValue: "off")!.label, "Off")
    }

    func testOnlyTheModesTheSharedTableHonorsAreSelectable() throws {
        let configured = [harness, deepseek]
        XCTAssertEqual(PermissionMode.allCases.filter { AgentDefaults.isSupported($0, engine: "dsh") },
                       [.default, .auto, .dontAsk])
        for mode in PermissionMode.allCases {
            // The same DeepSeek key on Claude Code takes every mode: the engine decides, not the key.
            XCTAssertTrue(AgentDefaults.isSupported(mode, engine: "claude"))
        }
        for key in ["deepseek-harness", "deepseek"] {
            XCTAssertEqual(AgentDefaults.clampPermissionMode(.plan, for: token, engine: "dsh", provider: key,
                                                             configured: configured), .default)
            XCTAssertEqual(AgentDefaults.clampPermissionMode(.bypass, for: token, engine: "dsh", provider: key,
                                                             configured: configured), .default)
            XCTAssertEqual(AgentDefaults.clampPermissionMode(.acceptEdits, for: token, engine: "dsh", provider: key,
                                                             configured: configured), .default)
            XCTAssertEqual(AgentDefaults.clampPermissionMode(.auto, for: token, engine: "dsh", provider: key,
                                                             configured: configured), .auto)
            XCTAssertEqual(AgentDefaults.clampPermissionMode(.dontAsk, for: token, engine: "dsh", provider: key,
                                                             configured: configured), .dontAsk)
        }
        XCTAssertEqual(AgentDefaults.clampPermissionMode(.plan, for: "deepseek-v4-pro", engine: "claude",
                                                         provider: "deepseek", configured: configured), .plan)

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
        // A row still on the retired runtime, the DeepSeek key, and a second DeepSeek key: every one of
        // them is Harness's to run (`engines`), each named by its own label with no engine beside it.
        let served = ConfiguredProvider(slug: "deepseek", label: "DeepSeek", runtime: "claude", models: deepseek.models,
                                        defaultModel: "deepseek-v4-pro", presetSlug: "deepseek",
                                        engines: ["claude", "opencode", "dsh"])
        let configured = [harness, served]
        let ready = SessionProviderChoices.providers(for: "dsh", sources: ChoiceSources(configured: configured, catalog: catalog,
                                                                                        dshState: .ready))
        XCTAssertEqual(ready.map(\.slug), ["deepseek-harness", "deepseek"])
        XCTAssertTrue(ready.allSatisfy { $0.unavailable == nil && $0.labelDetail == nil && $0.kind == .key })
        XCTAssertEqual(ready.map(\.modelLabel), ["DeepSeek V4 Pro", "DeepSeek V4 Pro"])

        for (state, reason) in [(DshRuntime.RunnerState.updateRunner, "Update runner"), (.notInstalled, "Not installed"),
                                (.unsupportedPlatform, "Not supported here"), (.unsupportedVersion, "Unsupported version")] {
            let blocked = SessionProviderChoices.providers(for: "dsh", sources: ChoiceSources(configured: configured,
                                                                                              catalog: catalog, dshState: state))
            XCTAssertTrue(blocked.allSatisfy { $0.unavailable == reason && $0.fixEngine == "dsh" })
            XCTAssertNil(SessionProviderChoices.providers(for: "claude", sources: ChoiceSources(configured: configured,
                                                                                                dshState: state))
                .first { $0.slug == "deepseek" }?.unavailable)
        }

        // No DeepSeek key: the hero offers the connection, which no Provider menu lists.
        let none = SessionProviderChoices.engines(sources: ChoiceSources(configured: [], catalog: catalog, dshState: .ready))
        let connect = none.first { $0.slug == "dsh" }!
        XCTAssertEqual(connect.unavailable, "Connect a DeepSeek key")
        XCTAssertEqual(connect.fixEngine, DshRuntime.connectFix)
        XCTAssertNil(connect.provider)
        XCTAssertNil(SessionProviderChoices.engines(sources: ChoiceSources(configured: [], dshState: .updateRunner))
            .first { $0.slug == "dsh" })
        XCTAssertNil(SessionProviderChoices.engines(sources: ChoiceSources(configured: [], dshState: nil))
            .first { $0.slug == "dsh" })
    }

    func testHeroGroupsEveryDeepSeekKeyUnderOneEngine() {
        let configured = [harness, deepseek]
        let engines = SessionProviderChoices.engines(sources: ChoiceSources(configured: configured, catalog: catalog,
                                                                            dshState: .ready))
        let dsh = engines.first { $0.slug == "dsh" }!
        XCTAssertEqual(dsh.label, "DeepSeek Harness")
        XCTAssertEqual(dsh.brandKey, "deepseek")
        XCTAssertEqual(dsh.provider?.slug, "deepseek-harness")
        XCTAssertNil(dsh.unavailable)
        // The retired row runs on Harness by default; on Claude Code it is not listed by an older server
        // that has not said it is (its `engines`), and the DeepSeek key is listed there.
        XCTAssertEqual(engines.first { $0.slug == "claude" }?.providers.map(\.slug), ["claude", "deepseek"])
    }

    /// Harness's approval bridge answers each ask once and drops remember rules, so its cards offer
    /// Allow / Deny only; every other runtime keeps Allow & remember.
    func testApprovalRememberIsNotOfferedOnHarness() throws {
        XCTAssertFalse(Approvals.rememberOffered(runtime: "dsh"))
        for runtime in ["claude", "codex", "kimi", "opencode", "antigravity"] {
            XCTAssertTrue(Approvals.rememberOffered(runtime: runtime), runtime)
        }
        // The card and the send path both read it from the session's engine, never its key.
        let card = try source("src/macos/OrbitApp/Sources/OrbitApp/Views/ApprovalCards.swift")
        XCTAssertTrue(card.contains("guard Approvals.rememberOffered(runtime: console.engine) else { return [] }"))
        let console = try source("src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift")
        XCTAssertTrue(console.contains("if remember, behavior == .allow, !executesDsh, let input = approval.input {"))
        XCTAssertTrue(console.contains("var executesDsh: Bool { engine == \"dsh\" }"))
    }

    func testRunnerPageRowAndSlashScope() {
        XCTAssertEqual(RunnerPageFormat.engineName("dsh"), "DeepSeek Harness")
        XCTAssertTrue(RunnerPageFormat.engineOrder.contains("dsh"))
        XCTAssertEqual(RunnerPageFormat.engineStatus(health())?.text, "Uses API keys")
        XCTAssertEqual(RunnerPageFormat.engineStatus(health(installed: false))?.text, "Not installed")
        XCTAssertEqual(RunnerPageFormat.engineStatus(health(compatible: false))?.text, "Unsupported version")
        let items = [SlashCommandInfo(name: "review", description: nil, type: "command", provider: "claude")]
        XCTAssertEqual(ComposerSlash.forEngine(items: items, engine: "dsh"), [])
        // The same DeepSeek key on Claude Code has Claude Code's commands: the engine decides.
        XCTAssertEqual(ComposerSlash.forEngine(items: items, engine: "claude"), items)
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
        for repair in [DshRuntime.Repair.needsKey, .notInstalled] {
            XCTAssertTrue(transcript.contains("'\(repair.detail)'"), "web lost \(repair.detail)")
        }
        // A rejected key is named at both ends (`the DeepSeek key “DeepSeek 2”`), so the web's sentence is a
        // template with the name in it, and "the DeepSeek key" where there is none.
        let template = "Update ${help.keyName ?? 'the DeepSeek key'} in Infrastructure, then send your message again."
        XCTAssertTrue(transcript.contains("`\(template)`"), "web lost \(template)")
        let slot = "${help.keyName ?? 'the DeepSeek key'}"
        XCTAssertEqual(DshRuntime.Repair.invalidKey.detail, template.replacingOccurrences(of: slot, with: "the DeepSeek key"))
        let named = "the DeepSeek key “DeepSeek 2”"
        XCTAssertEqual(DshRuntime.Repair.invalidKey.detail(keyName: named), template.replacingOccurrences(of: slot, with: named))
        // The picker: DeepSeek Harness without a DeepSeek key says what the web's says, and connects one at
        // the web's DeepSeek connect page.
        let choices = try source("src/web/src/lib/sessionProviderChoices.ts")
        let connect = try XCTUnwrap(SessionProviderChoices.engines(sources: ChoiceSources(configured: [], dshState: .ready))
            .first { $0.slug == "dsh" }?.unavailable)
        XCTAssertTrue(choices.contains("unavailable: '\(connect)'"), "web picker lost \(connect)")
        XCTAssertTrue(lib.contains("export const DSH_CONNECT_HREF = '/providers/new/\(DshRuntime.keyPreset)';"))
        // The engine's name is the shared table's (ENGINE_CLI_NAMES).
        let names = try source("src/shared/src/providerEngines.ts")
        XCTAssertTrue(names.contains("[AgentProvider.DSH]: '\(SessionProviderChoices.engineTitle("dsh"))',"))
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
