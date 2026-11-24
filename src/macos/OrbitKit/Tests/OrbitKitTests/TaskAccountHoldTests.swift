import Foundation
import XCTest
@testable import OrbitKit

/// Contract §3 (docs/account-health-owner-surface-contract.md): a held task's `accountHold` on the task read,
/// list items and project rows; `route.relaxedRun` on each run; and the row's one line.
final class TaskAccountHoldTests: XCTestCase {
    private let utc = TimeZone(identifier: "UTC")!
    private let holdJSON = """
    {"kind":"ACCOUNT_NEEDS_ACTION","reason":"Cursor said \\"Add a payment method to continue\\". Next try at 13:19",
     "until":"2026-11-22T13:19:00Z",
     "accounts":[{"provider":"cursor","engine":"cursor","line":"Cursor said \\"Add a payment method to continue\\"","until":"2026-11-22T13:19:00Z"}],
     "setting":"orbit-settings:relaxBlockedPins"}
    """

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    func testTheTaskReadAndListItemCarryTheHold() throws {
        let task = try decode(TaskItem.self, #"{"id":"t1","title":"Fix login","status":"OPEN","accountHold":\#(holdJSON),"hold":null}"#)
        XCTAssertEqual(task.accountHold?.kind, "ACCOUNT_NEEDS_ACTION")
        XCTAssertEqual(task.accountHold?.accounts.first?.provider, "cursor")
        XCTAssertEqual(task.accountHold?.setting, "orbit-settings:relaxBlockedPins")
        XCTAssertNil(task.hold)
        let plain = try decode(TaskItem.self, #"{"id":"t2","title":"Other","status":"OPEN"}"#)
        XCTAssertNil(plain.accountHold, "no hold, no line")
    }

    func testAProjectRowCarriesTheHoldAndTheSignInHold() throws {
        let row = try decode(ProjectTaskRow.self, #"{"id":"t1","title":"Fix login","status":"OPEN","accountHold":\#(holdJSON),"hold":{"engine":"claude"}}"#)
        XCTAssertEqual(row.accountHold?.accounts.count, 1)
        XCTAssertNotNil(row.hold)
        XCTAssertFalse(TaskAccountHoldCopy.showsOnRow(row.accountHold, signInHold: row.hold, running: false, queued: false),
                       "the sign-in hold wins")
    }

    func testEachRunCarriesItsRelaxedSentence() throws {
        let sentence = "Pinned to cursor, which can't run now (Cursor refused it); runs on codex instead, on the same engine, at tier M"
        let task = try decode(TaskItem.self, """
        {"id":"t1","title":"Fix","status":"OPEN","sessions":[
          {"id":"s1","route":{"level":"M","provider":"codex","applied":true,"reasons":[],"policyVersion":1,"decidedAt":"","relaxedRun":"\(sentence)"}},
          {"id":"s2","route":{"level":"M","provider":"codex","applied":true,"relaxedRun":null}}]}
        """)
        XCTAssertEqual(task.sessions?.first?.route?.relaxedRun?.hasPrefix("Pinned to cursor"), true)
        XCTAssertNil(task.sessions?.last?.route?.relaxedRun)
    }

    func testTheRowLineNamesTheProvidersWordsAndTheNextTry() throws {
        let hold = try decode(TaskAccountHold.self, holdJSON)
        let now = RelativeTime.parse("2026-11-22T10:00:00Z")!
        XCTAssertEqual(TaskAccountHoldCopy.line(hold, now: now, timeZone: utc),
                       "Held · Cursor said \"Add a payment method to continue\" · Next try 13:19")
        XCTAssertEqual(TaskAccountHoldCopy.accessibilityLine(hold, now: now, timeZone: utc),
                       "Held · Cursor said \"Add a payment method to continue\" · Next try 13:19 · Open account")
        let tomorrow = RelativeTime.parse("2026-11-21T10:00:00Z")!
        XCTAssertTrue(TaskAccountHoldCopy.line(hold, now: tomorrow, timeZone: utc).hasSuffix("Next try Nov 22, 13:19"))
    }

    func testWithNoAccountsTheLineIsTheReason() {
        let hold = TaskAccountHold(reason: "No account can run it now", until: "2026-11-22T13:19:00Z")
        XCTAssertEqual(TaskAccountHoldCopy.line(hold, timeZone: utc), "Held · No account can run it now")
    }

    func testTheLineStandsDownWhileItRunsOrIsQueued() {
        let hold = TaskAccountHold(reason: "r")
        XCTAssertTrue(TaskAccountHoldCopy.showsOnRow(hold, signInHold: nil, running: false, queued: false))
        XCTAssertFalse(TaskAccountHoldCopy.showsOnRow(hold, signInHold: nil, running: true, queued: false))
        XCTAssertFalse(TaskAccountHoldCopy.showsOnRow(hold, signInHold: nil, running: false, queued: true))
        XCTAssertFalse(TaskAccountHoldCopy.showsOnRow(nil, signInHold: nil, running: false, queued: false))
    }

    func testRunElsewhereOpensModelRoutingAtTheSetting() {
        XCTAssertEqual(TaskAccountHoldCopy.relaxPinsURL(base: URL(string: "https://orbit.test")!).absoluteString,
                       "https://orbit.test/settings/providers/routing#relaxBlockedPins")
    }

    // MARK: wiring

    func testTheRowsAndTheTaskViewDrawTheHold() throws {
        let tasks = try source("OrbitApp/Sources/OrbitApp/Views/TasksView.swift")
        XCTAssertTrue(tasks.contains("TaskAccountHoldCopy.showsOnRow(task.accountHold, signInHold: task.hold, running: task.running == true"))
        XCTAssertTrue(tasks.contains("TaskAccountHoldLine(hold: hold)"))
        XCTAssertEqual(tasks.components(separatedBy: "accountHoldLine\n").count - 1, 2, "the Mac row and the compact row")
        XCTAssertTrue(tasks.contains("TaskAccountHoldNote(hold: hold)"))
        XCTAssertTrue(tasks.contains("if let relaxed = session.route?.relaxedRun {\n                    RelaxedRunNote(sentence: relaxed)"))
        let projects = try source("OrbitApp/Sources/OrbitApp/Views/ProjectsView.swift")
        XCTAssertTrue(projects.contains("TaskAccountHoldCopy.showsOnRow(task.accountHold, signInHold: task.hold,"))
        let views = try source("OrbitApp/Sources/OrbitApp/Views/TaskAccountHoldViews.swift")
        XCTAssertTrue(views.contains(".font(.orbitRowNote)") && views.contains("app.openAccounts()"))
        XCTAssertTrue(views.contains("TaskAccountHoldCopy.relaxPinsURL(base: base)"))
        let line = views.components(separatedBy: "struct TaskAccountHoldNote")[0]
        XCTAssertFalse(line.contains("Capsule()"), "the row's line is no chip")
    }

    func testKeyAndPoolRowsDrawTheirBlock() throws {
        let keys = try source("OrbitApp/Sources/OrbitApp/Views/MachinesAndModelsSections.swift")
        XCTAssertTrue(keys.contains("AccountHealth.block(health.blocks, providerID: id)"))
        let pools = try source("OrbitApp/Sources/OrbitApp/Views/ProviderPoolViews.swift")
        XCTAssertTrue(pools.contains("AccountHealth.block(health.blocks, poolID: pool.id, account: login.fingerprint)"))
        XCTAssertEqual(pools.components(separatedBy: "AccountHealth.block(health.blocks, providerID: member.id)").count - 1, 2,
                       "a Claude pool member and a Codex pool's key")
        let settings = try source("OrbitApp/Sources/OrbitApp/Views/SettingsSheet.swift")
        XCTAssertEqual(settings.components(separatedBy: "await model.runners?.loadHealth()").count - 1, 3)
        let machines = try source("OrbitApp/Sources/OrbitApp/Views/SkillsRunnersView.swift")
        XCTAssertTrue(machines.contains("health: AccountHealthRows(runners)"))
        let app = try source("OrbitApp/Sources/OrbitApp/AppModel.swift")
        XCTAssertTrue(app.contains("case .openProviders:"))
    }

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) { return try String(contentsOf: candidate, encoding: .utf8) }
            dir.deleteLastPathComponent()
        }
        throw XCTSkip("\(relative) not found")
    }
}
