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

    func testAlwaysOffersTheEnginesWithNothingConfigured() {
        let choices = SessionProviderChoices.choices(configured: [])
        XCTAssertEqual(choices.map(\.slug), ["claude", "codex", "kimi", "antigravity"])
        XCTAssertTrue(choices.allSatisfy { $0.kind == .engine })
    }

    func testAppendsConfiguredProvidersAfterTheEngines() {
        let choices = SessionProviderChoices.choices(configured: [deepseek, custom])
        XCTAssertEqual(choices.map(\.slug), ["claude", "codex", "kimi", "antigravity", "deepseek", "my-endpoint"])
        XCTAssertTrue(choices.suffix(2).allSatisfy { $0.kind == .byok })
    }

    func testNeverOffersOpenCodeBecauseItIsNotALoginEngine() {
        XCTAssertFalse(SessionProviderChoices.choices(configured: []).contains { $0.slug == "opencode" })
    }

    /// Not a login engine either, but a built-in engine the user picks directly: agy has no
    /// sign-in at all, so it is offered like the engines that do.
    func testOffersAntigravityAsAnEngineWithTheModelTheRunnerReportsFirst() {
        let agy = RunnerModelCatalog(antigravity: [
            RunnerModelInfo(value: "gemini-3.8-flash", label: "Gemini 3.8 Flash",
                            reasoningLevels: ["low", "medium", "high"]),
            RunnerModelInfo(value: "gemini-3.1-pro", label: "Gemini 3.1 Pro", reasoningLevels: ["low", "high"]),
        ])
        let row = SessionProviderChoices.choices(configured: [], catalog: agy).first { $0.slug == "antigravity" }
        XCTAssertEqual(row?.kind, .engine)
        XCTAssertEqual(row?.label, "Antigravity")
        // Its own mark rather than the Gemini preset's, which is the Gemini API through another CLI.
        XCTAssertEqual(row?.brandKey, "antigravity")
        XCTAssertEqual(row?.modelLabel, "Gemini 3.8 Flash")
        XCTAssertNil(row?.accounts)
        // Before the runner reports its models, agy picks its own.
        XCTAssertEqual(SessionProviderChoices.choices(configured: []).first { $0.slug == "antigravity" }?.modelLabel,
                       "Managed by the provider")
        XCTAssertEqual(SessionProviderChoices.current("antigravity", in: SessionProviderChoices.choices(configured: []),
                                                      configured: []).kind, .engine)
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

    /// Antigravity is its own runtime too: with no Gemini key connected, a session on it has nowhere
    /// to move — and none of the Claude or Kimi rows may be offered as if it did.
    func testSameRuntimeLeavesAntigravityAlone() {
        let configured = [anthropic, anthropic2, moonshot]
        let choices = SessionProviderChoices.sameRuntime(
            "antigravity", in: SessionProviderChoices.choices(configured: configured),
            configured: configured)
        XCTAssertEqual(choices.map(\.slug), ["antigravity"])
        XCTAssertEqual(SessionProviderChoices.executingRuntime("antigravity", configured: configured),
                       "antigravity")
    }

    /// A Gemini key borrows Antigravity, so it and the engine are the same CLI with different keys:
    /// each is offered to the other, and to nobody else. Mirrors web's sameRuntimeChoices case.
    func testAGeminiKeySharesTheAntigravityRuntime() {
        let gemini = ConfiguredProvider(slug: "gemini", label: "Gemini", runtime: "antigravity",
                                        models: [ConfiguredProviderModel(value: "gemini-3.8-flash",
                                                                         label: "Gemini 3.8 Flash")],
                                        defaultModel: "gemini-3.8-flash", presetSlug: "gemini",
                                        modelsFromRuntime: true)
        let configured = [anthropic, moonshot, gemini]
        let choices = SessionProviderChoices.choices(configured: configured)
        XCTAssertEqual(SessionProviderChoices.executingRuntime("gemini", configured: configured), "antigravity")
        for from in ["antigravity", "gemini"] {
            XCTAssertEqual(SessionProviderChoices.sameRuntime(from, in: choices, configured: configured)
                .map(\.slug), ["antigravity", "gemini"])
        }
        XCTAssertFalse(SessionProviderChoices.sameRuntime("anthropic", in: choices, configured: configured)
            .map(\.slug).contains("gemini"))
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
        XCTAssertEqual(choices.map(\.slug), ["claude", "codex", "kimi", "antigravity", "deepseek"])
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

    /// agy runs on a Gemini API key from the session's environment — possibly the workspace's own,
    /// which the runner's probe of the machine never sees — so a "no" there is not a blocker. Only a
    /// missing CLI is, and that one is fixed on its own engine row.
    func testHoldsAntigravityToItsCLIBeingThereAndNeverToASignInItDoesNotHave() {
        let signedOut = SessionProviderChoices.choices(
            configured: [], engines: [health("antigravity", installed: true, auth: "no")])
        XCTAssertNil(signedOut.first { $0.slug == "antigravity" }?.unavailable)
        XCTAssertNil(signedOut.first { $0.slug == "antigravity" }?.fixEngine)
        let missing = SessionProviderChoices.choices(
            configured: [], engines: [health("antigravity", installed: false, auth: "unknown")])
        XCTAssertEqual(missing.first { $0.slug == "antigravity" }?.unavailable, "Not installed")
        XCTAssertEqual(missing.first { $0.slug == "antigravity" }?.fixEngine, "antigravity")
    }

    func testAnEngineTheRunnerHasClaimedNothingAboutStaysRunnable() {
        XCTAssertTrue(SessionProviderChoices.choices(configured: [], engines: nil)
            .allSatisfy { $0.unavailable == nil })
        let partial = SessionProviderChoices.choices(
            configured: [], engines: [health("claude", installed: false, auth: "no")])
        XCTAssertEqual(partial.map(\.slug), ["claude", "codex", "kimi", "antigravity"])
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

    // MARK: - account pools (web: the pool is one tile; its accounts wait behind "Pin a specific account")

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

    func testAPoolIsOneChoiceAfterTheEnginesWithItsAccountCount() {
        let pool = claudePool()
        let choices = SessionProviderChoices.choices(
            configured: withPools([anthropic, anthropic2, deepseek], [pool]), catalog: opus5, pools: [pool])
        XCTAssertEqual(choices.map(\.slug),
                       ["claude", "codex", "kimi", "antigravity", "claude-accounts", "anthropic", "anthropic-2",
                        "deepseek"])
        let tile = choices.first { $0.slug == "claude-accounts" }
        XCTAssertEqual(tile?.kind, .pool)
        XCTAssertEqual(tile?.poolSize, 2)
        XCTAssertEqual(tile?.label, "Claude accounts")
        XCTAssertEqual(tile?.brandKey, "anthropic")
        XCTAssertEqual(tile?.modelLabel, "Opus 5")
        XCTAssertNil(tile?.unavailable)
        XCTAssertNil(tile?.note)
        XCTAssertEqual(choices.filter { $0.slug == "claude-accounts" }.count, 1, "listed once, as the pool")
    }

    /// Its accounts stay pickable on their own — pinning one is a real need — but are marked for the
    /// picker to fold away; a key in no pool is not.
    func testTheAccountsOfAPoolAreMarkedToFoldAwayAndStayPickable() {
        let pool = claudePool()
        let choices = SessionProviderChoices.choices(
            configured: withPools([anthropic, anthropic2, deepseek], [pool]), pools: [pool])
        XCTAssertEqual(choices.filter(\.inPool).map(\.slug), ["anthropic", "anthropic-2"])
        XCTAssertTrue(choices.filter(\.inPool).allSatisfy { $0.kind == .byok && $0.unavailable == nil })
        XCTAssertFalse(choices.first { $0.slug == "deepseek" }?.inPool ?? true)
        XCTAssertNil(choices.first { $0.slug == "deepseek" }?.poolSize)
    }

    /// A pool the server says cannot run: greyed out with its reason, and no runner to send it to —
    /// nothing on a machine gives it an account that can.
    func testAPoolTheServerSaysCannotRunIsGreyedWithItsReason() {
        let stuck = claudePool((.refused, .disabled), unavailable: "No account can run")
        let tile = SessionProviderChoices.choices(
            configured: withPools([anthropic, anthropic2], [stuck]), pools: [stuck])
            .first { $0.slug == "claude-accounts" }
        XCTAssertEqual(tile?.unavailable, "No account can run")
        XCTAssertNil(tile?.fixEngine)
        XCTAssertNil(tile?.note)
    }

    /// "0 of N available" because every account is spent is not unavailable: the server takes the
    /// pool and a session on it waits for the first reset. So it stays pickable, and says when that
    /// is where its model would be.
    func testAFullySpentPoolStaysPickableAndSaysWhenItFreesUp() {
        let spent = claudePool((.spent, .spent), resetsAt: "2026-09-25T10:30:00.000Z")
        let now = RelativeTime.parse("2026-09-25T09:00:00.000Z")!
        let tile = SessionProviderChoices.choices(
            configured: withPools([anthropic, anthropic2], [spent]), catalog: opus5, pools: [spent], now: now)
            .first { $0.slug == "claude-accounts" }
        XCTAssertNil(tile?.unavailable)
        XCTAssertNil(tile?.fixEngine)
        XCTAssertEqual(tile?.note,
                       "All spent · resets \(ProviderPools.formatResetTime("2026-09-25T10:30:00.000Z", now: now)!)")
        XCTAssertEqual(tile?.modelLabel, "Opus 5")
    }

    /// A pool runs on the Claude CLI like a key does, so a runner without it can't run the pool
    /// either — and that one is fixed on the runner, so it outranks the accounts.
    func testAPoolNeedsTheClaudeCLIAndThatIsFixedOnTheRunner() {
        let spent = claudePool((.spent, .spent))
        let tile = SessionProviderChoices.choices(
            configured: withPools([anthropic, anthropic2], [spent]),
            engines: [health("claude", installed: false, auth: "no")], pools: [spent])
            .first { $0.slug == "claude-accounts" }
        XCTAssertEqual(tile?.unavailable, "Not installed")
        XCTAssertEqual(tile?.fixEngine, "claude")
        // Signed out doesn't matter: each run carries one of the accounts' own keys.
        let signedOut = SessionProviderChoices.choices(
            configured: withPools([anthropic], [claudePool()]),
            engines: [health("claude", installed: true, auth: "no")], pools: [claudePool()])
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

    /// A shared pool is one choice like an account pool — but its mark is Codex's, its badge counts
    /// keys, and its models are the Codex CLI's, because that is what it runs on.
    func testASharedPoolIsOneChoiceWithTheCodexMarkAndItsKeyCount() {
        let pool = sharedPool([sharedKey("orbit-org-1", next: true), sharedKey("orbit-org-2")])
        let tile = SessionProviderChoices.choices(
            configured: withPools([deepseek], [pool]), catalog: codexCatalog, pools: [pool])
            .first { $0.slug == "team-codex" }
        XCTAssertEqual(tile?.kind, .pool)
        XCTAssertEqual(tile?.label, "Team Codex")
        XCTAssertEqual(tile?.brandKey, "openai")
        XCTAssertEqual(tile?.poolSize, 2)
        XCTAssertEqual(tile?.poolUnit, "key")
        XCTAssertEqual(tile?.modelLabel, "GPT-5.6 Sol")
        XCTAssertNil(tile?.unavailable)
        XCTAssertEqual(SessionProviderChoices.poolBadgeLabel(size: tile?.poolSize ?? 0, unit: tile?.poolUnit),
                       "2 keys")
        XCTAssertEqual(SessionProviderChoices.poolBadgeLabel(size: 1, unit: tile?.poolUnit), "1 key")
    }

    /// An account pool counts accounts, and says so.
    func testAnAccountPoolsBadgeCountsAccounts() {
        let pool = claudePool()
        let tile = SessionProviderChoices.choices(configured: withPools([], [pool]), pools: [pool])
            .first { $0.slug == "claude-accounts" }
        XCTAssertNil(tile?.poolUnit)
        XCTAssertEqual(SessionProviderChoices.poolBadgeLabel(size: tile?.poolSize ?? 0, unit: tile?.poolUnit),
                       "2 accounts")
    }

    /// Its CLI is Codex, so a runner without that one can't run the pool — while the Claude CLI's
    /// absence leaves it alone, and the other way round for the account pool beside it.
    func testASharedPoolNeedsTheCodexCLIAndThatIsFixedOnThatRow() {
        let shared = sharedPool([sharedKey("orbit-org-1")])
        let account = claudePool()
        let choices = SessionProviderChoices.choices(
            configured: withPools([anthropic], [shared, account]),
            engines: [health("claude", installed: true, auth: "yes"),
                      health("codex", installed: false, auth: "unknown")],
            pools: [shared, account])
        let tile = choices.first { $0.slug == "team-codex" }
        XCTAssertEqual(tile?.unavailable, "Not installed")
        XCTAssertEqual(tile?.fixEngine, "codex")
        XCTAssertNil(choices.first { $0.slug == "claude-accounts" }?.unavailable,
                     "an account pool runs on Claude, which this machine has")
    }

    /// A key OpenAI refused, or one switched off, is why a shared pool goes grey — and it stays
    /// listed, saying so, rather than disappearing from a picker that exists to answer exactly this.
    func testASharedPoolWithNoKeyThatCanRunIsGreyedWithThePoolsWords() {
        let stuck = sharedPool([SharedPoolKey(id: "k", label: "orbit-org-1", fingerprint: "sk-…0000",
                                              state: .invalid,
                                              contributor: PoolKeyContributor(userId: "u", name: "Wikova"))])
        let tile = SessionProviderChoices.choices(configured: withPools([], [stuck]), pools: [stuck])
            .first { $0.slug == "team-codex" }
        XCTAssertEqual(tile?.unavailable, "No key can run")
        XCTAssertNil(tile?.fixEngine, "nothing on a runner gives it a key that can run")
    }

    /// Somebody a pool's maker added reads the same words its maker does: since 2026-10-03 the pool's
    /// ChatGPT accounts run their sessions too, so what the pool holds is what they can run on.
    func testAPoolSomebodyItsMakerAddedReadsSaysThePoolsOwnWords() {
        let refused = SharedPoolKey(id: "k", label: "orbit-org-1", fingerprint: "sk-…0000", state: .invalid,
                                    contributor: PoolKeyContributor(userId: "wikova", name: "Wikova"))
        func tile(_ pool: ProviderPool) -> ProviderChoice? {
            SessionProviderChoices.choices(configured: withPools([], [pool]), pools: [pool])
                .first { $0.slug == "team-codex" }
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
            return SessionProviderChoices.choices(configured: withPools([], [pool]), pools: [pool])
                .first { $0.slug == "team-codex" }
        }
        let account = CodexLogin(state: "ACTIVE", email: "wikova@orbitd.io", fingerprint: "…7QX4", next: true)
        XCTAssertNil(tile([account])?.unavailable, "an account of it can run: the pool takes the pick")
        XCTAssertEqual(tile([account])?.poolSize, 1)
        XCTAssertNil(tile([account])?.poolUnit, "an account is not a key")
        let out = CodexLogin(state: "SIGNED_OUT", email: "wikova@orbitd.io", fingerprint: "…7QX4", next: true)
        XCTAssertEqual(tile([out])?.unavailable, "Signed out")
        XCTAssertNil(tile([out], [sharedKey("orbit-org-1", you: true)])?.unavailable,
                     "a key of theirs can run")
    }

    /// A Codex pool of one's own runs on its owner's ChatGPT accounts through the Codex CLI: the picker
    /// offers it as Codex — its mark, and the CLI whose absence blocks it — though nobody else uses it and
    /// it carries no shared view.
    func testAChatGPTPoolOfOnesOwnIsOfferedAsCodex() {
        let login = CodexLogin(email: "wikova@orbitd.io", fingerprint: "…7QX4")
        let drawn = CodexLoginPool.drawn(slug: "my-codex", logins: [login])
        let pool = ProviderPool(id: "pool-3", slug: "my-codex", label: "My Codex", members: drawn.members,
                                engine: "codex", login: login, logins: [login])
        XCTAssertNil(pool.shared)
        let choices = SessionProviderChoices.choices(
            configured: withPools([], [pool]), catalog: codexCatalog,
            engines: [health("claude", installed: false, auth: "no"),
                      health("codex", installed: true, auth: "unknown")],
            pools: [pool])
        let tile = choices.first { $0.slug == "my-codex" }
        XCTAssertEqual(tile?.brandKey, "openai")
        XCTAssertEqual(tile?.modelLabel, "GPT-5.6 Sol")
        XCTAssertNil(tile?.unavailable, "the Claude CLI's absence is nothing to a pool that runs Codex")
        XCTAssertNil(tile?.poolUnit, "its members are accounts")
        let noCodex = SessionProviderChoices.choices(
            configured: withPools([], [pool]),
            engines: [health("claude", installed: true, auth: "yes"),
                      health("codex", installed: false, auth: "unknown")],
            pools: [pool]).first { $0.slug == "my-codex" }
        XCTAssertEqual(noCodex?.unavailable, "Not installed")
        XCTAssertEqual(noCodex?.fixEngine, "codex")
    }

    /// A Codex session may move onto a shared pool — the same CLI — and a Claude one may not, however
    /// nearby the pool is listed.
    func testASharedPoolMovesOnlyOntoACodexSession() {
        let pool = sharedPool([sharedKey("orbit-org-1")])
        let configured = withPools([deepseek], [pool])
        let choices = SessionProviderChoices.choices(configured: configured, pools: [pool])
        XCTAssertEqual(SessionProviderChoices.sameRuntime("codex", in: choices, configured: configured)
            .map(\.slug), ["codex", "team-codex"])
        XCTAssertEqual(SessionProviderChoices.sameRuntime("team-codex", in: choices, configured: configured)
            .map(\.slug), ["codex", "team-codex"])
        XCTAssertFalse(SessionProviderChoices.sameRuntime("deepseek", in: choices, configured: configured)
            .contains { $0.slug == "team-codex" })
    }

    /// A session on the pool may move to one of its accounts, or back, without changing CLI.
    func testSameRuntimeOffersThePoolAndItsAccountsTogether() {
        let pool = claudePool()
        let configured = withPools([anthropic, anthropic2, moonshot], [pool])
        let slugs = SessionProviderChoices.sameRuntime(
            "claude-accounts", in: SessionProviderChoices.choices(configured: configured, pools: [pool]),
            configured: configured).map(\.slug)
        XCTAssertEqual(slugs, ["claude", "claude-accounts", "anthropic", "anthropic-2"])
    }
}
