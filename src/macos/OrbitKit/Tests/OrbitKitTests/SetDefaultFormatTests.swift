import Foundation
import XCTest
@testable import OrbitKit

/// Set as default on Claude Code: what the engine page builds from the runner (web
/// RunnerEngines.setDefault.test.tsx / Android SetDefaultPageTest) — who is offered it, why it can't
/// be chosen, the confirmation's words, the waiting line and a failed swap's reason.
final class SetDefaultFormatTests: XCTestCase {

    private static let work = "3fa91c2e"
    private static let defaultAccount: [String: Any] = [
        "id": "default", "home": "/root/.claude", "auth": "yes",
    ]
    private static let workAccount: [String: Any] = [
        "id": work, "name": "Work", "home": "/root/.orbit/claude-accounts/3fa91c2e", "auth": "yes",
    ]

    private func runner(accounts: [[String: Any]] = [defaultAccount, workAccount],
                        capabilities: [String]? = ["claude-account-swap/v1", "claude-account-move/v1"],
                        online: Bool = true,
                        swap: [String: Any]? = nil) throws -> Runner {
        var object: [String: Any] = [
            "id": "0199a0c4-7a1e-7c3e-9d4f-2a6b8c0d1e2f", "name": "wikova", "status": "ONLINE",
            "online": online, "lastHeartbeatAt": "2026-09-29T00:14:52Z",
            "engines": [["engine": "claude", "installed": true, "version": "2.1.284 (Claude Code)",
                         "auth": "yes", "accounts": accounts]],
        ]
        if let capabilities { object["capabilities"] = capabilities }
        if let swap { object["claudeAccountSwap"] = swap }
        return try JSONDecoder().decode(Runner.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private func claude(_ runner: Runner) throws -> RunnerEngineHealth {
        try XCTUnwrap(runner.engines?.first { $0.engine == "claude" })
    }

    private func line(_ runner: Runner, _ id: String) throws -> RunnerPageFormat.AccountLine {
        let health = try claude(runner)
        return try XCTUnwrap(RunnerPageFormat.accountLines(health).first { $0.id == id })
    }

    private func swap(status: String, waiting: Int = 0, terminal: Bool = false,
                      message: String? = nil) -> [String: Any] {
        let waitingOn: [[String: Any]] = waiting < 1 ? [] : (1...waiting).map {
            ["id": "s-\($0)", "title": "Turn \($0)", "status": "RUNNING"]
        }
        return [
            "account": Self.work, "status": status,
            "message": message.map { $0 as Any } ?? NSNull(),
            "waitingOn": waitingOn,
            "foreignProcesses": terminal ? [["pid": 4121, "command": "claude"]] : [],
        ]
    }

    func testAnAddedClaudeAccountIsOfferedSetAsDefault() throws {
        let machine = try runner()
        XCTAssertTrue(RunnerPageFormat.offersSetDefault(try line(machine, Self.work), engine: "claude"))
        XCTAssertFalse(RunnerPageFormat.offersSetDefault(try line(machine, "default"), engine: "claude"))
        XCTAssertFalse(RunnerPageFormat.offersSetDefault(try line(machine, Self.work), engine: "codex"))
    }

    func testItSaysWhyItCantBeChosen() throws {
        let capable = try runner()
        XCTAssertNil(RunnerPageFormat.setDefaultBlocked(capable, offline: false, pressing: false))
        XCTAssertEqual(RunnerPageFormat.setDefaultBlocked(capable, offline: true, pressing: false),
                       RunnerAccountCopy.RUNNER_ACCOUNT_SET_DEFAULT_OFFLINE)
        XCTAssertEqual(RunnerPageFormat.setDefaultBlocked(capable, offline: false, pressing: true),
                       RunnerAccountCopy.RUNNER_ACCOUNT_SET_DEFAULT_BUSY)
        XCTAssertEqual(RunnerPageFormat.setDefaultBlocked(try runner(capabilities: []), offline: false,
                                                          pressing: false),
                       RunnerAccountCopy.RUNNER_ACCOUNT_SET_DEFAULT_UPDATE)
        let pending = try runner(swap: swap(status: "pending"))
        XCTAssertEqual(RunnerPageFormat.setDefaultBlocked(pending, offline: false, pressing: false),
                       RunnerAccountCopy.RUNNER_ACCOUNT_SET_DEFAULT_BUSY)
    }

    func testTheQuestionIsTheWebsWords() throws {
        let machine = try runner()
        let work = try line(machine, Self.work)
        let question = RunnerPageFormat.setDefaultQuestion(work, health: try claude(machine), runner: machine)
        XCTAssertEqual(question.title, "Make Work the default?")
        XCTAssertEqual(question.message,
                       "Work’s login moves to ~/.claude, and Default’s to ~/.orbit/claude-accounts/3fa91c2e. "
                           + "Claude Code in a terminal on wikova uses Work from then on — restart any that are "
                           + "open. Sessions stay on their accounts, and a turn in progress finishes first. "
                           + "Workspaces keep their account.")
    }

    func testTheWaitingLineCountsTheTurnsAndATerminal() throws {
        let none = try runner(swap: swap(status: "pending"))
        XCTAssertEqual(RunnerPageFormat.settingDefaultLine(none, line: try line(none, Self.work)),
                       "Making Work the default")
        let one = try runner(swap: swap(status: "pending", waiting: 1, terminal: true))
        XCTAssertEqual(RunnerPageFormat.settingDefaultLine(one, line: try line(one, Self.work)),
                       "Making Work the default — waiting for 1 session to finish its turn "
                           + RunnerAccountCopy.RUNNER_ACCOUNT_SETTING_DEFAULT_TERMINAL)
        let many = try runner(swap: swap(status: "pending", waiting: 2))
        XCTAssertEqual(RunnerPageFormat.settingDefaultLine(many, line: try line(many, Self.work)),
                       "Making Work the default — waiting for 2 sessions to finish their turns")
        XCTAssertNil(RunnerPageFormat.settingDefaultLine(many, line: try line(many, "default")),
                     "only the account being swapped")
    }

    func testAFailedSwapSaysTheMachinesReasonAndThatNothingChanged() throws {
        let failed = try runner(swap: swap(status: "failed", message: "the Keychain refused the write"))
        let work = try line(failed, Self.work)
        let state = try XCTUnwrap(RunnerPageFormat.failedSwap(failed, line: work))
        XCTAssertEqual(state.message, "the Keychain refused the write")
        XCTAssertNil(RunnerPageFormat.settingDefaultLine(failed, line: work))
        XCTAssertNil(RunnerPageFormat.failedSwap(failed, line: try line(failed, "default")))

        let done = try runner(swap: swap(status: "done"))
        XCTAssertNil(RunnerPageFormat.failedSwap(done, line: try line(done, Self.work)))
        XCTAssertNil(RunnerPageFormat.settingDefaultLine(done, line: try line(done, Self.work)))
    }

    func testTheSwapStateDecodesLeniently() throws {
        let json = """
        {"account":"\(Self.work)","status":"pending","message":null,
         "waitingOn":[{"id":"a","title":"Fix login","status":"RUNNING"},
                      {"title":"no id"},
                      {"id":"b","title":"Old","status":"SOMETHING_NEW"}],
         "foreignProcesses":[{"pid":4121,"command":"claude"},{"command":"no pid"}]}
        """
        let state = try JSONDecoder().decode(RunnerClaudeAccountSwapState.self, from: Data(json.utf8))
        XCTAssertEqual(state.waitingOn.map(\.id), ["a", "b"])
        XCTAssertNil(state.waitingOn[1].status)
        XCTAssertEqual(state.foreignProcesses.map(\.pid), [4121])
    }
}
