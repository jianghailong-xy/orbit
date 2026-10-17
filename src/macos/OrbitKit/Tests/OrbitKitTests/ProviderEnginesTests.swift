import Foundation
import XCTest
@testable import OrbitKit

/// The compatibility table (docs/provider-engine-contract.md §2.1), case for case the shared
/// `providerEngines.spec.ts` — which this mirrors, so the three implementations answer alike — then the
/// pickers' reading of a provider slug (web `workspaceDefaults`).
final class ProviderEnginesTests: XCTestCase {
    private func key(_ runtime: String?, _ presetSlug: String?, _ baseUrl: String,
                     _ subscriptionToken: Bool = false) -> ProviderEngines.Credential {
        .key(runtime: runtime, presetSlug: presetSlug, baseUrl: baseUrl, subscriptionToken: subscriptionToken)
    }

    private var deepseek: ProviderEngines.Credential { key("claude", "deepseek", "https://api.deepseek.com/anthropic") }
    private var glm: ProviderEngines.Credential { key("claude", "glm", "https://api.z.ai/api/anthropic") }

    // MARK: engines

    func testListsEveryEngineOnceEachUnderItsCLIName() throws {
        XCTAssertEqual(ProviderEngines.all, ["claude", "codex", "kimi", "antigravity", "opencode", "dsh"])
        XCTAssertEqual(Dictionary(uniqueKeysWithValues: ProviderEngines.names.map { ($0.engine, $0.name) }), [
            "claude": "Claude Code", "codex": "Codex", "kimi": "Kimi Code", "antigravity": "Antigravity CLI",
            "opencode": "OpenCode", "dsh": "DeepSeek Harness",
        ])
        for engine in ProviderEngines.all { XCTAssertTrue(ProviderEngines.isEngine(engine)) }
        XCTAssertFalse(ProviderEngines.isEngine("deepseek-harness"))
        XCTAssertFalse(ProviderEngines.isEngine(""))
        XCTAssertFalse(ProviderEngines.isEngine(nil))
        // The same six values the shared enum has, so no engine is missing on either side.
        let enums = try source("src/shared/src/enums.ts")
        for engine in ProviderEngines.all {
            XCTAssertTrue(enums.contains("= '\(engine)'"), "AgentProvider has no '\(engine)'")
        }
    }

    // MARK: credentialEngines

    func testRunsASignInAPoolAndOpenCodeConfigOnTheirOwnEngineOnly() {
        for engine in ["claude", "codex", "kimi", "antigravity"] {
            XCTAssertEqual(ProviderEngines.credentialEngines(.login(engine: engine)), [engine])
        }
        XCTAssertEqual(ProviderEngines.credentialEngines(.pool(engine: "claude")), ["claude"])
        XCTAssertEqual(ProviderEngines.credentialEngines(.pool(engine: "codex")), ["codex"])
        XCTAssertEqual(ProviderEngines.credentialEngines(.opencode), ["opencode"])
    }

    func testRunsAKeyOnItsDialectsOwnEngineFirstThenOpenCode() {
        XCTAssertEqual(ProviderEngines.credentialEngines(glm), ["claude", "opencode"])
        XCTAssertEqual(ProviderEngines.credentialEngines(key("codex", "openai", "https://api.openai.com/v1")),
                       ["codex", "opencode"])
        XCTAssertEqual(ProviderEngines.credentialEngines(key("kimi", "moonshot", "https://api.moonshot.ai/v1")),
                       ["kimi", "opencode"])
        XCTAssertEqual(ProviderEngines.credentialEngines(key("antigravity", "gemini",
                                                             "https://generativelanguage.googleapis.com")),
                       ["antigravity", "opencode"])
    }

    func testAddsDeepSeekHarnessForADeepSeekKeyPresetOrCustomHostAlike() {
        XCTAssertEqual(ProviderEngines.credentialEngines(deepseek), ["claude", "opencode", "dsh"])
        XCTAssertEqual(ProviderEngines.credentialEngines(key("claude", nil, "https://api.deepseek.com/anthropic")),
                       ["claude", "opencode", "dsh"])
        XCTAssertEqual(ProviderEngines.credentialEngines(key("claude", nil,
                                                             "https://api.deepseek.com.evil.example/anthropic")),
                       ["claude", "opencode"])
    }

    func testKeepsARowStillOnTheDshRuntimeOnDeepSeekHarnessByDefault() {
        XCTAssertEqual(ProviderEngines.credentialEngines(key("dsh", "deepseek-harness",
                                                             "https://api.deepseek.com/anthropic")),
                       ["dsh", "claude", "opencode"])
        // A custom endpoint chosen for Harness (a mock, a proxy) ran on it whatever its host.
        XCTAssertEqual(ProviderEngines.credentialEngines(key("dsh", nil, "http://127.0.0.1:8787/anthropic")),
                       ["dsh", "claude", "opencode"])
    }

    func testRunsAClaudeSubscriptionTokenOnClaudeCodeAlone() {
        XCTAssertEqual(ProviderEngines.credentialEngines(key("claude", "anthropic", "https://api.anthropic.com", true)),
                       ["claude"])
        XCTAssertEqual(ProviderEngines.credentialEngines(key("claude", "deepseek", "https://api.deepseek.com/anthropic",
                                                             true)), ["claude"])
        XCTAssertEqual(ProviderEngines.credentialEngines(key("codex", "openai", "https://api.openai.com/v1", true)), [])
        // The token rule outranks a legacy Harness row's default: Harness cannot spend a subscription.
        let legacyToken = key("dsh", "deepseek-harness", "https://api.deepseek.com/anthropic", true)
        XCTAssertEqual(ProviderEngines.credentialEngines(legacyToken), ["claude"])
        XCTAssertEqual(ProviderEngines.defaultEngine(of: legacyToken), "claude")
    }

    func testRunsAKeyOnAProtocolNoEngineSpeaksNowhere() {
        XCTAssertEqual(ProviderEngines.credentialEngines(key("opencode", nil, "https://x.example")), [])
        XCTAssertNil(ProviderEngines.defaultEngine(of: key("opencode", nil, "https://x.example")))
    }

    // MARK: defaultEngineOf

    func testTheDefaultIsTheEngineTheCredentialRanOnBeforeTheSplit() {
        XCTAssertEqual(ProviderEngines.defaultEngine(of: .login(engine: "kimi")), "kimi")
        XCTAssertEqual(ProviderEngines.defaultEngine(of: .pool(engine: "codex")), "codex")
        XCTAssertEqual(ProviderEngines.defaultEngine(of: .opencode), "opencode")
        XCTAssertEqual(ProviderEngines.defaultEngine(of: deepseek), "claude")
        XCTAssertEqual(ProviderEngines.defaultEngine(of: key("dsh", "deepseek-harness",
                                                             "https://api.deepseek.com/anthropic")), "dsh")
        XCTAssertEqual(ProviderEngines.defaultEngine(of: key("antigravity", "gemini",
                                                             "https://generativelanguage.googleapis.com")),
                       "antigravity")
    }

    // MARK: isEngineCompatible

    func testPairsAnEngineWithACredentialOnlyWhereTheTableAllowsIt() {
        XCTAssertTrue(ProviderEngines.isCompatible("dsh", deepseek))
        XCTAssertTrue(ProviderEngines.isCompatible("opencode", deepseek))
        XCTAssertFalse(ProviderEngines.isCompatible("dsh", glm))
        XCTAssertFalse(ProviderEngines.isCompatible("codex", glm))
        XCTAssertFalse(ProviderEngines.isCompatible("claude", .login(engine: "codex")))
        XCTAssertFalse(ProviderEngines.isCompatible("opencode", key("claude", "anthropic", "https://api.anthropic.com", true)))
        XCTAssertFalse(ProviderEngines.isCompatible("deepseek", deepseek))
    }

    // MARK: isDeepSeekKey

    func testIsTheTwoPresetsElseACustomEndpointOnApiDeepseekCom() {
        XCTAssertTrue(ProviderEngines.isDeepSeekKey(presetSlug: "deepseek", baseUrl: "https://api.deepseek.com/anthropic"))
        XCTAssertTrue(ProviderEngines.isDeepSeekKey(presetSlug: "deepseek-harness",
                                                    baseUrl: "https://api.deepseek.com/anthropic"))
        XCTAssertTrue(ProviderEngines.isDeepSeekKey(presetSlug: nil, baseUrl: "https://API.DeepSeek.com/v1"))
        XCTAssertFalse(ProviderEngines.isDeepSeekKey(presetSlug: nil, baseUrl: "https://api.deepseek.com.evil.example/v1"))
        XCTAssertFalse(ProviderEngines.isDeepSeekKey(presetSlug: nil, baseUrl: "not a url"))
        XCTAssertFalse(ProviderEngines.isDeepSeekKey(presetSlug: "moonshot", baseUrl: "https://api.deepseek.com/anthropic"))
    }

    // MARK: a provider slug, as the pickers read it (web `providerEngines`, `sessionEngineOf`, `sessionPick`)

    private let deepseekRow = ConfiguredProvider(slug: "deepseek", label: "DeepSeek", runtime: "claude",
                                                 presetSlug: "deepseek", engines: ["claude", "opencode", "dsh"])
    private let maxRow = ConfiguredProvider(slug: "claude-max", label: "Claude Max", runtime: "claude",
                                            presetSlug: "anthropic", engines: ["claude"])

    func testAProviderRunsWhereTheServerSaysASignInOnItsOwnEngine() {
        let configured = [deepseekRow, maxRow]
        XCTAssertEqual(ProviderEngines.engines(ofProvider: "deepseek", configured: configured), ["claude", "opencode", "dsh"])
        XCTAssertEqual(ProviderEngines.engines(ofProvider: "claude-max", configured: configured), ["claude"])
        XCTAssertEqual(ProviderEngines.engines(ofProvider: "codex", configured: configured), ["codex"])
        XCTAssertEqual(ProviderEngines.engines(ofProvider: "opencode", configured: configured), ["opencode"])
        // The legacy built-in `dsh`: DeepSeek Harness on the key its workspace's environment holds.
        XCTAssertEqual(ProviderEngines.engines(ofProvider: "dsh", configured: configured), ["dsh"])
        // Removed, turned off, or not loaded yet: nothing here can say.
        XCTAssertEqual(ProviderEngines.engines(ofProvider: "gone", configured: configured), [])
        XCTAssertEqual(ProviderEngines.engines(ofProvider: nil, configured: configured), [])
        XCTAssertNil(ProviderEngines.defaultEngine(ofProvider: "gone", configured: configured))
    }

    func testARowFromAnOlderServerRunsOnItsProtocolAndOpenCodeWhereItSaid() {
        let older = ConfiguredProvider(slug: "glm", label: "Z.AI (GLM)", runtime: "claude", runsOnOpenCode: true)
        XCTAssertEqual(ProviderEngines.of(older), ["claude", "opencode"])
        let harness = ConfiguredProvider(slug: "deepseek-harness", label: "DeepSeek Harness", runtime: "dsh")
        XCTAssertEqual(ProviderEngines.of(harness), ["dsh"])
        let unknown = ConfiguredProvider(slug: "odd", label: "Odd", runtime: "opencode")
        XCTAssertEqual(ProviderEngines.of(unknown), [])
        // A pool read as a provider runs on its own engine alone.
        XCTAssertEqual(ProviderEngines.of(ConfiguredProvider(slug: "team", label: "Team", runtime: "codex")), ["codex"])
        // An engine name the server sends that this build does not know is dropped, not run.
        XCTAssertEqual(ProviderEngines.of(ConfiguredProvider(slug: "k", label: "K", runtime: "claude",
                                                             engines: ["claude", "future-cli"])), ["claude"])
    }

    func testASessionsEngineIsTheOneItRecordedElseWhereItsProviderRan() {
        let configured = [deepseekRow]
        XCTAssertEqual(ProviderEngines.sessionEngine("dsh", provider: "deepseek", configured: configured), "dsh")
        XCTAssertEqual(ProviderEngines.sessionEngine(nil, provider: "deepseek", configured: configured), "claude")
        XCTAssertEqual(ProviderEngines.sessionEngine(nil, provider: "opencode", configured: configured), "opencode")
        XCTAssertEqual(ProviderEngines.sessionEngine("unknown", provider: "codex", configured: configured), "codex")
        // A key since removed, on a row an older replica wrote: Claude Code, as dispatch used to read it.
        XCTAssertEqual(ProviderEngines.sessionEngine(nil, provider: "gone", configured: configured), "claude")
    }

    func testAnOlderOpenCodeSessionOnAKeyIsReadAsThatKey() {
        let pick = ProviderEngines.sessionPick(engine: "opencode", provider: "opencode", model: "orbit-deepseek/deepseek-v4-pro")
        XCTAssertEqual(pick.provider, "deepseek")
        XCTAssertEqual(pick.model, "deepseek-v4-pro")
        // OpenCode's own `provider/model` and its "managed" pick are its own configuration's.
        let own = ProviderEngines.sessionPick(engine: "opencode", provider: "opencode", model: "anthropic/claude-sonnet-4")
        XCTAssertEqual(own.provider, "opencode")
        XCTAssertEqual(own.model, "anthropic/claude-sonnet-4")
        // Only an OpenCode session on OpenCode's own slug carries the old encoding.
        let claude = ProviderEngines.sessionPick(engine: "claude", provider: "opencode", model: "orbit-deepseek/x")
        XCTAssertEqual(claude.provider, "opencode")
        XCTAssertEqual(OpenCodeKeys.dialect(nil), .anthropic)
        XCTAssertEqual(OpenCodeKeys.dialect("dsh"), .anthropic)
        XCTAssertNil(OpenCodeKeys.dialect("opencode"))
    }

    /// The shared module is the only implementation of the table; this file's cases are its spec's.
    func testTheSharedSpecStillHoldsTheseCases() throws {
        let spec = try source("src/shared/src/providerEngines.spec.ts")
        for line in [
            "expect(credentialEngines(DEEPSEEK)).toEqual(['claude', 'opencode', 'dsh']);",
            "expect(credentialEngines(legacyToken)).toEqual(['claude']);",
            "expect(isEngineCompatible('dsh', GLM)).toBe(false);",
            "expect(isDeepSeekKey({ presetSlug: null, baseUrl: 'https://api.deepseek.com.evil.example/v1' })).toBe(false);",
        ] {
            XCTAssertTrue(spec.contains(line), "the shared spec lost: \(line)")
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
