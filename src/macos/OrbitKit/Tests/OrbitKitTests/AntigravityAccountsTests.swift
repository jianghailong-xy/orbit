import Foundation
import XCTest
@testable import OrbitKit

/// Antigravity's Google accounts, drawn and weighed the way Claude Code's and Codex's are
/// (docs/mocks/antigravity-accounts): the runner page's row and its roll-up, the engine page's account
/// lines and each one's own quota from the engine health, Add Account's gates, a runner that runs on
/// its own GEMINI_API_KEY, the New Session picker's rows, Automatic, Needs Attention, and what a
/// session and its workspace carry. The machine is the mocks' HPC: Default, and Work added beside it.
final class AntigravityAccountsTests: XCTestCase {
    private let work = "5c2e91a0"
    private let loginCapability = "antigravity-account-login/v1"
    /// 2026-10-06 13:30 in the mocks' Shanghai time: before every reset below.
    private let now = ISO8601DateFormatter().date(from: "2026-10-06T05:30:00Z")!

    /// agy's four buckets, what each has left, and when its weekly and 5-hour ones reset.
    private func buckets(_ left: [Double], weekly: String, fiveHour: String) -> [[String: Any]] {
        zip(["gemini-weekly", "gemini-5h", "3p-weekly", "3p-5h"], left).map { id, left in
            ["id": id, "window": id.hasSuffix("5h") ? "5h" : "weekly", "remainingFraction": left,
             "resetTime": id.hasSuffix("5h") ? fiveHour : weekly]
        }
    }

    /// Default's, as 02-ios-engine-page.png draws them.
    private var defaultBuckets: [[String: Any]] {
        buckets([1, 1, 0.98, 1], weekly: "2026-10-10T17:31:00Z", fiveHour: "2026-10-06T14:28:00Z")
    }

    /// Work's: its 5 hours down to 4%.
    private var workBuckets: [[String: Any]] {
        buckets([0.61, 0.04, 1, 1], weekly: "2026-10-10T00:05:00Z", fiveHour: "2026-10-06T11:40:00Z")
    }

    /// Antigravity as the runner reports it: the engine's own answer, its accounts — Default first —
    /// and each one's buckets: Default's beside every other account's under `accounts`.
    private func engine(auth: String = "yes", authSource: String? = "google",
                        accounts: [(id: String, name: String?, auth: String)],
                        defaultBuckets: [[String: Any]]? = nil,
                        others: [String: [[String: Any]]] = [:]) -> [String: Any] {
        var engine: [String: Any] = ["engine": "antigravity", "installed": true, "version": "1.3.0", "auth": auth]
        if let authSource { engine["authSource"] = authSource }
        engine["accounts"] = accounts.map { account -> [String: Any] in
            var entry: [String: Any] = [
                "id": account.id, "auth": account.auth,
                "home": account.id == "default" ? "/root/.orbit/antigravity/google"
                    : "/root/.orbit/antigravity-accounts/\(account.id)",
            ]
            if let name = account.name { entry["name"] = name }
            return entry
        }
        if defaultBuckets != nil || !others.isEmpty {
            var usage: [String: Any] = ["provider": "antigravity", "fetchedAt": "2026-10-06T05:29:00Z"]
            if let defaultBuckets { usage["buckets"] = defaultBuckets }
            if !others.isEmpty {
                usage["accounts"] = others.mapValues { buckets -> [String: Any] in
                    ["provider": "antigravity", "fetchedAt": "2026-10-06T05:29:00Z", "buckets": buckets]
                }
            }
            engine["planUsage"] = usage
        }
        return engine
    }

    /// The HPC runner, online, its Antigravity reported as `engine` says.
    private func runner(_ engine: [String: Any], googleLogin: String = "available",
                        capabilities: [String]? = nil) throws -> Runner {
        let object: [String: Any] = [
            "id": "r1", "name": "HPC", "online": true, "status": "ONLINE", "version": "0.1.230",
            "lastHeartbeatAt": "2026-10-06T05:29:50Z",
            "capabilities": capabilities ?? [loginCapability, "antigravity-account-remove/v1"],
            "engines": [engine],
            "antigravity": ["supported": true, "installed": true, "version": "1.3.0", "envKeyAvailable": true,
                            "googleLogin": googleLogin] as [String: Any],
        ]
        return try JSONDecoder().decode(Runner.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private func agy(_ runner: Runner) throws -> RunnerEngineHealth {
        try XCTUnwrap(runner.engines?.first { $0.engine == "antigravity" })
    }

    private func workspace() throws -> Agent {
        try JSONDecoder().decode(Agent.self,
                                 from: Data(#"{"id":"w1","name":"orbit-develop","lastProvider":"antigravity"}"#.utf8))
    }

    // MARK: the runner page's row (01-ios-runner-row.png)

    /// ① One Google account reads like Codex: "Signed in", its window closest to its limit on the row,
    /// and nothing in place of Sign In.
    func testOneGoogleAccountIsSignedInWithItsWindowsOnTheRow() throws {
        let hpc = try runner(engine(accounts: [("default", nil, "yes")], defaultBuckets: defaultBuckets))
        let health = try agy(hpc)
        XCTAssertEqual(RunnerPageFormat.engineStatus(health, runner: hpc),
                       RunnerPageFormat.Status(text: "Signed in", tone: .ok))
        XCTAssertFalse(RunnerPageFormat.needsSignIn(health))
        XCTAssertNil(RunnerPageFormat.signInHint(hpc, engine: "antigravity"))
        // The row carries the one closest to its limit — 3p-weekly, at 98% left — and the engine page
        // all four (accountWindows).
        XCTAssertEqual(RunnerPageFormat.engineWindows(hpc, engine: "antigravity").map(\.groupLabel), ["3p-weekly"])
        let rows = RunnerPageFormat.accountWindows(hpc, engine: "antigravity", account: "default")
        XCTAssertEqual(rows.map(\.groupLabel), ["gemini-weekly", "gemini-5h", "3p-weekly", "3p-5h"])
        XCTAssertEqual(rows.map(\.label), ["Weekly", "5-hour", "Weekly", "5-hour"])
        XCTAssertEqual(rows.map(\.percent), [100, 100, 98, 100])
        XCTAssertTrue(rows.allSatisfy(\.remaining), "still what is left, as agy says it")
    }

    /// ③ Several read like Claude Code: "2 accounts signed in", and on the row the window closest to its
    /// limit of the account a new session starts on, named — each account's quota is its own, read from
    /// the engine health, and all of it lives on the engine page.
    func testSeveralGoogleAccountsAreCountedAndEachOnesQuotaIsItsOwn() throws {
        let hpc = try runner(engine(accounts: [("default", nil, "yes"), (work, "Work", "yes")],
                                    defaultBuckets: defaultBuckets, others: [work: workBuckets]))
        XCTAssertEqual(RunnerPageFormat.engineStatus(try agy(hpc), runner: hpc),
                       RunnerPageFormat.Status(text: "2 accounts signed in", tone: .ok))
        // Work's 5 hours are down to 4%, nearly spent: a new session starts on Default.
        XCTAssertEqual(RunnerPageFormat.engineNextAccount(hpc, engine: "antigravity", now: now), "Default")
        XCTAssertEqual(RunnerPageFormat.engineWindows(hpc, engine: "antigravity", now: now).map(\.groupLabel),
                       ["3p-weekly"])
        XCTAssertEqual(RunnerPageFormat.accountWindows(hpc, engine: "antigravity", account: "default").map(\.percent),
                       [100, 100, 98, 100])
        XCTAssertEqual(RunnerPageFormat.accountWindows(hpc, engine: "antigravity", account: work).map(\.percent),
                       [61, 4, 100, 100])
        XCTAssertEqual(RunnerPageFormat.accountWindows(hpc, engine: "antigravity", account: "gone"), [])
    }

    /// ④ Any account signed out is the row's to say, and the usual Sign In with it.
    func testAnAccountSignedOutIsTheRowsToSay() throws {
        let hpc = try runner(engine(accounts: [("default", nil, "yes"), (work, "Work", "no")],
                                    defaultBuckets: defaultBuckets))
        XCTAssertEqual(RunnerPageFormat.engineStatus(try agy(hpc), runner: hpc),
                       RunnerPageFormat.Status(text: "Signed out", tone: .warn))
        XCTAssertTrue(RunnerPageFormat.needsSignIn(try agy(hpc)))
        XCTAssertEqual(RunnerPageFormat.accountWindows(hpc, engine: "antigravity", account: work), [],
                       "a signed-out account has no quota")
        XCTAssertEqual(RunnerPageFormat.engineNextAccount(hpc, engine: "antigravity", now: now), "Default",
                       "a new session still starts on the one that is in, as web's row says")
        XCTAssertEqual(RunnerPageFormat.engineWindows(hpc, engine: "antigravity", now: now).map(\.groupLabel),
                       ["3p-weekly"])

        // Default signed out takes its buckets with it, and the rest are still each one's own.
        let defaultOut = try runner(engine(auth: "no", accounts: [("default", nil, "no"), (work, "Work", "yes")],
                                           others: [work: workBuckets]))
        XCTAssertEqual(RunnerPageFormat.engineStatus(try agy(defaultOut), runner: defaultOut)?.text, "Signed out")
        XCTAssertEqual(RunnerPageFormat.accountWindows(defaultOut, engine: "antigravity", account: "default"), [])
        XCTAssertEqual(RunnerPageFormat.accountWindows(defaultOut, engine: "antigravity", account: work).map(\.percent),
                       [61, 4, 100, 100])
        XCTAssertEqual(RunnerPageFormat.engineNextAccount(defaultOut, engine: "antigravity", now: now), "Work")
        XCTAssertEqual(RunnerPageFormat.engineWindows(defaultOut, engine: "antigravity", now: now).map(\.percent), [4])
    }

    /// A runner that runs agy on its own GEMINI_API_KEY keeps saying "env key": its Default — the
    /// runner's Google sign-in and nothing else — answers no, yet is neither signed out nor short of
    /// quota, so it raises no Sign In and no Needs Attention item.
    func testARunnerOnItsGeminiKeyKeepsSayingEnvKey() throws {
        let keyed = try runner(engine(authSource: "env_key", accounts: [("default", nil, "no")]))
        let health = try agy(keyed)
        XCTAssertEqual(RunnerPageFormat.engineStatus(health, runner: keyed),
                       RunnerPageFormat.Status(text: "env key", tone: .ok))
        XCTAssertFalse(RunnerPageFormat.needsSignIn(health))
        XCTAssertEqual(RunnerPageFormat.engineWindows(keyed, engine: "antigravity"), [])
        let line = try XCTUnwrap(RunnerPageFormat.accountLines(health).first)
        XCTAssertTrue(line.envKey, "its line says what it runs on")
        XCTAssertNil(line.auth, "neither signed in nor out")
        XCTAssertNil(RunnerPageFormat.authStatus(line.auth))
        XCTAssertEqual(line.subtitle, "~/.orbit/antigravity/google")
        let items = RunnerAttention.runnerAttention(runner: keyed, workspaces: [try workspace()],
                                                    nowMs: RunnerPageFormat.nowMs(now), latestVersion: nil)
        XCTAssertFalse(items.contains { $0.kind == .engineSignedOut || $0.kind == .quotaNearLimit })

        // One too old to list its accounts says the same of the engine's own answer.
        let older = RunnerEngineHealth(engine: "antigravity", installed: true, auth: "yes", authSource: "env_key")
        XCTAssertEqual(RunnerPageFormat.engineStatus(older)?.text, "env key")
        XCTAssertEqual(RunnerPageFormat.accountLines(older).map(\.envKey), [true])

        // With a Google account added beside it, the key's Default still counts as in, never as out.
        let both = try runner(engine(authSource: "env_key", accounts: [("default", nil, "no"), (work, "Work", "yes")],
                                     others: [work: workBuckets]))
        XCTAssertEqual(RunnerPageFormat.engineStatus(try agy(both), runner: both)?.text, "2 accounts signed in")
        XCTAssertFalse(RunnerPageFormat.needsSignIn(try agy(both)))
        XCTAssertEqual(RunnerPageFormat.accountLines(try agy(both)).map(\.envKey), [true, false])
        XCTAssertEqual(RunnerPageFormat.accountLines(try agy(both)).map(\.auth), [nil, "yes"])
        // The key has no quota to spend first: a new session starts on Work, and the row says so.
        XCTAssertEqual(RunnerPageFormat.engineNextAccount(both, engine: "antigravity", now: now), "Work")
        XCTAssertEqual(RunnerPageFormat.engineWindows(both, engine: "antigravity", now: now).map(\.groupLabel),
                       ["gemini-5h"])
        let workOut = try runner(engine(authSource: "env_key", accounts: [("default", nil, "no"), (work, "Work", "no")]))
        XCTAssertEqual(RunnerPageFormat.engineStatus(try agy(workOut), runner: workOut)?.text, "Signed out")
        XCTAssertTrue(RunnerPageFormat.needsSignIn(try agy(workOut)), "Work is out, and needs signing in")
    }

    // MARK: the engine page (02-ios-engine-page.png, 03-ios-add-account.png)

    /// Each Google account is a line of the Accounts section, Default first: its name, where its
    /// sign-in lives, its own state — and a sign-in on it names it.
    func testTheEnginePageListsEachGoogleAccount() throws {
        let hpc = try runner(engine(accounts: [("default", nil, "yes"), (work, "Work", "yes")],
                                    defaultBuckets: defaultBuckets, others: [work: workBuckets]))
        let lines = RunnerPageFormat.accountLines(try agy(hpc))
        XCTAssertEqual(lines.map(\.name), ["Default", "Work"])
        XCTAssertEqual(lines.map(\.subtitle), ["~/.orbit/antigravity/google", "~/.orbit/antigravity-accounts/5c2e91a0"])
        XCTAssertEqual(lines.map(\.auth), ["yes", "yes"])
        XCTAssertEqual(lines.map(\.signInAccount), ["default", work])
        XCTAssertEqual(lines.map(\.envKey), [false, false])
        XCTAssertTrue(RunnerPageFormat.keepsAccounts("antigravity"))
        XCTAssertEqual(RunnerPageFormat.defaultAccountName(try XCTUnwrap(try agy(hpc).accounts)), "Account 3")
    }

    /// Add Account is offered where the runner relays Google's sign-in and keeps the account it adds
    /// apart from Default's; a macOS runner, or one too old to sign in with Google, says why instead.
    func testAddAccountNeedsGoogleSignInAndARunnerThatKeepsAccounts() throws {
        let one = engine(accounts: [("default", nil, "yes")], defaultBuckets: defaultBuckets)
        let hpc = try runner(one)
        XCTAssertTrue(RunnerPageFormat.canAddAccount(hpc, engine: "antigravity"))
        XCTAssertTrue(RunnerPageFormat.canSignIn(hpc, engine: "antigravity"))
        let older = try runner(one, capabilities: [])
        XCTAssertFalse(RunnerPageFormat.canAddAccount(older, engine: "antigravity"),
                       "a runner without antigravity-account-login/v1 would sign Default in again in its place")
        XCTAssertTrue(RunnerPageFormat.canSignIn(older, engine: "antigravity"), "Default still signs in again there")
        let mac = try runner(one, googleLogin: "unsupported_platform")
        XCTAssertFalse(RunnerPageFormat.canAddAccount(mac, engine: "antigravity"))
        XCTAssertFalse(RunnerPageFormat.canSignIn(mac, engine: "antigravity"))
        XCTAssertEqual(RunnerPageFormat.signInHint(mac, engine: "antigravity"),
                       "Google sign-in is not supported on macOS runners yet. Use a Gemini API key.")
        XCTAssertEqual(RunnerPageFormat.signInHint(try runner(one, googleLogin: "needs_update"), engine: "antigravity"),
                       "Update this runner to sign in with Google.")
        // Every other engine is as it was.
        XCTAssertTrue(RunnerPageFormat.canAddAccount(mac, engine: "claude"))
        XCTAssertTrue(RunnerPageFormat.canSignIn(mac, engine: "codex"))
        XCTAssertNil(RunnerPageFormat.signInHint(mac, engine: "claude"))
        XCTAssertFalse(RunnerPageFormat.canAddAccount(hpc, engine: "kimi"))
    }

    // MARK: whose quota a session spends

    /// Weighed against other quota, a bucket is the window it names (shared `bucketWindow`): the share
    /// used, its reset, and a length from agy's own name for it — so Default's part of a snapshot that
    /// also holds Work's is there, and Work's nearly spent 5 hours are nearly spent.
    func testABucketIsTheWindowItNames() throws {
        let window = CodexAccounts.bucketWindow(PlanUsageBucket(id: "gemini-5h", window: "5h", remainingFraction: 0.04,
                                                                resetTime: "2026-10-06T11:40:00Z"))
        XCTAssertEqual(window.utilization, 96, accuracy: 0.0001)
        XCTAssertEqual(window.resetsAt, "2026-10-06T11:40:00Z")
        XCTAssertEqual(window.windowDurationMins, 300)
        XCTAssertEqual(CodexAccounts.bucketWindow(PlanUsageBucket(id: "gemini-weekly", window: "weekly",
                                                                  remainingFraction: 1)).windowDurationMins, 10080)
        XCTAssertNil(CodexAccounts.bucketWindow(PlanUsageBucket(id: "x", window: "daily", remainingFraction: 1))
                        .windowDurationMins)
        let usage = try XCTUnwrap(try agy(try runner(engine(
            accounts: [("default", nil, "yes"), (work, "Work", "yes")],
            defaultBuckets: defaultBuckets, others: [work: workBuckets]))).planUsage)
        let own = try XCTUnwrap(CodexAccounts.snapshot(usage, account: "default"))
        XCTAssertEqual(CodexAccounts.windows(own).count, 4)
        XCTAssertNil(own.accounts)
        XCTAssertFalse(CodexAccounts.nearlySpent(own, now: now))
        XCTAssertTrue(CodexAccounts.nearlySpent(try XCTUnwrap(CodexAccounts.snapshot(usage, account: work)), now: now))
    }

    /// A new session with no account picked starts where quota would go to waste first — but not on
    /// an account whose 5 hours are 80% used, nor on one signed out (shared `accountToStartOn`).
    func testAutomaticWeighsGoogleAccountsAsItWeighsEveryOther() throws {
        let accounts = [RunnerEngineAccount(id: "default", auth: "yes"), RunnerEngineAccount(id: work, name: "Work", auth: "yes")]
        func usage(workFiveHourLeft: Double) throws -> PlanUsageSnapshot {
            let theirs = buckets([0.61, workFiveHourLeft, 1, 1], weekly: "2026-10-10T00:05:00Z",
                                 fiveHour: "2026-10-06T11:40:00Z")
            return try XCTUnwrap(try agy(try runner(engine(accounts: [("default", nil, "yes"), (work, "Work", "yes")],
                                                              defaultBuckets: defaultBuckets, others: [work: theirs]))).planUsage)
        }
        // Work's week ends half a day before Default's: it takes the session while its 5 hours have room…
        XCTAssertEqual(CodexAccounts.toStartOn(accounts, usage: try usage(workFiveHourLeft: 0.5), now: now), work)
        // …and not once they are nearly spent.
        XCTAssertEqual(CodexAccounts.toStartOn(accounts, usage: try usage(workFiveHourLeft: 0.04), now: now), "default")
        XCTAssertEqual(CodexAccounts.toStartOn([accounts[0], RunnerEngineAccount(id: work, auth: "no")],
                                               usage: try usage(workFiveHourLeft: 0.5), now: now), "default")
        // Read from the engine health, where Antigravity's quota travels — never the runner's own report.
        let hpc = try runner(engine(accounts: [("default", nil, "yes"), (work, "Work", "yes")],
                                    defaultBuckets: defaultBuckets, others: [work: workBuckets]))
        XCTAssertEqual(CodexAccounts.usage("antigravity", planUsage: hpc.planUsage, engines: hpc.engines),
                       try agy(hpc).planUsage)
        XCTAssertNil(hpc.planUsage?.snapshot(for: "antigravity"))
    }

    /// Automatic is on offer for Antigravity where its workspace picked no Google account of its own
    /// and its env names no account directory and no Gemini key of its own; the console moves a session
    /// between accounts on a runner that keeps them.
    func testAntigravityAutomaticIsDecidedByItsOwnPickAndEnv() throws {
        func agent(_ json: String) throws -> Agent {
            try JSONDecoder().decode(Agent.self, from: Data(#"{"id":"w","name":"orbit"\#(json)}"#.utf8))
        }
        let both = [RunnerEngineAccount(id: "default", auth: "yes"), RunnerEngineAccount(id: work, auth: "yes")]
        XCTAssertTrue(CodexAccounts.automaticOffered(engine: "antigravity", agent: try agent(""), accounts: both))
        XCTAssertFalse(CodexAccounts.automaticOffered(engine: "antigravity", agent: try agent(#","antigravityAccount":"default""#),
                                                      accounts: both))
        XCTAssertTrue(CodexAccounts.automaticOffered(engine: "antigravity", agent: try agent(#","claudeAccount":"default""#),
                                                     accounts: both), "another engine's pick says nothing of these sessions")
        XCTAssertTrue(CodexAccounts.automaticOffered(engine: "claude", agent: try agent(#","antigravityAccount":"default""#),
                                                     accounts: both))
        XCTAssertFalse(CodexAccounts.automaticOffered(engine: "antigravity", agent: try agent(#","env":{"GEMINI_API_KEY":"k"}"#),
                                                      accounts: both))
        XCTAssertFalse(CodexAccounts.automaticOffered(
            engine: "antigravity", pick: nil, env: ["ORBIT_ANTIGRAVITY_GOOGLE_DIR": "/root/.orbit/antigravity-accounts/5c2e91a0"],
            accounts: both))
        XCTAssertTrue(CodexAccounts.automaticOffered(engine: "antigravity", pick: nil, env: ["ANTHROPIC_API_KEY": "k"],
                                                     accounts: both))
        XCTAssertEqual(CodexAccounts.workspaceAccount("antigravity",
                                                      of: try agent(#","antigravityAccount":"5c2e91a0","codexAccount":"default""#)),
                       work)
        XCTAssertEqual(CodexAccounts.moveCapability("antigravity"), loginCapability,
                       "nothing to carry between Google accounts: a runner that keeps them moves a session")
        XCTAssertEqual(CodexAccounts.moveCapability("claude"), "claude-account-move/v1")
        XCTAssertEqual(CodexAccounts.moveCapability("codex"), "codex-account-move/v1")
    }

    /// The New Session picker lists the Google accounts under Antigravity, each by the bucket with the
    /// least left, in agy's own words for it — and a Default that runs on the runner's key by its key.
    func testThePickerListsGoogleAccountsByTheBucketWithTheLeastLeft() throws {
        let hpc = try runner(engine(accounts: [("default", nil, "yes"), (work, "Work", "yes")],
                                    defaultBuckets: defaultBuckets, others: [work: workBuckets]))
        let google = RunnerAntigravityState(supported: true, installed: true, envKeyAvailable: true,
                                            authSource: "google", googleLogin: .available)
        XCTAssertEqual(SessionProviderChoices.choices(configured: [], engines: hpc.engines, antigravity: google)
                        .first { $0.slug == "antigravity" }?.accounts, [
            AccountChoice(id: "default", label: "Default", quota: "3p-weekly 98% left"),
            AccountChoice(id: work, label: "Work", quota: "gemini-5h 4% left", nearLimit: true),
        ])
        let keyed = try runner(engine(authSource: "env_key", accounts: [("default", nil, "no"), (work, "Work", "yes")],
                                      others: [work: workBuckets]))
        let key = RunnerAntigravityState(supported: true, installed: true, envKeyAvailable: true,
                                         authSource: "env_key", googleLogin: .available)
        XCTAssertEqual(SessionProviderChoices.choices(configured: [], engines: keyed.engines, antigravity: key)
                        .first { $0.slug == "antigravity" }?.accounts, [
            AccountChoice(id: "default", label: "Default", quota: "env key"),
            AccountChoice(id: work, label: "Work", quota: "gemini-5h 4% left", nearLimit: true),
        ], "it runs, on the key: not an account that is signed out")
    }

    // MARK: Needs Attention

    /// A nearly spent Antigravity quota is weighed by what it has used, as every other engine's is:
    /// raised only when every account that can run is near its limit — a Default on the machine's
    /// Gemini key has no quota to run out of — and said in the share used, of the window agy names.
    func testNeedsAttentionWeighsGoogleAccountsByWhatTheyHaveUsed() throws {
        func quotaItems(_ runner: Runner) throws -> [RunnerAttentionItem] {
            RunnerAttention.runnerAttention(runner: runner, workspaces: [try workspace()],
                                            nowMs: RunnerPageFormat.nowMs(now), latestVersion: nil)
                .filter { $0.kind == .quotaNearLimit }
        }
        let workOnly = try runner(engine(auth: "no", accounts: [("default", nil, "no"), (work, "Work", "yes")],
                                         others: [work: workBuckets]))
        let item = try XCTUnwrap(try quotaItems(workOnly).first)
        XCTAssertEqual(item.title, "Antigravity 5-hour limit at 96%", "4% left is 96% used")
        XCTAssertEqual(item.short, "Antigravity 5-hour limit 96%")
        XCTAssertEqual(item.params["percent"], .int(96))
        XCTAssertEqual(item.params["resetsAt"], .string("2026-10-06T11:40:00Z"))
        let both = try runner(engine(accounts: [("default", nil, "yes"), (work, "Work", "yes")],
                                     defaultBuckets: defaultBuckets, others: [work: workBuckets]))
        XCTAssertEqual(try quotaItems(both), [], "Default has room, so the machine is not short")
        let keyed = try runner(engine(authSource: "env_key", accounts: [("default", nil, "no"), (work, "Work", "yes")],
                                      others: [work: workBuckets]))
        XCTAssertEqual(try quotaItems(keyed), [], "Default runs on the key, which no window holds back")
    }

    // MARK: what a session and its workspace carry

    func testTheSessionAndItsWorkspaceCarryTheirAntigravityAccount() throws {
        let session = try JSONDecoder().decode(Session.self, from: Data("""
        {"id": "s", "status": "AWAITING_INPUT", "provider": "antigravity",
         "antigravityAccount": "5c2e91a0", "antigravityAccountPinned": true,
         "agent": {"id": "w", "name": "orbit", "antigravityAccount": "default"}}
        """.utf8))
        XCTAssertEqual(session.antigravityAccount, work)
        XCTAssertEqual(session.antigravityAccountPinned, true)
        XCTAssertEqual(session.agent?.antigravityAccount, "default")
        XCTAssertEqual(session.settingPendingApprovals(1).antigravityAccount, work, "an event keeps the detail's account")
        XCTAssertEqual(session.settingPendingApprovals(1).antigravityAccountPinned, true)
        let workspace = try JSONDecoder().decode(Agent.self,
                                                 from: Data(#"{"id":"w","name":"orbit","antigravityAccount":"5c2e91a0"}"#.utf8))
        XCTAssertEqual(workspace.antigravityAccount, work)

        let encoder = JSONEncoder()
        let picked = try JSONSerialization.jsonObject(with: encoder.encode(
            CreateSessionRequest(prompt: "hi", agentId: "w", provider: "antigravity", antigravityAccount: work))) as? [String: Any]
        XCTAssertEqual(picked?["antigravityAccount"] as? String, work)
        XCTAssertNil(picked?["claudeAccount"])
        let unpicked = try JSONSerialization.jsonObject(with: encoder.encode(
            CreateSessionRequest(prompt: "hi", agentId: "w", provider: "antigravity"))) as? [String: Any]
        XCTAssertNil(unpicked?["antigravityAccount"], "no pick is no field: the server decides")
    }
}
