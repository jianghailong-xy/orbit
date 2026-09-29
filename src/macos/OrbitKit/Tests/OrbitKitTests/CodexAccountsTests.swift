import XCTest
@testable import OrbitKit

/// A runner's Codex accounts as this client reads them: the heartbeat's accounts and per-account
/// quota, which one a new session starts on, and the picker rows under Codex. Mirrors shared
/// `planUsage.spec.ts` (roomiestCodexAccount) and web's `sessionProviderChoices.test.ts`.
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

    func testPassesOverASpentAccountAndRanksTheRestByTheirTightestWindow() {
        XCTAssertEqual(CodexAccounts.roomiest(both, usage: usage(100, 18, 70), now: now), pro)
        XCTAssertEqual(CodexAccounts.roomiest(both, usage: usage(5, 18, 0), now: now), pro)
        XCTAssertEqual(CodexAccounts.roomiest(both, usage: usage(5, 18, 40), now: now), "default")
        XCTAssertEqual(CodexAccounts.roomiest(both, usage: usage(18, 18, 18), now: now), "default", "a tie goes to Default")
    }

    func testRanksAnUnreadAccountLastButTakesItOverASpentOne() {
        XCTAssertEqual(CodexAccounts.roomiest(both, usage: usage(90, 18, nil), now: now), "default")
        XCTAssertEqual(CodexAccounts.roomiest(both, usage: usage(100, 18, nil), now: now), pro)
    }

    func testNeverPicksASignedOutAccount() {
        XCTAssertEqual(CodexAccounts.roomiest([account("default"), account(pro, "no")], usage: usage(90, 18, 0), now: now), "default")
        XCTAssertNil(CodexAccounts.roomiest([account("default", "no"), account(pro, "no")], usage: usage(0, 0, 0), now: now))
    }

    func testWithEveryAccountSpentStartsWhereTheFirstWindowFreesUp() {
        XCTAssertEqual(CodexAccounts.roomiest(both, usage: usage(100, 18, 100), now: now), "default")
        XCTAssertEqual(CodexAccounts.roomiest(both, usage: usage(100, 18, 100, proReset: "2026-08-03T14:00:00Z"), now: now), pro)
    }

    func testASpentWindowWithNoResetIsSpentAndOnePastItsResetIsNot() {
        let noReset = PlanUsageSnapshot(provider: "codex", primary: win(100, 300, nil),
                                        accounts: [pro: PlanUsageSnapshot(provider: "codex", primary: win(60, 10080, later))])
        XCTAssertEqual(CodexAccounts.roomiest(both, usage: noReset, now: now), pro)
        let lapsed = PlanUsageSnapshot(provider: "codex", primary: win(100, 300, "2026-08-03T12:00:00Z"))
        XCTAssertEqual(CodexAccounts.roomiest(both, usage: lapsed, now: now), "default")
    }

    func testHasNothingToChooseWithFewerThanTwoAccounts() {
        XCTAssertNil(CodexAccounts.roomiest([account("default")], usage: usage(100, 18, nil), now: now))
        XCTAssertNil(CodexAccounts.roomiest([], usage: nil, now: now))
        XCTAssertNil(CodexAccounts.roomiest(nil, usage: nil, now: now))
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
}
