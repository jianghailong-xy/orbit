import Foundation
import XCTest
@testable import OrbitKit

/// Cursor CLI on iPhone and Mac (P7b, the owner's board docs/mocks/cursor-engine ios-1…ios-6): the
/// runner's state and what fixes it, its accounts' plans and quota, its key's last check, the session's
/// models, modes, notes and usage-limit card — and parity with the web's `lib/cursorRuntime.ts` and the
/// shared tables the web draws the same screens from.
final class CursorRuntimeTests: XCTestCase {
    /// 2026-09-28T12:00:00Z, the clock of the web's P7a captures (docs/evidence/cursor-engine/p7a).
    private let now = Date(timeIntervalSince1970: 1_790_596_800)
    private var nowMs: Int64 { RunnerPageFormat.nowMs(now) }
    private let utc = TimeZone(identifier: "UTC")!
    private let team = "5c2e91a0"

    private func iso(minutes: Double) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: now.addingTimeInterval(minutes * 60))
    }

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    /// Cursor CLI as the runner reports the pinned build (cursor_health.go): Default and Team signed in.
    private func cursorHealth(installed: Bool = true, auth: String = "yes", version: String = "2026.10.14-941492e",
                              error: String? = nil, defaultAuth: String = "yes", accounts: Bool = true) -> String {
        let accountRows = accounts ? #","accounts":[{"id":"default","home":"/root/.orbit/cursor/default","auth":""# + defaultAuth
            + #""},{"id":""# + team + #"","name":"Team","home":"/root/.orbit/cursor-accounts/"# + team + #"","auth":"yes"}]"# : ""
        let errorField = error.map { #","installationError":""# + $0 + #"""# } ?? ""
        return #"{"engine":"cursor","installed":"# + (installed ? "true" : "false") + #","auth":""# + auth
            + #"","version":""# + version + #"","update":{"status":"checked","at":""# + iso(minutes: -6)
            + #"","okAt":""# + iso(minutes: -6) + #"","latest":"2026.10.14-941492e"}"# + errorField + accountRows + "}"
    }

    /// P6a's reading (PlanUsage.cursor): Default on the Free plan with no share reported, Team on Pro at
    /// 34% of this month. `defaultSpent` is a turn on Default that met Cursor's limit 16 minutes ago.
    private func cursorUsage(defaultSpent: Bool = false) -> String {
        let limit = defaultSpent ? #","limitReachedAt":""# + iso(minutes: -16) + #"""# : ""
        return #"{"provider":"cursor","account":"default","planName":"Free","includedUsage":{"startsAt":"2026-09-02T16:00:00.000Z","resetsAt":"2026-10-02T16:00:00.000Z""#
            + limit + #"},"fetchedAt":""# + iso(minutes: -4) + #"","accounts":{""# + team
            + #"":{"provider":"cursor","account":""# + team + #"","planName":"Pro","includedUsage":{"period":"monthly","startsAt":"2026-09-03T16:00:00.000Z","resetsAt":""#
            + iso(minutes: 5 * 1440 + 4 * 60) + #"","percentUsed":34},"fetchedAt":""# + iso(minutes: -4) + #""}}}"#
    }

    private let catalog = #"""
    {"cursor":[{"value":"default","label":"Auto"},
               {"value":"claude-opus-5-5","label":"Claude Opus 5.5","reasoningLevels":["low","medium","high","xhigh","max"],"defaultReasoningLevel":"medium"},
               {"value":"gpt-5.5","label":"GPT-5.5","reasoningLevels":["low","medium","high","xhigh"]},
               {"value":"composer-2.5","label":"Composer 2.5"}]}
    """#

    private func runner(id: String = "hpc", name: String = "hpc", caps: [String] = ["provider:cursor", "cursor-account-login/v1"],
                        cursor: String? = nil, usage: String? = nil, online: Bool = true) throws -> Runner {
        let engines = [#"{"engine":"claude","installed":true,"auth":"yes"}"#] + (cursor.map { [$0] } ?? [])
        let capabilities = "[" + caps.map { "\"\($0)\"" }.joined(separator: ",") + "]"
        let planUsage = usage.map { #","planUsage":{"cursor":"# + $0 + "}" } ?? ""
        let json = #"{"id":""# + id + #"","name":""# + name + #"","online":"# + (online ? "true" : "false")
            + #","lastHeartbeatAt":""# + iso(minutes: -0.2) + #"","capabilities":"# + capabilities
            + #","engines":["# + engines.joined(separator: ",") + "]" + planUsage + #","modelCatalog":"# + catalog + "}"
        return try decode(Runner.self, json)
    }

    private func readyRunner(defaultSpent: Bool = false, defaultAuth: String = "yes") throws -> Runner {
        try runner(cursor: cursorHealth(defaultAuth: defaultAuth), usage: cursorUsage(defaultSpent: defaultSpent))
    }

    private let cursorKey = ConfiguredProvider(slug: "cursor-api", label: "Cursor", runtime: "cursor", models: [],
                                               presetSlug: "cursor-api", modelsFromRuntime: true, enabled: true,
                                               engines: ["cursor"])

    // MARK: - the runner (board iOS 1 ④, iOS 2 ②)

    func testARunnersStateGoesFromWhatIsMostFundamental() throws {
        // A runner that predates Cursor CLI: nothing declared, nothing reported.
        XCTAssertEqual(CursorRuntime.state(capabilities: [], engines: []), .updateRunner)
        XCTAssertEqual(CursorRuntime.state(of: nil), .updateRunner)
        // One that declares it and hasn't reported it yet claims nothing more.
        XCTAssertEqual(CursorRuntime.state(capabilities: ["provider:cursor"], engines: nil), .ready)
        let health = { (json: String) in try self.decode(RunnerEngineHealth.self, json) }
        XCTAssertEqual(CursorRuntime.state(capabilities: [], engines: [try health(cursorHealth(
            installed: false, error: "CURSOR_PLATFORM_UNSUPPORTED: Cursor CLI 2026.10.14-941492e runs on Linux x64 and macOS arm64 only"))]),
            .unsupportedPlatform)
        XCTAssertEqual(CursorRuntime.state(capabilities: [], engines: [try health(cursorHealth(
            version: "2026.10.16-e3cb207", error: "CURSOR_VERSION_INCOMPATIBLE: Cursor CLI 2026.10.16-e3cb207 is not the pinned version"))]),
            .unsupportedVersion)
        XCTAssertEqual(CursorRuntime.state(capabilities: [], engines: [try health(cursorHealth(
            installed: false, error: "CURSOR_NOT_INSTALLED: Cursor CLI 2026.10.14-941492e is not installed"))]), .notInstalled)
        // The pinned build is ready, and a runner without the session driver for it still needs an update.
        XCTAssertEqual(CursorRuntime.state(capabilities: [], engines: [try health(cursorHealth())]), .updateRunner)
        XCTAssertEqual(CursorRuntime.state(capabilities: ["provider:cursor"], engines: [try health(cursorHealth())]), .ready)

        XCTAssertEqual([CursorRuntime.RunnerState.updateRunner, .unsupportedPlatform, .unsupportedVersion, .notInstalled].map(\.label),
                       ["Update runner", "Not supported here", "Unsupported version", "Not installed"])
        XCTAssertNil(CursorRuntime.RunnerState.ready.label)
        XCTAssertEqual([CursorRuntime.RunnerState.updateRunner, .unsupportedPlatform, .unsupportedVersion].map(\.blocks), [true, true, true])
        XCTAssertFalse(CursorRuntime.RunnerState.notInstalled.blocks)
        XCTAssertEqual(CursorRuntime.installLabel(.notInstalled), "Install Cursor CLI")
        XCTAssertEqual(CursorRuntime.installLabel(.unsupportedVersion), "Reinstall Cursor CLI")
        XCTAssertNil(CursorRuntime.installLabel(.updateRunner))
    }

    func testEachStateSaysWhatFixesIt() {
        XCTAssertEqual(CursorRuntime.stateHint(.updateRunner),
                       "This runner predates Cursor CLI. It updates itself when no session is running on it.")
        XCTAssertEqual(CursorRuntime.stateHint(.unsupportedVersion),
                       "Orbit runs Cursor CLI 2026.10.14-941492e. Reinstall puts that version back on this runner; sessions here can’t start until then.")
        XCTAssertEqual(CursorRuntime.stateHint(.unsupportedPlatform,
                                               installationError: "CURSOR_PLATFORM_UNSUPPORTED: Cursor CLI runs on Linux x64 only.."),
                       "Cursor CLI runs on Linux x64 only.")
        XCTAssertEqual(CursorRuntime.stateHint(.unsupportedPlatform),
                       "Orbit doesn’t run Cursor CLI on this runner’s platform yet.")
        XCTAssertNil(CursorRuntime.stateHint(.notInstalled))
        XCTAssertNil(CursorRuntime.stateHint(.ready))
    }

    /// The machine's Engines rows (board iOS 2 ② and its four states): Cursor CLI last, with its version
    /// and its accounts, and each state with its words.
    func testTheMachinesCursorRowSaysWhereItStands() throws {
        let ready = try readyRunner()
        let row = try XCTUnwrap(RunnerPageFormat.engines(ready).last)
        XCTAssertEqual(row.engine, "cursor")
        XCTAssertEqual(RunnerPageFormat.engineStatus(row, runner: ready),
                       RunnerPageFormat.Status(text: "2 accounts signed in", tone: .ok))
        // Next: Team, and Team's window — Default's Free plan reports no share to weigh.
        XCTAssertEqual(RunnerPageFormat.engineNextAccount(ready, engine: "cursor", now: now), "Team")
        let window = try XCTUnwrap(RunnerPageFormat.engineWindows(ready, engine: "cursor", now: now).first)
        XCTAssertEqual(window.label, "Monthly limit")
        XCTAssertEqual(window.percent, 34)
        XCTAssertTrue(RunnerPageFormat.marksNext(ready, engine: "cursor", account: team, now: now))
        XCTAssertFalse(RunnerPageFormat.marksNext(ready, engine: "cursor", account: "default", now: now))
        XCTAssertEqual(RunnerPageFormat.enginesFooter(ready, offline: false), CursorRuntime.machineEnginesFooter)
        XCTAssertEqual(RunnerPageFormat.enginesFooter(ready, offline: true), RunnerPageCopy.RUNNER_ENGINES_OFFLINE_FOOTER)

        // Signed out: the version, Signed out, and the row's Sign In.
        let signedOut = try runner(cursor: cursorHealth(auth: "no", accounts: false))
        let out = try XCTUnwrap(RunnerPageFormat.engines(signedOut).last)
        XCTAssertEqual(RunnerPageFormat.engineStatus(out, runner: signedOut)?.text, RunnerPageCopy.RUNNER_ENGINE_SIGNED_OUT)
        XCTAssertTrue(RunnerPageFormat.needsSignIn(out))
        XCTAssertNil(RunnerPageFormat.signInHint(signedOut, engine: "cursor"))

        // Not installed: muted, its page offers the install.
        let missing = try runner(caps: [], cursor: cursorHealth(installed: false, auth: "unknown",
                                                                error: "CURSOR_NOT_INSTALLED: not installed", accounts: false))
        let none = try XCTUnwrap(RunnerPageFormat.engines(missing).last)
        XCTAssertEqual(RunnerPageFormat.engineStatus(none, runner: missing),
                       RunnerPageFormat.Status(text: RunnerPageCopy.RUNNER_ENGINE_NOT_INSTALLED, tone: .muted))
        XCTAssertEqual(CursorRuntime.installLabel(CursorRuntime.state(of: missing)), "Install Cursor CLI")

        // Another build: its version, Unsupported version, and what fixes it under the row.
        let other = try runner(caps: [], cursor: cursorHealth(auth: "unknown", version: "2026.10.16-e3cb207",
                                                              error: "CURSOR_VERSION_INCOMPATIBLE: not the pinned build", accounts: false))
        let wrong = try XCTUnwrap(RunnerPageFormat.engines(other).last)
        XCTAssertEqual(RunnerPageFormat.engineStatus(wrong, runner: other),
                       RunnerPageFormat.Status(text: "Unsupported version", tone: .warn))
        XCTAssertEqual(RunnerPageFormat.engineVersion(wrong.version), "2026.10.16-e3cb207")
        XCTAssertEqual(RunnerPageFormat.signInHint(other, engine: "cursor"), CursorRuntime.stateHint(.unsupportedVersion))
        XCTAssertFalse(RunnerPageFormat.canSignIn(other, engine: "cursor"))
    }

    /// Cursor CLI's own page (board iOS 2 ③, iOS 3): its version as Orbit pins it, each account with its
    /// plan before its directory, Add Account where the runner keeps accounts apart.
    func testTheEnginePageListsEachAccountWithItsPlan() throws {
        let ready = try readyRunner()
        let health = try XCTUnwrap(ready.engines?.last)
        let usage = CodexAccounts.usage("cursor", planUsage: ready.planUsage, engines: ready.engines)
        let lines = RunnerPageFormat.accountLines(health, usage: usage)
        XCTAssertEqual(lines.map(\.name), ["Default", "Team"])
        XCTAssertEqual(lines.map(\.subtitle), ["Free plan · ~/.orbit/cursor/default", "Pro plan · ~/.orbit/cursor-accounts/\(team)"])
        XCTAssertEqual(RunnerPageFormat.accountWindows(ready, engine: "cursor", account: "default"), [])
        XCTAssertEqual(RunnerPageFormat.accountWindows(ready, engine: "cursor", account: team).map(\.percent), [34])
        XCTAssertEqual(CursorRuntime.usageUnavailable(plan: "Free"),
                       "Usage unavailable — Cursor doesn’t report how many of the Free plan’s requests are left.")
        XCTAssertEqual(CursorRuntime.usageUnavailable(plan: "Pro"),
                       "Usage unavailable — Cursor doesn’t report how much of the Pro plan’s usage is left.")
        XCTAssertEqual(RunnerAttention.updateNoteOf(health.update, nowMs: nowMs, pinned: true)?.text, "pinned · checked 6m ago")
        XCTAssertEqual(RunnerAttention.updateNoteOf(health.update, nowMs: nowMs)?.text, "checked 6m ago")

        // Add Account where the runner signs a named account into its own directory (D4 A); without it the
        // page keeps Default alone, under Sign-In.
        XCTAssertTrue(RunnerPageFormat.canAddAccount(ready, engine: "cursor"))
        XCTAssertEqual(RunnerPageFormat.accountsTitle(ready, engine: "cursor"), "Accounts")
        let defaultOnly = try runner(caps: ["provider:cursor"], cursor: cursorHealth(accounts: false))
        XCTAssertFalse(RunnerPageFormat.canAddAccount(defaultOnly, engine: "cursor"))
        XCTAssertEqual(RunnerPageFormat.accountsTitle(defaultOnly, engine: "cursor"), "Sign-In")
        XCTAssertTrue(RunnerPageFormat.keepsAccounts("cursor"))
        XCTAssertEqual(LoginEngine.cursor.displayName, "Cursor CLI")
        XCTAssertEqual(EngineAuth.remedy(forProvider: "cursor"), .signIn(.cursor))
    }

    /// A turn on Default that met Cursor's limit: Default is spent until its included usage resets, which
    /// no reading says — and Automatic passes it over.
    func testASpentAccountIsSpentUntilItsUsageResets() throws {
        let spent = try readyRunner(defaultSpent: true)
        let limit = try XCTUnwrap(RunnerPageFormat.accountUsageLimit(spent, engine: "cursor", account: "default", now: now))
        XCTAssertEqual(limit.resetsAt, "2026-10-02T16:00:00.000Z")
        XCTAssertEqual(CursorRuntime.spentStatus(limit, now: now, timeZone: utc), "Spent · resets Fri, Oct 2 at 4:00 PM")
        XCTAssertNil(RunnerPageFormat.accountUsageLimit(spent, engine: "cursor", account: team, now: now))
        XCTAssertNil(RunnerPageFormat.accountUsageLimit(try readyRunner(), engine: "cursor", account: "default", now: now))
        // Once the reset has passed, nothing is spent; a limit met before the period began is over.
        XCTAssertNil(CursorRuntime.usageLimit(PlanUsageSnapshot(includedUsage: PlanUsageIncludedUsage(
            resetsAt: iso(minutes: -1), limitReachedAt: iso(minutes: -60))), now: now))
        XCTAssertNil(CursorRuntime.usageLimit(PlanUsageSnapshot(includedUsage: PlanUsageIncludedUsage(
            startsAt: iso(minutes: -10), limitReachedAt: iso(minutes: -60))), now: now))
        XCTAssertEqual(CursorRuntime.usageLimit(PlanUsageSnapshot(includedUsage: PlanUsageIncludedUsage(
            limitReachedAt: iso(minutes: -60))), now: now), CursorRuntime.UsageLimit(resetsAt: nil))

        let health = try XCTUnwrap(spent.engines?.last)
        let usage = CodexAccounts.usage("cursor", planUsage: spent.planUsage, engines: spent.engines)
        XCTAssertEqual(CodexAccounts.toStartOn(health.accounts, usage: usage, now: now), team)
        let choices = try XCTUnwrap(SessionProviderChoices.accountChoices(health, usage: usage, now: now))
        XCTAssertEqual(choices.map(\.label), ["Default", "Team"])
        XCTAssertEqual(choices.map(\.quota), ["Spent", "Monthly 34%"])
        XCTAssertEqual(choices.map(\.nearLimit), [true, false])
    }

    /// Cursor's 0% is no reading (contract §11): an account with none has no window to draw and no row to
    /// read as "0%", and a reading never says an account is spent — at 100% neither.
    func testAReadingOnlyAboveZeroAndNeverSpent() {
        let none = PlanUsageSnapshot(provider: "cursor", planName: "Free",
                                     includedUsage: PlanUsageIncludedUsage(resetsAt: iso(minutes: 60), percentUsed: 0))
        XCTAssertEqual(none.rows, [])
        let weekly = PlanUsageSnapshot(provider: "cursor", planName: "Premium",
                                       includedUsage: PlanUsageIncludedUsage(period: "weekly", resetsAt: iso(minutes: 60), percentUsed: 100))
        XCTAssertEqual(weekly.rows.map(\.label), ["Weekly limit"])
        XCTAssertNil(CursorRuntime.usageLimit(weekly, now: now))
        let accounts = [RunnerEngineAccount(id: "default", auth: "yes"), RunnerEngineAccount(id: team, auth: "yes")]
        let usage = PlanUsageSnapshot(provider: "cursor", accounts: [team: weekly], planName: "Free",
                                      includedUsage: PlanUsageIncludedUsage(resetsAt: iso(minutes: 10_000)))
        // Team at 100% is fullest, not spent: Default — read, with nothing known to expire — goes first.
        XCTAssertEqual(CodexAccounts.toStartOn(accounts, usage: usage, now: now), "default")
    }

    // MARK: - Infrastructure (board iOS 2 ①)

    func testTheSeventhEngineCardAndWhatNeedsAPerson() throws {
        let ready = try readyRunner()
        let card = try XCTUnwrap(Infrastructure.engineCards(runners: [ready], keys: [cursorKey], pools: []).last)
        XCTAssertEqual(card.name, "Cursor CLI")
        XCTAssertTrue(card.ready)
        XCTAssertEqual(card.machines, ["hpc ×2"])
        XCTAssertEqual(card.keys, [Infrastructure.EngineCard.Key(label: "Cursor", model: "Auto")])
        // Counted beside the other engines this machine signs in (Claude Code, Codex and Kimi Code here).
        XCTAssertEqual(Infrastructure.machineLine(ready, now: now), "2 of 4 signed in")

        // Signed out on a machine that runs it: Needs you says so, and the machine counts it.
        let signedOut = try runner(cursor: cursorHealth(auth: "no", accounts: false))
        XCTAssertEqual(Infrastructure.attention(runners: [signedOut], memberPools: [], ownPools: [], now: now).map(\.line),
                       ["Cursor CLI is signed out on hpc"])
        XCTAssertEqual(Infrastructure.machineLine(signedOut, now: now), "1 engine signed out")
        // A machine that can't run it at all says so on its row instead, and is not counted against.
        let older = try runner(id: "old", name: "mac-studio", caps: [])
        XCTAssertEqual(Infrastructure.attention(runners: [older], memberPools: [], ownPools: [], now: now), [])
        XCTAssertEqual(Infrastructure.summary(older, now: now), "1 of 3 signed in")
        // A runner that knows it but has none installed counts it, as every engine its row can sign in.
        let missing = try runner(caps: [], cursor: cursorHealth(installed: false, auth: "unknown",
                                                                error: "CURSOR_NOT_INSTALLED: x", accounts: false))
        XCTAssertEqual(Infrastructure.summary(missing, now: now), "1 of 4 signed in")
    }

    /// A Cursor CLI sign-in signed out under a workspace whose sessions run on it is a machine's Needs
    /// Attention item, in Cursor CLI's name.
    func testASignedOutCursorSignInIsAttention() throws {
        let signedOut = try runner(cursor: cursorHealth(auth: "no", accounts: false))
        let workspace = try decode(Agent.self, #"{"id":"w","name":"orbit","lastProvider":"cursor","lastEngine":"cursor"}"#)
        let items = RunnerAttention.runnerAttention(runner: signedOut, workspaces: [workspace], nowMs: nowMs, latestVersion: nil)
        XCTAssertEqual(items.first?.kind, .engineSignedOut)
        XCTAssertTrue(items.first?.title.contains("Cursor CLI") ?? false, items.first?.title ?? "")
    }

    // MARK: - the new-session hero and the Provider menu (board iOS 1, iOS 6)

    private func sources(_ runner: Runner, configured: [ConfiguredProvider] = []) -> ChoiceSources {
        ChoiceSources(configured: configured, catalog: runner.modelCatalog, runtimeDefaults: runner.runtimeDefaultModels,
                      engines: runner.engines, planUsage: runner.planUsage, now: now,
                      cursorState: CursorRuntime.state(of: runner), showsCursor: true)
    }

    func testTheHeroListsCursorCLIOnAutoOrSaysWhyNot() throws {
        let ready = try XCTUnwrap(SessionProviderChoices.engines(sources: sources(try readyRunner())).last)
        XCTAssertEqual(ready.slug, "cursor")
        XCTAssertEqual(ready.brandKey, "cursor-api")
        XCTAssertNil(ready.unavailable)
        XCTAssertEqual(ready.provider?.modelLabel, "Auto")
        XCTAssertEqual(ready.provider?.kind, .login)

        let signedOut = try runner(cursor: cursorHealth(auth: "no", accounts: false))
        let out = try XCTUnwrap(SessionProviderChoices.engines(sources: sources(signedOut)).last)
        XCTAssertEqual(out.unavailable, "Not signed in")
        XCTAssertEqual(out.fixEngine, "cursor")
        XCTAssertEqual(SessionProviderChoices.fixSuffix(out.fixEngine, unavailable: out.unavailable), ", sign in →")

        let missing = try runner(caps: [], cursor: cursorHealth(installed: false, auth: "unknown",
                                                                error: "CURSOR_NOT_INSTALLED: x", accounts: false))
        let older = try runner(caps: [])
        let other = try runner(caps: [], cursor: cursorHealth(auth: "unknown", version: "2026.10.16-e3cb207",
                                                              error: "CURSOR_VERSION_INCOMPATIBLE: x", accounts: false))
        for (machine, words) in [(missing, "Not installed"), (older, "Update runner"), (other, "Unsupported version")] {
            let row = try XCTUnwrap(SessionProviderChoices.engines(sources: sources(machine)).last)
            XCTAssertEqual(row.unavailable, words)
            XCTAssertEqual("\(words)\(SessionProviderChoices.fixSuffix(row.fixEngine, unavailable: row.unavailable))", "\(words) →")
        }
        // A key brings its own credential, but the runner still has to run the pinned build.
        let withKey = SessionProviderChoices.providers(for: "cursor", sources: sources(older, configured: [cursorKey]))
        XCTAssertEqual(withKey.map(\.slug), ["cursor", "cursor-api"])
        XCTAssertEqual(withKey.map(\.unavailable), ["Update runner", "Update runner"])
        // The key runs on Cursor CLI alone, and no other engine's menu lists it.
        for engine in ProviderEngines.all where engine != "cursor" {
            XCTAssertFalse(SessionProviderChoices.providers(for: engine, sources: sources(try readyRunner(), configured: [cursorKey]))
                .contains { $0.slug == "cursor-api" }, engine)
        }
        XCTAssertEqual(SessionProviderChoices.runtimeSummary("cursor"), "Cursor API")
        XCTAssertEqual(SessionProviderChoices.keyName(cursorKey), "the Cursor key “Cursor”")
    }

    /// Whether a session has talked (the server's P6b test): a settled turn, a conversation id Cursor
    /// reported, or a turn running now.
    func testAConversationStartsWithItsFirstTurn() throws {
        func session(_ fields: String) throws -> Session {
            try decode(Session.self, #"{"id":"s","status":"AWAITING_INPUT","engine":"cursor","provider":"cursor""# + fields + "}")
        }
        XCTAssertFalse(CursorRuntime.conversationStarted(nil))
        XCTAssertFalse(CursorRuntime.conversationStarted(try session(#","numTurns":0"#)))
        XCTAssertTrue(CursorRuntime.conversationStarted(try session(#","numTurns":2"#)))
        XCTAssertTrue(CursorRuntime.conversationStarted(try session(##","runtimeSessionId":"a6f1""##)))
        XCTAssertTrue(CursorRuntime.conversationStarted(try decode(Session.self, #"{"id":"s","status":"RUNNING","engine":"cursor"}"#)))
        let parked = try decode(Session.self, #"{"id":"s","status":"AWAITING_INPUT","engineTurnActive":true,"engine":"cursor"}"#)
        XCTAssertTrue(CursorRuntime.conversationStarted(parked))
        let decoded = try session(##","numTurns":3,"runtimeSessionId":"a6f1","cursorAccount":"5c2e91a0","cursorAccountPinned":true"##)
        XCTAssertEqual(decoded.cursorAccount, team)
        XCTAssertEqual(decoded.cursorAccountPinned, true)
        XCTAssertEqual(CodexAccounts.moveCapability("cursor"), "cursor-account-move/v1")
        XCTAssertEqual(CodexAccounts.workspaceAccount("cursor", of: try decode(Agent.self, #"{"id":"w","name":"orbit","cursorAccount":"5c2e91a0"}"#)), team)
    }

    // MARK: - models and modes (board iOS 5, iOS 6)

    func testTheModelMenuIsCursorsCatalogueWithAutoFirst() throws {
        let catalog = try readyRunner().modelCatalog
        let models = AgentDefaults.models(engine: "cursor", provider: "cursor", catalog: catalog, configured: [])
        XCTAssertEqual(models.map(\.name), ["Auto", "Claude Opus 5.5", "GPT-5.5", "Composer 2.5"])
        // The same on a Cursor key: its models are Cursor CLI's on the machine.
        XCTAssertEqual(AgentDefaults.models(engine: "cursor", provider: "cursor-api", catalog: catalog, configured: [cursorKey]), models)
        XCTAssertEqual(AgentDefaults.models(engine: "cursor", provider: "cursor", catalog: nil, configured: []).map(\.name), ["Auto"])
        XCTAssertEqual(AgentDefaults.defaultModel(engine: "cursor", provider: "cursor", catalog: catalog, configured: []), "default")
        XCTAssertEqual(AgentDefaults.defaultModel(engine: "cursor", provider: "cursor", catalog: nil, configured: []), "")
        XCTAssertEqual(AgentDefaults.friendlyName("", engine: "cursor", provider: "cursor", catalog: catalog, configured: []), "Auto")
        XCTAssertTrue(CursorRuntime.isAuto("default"))
        XCTAssertTrue(CursorRuntime.isAuto(""))
        XCTAssertFalse(CursorRuntime.isAuto("claude-opus-5-5"))
        // Each model's own efforts; Auto takes none.
        XCTAssertEqual(AgentDefaults.efforts(for: "cursor", model: "claude-opus-5-5", catalog: catalog),
                       [.default, .low, .medium, .high, .xhigh, .max])
        XCTAssertEqual(AgentDefaults.efforts(for: "cursor", model: "default", catalog: catalog), [.default])
        XCTAssertEqual(AgentDefaults.normalizedEffort(.ultra, for: "cursor", model: "gpt-5.5", catalog: catalog), .default)
        XCTAssertEqual(AgentDefaults.normalizedEffort(.high, for: "cursor", model: "gpt-5.5", catalog: catalog), .high)
        // A stored model the catalogue no longer lists is retired, on the sign-in and on a key alike.
        XCTAssertNil(AgentDefaults.livePin("grok-9", engine: "cursor", provider: "cursor-api", catalog: catalog,
                                           configured: [cursorKey], runtimeDefaults: nil))
        XCTAssertEqual(AgentDefaults.livePin("gpt-5.5", engine: "cursor", provider: "cursor-api", catalog: catalog,
                                             configured: [cursorKey], runtimeDefaults: nil), "gpt-5.5")
    }

    /// D6 A: no Default on Cursor CLI — shown, greyed, with why — and a session lands on Accept Edits.
    func testDefaultIsGreyedAndASessionLandsOnAcceptEdits() {
        XCTAssertFalse(AgentDefaults.isSupported(.default, engine: "cursor"))
        for mode in [PermissionMode.acceptEdits, .plan, .auto, .dontAsk, .bypass] {
            XCTAssertTrue(AgentDefaults.isSupported(mode, engine: "cursor"), mode.rawValue)
        }
        XCTAssertEqual(AgentDefaults.clampPermissionMode(.default, for: "default", engine: "cursor"), .acceptEdits)
        XCTAssertEqual(AgentDefaults.clampPermissionMode(.auto, for: "default", engine: "cursor"), .auto)
        XCTAssertEqual(AgentDefaults.clampPermissionMode(.plan, for: "gpt-5.5", engine: "cursor"), .plan)
        // Every other engine still falls back to Default.
        XCTAssertEqual(AgentDefaults.clampPermissionMode(.acceptEdits, for: "x", engine: "dsh"), .default)
        XCTAssertEqual(CursorRuntime.modeNote(.default), "Unsupported on Cursor CLI; session configuration is rejected")
        XCTAssertEqual(CursorRuntime.modeNote(.dontAsk), "Partly enforced, edits inside the workspace still run")
        for mode in [PermissionMode.acceptEdits, .plan, .auto, .bypass] { XCTAssertNil(CursorRuntime.modeNote(mode)) }
    }

    func testOnlyCursorsOwnSlashCommandsInACursorSession() {
        let items = [
            SlashCommandInfo(name: "review", type: "command", provider: "cursor"),
            SlashCommandInfo(name: "compact", type: "command", provider: "claude"),
            SlashCommandInfo(name: "legacy", type: "command"),
            SlashCommandInfo(name: "kimi-only", type: "command", provider: "kimi"),
            SlashCommandInfo(name: "status", type: "local"),
        ]
        XCTAssertEqual(ComposerSlash.forEngine(items: items, engine: "cursor").map(\.name), ["review", "status"])
        XCTAssertEqual(ComposerSlash.forEngine(items: items, engine: "claude").map(\.name), ["compact", "legacy", "status"])
        XCTAssertEqual(ComposerSlash.forEngine(items: items, engine: "kimi").map(\.name), ["kimi-only", "status"])
    }

    // MARK: - the usage-limit card (board iOS 5 ⑧)

    func testTheUsageLimitCardNamesTheAccountItsPlanAndWhereElseToGo() {
        let notice = AutoRetryNotice(id: "n", message: #"You've hit your usage limit on Cursor. Cursor said: "Upgrade your plan to continue.""#,
                                     variant: .quota, seq: 9)
        let state = AutoRetryLogic.state(notice: notice, live: true, retryAt: nil, attempts: 0, provider: "cursor",
                                         runnerName: "hpc", hasRetryText: true, now: now,
                                         cursor: AutoRetryLogic.CursorQuota(account: "Default", plan: "Free",
                                                                            resetsAt: "2026-10-03T08:00:00.000Z", elsewhere: "Team"),
                                         timeZone: utc)
        XCTAssertEqual(state.title, "Usage limit reached")
        XCTAssertTrue(state.body.hasPrefix("The quota for Default (Cursor CLI) on “hpc” is used up."), state.body)
        XCTAssertEqual(state.cursorAnswer,
                       "Cursor answered “Upgrade your plan to continue”: Default’s Free plan has no requests left until Oct 3.")
        XCTAssertEqual(state.cursorElsewhere, "Team")
        XCTAssertEqual(AutoRetryLogic.cursorElsewhereLead("Team") + AutoRetryLogic.cursorElsewhereLink("Team") + ".",
                       "This conversation can’t move to Team yet — start a new session on Team.")
        XCTAssertEqual(state.retryNowTitle, "Retry now")
        // A paid plan runs out of its included usage; nothing known about the plan is said as nothing.
        let paid = AutoRetryLogic.cursorAnswer(AutoRetryLogic.CursorQuota(account: "Team", plan: "Pro"), message: "", timeZone: utc)
        XCTAssertEqual(paid, "Cursor answered “Upgrade your plan to continue”: Team’s Pro plan has no included usage left.")
        XCTAssertEqual(AutoRetryLogic.cursorAnswer(AutoRetryLogic.CursorQuota(account: "Cursor"), message: "", timeZone: utc),
                       "Cursor answered “Upgrade your plan to continue”.")
        // A stale card, or any other engine's, says nothing of Cursor.
        let stale = AutoRetryLogic.state(notice: notice, live: false, retryAt: nil, attempts: 0, provider: "cursor",
                                         runnerName: "hpc", hasRetryText: true, now: now,
                                         cursor: AutoRetryLogic.CursorQuota(account: "Default"))
        XCTAssertNil(stale.cursorAnswer)
    }

    // MARK: - an API key (board iOS 4)

    func testAKeysLastCheckOnItsRowAndItsPage() throws {
        let rows = try decode([ConfiguredProvider].self, #"""
        [{"id":"k1","slug":"cursor-api","label":"Cursor","runtime":"cursor","presetSlug":"cursor-api","models":[],"engines":["cursor"],
          "keyCheckState":"VALID","keyCheckedAt":"2026-09-28T11:56:00.000Z"},
         {"id":"k2","slug":"cursor-2","label":"Cursor 2","runtime":"cursor","presetSlug":"cursor-api","models":[],"engines":["cursor"],
          "keyCheckState":"INVALID","keyCheckedAt":"2026-09-28T11:56:00.000Z"},
         {"id":"k3","slug":"cursor-3","label":"Cursor 3","runtime":"cursor","presetSlug":"cursor-api","models":[],"engines":["cursor"],
          "keyCheckState":"UNREACHABLE","keyCheckedAt":"2026-09-28T11:48:00.000Z"},
         {"id":"k4","slug":"glm","label":"Z.AI","runtime":"claude","presetSlug":"glm","models":[]}]
        """#)
        XCTAssertEqual(rows.map(CursorRuntime.isKey), [true, true, true, false])
        XCTAssertEqual(rows.map(CursorRuntime.keyCheck), [.valid, .rejected, .unreachable, nil])
        XCTAssertEqual(CursorRuntime.lastCheck(.valid, at: rows[0].keyCheckedAt, now: now), "Valid · 4 min ago")
        XCTAssertEqual(CursorRuntime.lastCheck(.rejected, at: rows[1].keyCheckedAt, now: now), "Rejected · 4 min ago")
        XCTAssertEqual(CursorRuntime.lastCheck(.unreachable, at: rows[2].keyCheckedAt, now: now), "Couldn’t check · 12 min ago")
        XCTAssertEqual(CursorRuntime.lastCheck(.valid, at: iso(minutes: -0.3), now: now), "Valid · just now")
        XCTAssertEqual(CursorRuntime.lastCheck(nil, at: nil, now: now), "Not checked yet")
        XCTAssertEqual(CursorRuntime.checkFooter(.valid), "A runner with Cursor CLI checks the key with Cursor (no request is spent).")
        XCTAssertEqual(CursorRuntime.checkFooter(.rejected),
                       "Cursor said “The provided API key is invalid.” Paste a new key on the web, then check again.")
        let answer = try decode(CursorKeyRecheckAnswer.self, #"""
        {"ok":false,"keyCheck":"NO_RUNNER","message":"No runner of yours can check Cursor keys right now.","recorded":false,
         "keyCheckState":"INVALID","keyCheckedAt":"2026-09-28T11:56:00.000Z"}
        """#)
        XCTAssertFalse(answer.recorded)
        XCTAssertEqual(answer.keyCheckState, "INVALID")
    }

    // MARK: - what the server and runner send, decoded

    func testTheRunnersReportDecodes() throws {
        let ready = try readyRunner()
        XCTAssertEqual(ready.planUsage?.cursor?.planName, "Free")
        XCTAssertEqual(ready.planUsage?.cursor?.accounts?[team]?.includedUsage?.percentUsed, 34)
        XCTAssertEqual(ready.planUsage?.snapshot(for: "cursor")?.provider, "cursor")
        XCTAssertNil(ready.planUsage?.snapshot(for: "claude")?.planName)
        XCTAssertEqual(ready.modelCatalog?.models(for: "cursor")?.first?.name, "Auto")
        XCTAssertEqual(ready.modelCatalog?.modelInfo(for: "cursor", model: "gpt-5.5")?.reasoningLevels, ["low", "medium", "high", "xhigh"])
        let link = try decode(RunnerLoginState.self, #"""
        {"status":"awaiting_approval","engine":"cursor","url":"https://cursor.com/loginDeepControl?challenge=x","userCode":null,
         "message":null,"account":null,"expiresAt":"2026-09-28T12:26:00.000Z"}
        """#)
        XCTAssertEqual(link.expiresAt, "2026-09-28T12:26:00.000Z")
        let expired = try decode(RunnerLoginState.self, #"{"status":"failed","engine":"cursor","url":null,"userCode":null,"message":"The sign-in link expired before anyone signed in with it.","reason":"expired"}"#)
        XCTAssertEqual(expired.reason, "expired")
    }

    // MARK: - parity with the web and the shared tables

    func testTheWordsAreTheWebsOwn() throws {
        let web = try source("src/web/src/lib/cursorRuntime.ts")
        func says(_ declaration: String) { XCTAssertTrue(web.contains(declaration), "cursorRuntime.ts lost `\(declaration)`") }
        says("export const CURSOR_RUNNER_CAPABILITY = '\(CursorRuntime.runnerCapability)';")
        says("export const CURSOR_ACCOUNT_LOGIN_CAPABILITY = '\(CursorRuntime.accountLoginCapability)';")
        says("export const CURSOR_ACCOUNT_MOVE_CAPABILITY = '\(CursorRuntime.accountMoveCapability)';")
        says("export const CURSOR_PINNED_VERSION = '\(CursorRuntime.pinnedVersion)';")
        says("export const CURSOR_KEY_PRESET = '\(CursorRuntime.keyPreset)';")
        for state in [CursorRuntime.RunnerState.updateRunner, .unsupportedPlatform, .unsupportedVersion, .notInstalled] {
            says("  \(state.rawValue): '\(state.label!)',")
        }
        // The web writes Cursor CLI's name and the pinned build as `${…}`: read them back as text.
        let rendered = web.replacingOccurrences(of: "${CURSOR_CLI}", with: CursorRuntime.name)
            .replacingOccurrences(of: "${CURSOR_PINNED_VERSION}", with: CursorRuntime.pinnedVersion)
        for sentence in [CursorRuntime.moveBlockedNote, CursorRuntime.autoNote, CursorRuntime.queueNote,
                         CursorRuntime.runningPlaceholder, CursorRuntime.contextUnavailable,
                         CursorRuntime.stateHint(.updateRunner)!, CursorRuntime.stateHint(.unsupportedPlatform)!] {
            XCTAssertTrue(rendered.contains(sentence), "cursorRuntime.ts no longer says “\(sentence)”")
        }
        // The version hint is two literals on the web.
        let version = CursorRuntime.stateHint(.unsupportedVersion)!
        XCTAssertTrue(rendered.contains(String(version.prefix(version.count - 1))), version)
        let names = try source("src/shared/src/providerEngines.ts")
        XCTAssertTrue(names.contains("[AgentProvider.CURSOR]: '\(CursorRuntime.name)',"))
    }

    func testTheModesAreTheSharedTablesOwn() throws {
        let enums = try source("src/shared/src/enums.ts")
        let block = try XCTUnwrap(enums.components(separatedBy: "export const CURSOR_PERMISSION_MODES").last?
            .components(separatedBy: "];").first)
        let shared = ["ACCEPT_EDITS": PermissionMode.acceptEdits, "PLAN": .plan, "AUTO": .auto, "DONT_ASK": .dontAsk,
                      "BYPASS": .bypass, "DEFAULT": .default]
        let listed = shared.filter { block.contains("PermissionMode.\($0.key)") }.map(\.value)
        XCTAssertEqual(Set(listed), Set(CursorRuntime.permissionModes))
        XCTAssertTrue(enums.contains("export const CURSOR_DEFAULT_PERMISSION_MODE = PermissionMode.ACCEPT_EDITS;"))
        // The subtitles are the shared short notes, first letter capitalised (board iOS 6 ②).
        let semantics = try source("src/shared/src/permissionSemantics.ts")
        XCTAssertTrue(semantics.contains("shortNote: `unsupported on ${cursor}; session configuration is rejected`,"))
        XCTAssertTrue(semantics.contains("shortNote: 'partly enforced, edits inside the workspace still run',"))
        XCTAssertEqual(CursorRuntime.modeNote(.default), "Unsupported on Cursor CLI; session configuration is rejected")
    }

    func testTheUsageWordsAreTheWebsOwn() throws {
        let planUsage = try source("src/web/src/lib/planUsage.ts")
        XCTAssertTrue(planUsage.contains("label: included.period === 'weekly' ? 'Weekly limit' : 'Monthly limit',"))
        let engines = try source("src/web/src/components/RunnerEngines.tsx")
        XCTAssertTrue(engines.contains("label: spent.resetsAt ? `Spent · resets ${formatResetTime(spent.resetsAt, now)}` : 'Spent' }"))
        XCTAssertTrue(engines.contains("Usage unavailable"))
        let runnerEngines = try source("src/web/src/lib/runnerEngines.ts")
        XCTAssertTrue(runnerEngines.contains("text: `${pinned ? 'pinned · ' : ''}${update.status === 'checked' ? 'checked' : 'updated'} ${ago(update.at, now)}`,"))
        let transcript = try source("src/web/src/components/Transcript.tsx")
        XCTAssertTrue(transcript.contains("Cursor answered “{cursorSaid}”"))
        XCTAssertTrue(transcript.contains("cursor.plan === 'Free' ? 'requests' : 'included usage'"))
        XCTAssertTrue(transcript.contains("This conversation can’t move to {cursor.elsewhere.label} yet —{' '}"))
        XCTAssertTrue(transcript.contains("start a new session on {cursor.elsewhere.label}"))
        let signIn = try source("src/web/src/components/RunnerSignIn.tsx")
        for words in ["Open cursor.com", "Waiting for you to sign in…", "link expires in ${left} min", "'Get a new link'",
                      "with the account you are adding:", "with this account again:"] {
            XCTAssertTrue(signIn.contains(words), "RunnerSignIn.tsx no longer says \(words)")
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
