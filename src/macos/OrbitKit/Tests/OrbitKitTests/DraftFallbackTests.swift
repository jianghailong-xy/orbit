import XCTest
@testable import OrbitKit

/// A new session's default when what the workspace last ran on can't run on this machine (board
/// docs/mocks/new-session-usable-default). Mirrors web's `draftFallback` spec in
/// sessionProviderChoices.test.ts and the hero's words in NewSessionProviderHero.test.tsx.
final class DraftFallbackTests: XCTestCase {
    private let deepseek = ConfiguredProvider(
        slug: "deepseek", label: "DeepSeek", runtime: "claude",
        models: [ConfiguredProviderModel(value: "deepseek-v4-pro", label: "DeepSeek V4 Pro")],
        defaultModel: "deepseek-v4-pro", presetSlug: "deepseek", runsOnOpenCode: true,
        engines: ["claude", "opencode", "dsh"])
    private let anthropic = ConfiguredProvider(
        slug: "anthropic", label: "Personal Max", runtime: "claude", models: [], defaultModel: "claude-opus-5",
        presetSlug: "anthropic", modelsFromRuntime: true, engines: ["claude"])
    private let catalog = RunnerModelCatalog(
        claude: [RunnerModelInfo(value: "claude-opus-5", label: "Claude Opus 5")],
        codex: [RunnerModelInfo(value: "gpt-5.6-sol", label: "GPT-5.6 Sol")])
    private let blocked = RunnerRegionView(verdict: "blocked", country: "CN", regionCode: nil, name: "mainland China",
                                           viaProxy: false, checkedAt: "2026-10-31T03:58:00Z")
    private let claudeIn = RunnerEngineHealth(engine: "claude", installed: true, auth: "yes")
    private let codexIn = RunnerEngineHealth(engine: "codex", installed: true, auth: "yes")

    private func sources(_ configured: [ConfiguredProvider], _ engines: [RunnerEngineHealth]?,
                         region: RunnerRegionView? = nil) -> ChoiceSources {
        ChoiceSources(configured: configured, catalog: catalog, engines: engines, pools: [], now: Date(), region: region)
    }

    /// As ConsoleModel works it out: the remembered pair on this machine, and where the draft goes.
    private func fallback(_ engine: String, _ provider: String, _ src: ChoiceSources)
        -> (from: EngineChoice, to: EnginePick?, engines: [EngineChoice]) {
        let pick = EnginePick(engine: engine, provider: provider)
        let engines = SessionProviderChoices.engines(sources: src, preferred: [pick])
        let from = SessionProviderChoices.currentEngine(engine: engine, provider: provider, engines: engines, sources: src)
        return (from, SessionProviderChoices.draftFallback(remembered: from, engines: engines, engineHealth: src.engines), engines)
    }

    func testStaysOnWhatTheWorkspaceLastRanOnWhileItRuns() {
        XCTAssertNil(fallback("claude", "claude", sources([deepseek], [claudeIn])).to)
    }

    func testMovesToACredentialOfTheSameEngineThatRuns() {
        let result = fallback("claude", "claude", sources([deepseek, anthropic], [claudeIn, codexIn], region: blocked))
        XCTAssertEqual(result.to, EnginePick(engine: "claude", provider: "deepseek"))
    }

    func testMovesToAnotherEngineOnlyWhenTheRememberedOneHasNothingThatRuns() {
        let result = fallback("claude", "anthropic", sources([anthropic], [claudeIn, codexIn], region: blocked))
        XCTAssertEqual(result.to, EnginePick(engine: "codex", provider: "codex"))
    }

    func testMovesToAnotherEngineOnlyOntoOneTheRunnerSaysIsInstalled() {
        let codexMissing = RunnerEngineHealth(engine: "codex", installed: false, auth: "unknown")
        XCTAssertNil(fallback("claude", "anthropic", sources([anthropic], [claudeIn, codexMissing], region: blocked)).to)
    }

    func testHasNowhereToGoWhenNothingOnTheMachineRuns() {
        XCTAssertNil(fallback("claude", "claude", sources([anthropic], [claudeIn], region: blocked)).to)
    }

    func testMovesForAReasonOtherThanTheRegion() {
        let signedOut = RunnerEngineHealth(engine: "claude", installed: true, auth: "no")
        XCTAssertEqual(fallback("claude", "claude", sources([deepseek], [signedOut])).to,
                       EnginePick(engine: "claude", provider: "deepseek"))
    }

    func testDoesNotMoveOnWhatNobodyHasChecked() {
        XCTAssertNil(fallback("claude", "claude", sources([deepseek], nil)).to)
    }

    // MARK: the hero's words

    private func line(_ engine: String, _ provider: String, _ src: ChoiceSources) -> String? {
        let result = fallback(engine, provider, src)
        guard let to = result.to else { return nil }
        let now = SessionProviderChoices.currentEngine(engine: to.engine, provider: to.provider,
                                                       engines: result.engines, sources: src)
        return SessionProviderChoices.fallbackLine(from: result.from, to: now, machine: "jdcloud")
    }

    func testSaysWhichCredentialItUsesNowAndWhy() {
        XCTAssertEqual(line("claude", "claude", sources([deepseek, anthropic], [claudeIn], region: blocked)),
                       "Using DeepSeek · Anthropic unavailable on jdcloud")
    }

    func testNamesTheEngineThatCouldNotRunWhenItMovedToAnother() {
        XCTAssertEqual(line("claude", "anthropic", sources([anthropic], [claudeIn, codexIn], region: blocked)),
                       "Claude Code can’t run on jdcloud: Region not supported")
    }

    func testNamesAReasonOtherThanTheRegionByTheCredential() {
        let signedOut = RunnerEngineHealth(engine: "claude", installed: true, auth: "no")
        XCTAssertEqual(line("claude", "claude", sources([deepseek], [signedOut])),
                       "Using DeepSeek · Claude Code: Not signed in on jdcloud")
    }

    func testSaysNothingRunsHere() {
        XCTAssertEqual(SessionProviderChoices.cantRunLine(machine: "jdcloud"), "Nothing on jdcloud can run a session yet.")
    }
}
