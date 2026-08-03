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
}
