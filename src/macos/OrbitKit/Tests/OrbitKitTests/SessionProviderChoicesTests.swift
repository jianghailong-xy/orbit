import XCTest
@testable import OrbitKit

/// Mirrors web's sessionProviderChoices.test.ts — the two pickers must offer the same things.
final class SessionProviderChoicesTests: XCTestCase {
    private let deepseek = ConfiguredProvider(
        slug: "deepseek", label: "DeepSeek", runtime: "claude",
        models: [ConfiguredProviderModel(value: "deepseek-v4-pro", label: "DeepSeek V4 Pro")],
        defaultModel: "deepseek-v4-pro", presetSlug: "deepseek")

    private let custom = ConfiguredProvider(
        slug: "my-endpoint", label: "my endpoint", runtime: "claude",
        models: [ConfiguredProviderModel(value: "x-1", label: "X 1")],
        defaultModel: "x-1", presetSlug: nil)

    func testAlwaysOffersTheThreeEnginesWithNothingConfigured() {
        let choices = SessionProviderChoices.choices(configured: [])
        XCTAssertEqual(choices.map(\.slug), ["claude", "codex", "kimi"])
        XCTAssertTrue(choices.allSatisfy { $0.kind == .engine })
    }

    func testAppendsConfiguredProvidersAfterTheEngines() {
        let choices = SessionProviderChoices.choices(configured: [deepseek, custom])
        XCTAssertEqual(choices.map(\.slug), ["claude", "codex", "kimi", "deepseek", "my-endpoint"])
        XCTAssertTrue(choices.suffix(2).allSatisfy { $0.kind == .byok })
    }

    func testNeverOffersOpenCodeBecauseItIsNotALoginEngine() {
        XCTAssertFalse(SessionProviderChoices.choices(configured: []).contains { $0.slug == "opencode" })
    }

    func testDropsAConfiguredRowShadowingABuiltInSlug() {
        let shadow = ConfiguredProvider(slug: "kimi", label: "Kimi (custom)", runtime: "claude",
                                        models: [], defaultModel: nil, presetSlug: nil)
        let choices = SessionProviderChoices.choices(configured: [shadow])
        XCTAssertEqual(choices.filter { $0.slug == "kimi" }.count, 1)
        XCTAssertEqual(choices.first { $0.slug == "kimi" }?.kind, .engine)
    }

    func testEachChoiceCarriesItsDefaultModelSoASwitchPreviewsIt() {
        let choices = SessionProviderChoices.choices(configured: [deepseek])
        XCTAssertEqual(choices.first { $0.slug == "deepseek" }?.modelLabel, "DeepSeek V4 Pro")
        XCTAssertEqual(choices.first { $0.slug == "kimi" }?.modelLabel, "Kimi for Coding")
    }

    func testEngineBorrowsItsVendorMarkAndCustomEndpointHasNone() {
        let choices = SessionProviderChoices.choices(configured: [deepseek, custom])
        XCTAssertEqual(choices.first { $0.slug == "claude" }?.brandKey, "anthropic")
        XCTAssertEqual(choices.first { $0.slug == "codex" }?.brandKey, "openai")
        XCTAssertEqual(choices.first { $0.slug == "kimi" }?.brandKey, "moonshot")
        XCTAssertEqual(choices.first { $0.slug == "deepseek" }?.brandKey, "deepseek")
        XCTAssertNil(choices.first { $0.slug == "my-endpoint" }?.brandKey)
    }

    func testCurrentResolvesFromTheOfferedChoices() {
        let choices = SessionProviderChoices.choices(configured: [deepseek])
        let current = SessionProviderChoices.current("deepseek", in: choices, configured: [deepseek])
        XCTAssertEqual(current.label, "DeepSeek")
        XCTAssertEqual(current.kind, .byok)
    }

    func testCurrentSynthesizesOpenCodeRatherThanReadingAsClaude() {
        let choices = SessionProviderChoices.choices(configured: [])
        let current = SessionProviderChoices.current("opencode", in: choices, configured: [])
        XCTAssertEqual(current.slug, "opencode")
        XCTAssertEqual(current.label, "OpenCode")
        XCTAssertEqual(current.kind, .engine)
        XCTAssertEqual(current.modelLabel, "Managed by the provider")
    }

    func testCurrentSynthesizesARemovedProviderTruthfully() {
        let choices = SessionProviderChoices.choices(configured: [])
        let current = SessionProviderChoices.current("gone-away", in: choices, configured: [])
        XCTAssertEqual(current.slug, "gone-away")
        XCTAssertEqual(current.label, "gone-away")
        XCTAssertEqual(current.kind, .byok)
    }

    // MARK: - sameRuntime (the composer's Provider menu)

    private let anthropic = ConfiguredProvider(
        slug: "anthropic", label: "Anthropic (Claude)", runtime: "claude",
        models: [], defaultModel: "claude-opus-5", presetSlug: "anthropic")

    private let anthropic2 = ConfiguredProvider(
        slug: "anthropic-2", label: "Work account", runtime: "claude",
        models: [], defaultModel: "claude-opus-5", presetSlug: "anthropic")

    private let moonshot = ConfiguredProvider(
        slug: "moonshot", label: "Kimi (Moonshot)", runtime: "kimi",
        models: [ConfiguredProviderModel(value: "kimi-k3", label: "Kimi K3")],
        defaultModel: "kimi-k3", presetSlug: "moonshot")

    func testSameRuntimeOffersTheSecondAnthropicAccountAndTheEngine() {
        let configured = [anthropic, anthropic2, deepseek, moonshot]
        let choices = SessionProviderChoices.sameRuntime(
            "anthropic", in: SessionProviderChoices.choices(configured: configured),
            configured: configured)
        XCTAssertEqual(choices.map(\.slug), ["claude", "anthropic", "anthropic-2", "deepseek"])
    }

    /// The menu is the same short list every time it opens; rotating the running one to the top
    /// moved every other row under the cursor depending on which session you were in.
    func testSameRuntimeOrdersTheSameWhicheverProviderIsRunning() {
        let configured = [anthropic, anthropic2, deepseek, moonshot]
        let all = SessionProviderChoices.choices(configured: configured)
        let order = ["claude", "anthropic", "anthropic-2", "deepseek"]
        for from in order {
            XCTAssertEqual(
                SessionProviderChoices.sameRuntime(from, in: all, configured: configured).map(\.slug),
                order, "running on \(from)")
        }
    }

    func testSameRuntimeNeverCrossesToAnotherRuntime() {
        let configured = [anthropic, anthropic2, deepseek, moonshot]
        let slugs = SessionProviderChoices.sameRuntime(
            "claude", in: SessionProviderChoices.choices(configured: configured),
            configured: configured).map(\.slug)
        XCTAssertFalse(slugs.contains("codex"))
        XCTAssertFalse(slugs.contains("kimi"))
        XCTAssertFalse(slugs.contains("moonshot"))
    }

    func testSameRuntimeGroupsKimiWithTheProvidersThatBorrowIt() {
        let configured = [anthropic, moonshot]
        let slugs = SessionProviderChoices.sameRuntime(
            "kimi", in: SessionProviderChoices.choices(configured: configured),
            configured: configured).map(\.slug).sorted()
        XCTAssertEqual(slugs, ["kimi", "moonshot"])
    }

    /// OpenCode is its own runtime. Resolving it through AgentDefaults.runtime(for:) would answer
    /// "claude" and offer every Anthropic provider on the account — see `executingRuntime`.
    func testSameRuntimeLeavesOpenCodeAlone() {
        let configured = [anthropic, anthropic2]
        let choices = SessionProviderChoices.sameRuntime(
            "opencode", in: SessionProviderChoices.choices(configured: configured),
            configured: configured)
        XCTAssertEqual(choices.map(\.slug), ["opencode"])
    }

    func testSameRuntimeLeavesALoneProviderAloneSoTheMenuCanBeHidden() {
        XCTAssertEqual(
            SessionProviderChoices.sameRuntime("claude", in: SessionProviderChoices.choices(configured: []),
                                               configured: []).count,
            1)
    }

    func testSameRuntimeStillShowsASessionWhoseProviderWasRemoved() {
        let choices = SessionProviderChoices.sameRuntime(
            "gone-away", in: SessionProviderChoices.choices(configured: [anthropic]),
            configured: [anthropic])
        XCTAssertEqual(choices.first?.slug, "gone-away")
        XCTAssertTrue(choices.contains { $0.slug == "anthropic" })
    }

    // MARK: - Engine health (web parity: listed with a reason, never hidden)

    private func health(_ engine: String, installed: Bool, auth: String) -> RunnerEngineHealth {
        RunnerEngineHealth(engine: engine, installed: installed, auth: auth)
    }

    func testKeepsAnEngineTheRunnerDoesNotHaveInstalledWithTheReason() {
        let choices = SessionProviderChoices.choices(
            configured: [deepseek], engines: [
                health("claude", installed: true, auth: "yes"),
                health("codex", installed: false, auth: "unknown"),
                health("kimi", installed: false, auth: "unknown"),
            ])
        XCTAssertEqual(choices.map(\.slug), ["claude", "codex", "kimi", "deepseek"])
        XCTAssertEqual(choices.first { $0.slug == "kimi" }?.unavailable, "Not installed")
        XCTAssertEqual(choices.first { $0.slug == "kimi" }?.fixEngine, "kimi")
        XCTAssertNil(choices.first { $0.slug == "claude" }?.unavailable)
    }

    func testSaysNotInstalledRatherThanSignedOutForAMissingCLI() {
        let choices = SessionProviderChoices.choices(
            configured: [], engines: [health("kimi", installed: false, auth: "no")])
        XCTAssertEqual(choices.first { $0.slug == "kimi" }?.unavailable, "Not installed")
    }

    func testKeepsAnInstalledButSignedOutEngineWithTheReason() {
        let choices = SessionProviderChoices.choices(
            configured: [], engines: [
                health("claude", installed: true, auth: "no"),
                health("kimi", installed: true, auth: "unknown"),
            ])
        XCTAssertEqual(choices.first { $0.slug == "claude" }?.unavailable, "Not signed in")
        // `unknown` is a CLI that wouldn't answer, not a "no" — it stays runnable.
        XCTAssertNil(choices.first { $0.slug == "kimi" }?.unavailable)
    }

    func testBlocksAConfiguredProviderWhoseBorrowedCLIIsMissing() {
        let choices = SessionProviderChoices.choices(
            configured: [moonshot, deepseek], engines: [
                health("claude", installed: true, auth: "yes"),
                health("kimi", installed: false, auth: "unknown"),
            ])
        let row = choices.first { $0.slug == "moonshot" }
        XCTAssertEqual(row?.unavailable, "Not installed")
        // Its own slug has no row on the Providers page; the install lives on the engine it borrows.
        XCTAssertEqual(row?.fixEngine, "kimi")
        XCTAssertNil(choices.first { $0.slug == "deepseek" }?.unavailable)
    }

    func testAConfiguredProviderOnASignedOutCLIStaysRunnable() {
        // Its pasted key is the credential, so the engine's own sign-in does not apply.
        let choices = SessionProviderChoices.choices(
            configured: [moonshot], engines: [health("kimi", installed: true, auth: "no")])
        XCTAssertEqual(choices.first { $0.slug == "kimi" }?.unavailable, "Not signed in")
        XCTAssertNil(choices.first { $0.slug == "moonshot" }?.unavailable)
    }

    func testAnEngineTheRunnerHasClaimedNothingAboutStaysRunnable() {
        XCTAssertTrue(SessionProviderChoices.choices(configured: [], engines: nil)
            .allSatisfy { $0.unavailable == nil })
        let partial = SessionProviderChoices.choices(
            configured: [], engines: [health("claude", installed: false, auth: "no")])
        XCTAssertEqual(partial.map(\.slug), ["claude", "codex", "kimi"])
        XCTAssertEqual(partial.filter { $0.unavailable != nil }.count, 1)
    }

    /// The composer's menu greys these out rather than dropping them — the bug that started this:
    /// every production runner reports claude installed-but-signed-out, and hiding the row read as
    /// "Orbit lost my Claude".
    func testSameRuntimeKeepsABlockedTargetSoTheMenuCanExplainIt() {
        let rows = [anthropic, anthropic2]
        let choices = SessionProviderChoices.sameRuntime(
            "anthropic",
            in: SessionProviderChoices.choices(
                configured: rows, engines: [health("claude", installed: true, auth: "no")]),
            configured: rows)
        XCTAssertEqual(choices.map(\.slug), ["claude", "anthropic", "anthropic-2"])
        XCTAssertEqual(choices.first { $0.slug == "claude" }?.unavailable, "Not signed in")
        XCTAssertNil(choices.first { $0.slug == "anthropic-2" }?.unavailable)
    }
}
