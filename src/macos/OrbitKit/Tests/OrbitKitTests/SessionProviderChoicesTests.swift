import XCTest
@testable import OrbitKit

/// Mirrors web's sessionProviderChoices.test.ts — the two pickers must offer the same things, engine
/// first: the hero lists engines, the Provider menu the credentials of one (docs/provider-engine-contract.md
/// §2.1, boards iOS 4 and 5).
final class SessionProviderChoicesTests: XCTestCase {
    // Keys as GET /providers serves them: each with the engines it runs on, its default first (§6.3).
    private let deepseek = ConfiguredProvider(
        slug: "deepseek", label: "DeepSeek", runtime: "claude",
        models: [ConfiguredProviderModel(value: "deepseek-v4-pro", label: "DeepSeek V4 Pro")],
        defaultModel: "deepseek-v4-pro", presetSlug: "deepseek", runsOnOpenCode: true,
        engines: ["claude", "opencode", "dsh"])
    private var deepseek2: ConfiguredProvider {
        ConfiguredProvider(slug: "deepseek-2", label: "DeepSeek 2", runtime: "claude", models: deepseek.models,
                           defaultModel: "deepseek-v4-pro", presetSlug: "deepseek", runsOnOpenCode: true,
                           engines: ["claude", "opencode", "dsh"])
    }
    private let custom = ConfiguredProvider(
        slug: "my-endpoint", label: "my endpoint", runtime: "claude",
        models: [ConfiguredProviderModel(value: "x-1", label: "X 1")],
        defaultModel: "x-1", presetSlug: nil, runsOnOpenCode: true, engines: ["claude", "opencode"])
    private let moonshot = ConfiguredProvider(
        slug: "moonshot", label: "Kimi (Moonshot)", runtime: "kimi",
        models: [ConfiguredProviderModel(value: "kimi-k3", label: "Kimi K3")],
        defaultModel: "kimi-k3", presetSlug: "moonshot", runsOnOpenCode: true, engines: ["kimi", "opencode"])
    // A key connected from the Gemini preset, as GET /providers serves it.
    private let gemini = ConfiguredProvider(
        slug: "gemini", label: "Gemini", runtime: "antigravity",
        models: [ConfiguredProviderModel(value: "gemini-3.8-flash", label: "Gemini 3.8 Flash")],
        defaultModel: "gemini-3.8-flash", presetSlug: "gemini", modelsFromRuntime: true, runsOnOpenCode: true,
        engines: ["antigravity", "opencode"])
    // A Claude subscription token: the server says it runs on Claude Code alone.
    private let claudeMax = ConfiguredProvider(
        slug: "claude-max", label: "Claude Max", runtime: "claude", models: [], presetSlug: "anthropic",
        modelsFromRuntime: true, engines: ["claude"])
    private let anthropic = ConfiguredProvider(
        slug: "anthropic", label: "Anthropic (Claude)", runtime: "claude",
        models: [], defaultModel: "claude-opus-5", presetSlug: "anthropic", modelsFromRuntime: true,
        engines: ["claude", "opencode"])
    private let anthropic2 = ConfiguredProvider(
        slug: "anthropic-2", label: "Work account", runtime: "claude",
        models: [], defaultModel: "claude-opus-5", presetSlug: "anthropic", modelsFromRuntime: true,
        engines: ["claude", "opencode"])

    private let catalog = RunnerModelCatalog(
        claude: [RunnerModelInfo(value: "claude-opus-5", label: "Claude Opus 5")],
        codex: [RunnerModelInfo(value: "gpt-5.6-sol", label: "GPT-5.6 Sol")])
    private var dshCatalog: RunnerModelCatalog {
        RunnerModelCatalog(claude: catalog.claude, codex: catalog.codex,
                           dsh: [RunnerModelInfo(value: "acp-pro", label: "DeepSeek V4 Pro")])
    }

    private func sources(_ configured: [ConfiguredProvider] = [], catalog: RunnerModelCatalog? = nil,
                         engines: [RunnerEngineHealth]? = nil, pools: [ProviderPool] = [],
                         planUsage: PlanUsage? = nil, now: Date = Date(),
                         antigravity: RunnerAntigravityState? = nil, antigravityKeyAvailable: Bool? = nil,
                         dshState: DshRuntime.RunnerState? = nil) -> ChoiceSources {
        ChoiceSources(configured: configured, catalog: catalog ?? self.catalog, engines: engines, pools: pools,
                      planUsage: planUsage, now: now, antigravity: antigravity,
                      antigravityKeyAvailable: antigravityKeyAvailable, dshState: dshState)
    }

    private func health(_ engine: String, installed: Bool, auth: String) -> RunnerEngineHealth {
        RunnerEngineHealth(engine: engine, installed: installed, auth: auth)
    }

    private func providers(_ engine: String, _ sources: ChoiceSources) -> [ProviderChoice] {
        SessionProviderChoices.providers(for: engine, sources: sources)
    }

    private func engine(_ engines: [EngineChoice], _ slug: String) -> EngineChoice? {
        engines.first { $0.slug == slug }
    }

    // MARK: - engines: the engines a new session can pick

    func testListsTheEnginesByTheirCLINamesInTheSharedOrder() {
        let engines = SessionProviderChoices.engines(sources: sources([deepseek, moonshot, gemini], dshState: .ready))
        XCTAssertEqual(engines.map(\.slug), ["claude", "codex", "kimi", "antigravity", "opencode", "dsh"])
        XCTAssertEqual(engines.map(\.label),
                       ["Claude Code", "Codex", "Kimi Code", "Antigravity CLI", "OpenCode", "DeepSeek Harness"])
        // The hero and the composer's menu title say the same names (`engineTitle`).
        XCTAssertEqual(engines.map { SessionProviderChoices.engineTitle($0.slug) }, engines.map(\.label))
    }

    func testListsAnEngineOnceWithEveryCredentialItRunsOnOneKeyUnderSeveralEngines() {
        let engines = SessionProviderChoices.engines(sources: sources([deepseek, moonshot, gemini]))
        XCTAssertEqual(engine(engines, "claude")?.providers.map(\.slug), ["claude", "deepseek"])
        XCTAssertEqual(engine(engines, "kimi")?.providers.map(\.slug), ["kimi", "moonshot"])
        XCTAssertEqual(engine(engines, "antigravity")?.providers.map(\.slug), ["gemini"])
        // OpenCode: its own configuration, and every key it runs.
        XCTAssertEqual(engine(engines, "opencode")?.providers.map(\.slug), ["opencode", "deepseek", "moonshot", "gemini"])
    }

    func testLeavesOutAntigravityWithNeitherAKeyAGoogleAccountNorAGeminiKey() {
        XCTAssertEqual(SessionProviderChoices.engines(sources: sources()).map(\.slug), ["claude", "codex", "kimi", "opencode"])
        XCTAssertTrue(SessionProviderChoices.engines(sources: sources(antigravityKeyAvailable: true)).map(\.slug)
            .contains("antigravity"))
    }

    func testLandsOnTheEnginesOwnSignInUnlessAPreferredProviderOfItCanRun() {
        let configured = [deepseek, moonshot, gemini]
        func landing(_ preferred: [EnginePick]) -> [String?] {
            SessionProviderChoices.engines(sources: sources(configured, antigravityKeyAvailable: true, dshState: .ready),
                                           preferred: preferred).map { $0.provider?.slug }
        }
        XCTAssertEqual(landing([]), ["claude", "codex", "kimi", "antigravity", "opencode", "deepseek"])
        // The draft's pick first, then what the workspace last ran: each only on its own engine.
        XCTAssertEqual(landing([EnginePick(engine: "claude", provider: "deepseek"),
                                EnginePick(engine: "kimi", provider: "moonshot")]),
                       ["deepseek", "codex", "moonshot", "antigravity", "opencode", "deepseek"])
        XCTAssertEqual(landing([EnginePick(engine: "opencode", provider: "deepseek")]),
                       ["claude", "codex", "kimi", "antigravity", "deepseek", "deepseek"])
    }

    func testSkipsAPreferredProviderThatCannotRunAndASignedOutSignInForOneThatCan() {
        let engines = SessionProviderChoices.engines(
            sources: sources([deepseek], engines: [health("claude", installed: true, auth: "no")]))
        let claude = engine(engines, "claude")!
        XCTAssertEqual(claude.provider?.slug, "deepseek")
        XCTAssertNil(claude.unavailable)
    }

    func testCarriesTheReasonWhenNoCredentialOfTheEngineCanRun() {
        let engines = SessionProviderChoices.engines(
            sources: sources([moonshot], engines: [health("kimi", installed: false, auth: "unknown")]),
            preferred: [EnginePick(engine: "kimi", provider: "moonshot")])
        let kimi = engine(engines, "kimi")!
        XCTAssertEqual(kimi.provider?.slug, "kimi")
        XCTAssertEqual(kimi.unavailable, "Not installed")
        XCTAssertEqual(kimi.fixEngine, "kimi")
    }

    /// OpenCode is listed whether or not the runner has it — Orbit installs it — so the row carries the
    /// reason and where it is fixed rather than vanishing. It has no sign-in to relay, so it is never a
    /// pick before the CLI is there, and the keys it could spend wait with it.
    func testKeepsOpenCodeListedWithItsReasonUntilTheRunnerReportsItInstalled() {
        let missing = SessionProviderChoices.engines(
            sources: sources([deepseek], engines: [health("opencode", installed: false, auth: "unknown")]))
        let openCode = engine(missing, "opencode")!
        XCTAssertEqual(openCode.label, "OpenCode")
        XCTAssertEqual(openCode.unavailable, "Not installed")
        XCTAssertEqual(openCode.fixEngine, "opencode")
        XCTAssertTrue(openCode.providers.allSatisfy { $0.unavailable == "Not installed" })
        // What the row ends with: an install to send the user to, never a sign-in this client has no
        // relay for.
        XCTAssertEqual("\(openCode.unavailable ?? "")\(SessionProviderChoices.fixSuffix(openCode.fixEngine))",
                       "Not installed →")
        // A runner that reports its engines but not OpenCode has not got it either.
        XCTAssertEqual(engine(SessionProviderChoices.engines(
            sources: sources(engines: [health("claude", installed: true, auth: "yes")])), "opencode")?.unavailable,
                       "Not installed")
        // A runner that has reported nothing claims nothing.
        XCTAssertNil(engine(SessionProviderChoices.engines(sources: sources()), "opencode")?.unavailable)
    }

    func testPreviewsEachEnginesModelByWhereItLands() {
        let engines = SessionProviderChoices.engines(sources: sources([deepseek]),
                                                     preferred: [EnginePick(engine: "claude", provider: "deepseek")])
        XCTAssertEqual(engine(engines, "claude")?.provider?.modelLabel, "DeepSeek V4 Pro")
        XCTAssertEqual(engine(engines, "codex")?.provider?.modelLabel, "GPT-5.6 Sol")
        XCTAssertEqual(engine(engines, "kimi")?.provider?.modelLabel, "Kimi for Coding")
        XCTAssertEqual(engine(engines, "opencode")?.provider?.modelLabel, "Managed by OpenCode")
    }

    /// The arrow a row's reason ends with: only an engine this client can drive a sign-in for promises
    /// one. Everything else — an install, a runner update, a key to connect — gets the bare arrow,
    /// OpenCode included now that Orbit installs it.
    func testOnlyASignInTheClientCanDriveClosesARowWithSignIn() {
        for engine in ["claude", "codex", "kimi"] {
            XCTAssertEqual(SessionProviderChoices.fixSuffix(engine), ", sign in →")
        }
        for engine in ["opencode", "dsh", DshRuntime.connectFix, "antigravity"] {
            XCTAssertEqual(SessionProviderChoices.fixSuffix(engine), " →")
        }
    }

    // MARK: - DeepSeek Harness, on the DeepSeek keys (board iOS 4 ③)

    func testListsEveryDeepSeekKeyUnderHarnessAndLandsOnTheFirst() {
        let engines = SessionProviderChoices.engines(
            sources: sources([deepseek, deepseek2, moonshot], catalog: dshCatalog, dshState: .ready))
        let dsh = engine(engines, "dsh")!
        XCTAssertEqual(dsh.label, "DeepSeek Harness")
        XCTAssertEqual(dsh.brandKey, "deepseek")
        XCTAssertEqual(dsh.providers.map(\.slug), ["deepseek", "deepseek-2"])
        XCTAssertTrue(dsh.providers.allSatisfy { $0.kind == .key })
        XCTAssertEqual(dsh.provider?.slug, "deepseek")
        XCTAssertEqual(dsh.provider?.modelLabel, "DeepSeek V4 Pro")
        // A key with no DeepSeek Harness among its engines is not one of them.
        XCTAssertFalse(dsh.providers.map(\.slug).contains("moonshot"))
    }

    func testOffersToConnectADeepSeekKeyWhenThereIsNone() {
        let dsh = engine(SessionProviderChoices.engines(sources: sources([moonshot], dshState: .ready)), "dsh")!
        XCTAssertEqual(dsh.label, "DeepSeek Harness")
        XCTAssertNil(dsh.provider)
        XCTAssertEqual(dsh.providers, [])
        XCTAssertEqual(dsh.unavailable, "Connect a DeepSeek key")
        XCTAssertEqual(dsh.fixEngine, DshRuntime.connectFix)
        XCTAssertEqual(DshRuntime.keyPreset, "deepseek")
    }

    func testOffersNoConnectionOnARunnerTooOldForItAndNoneWhereThereIsAKey() {
        XCTAssertNil(engine(SessionProviderChoices.engines(sources: sources(dshState: .updateRunner)), "dsh"))
        XCTAssertNil(engine(SessionProviderChoices.engines(sources: sources(dshState: nil)), "dsh"),
                     "a runner snapshot not yet read claims nothing")
        XCTAssertNil(engine(SessionProviderChoices.engines(sources: sources([deepseek], dshState: .ready)), "dsh")?
            .unavailable)
    }

    func testKeepsItsKeysListedWhereHarnessCannotRunWithTheReasonAndTheEngineRowThatFixesIt() {
        for (state, reason) in [(DshRuntime.RunnerState.updateRunner, "Update runner"), (.notInstalled, "Not installed"),
                                (.unsupportedPlatform, "Not supported here"), (.unsupportedVersion, "Unsupported version")] {
            let rows = providers("dsh", sources([deepseek], dshState: state))
            XCTAssertEqual(rows.first?.slug, "deepseek")
            XCTAssertEqual(rows.first?.unavailable, reason)
            XCTAssertEqual(rows.first?.fixEngine, "dsh")
            // The same key on Claude Code does not wait on Harness.
            XCTAssertNil(providers("claude", sources([deepseek], dshState: state)).first { $0.slug == "deepseek" }?
                .unavailable)
        }
    }

    func testRunsTheSameKeyOnClaudeCodeAndOpenCodeTooNeverNamingTheEngineOnTheKey() {
        let engines = SessionProviderChoices.engines(sources: sources([deepseek], dshState: .ready))
        for slug in ["claude", "opencode", "dsh"] {
            let row = engine(engines, slug)!.providers.first { $0.slug == "deepseek" }!
            XCTAssertEqual(row.label, "DeepSeek")
            XCTAssertEqual(row.kind, .key)
            XCTAssertNil(row.labelDetail)
        }
    }

    // MARK: - providers(for:): the credentials an engine runs on, in the Provider menu's order

    func testListsTheSignInThenThePoolsThenTheKeysOnlyThoseTheEngineRuns() {
        let pool = ProviderPool(id: "pool", slug: "claude-accounts", label: "Claude accounts",
                                members: [poolMember(claudeMax, .available)])
        let configured = [deepseek, claudeMax, moonshot] + ProviderPools.asProviders([pool])
        let rows = providers("claude", sources(configured, pools: [pool]))
        XCTAssertEqual(rows.map(\.slug), ["claude", "claude-accounts", "deepseek", "claude-max"])
        XCTAssertEqual(rows.map(\.kind), [.login, .pool, .key, .key])
    }

    func testKeepsASubscriptionTokenWhichAnthropicServesToClaudeCodeAloneOffOpenCode() {
        let configured = [deepseek, claudeMax]
        XCTAssertEqual(providers("opencode", sources(configured)).map(\.slug), ["opencode", "deepseek"])
        XCTAssertTrue(providers("claude", sources(configured)).map(\.slug).contains("claude-max"))
    }

    func testReadsARowFromAPayloadWithoutEnginesByItsProtocolAndOpenCodeWhereItSaysSo() {
        let older = ConfiguredProvider(slug: "gw", label: "Gateway", runtime: "codex")
        XCTAssertEqual(providers("codex", sources([older])).map(\.slug), ["codex", "gw"])
        XCTAssertEqual(providers("opencode", sources([older])).map(\.slug), ["opencode"])
        let openCode = ConfiguredProvider(slug: "gw", label: "Gateway", runtime: "codex", runsOnOpenCode: true)
        XCTAssertEqual(providers("opencode", sources([openCode])).map(\.slug), ["opencode", "gw"])
    }

    func testDropsAConfiguredRowThatShadowsABuiltInEngineSlug() {
        let shadow = ConfiguredProvider(slug: "kimi", label: "Kimi (custom)", runtime: "claude", engines: ["kimi"])
        let rows = providers("kimi", sources([shadow]))
        XCTAssertEqual(rows.filter { $0.slug == "kimi" }.count, 1)
        XCTAssertEqual(rows.first?.kind, .login)
    }

    func testCarriesEachCredentialsResolvedDefaultModelOnThisEngine() {
        let rows = providers("claude", sources([deepseek]))
        XCTAssertEqual(rows.first { $0.kind == .login }?.modelLabel, "Claude Opus 5")
        XCTAssertEqual(rows.first { $0.slug == "deepseek" }?.modelLabel, "DeepSeek V4 Pro")
    }

    func testEngineBorrowsItsVendorMarkAndACustomEndpointHasNone() {
        XCTAssertEqual(providers("claude", sources([deepseek, custom])).first?.brandKey, "anthropic")
        XCTAssertEqual(providers("codex", sources()).first?.brandKey, "openai")
        XCTAssertEqual(providers("kimi", sources()).first?.brandKey, "moonshot")
        XCTAssertEqual(providers("claude", sources([deepseek, custom])).first { $0.slug == "deepseek" }?.brandKey,
                       "deepseek")
        XCTAssertNil(providers("claude", sources([deepseek, custom])).first { $0.slug == "my-endpoint" }?.brandKey)
        // Antigravity wears its own mark rather than the Gemini preset's, which is the Gemini API.
        XCTAssertEqual(SessionProviderChoices.enginePreset["antigravity"], "antigravity")
    }

    func testKeepsASignInTheRunnerDoesNotHaveInstalledWithTheReasonFixedOnItsOwnEngineRow() {
        let report = [health("claude", installed: true, auth: "yes"), health("codex", installed: false, auth: "unknown"),
                      health("kimi", installed: false, auth: "unknown")]
        // Hiding it would leave "why is Kimi missing?" with no answer anywhere in the product.
        let kimi = providers("kimi", sources(engines: report)).first { $0.kind == .login }
        XCTAssertEqual(kimi?.unavailable, "Not installed")
        XCTAssertEqual(kimi?.fixEngine, "kimi")
        XCTAssertEqual(providers("codex", sources(engines: report)).first?.unavailable, "Not installed")
        XCTAssertNil(providers("claude", sources(engines: report)).first?.unavailable)
    }

    func testSaysNotInstalledNotSignedOutForAMissingCLIThatNeverAnswered() {
        XCTAssertEqual(providers("kimi", sources(engines: [health("kimi", installed: false, auth: "no")])).first?.unavailable,
                       "Not installed")
    }

    func testKeepsAnInstalledButSignedOutSignInWithTheReasonAndUnknownPickable() {
        let report = [health("codex", installed: true, auth: "no"), health("kimi", installed: true, auth: "unknown")]
        XCTAssertEqual(providers("codex", sources(engines: report)).first?.unavailable, "Not signed in")
        // `unknown` is a CLI that wouldn't answer, not a "no" — it stays runnable.
        XCTAssertNil(providers("kimi", sources(engines: report)).first?.unavailable)
    }

    func testBlocksAKeyWhoseEnginesCLIIsNotInstalledAndKeepsItOnASignedOutOne() {
        let missing = providers("kimi", sources([moonshot], engines: [health("kimi", installed: false, auth: "unknown")]))
        XCTAssertEqual(missing.first { $0.slug == "moonshot" }?.unavailable, "Not installed")
        XCTAssertEqual(missing.first { $0.slug == "moonshot" }?.fixEngine, "kimi")
        // The key is the credential, so the engine's own sign-in does not apply.
        let signedOut = providers("kimi", sources([moonshot], engines: [health("kimi", installed: true, auth: "no")]))
        XCTAssertEqual(signedOut.first { $0.kind == .login }?.unavailable, "Not signed in")
        XCTAssertNil(signedOut.first { $0.slug == "moonshot" }?.unavailable)
        // Nothing reported about the CLI: nothing claimed.
        XCTAssertNil(providers("kimi", sources([moonshot], engines: nil)).first { $0.slug == "moonshot" }?.unavailable)
        XCTAssertTrue(SessionProviderChoices.engines(sources: sources(engines: nil))
            .allSatisfy { $0.unavailable == nil })
    }

    // MARK: - Antigravity's sign-in and Gemini keys

    func testOffersTheAntigravitySignInWithTheModelTheRunnerReportsFirstAndSaysHowItSignsIn() {
        let agy = RunnerModelCatalog(antigravity: [
            RunnerModelInfo(value: "gemini-3.8-flash", label: "Gemini 3.8 Flash", reasoningLevels: ["low", "medium", "high"]),
            RunnerModelInfo(value: "gemini-3.1-pro", label: "Gemini 3.1 Pro", reasoningLevels: ["low", "high"]),
        ])
        let row = providers("antigravity", sources(catalog: agy, antigravityKeyAvailable: true)).first
        XCTAssertEqual(row?.kind, .login)
        XCTAssertEqual(row?.labelDetail, "env key")
        XCTAssertEqual(row?.brandKey, "antigravity")
        XCTAssertEqual(row?.modelLabel, "Gemini 3.8 Flash")
        XCTAssertNil(row?.accounts)
        // Before a runner reports its catalogue, the picker names the preset's default.
        XCTAssertEqual(providers("antigravity", sources(antigravityKeyAvailable: true)).first?.modelLabel,
                       "Gemini 3.8 Flash")
    }

    func testUsesTheServerKeyBooleanInsteadOfInferringAvailabilityFromRunnerAuth() {
        let ready = RunnerAntigravityState(supported: true, installed: true, envKeyAvailable: true)
        let rawAuth = [health("antigravity", installed: true, auth: "yes")]
        XCTAssertEqual(providers("antigravity", sources([gemini], engines: rawAuth)).map(\.slug), ["gemini"],
                       "raw runner auth is not a client-side key source")
        XCTAssertEqual(providers("antigravity", sources([gemini], antigravity: ready, antigravityKeyAvailable: false))
            .map(\.slug), ["gemini"])
        XCTAssertEqual(providers("antigravity", sources(antigravity: ready, antigravityKeyAvailable: true)).first?.labelDetail,
                       "env key")
        // A Gemini key keeps its own name and Google Gemini's mark, whichever engine runs it.
        for slug in ["antigravity", "opencode"] {
            let row = providers(slug, sources([gemini])).first { $0.slug == "gemini" }
            XCTAssertEqual(row?.label, "Gemini")
            XCTAssertEqual(row?.kind, .key)
            XCTAssertEqual(row?.brandKey, "gemini")
        }
    }

    func testAllowsAWorkspaceKeyToRunAntigravityAfterTheRunnerGoogleSignInExpires() {
        let expired = RunnerAntigravityState(supported: true, installed: true, envKeyAvailable: false,
                                             authSource: "google", googleLogin: .available)
        let report = [RunnerEngineHealth(engine: "antigravity", installed: true, auth: "no", authSource: "google")]
        func login(_ keyAvailable: Bool?) -> ProviderChoice? {
            providers("antigravity", sources([gemini], engines: report, antigravity: expired,
                                             antigravityKeyAvailable: keyAvailable)).first { $0.kind == .login }
        }
        XCTAssertEqual(login(nil)?.labelDetail, "Google account")
        XCTAssertEqual(login(nil)?.unavailable, "Not signed in")
        XCTAssertEqual(login(nil)?.fixEngine, "antigravity")
        XCTAssertEqual(login(true)?.labelDetail, "env key")
        XCTAssertNil(login(true)?.unavailable)
    }

    func testBlocksBothGeminiEntrancesWithTheServerReadiness() {
        for (state, reason) in [(RunnerAntigravityState(supported: false, installed: true), "Update runner"),
                                (RunnerAntigravityState(supported: true, installed: false), "Not installed")] {
            let rows = providers("antigravity", sources([gemini], antigravity: state, antigravityKeyAvailable: true))
            for slug in ["antigravity", "gemini"] {
                XCTAssertEqual(rows.first { $0.slug == slug }?.unavailable, reason)
                XCTAssertEqual(rows.first { $0.slug == slug }?.fixEngine, "antigravity")
            }
        }
    }

    func testBlocksAGeminiKeyWhereAgyIsMissingAndKeepsItWhereAgyIsSignedOut() {
        let missing = providers("antigravity", sources([gemini], engines: [health("antigravity", installed: false, auth: "unknown")]))
        XCTAssertEqual(missing.first { $0.slug == "gemini" }?.unavailable, "Not installed")
        XCTAssertEqual(missing.first { $0.slug == "gemini" }?.fixEngine, "antigravity")
        let ready = providers("antigravity", sources([gemini], engines: [health("antigravity", installed: true, auth: "no")]))
        XCTAssertNil(ready.first { $0.slug == "gemini" }?.unavailable)
    }

    func testWorkspaceKeyAvailabilityMapDecodesAndUsesTheSelectedRunner() throws {
        let runner = try JSONDecoder().decode(Runner.self, from: Data(#"{"id":"r1","name":"HPC","antigravity":{"supported":true,"installed":true,"version":"1.0.0","envKeyAvailable":true}}"#.utf8))
        let workspace = try JSONDecoder().decode(Agent.self, from: Data(#"{"id":"w1","name":"repo","env":{"GEMINI_API_KEY":"present"},"antigravityKeyAvailableByRunner":{"r1":false,"r2":true}}"#.utf8))
        XCTAssertEqual(runner.antigravity?.version, "1.0.0")
        XCTAssertTrue(SessionProviderChoices.antigravityKeyAvailable(workspace: nil, runner: runner))
        XCTAssertFalse(SessionProviderChoices.antigravityKeyAvailable(workspace: workspace, runner: runner),
                       "neither raw env nor the runner boolean overrides the workspace result")
        let noMap = try JSONDecoder().decode(Agent.self, from: Data(#"{"id":"w1","name":"repo"}"#.utf8))
        XCTAssertFalse(SessionProviderChoices.antigravityKeyAvailable(workspace: noMap, runner: runner))
        let session = try JSONDecoder().decode(Session.self, from: Data(#"{"id":"s1","status":"PENDING","agent":{"id":"w1","antigravityKeyAvailableByRunner":{"r1":true}}}"#.utf8))
        XCTAssertEqual(session.agent?.antigravityKeyAvailableByRunner, ["r1": true])
    }

    // MARK: - current: a session's provider its engine's menu does not list

    func testCurrentResolvesThePickFromTheListedCredentials() {
        let rows = providers("claude", sources([deepseek]))
        let current = SessionProviderChoices.current(engine: "claude", provider: "deepseek", in: rows, sources: sources([deepseek]))
        XCTAssertEqual(current.label, "DeepSeek")
        XCTAssertEqual(current.kind, .key)
    }

    func testCurrentNamesOpenCodesOwnConfigurationAsItself() {
        let current = SessionProviderChoices.current(engine: "opencode", provider: "opencode", in: [], sources: sources())
        XCTAssertEqual(current.slug, "opencode")
        XCTAssertEqual(current.kind, .opencode)
        XCTAssertEqual(current.label, "OpenCode's own sign-in")
        XCTAssertEqual(current.labelDetail, "opencode auth")
        XCTAssertEqual(current.modelLabel, "Managed by OpenCode")
    }

    func testCurrentSynthesizesAKeyThatHasSinceBeenRemovedWithoutMovingTheEngine() {
        let current = SessionProviderChoices.current(engine: "dsh", provider: "gone-away", in: [], sources: sources())
        XCTAssertEqual(current.slug, "gone-away")
        XCTAssertEqual(current.label, "gone-away")
        XCTAssertEqual(current.kind, .key)
        XCTAssertNil(current.brandKey)
    }

    func testCurrentKeepsAConfiguredKeysOwnNameWhereItsEngineDoesNotListIt() {
        XCTAssertEqual(SessionProviderChoices.current(engine: "dsh", provider: "moonshot", in: [],
                                                      sources: sources([moonshot])).label, "Kimi (Moonshot)")
    }

    func testCurrentNamesTheLegacyBuiltInDshAsTheKeyItsWorkspacesEnvironmentHolds() {
        let current = SessionProviderChoices.current(engine: "dsh", provider: "dsh", in: [], sources: sources())
        XCTAssertEqual(current.slug, "dsh")
        XCTAssertEqual(current.label, "Workspace key")
        XCTAssertEqual(current.labelDetail, "ORBIT_DSH_API_KEY")
    }

    func testCurrentKeepsAnAntigravitySessionsSignInAndItsReason() {
        let current = SessionProviderChoices.current(engine: "antigravity", provider: "antigravity", in: [],
                                                     sources: sources(antigravity: RunnerAntigravityState(supported: false)))
        XCTAssertEqual(current.kind, .login)
        XCTAssertEqual(current.modelLabel, "Gemini 3.8 Flash")
        XCTAssertEqual(current.labelDetail, "env key")
        XCTAssertEqual(current.unavailable, "Update runner")
        XCTAssertEqual(current.fixEngine, "antigravity")
    }

    func testLandsTheHerosCurrentEngineOnThePickEvenWhereItsEngineDoesNotListIt() {
        let engines = SessionProviderChoices.engines(sources: sources([deepseek]))
        let current = SessionProviderChoices.currentEngine(engine: "claude", provider: "gone-away", engines: engines,
                                                           sources: sources([deepseek]))
        XCTAssertEqual(current.slug, "claude")
        XCTAssertEqual(current.label, "Claude Code")
        XCTAssertEqual(current.provider?.slug, "gone-away")
        XCTAssertEqual(current.providers.map(\.slug), ["claude", "deepseek"])
    }

    // MARK: - model labels

    func testSaysWhoPicksWhenTheEngineManagesTheModelItself() {
        XCTAssertEqual(SessionProviderChoices.modelLabel(engine: "opencode", provider: "opencode", sources: sources()),
                       "Managed by OpenCode")
        XCTAssertEqual(SessionProviderChoices.modelLabel(engine: "dsh", provider: "deepseek", sources: sources([deepseek])),
                       "Managed by the provider")
    }

    func testNamesAModelByItsCatalogueLabelPerEngineAndCredential() {
        XCTAssertEqual(SessionProviderChoices.modelLabel(engine: "kimi", provider: "kimi", sources: sources()), "Kimi for Coding")
        XCTAssertEqual(SessionProviderChoices.modelLabel(engine: "claude", provider: "deepseek", sources: sources([deepseek])),
                       "DeepSeek V4 Pro")
        XCTAssertEqual(SessionProviderChoices.modelLabel(engine: "opencode", provider: "deepseek", sources: sources([deepseek])),
                       "DeepSeek V4 Pro")
        XCTAssertEqual(SessionProviderChoices.modelLabel(engine: "dsh", provider: "deepseek",
                                                         sources: sources([deepseek], catalog: dshCatalog)),
                       "DeepSeek V4 Pro")
    }

    // MARK: - the Provider menu of a session, by its engine (board iOS 5)

    func testOffersTheEnginesOwnSignInAndEveryKeyItRunsInOneOrderWhicheverIsRunning() {
        let configured = [anthropic, anthropic2, deepseek, moonshot]
        XCTAssertEqual(providers("claude", sources(configured)).map(\.slug), ["claude", "anthropic", "anthropic-2", "deepseek"])
    }

    func testNeverOffersAnotherEnginesCredentials() {
        let rows = providers("claude", sources([anthropic, anthropic2, deepseek, moonshot])).map(\.slug)
        XCTAssertFalse(rows.contains("codex"))
        XCTAssertFalse(rows.contains("kimi"))
        XCTAssertFalse(rows.contains("moonshot"))
        // OpenCode is its own engine: never every Anthropic key on the account read as Claude's.
        XCTAssertEqual(providers("opencode", sources([claudeMax])).map(\.slug), ["opencode"])
        XCTAssertEqual(providers("antigravity", sources([anthropic, moonshot], antigravityKeyAvailable: true)).map(\.slug),
                       ["antigravity"])
    }

    func testLeavesALoneCredentialAloneSoTheComposerCanLeaveTheProviderRowOut() {
        XCTAssertEqual(providers("kimi", sources()).count, 1)
        XCTAssertEqual(providers("codex", sources()).count, 1)
    }

    func testKeepsATargetThisMachineCannotRunWithItsReasonTheKeysStayPickable() {
        let rows = providers("claude", sources([anthropic, anthropic2], engines: [health("claude", installed: true, auth: "no")]))
        XCTAssertEqual(rows.map(\.slug), ["claude", "anthropic", "anthropic-2"])
        XCTAssertEqual(rows[0].unavailable, "Not signed in")
        XCTAssertEqual(rows[0].fixEngine, "claude")
        XCTAssertNil(rows.first { $0.slug == "anthropic-2" }?.unavailable)
    }

    func testStillNamesEveryOptionWhenNothingOnThatCLICanRun() {
        let rows = providers("claude", sources([anthropic, anthropic2], engines: [health("claude", installed: false, auth: "unknown")]))
        XCTAssertTrue(rows.allSatisfy { $0.unavailable == "Not installed" })
    }

    func testNamesAnEnginesOwnSignInByTheEngineWhereItsEngineIsNotBesideIt() {
        let rows = providers("claude", sources([deepseek]))
        XCTAssertEqual(SessionProviderChoices.providerName(on: "claude", rows[0]), "Claude Code")
        XCTAssertEqual(SessionProviderChoices.providerName(on: "claude", rows[1]), "DeepSeek")
    }

    // MARK: - account pools among the credentials

    private func poolMember(_ provider: ConfiguredProvider, _ state: PoolMemberState,
                            next: Bool = false) -> PoolMember {
        PoolMember(id: "id-\(provider.slug)", slug: provider.slug, label: provider.label,
                   presetSlug: "anthropic", state: state, next: next)
    }

    private func claudePool(_ states: (PoolMemberState, PoolMemberState) = (.available, .running),
                            resetsAt: String? = nil, unavailable: String? = nil) -> ProviderPool {
        ProviderPool(id: "pool-1", slug: "claude-accounts", label: "Claude accounts", resetsAt: resetsAt,
                     unavailable: unavailable,
                     members: [poolMember(anthropic, states.0, next: states.0 == .available),
                               poolMember(anthropic2, states.1)])
    }

    private let opus5 = RunnerModelCatalog(claude: [RunnerModelInfo(value: "claude-opus-5", label: "Opus 5")])

    /// The catalogue the pickers read: the keys, then the pools as providers (ProviderPools.asProviders).
    private func withPools(_ keys: [ConfiguredProvider], _ pools: [ProviderPool]) -> [ConfiguredProvider] {
        keys + ProviderPools.asProviders(pools)
    }

    func testAPoolIsOneChoiceAfterTheSignInWithItsAccountCount() {
        let pool = claudePool()
        let rows = providers("claude", sources(withPools([anthropic, anthropic2, deepseek], [pool]), catalog: opus5,
                                              pools: [pool]))
        XCTAssertEqual(rows.map(\.slug), ["claude", "claude-accounts", "anthropic", "anthropic-2", "deepseek"])
        let tile = rows.first { $0.slug == "claude-accounts" }
        XCTAssertEqual(tile?.kind, .pool)
        XCTAssertEqual(tile?.poolSize, 2)
        XCTAssertEqual(tile?.label, "Claude accounts")
        XCTAssertEqual(tile?.brandKey, "anthropic")
        XCTAssertEqual(tile?.modelLabel, "Opus 5")
        XCTAssertNil(tile?.unavailable)
        XCTAssertNil(tile?.note)
        XCTAssertNil(tile?.poolUnit, "an account pool's badge counts accounts")
        XCTAssertEqual(rows.filter { $0.slug == "claude-accounts" }.count, 1, "listed once, as the pool")
        // A pool runs on its own engine alone.
        XCTAssertFalse(providers("opencode", sources(withPools([], [pool]), pools: [pool])).contains { $0.slug == "claude-accounts" })
    }

    /// Its accounts stay pickable on their own — pinning one is a real need — but are marked for a pick
    /// to land on the pool first; a key in no pool is not.
    func testTheAccountsOfAPoolAreMarkedAndStayPickable() {
        let pool = claudePool()
        let rows = providers("claude", sources(withPools([anthropic, anthropic2, deepseek], [pool]), pools: [pool]))
        XCTAssertEqual(rows.filter(\.inPool).map(\.slug), ["anthropic", "anthropic-2"])
        XCTAssertTrue(rows.filter(\.inPool).allSatisfy { $0.kind == .key && $0.unavailable == nil })
        XCTAssertFalse(rows.first { $0.slug == "deepseek" }?.inPool ?? true)
        XCTAssertNil(rows.first { $0.slug == "deepseek" }?.poolSize)
        // With its sign-in signed out, Claude Code lands on the pool before an account in it.
        let landing = SessionProviderChoices.engines(
            sources: sources(withPools([anthropic, anthropic2], [pool]), engines: [health("claude", installed: true, auth: "no")],
                             pools: [pool])).first { $0.slug == "claude" }?.provider?.slug
        XCTAssertEqual(landing, "claude-accounts")
    }

    /// A pool the server says cannot run: greyed out with its reason, and no runner to send it to —
    /// nothing on a machine gives it an account that can.
    func testAPoolTheServerSaysCannotRunIsGreyedWithItsReason() {
        let stuck = claudePool((.refused, .disabled), unavailable: "No account can run")
        let tile = providers("claude", sources(withPools([anthropic, anthropic2], [stuck]), pools: [stuck]))
            .first { $0.slug == "claude-accounts" }
        XCTAssertEqual(tile?.unavailable, "No account can run")
        XCTAssertNil(tile?.fixEngine)
        XCTAssertNil(tile?.note)
    }

    /// "0 of N available" because every account is spent is not unavailable: the server takes the pool
    /// and a session on it waits for the first reset. So it stays pickable, and says when that is where
    /// its model would be.
    func testAFullySpentPoolStaysPickableAndSaysWhenItFreesUp() {
        let spent = claudePool((.spent, .spent), resetsAt: "2026-09-25T10:30:00.000Z")
        let now = RelativeTime.parse("2026-09-25T09:00:00.000Z")!
        let tile = providers("claude", sources(withPools([anthropic, anthropic2], [spent]), catalog: opus5,
                                               pools: [spent], now: now))
            .first { $0.slug == "claude-accounts" }
        XCTAssertNil(tile?.unavailable)
        XCTAssertNil(tile?.fixEngine)
        XCTAssertEqual(tile?.note,
                       "All spent · resets \(ProviderPools.formatResetTime("2026-09-25T10:30:00.000Z", now: now)!)")
        XCTAssertEqual(tile?.modelLabel, "Opus 5")
    }

    /// A pool runs on the Claude CLI like a key does, so a runner without it can't run the pool either —
    /// and that one is fixed on the runner, so it outranks the accounts.
    func testAPoolNeedsTheClaudeCLIAndThatIsFixedOnTheRunner() {
        let spent = claudePool((.spent, .spent))
        let tile = providers("claude", sources(withPools([anthropic, anthropic2], [spent]),
                                               engines: [health("claude", installed: false, auth: "no")], pools: [spent]))
            .first { $0.slug == "claude-accounts" }
        XCTAssertEqual(tile?.unavailable, "Not installed")
        XCTAssertEqual(tile?.fixEngine, "claude")
        // Signed out doesn't matter: each run carries one of the accounts' own keys.
        let signedOut = providers("claude", sources(withPools([anthropic], [claudePool()]),
                                                    engines: [health("claude", installed: true, auth: "no")],
                                                    pools: [claudePool()]))
        XCTAssertNil(signedOut.first { $0.slug == "claude-accounts" }?.unavailable)
    }

    // MARK: - shared pools (a pool of OpenAI keys, drawn as a pool whose members are its keys)

    private let codexCatalog = RunnerModelCatalog(
        codex: [RunnerModelInfo(value: "gpt-5.6-sol", label: "GPT-5.6 Sol")])

    /// A shared pool as its maker reads it — or, `added`, as somebody its maker added does.
    private func sharedPool(_ keys: [SharedPoolKey], added: Bool = false,
                            monthEnds: String = "2026-10-01T00:00:00.000Z") -> ProviderPool {
        SharedPools.asProviderPool(SharedPool(
            id: "pool-2", slug: "team-codex", label: "Team Codex",
            window: SharedPoolWindow(start: "2026-09-01T00:00:00.000Z", end: monthEnds),
            people: [SharedPoolPerson(userId: "wikova", name: "Wikova", role: .admin, creator: true, you: !added)]
                + (added ? [SharedPoolPerson(userId: "me", name: "Me", you: true)] : []),
            keys: keys))
    }

    private func sharedKey(_ id: String, cap: Int? = nil, others: Double = 0,
                           you: Bool = false, next: Bool = false) -> SharedPoolKey {
        SharedPoolKey(id: id, label: id, fingerprint: "sk-…0000", shareCap: cap,
                      contributor: PoolKeyContributor(userId: you ? "me" : "wikova",
                                                      name: you ? "Me" : "Wikova", you: you),
                      usage: PoolSpend(costUsd: others, othersCostUsd: others), next: next)
    }

    /// A shared pool is one choice like an account pool — under Codex, its mark Codex's, its badge
    /// counting keys, and its models the Codex CLI's, because that is what it runs on.
    func testASharedPoolIsOneChoiceUnderCodexWithTheCodexMarkAndItsKeyCount() {
        let pool = sharedPool([sharedKey("orbit-org-1", next: true), sharedKey("orbit-org-2")])
        let rows = providers("codex", sources(withPools([deepseek], [pool]), catalog: codexCatalog, pools: [pool]))
        XCTAssertEqual(rows.map(\.slug), ["codex", "team-codex"])
        let tile = rows.first { $0.slug == "team-codex" }
        XCTAssertEqual(tile?.kind, .pool)
        XCTAssertEqual(tile?.label, "Team Codex")
        XCTAssertEqual(tile?.brandKey, "openai")
        XCTAssertEqual(tile?.poolSize, 2)
        XCTAssertEqual(tile?.poolUnit, "key")
        XCTAssertEqual(tile?.modelLabel, "GPT-5.6 Sol")
        XCTAssertNil(tile?.unavailable)
        // Never under Claude Code, however nearby it is listed.
        XCTAssertFalse(providers("claude", sources(withPools([deepseek], [pool]), pools: [pool])).contains { $0.slug == "team-codex" })
    }

    /// Its CLI is Codex, so a runner without that one can't run the pool — while the Claude CLI's
    /// absence leaves it alone, and the other way round for the account pool beside it.
    func testASharedPoolNeedsTheCodexCLIAndThatIsFixedOnThatRow() {
        let shared = sharedPool([sharedKey("orbit-org-1")])
        let account = claudePool()
        let report = [health("claude", installed: true, auth: "yes"), health("codex", installed: false, auth: "unknown")]
        let configured = withPools([anthropic], [shared, account])
        let tile = providers("codex", sources(configured, engines: report, pools: [shared, account]))
            .first { $0.slug == "team-codex" }
        XCTAssertEqual(tile?.unavailable, "Not installed")
        XCTAssertEqual(tile?.fixEngine, "codex")
        XCTAssertNil(providers("claude", sources(configured, engines: report, pools: [shared, account]))
            .first { $0.slug == "claude-accounts" }?.unavailable,
                     "an account pool runs on Claude, which this machine has")
    }

    /// A key OpenAI refused, or one switched off, is why a shared pool goes grey — and it stays listed,
    /// saying so, rather than disappearing from a picker that exists to answer exactly this.
    func testASharedPoolWithNoKeyThatCanRunIsGreyedWithThePoolsWords() {
        let stuck = sharedPool([SharedPoolKey(id: "k", label: "orbit-org-1", fingerprint: "sk-…0000",
                                              state: .invalid,
                                              contributor: PoolKeyContributor(userId: "u", name: "Wikova"))])
        let tile = providers("codex", sources(withPools([], [stuck]), pools: [stuck])).first { $0.slug == "team-codex" }
        XCTAssertEqual(tile?.unavailable, "No key can run")
        XCTAssertNil(tile?.fixEngine, "nothing on a runner gives it a key that can run")
    }

    /// Somebody a pool's maker added reads the same words its maker does: since 2026-10-03 the pool's
    /// ChatGPT accounts run their sessions too, so what the pool holds is what they can run on.
    func testAPoolSomebodyItsMakerAddedReadsSaysThePoolsOwnWords() {
        let refused = SharedPoolKey(id: "k", label: "orbit-org-1", fingerprint: "sk-…0000", state: .invalid,
                                    contributor: PoolKeyContributor(userId: "wikova", name: "Wikova"))
        func tile(_ pool: ProviderPool) -> ProviderChoice? {
            providers("codex", sources(withPools([], [pool]), pools: [pool])).first { $0.slug == "team-codex" }
        }
        XCTAssertEqual(tile(sharedPool([], added: true))?.unavailable, "No keys")
        XCTAssertEqual(tile(sharedPool([refused], added: true))?.unavailable, "No key can run")
        XCTAssertNil(tile(sharedPool([refused], added: true))?.fixEngine)
        XCTAssertEqual(tile(sharedPool([]))?.unavailable, "No keys", "its maker reads the pool's own words")
        XCTAssertNil(tile(sharedPool([sharedKey("orbit-org-1")], added: true))?.unavailable,
                     "a key of it can run: the pool takes the pick")
    }

    /// A pool of somebody's own, read by one of the people they added: its ChatGPT accounts run their
    /// sessions too (2026-10-03), so the pool is pickable with no key in it at all — and greyed as
    /// "Signed out" only once every account is out and no key can run.
    func testAPoolOfSomebodysOwnIsPickableForThemOnItsAccounts() {
        func tile(_ logins: [CodexLogin], _ keys: [SharedPoolKey] = []) -> ProviderChoice? {
            let pool = SharedPools.asProviderPool(SharedPool(
                id: "pool-2", slug: "team-codex", label: "Team Codex", shared: false,
                logins: logins,
                people: [SharedPoolPerson(userId: "wikova", name: "Wikova", role: .admin, creator: true),
                         SharedPoolPerson(userId: "me", name: "Me", you: true)],
                keys: keys))
            return providers("codex", sources(withPools([], [pool]), pools: [pool])).first { $0.slug == "team-codex" }
        }
        let account = CodexLogin(state: "ACTIVE", email: "wikova@orbitd.io", fingerprint: "…7QX4", next: true)
        XCTAssertNil(tile([account])?.unavailable, "an account of it can run: the pool takes the pick")
        XCTAssertEqual(tile([account])?.poolSize, 1)
        XCTAssertNil(tile([account])?.poolUnit, "an account is not a key")
        let out = CodexLogin(state: "SIGNED_OUT", email: "wikova@orbitd.io", fingerprint: "…7QX4", next: true)
        XCTAssertEqual(tile([out])?.unavailable, "Signed out")
        XCTAssertNil(tile([out], [sharedKey("orbit-org-1", you: true)])?.unavailable, "a key of theirs can run")
    }

    /// A Codex pool of one's own runs on its owner's ChatGPT accounts through the Codex CLI: the picker
    /// offers it under Codex — its mark, and the CLI whose absence blocks it — though nobody else uses it.
    func testAChatGPTPoolOfOnesOwnIsOfferedUnderCodex() {
        let login = CodexLogin(email: "wikova@orbitd.io", fingerprint: "…7QX4")
        let drawn = CodexLoginPool.drawn(slug: "my-codex", logins: [login])
        let pool = ProviderPool(id: "pool-3", slug: "my-codex", label: "My Codex", members: drawn.members,
                                engine: "codex", login: login, logins: [login])
        XCTAssertNil(pool.shared)
        let rows = providers("codex", sources(withPools([], [pool]), catalog: codexCatalog,
                                              engines: [health("claude", installed: false, auth: "no"),
                                                        health("codex", installed: true, auth: "unknown")],
                                              pools: [pool]))
        let tile = rows.first { $0.slug == "my-codex" }
        XCTAssertEqual(tile?.brandKey, "openai")
        XCTAssertEqual(tile?.modelLabel, "GPT-5.6 Sol")
        XCTAssertNil(tile?.unavailable, "the Claude CLI's absence is nothing to a pool that runs Codex")
        XCTAssertNil(tile?.poolUnit, "its members are accounts")
        let noCodex = providers("codex", sources(withPools([], [pool]),
                                                 engines: [health("claude", installed: true, auth: "yes"),
                                                           health("codex", installed: false, auth: "unknown")],
                                                 pools: [pool])).first { $0.slug == "my-codex" }
        XCTAssertEqual(noCodex?.unavailable, "Not installed")
        XCTAssertEqual(noCodex?.fixEngine, "codex")
    }

    // MARK: - OpenCode and the keys it runs

    /// A key runs on OpenCode under its own slug — no `opencode/<slug>` choice, no `orbit-<slug>/` model:
    /// the session stores the key and the bare model, and dispatch names the key for OpenCode.
    func testOpenCodeListsItsOwnSignInThenEveryKeyItRunsUnderTheKeysOwnSlug() {
        let configured = [deepseek, claudeMax, moonshot]
        let rows = providers("opencode", sources(configured, engines: [health("opencode", installed: true, auth: "unknown")]))
        XCTAssertEqual(rows.map(\.slug), ["opencode", "deepseek", "moonshot"])
        XCTAssertEqual(rows.map(\.label), ["OpenCode's own sign-in", "DeepSeek", "Kimi (Moonshot)"])
        XCTAssertEqual(rows.map(\.kind), [.opencode, .key, .key])
        XCTAssertEqual(rows[1].modelLabel, "DeepSeek V4 Pro")
        XCTAssertFalse(rows.contains { $0.slug.contains("/") })
        XCTAssertEqual(AgentDefaults.models(engine: "opencode", provider: "deepseek", catalog: nil, configured: configured)
            .map(\.id), ["deepseek-v4-pro"])
        XCTAssertEqual(AgentDefaults.defaultModel(engine: "opencode", provider: "deepseek", catalog: nil, configured: configured),
                       "deepseek-v4-pro")
    }

    func testAnOlderOpenCodeModelIdIsStillReadButNeverWritten() {
        XCTAssertEqual(OpenCodeKeys.key(of: "orbit-deepseek-2/deepseek-v4-pro")?.slug, "deepseek-2")
        XCTAssertEqual(OpenCodeKeys.key(of: "orbit-glm/glm-5/turbo")?.model, "glm-5/turbo")
        XCTAssertNil(OpenCodeKeys.key(of: "anthropic/claude-opus-5"))
        XCTAssertNil(OpenCodeKeys.key(of: "orbit-/x"))
        XCTAssertNil(OpenCodeKeys.key(of: "orbit-deepseek/"))
    }

    // MARK: - engineTitle (the composer model menu's title)

    /// The title answers "which engine runs this session" — the session's own, which no pick changes, by
    /// the CLI that executes it rather than the vendor whose models it writes (web `engineTitleFor`).
    func testEngineTitleNamesTheSessionsOwnEngine() {
        XCTAssertEqual(SessionProviderChoices.engineTitle("claude"), "Claude Code")
        XCTAssertEqual(SessionProviderChoices.engineTitle("codex"), "Codex")
        XCTAssertEqual(SessionProviderChoices.engineTitle("kimi"), "Kimi Code")
        XCTAssertEqual(SessionProviderChoices.engineTitle("antigravity"), "Antigravity CLI")
        XCTAssertEqual(SessionProviderChoices.engineTitle("opencode"), "OpenCode")
        XCTAssertEqual(SessionProviderChoices.engineTitle("dsh"), "DeepSeek Harness")
        // A DeepSeek Harness session whose key was deleted is still titled by its engine (board iOS 5 ③).
        let engine = ProviderEngines.sessionEngine("dsh", provider: "deepseek-harness", configured: [])
        XCTAssertEqual(SessionProviderChoices.engineTitle(engine), "DeepSeek Harness")
    }

    // MARK: - what the cards and settings call a key and an engine

    func testNamesAKeyByItsVendorAndItsOwnNameNeverItsSlugOrAnEngine() {
        XCTAssertEqual(SessionProviderChoices.keyName(deepseek2), "the DeepSeek key “DeepSeek 2”")
        XCTAssertEqual(SessionProviderChoices.keyName(gemini), "the Google Gemini key “Gemini”")
        XCTAssertEqual(SessionProviderChoices.keyName(custom), "the key “my endpoint”")
        let harnessHost = ConfiguredProvider(slug: "ds-proxy", label: "Proxy", runtime: "claude",
                                             engines: ["claude", "opencode", "dsh"])
        XCTAssertEqual(SessionProviderChoices.keyName(harnessHost), "the DeepSeek key “Proxy”")
    }

    func testSaysAWorkspacesNextSessionAsItsEngineViaItsCredential() {
        XCTAssertEqual(SessionProviderChoices.engineVia(engine: "claude", provider: "claude", configured: [deepseek]),
                       "Claude Code")
        XCTAssertEqual(SessionProviderChoices.engineVia(engine: "claude", provider: "deepseek", configured: [deepseek]),
                       "Claude Code via DeepSeek")
        XCTAssertEqual(SessionProviderChoices.engineVia(engine: "dsh", provider: "deepseek-2", configured: [deepseek2]),
                       "DeepSeek Harness via DeepSeek 2")
        XCTAssertEqual(SessionProviderChoices.engineVia(engine: "opencode", provider: "opencode", configured: []), "OpenCode")
    }

    /// The web module these mirror: the same words for the same rows.
    func testCopyMatchesWeb() throws {
        let web = try source("src/web/src/lib/sessionProviderChoices.ts")
        for phrase in ["label: \"OpenCode's own sign-in\",", "labelDetail: 'opencode auth',", "label: 'Workspace key',",
                       "labelDetail: 'ORBIT_DSH_API_KEY',", "unavailable: '\(DshRuntime.connectKey)'",
                       "return `${name} via ${configured?.find((p) => p.slug === provider)?.label ?? provider}`;",
                       "return vendor ? `the ${vendor} key “${row.label}”` : `the key “${row.label}”`;",
                       "return model || 'Managed by the provider';"] {
            XCTAssertTrue(web.contains(phrase), "web lost \(phrase)")
        }
        XCTAssertTrue(try source("src/web/src/lib/dshRuntime.ts")
            .contains("export const DSH_CONNECT_HREF = '/providers/new/\(DshRuntime.keyPreset)';"))
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
