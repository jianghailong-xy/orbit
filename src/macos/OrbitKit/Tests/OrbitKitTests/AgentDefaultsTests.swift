import XCTest
@testable import OrbitKit

/// Provider-aware model and effort data, mirrored from web's src/web/src/lib/agentDefaults.ts.
/// An unknown provider string always behaves like "claude", while each built-in runtime keeps its
/// own model and effort choices.
final class AgentDefaultsTests: XCTestCase {

    func testModelsForProvider() {
        // Codex models come exclusively from the runner catalog; no static fallback.
        let codex = AgentDefaults.models(for: "codex").map(\.id)
        XCTAssertEqual(codex, [])
        // With a catalog, codex models are returned.
        let catalog = RunnerModelCatalog(
            claude: nil,
            codex: [RunnerModelInfo(value: "gpt-5.6-sol", label: "GPT-5.6-Sol", priority: nil,
                                    contextWindow: nil, reasoningLevels: nil,
                                    defaultReasoningLevel: nil, serviceTiers: nil)])
        let codexFromCatalog = AgentDefaults.models(for: "codex", catalog: catalog).map(\.id)
        XCTAssertEqual(codexFromCatalog, ["gpt-5.6-sol"])

        // Claude models also come exclusively from the runner catalog; no static fallback.
        let claude = AgentDefaults.models(for: "claude").map(\.id)
        XCTAssertEqual(claude, [])
        let claudeCatalog = RunnerModelCatalog(
            claude: [RunnerModelInfo(value: "claude-opus-5", label: "Opus 5", priority: nil,
                                     contextWindow: nil, reasoningLevels: nil,
                                     defaultReasoningLevel: nil, serviceTiers: nil)],
            codex: nil)
        let claudeFromCatalog = AgentDefaults.models(for: "claude", catalog: claudeCatalog).map(\.id)
        XCTAssertEqual(claudeFromCatalog, ["claude-opus-5"])

        // Managed Kimi is the one provider the catalog never reports, so its list stays static.
        let kimi = AgentDefaults.models(for: "kimi")
        XCTAssertEqual(kimi.map(\.id), ["kimi-code/kimi-for-coding"])
        XCTAssertEqual(kimi.map(\.name), ["Kimi for Coding"])

        XCTAssertEqual(AgentDefaults.models(for: "opencode").map(\.id), [""])
        XCTAssertEqual(AgentDefaults.models(for: "opencode").map(\.name), ["Managed by OpenCode"])

        // Unknown provider returns empty (no static list to fall back to).
        XCTAssertEqual(AgentDefaults.models(for: "gemini").map(\.id), [])
    }

    func testDefaultModelForProvider() {
        XCTAssertEqual(AgentDefaults.defaultModel(for: "codex"), "gpt-5.6-sol")
        XCTAssertEqual(AgentDefaults.defaultModel(for: "claude"), "claude-opus-5")
        XCTAssertEqual(AgentDefaults.defaultModel(for: "kimi"), "kimi-code/kimi-for-coding")
        XCTAssertEqual(AgentDefaults.defaultModel(for: "opencode"), "")
        XCTAssertEqual(AgentDefaults.defaultModel(for: "gemini"), AgentDefaults.defaultModelID)
    }

    func testFriendlyNameSpansProviders() {
        // Claude/Codex ids render as raw ids without a catalog (no static fallback for them);
        // managed Kimi's single model keeps its static label.
        XCTAssertEqual(AgentDefaults.friendlyName("gpt-5.6-sol"), "gpt-5.6-sol")
        XCTAssertEqual(AgentDefaults.friendlyName("claude-opus-5"), "claude-opus-5")
        XCTAssertEqual(AgentDefaults.friendlyName("kimi-code/kimi-for-coding"), "Kimi for Coding")
        // With a catalog, model ids get their friendly names from the catalog.
        let catalog = RunnerModelCatalog(
            claude: [RunnerModelInfo(value: "claude-opus-5", label: "Opus 5", priority: nil,
                                     contextWindow: nil, reasoningLevels: nil,
                                     defaultReasoningLevel: nil, serviceTiers: nil)],
            codex: [RunnerModelInfo(value: "gpt-5.6-sol", label: "GPT-5.6-Sol", priority: nil,
                                    contextWindow: nil, reasoningLevels: nil,
                                    defaultReasoningLevel: nil, serviceTiers: nil)])
        XCTAssertEqual(AgentDefaults.friendlyName("gpt-5.6-sol", catalog: catalog), "GPT-5.6-Sol")
        XCTAssertEqual(AgentDefaults.friendlyName("claude-opus-5", catalog: catalog), "Opus 5")
        XCTAssertEqual(AgentDefaults.friendlyName(""), "Managed by OpenCode")
        // Unknown ids (incl. non-current models like claude-opus-4-8) fall back to the raw string.
        XCTAssertEqual(AgentDefaults.friendlyName("unknown-model"), "unknown-model")
    }

    func testProviderOptions() {
        XCTAssertEqual(AgentDefaults.providers.map(\.id), ["claude", "codex", "kimi", "opencode"])
        XCTAssertEqual(AgentDefaults.providers.map(\.name), ["Claude", "Codex", "Kimi", "OpenCode"])
    }

    func testEffortsForProvider() {
        XCTAssertEqual(AgentDefaults.efforts(for: "claude"),
                       [.default, .low, .medium, .high, .xhigh, .max])
        XCTAssertEqual(AgentDefaults.efforts(for: "codex"),
                       [.default, .minimal, .low, .medium, .high, .xhigh])
        XCTAssertEqual(AgentDefaults.efforts(for: "kimi"),
                       [.default, .low, .high, .max])
        XCTAssertEqual(AgentDefaults.efforts(for: "opencode"),
                       [.default, .minimal, .low, .medium, .high, .xhigh, .max])

        // The whole point: neither provider is offered a value it rejects.
        XCTAssertFalse(AgentDefaults.efforts(for: "claude").contains(.minimal))
        XCTAssertFalse(AgentDefaults.efforts(for: "codex").contains(.max))
        XCTAssertFalse(AgentDefaults.efforts(for: "kimi").contains(.minimal))

        XCTAssertEqual(AgentDefaults.efforts(for: "gemini"), AgentDefaults.efforts(for: "claude"))
    }

    func testMinimalEffortLabelAndRawValue() {
        XCTAssertEqual(Effort.minimal.rawValue, "minimal")
        XCTAssertEqual(Effort.minimal.label, "Minimal")
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

    func testAutoPermissionModeCapabilityAndClamp() {
        XCTAssertTrue(AgentDefaults.supportsAuto("claude-opus-5"))
        XCTAssertTrue(AgentDefaults.supportsAuto("claude-fable-5"))
        XCTAssertTrue(AgentDefaults.supportsAuto("claude-sonnet-5"))
        XCTAssertTrue(AgentDefaults.supportsAuto(
            "kimi-code/kimi-for-coding", provider: "kimi"))
        XCTAssertTrue(AgentDefaults.supportsAuto("local-kimi-alias", provider: "kimi"))
        XCTAssertFalse(AgentDefaults.supportsAuto("claude-haiku-4-5"))
        XCTAssertFalse(AgentDefaults.supportsAuto("gpt-5.6-sol"))
        XCTAssertFalse(AgentDefaults.supportsAuto("custom-model"))

        XCTAssertEqual(AgentDefaults.clampPermissionMode(.auto, for: "claude-haiku-4-5"),
                       .default)
        XCTAssertEqual(AgentDefaults.clampPermissionMode(.auto, for: "gpt-5.6-sol"), .default)
        XCTAssertEqual(AgentDefaults.clampPermissionMode(.auto, for: "claude-opus-5"), .auto)
        XCTAssertEqual(AgentDefaults.clampPermissionMode(.plan, for: "gpt-5.6-sol"), .plan)

        let configured = [ConfiguredProvider(
            slug: "local-kimi", label: "Local Kimi", runtime: "kimi")]
        XCTAssertFalse(AgentDefaults.supportsAuto(
            "any-alias", provider: "local-kimi", configured: configured))
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
                       ["claude", "codex", "kimi", "opencode", "deepseek"])
        XCTAssertEqual(AgentDefaults.providers(configured: [deepseek]).last?.name, "DeepSeek")
        // No configured providers → the built-ins only, in their fixed order.
        XCTAssertEqual(AgentDefaults.providers(configured: nil).map(\.id), ["claude", "codex", "kimi", "opencode"])
        XCTAssertEqual(AgentDefaults.providers(configured: []).map(\.id), ["claude", "codex", "kimi", "opencode"])
    }

    func testModelsForConfiguredProvider() {
        let models = AgentDefaults.models(for: "deepseek", catalog: nil, configured: [deepseek])
        XCTAssertEqual(models.map(\.id), ["deepseek-v4-pro", "deepseek-v4-lite"])
        XCTAssertEqual(models.map(\.name), ["DeepSeek V4 Pro", "DeepSeek V4 Lite"])

        // A built-in slug never resolves to a configured provider — returns empty (no static fallback).
        XCTAssertEqual(AgentDefaults.models(for: "claude", catalog: nil, configured: [deepseek]).map(\.id), [])
        // An unconfigured slug also returns empty (no static fallback).
        XCTAssertEqual(AgentDefaults.models(for: "gemini", catalog: nil, configured: [deepseek]).map(\.id), [])
        // A configured provider with no usable models also returns empty.
        let empty = ConfiguredProvider(slug: "hollow", label: "Hollow")
        XCTAssertEqual(AgentDefaults.models(for: "hollow", catalog: nil, configured: [empty]).map(\.id), [])
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

        // An empty custom model space inherits only the static default of the runtime it borrows;
        // resolving its unknown slug directly would incorrectly fall back to Claude.
        let codexBacked = ConfiguredProvider(slug: "internal-codex", label: "Internal Codex",
                                             runtime: "codex", models: [], defaultModel: nil)
        XCTAssertEqual(AgentDefaults.defaultModel(
            for: "internal-codex", catalog: nil, configured: [codexBacked]), "gpt-5.6-sol")
        XCTAssertEqual(AgentDefaults.effectiveDefaultModel(
            for: "internal-codex", catalog: nil, configured: [codexBacked],
            runtimeDefaults: ["codex": "runner-codex-default"]), "gpt-5.6-sol")
    }

    func testEffectiveDefaultModelUsesRuntimeThenCatalogThenStatic() {
        let catalog = RunnerModelCatalog(
            claude: [RunnerModelInfo(value: "claude-fable-5", label: "Fable 5", priority: nil,
                                     contextWindow: nil, reasoningLevels: nil,
                                     defaultReasoningLevel: nil, serviceTiers: nil)],
            codex: nil)
        XCTAssertEqual(AgentDefaults.effectiveDefaultModel(
            for: "claude", catalog: catalog, configured: nil,
            runtimeDefaults: ["claude": "claude-sonnet-5"]),
            "claude-sonnet-5")
        // No directly reported default falls through to the Runtime catalog.
        XCTAssertEqual(AgentDefaults.effectiveDefaultModel(
            for: "claude", catalog: catalog, configured: nil,
            runtimeDefaults: [:]),
            "claude-fable-5")
        XCTAssertEqual(AgentDefaults.effectiveDefaultModel(
            for: "kimi", catalog: nil, configured: nil,
            runtimeDefaults: [:]),
            "kimi-code/kimi-for-coding")
    }

    func testEffectiveDefaultModelKeepsConfiguredProviderInItsOwnModelSpace() {
        XCTAssertEqual(AgentDefaults.effectiveDefaultModel(
            for: "claude", catalog: nil, configured: nil,
            runtimeDefaults: nil),
            "claude-opus-5")
        XCTAssertEqual(AgentDefaults.effectiveDefaultModel(
            for: "deepseek", catalog: nil, configured: [deepseek],
            runtimeDefaults: nil),
            "deepseek-v4-pro")
        // A configured provider owns its own default even if the borrowed Claude runtime reports
        // another one.
        XCTAssertEqual(AgentDefaults.effectiveDefaultModel(
            for: "deepseek", catalog: nil, configured: [deepseek],
            runtimeDefaults: ["claude": "claude-opus-5"]),
            "deepseek-v4-pro")
    }

    func testEffectiveDefaultModelNormalizesUnknownProviderBeforeRuntimeLookup() {
        let catalog = RunnerModelCatalog(
            claude: [RunnerModelInfo(value: "claude-fable-5", label: "Fable 5", priority: nil,
                                     contextWindow: nil, reasoningLevels: nil,
                                     defaultReasoningLevel: nil, serviceTiers: nil)],
            codex: nil)

        // A disabled custom Provider falls back through the Claude Runtime. A stale/forged entry
        // under its old slug is ignored rather than becoming a fourth heartbeat namespace.
        XCTAssertEqual(AgentDefaults.effectiveDefaultModel(
            for: "retired-provider", catalog: catalog, configured: [],
            runtimeDefaults: [
                "retired-provider": "wrong-custom-default",
                "claude": "runtime-claude-default",
            ]), "runtime-claude-default")
        XCTAssertEqual(AgentDefaults.effectiveDefaultModel(
            for: "retired-provider", catalog: catalog, configured: [], runtimeDefaults: [:]),
            "claude-fable-5")
        XCTAssertEqual(AgentDefaults.effectiveDefaultModel(
            for: "retired-provider", catalog: nil, configured: [], runtimeDefaults: [:]),
            "claude-opus-5")

        // An enabled configured Provider still owns its declared model space.
        XCTAssertEqual(AgentDefaults.effectiveDefaultModel(
            for: "deepseek", catalog: catalog, configured: [deepseek],
            runtimeDefaults: ["claude": "runtime-claude-default"]),
            "deepseek-v4-pro")
    }

    func testRefreshedDefaultModelPreservesAnUnavailableSnapshot() {
        XCTAssertEqual(AgentDefaults.refreshedDefaultModel(
            currentModel: "cached-runtime-default", for: "claude", catalog: nil, configured: nil,
            runtimeDefaults: nil, runnerSnapshotLoaded: false, configuredProvidersLoaded: false),
            "cached-runtime-default")
        XCTAssertEqual(AgentDefaults.refreshedDefaultModel(
            currentModel: "cached-runtime-default", for: "claude", catalog: nil, configured: nil,
            runtimeDefaults: nil, runnerSnapshotLoaded: true, configuredProvidersLoaded: false),
            "claude-opus-5")
        XCTAssertEqual(AgentDefaults.refreshedDefaultModel(
            currentModel: "cached-custom-default", for: "deepseek", catalog: nil, configured: nil,
            runtimeDefaults: [:], runnerSnapshotLoaded: true, configuredProvidersLoaded: false),
            "cached-custom-default")
        XCTAssertEqual(AgentDefaults.refreshedDefaultModel(
            currentModel: "wrong-claude-seed", for: "deepseek", catalog: nil,
            configured: [deepseek], runtimeDefaults: nil, runnerSnapshotLoaded: false,
            configuredProvidersLoaded: true),
            "deepseek-v4-pro")
    }

    func testModelSelectionRevisionStaysDirtyAfterReturningToInitialValue() {
        var revision = ModelSelectionRevision()
        XCTAssertTrue(revision.isPristine)
        revision.markUserEdit() // pick another model
        revision.markUserEdit() // pick the original model again
        XCTAssertFalse(revision.isPristine)
        XCTAssertEqual(revision.value, 2)
    }

    func testFriendlyNameFromConfiguredProvider() {
        XCTAssertEqual(AgentDefaults.friendlyName("deepseek-v4-pro", catalog: nil, configured: [deepseek]),
                       "DeepSeek V4 Pro")
        // Static ids and unknown ids render as raw without a catalog (no static fallback).
        XCTAssertEqual(AgentDefaults.friendlyName("claude-opus-5", catalog: nil, configured: [deepseek]),
                       "claude-opus-5")
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

    func testOpenCodeModelsComeFromRunnerCatalogAfterEmptyDefault() {
        let catalog = RunnerModelCatalog(
            opencode: [RunnerModelInfo(value: "anthropic/claude-sonnet-4",
                                       label: "Claude Sonnet 4", priority: 1,
                                       contextWindow: 200_000,
                                       reasoningLevels: ["low", "high"],
                                       defaultReasoningLevel: "high", serviceTiers: nil)])
        XCTAssertEqual(AgentDefaults.models(for: "opencode", catalog: catalog).map(\.id),
                       ["", "anthropic/claude-sonnet-4"])
        XCTAssertEqual(AgentDefaults.defaultModel(for: "opencode", catalog: catalog), "")
        XCTAssertEqual(AgentDefaults.friendlyName("anthropic/claude-sonnet-4", catalog: catalog),
                       "Claude Sonnet 4")
        XCTAssertEqual(AgentDefaults.contextWindow(for: "anthropic/claude-sonnet-4",
                                                   catalog: catalog), 200_000)
        XCTAssertEqual(AgentDefaults.efforts(for: "opencode",
                                             model: "anthropic/claude-sonnet-4",
                                             catalog: catalog), [.default, .low, .high])
    }

    func testOpenCodePreservesArbitraryCatalogVariants() {
        let catalog = RunnerModelCatalog(
            opencode: [RunnerModelInfo(value: "provider/model", label: "Model", priority: nil,
                                       contextWindow: nil,
                                       reasoningLevels: ["low", "ultra", "low", ""],
                                       defaultReasoningLevel: nil, serviceTiers: nil)])
        let ultra = Effort(rawValue: "ultra")!
        XCTAssertEqual(AgentDefaults.efforts(for: "opencode", model: "provider/model",
                                             catalog: catalog), [.default, .low, ultra])
        XCTAssertEqual(ultra.label, "Ultra")
        XCTAssertTrue(AgentDefaults.supportsEffort(ultra, for: "opencode",
                                                   model: "provider/model", catalog: catalog))
        XCTAssertFalse(AgentDefaults.supportsEffort(.max, for: "opencode",
                                                    model: "provider/model", catalog: catalog))
        XCTAssertTrue(AgentDefaults.supportsEffort(ultra, for: "opencode",
                                                   model: "project/model", catalog: catalog))
    }

    func testOpenCodeKnownModelWithNoVariantsOffersDefaultOnly() {
        let nilLevels = RunnerModelCatalog(
            opencode: [RunnerModelInfo(value: "provider/plain", label: "Plain", priority: nil,
                                       contextWindow: nil, reasoningLevels: nil,
                                       defaultReasoningLevel: nil, serviceTiers: nil)])
        let emptyLevels = RunnerModelCatalog(
            opencode: [RunnerModelInfo(value: "provider/plain", label: "Plain", priority: nil,
                                       contextWindow: nil, reasoningLevels: [],
                                       defaultReasoningLevel: nil, serviceTiers: nil)])

        for catalog in [nilLevels, emptyLevels] {
            XCTAssertEqual(AgentDefaults.efforts(for: "opencode", model: "provider/plain",
                                                 catalog: catalog), [.default])
            XCTAssertFalse(AgentDefaults.supportsEffort(.high, for: "opencode",
                                                        model: "provider/plain", catalog: catalog))
            XCTAssertEqual(AgentDefaults.normalizedEffort(.high, for: "opencode",
                                                          model: "provider/plain", catalog: catalog),
                           .default)
        }
    }

    func testOpenCodeUnknownProjectModelPreservesCustomVariant() {
        let catalog = RunnerModelCatalog(
            opencode: [RunnerModelInfo(value: "provider/global", label: "Global", priority: nil,
                                       contextWindow: nil, reasoningLevels: [],
                                       defaultReasoningLevel: nil, serviceTiers: nil)])
        let ultra = Effort(rawValue: "ultra")!

        XCTAssertEqual(AgentDefaults.efforts(for: "opencode", model: "project/only",
                                             catalog: catalog), AgentDefaults.efforts(for: "opencode"))
        XCTAssertTrue(AgentDefaults.supportsEffort(ultra, for: "opencode",
                                                   model: "project/only", catalog: catalog))
        XCTAssertEqual(AgentDefaults.normalizedEffort(ultra, for: "opencode",
                                                      model: "project/only", catalog: catalog), ultra)
    }

    func testProviderNameResolution() {
        XCTAssertEqual(AgentDefaults.providerName("claude", configured: [deepseek]), "Claude")
        XCTAssertEqual(AgentDefaults.providerName("codex", configured: nil), "Codex")
        XCTAssertEqual(AgentDefaults.providerName("kimi", configured: nil), "Kimi")
        XCTAssertEqual(AgentDefaults.providerName("opencode", configured: nil), "OpenCode")
        XCTAssertEqual(AgentDefaults.providerName("deepseek", configured: [deepseek]), "DeepSeek")
        // A removed/disabled provider's slug renders verbatim — never mislabels as Claude.
        XCTAssertEqual(AgentDefaults.providerName("deepseek", configured: []), "deepseek")
    }
}
