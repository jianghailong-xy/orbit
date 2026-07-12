import XCTest
@testable import OrbitKit

/// Provider-aware model and effort data, mirrored from web's src/web/src/lib/agentDefaults.ts.
/// An unknown provider string always behaves like "claude" — the server treats anything that
/// isn't exactly "codex" as Claude (see apiserver's agentProvider()).
final class AgentDefaultsTests: XCTestCase {

    func testModelsForProvider() {
        let codex = AgentDefaults.models(for: "codex").map(\.id)
        XCTAssertEqual(codex, ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini"])
        XCTAssertFalse(codex.contains("claude-opus-4-8"))

        let claude = AgentDefaults.models(for: "claude").map(\.id)
        XCTAssertEqual(claude, ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"])
        XCTAssertFalse(claude.contains("gpt-5.6-sol"))

        // Unknown provider falls back to Claude, never to an empty menu.
        XCTAssertEqual(AgentDefaults.models(for: "gemini").map(\.id), claude)
    }

    func testDefaultModelForProvider() {
        XCTAssertEqual(AgentDefaults.defaultModel(for: "codex"), "gpt-5.6-sol")
        XCTAssertEqual(AgentDefaults.defaultModel(for: "claude"), "claude-opus-4-8")
        XCTAssertEqual(AgentDefaults.defaultModel(for: "gemini"), AgentDefaults.defaultModelID)
    }

    func testFriendlyNameSpansProviders() {
        XCTAssertEqual(AgentDefaults.friendlyName("gpt-5.6-sol"), "GPT-5.6-Sol")
        XCTAssertEqual(AgentDefaults.friendlyName("gpt-5.5"), "GPT-5.5")
        XCTAssertEqual(AgentDefaults.friendlyName("claude-opus-4-8"), "Opus 4.8")
        // Unknown ids still fall back to the raw string (an env-overridden endpoint).
        XCTAssertEqual(AgentDefaults.friendlyName("unknown-model"), "unknown-model")
    }

    func testProviderOptions() {
        XCTAssertEqual(AgentDefaults.providers.map(\.id), ["claude", "codex"])
        XCTAssertEqual(AgentDefaults.providers.map(\.name), ["Claude", "Codex"])
    }

    func testEffortsForProvider() {
        XCTAssertEqual(AgentDefaults.efforts(for: "claude"),
                       [.default, .low, .medium, .high, .xhigh, .max])
        XCTAssertEqual(AgentDefaults.efforts(for: "codex"),
                       [.default, .minimal, .low, .medium, .high, .xhigh])

        // The whole point: neither provider is offered a value it rejects.
        XCTAssertFalse(AgentDefaults.efforts(for: "claude").contains(.minimal))
        XCTAssertFalse(AgentDefaults.efforts(for: "codex").contains(.max))

        XCTAssertEqual(AgentDefaults.efforts(for: "gemini"), AgentDefaults.efforts(for: "claude"))
    }

    func testMinimalEffortLabelAndWire() {
        XCTAssertEqual(Effort.minimal.rawValue, "minimal")
        XCTAssertEqual(Effort.minimal.label, "Minimal")
        XCTAssertEqual(Effort.minimal.wire, "minimal")
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
                       ["claude", "codex", "deepseek"])
        XCTAssertEqual(AgentDefaults.providers(configured: [deepseek]).last?.name, "DeepSeek")
        // No configured providers → the built-ins only, in their fixed order.
        XCTAssertEqual(AgentDefaults.providers(configured: nil).map(\.id), ["claude", "codex"])
        XCTAssertEqual(AgentDefaults.providers(configured: []).map(\.id), ["claude", "codex"])
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
        XCTAssertEqual(AgentDefaults.friendlyName("claude-opus-4-8", catalog: nil, configured: [deepseek]),
                       "Opus 4.8")
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
        XCTAssertEqual(AgentDefaults.contextWindow(for: "claude-opus-4-8", catalog: nil, configured: [deepseek]),
                       1_000_000)
    }

    func testProviderNameResolution() {
        XCTAssertEqual(AgentDefaults.providerName("claude", configured: [deepseek]), "Claude")
        XCTAssertEqual(AgentDefaults.providerName("codex", configured: nil), "Codex")
        XCTAssertEqual(AgentDefaults.providerName("deepseek", configured: [deepseek]), "DeepSeek")
        // A removed/disabled provider's slug renders verbatim — never mislabels as Claude.
        XCTAssertEqual(AgentDefaults.providerName("deepseek", configured: []), "deepseek")
    }
}
