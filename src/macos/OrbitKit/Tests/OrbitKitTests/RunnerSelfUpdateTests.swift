import Foundation
import XCTest
@testable import OrbitKit

/// A runner that reports where its updates of itself stand (`selfUpdate`) gets the card its state
/// calls for, and one too old to report it keeps the card it always had — the web's
/// `RunnerDetailPage.selfUpdate.test.tsx`, at this end.
///
/// The states are `runnerAttention.cases.json`'s own `selfUpdate …` machines, which
/// `RunnerAttentionCasesTests` runs case by case like every other. This holds what the case file
/// cannot carry — each card's sentence, action and params, About's version line and last update, and
/// where Update Runner Now is offered — to the web spec's own expectations, and the app's runner page
/// (which can't compile on Linux) to the presses that use them.
final class RunnerSelfUpdateTests: XCTestCase {

    private static let caseFile = "src/web/src/lib/runnerAttention.cases.json"

    private struct Missing: Error, CustomStringConvertible {
        let description: String
    }

    /// Found by walking up from this file; never a skip, so the check can't go quiet when a file moves.
    private func repoFile(_ relative: String) throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            dir = dir.deletingLastPathComponent()
        }
        throw Missing(description: "\(relative) wasn't found above this test. If it moved, point this check at "
                          + "its new home — don't delete the check.")
    }

    private func source(_ relative: String) throws -> String {
        try String(contentsOf: try repoFile(relative), encoding: .utf8)
    }

    private func caseObjects() throws -> [[String: Any]] {
        let data = try Data(contentsOf: try repoFile(Self.caseFile))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
    }

    /// The input of the one case whose name starts with `prefix`, edited as JSON before it is read.
    private func caseInput(_ prefix: String, _ edit: (inout [String: Any]) -> Void = { _ in }) throws -> [String: Any] {
        let found = try caseObjects().filter { ($0["name"] as? String)?.hasPrefix(prefix) == true }
        guard found.count == 1 else {
            throw Missing(description: "\(Self.caseFile) has \(found.count) cases starting \(prefix.debugDescription)")
        }
        var input = try XCTUnwrap(found[0]["input"] as? [String: Any])
        edit(&input)
        return input
    }

    private func input(_ prefix: String, _ edit: (inout [String: Any]) -> Void = { _ in }) throws -> RunnerAttentionInput {
        try JSONDecoder().decode(RunnerAttentionInput.self,
                                 from: JSONSerialization.data(withJSONObject: try caseInput(prefix, edit)))
    }

    /// That case with its runner's report replaced; nil takes it out, as an older runner sends it.
    private func reporting(_ prefix: String, _ report: [String: Any]?) throws -> RunnerAttentionInput {
        try input(prefix) { input in
            var runner = input["runner"] as? [String: Any] ?? [:]
            if let report { runner["selfUpdate"] = report } else { runner.removeValue(forKey: "selfUpdate") }
            input["runner"] = runner
        }
    }

    /// The case's runner as GET /runners answers it, for the page's own formats.
    private func runner(_ input: [String: Any]) throws -> Runner {
        var runner = try XCTUnwrap(input["runner"] as? [String: Any])
        runner["id"] = "0199a0c4-7a1e-7c3e-9d4f-2a6b8c0d1e31"
        return try JSONDecoder().decode(Runner.self, from: JSONSerialization.data(withJSONObject: runner))
    }

    /// The one card a case raises, offline aside.
    private func card(_ input: RunnerAttentionInput) throws -> RunnerAttentionItem {
        let items = RunnerAttention.runnerAttention(input).filter { $0.kind != .offline }
        guard items.count == 1, let item = items.first else {
            throw Missing(description: "expected one card, got \(items.map(\.title))")
        }
        return item
    }

    // MARK: the state matrix

    /// Every state has a machine behind the latest release in the file both clients run, and so does
    /// a runner too old to report one — so neither end can lose a state without the other noticing.
    func testTheCaseFileHasEveryStateOnARunnerThatIsBehind() throws {
        let names = try caseObjects().compactMap { $0["name"] as? String }
        for state in ["enabled", "disabledByEnv", "dirNotWritable", "waitingForIdle", "failed", "heldByRollout"] {
            XCTAssertTrue(names.contains { $0.hasPrefix("selfUpdate \(state) and behind") }, state)
        }
        XCTAssertTrue(names.contains { $0.hasPrefix("selfUpdate null") }, "a runner too old to report it")
    }

    func testEachStateRaisesTheCardItCallsFor() throws {
        let expected: [(prefix: String, title: String?, action: RunnerAttentionActionKind?)] = [
            ("selfUpdate dirNotWritable and behind", "Install folder isn’t writable", .copyCommand),
            ("selfUpdate disabledByEnv and behind", "Updates are turned off", nil),
            ("selfUpdate failed and behind", "Runner update failed", .updateRunner),
            ("selfUpdate waitingForIdle and behind", nil, nil),
            ("selfUpdate heldByRollout and behind", nil, nil),
            ("selfUpdate enabled and behind", nil, nil),
            ("selfUpdate null", "Can’t update itself", .copyCommand),
        ]
        for (prefix, title, action) in expected {
            let items = RunnerAttention.runnerAttention(try input(prefix))
            XCTAssertEqual(items.map(\.title), title.map { [$0] } ?? [], prefix)
            XCTAssertEqual(items.first?.short, title, prefix)
            XCTAssertEqual(items.first?.kind, title.map { _ in RunnerAttentionKind.cannotSelfUpdate }, prefix)
            XCTAssertEqual(items.first?.action?.kind, action, prefix)
        }
    }

    // MARK: what each card says

    func testDirNotWritableNamesTheFolderAndCopiesTheCommandThatMovesTheInstall() throws {
        let item = try card(try input("selfUpdate dirNotWritable and behind"))
        XCTAssertEqual(item.detail,
                       "It can’t write to /usr/local/bin, so it can’t replace its own binary — still on 0.1.190, "
                           + "latest is 0.1.197. On that machine, run sudo orbit upgrade once; after that it updates itself.")
        XCTAssertEqual(item.action, RunnerAttentionAction(kind: .copyCommand, engine: nil, workspaceId: nil,
                                                          command: "sudo orbit upgrade"))
        XCTAssertEqual(item.params, [
            "version": .string("0.1.190"), "latest": .string("0.1.197"), "state": .string("dirNotWritable"),
            "installDir": .string("/usr/local/bin"),
        ])
        XCTAssertEqual(RunnerPageFormat.attentionCode(item), ["sudo orbit upgrade"], "the command is set in monospace")
        // A runner that didn't say which folder.
        let unsaid = try card(try reporting("selfUpdate dirNotWritable and behind", ["state": "dirNotWritable"]))
        XCTAssertEqual(unsaid.detail,
                       "It can’t write to its install folder, so it can’t replace its own binary — still on 0.1.190, "
                           + "latest is 0.1.197. On that machine, run sudo orbit upgrade once; after that it updates itself.")
    }

    func testDisabledByEnvSaysWhatTurnedItOffAndHowToTurnItBackOn() throws {
        let item = try card(try input("selfUpdate disabledByEnv and behind"))
        XCTAssertEqual(item.detail,
                       "ORBIT_NO_SELFUPDATE is set, so it doesn’t update itself — still on 0.1.190, latest is 0.1.197. "
                           + "To turn them back on, remove ORBIT_NO_SELFUPDATE from the runner’s environment and restart "
                           + "it — on a Mac, opening the latest Orbit app does this.")
        XCTAssertNil(item.action)
        XCTAssertEqual(item.params, [
            "version": .string("0.1.190"), "latest": .string("0.1.197"), "state": .string("disabledByEnv"),
            "reason": .string("ORBIT_NO_SELFUPDATE is set"),
        ])
        // A development build or a platform with no release has no switch: the reason alone.
        func off(_ reason: String?) throws -> String {
            var report: [String: Any] = ["state": "disabledByEnv"]
            if let reason { report["reason"] = reason }
            return try card(try reporting("selfUpdate disabledByEnv and behind", report)).detail
        }
        XCTAssertEqual(try off("development build"),
                       "Development build, so it doesn’t update itself — still on 0.1.190, latest is 0.1.197.")
        XCTAssertEqual(try off("no release is published for linux/riscv64"),
                       "No release is published for linux/riscv64, so it doesn’t update itself — still on 0.1.190, "
                           + "latest is 0.1.197.")
        XCTAssertEqual(try off(nil),
                       "Its updater is switched off, so it doesn’t update itself — still on 0.1.190, latest is 0.1.197.")
    }

    func testFailedGivesTheRunnersOwnWordsAndUpdateRunnerNow() throws {
        let item = try card(try input("selfUpdate failed and behind"))
        XCTAssertEqual(item.detail,
                       "Installing 0.1.197: sha256 mismatch for orbit-linux-amd64.gz. Still on 0.1.190, latest is "
                           + "0.1.197. It retries every 10 min — Update Runner Now tries again right away.")
        XCTAssertEqual(item.action, RunnerAttentionAction(kind: .updateRunner, engine: nil, workspaceId: nil,
                                                          command: nil))
        XCTAssertEqual(item.params, [
            "version": .string("0.1.190"), "latest": .string("0.1.197"), "state": .string("failed"),
            "reason": .string("installing 0.1.197: sha256 mismatch for orbit-linux-amd64.gz"),
        ])
        // Its own full stop is not doubled, and no reason at all still makes a sentence.
        func failed(_ reason: String?) throws -> String {
            var report: [String: Any] = ["state": "failed"]
            if let reason { report["reason"] = reason }
            return try card(try reporting("selfUpdate failed and behind", report)).detail
        }
        XCTAssertEqual(try failed("cannot read the release to install: 502 Bad Gateway."),
                       "Cannot read the release to install: 502 Bad Gateway. Still on 0.1.190, latest is 0.1.197. "
                           + "It retries every 10 min — Update Runner Now tries again right away.")
        XCTAssertEqual(try failed(nil),
                       "Its last update didn’t go through. Still on 0.1.190, latest is 0.1.197. "
                           + "It retries every 10 min — Update Runner Now tries again right away.")
    }

    func testARunnerThatReportsNothingKeepsTheCardItAlwaysHad() throws {
        let absent = try card(try reporting("selfUpdate dirNotWritable and behind", nil))
        let null = try card(try input("selfUpdate null"))
        for item in [absent, null] {
            XCTAssertEqual(item.title, "Can’t update itself")
            XCTAssertEqual(item.detail,
                           "It runs as a regular user, so it can’t replace its own binary — still on 0.1.190, latest "
                               + "is 0.1.197. On that machine, run sudo orbit upgrade.")
            XCTAssertEqual(item.action, RunnerAttentionAction(kind: .copyCommand, engine: nil, workspaceId: nil,
                                                              command: "sudo orbit upgrade"))
            XCTAssertEqual(item.params, ["version": .string("0.1.190"), "latest": .string("0.1.197")])
        }
        // …and a root one still gets none: it installs the release itself.
        let root = try reporting("selfUpdate failed and behind", nil)
        XCTAssertEqual(root.runner.runsAsRoot, true)
        XCTAssertEqual(RunnerAttention.runnerAttention(root), [])
    }

    func testUpdateRunnerNowIsOfferedWhereACheckCanChangeSomethingAndOnlyOnline() throws {
        func can(_ input: RunnerAttentionInput) -> Bool {
            RunnerAttention.runnerCanUpdateNow(input.runner, nowMs: input.nowMs)
        }
        XCTAssertTrue(can(try input("selfUpdate failed and behind")))
        XCTAssertTrue(can(try input("selfUpdate enabled and behind")))
        XCTAssertTrue(can(try input("selfUpdate waitingForIdle and behind")))
        XCTAssertTrue(can(try input("selfUpdate heldByRollout and behind")))
        XCTAssertFalse(can(try input("selfUpdate dirNotWritable and behind")))
        XCTAssertFalse(can(try input("selfUpdate disabledByEnv and behind")))
        XCTAssertFalse(can(try input("selfUpdate failed while offline")))
        XCTAssertFalse(can(try reporting("selfUpdate failed and behind", nil)))
        XCTAssertFalse(can(try input("selfUpdate null")))
    }

    // MARK: About This Runner

    func testAboutsVersionLineSaysWhichStateItIsIn() throws {
        func version(_ prefix: String) throws -> String? {
            RunnerPageFormat.versionValue(try runner(try caseInput(prefix)), latest: "0.1.197")
        }
        XCTAssertEqual(try version("selfUpdate waitingForIdle and behind"),
                       "0.1.190 · 0.1.197 installs when no turn is running")
        XCTAssertEqual(try version("selfUpdate enabled and behind"), "0.1.190 · 0.1.197 installs when no turn is running")
        XCTAssertEqual(try version("selfUpdate heldByRollout and behind"), "0.1.190 · 0.1.197 not rolled out to it yet")
        // A card says the rest; here it is just the version.
        XCTAssertEqual(try version("selfUpdate dirNotWritable and behind"), "0.1.190")
        XCTAssertEqual(try version("selfUpdate disabledByEnv and behind"), "0.1.190")
        XCTAssertEqual(try version("selfUpdate failed and behind"), "0.1.190")
        XCTAssertEqual(try version("selfUpdate dirNotWritable on the latest release"), "0.1.197 · Latest")
        // A runner too old to report it, as before: a regular user is a card's, root installs when idle.
        XCTAssertEqual(try version("selfUpdate null"), "0.1.190")
        let root = try runner(try caseInput("selfUpdate failed and behind") { input in
            var runner = input["runner"] as? [String: Any] ?? [:]
            runner.removeValue(forKey: "selfUpdate")
            input["runner"] = runner
        })
        XCTAssertEqual(RunnerPageFormat.versionValue(root, latest: "0.1.197"),
                       "0.1.190 · 0.1.197 installs when no turn is running")
    }

    func testLastUpdateSaysWhenInTheReadersZoneAndBetweenWhichVersions() throws {
        let shanghai = try XCTUnwrap(TimeZone(identifier: "Asia/Shanghai"))
        XCTAssertEqual(RunnerPageFormat.lastUpdate(try runner(try caseInput("selfUpdate enabled and behind")),
                                                   timeZone: shanghai),
                       "Sep 20, 4:00 PM · 0.1.189 → 0.1.190")
        XCTAssertNil(RunnerPageFormat.lastUpdate(try runner(try caseInput("selfUpdate heldByRollout and behind")),
                                                 timeZone: shanghai),
                     "one that reports but hasn't updated itself yet has no Last Update row")
        XCTAssertNil(RunnerPageFormat.lastUpdate(try runner(try caseInput("selfUpdate null")), timeZone: shanghai))
    }

    // MARK: the wire

    func testTheRunnerListCarriesTheReportAndAnOlderServerDoesNot() throws {
        func decode(_ json: String) throws -> Runner { try JSONDecoder().decode(Runner.self, from: Data(json.utf8)) }
        let reported = try decode(#"""
        {"id":"r1","name":"lab","selfUpdate":{"state":"failed","reason":"installing 0.1.198: timeout",
         "installDir":"/home/lab/.orbit/bin","lastUpdatedAt":"2026-09-20T08:00:00.000Z",
         "lastUpdatedFrom":"0.1.189","lastUpdatedTo":"0.1.190"}}
        """#)
        XCTAssertEqual(reported.selfUpdate?.state, "failed")
        XCTAssertEqual(reported.selfUpdate?.reason, "installing 0.1.198: timeout")
        XCTAssertEqual(reported.selfUpdate?.installDir, "/home/lab/.orbit/bin")
        XCTAssertEqual(reported.selfUpdate?.lastUpdatedAt, "2026-09-20T08:00:00.000Z")
        XCTAssertEqual(reported.selfUpdate?.lastUpdatedFrom, "0.1.189")
        XCTAssertEqual(reported.selfUpdate?.lastUpdatedTo, "0.1.190")
        XCTAssertNil(try decode(#"{"id":"r1","name":"lab"}"#).selfUpdate, "an older server")
        XCTAssertNil(try decode(#"{"id":"r1","name":"lab","selfUpdate":null}"#).selfUpdate, "an older runner")
        // A state a newer control plane adds still decodes — the list must not blank — and raises nothing.
        XCTAssertEqual(try decode(#"{"id":"r1","name":"lab","selfUpdate":{"state":"pausedByOwner"}}"#)
                           .selfUpdate?.state, "pausedByOwner")
        XCTAssertEqual(RunnerAttention.runnerAttention(
            try input("selfUpdate in a state this client doesn’t know")), [])
    }

    // MARK: the app's runner page

    /// From the first `start` through the next `end` after it.
    private func slice(_ text: String, from start: String, to end: String) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`")
        let upper = try XCTUnwrap(text.range(of: end, range: lower.upperBound..<text.endIndex),
                                  "no `\(end)` after `\(start)`")
        return String(text[lower.lowerBound..<upper.upperBound])
    }

    func testTheRunnerPagePressesUpdateRunnerNowAndShowsTheLastUpdate() throws {
        let page = try source("src/macos/OrbitApp/Sources/OrbitApp/Views/SkillsRunnersView.swift")
        let actions = try slice(page, from: "private func attentionButton(", to: "private func diskRow(")
        XCTAssertTrue(actions.contains("case .updateRunner:\n            Button(RunnerPageCopy.RUNNER_UPDATE_RUNNER_NOW) { updateRunner() }"),
                      "a failed update's card presses Update Runner Now")
        let about = try slice(page, from: "private func aboutSection(", to: "private var rotateSection: some View {")
        var from = about.startIndex
        for piece in ["aboutRow(RunnerPageCopy.RUNNER_ABOUT_VERSION,",
                      "aboutRow(RunnerPageCopy.RUNNER_ABOUT_LAST_UPDATE, RunnerPageFormat.lastUpdate(runner))",
                      "if RunnerAttention.runnerCanUpdateNow(runner, nowMs: RunnerPageFormat.nowMs(now)) {",
                      "Button(RunnerPageCopy.RUNNER_UPDATE_RUNNER_NOW) { updateRunner() }",
                      "aboutRow(RunnerPageCopy.RUNNER_ABOUT_RUNS_AS,"] {
            let found = try XCTUnwrap(about.range(of: piece, range: from..<about.endIndex),
                                      "About: `\(piece)` is missing or out of order")
            from = found.upperBound
        }
        let press = try slice(page, from: "private func updateRunner() {", to: "private func repair(")
        XCTAssertTrue(press.contains("show(await runners.updateRunner(id) ?? RunnerPageCopy.RUNNER_UPDATE_RUNNER_REQUESTED)"))
        let model = try source("src/macos/OrbitApp/Sources/OrbitApp/RunnersModel.swift")
        XCTAssertTrue(model.contains("await press { _ = try await self.api.requestRunnerSelfUpdate(id) }"))
        let api = try source("src/macos/OrbitKit/Sources/OrbitKit/Net/APIClient.swift")
        XCTAssertTrue(api.contains(#"try await postEmpty("runners/\(id)/self-update")"#))
    }
}
