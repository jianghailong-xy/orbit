import Foundation
import XCTest
@testable import OrbitKit

/// A runner's Default removed from Orbit, on its engine page and its runner page — the web's cases
/// (RunnerEngines.removeDefault.test.tsx) on what iOS and macOS build the page from. Default offers
/// Remove while another account of the engine stays, asks first in the web's words, and works with the
/// runner offline. Once it is removed the accounts that remain are listed, the only one too, each with
/// its own sign-in and windows, and they end with Default's line and Use again; what sums the engine up
/// speaks for them alone; and removing an added account then never sends its workspaces to Default.
final class RunnerDefaultRemovedTests: XCTestCase {

    /// 2026-09-29 00:15 UTC.
    private let now = Date(timeIntervalSince1970: 1_790_640_900)

    private static let work = "3fa91c2e"
    private static let personal = "7c21de40"

    private static let defaultAccount: [String: Any] = [
        "id": "default", "home": "/root/.codex", "auth": "yes", "fingerprintPrefix": "cxa1_2b7e9013",
    ]
    private static let workAccount: [String: Any] = [
        "id": work, "name": "Work", "home": "/root/.orbit/codex-accounts/3fa91c2e", "auth": "yes",
        "fingerprintPrefix": "cxa1_9f3a41c7",
    ]
    private static let personalAccount: [String: Any] = [
        "id": personal, "name": "Personal", "home": "/root/.orbit/codex-accounts/7c21de40", "auth": "yes",
        "fingerprintPrefix": "cxa1_4d5c8b26",
    ]

    /// What each account has used of its 5-hour window.
    private static let used: [String: Double] = ["default": 62, work: 8, personal: 30]

    private static func id(_ account: [String: Any]) -> String { account["id"] as? String ?? "" }

    private static func signedOut(_ account: [String: Any]) -> [String: Any] {
        account.merging(["auth": "no"]) { $1 }
    }

    /// One login's Codex snapshot: a 5-hour window with `used` percent of it gone.
    private static func window(_ used: Double) -> [String: Any] {
        ["provider": "codex", "primary": ["utilization": used, "windowDurationMins": 300]]
    }

    /// wikova with Codex as `codex` and the Codex quota `usage`, with some of its row replaced.
    private func runner(codex: [String: Any], usage: [String: Any], _ changes: [String: Any] = [:]) throws -> Runner {
        var object: [String: Any] = [
            "id": "0199a0c4-7a1e-7c3e-9d4f-2a6b8c0d1e2f", "name": "wikova", "status": "ONLINE", "online": true,
            "lastHeartbeatAt": "2026-09-29T00:14:52Z",
            "engines": [["engine": "claude", "installed": true, "version": "2.1.284 (Claude Code)", "auth": "yes"],
                        codex.merging(["engine": "codex", "installed": true, "version": "codex-cli 0.158.0"]) { $1 }],
            "planUsage": ["codex": usage],
        ]
        for (key, value) in changes { object[key] = value }
        return try JSONDecoder().decode(Runner.self, from: JSONSerialization.data(withJSONObject: object))
    }

    /// Codex as the runner reports it: Default first, beside `others`, Default's window the snapshot's own.
    private func withDefault(_ others: [[String: Any]], _ changes: [String: Any] = [:]) throws -> Runner {
        var usage = Self.window(Self.used["default"]!)
        usage["accounts"] = Dictionary(uniqueKeysWithValues: others.map { (Self.id($0), Self.window(Self.used[Self.id($0)]!)) })
        return try runner(codex: ["auth": "yes", "accounts": [Self.defaultAccount] + others], usage: usage, changes)
    }

    /// Codex as the control plane serves it with Default removed (usedRunnerEngines): the accounts that
    /// remain, the marker, the engine's sign-in the first signed in's, and Default's windows gone from its
    /// quota — one remaining account's becoming the snapshot's own.
    private func removed(_ remaining: [[String: Any]], name: String? = nil,
                         _ changes: [String: Any] = [:]) throws -> Runner {
        var marker: [String: Any] = ["home": "/root/.codex", "fingerprintPrefix": "cxa1_2b7e9013"]
        if let name { marker["name"] = name }
        var usage: [String: Any] = remaining.count == 1 ? Self.window(Self.used[Self.id(remaining[0])]!) : ["provider": "codex"]
        usage["accounts"] = Dictionary(uniqueKeysWithValues: remaining.map { (Self.id($0), Self.window(Self.used[Self.id($0)]!)) })
        let auth = (remaining.first { $0["auth"] as? String == "yes" } ?? remaining[0])["auth"] ?? "unknown"
        return try runner(codex: ["auth": auth, "accounts": remaining, "removedDefault": marker], usage: usage, changes)
    }

    private func codex(_ runner: Runner) throws -> RunnerEngineHealth {
        try XCTUnwrap(runner.engines?.first { $0.engine == "codex" })
    }

    private func lines(_ runner: Runner, engine: String = "codex") throws -> [RunnerPageFormat.AccountLine] {
        let health = try XCTUnwrap(runner.engines?.first { $0.engine == engine })
        return RunnerPageFormat.accountLines(health, usage: CodexAccounts.usage(engine, planUsage: runner.planUsage,
                                                                               engines: runner.engines))
    }

    private func line(_ runner: Runner, _ id: String) throws -> RunnerPageFormat.AccountLine {
        try XCTUnwrap(try lines(runner).first { $0.id == id }, "no line \(id)")
    }

    private func removing(_ account: String, status: String) -> [String: Any] {
        ["accountRemove": ["engine": "codex", "account": account, "status": status]]
    }

    // MARK: the marker

    func testTheServedMarkerIsRead() throws {
        let health = try codex(try removed([Self.workAccount], name: "jianghailong.main"))
        XCTAssertEqual(health.removedDefault, RunnerRemovedDefault(home: "/root/.codex", name: "jianghailong.main",
                                                                  fingerprintPrefix: "cxa1_2b7e9013"))
        XCTAssertNil(try codex(try withDefault([Self.workAccount])).removedDefault)
    }

    // MARK: Remove on Default

    func testDefaultOffersRemoveWhileAnotherAccountOfTheEngineIsOnTheRunner() throws {
        let runner = try withDefault([Self.workAccount])
        let health = try codex(runner)
        XCTAssertEqual(try lines(runner).map(\.id), ["default", Self.work])
        XCTAssertTrue(RunnerPageFormat.offersRemove(try line(runner, "default"), health: health, runner: runner))
        XCTAssertTrue(RunnerPageFormat.offersRemove(try line(runner, Self.work), health: health, runner: runner))
    }

    func testDefaultOffersNoRemoveWhenItIsTheOnlyAccount() throws {
        let machines = [try runner(codex: ["auth": "yes", "accounts": [Self.defaultAccount]], usage: Self.window(62)),
                        // An older runner that lists no accounts: the one line is Default's.
                        try runner(codex: ["auth": "yes"], usage: Self.window(62))]
        for machine in machines {
            let only = try XCTUnwrap(try lines(machine).first)
            XCTAssertEqual(try lines(machine).count, 1)
            XCTAssertTrue(only.isDefault)
            XCTAssertFalse(RunnerPageFormat.offersRemove(only, health: try codex(machine), runner: machine))
        }
    }

    func testAnAccountOnItsWayOffTheMachineDoesNotCount() throws {
        for status in ["pending", "done"] {
            let runner = try withDefault([Self.workAccount], removing(Self.work, status: status))
            XCTAssertFalse(RunnerPageFormat.offersRemove(try line(runner, "default"), health: try codex(runner), runner: runner),
                           "Work \(status)")
        }
        // A refused removal leaves the account where it was.
        let refused = try withDefault([Self.workAccount], removing(Self.work, status: "failed"))
        XCTAssertTrue(RunnerPageFormat.offersRemove(try line(refused, "default"), health: try codex(refused), runner: refused))
        // Another account stays.
        let two = try withDefault([Self.workAccount, Self.personalAccount], removing(Self.work, status: "pending"))
        XCTAssertTrue(RunnerPageFormat.offersRemove(try line(two, "default"), health: try codex(two), runner: two))
    }

    func testDefaultsRemoveWorksOfflineWhereAnAddedAccountsDoesNot() throws {
        let runner = try withDefault([Self.workAccount])
        XCTAssertTrue(RunnerPageFormat.canRemove(try line(runner, "default"), offline: true), "nothing goes to the machine")
        XCTAssertFalse(RunnerPageFormat.canRemove(try line(runner, Self.work), offline: true), "the runner deletes its sign-in")
        XCTAssertTrue(RunnerPageFormat.canRemove(try line(runner, "default"), offline: false))
        XCTAssertTrue(RunnerPageFormat.canRemove(try line(runner, Self.work), offline: false))
    }

    func testItAsksFirstSayingTheMachineKeepsItsSignIn() throws {
        let runner = try withDefault([Self.workAccount, Self.personalAccount])
        let question = RunnerPageFormat.removalQuestion(try line(runner, "default"), health: try codex(runner), runner: runner)
        XCTAssertEqual(question.title, "Remove Default?")
        XCTAssertEqual(question.message, "Orbit stops using it on wikova. Its sign-in stays on the machine, and Codex "
                           + "in a terminal there keeps working. Workspaces set to it run on Automatic.")
        // The runner by the name the page shows it by.
        let aliased = try withDefault([Self.workAccount], ["displayName": "Studio"])
        XCTAssertTrue(RunnerPageFormat.removalQuestion(try line(aliased, "default"), health: try codex(aliased), runner: aliased)
            .message.hasPrefix("Orbit stops using it on Studio."))
    }

    func testItNamesARenamedDefaultAndTheCLIOfItsOwnEngine() throws {
        let runner = try JSONDecoder().decode(Runner.self, from: Data("""
        {"id": "0199a0c4-7a1e-7c3e-9d4f-2a6b8c0d1e2f", "name": "wikova", "online": true,
         "engines": [{"engine": "claude", "installed": true, "auth": "yes",
                      "accounts": [{"id": "default", "name": "jianghailong.main", "home": "/root/.claude", "auth": "yes"},
                                   {"id": "a1b2c3d4", "name": "Work", "home": "/root/.orbit/claude-accounts/a1b2c3d4",
                                    "auth": "yes"}]}]}
        """.utf8))
        let health = try XCTUnwrap(runner.engines?.first)
        let own = try XCTUnwrap(try lines(runner, engine: "claude").first)
        XCTAssertTrue(RunnerPageFormat.offersRemove(own, health: health, runner: runner))
        let question = RunnerPageFormat.removalQuestion(own, health: health, runner: runner)
        XCTAssertEqual(question.title, "Remove jianghailong.main?")
        XCTAssertTrue(question.message.contains("and Claude Code in a terminal there keeps working."), question.message)
    }

    // MARK: the removed state

    func testItListsTheTwoAccountsThatRemainEachWithItsOwnSignInAndWindowsThenDefaultsLine() throws {
        let runner = try removed([Self.workAccount, Self.signedOut(Self.personalAccount)])
        let health = try codex(runner)
        let rows = try lines(runner)
        XCTAssertEqual(rows.map(\.id), [Self.work, Self.personal])
        XCTAssertEqual(rows.map(\.name), ["Work", "Personal"])
        XCTAssertEqual(rows.map(\.auth), ["yes", "no"])
        XCTAssertEqual(rows.map(\.home), ["~/.orbit/codex-accounts/3fa91c2e", "~/.orbit/codex-accounts/7c21de40"])
        XCTAssertEqual(rows.map(\.signInAccount), [Self.work, Self.personal], "each signs in as itself")
        XCTAssertEqual(RunnerPageFormat.accountWindows(runner, engine: "codex", account: Self.work).map(\.window.utilization), [8])
        XCTAssertEqual(RunnerPageFormat.removedDefaultLine(health), "Default · ~/.codex isn’t used by Orbit")
        // Each remaining account still has its own Remove.
        XCTAssertTrue(rows.allSatisfy { RunnerPageFormat.offersRemove($0, health: health, runner: runner) })
    }

    func testOneRemainingAccountIsALineOfItsOwnNeverTheEnginesOrDefaults() throws {
        let runner = try removed([Self.signedOut(Self.workAccount)])
        let health = try codex(runner)
        let only = try XCTUnwrap(try lines(runner).first)
        XCTAssertEqual(try lines(runner).count, 1)
        XCTAssertEqual(only.id, Self.work)
        XCTAssertEqual(only.name, "Work")
        XCTAssertEqual(only.home, "~/.orbit/codex-accounts/3fa91c2e")
        XCTAssertEqual(only.auth, "no")
        XCTAssertEqual(only.signInAccount, Self.work, "its Sign In is its own account's, by id")
        XCTAssertEqual(RunnerPageFormat.signedOutNote(only, alone: true, engine: "codex"),
                       "Sessions on this runner can’t use Codex until you sign in again.")
        XCTAssertEqual(RunnerPageFormat.removedDefaultLine(health), "Default · ~/.codex isn’t used by Orbit")
    }

    func testItNamesARenamedDefaultByItsNameOnItsLine() throws {
        let health = try codex(try removed([Self.workAccount, Self.personalAccount], name: "jianghailong.main"))
        XCTAssertEqual(RunnerPageFormat.removedDefaultName(health), "jianghailong.main")
        XCTAssertEqual(RunnerPageFormat.removedDefaultLine(health), "jianghailong.main · ~/.codex isn’t used by Orbit")
    }

    func testWithDefaultInUseThereIsNoLine() throws {
        let health = try codex(try withDefault([Self.workAccount]))
        XCTAssertNil(RunnerPageFormat.removedDefaultLine(health))
        XCTAssertNil(RunnerPageFormat.removedDefaultName(health))
    }

    // MARK: Automatic and what sums the engine up

    func testAutomaticStartsTheNextSessionOnARemainingAccountTheOnlyOneToo() throws {
        let one = try removed([Self.workAccount])
        XCTAssertTrue(RunnerPageFormat.marksNext(one, engine: "codex", account: Self.work, now: now))
        // The runner page's row names it, with its own window, and calls the engine signed in by it.
        XCTAssertEqual(RunnerPageFormat.engineNextAccount(one, engine: "codex", now: now), "Work")
        XCTAssertEqual(RunnerPageFormat.engineWindows(one, engine: "codex", now: now).map(\.window.utilization), [8])
        XCTAssertEqual(RunnerPageFormat.engineStatus(try codex(one), runner: one)?.text, "Signed in")

        let two = try removed([Self.workAccount, Self.personalAccount])
        XCTAssertTrue(RunnerPageFormat.marksNext(two, engine: "codex", account: Self.work, now: now))
        XCTAssertFalse(RunnerPageFormat.marksNext(two, engine: "codex", account: Self.personal, now: now))
        XCTAssertFalse(RunnerPageFormat.marksNext(two, engine: "codex", account: "default", now: now))
        XCTAssertEqual(RunnerPageFormat.engineNextAccount(two, engine: "codex", now: now), "Work")
        XCTAssertEqual(RunnerPageFormat.engineWindows(two, engine: "codex", now: now).map(\.window.utilization), [8],
                       "never Default's 62%")
        XCTAssertEqual(RunnerPageFormat.engineStatus(try codex(two), runner: two)?.text, "2 accounts signed in")
    }

    func testARemainingAccountSignedOutShowsNoWindowOnTheRunnersRow() throws {
        let runner = try removed([Self.signedOut(Self.workAccount)])
        XCTAssertTrue(RunnerPageFormat.marksNext(runner, engine: "codex", account: Self.work, now: now),
                      "a session waits on its sign-in")
        XCTAssertEqual(RunnerPageFormat.engineWindows(runner, engine: "codex", now: now), [])
        XCTAssertNil(RunnerPageFormat.engineNextAccount(runner, engine: "codex", now: now))
        XCTAssertEqual(RunnerPageFormat.engineStatus(try codex(runner), runner: runner)?.text, "Signed out")
        XCTAssertTrue(RunnerPageFormat.needsSignIn(try codex(runner)))
    }

    // MARK: removing an added account while Default is removed

    func testItSaysItsWorkspacesRunOnAutomaticNotOnDefault() throws {
        let runner = try removed([Self.workAccount, Self.personalAccount])
        let question = RunnerPageFormat.removalQuestion(try line(runner, Self.personal), health: try codex(runner),
                                                        runner: runner)
        XCTAssertEqual(question.title, "Remove Personal?")
        XCTAssertEqual(question.message, "Its sign-in is deleted from wikova. Workspaces set to this account run on Automatic.")
    }

    func testItSaysOrbitGoesBackToDefaultWhenItIsTheLastAccountOrbitUsesThere() throws {
        let runner = try removed([Self.workAccount], name: "jianghailong.main")
        let question = RunnerPageFormat.removalQuestion(try line(runner, Self.work), health: try codex(runner), runner: runner)
        XCTAssertEqual(question.title, "Remove Work?")
        XCTAssertEqual(question.message, "Its sign-in is deleted from wikova. Without it, Orbit uses jianghailong.main there "
                           + "again, and workspaces set to this account run on it.")
        // The other one on its way off the machine leaves this one the last.
        let leaving = try removed([Self.workAccount, Self.personalAccount], removing(Self.personal, status: "pending"))
        XCTAssertTrue(RunnerPageFormat.removalQuestion(try line(leaving, Self.work), health: try codex(leaving), runner: leaving)
            .message.contains("Without it, Orbit uses Default there again"))
    }

    func testNoRemovalQuestionWhileDefaultIsRemovedSaysRunOnDefault() throws {
        for machine in [try removed([Self.workAccount, Self.personalAccount]), try removed([Self.workAccount])] {
            for account in try lines(machine) {
                let question = RunnerPageFormat.removalQuestion(account, health: try codex(machine), runner: machine)
                XCTAssertFalse(question.message.contains("run on Default"), question.message)
                XCTAssertFalse(question.message.contains("Default is untouched"), question.message)
            }
        }
    }

    func testWithDefaultInUseAnAddedAccountsQuestionIsThePagesOwn() throws {
        let runner = try withDefault([Self.workAccount])
        let question = RunnerPageFormat.removalQuestion(try line(runner, Self.work), health: try codex(runner), runner: runner)
        XCTAssertEqual(question.title, "Remove “Work” from wikova?")
        XCTAssertEqual(question.message, "~/.orbit/codex-accounts/3fa91c2e goes from this machine, and sessions stop running "
                           + "on it. Default is untouched.")
    }
}
