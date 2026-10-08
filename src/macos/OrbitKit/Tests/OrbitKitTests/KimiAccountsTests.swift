import Foundation
import XCTest
@testable import OrbitKit

/// Kimi Code's accounts, drawn and weighed the way Claude Code's, Codex's and Antigravity's are
/// (docs/mocks/kimi-accounts/02-ios): the runner page's row, the engine page's account lines — each
/// with its own site, directory and three windows — Add Account's gate, the sign-in's Current, NEXT on
/// every engine page that keeps accounts, Automatic, the New Session picker, Needs Attention, and what
/// a session and its workspace carry. The machine is the board's HPC: Default on kimi.ai, and Work
/// added beside it on kimi.com.
final class KimiAccountsTests: XCTestCase {
    private let work = "5c2e91a0"
    private let loginCapability = "kimi-account-login/v1"
    /// 2026-10-08 5:30 PM in the board's Shanghai time: before every reset below.
    private let now = ISO8601DateFormatter().date(from: "2026-10-08T09:30:00Z")!

    private typealias Account = (id: String, name: String?, auth: String, region: String?)

    /// One account's windows as the runner reads them off Kimi's /usages: limit_5h, limit_7d,
    /// limit_month_total and limit_month_code.
    private func usage(fiveHour: Double, fiveHourResets: String, week: Double, weekResets: String,
                       month: Double, monthResets: String, monthCode: Double) -> [String: Any] {
        ["provider": "kimi", "fetchedAt": "2026-10-08T09:28:00Z",
         "fiveHour": ["utilization": fiveHour, "resetsAt": fiveHourResets],
         "sevenDay": ["utilization": week, "resetsAt": weekResets],
         "month": ["utilization": month, "resetsAt": monthResets],
         "monthCode": ["utilization": monthCode, "resetsAt": monthResets]]
    }

    /// Default's, as the board draws them: 5h 12%, Weekly 34%, Monthly 8%.
    private var defaultUsage: [String: Any] {
        usage(fiveHour: 12, fiveHourResets: "2026-10-08T11:40:00Z", week: 34, weekResets: "2026-10-13T01:00:00Z",
              month: 8, monthResets: "2026-11-01T00:00:00Z", monthCode: 5)
    }

    /// Work's: its 5 hours at 91%.
    private var workUsage: [String: Any] {
        usage(fiveHour: 91, fiveHourResets: "2026-10-08T10:15:00Z", week: 61, weekResets: "2026-10-10T06:00:00Z",
              month: 22, monthResets: "2026-10-29T07:12:00Z", monthCode: 15)
    }

    private let both: [Account] = [("default", nil, "yes", "global"), ("5c2e91a0", "Work", "yes", "mainland-cn")]

    /// Kimi as the runner reports it: the engine's own answer and site (Default's), and — from a runner
    /// that keeps Kimi accounts — every account, Default first, each with its directory and site.
    private func kimi(_ accounts: [Account]?, auth: String = "yes", region: String? = "global") -> [String: Any] {
        var engine: [String: Any] = ["engine": "kimi", "installed": true, "version": "2.1.1", "auth": auth]
        if let region { engine["kimiRegion"] = region }
        if let accounts {
            engine["accounts"] = accounts.map { account -> [String: Any] in
                var entry: [String: Any] = [
                    "id": account.id, "auth": account.auth,
                    "home": account.id == "default" ? "/root/.kimi-code" : "/root/.orbit/kimi-accounts/\(account.id)",
                ]
                if let name = account.name { entry["name"] = name }
                if let region = account.region { entry["kimiRegion"] = region }
                return entry
            }
        }
        return engine
    }

    /// The heartbeat's planUsage.kimi: Default's windows, every other account's under `accounts`.
    private func kimiUsage(_ own: [String: Any]?, others: [String: [String: Any]] = [:]) -> [String: Any] {
        var usage = own ?? ["provider": "kimi"]
        if !others.isEmpty { usage["accounts"] = others }
        return usage
    }

    /// The HPC runner, online, reporting `engines` and `planUsage`.
    private func runner(_ engines: [[String: Any]], planUsage: [String: Any]? = nil,
                        capabilities: [String]? = nil) throws -> Runner {
        var object: [String: Any] = [
            "id": "r1", "name": "HPC", "online": true, "status": "ONLINE", "version": "0.1.232",
            "lastHeartbeatAt": "2026-10-08T09:29:50Z",
            "capabilities": capabilities ?? [loginCapability, "kimi-account-remove/v1", "kimi-account-move/v1",
                                             "kimi-login-region/v1"],
            "engines": engines,
        ]
        if let planUsage { object["planUsage"] = planUsage }
        return try JSONDecoder().decode(Runner.self, from: JSONSerialization.data(withJSONObject: object))
    }

    /// The board's HPC: Default and Work, each with its own windows.
    private func hpc(_ accounts: [Account]? = nil, capabilities: [String]? = nil) throws -> Runner {
        try runner([kimi(accounts ?? both)],
                   planUsage: ["kimi": kimiUsage(defaultUsage, others: [work: workUsage])],
                   capabilities: capabilities)
    }

    private func health(_ runner: Runner, _ engine: String = "kimi") throws -> RunnerEngineHealth {
        try XCTUnwrap(runner.engines?.first { $0.engine == engine })
    }

    private func workspace(_ json: String = "") throws -> Agent {
        try JSONDecoder().decode(Agent.self,
                                 from: Data(#"{"id":"w1","name":"orbit-develop","lastProvider":"kimi"\#(json)}"#.utf8))
    }

    // MARK: what the runner reports

    /// Each account's site and Kimi's four windows decode; the month's coding share rides beside its
    /// total, and the other accounts' windows sit under `accounts` as Codex's and Claude's do.
    func testTheRunnerReportDecodesEachAccountsSiteAndKimisWindows() throws {
        let machine = try hpc()
        XCTAssertEqual(try health(machine).accounts?.map(\.kimiRegion), ["global", "mainland-cn"])
        XCTAssertEqual(try health(machine).kimiRegion, "global", "the engine's own site stays Default's")
        let usage = try XCTUnwrap(machine.planUsage?.snapshot(for: "kimi"))
        XCTAssertEqual(usage.month?.utilization, 8)
        XCTAssertEqual(usage.month?.resetsAt, "2026-11-01T00:00:00Z")
        XCTAssertEqual(usage.monthCode?.utilization, 5)
        XCTAssertEqual(CodexAccounts.snapshot(usage, account: work)?.month?.utilization, 22)
        XCTAssertEqual(CodexAccounts.snapshot(usage, account: work)?.fiveHour?.utilization, 91)
        XCTAssertNil(CodexAccounts.snapshot(usage, account: "default")?.accounts, "Default's part is its own")
        XCTAssertEqual(CodexAccounts.usage("kimi", planUsage: machine.planUsage, engines: machine.engines), usage,
                       "read from the runner's own report, as Codex's and Claude's are")
        // A flat payload that says it is Kimi's carries its month too.
        let flat = try JSONDecoder().decode(PlanUsage.self, from: Data("""
        {"provider": "kimi", "month": {"utilization": 40}, "monthCode": {"utilization": 10}}
        """.utf8))
        XCTAssertEqual(flat.snapshot(for: "kimi")?.month?.utilization, 40)
        XCTAssertEqual(flat.snapshot(for: "kimi")?.monthCode?.utilization, 10)
    }

    // MARK: the engine page (02-ios ① ② ③)

    /// Each Kimi account is a line of the Accounts section, Default first: its name, its site before
    /// where its login lives, its own state — and a sign-in on it names it.
    func testEachAccountsLineSaysItsSiteThenItsDirectory() throws {
        let lines = RunnerPageFormat.accountLines(try health(try hpc()))
        XCTAssertEqual(lines.map(\.name), ["Default", "Work"])
        XCTAssertEqual(lines.map(\.subtitle), ["kimi.ai · ~/.kimi-code", "kimi.com · ~/.orbit/kimi-accounts/5c2e91a0"])
        XCTAssertEqual(lines.map(\.auth), ["yes", "yes"])
        XCTAssertEqual(lines.map(\.signInAccount), ["default", work])
        XCTAssertEqual(RunnerPageFormat.defaultAccountName(try XCTUnwrap(try health(try hpc()).accounts)), "Account 3")
        // One that has not signed in yet has no site to say.
        let fresh = RunnerPageFormat.accountLines(try health(try hpc([both[0], (work, "Work", "no", nil)])))
        XCTAssertEqual(fresh.map(\.subtitle), ["kimi.ai · ~/.kimi-code", "~/.orbit/kimi-accounts/5c2e91a0"])
        // A Default renamed in Orbit still says it is the machine's own login.
        let renamed = RunnerPageFormat.accountLines(try health(try hpc([("default", "Personal", "yes", "global"), both[1]])))
        XCTAssertEqual(renamed.first?.subtitle, "kimi.ai · ~/.kimi-code · Default")
        // The one account of a runner that keeps Kimi accounts says the same, and the runner too old to
        // list any says its site alone, as it always has.
        let one = RunnerPageFormat.accountLines(try health(try hpc([both[0]])))
        XCTAssertEqual(one.map(\.subtitle), ["kimi.ai · ~/.kimi-code"])
        XCTAssertEqual(one.map(\.signInAccount), [nil])
        let older = RunnerPageFormat.accountLines(try health(try runner([kimi(nil)], capabilities: [])))
        XCTAssertEqual(older.map(\.subtitle), ["kimi.ai"])
    }

    /// Each account's three windows, in the words of Kimi's own /usage: 5h, Weekly and Monthly — the
    /// month drawn once, as its total (the owner's call on 02-ios ①), its coding share never a row.
    func testEachAccountShowsItsOwnThreeWindows() throws {
        let machine = try hpc()
        let own = RunnerPageFormat.accountWindows(machine, engine: "kimi", account: "default")
        XCTAssertEqual(own.map(\.label), ["5h limit", "Weekly limit", "Monthly limit"])
        XCTAssertEqual(own.map(\.key), ["fiveHour", "sevenDay", "month"])
        XCTAssertEqual(own.map(\.percent), [12, 34, 8])
        XCTAssertFalse(own.contains { $0.remaining }, "Kimi says what is used, as Claude and Codex do")
        let theirs = RunnerPageFormat.accountWindows(machine, engine: "kimi", account: work)
        XCTAssertEqual(theirs.map(\.percent), [91, 61, 22])
        XCTAssertEqual(theirs.map(\.nearLimit), [true, false, false], "Work's 5 hours turn amber")
        XCTAssertEqual(RunnerPageFormat.resetsLine(theirs[2], now: now, timeZone: TimeZone(identifier: "Asia/Shanghai")!),
                       "Resets Thu, Oct 29 at 3:12 PM")
        XCTAssertEqual(RunnerPageFormat.accountWindows(machine, engine: "kimi", account: "gone"), [])
        // Claude's windows keep Claude's words.
        let claude = PlanUsageSnapshot(provider: "claude", fiveHour: PlanUsageWindow(utilization: 1),
                                       sevenDay: PlanUsageWindow(utilization: 2), month: PlanUsageWindow(utilization: 3))
        XCTAssertEqual(claude.rows.map(\.label), ["5-hour limit", "Weekly · all models"])
        // The month that stops the login is what one number for it shows.
        let spentMonth = PlanUsageSnapshot(provider: "kimi", fiveHour: PlanUsageWindow(utilization: 4),
                                           month: PlanUsageWindow(utilization: 97), monthCode: PlanUsageWindow(utilization: 99))
        XCTAssertEqual(spentMonth.bindingRow(at: now)?.label, "Monthly limit")
    }

    /// Add Account is offered where the runner keeps the account it adds apart from Default — it
    /// declares kimi-account-login/v1; an older one would sign Default in again in its place, so its
    /// page reads as it always has: Sign-In, one login, no Add Account.
    func testAddAccountNeedsARunnerThatKeepsKimiAccounts() throws {
        XCTAssertTrue(RunnerPageFormat.keepsAccounts("kimi"))
        let keeps = try hpc([both[0]])
        XCTAssertTrue(RunnerPageFormat.canAddAccount(keeps, engine: "kimi"))
        XCTAssertEqual(RunnerPageFormat.accountsTitle(keeps, engine: "kimi"), "Accounts")
        let older = try runner([kimi(nil)], capabilities: ["kimi-login-region/v1"])
        XCTAssertFalse(RunnerPageFormat.canAddAccount(older, engine: "kimi"))
        XCTAssertEqual(RunnerPageFormat.accountsTitle(older, engine: "kimi"), "Sign-In")
        XCTAssertTrue(RunnerPageFormat.canSignIn(older, engine: "kimi"), "Default still signs in again there")
        // Every other engine is as it was.
        XCTAssertTrue(RunnerPageFormat.canAddAccount(older, engine: "claude"))
        XCTAssertEqual(RunnerPageFormat.accountsTitle(older, engine: "codex"), "Accounts")
        XCTAssertEqual(RunnerPageFormat.accountsTitle(older, engine: "opencode"), "Sign-In")
        XCTAssertFalse(RunnerPageFormat.canAddAccount(keeps, engine: "antigravity"),
                       "Kimi's capability says nothing of Antigravity's")
    }

    /// The sign-in card's Current marks the site of the login it signs in again: the account's own —
    /// Work is on kimi.com while the engine's (Default's) is kimi.ai — and nothing on a card adding an
    /// account, which has no login yet (02-ios ② and ⑫).
    func testTheSignInsCurrentIsTheAccountsOwnSite() throws {
        let machine = try hpc()
        XCTAssertNil(KimiSite.current(on: machine, account: nil, adding: true), "a new account has no site yet")
        XCTAssertEqual(KimiSite.current(on: machine, account: work, adding: false), .mainlandCN)
        XCTAssertEqual(KimiSite.current(on: machine, account: "default", adding: false), .global)
        XCTAssertEqual(KimiSite.current(on: machine, account: nil, adding: false), .global, "the runner's own login")
        XCTAssertNil(KimiSite.current(on: machine, account: "gone", adding: false))
        XCTAssertNil(KimiSite.current(on: try hpc([both[0], (work, "Work", "no", nil)]), account: work, adding: false),
                     "one never signed in has none")
        XCTAssertEqual(KimiSite.site(of: RunnerEngineAccount(id: work, kimiRegion: "global")), .global)
        XCTAssertNil(KimiSite.site(of: RunnerEngineAccount(id: work, kimiRegion: "eu")))
        // The device code step names the site of the account being added.
        XCTAssertEqual(KimiSite.mainlandCN.enterCodeAdding,
                       "Sign in with the kimi.com account you are adding, then enter this one-time code:")
        XCTAssertEqual(KimiSite.global.enterCode,
                       "Sign in with your kimi.ai account there, then enter this one-time code:")
    }

    // MARK: the runner page's row (02-ios ③ ⑪ and its cut-outs)

    /// One account reads as before, with its window now under it; several read like Claude Code: "2
    /// accounts signed in", no site (two accounts can be on different sites), and the window of the
    /// account a new session starts on, named — Default, since Work's 5 hours are past 80%.
    func testTheRunnerRowCountsTheAccountsAndNamesTheNextOne() throws {
        let one = try runner([kimi([both[0]])], planUsage: ["kimi": kimiUsage(defaultUsage)])
        XCTAssertEqual(RunnerPageFormat.engineStatus(try health(one), runner: one),
                       RunnerPageFormat.Status(text: "Signed in", tone: .ok))
        XCTAssertEqual(RunnerPageFormat.engineSite(try health(one)), "kimi.ai")
        XCTAssertNil(RunnerPageFormat.engineNextAccount(one, engine: "kimi", now: now))
        XCTAssertEqual(RunnerPageFormat.engineWindows(one, engine: "kimi", now: now).map(\.label), ["Weekly limit"])

        let two = try hpc()
        XCTAssertEqual(RunnerPageFormat.engineStatus(try health(two), runner: two),
                       RunnerPageFormat.Status(text: "2 accounts signed in", tone: .ok))
        XCTAssertNil(RunnerPageFormat.engineSite(try health(two)))
        XCTAssertEqual(RunnerPageFormat.engineNextAccount(two, engine: "kimi", now: now), "Default")
        XCTAssertEqual(RunnerPageFormat.engineWindows(two, engine: "kimi", now: now).map(\.label), ["Weekly limit"])
        XCTAssertEqual(RunnerPageFormat.engineWindows(two, engine: "kimi", now: now).map(\.percent), [34])

        // Work signed out: the row says so and offers Sign In, and Next is the one still in.
        let workOut = try hpc([both[0], (work, "Work", "no", "mainland-cn")])
        XCTAssertEqual(RunnerPageFormat.engineStatus(try health(workOut), runner: workOut)?.text, "Signed out")
        XCTAssertTrue(RunnerPageFormat.needsSignIn(try health(workOut)))
        XCTAssertEqual(RunnerPageFormat.engineNextAccount(workOut, engine: "kimi", now: now), "Default")
        // Default out instead: Work is next, and the row carries Work's tightest window.
        let defaultOut = try hpc([("default", nil, "no", "global"), both[1]])
        XCTAssertEqual(RunnerPageFormat.engineNextAccount(defaultOut, engine: "kimi", now: now), "Work")
        XCTAssertEqual(RunnerPageFormat.engineWindows(defaultOut, engine: "kimi", now: now).map(\.label), ["5h limit"])
        XCTAssertEqual(RunnerPageFormat.engineWindows(defaultOut, engine: "kimi", now: now).map(\.percent), [91])
    }

    // MARK: NEXT on the engine page (the owner's call on 02-ios ②: all four engines)

    /// The engine page marks the account a new session nobody picked one for starts on, beside its
    /// name — the one the runner page's row names "Next: …" — on every engine that keeps accounts,
    /// and only where there are two or more to choose between (web `AccountName`, `accountToStartOn`).
    func testNextMarksTheAccountANewSessionStartsOnOnEveryEngine() throws {
        let later = "2026-10-12T10:56:00Z", sooner = "2026-10-09T03:00:00Z"
        let claude: [String: Any] = [
            "engine": "claude", "installed": true, "version": "2.1.294", "auth": "yes",
            "accounts": [["id": "default", "auth": "yes", "home": "/root/.claude"],
                         ["id": "a1b2c3d4", "name": "Team", "auth": "yes",
                          "home": "/root/.orbit/claude-accounts/a1b2c3d4"],
                         ["id": "e5f6a7b8", "name": "Side", "auth": "yes",
                          "home": "/root/.orbit/claude-accounts/e5f6a7b8"]],
        ]
        let codex: [String: Any] = [
            "engine": "codex", "installed": true, "version": "0.161.0", "auth": "yes",
            "accounts": [["id": "default", "auth": "yes", "home": "/root/.codex"],
                         ["id": "1fda3f43", "name": "Pro", "auth": "yes", "home": "/root/.orbit/codex-accounts/1fda3f43"]],
        ]
        func bucket(_ id: String, _ left: Double, _ resets: String) -> [String: Any] {
            ["id": id, "window": id.hasSuffix("5h") ? "5h" : "weekly", "remainingFraction": left, "resetTime": resets]
        }
        let antigravity: [String: Any] = [
            "engine": "antigravity", "installed": true, "version": "1.3.1", "auth": "yes", "authSource": "google",
            "accounts": [["id": "default", "auth": "yes", "home": "/root/.orbit/antigravity/google"],
                         ["id": "9f8e7d6c", "name": "Work", "auth": "yes",
                          "home": "/root/.orbit/antigravity-accounts/9f8e7d6c"]],
            "planUsage": ["provider": "antigravity",
                          "buckets": [bucket("gemini-weekly", 1, later), bucket("gemini-5h", 1, "2026-10-08T12:00:00Z")],
                          "accounts": ["9f8e7d6c": ["provider": "antigravity",
                                                    "buckets": [bucket("gemini-weekly", 0.61, sooner),
                                                                bucket("gemini-5h", 0.04, "2026-10-08T11:40:00Z")]]]],
        ]
        let planUsage: [String: Any] = [
            // Claude: the second account's week ends first — it takes the next session.
            "claude": ["provider": "claude",
                       "fiveHour": ["utilization": 6, "resetsAt": "2026-10-08T12:00:00Z"],
                       "sevenDay": ["utilization": 34, "resetsAt": later],
                       "accounts": ["a1b2c3d4": ["provider": "claude",
                                                 "fiveHour": ["utilization": 19, "resetsAt": "2026-10-08T12:00:00Z"],
                                                 "sevenDay": ["utilization": 70, "resetsAt": sooner]],
                                    "e5f6a7b8": ["provider": "claude",
                                                 "sevenDay": ["utilization": 10, "resetsAt": later]]]],
            // Codex: Default's 5 hours are spent — Pro.
            "codex": ["provider": "codex",
                      "primary": ["utilization": 100, "windowDurationMins": 300, "resetsAt": "2026-10-08T12:00:00Z"],
                      "secondary": ["utilization": 18, "windowDurationMins": 10080, "resetsAt": later],
                      "accounts": ["1fda3f43": ["provider": "codex",
                                                "primary": ["utilization": 40, "windowDurationMins": 10080,
                                                            "resetsAt": later]]]],
            "kimi": kimiUsage(defaultUsage, others: [work: workUsage]),
        ]
        let machine = try runner([claude, codex, kimi(both), antigravity], planUsage: planUsage,
                                 capabilities: [loginCapability, "antigravity-account-login/v1"])
        func marked(_ engine: String) throws -> [String] {
            try XCTUnwrap(machine.engines?.first { $0.engine == engine }?.accounts).map(\.id)
                .filter { RunnerPageFormat.marksNext(machine, engine: engine, account: $0, now: now) }
        }
        XCTAssertEqual(try marked("claude"), ["a1b2c3d4"])
        XCTAssertEqual(try marked("codex"), ["1fda3f43"])
        XCTAssertEqual(try marked("antigravity"), ["default"], "Work's 5 hours have 4% left")
        XCTAssertEqual(try marked("kimi"), ["default"], "Work's 5 hours are at 91%")
        // The row's Next names the same account the page marks.
        XCTAssertEqual(RunnerPageFormat.engineNextAccount(machine, engine: "claude", now: now), "Team")
        XCTAssertEqual(RunnerPageFormat.engineNextAccount(machine, engine: "codex", now: now), "Pro")
        XCTAssertEqual(RunnerPageFormat.engineNextAccount(machine, engine: "kimi", now: now), "Default")

        // One account is nothing to choose between: no mark, as on web.
        let single = try runner([kimi([both[0]])], planUsage: ["kimi": kimiUsage(defaultUsage)])
        XCTAssertFalse(RunnerPageFormat.marksNext(single, engine: "kimi", account: "default", now: now))
        let older = try runner([kimi(nil)], capabilities: [])
        XCTAssertFalse(RunnerPageFormat.marksNext(older, engine: "kimi", account: "default", now: now))
        // A signed-out account is never next, and with Default out it passes to Work.
        let defaultOut = try hpc([("default", nil, "no", "global"), both[1]])
        XCTAssertFalse(RunnerPageFormat.marksNext(defaultOut, engine: "kimi", account: "default", now: now))
        XCTAssertTrue(RunnerPageFormat.marksNext(defaultOut, engine: "kimi", account: work, now: now))
        // An engine that keeps no accounts, or one the runner doesn't report, has none.
        XCTAssertFalse(RunnerPageFormat.marksNext(machine, engine: "opencode", account: "default", now: now))
    }

    // MARK: whose quota a session spends

    /// Kimi's month is weighed as the server weighs it (shared `windowsWithLength`, `MONTH_MINS`): its
    /// longest window, so its reset is when what is left of the account goes to waste, and nearly spent
    /// at 90% — and the month's coding share counts too, though no row draws it.
    func testAutomaticWeighsKimisMonthAsItsLongestWindow() throws {
        let accounts = [RunnerEngineAccount(id: "default", auth: "yes"), RunnerEngineAccount(id: work, auth: "yes")]
        func snapshot(defaultMonth: Double, defaultMonthResets: String, workMonthResets: String,
                      defaultMonthCode: Double = 10) -> PlanUsageSnapshot {
            PlanUsageSnapshot(
                provider: "kimi",
                fiveHour: PlanUsageWindow(utilization: 10, resetsAt: "2026-10-08T12:00:00Z"),
                // Default's week ends first: by the weeks alone it would take the session.
                sevenDay: PlanUsageWindow(utilization: 20, resetsAt: "2026-10-10T00:00:00Z"),
                month: PlanUsageWindow(utilization: defaultMonth, resetsAt: defaultMonthResets),
                monthCode: PlanUsageWindow(utilization: defaultMonthCode, resetsAt: defaultMonthResets),
                accounts: [work: PlanUsageSnapshot(
                    provider: "kimi",
                    fiveHour: PlanUsageWindow(utilization: 10, resetsAt: "2026-10-08T12:00:00Z"),
                    sevenDay: PlanUsageWindow(utilization: 20, resetsAt: "2026-10-13T00:00:00Z"),
                    month: PlanUsageWindow(utilization: 30, resetsAt: workMonthResets))])
        }
        // Work's month ends first, and the month is the longest window: Work.
        XCTAssertEqual(CodexAccounts.toStartOn(accounts, usage: snapshot(defaultMonth: 30, defaultMonthResets: "2026-11-01T00:00:00Z",
                                                                         workMonthResets: "2026-10-29T00:00:00Z"), now: now), work)
        XCTAssertEqual(CodexAccounts.toStartOn(accounts, usage: snapshot(defaultMonth: 30, defaultMonthResets: "2026-10-20T00:00:00Z",
                                                                         workMonthResets: "2026-10-29T00:00:00Z"), now: now), "default")
        // Default's month at 90% is nearly spent: it goes after Work however soon it resets.
        XCTAssertEqual(CodexAccounts.toStartOn(accounts, usage: snapshot(defaultMonth: 90, defaultMonthResets: "2026-10-20T00:00:00Z",
                                                                         workMonthResets: "2026-10-29T00:00:00Z"), now: now), work)
        // Its coding share spent holds it back as the server's own pick does.
        XCTAssertEqual(CodexAccounts.toStartOn(accounts, usage: snapshot(defaultMonth: 30, defaultMonthResets: "2026-10-20T00:00:00Z",
                                                                         workMonthResets: "2026-10-29T00:00:00Z",
                                                                         defaultMonthCode: 100), now: now), work)
        let month = PlanUsageSnapshot(provider: "kimi", month: PlanUsageWindow(utilization: 1, resetsAt: "2026-11-01T00:00:00Z"))
        XCTAssertEqual(CodexAccounts.withLength(month).map(\.mins), [CodexAccounts.monthMins])
        XCTAssertEqual(CodexAccounts.windows(month).count, 1, "a Default with only its month read still has its own part")
    }

    /// Automatic is on offer for Kimi where its workspace picked no Kimi account of its own and its env
    /// names no KIMI_CODE_HOME — and no model of its own, which only KIMI_MODEL_NAME and
    /// KIMI_MODEL_API_KEY together are; a session there moves between accounts on a runner that
    /// carries the conversation (kimi-account-move/v1).
    func testKimiAutomaticIsDecidedByItsOwnPickAndEnv() throws {
        let accounts = [RunnerEngineAccount(id: "default", auth: "yes"), RunnerEngineAccount(id: work, auth: "yes")]
        XCTAssertTrue(CodexAccounts.automaticOffered(engine: "kimi", agent: try workspace(), accounts: accounts))
        XCTAssertFalse(CodexAccounts.automaticOffered(engine: "kimi", agent: try workspace(#","kimiAccount":"default""#),
                                                      accounts: accounts))
        XCTAssertTrue(CodexAccounts.automaticOffered(engine: "kimi", agent: try workspace(#","codexAccount":"default""#),
                                                     accounts: accounts), "another engine's pick says nothing of these sessions")
        XCTAssertTrue(CodexAccounts.automaticOffered(engine: "codex", agent: try workspace(#","kimiAccount":"default""#),
                                                     accounts: accounts))
        XCTAssertFalse(CodexAccounts.automaticOffered(engine: "kimi", pick: nil,
                                                      env: ["KIMI_CODE_HOME": "/root/.orbit/kimi-accounts/5c2e91a0"],
                                                      accounts: accounts))
        XCTAssertTrue(CodexAccounts.automaticOffered(engine: "kimi", pick: nil, env: ["KIMI_MODEL_NAME": "kimi-k3"],
                                                     accounts: accounts), "a model alone still runs on the account's login")
        XCTAssertTrue(CodexAccounts.automaticOffered(engine: "kimi", pick: nil, env: ["KIMI_MODEL_API_KEY": "k"],
                                                     accounts: accounts), "and so does a key alone")
        XCTAssertFalse(CodexAccounts.automaticOffered(engine: "kimi", pick: nil,
                                                      env: ["KIMI_MODEL_NAME": "kimi-k3", "KIMI_MODEL_API_KEY": "k"],
                                                      accounts: accounts), "both are a model of its own")
        XCTAssertTrue(CodexAccounts.automaticOffered(engine: "kimi", pick: nil,
                                                     env: ["KIMI_MODEL_NAME": "kimi-k3", "KIMI_MODEL_API_KEY": " "],
                                                     accounts: accounts))
        XCTAssertTrue(CodexAccounts.automaticOffered(engine: "kimi", pick: nil, env: ["CODEX_HOME": "/root/.codex"],
                                                     accounts: accounts))
        XCTAssertFalse(CodexAccounts.automaticOffered(engine: "kimi", agent: try workspace(), accounts: [accounts[0]]))
        XCTAssertEqual(CodexAccounts.workspaceAccount("kimi", of: try workspace(#","kimiAccount":"5c2e91a0","codexAccount":"default""#)),
                       work)
        XCTAssertEqual(CodexAccounts.moveCapability("kimi"), "kimi-account-move/v1",
                       "not Codex's: a Kimi conversation is carried between KIMI_CODE_HOMEs")
        XCTAssertEqual(CodexAccounts.moveCapability("codex"), "codex-account-move/v1")
        XCTAssertEqual(CodexAccounts.moveCapability("claude"), "claude-account-move/v1")
        XCTAssertEqual(CodexAccounts.moveCapability("antigravity"), "antigravity-account-login/v1")
    }

    /// The composer's Provider submenu lists Kimi's accounts under Kimi, each by its own tightest window
    /// (02-ios ⑮: Default Weekly 34%, Work 5h 91%); a signed-out one asks for its sign-in.
    func testThePickerListsKimiAccountsByTheirTightestWindow() throws {
        let machine = try hpc()
        XCTAssertEqual(SessionProviderChoices.choices(configured: [], engines: machine.engines, planUsage: machine.planUsage)
                        .first { $0.slug == "kimi" }?.accounts, [
            AccountChoice(id: "default", label: "Default", quota: "Weekly 34%"),
            AccountChoice(id: work, label: "Work", quota: "5h 91%", nearLimit: true),
        ])
        let workOut = try hpc([both[0], (work, "Work", "no", "mainland-cn")])
        XCTAssertEqual(SessionProviderChoices.choices(configured: [], engines: workOut.engines, planUsage: workOut.planUsage)
                        .first { $0.slug == "kimi" }?.accounts?.last,
                       AccountChoice(id: work, label: "Work", unavailable: "Not signed in"))
        // One account, or a runner too old to list them, lists none.
        let one = try runner([kimi([both[0]])], planUsage: ["kimi": kimiUsage(defaultUsage)])
        XCTAssertNil(SessionProviderChoices.choices(configured: [], engines: one.engines, planUsage: one.planUsage)
                        .first { $0.slug == "kimi" }?.accounts)
        // A month near its end is what the row says.
        let monthly = PlanUsageSnapshot(provider: "kimi", fiveHour: PlanUsageWindow(utilization: 3),
                                        month: PlanUsageWindow(utilization: 95))
        XCTAssertEqual(SessionProviderChoices.quotaText(try XCTUnwrap(monthly.bindingRow())), "Monthly 95%")
    }

    // MARK: Needs Attention

    /// A nearly spent Kimi quota is raised only when every account that can run is near its limit, and
    /// is said in the window's own words.
    func testNeedsAttentionWeighsEveryKimiAccount() throws {
        func quotaItems(_ runner: Runner) throws -> [RunnerAttentionItem] {
            RunnerAttention.runnerAttention(runner: runner, workspaces: [try workspace()],
                                            nowMs: RunnerPageFormat.nowMs(now), latestVersion: nil)
                .filter { $0.kind == .quotaNearLimit }
        }
        XCTAssertEqual(try quotaItems(try hpc()), [], "Default has room, so the machine is not short")
        let workOnly = try hpc([("default", nil, "no", "global"), both[1]])
        let item = try XCTUnwrap(try quotaItems(workOnly).first)
        XCTAssertEqual(item.title, "Kimi 5-hour limit at 91%")
        XCTAssertEqual(item.params["resetsAt"], .string("2026-10-08T10:15:00Z"))
        let month = try runner([kimi([both[0]])], planUsage: ["kimi": kimiUsage(
            usage(fiveHour: 2, fiveHourResets: "2026-10-08T11:40:00Z", week: 30, weekResets: "2026-10-13T01:00:00Z",
                  month: 96, monthResets: "2026-11-01T00:00:00Z", monthCode: 40))])
        XCTAssertEqual(try quotaItems(month).first?.title, "Kimi monthly limit at 96%")
    }

    // MARK: the web's and the server's rules

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        XCTFail("\(relative) was not found above this test file; if it moved, move this check with it.")
        return ""
    }

    /// The gates and keys are the ones web and the server read — Add Account's capability (web
    /// `KIMI_ACCOUNT_LOGIN_CAPABILITY`), the move's (web `ACCOUNT_MOVE_CAPABILITY`), the engines that keep
    /// accounts, the variables that decide a session's account and the month's length (shared
    /// planUsage.ts) — looked up in their source: a missing counterpart is a failure.
    func testTheGatesAndKeysAreTheWebsAndTheServers() throws {
        XCTAssertTrue(try source("src/web/src/lib/engineAccounts.ts")
            .contains("KIMI_ACCOUNT_LOGIN_CAPABILITY = '\(CodexAccounts.kimiAccountLoginCapability)'"))
        XCTAssertTrue(try source("src/web/src/components/WorkspaceView.tsx")
            .contains("kimi: '\(CodexAccounts.moveCapability("kimi"))'"))
        XCTAssertTrue(["claude", "codex", "antigravity", "kimi"].allSatisfy(RunnerPageFormat.keepsAccounts))
        XCTAssertEqual(CodexAccounts.monthMins, 30 * 24 * 60)
        let shared = try source("src/shared/src/planUsage.ts")
        for literal in ["ACCOUNT_ENGINES: readonly AccountEngine[] = ['claude', 'codex', 'antigravity', 'kimi']",
                        "kimi: 'KIMI_CODE_HOME'", "kimi: ['KIMI_MODEL_NAME', 'KIMI_MODEL_API_KEY']",
                        "OWN_CREDENTIAL_NEEDS_ALL: ReadonlySet<string> = new Set(['kimi'])",
                        "const MONTH_MINS = 30 * 24 * 60;", "[snapshot.month, MONTH_MINS]", "[snapshot.monthCode, MONTH_MINS]"] {
            XCTAssertTrue(shared.contains(literal), "@orbit/shared no longer says \(literal)")
        }
    }

    /// The console can't be built on Linux, so its source is read: a Kimi session's own account, its pin
    /// and its workspace's are adopted from the detail; a draft's pick under Kimi rides on the create —
    /// and nothing of Kimi's falls through to Codex's.
    func testTheConsoleCarriesTheKimiAccount() throws {
        let console = try source("src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift")
        for piece in ["case \"kimi\": return draftKimiAccount", "case \"kimi\": return sessionKimiAccount",
                      "case \"kimi\": return sessionKimiAccountPinned", "case \"kimi\": return workspaceKimiAccount",
                      "draftKimiAccount = slug == \"kimi\" ? account : nil",
                      "kimiAccount: provider == \"kimi\" ? draftKimiAccount : nil"] {
            XCTAssertTrue(console.contains(piece), "the console lost \(piece)")
        }
        let adopted = ["sessionKimiAccount = s.kimiAccount", "workspaceKimiAccount = s.agent?.kimiAccount",
                       "sessionKimiAccountPinned = s.kimiAccountPinned ?? false"]
        for piece in adopted {
            XCTAssertEqual(console.components(separatedBy: piece).count - 1, 2,
                           "both detail reads adopt \(piece)")
        }
    }

    // MARK: what a session and its workspace carry

    func testTheSessionAndItsWorkspaceCarryTheirKimiAccount() throws {
        let session = try JSONDecoder().decode(Session.self, from: Data("""
        {"id": "s", "status": "AWAITING_INPUT", "provider": "kimi",
         "kimiAccount": "5c2e91a0", "kimiAccountPinned": true,
         "agent": {"id": "w", "name": "orbit", "kimiAccount": "default"}}
        """.utf8))
        XCTAssertEqual(session.kimiAccount, work)
        XCTAssertEqual(session.kimiAccountPinned, true)
        XCTAssertEqual(session.agent?.kimiAccount, "default")
        XCTAssertNil(session.codexAccount, "not Codex's")
        XCTAssertEqual(session.settingPendingApprovals(1).kimiAccount, work, "an event keeps the detail's account")
        XCTAssertEqual(session.settingPendingApprovals(1).kimiAccountPinned, true)
        XCTAssertEqual(try workspace(#","kimiAccount":"5c2e91a0""#).kimiAccount, work)

        let encoder = JSONEncoder()
        let picked = try JSONSerialization.jsonObject(with: encoder.encode(
            CreateSessionRequest(prompt: "hi", agentId: "w", provider: "kimi", kimiAccount: work))) as? [String: Any]
        XCTAssertEqual(picked?["kimiAccount"] as? String, work)
        XCTAssertNil(picked?["codexAccount"])
        let unpicked = try JSONSerialization.jsonObject(with: encoder.encode(
            CreateSessionRequest(prompt: "hi", agentId: "w", provider: "kimi"))) as? [String: Any]
        XCTAssertNil(unpicked?["kimiAccount"], "no pick is no field: the server decides")
    }
}
