import XCTest
@testable import OrbitKit

/// Provider-aware model and effort data, mirrored from web's src/web/src/lib/agentDefaults.ts.
/// An unknown provider string always behaves like "claude", while each built-in runtime keeps its
/// own model and effort choices.
final class AgentDefaultsTests: XCTestCase {

    func testModelsForProvider() {
        let codex = AgentDefaults.models(for: "codex").map(\.id)
        XCTAssertEqual(codex, ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini"])
        XCTAssertFalse(codex.contains("claude-opus-4-8"))

        let claude = AgentDefaults.models(for: "claude").map(\.id)
        XCTAssertEqual(claude, ["claude-opus-5", "claude-fable-5", "claude-sonnet-5", "claude-haiku-4-5"])
        XCTAssertFalse(claude.contains("gpt-5.6-sol"))

        let kimi = AgentDefaults.models(for: "kimi")
        XCTAssertEqual(kimi.map(\.id), ["kimi-code/kimi-for-coding"])
        XCTAssertEqual(kimi.map(\.name), ["Kimi for Coding"])

        // Unknown provider falls back to Claude, never to an empty menu.
        XCTAssertEqual(AgentDefaults.models(for: "gemini").map(\.id), claude)
    }

    func testDefaultModelForProvider() {
        XCTAssertEqual(AgentDefaults.defaultModel(for: "codex"), "gpt-5.6-sol")
        XCTAssertEqual(AgentDefaults.defaultModel(for: "claude"), "claude-opus-5")
        XCTAssertEqual(AgentDefaults.defaultModel(for: "kimi"), "kimi-code/kimi-for-coding")
        XCTAssertEqual(AgentDefaults.defaultModel(for: "gemini"), AgentDefaults.defaultModelID)
    }

    func testFriendlyNameSpansProviders() {
        XCTAssertEqual(AgentDefaults.friendlyName("gpt-5.6-sol"), "GPT-5.6-Sol")
        XCTAssertEqual(AgentDefaults.friendlyName("gpt-5.5"), "GPT-5.5")
        XCTAssertEqual(AgentDefaults.friendlyName("claude-opus-5"), "Opus 5")
        XCTAssertEqual(AgentDefaults.friendlyName("claude-fable-5"), "Fable 5")
        XCTAssertEqual(AgentDefaults.friendlyName("kimi-code/kimi-for-coding"), "Kimi for Coding")
        // Unknown ids (incl. non-current models like claude-opus-4-8) fall back to the raw string.
        XCTAssertEqual(AgentDefaults.friendlyName("unknown-model"), "unknown-model")
    }

    func testProviderOptions() {
        XCTAssertEqual(AgentDefaults.providers.map(\.id), ["claude", "codex", "kimi"])
        XCTAssertEqual(AgentDefaults.providers.map(\.name), ["Claude", "Codex", "Kimi"])
    }

    func testEffortsForProvider() {
        XCTAssertEqual(AgentDefaults.efforts(for: "claude"),
                       [.default, .low, .medium, .high, .xhigh, .max])
        XCTAssertEqual(AgentDefaults.efforts(for: "codex"),
                       [.default, .minimal, .low, .medium, .high, .xhigh])
        XCTAssertEqual(AgentDefaults.efforts(for: "kimi"),
                       [.default, .low, .high, .max])

        // The whole point: neither provider is offered a value it rejects.
        XCTAssertFalse(AgentDefaults.efforts(for: "claude").contains(.minimal))
        XCTAssertFalse(AgentDefaults.efforts(for: "codex").contains(.max))
        XCTAssertFalse(AgentDefaults.efforts(for: "kimi").contains(.minimal))

        XCTAssertEqual(AgentDefaults.efforts(for: "gemini"), AgentDefaults.efforts(for: "claude"))
    }

    func testMinimalEffortLabelAndWire() {
        XCTAssertEqual(Effort.minimal.rawValue, "minimal")
        XCTAssertEqual(Effort.minimal.label, "Minimal")
        XCTAssertEqual(Effort.minimal.wire, "minimal")
    }

    func testEffortNormalizationForProvider() {
        XCTAssertEqual(AgentDefaults.normalizeEffort(.max, for: "codex"), .xhigh)
        XCTAssertEqual(AgentDefaults.normalizeEffort(.high, for: "codex"), .high)

        XCTAssertEqual(AgentDefaults.normalizeEffort(.minimal, for: "kimi"), .low)
        XCTAssertEqual(AgentDefaults.normalizeEffort(.medium, for: "kimi"), .high)
        XCTAssertEqual(AgentDefaults.normalizeEffort(.xhigh, for: "kimi"), .max)
        XCTAssertEqual(AgentDefaults.normalizeEffort(.default, for: "kimi"), .default)
        XCTAssertEqual(AgentDefaults.normalizeEffort(.low, for: "kimi"), .low)
        XCTAssertEqual(AgentDefaults.normalizeEffort(.high, for: "kimi"), .high)
        XCTAssertEqual(AgentDefaults.normalizeEffort(.max, for: "kimi"), .max)

        XCTAssertEqual(AgentDefaults.normalizeEffort(.xhigh, for: "claude"), .xhigh)
        XCTAssertEqual(AgentDefaults.normalizeEffort(.medium, for: "deepseek"), .medium)
    }

    // MARK: configured providers (control-plane custom slugs — GET /api/providers)

    private let deepseek = ConfiguredProvider(
        slug: "deepseek", label: "DeepSeek", runtime: "claude",
        models: [
            ConfiguredProviderModel(value: "deepseek-v4-pro", label: "DeepSeek V4 Pro", contextWindow: 128_000),
            ConfiguredProviderModel(value: "deepseek-v4-lite", label: "DeepSeek V4 Lite"),
        ],
        defaultModel: "deepseek-v4-pro")

    func testMergedProviderOptions() {
        XCTAssertEqual(AgentDefaults.providers(configured: [deepseek]).map(\.id),
                       ["claude", "codex", "kimi", "deepseek"])
        XCTAssertEqual(AgentDefaults.providers(configured: [deepseek]).last?.name, "DeepSeek")
        // No configured providers → the built-ins only, in their fixed order.
        XCTAssertEqual(AgentDefaults.providers(configured: nil).map(\.id), ["claude", "codex", "kimi"])
        XCTAssertEqual(AgentDefaults.providers(configured: []).map(\.id), ["claude", "codex", "kimi"])
    }

    func testModelsForConfiguredProvider() {
        let models = AgentDefaults.models(for: "deepseek", catalog: nil, configured: [deepseek])
        XCTAssertEqual(models.map(\.id), ["deepseek-v4-pro", "deepseek-v4-lite"])
        XCTAssertEqual(models.map(\.name), ["DeepSeek V4 Pro", "DeepSeek V4 Lite"])

        // A built-in slug never resolves to a configured provider — the static list stays.
        XCTAssertEqual(AgentDefaults.models(for: "claude", catalog: nil, configured: [deepseek]).map(\.id),
                       AgentDefaults.claudeModels.map(\.id))
        // An unconfigured slug keeps the existing fallback (Claude, never an empty menu).
        XCTAssertEqual(AgentDefaults.models(for: "gemini", catalog: nil, configured: [deepseek]).map(\.id),
                       AgentDefaults.claudeModels.map(\.id))
        // A configured provider with no usable models falls back too rather than emptying the menu.
        let empty = ConfiguredProvider(slug: "hollow", label: "Hollow")
        XCTAssertEqual(AgentDefaults.models(for: "hollow", catalog: nil, configured: [empty]).map(\.id),
                       AgentDefaults.claudeModels.map(\.id))
    }

    func testDefaultModelForConfiguredProvider() {
        XCTAssertEqual(AgentDefaults.defaultModel(for: "deepseek", catalog: nil, configured: [deepseek]),
                       "deepseek-v4-pro")
        // No declared default → the provider's first model.
        let noDefault = ConfiguredProvider(slug: "deepseek", label: "DeepSeek",
                                           models: deepseek.models, defaultModel: nil)
        XCTAssertEqual(AgentDefaults.defaultModel(for: "deepseek", catalog: nil, configured: [noDefault]),
                       "deepseek-v4-pro")
        // Not configured at all → identical to the existing catalog overload's fallback.
        XCTAssertEqual(AgentDefaults.defaultModel(for: "deepseek", catalog: nil, configured: []),
                       AgentDefaults.defaultModel(for: "deepseek", catalog: nil))
    }

    func testFriendlyNameFromConfiguredProvider() {
        XCTAssertEqual(AgentDefaults.friendlyName("deepseek-v4-pro", catalog: nil, configured: [deepseek]),
                       "DeepSeek V4 Pro")
        // Static ids and unknown ids keep the existing behavior.
        XCTAssertEqual(AgentDefaults.friendlyName("claude-opus-5", catalog: nil, configured: [deepseek]),
                       "Opus 5")
        XCTAssertEqual(AgentDefaults.friendlyName("unknown-model", catalog: nil, configured: [deepseek]),
                       "unknown-model")
    }

    func testContextWindowFromConfiguredProvider() {
        XCTAssertEqual(AgentDefaults.contextWindow(for: "deepseek-v4-pro", catalog: nil, configured: [deepseek]),
                       128_000)
        // A row without a window falls through to the static table's default.
        XCTAssertEqual(AgentDefaults.contextWindow(for: "deepseek-v4-lite", catalog: nil, configured: [deepseek]),
                       200_000)
        // Static ids are untouched by the configured list.
        XCTAssertEqual(AgentDefaults.contextWindow(for: "claude-opus-5", catalog: nil, configured: [deepseek]),
                       1_000_000)
        XCTAssertEqual(AgentDefaults.contextWindow(for: "claude-fable-5", catalog: nil, configured: [deepseek]),
                       1_000_000)
        XCTAssertEqual(AgentDefaults.contextWindow(for: "kimi-code/kimi-for-coding", catalog: nil,
                                                   configured: [deepseek]), 262_144)
    }

    func testCodexContextWindowComesFromRunnerCatalog() {
        let catalog = RunnerModelCatalog(
            claude: [RunnerModelInfo(value: "claude-opus-5", label: "Opus 5", priority: nil,
                                     contextWindow: nil, reasoningLevels: nil,
                                     defaultReasoningLevel: nil, serviceTiers: nil)],
            codex: [RunnerModelInfo(value: "gpt-5.5", label: "GPT-5.5", priority: nil,
                                    contextWindow: 272_000, reasoningLevels: nil,
                                    defaultReasoningLevel: nil, serviceTiers: nil)])
        XCTAssertEqual(AgentDefaults.contextWindow(for: "gpt-5.5", catalog: catalog), 272_000)
        // Claude windows stay static — no catalog reports them.
        XCTAssertEqual(AgentDefaults.contextWindow(for: "claude-opus-5", catalog: catalog), 1_000_000)
        // No catalog (runner offline / codex missing) → the generic default.
        XCTAssertEqual(AgentDefaults.contextWindow(for: "gpt-5.5", catalog: nil), 200_000)
    }

    func testUnknownModelContextWindowFallsBackToRunnerCatalog() {
        let catalog = RunnerModelCatalog(
            claude: nil,
            codex: [RunnerModelInfo(value: "gpt-new", label: "GPT New", priority: nil,
                                    contextWindow: 512_000, reasoningLevels: nil,
                                    defaultReasoningLevel: nil, serviceTiers: nil)])
        XCTAssertEqual(AgentDefaults.contextWindow(for: "gpt-new", catalog: catalog), 512_000)
    }

    func testKimiRunnerCatalogDecodes() throws {
        let json = #"{"kimi":[{"value":"kimi-code/kimi-for-coding","label":"Kimi for Coding","contextWindow":262144}]}"#
        let catalog = try JSONDecoder().decode(RunnerModelCatalog.self, from: Data(json.utf8))
        XCTAssertEqual(catalog.models(for: "kimi")?.map(\.id), ["kimi-code/kimi-for-coding"])
        XCTAssertEqual(catalog.models(for: "kimi")?.map(\.name), ["Kimi for Coding"])
        XCTAssertEqual(catalog.contextWindow(for: "kimi-code/kimi-for-coding"), 262_144)
    }

    func testProviderNameResolution() {
        XCTAssertEqual(AgentDefaults.providerName("claude", configured: [deepseek]), "Claude")
        XCTAssertEqual(AgentDefaults.providerName("codex", configured: nil), "Codex")
        XCTAssertEqual(AgentDefaults.providerName("kimi", configured: nil), "Kimi")
        XCTAssertEqual(AgentDefaults.providerName("deepseek", configured: [deepseek]), "DeepSeek")
        // A removed/disabled provider's slug renders verbatim — never mislabels as Claude.
        XCTAssertEqual(AgentDefaults.providerName("deepseek", configured: []), "deepseek")
    }
}
