import XCTest
@testable import OrbitKit

/// A runner's Codex accounts as this client reads them: the heartbeat's accounts and per-account
/// quota, which one a new session starts on, and the picker rows under Codex. Mirrors shared
/// `planUsage.spec.ts` (codexAccountToStartOn) and web's `sessionProviderChoices.test.ts`.
final class CodexAccountsTests: XCTestCase {
    private let decoder = JSONDecoder()
    private let now = ISO8601DateFormatter().date(from: "2026-08-03T13:00:00Z")!
    private let later = "2026-08-09T05:26:43Z"
    private let earlier = "2026-08-04T01:00:00Z"
    private let pro = "1fda3f43"

    private func account(_ id: String, _ auth: String = "yes", name: String? = nil) -> RunnerEngineAccount {
        RunnerEngineAccount(id: id, name: name, auth: auth)
    }
    private var both: [RunnerEngineAccount] { [account("default"), account(pro)] }

    private func win(_ utilization: Double, _ mins: Int, _ resetsAt: String?) -> PlanUsageWindow {
        PlanUsageWindow(utilization: utilization, resetsAt: resetsAt, windowDurationMins: mins)
    }
    /// Default a Plus login (a 5-hour and a weekly window), Pro reporting only a weekly one.
    private func usage(_ fiveHour: Double, _ weekly: Double, _ proUsed: Double?, proReset: String? = nil) -> PlanUsageSnapshot {
        PlanUsageSnapshot(
            provider: "codex", primary: win(fiveHour, 300, earlier), secondary: win(weekly, 10080, later),
            accounts: proUsed.map { [pro: PlanUsageSnapshot(provider: "codex", primary: win($0, 10080, proReset ?? later))] })
    }

    func testSpendsTheQuotaThatResetsSoonestFirstSoNoneOfItGoesUnused() {
        // Pro's week ends in two days, Default's in six: Pro, though it has used more of it.
        XCTAssertEqual(CodexAccounts.toStartOn(both, usage: usage(5, 18, 40, proReset: "2026-08-05T13:00:00Z"), now: now), pro)
        XCTAssertEqual(CodexAccounts.toStartOn(both, usage: usage(5, 18, 40, proReset: "2026-08-10T00:00:00Z"), now: now), "default")
    }

    func testTakesAnAccountNearlySpentLastHoweverSoonItResets() {
        XCTAssertEqual(CodexAccounts.toStartOn(both, usage: usage(5, 18, 92, proReset: "2026-08-05T13:00:00Z"), now: now), "default")
        XCTAssertEqual(CodexAccounts.toStartOn(both, usage: usage(95, 18, 40), now: now), pro)
        XCTAssertEqual(CodexAccounts.toStartOn(both, usage: usage(100, 18, 92), now: now), pro, "last still beats spent")
    }

    func testLeavesTheLastFifthOfAPlusLoginsFiveHoursAndAProLoginsWeekItsLastTenth() {
        // Default's week ends first, so it takes the run — until its 5-hour window passes 80%.
        XCTAssertEqual(CodexAccounts.toStartOn(both, usage: usage(79, 18, 40, proReset: "2026-08-10T00:00:00Z"), now: now), "default")
        XCTAssertEqual(CodexAccounts.toStartOn(both, usage: usage(80, 18, 40, proReset: "2026-08-10T00:00:00Z"), now: now), pro)
        // Pro reports its week in the slot Plus reports its 5 hours in: at 85% it is not nearly spent.
        XCTAssertEqual(CodexAccounts.toStartOn(both, usage: usage(5, 18, 85, proReset: "2026-08-05T13:00:00Z"), now: now), pro)
    }

    func testCallsAFiveHourWindowNearlySpentAtEightyPercentAndALongerOneAtNinety() {
        let inTwoHours = "2026-08-03T15:00:00Z", inThreeDays = "2026-08-06T13:00:00Z"
        func claude(_ fiveHour: Double, _ sevenDay: Double) -> PlanUsageSnapshot {
            PlanUsageSnapshot(provider: "claude", fiveHour: PlanUsageWindow(utilization: fiveHour, resetsAt: inTwoHours),
                              sevenDay: PlanUsageWindow(utilization: sevenDay, resetsAt: inThreeDays))
        }
        func codex(_ window: PlanUsageWindow) -> PlanUsageSnapshot { PlanUsageSnapshot(provider: "codex", primary: window) }
        XCTAssertFalse(CodexAccounts.nearlySpent(claude(79, 89), now: now))
        XCTAssertTrue(CodexAccounts.nearlySpent(claude(80, 0), now: now))
        XCTAssertTrue(CodexAccounts.nearlySpent(claude(0, 90), now: now))
        // By the window's length, never its slot: a Plus login's 5 hours and a Pro login's week both
        // come as `primary`.
        XCTAssertTrue(CodexAccounts.nearlySpent(codex(win(80, 300, inTwoHours)), now: now))
        XCTAssertFalse(CodexAccounts.nearlySpent(codex(win(89, 10080, inTwoHours)), now: now))
        XCTAssertTrue(CodexAccounts.nearlySpent(codex(win(90, 10080, inTwoHours)), now: now))
        // One that does not say how long it is is held to the longer windows' mark.
        XCTAssertFalse(CodexAccounts.nearlySpent(codex(PlanUsageWindow(utilization: 89, resetsAt: inTwoHours)), now: now))
        let lapsed = PlanUsageSnapshot(provider: "claude", fiveHour: PlanUsageWindow(utilization: 100, resetsAt: "2026-08-03T12:00:00Z"))
        XCTAssertFalse(CodexAccounts.nearlySpent(lapsed, now: now))
    }

    func testAQuotaExpiresWhenItsLongestWindowResets() {
        let inTwoHours = "2026-08-03T15:00:00Z", inThreeDays = "2026-08-06T13:00:00Z"
        func at(_ iso: String) -> Double { ISO8601DateFormatter().date(from: iso)!.timeIntervalSince1970 }
        let claude = PlanUsageSnapshot(provider: "claude", fiveHour: PlanUsageWindow(utilization: 40, resetsAt: inTwoHours),
                                       sevenDay: PlanUsageWindow(utilization: 10, resetsAt: inThreeDays))
        XCTAssertEqual(CodexAccounts.expiresAt(claude, now: now), at(inThreeDays))
        let codex = PlanUsageSnapshot(provider: "codex", primary: win(40, 300, inTwoHours), secondary: win(10, 10080, inThreeDays))
        XCTAssertEqual(CodexAccounts.expiresAt(codex, now: now), at(inThreeDays))
        // The week it describes is over, so the 5 hours are what is left to go by.
        let lapsedWeek = PlanUsageSnapshot(provider: "claude", fiveHour: PlanUsageWindow(utilization: 40, resetsAt: inTwoHours),
                                           sevenDay: PlanUsageWindow(utilization: 10, resetsAt: "2026-08-03T12:00:00Z"))
        XCTAssertEqual(CodexAccounts.expiresAt(lapsedWeek, now: now), at(inTwoHours))
        let noReset = PlanUsageSnapshot(provider: "claude", fiveHour: PlanUsageWindow(utilization: 40, resetsAt: nil))
        XCTAssertEqual(CodexAccounts.expiresAt(noReset, now: now), .infinity)
    }

    func testPassesOverASpentAccountAndOnEqualExpiryRanksTheRestByTheirTightestWindow() {
        XCTAssertEqual(CodexAccounts.toStartOn(both, usage: usage(100, 18, 70), now: now), pro)
        XCTAssertEqual(CodexAccounts.toStartOn(both, usage: usage(5, 18, 0), now: now), pro)
        XCTAssertEqual(CodexAccounts.toStartOn(both, usage: usage(5, 18, 40), now: now), "default")
        XCTAssertEqual(CodexAccounts.toStartOn(both, usage: usage(18, 18, 18), now: now), "default", "a tie goes to Default")
    }

    func testRanksAnUnreadAccountAfterOnesWithRoomButTakesItOverASpentOne() {
        XCTAssertEqual(CodexAccounts.toStartOn(both, usage: usage(79, 18, nil), now: now), "default")
        XCTAssertEqual(CodexAccounts.toStartOn(both, usage: usage(80, 18, nil), now: now), pro, "ahead of one nearly spent")
        XCTAssertEqual(CodexAccounts.toStartOn(both, usage: usage(100, 18, nil), now: now), pro)
    }

    func testNeverPicksASignedOutAccount() {
        XCTAssertEqual(CodexAccounts.toStartOn([account("default"), account(pro, "no")], usage: usage(90, 18, 0), now: now), "default")
        XCTAssertNil(CodexAccounts.toStartOn([account("default", "no"), account(pro, "no")], usage: usage(0, 0, 0), now: now))
    }

    func testWithEveryAccountSpentStartsWhereTheFirstWindowFreesUp() {
        XCTAssertEqual(CodexAccounts.toStartOn(both, usage: usage(100, 18, 100), now: now), "default")
        XCTAssertEqual(CodexAccounts.toStartOn(both, usage: usage(100, 18, 100, proReset: "2026-08-03T14:00:00Z"), now: now), pro)
    }

    func testASpentWindowWithNoResetIsSpentAndOnePastItsResetIsNot() {
        let noReset = PlanUsageSnapshot(provider: "codex", primary: win(100, 300, nil),
                                        accounts: [pro: PlanUsageSnapshot(provider: "codex", primary: win(60, 10080, later))])
        XCTAssertEqual(CodexAccounts.toStartOn(both, usage: noReset, now: now), pro)
        let lapsed = PlanUsageSnapshot(provider: "codex", primary: win(100, 300, "2026-08-03T12:00:00Z"))
        XCTAssertEqual(CodexAccounts.toStartOn(both, usage: lapsed, now: now), "default")
    }

    func testHasNothingToChooseWithFewerThanTwoAccounts() {
        XCTAssertNil(CodexAccounts.toStartOn([account("default")], usage: usage(100, 18, nil), now: now))
        XCTAssertNil(CodexAccounts.toStartOn([], usage: nil, now: now))
        XCTAssertNil(CodexAccounts.toStartOn(nil, usage: nil, now: now))
    }

    func testEachAccountHasItsOwnQuotaAndNoAccountAnothers() {
        let u = usage(62, 18, 8)
        XCTAssertEqual(CodexAccounts.snapshot(u, account: "default")?.primary?.utilization, 62)
        XCTAssertNil(CodexAccounts.snapshot(u, account: "default")?.accounts)
        XCTAssertEqual(CodexAccounts.snapshot(u, account: pro)?.primary?.utilization, 8)
        XCTAssertNil(CodexAccounts.snapshot(u, account: "c0ffee42"))
        // A snapshot from before accounts is Default's whole.
        XCTAssertEqual(CodexAccounts.snapshot(usage(62, 18, nil), account: "default")?.primary?.utilization, 62)
    }

    func testAnAccountIsNamedTheWayThePickerNamesIt() {
        let accounts = [account("default"), account(pro, name: "kxugfvukxczwl@mail.com"), account("c0ffee42")]
        XCTAssertEqual(CodexAccounts.label("default", accounts: accounts), "Default")
        XCTAssertEqual(CodexAccounts.label(pro, accounts: accounts), "kxugfvukxczwl@mail.com")
        XCTAssertEqual(CodexAccounts.label("c0ffee42", accounts: accounts), "Account c0ffee42")
    }

    func testAnIdTheRunnerDoesNotReportRunsOnDefault() {
        XCTAssertEqual(CodexAccounts.onRunner(pro, accounts: both), pro)
        XCTAssertEqual(CodexAccounts.onRunner("c0ffee42", accounts: both), "default")
        XCTAssertEqual(CodexAccounts.onRunner(nil, accounts: both), "default")
    }

    func testAutomaticIsOnOfferOnlyWhereNothingElseDecidesTheAccount() throws {
        func agent(_ json: String) throws -> Agent {
            try decoder.decode(Agent.self, from: Data(#"{"id":"w","name":"orbit"\#(json)}"#.utf8))
        }
        XCTAssertTrue(CodexAccounts.automaticOffered(agent: try agent(""), accounts: both))
        XCTAssertFalse(CodexAccounts.automaticOffered(agent: try agent(#","codexAccount":"default""#), accounts: both))
        XCTAssertFalse(CodexAccounts.automaticOffered(agent: try agent(#","codexAccount":"1fda3f43""#), accounts: both))
        XCTAssertFalse(CodexAccounts.automaticOffered(agent: try agent(#","env":{"CODEX_HOME":"/srv/codex"}"#), accounts: both))
        XCTAssertFalse(CodexAccounts.automaticOffered(agent: try agent(#","env":{"OPENAI_API_KEY":"sk-test"}"#), accounts: both))
        XCTAssertTrue(CodexAccounts.automaticOffered(agent: try agent(#","env":{"RUST_LOG":"warn"}"#), accounts: both))
        XCTAssertFalse(CodexAccounts.automaticOffered(agent: try agent(""), accounts: [account("default")]))
    }

    func testTheRunnerReportDecodesItsAccountsAndEachOnesQuota() throws {
        let runner = try decoder.decode(Runner.self, from: Data("""
        {"id": "r", "name": "wikova",
         "engines": [{"engine": "codex", "installed": true, "auth": "yes",
                      "accounts": [{"id": "default", "home": "/root/.codex", "codexHome": "/root/.codex", "auth": "yes"},
                                   {"id": "1fda3f43", "name": "kxugfvukxczwl@mail.com", "home": "/root/.orbit/codex-accounts/1fda3f43", "auth": "yes",
                                    "fingerprintPrefix": "cxa1_a45157f6"}]}],
         "planUsage": {"codex": {"provider": "codex",
                                 "primary": {"utilization": 100, "windowDurationMins": 300, "resetsAt": "2026-09-29T06:19:23Z"},
                                 "accounts": {"1fda3f43": {"provider": "codex", "primary": {"utilization": 0, "windowDurationMins": 10080}}}}}}
        """.utf8))
        XCTAssertEqual(runner.engines?.first?.accounts?.map(\.id), ["default", pro])
        XCTAssertEqual(runner.engines?.first?.accounts?.last?.name, "kxugfvukxczwl@mail.com")
        let codex = runner.planUsage?.snapshot(for: "codex")
        XCTAssertEqual(CodexAccounts.snapshot(codex, account: pro)?.primary?.utilization, 0)
        XCTAssertEqual(CodexAccounts.snapshot(codex, account: "default")?.primary?.utilization, 100)
    }

    func testTheSessionDetailCarriesItsOwnAccountAndItsWorkspaces() throws {
        let session = try decoder.decode(Session.self, from: Data("""
        {"id": "s", "status": "AWAITING_INPUT", "provider": "codex", "codexAccount": "1fda3f43",
         "agent": {"id": "w", "name": "orbit", "codexAccount": "default"}}
        """.utf8))
        XCTAssertEqual(session.codexAccount, pro)
        XCTAssertEqual(session.agent?.codexAccount, "default")
        // An upsert from the list, which carries neither, keeps the detail's.
        let listed = try decoder.decode(Session.self, from: Data(#"{"id": "s", "status": "RUNNING"}"#.utf8))
        XCTAssertNil(listed.codexAccount)
    }

    func testTheCreateRequestSendsAnAccountOnlyWhenOneWasPicked() throws {
        let encoder = JSONEncoder()
        let picked = try JSONSerialization.jsonObject(with: encoder.encode(
            CreateSessionRequest(prompt: "hi", agentId: "w", codexAccount: "default"))) as? [String: Any]
        XCTAssertEqual(picked?["codexAccount"] as? String, "default")
        let unpicked = try JSONSerialization.jsonObject(with: encoder.encode(
            CreateSessionRequest(prompt: "hi", agentId: "w"))) as? [String: Any]
        XCTAssertNil(unpicked?["codexAccount"], "no pick is no field: the server decides")
    }

    func testThePickerListsTheCodexAccountsUnderCodexWithTheirOwnQuota() {
        let engines = [
            RunnerEngineHealth(engine: "claude", installed: true, auth: "yes"),
            RunnerEngineHealth(engine: "codex", installed: true, auth: "yes", accounts: [
                account("default"), account(pro, name: "kxugfvukxczwl@mail.com"), account("c0ffee42", "no"),
            ]),
        ]
        let planUsage = try? decoder.decode(PlanUsage.self, from: Data("""
        {"codex": {"provider": "codex",
                   "primary": {"utilization": 100, "windowDurationMins": 300, "resetsAt": "\(earlier)"},
                   "secondary": {"utilization": 18, "windowDurationMins": 10080, "resetsAt": "\(later)"},
                   "accounts": {"\(pro)": {"provider": "codex", "primary": {"utilization": 0, "windowDurationMins": 10080}}}}}
        """.utf8))
        XCTAssertNotNil(planUsage)
        let choices = SessionProviderChoices.choices(configured: [], engines: engines, planUsage: planUsage)
        XCTAssertEqual(choices.first { $0.slug == "codex" }?.accounts, [
            AccountChoice(id: "default", label: "Default", quota: "5h 100%", nearLimit: true),
            AccountChoice(id: pro, label: "kxugfvukxczwl@mail.com", quota: "Weekly 0%"),
            AccountChoice(id: "c0ffee42", label: "Account c0ffee42", unavailable: "Not signed in"),
        ])
        XCTAssertNil(choices.first { $0.slug == "claude" }?.accounts)
        // One account, or an engine that cannot run, lists none.
        let single = [RunnerEngineHealth(engine: "codex", installed: true, auth: "yes", accounts: [account("default")])]
        XCTAssertNil(SessionProviderChoices.choices(configured: [], engines: single).first { $0.slug == "codex" }?.accounts)
        let signedOut = [RunnerEngineHealth(engine: "codex", installed: true, auth: "no", accounts: both)]
        XCTAssertNil(SessionProviderChoices.choices(configured: [], engines: signedOut).first { $0.slug == "codex" }?.accounts)
    }

    // MARK: Claude accounts, the same way

    private func claudeUsage(defaultFive: Double, defaultWeek: Double, workWeek: Double) -> PlanUsageSnapshot {
        PlanUsageSnapshot(
            provider: "claude",
            fiveHour: PlanUsageWindow(utilization: defaultFive, resetsAt: later),
            sevenDay: PlanUsageWindow(utilization: defaultWeek, resetsAt: later),
            accounts: [pro: PlanUsageSnapshot(provider: "claude",
                                              fiveHour: PlanUsageWindow(utilization: 19, resetsAt: later),
                                              sevenDay: PlanUsageWindow(utilization: workWeek, resetsAt: later))])
    }

    func testAClaudeLoginIsRankedByTheWindowThatStopsIt() {
        // Default's 5-hour window reads 0% but its weekly one is spent: the other account has room.
        XCTAssertEqual(CodexAccounts.toStartOn(both, usage: claudeUsage(defaultFive: 0, defaultWeek: 100, workWeek: 28), now: now), pro)
        XCTAssertEqual(CodexAccounts.toStartOn(both, usage: claudeUsage(defaultFive: 0, defaultWeek: 10, workWeek: 28), now: now), "default")
    }

    func testAClaudeSessionStartsWhereTheWeekEndsFirstUntilThatAccountsFiveHoursPassEightyPercent() {
        // 2026-10-02 on wikova, in miniature: Work's week ends days before Default's, and every new
        // session went to Work while Default sat at 1% of its 5 hours.
        func usage(workFive: Double) -> PlanUsageSnapshot {
            PlanUsageSnapshot(
                provider: "claude",
                fiveHour: PlanUsageWindow(utilization: 1, resetsAt: earlier),
                sevenDay: PlanUsageWindow(utilization: 0, resetsAt: "2026-08-09T03:59:59Z"),
                accounts: [pro: PlanUsageSnapshot(provider: "claude",
                                                  fiveHour: PlanUsageWindow(utilization: workFive, resetsAt: earlier),
                                                  sevenDay: PlanUsageWindow(utilization: 59, resetsAt: "2026-08-06T21:59:59Z"))])
        }
        XCTAssertEqual(CodexAccounts.toStartOn(both, usage: usage(workFive: 79), now: now), pro)
        XCTAssertEqual(CodexAccounts.toStartOn(both, usage: usage(workFive: 85), now: now), "default")
    }

    func testThePickerListsClaudeAccountsUnderClaudeByTheirTightestWindow() {
        let engines = [
            RunnerEngineHealth(engine: "claude", installed: true, auth: "yes", accounts: [
                account("default"), account(pro, name: "jianghailong.rd"),
            ]),
        ]
        let planUsage = try? decoder.decode(PlanUsage.self, from: Data("""
        {"claude": {"provider": "claude",
                    "fiveHour": {"utilization": 0, "resetsAt": "\(later)"},
                    "sevenDay": {"utilization": 100, "resetsAt": "\(later)"},
                    "accounts": {"\(pro)": {"provider": "claude", "fiveHour": {"utilization": 19}, "sevenDay": {"utilization": 28}}}}}
        """.utf8))
        XCTAssertNotNil(planUsage)
        let choices = SessionProviderChoices.choices(configured: [], engines: engines, planUsage: planUsage)
        XCTAssertEqual(choices.first { $0.slug == "claude" }?.accounts, [
            AccountChoice(id: "default", label: "Default", quota: "Weekly 100%", nearLimit: true),
            AccountChoice(id: pro, label: "jianghailong.rd", quota: "Weekly 28%"),
        ])
        XCTAssertEqual(SessionProviderChoices.compactWindowLabel("5-hour limit"), "5h")
        XCTAssertEqual(SessionProviderChoices.compactWindowLabel("Weekly · Opus"), "Weekly Opus")
        XCTAssertEqual(SessionProviderChoices.compactWindowLabel("5h limit"), "5h")
    }

    func testClaudeAutomaticIsDecidedByTheWorkspacesClaudePickAndEnv() throws {
        func agent(_ json: String) throws -> Agent {
            try decoder.decode(Agent.self, from: Data(#"{"id":"w","name":"orbit"\#(json)}"#.utf8))
        }
        XCTAssertTrue(CodexAccounts.automaticOffered(engine: "claude", agent: try agent(""), accounts: both))
        // Its Codex pick says nothing about its Claude sessions, and the reverse.
        XCTAssertTrue(CodexAccounts.automaticOffered(engine: "claude", agent: try agent(#","codexAccount":"default""#), accounts: both))
        XCTAssertFalse(CodexAccounts.automaticOffered(engine: "claude", agent: try agent(#","claudeAccount":"default""#), accounts: both))
        XCTAssertTrue(CodexAccounts.automaticOffered(engine: "codex", agent: try agent(#","claudeAccount":"default""#), accounts: both))
        XCTAssertFalse(CodexAccounts.automaticOffered(engine: "claude", agent: try agent(#","env":{"CLAUDE_CONFIG_DIR":"/srv/claude"}"#), accounts: both))
        XCTAssertFalse(CodexAccounts.automaticOffered(engine: "claude", agent: try agent(#","env":{"ANTHROPIC_API_KEY":"sk-ant-test"}"#), accounts: both))
        XCTAssertTrue(CodexAccounts.automaticOffered(engine: "claude", agent: try agent(#","env":{"CODEX_HOME":"/srv/codex"}"#), accounts: both))
        // Asked of what a session's detail carries of its workspace.
        XCTAssertFalse(CodexAccounts.automaticOffered(engine: "claude", pick: nil, env: ["CLAUDE_CODE_OAUTH_TOKEN": "t"], accounts: both))
        XCTAssertTrue(CodexAccounts.automaticOffered(engine: "claude", pick: nil, env: nil, accounts: both))
    }

    func testTheSessionDetailCarriesItsClaudeAccountAndWhetherEachAccountWasPicked() throws {
        let session = try decoder.decode(Session.self, from: Data("""
        {"id": "s", "status": "AWAITING_INPUT", "provider": "claude",
         "codexAccount": null, "codexAccountPinned": false,
         "claudeAccount": "1fda3f43", "claudeAccountPinned": true,
         "agent": {"id": "w", "name": "orbit", "claudeAccount": null, "env": {"RUST_LOG": "warn"}}}
        """.utf8))
        XCTAssertEqual(session.claudeAccount, pro)
        XCTAssertEqual(session.claudeAccountPinned, true)
        XCTAssertEqual(session.codexAccountPinned, false)
        XCTAssertEqual(session.agent?.env?["RUST_LOG"], "warn")
    }

    func testTheCreateRequestSendsAClaudeAccountOnlyWhenOneWasPicked() throws {
        let encoder = JSONEncoder()
        let picked = try JSONSerialization.jsonObject(with: encoder.encode(
            CreateSessionRequest(prompt: "hi", agentId: "w", provider: "claude", claudeAccount: pro))) as? [String: Any]
        XCTAssertEqual(picked?["claudeAccount"] as? String, pro)
        XCTAssertNil(picked?["codexAccount"])
        let move = try JSONSerialization.jsonObject(with: encoder.encode(
            SessionAccountRequest(account: CodexAccounts.automaticID))) as? [String: Any]
        XCTAssertEqual(move as? [String: String], ["account": "automatic"])
    }
}
