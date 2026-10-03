import Foundation
import XCTest
@testable import OrbitKit

/// The web's runner-attention rule, run case by case against this port.
///
/// `runnerAttention.cases.json` is the one statement of what the Runners list, a runner page's Needs
/// Attention cards and the web card say about a machine, and when. The web's own spec
/// (`runnerAttention.test.ts`) runs every case in it against `runnerAttention.ts`; this runs the same
/// file against `RunnerAttention`, so the two ends cannot disagree about a case without one of the
/// two suites going red. A rule change starts in the case file and lands at both ends or neither.
///
/// What the file cannot carry — the detail sentences, params and actions — is checked below it, with
/// the web spec's own expectations.
final class RunnerAttentionCasesTests: XCTestCase {

    private static let caseFile = "src/web/src/lib/runnerAttention.cases.json"

    private enum CaseFileError: Error, CustomStringConvertible {
        case missing
        case noCase(String)

        var description: String {
            switch self {
            case .missing:
                return "\(RunnerAttentionCasesTests.caseFile) was not found above this test file. It "
                    + "is the one source of the runner-attention rule both clients run; if the web "
                    + "moved it, move this check with it rather than deleting it."
            case .noCase(let name):
                return "\(RunnerAttentionCasesTests.caseFile) has no case named \(name.debugDescription)"
            }
        }
    }

    private struct AttentionCase: Decodable {
        let name: String
        let input: RunnerAttentionInput
        let expected: Expected
    }

    private struct Expected: Decodable {
        let items: [ExpectedItem]
        let listLine: String?
        let subtitle: String
        let disk: RunnerDisk?
    }

    private struct ExpectedItem: Decodable, Equatable {
        let kind: String
        let tone: String
        let short: String
        let title: String
        let actionKind: String?
    }

    /// The case file's bytes. Deliberately a failure and never an `XCTSkip` when it is not found: a
    /// check that quietly opts out reports green on exactly the day the thing it watches went missing.
    private func caseFileData() throws -> Data {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(Self.caseFile)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try Data(contentsOf: candidate)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw CaseFileError.missing
    }

    private func cases() throws -> [AttentionCase] {
        try JSONDecoder().decode([AttentionCase].self, from: caseFileData())
    }

    /// One case's input, edited as JSON before it is read — the web spec's `{ ...input, … }`.
    private func input(_ name: String,
                       _ edit: (inout [String: Any]) -> Void = { _ in }) throws -> RunnerAttentionInput {
        let all = try XCTUnwrap(JSONSerialization.jsonObject(with: caseFileData()) as? [[String: Any]])
        guard let found = all.first(where: { $0["name"] as? String == name }) else {
            throw CaseFileError.noCase(name)
        }
        var input = try XCTUnwrap(found["input"] as? [String: Any])
        edit(&input)
        return try JSONDecoder().decode(RunnerAttentionInput.self,
                                        from: JSONSerialization.data(withJSONObject: input))
    }

    private func items(_ name: String) throws -> [RunnerAttentionItem] {
        RunnerAttention.runnerAttention(try input(name))
    }

    // MARK: the case file

    func testEveryCaseSaysWhatTheWebRuleSays() throws {
        let all = try cases()
        XCTAssertFalse(all.isEmpty, "the case file holds no cases — a run over nothing proves nothing")
        for c in all {
            let items = RunnerAttention.runnerAttention(c.input)
            XCTAssertEqual(items.map {
                ExpectedItem(kind: $0.kind.rawValue, tone: $0.tone.rawValue, short: $0.short,
                             title: $0.title, actionKind: $0.action?.kind.rawValue)
            }, c.expected.items, c.name)
            XCTAssertEqual(RunnerAttention.listAttentionLine(items), c.expected.listLine, c.name)
            XCTAssertEqual(RunnerAttention.runnerListSubtitle(c.input.runner, nowMs: c.input.nowMs),
                           c.expected.subtitle, c.name)
            XCTAssertEqual(RunnerAttention.runnerDisk(c.input.workspaces), c.expected.disk, c.name)
        }
    }

    /// So a failure at either end points at one case.
    func testTheCaseFileNamesEveryCaseOnce() throws {
        let names = try cases().map(\.name)
        XCTAssertEqual(Set(names).count, names.count)
    }

    func testNoListLineForItemsThatSayTheRunnerIsOffline() throws {
        let offline = try XCTUnwrap(try items("offline for 5 hours").first)
        let online = try items("everything at once: most severe first, and the list line shows the first two")
        XCTAssertEqual(offline.kind, .offline)
        XCTAssertEqual(RunnerAttention.listAttentionLine(online),
                       "Claude signed out · app checkout stuck in a rebase")
        XCTAssertNil(RunnerAttention.listAttentionLine([offline] + online))
        XCTAssertNil(RunnerAttention.listAttentionLine(online + [offline]))
        XCTAssertNil(RunnerAttention.listAttentionLine([offline]))
    }

    // MARK: what an item says beyond the case file

    func testMultiAccountQuotaKeepsTheAvailableAccountsOwnWindowAndReset() throws {
        let quota = try XCTUnwrap(try items(
            "all Claude accounts near their limits: the account with most room supplies its own fullest window"
        ).first)
        XCTAssertEqual(quota.params, [
            "engine": .string("claude"), "window": .string("5-hour limit"), "percent": .int(94),
            "resetsAt": .string("2026-09-29T03:00:00Z"), "workspaces": .array([.string("app")]),
        ])
    }

    func testWikovasQuotaNamesTheWorkspaceThatSpendsItAndKeepsTheResetTimeRaw() throws {
        let found = try items("real wikova: Claude weekly 98% and a 95% full disk")
        guard found.count == 2 else { return XCTFail("expected a quota and a disk item, got \(found)") }
        let (quota, disk) = (found[0], found[1])
        XCTAssertEqual(quota.detail,
                       "wikova-develop runs on this machine’s Claude login — its sessions pause if the limit runs out.")
        XCTAssertNil(quota.action)
        XCTAssertEqual(quota.params, [
            "engine": .string("claude"), "window": .string("weekly limit"), "percent": .int(98),
            "resetsAt": .string("2026-10-02T03:59:59Z"), "workspaces": .array([.string("wikova-develop")]),
        ])
        XCTAssertEqual(disk.detail,
                       "9.4 GB free of 197 GB. No reserve is set, so task runs keep landing here until the disk fills.")
        XCTAssertEqual(disk.action, RunnerAttentionAction(kind: .setReserve, engine: nil, workspaceId: nil,
                                                          command: nil))
        XCTAssertEqual(disk.params, [
            "freeBytes": .int(10_087_419_904), "totalBytes": .int(211_157_901_312),
            "usedPercent": .int(95), "reserveMb": .null,
        ])
    }

    func testTheMacMiniSaysHowToWakeItAndTheCommandThatUpdatesIt() throws {
        let found = try items(
            "real longdeMac-mini.local: offline 14 days and can’t update itself; its failing Claude update is not raised while offline")
        guard found.count == 2 else { return XCTFail("expected offline and can’t-update items, got \(found)") }
        let (offline, cannotUpdate) = (found[0], found[1])
        XCTAssertEqual(offline.detail, "Start the runner on that machine — it reconnects within 30 seconds.")
        XCTAssertNil(offline.action)
        XCTAssertEqual(offline.params, ["lastSeenAt": .string("2026-09-14T14:25:09Z"), "sessions": .int(0)])
        XCTAssertEqual(cannotUpdate.detail,
                       "It runs as a regular user, so it can’t replace its own binary — still on 0.1.155, "
                           + "latest is 0.1.197. On that machine, run sudo orbit upgrade.")
        XCTAssertEqual(cannotUpdate.action, RunnerAttentionAction(kind: .copyCommand, engine: nil,
                                                                  workspaceId: nil,
                                                                  command: "sudo orbit upgrade"))
        XCTAssertEqual(cannotUpdate.params, ["version": .string("0.1.155"), "latest": .string("0.1.197")])
    }

    func testAnOfflineRunnerCountsTheSessionsWaitingOnIt() throws {
        func detail(_ activeSessions: Int) throws -> String? {
            let edited = try input("offline for 5 hours") { input in
                var runner = input["runner"] as? [String: Any] ?? [:]
                runner["activeSessions"] = activeSessions
                input["runner"] = runner
            }
            return RunnerAttention.runnerAttention(edited).first?.detail
        }
        XCTAssertEqual(try detail(1),
                       "Its 1 session waits until it checks in again. Start the runner on that machine — it reconnects within 30 seconds.")
        XCTAssertEqual(try detail(3),
                       "Its 3 sessions wait until it checks in again. Start the runner on that machine — it reconnects within 30 seconds.")
    }

    func testASignedOutLoginNamesEveryWorkspaceItStopsAndOffersThatEnginesSignIn() throws {
        func on(_ names: String...) throws -> RunnerAttentionItem {
            let edited = try input("Claude signed out and a workspace runs on claude: raised") { input in
                input["workspaces"] = names.map { ["id": "ws-\($0)", "name": $0, "lastProvider": "claude"] }
            }
            return try XCTUnwrap(RunnerAttention.runnerAttention(edited).first)
        }
        XCTAssertEqual(try on("app").detail,
                       "app runs on this machine’s Claude login — its sessions fail until you sign in again.")
        XCTAssertEqual(try on("app", "docs").detail,
                       "app and docs run on this machine’s Claude login — their sessions fail until you sign in again.")
        XCTAssertEqual(try on("app", "docs", "site").detail,
                       "app and 2 more run on this machine’s Claude login — their sessions fail until you sign in again.")
        XCTAssertEqual(try on("app").action, RunnerAttentionAction(kind: .signIn, engine: "claude",
                                                                   workspaceId: nil, command: nil))
        XCTAssertEqual(try on("app", "docs").params,
                       ["engine": .string("claude"), "workspaces": .array([.string("app"), .string("docs")])])
    }

    func testAStuckCheckoutRepairsThroughTheFirstWorkspaceInIt() throws {
        let orbit = try XCTUnwrap(
            try items("two workspaces in one stuck checkout are one item, named after the first").first)
        XCTAssertEqual(orbit.detail,
                       "Nothing can merge into it until it’s cleaned up. Repair saves everything it holds to an "
                           + "orbit/rescue-… branch, then returns it to its last commit.")
        XCTAssertEqual(orbit.action, RunnerAttentionAction(kind: .repair, engine: nil, workspaceId: "ws-orbit",
                                                           command: nil))
        XCTAssertEqual(orbit.params, [
            "workspaceId": .string("ws-orbit"),
            "workspaces": .array([.string("orbit"), .string("orbit-docs")]),
            "root": .string("/srv/orbit"), "state": .string("merge"), "branch": .null,
        ])
    }

    func testADiskUnderKeepFreeSaysSo() throws {
        let disk = try XCTUnwrap(
            try items("Keep Free 50 GB and 40 GB free: raised, though 20% of the disk is free").first)
        XCTAssertEqual(disk.detail,
                       "40 GB free of 200 GB, under the 50 GB it keeps free — task runs stop being sent here until space frees up.")
        XCTAssertEqual(disk.params["reserveMb"], JSONValue.int(51_200))
    }

    func testAnEngineThatStoppedUpdatingSaysHowFarBehindItIsAndUpdatesThatEngine() throws {
        let claude = try XCTUnwrap(
            try items("Claude Code 12 days behind: raised, whether or not a workspace runs on it").first)
        XCTAssertEqual(claude.detail,
                       "12d behind 2.1.290. Orbit retries every 30 min — Update Engines Now tries again right away.")
        XCTAssertEqual(claude.action, RunnerAttentionAction(kind: .updateEngines, engine: "claude",
                                                            workspaceId: nil, command: nil))
        XCTAssertEqual(claude.params, ["engine": .string("claude"), "note": .string("12d behind 2.1.290"),
                                       "latest": .string("2.1.290")])
        let opencode = try XCTUnwrap(try items("OpenCode never updated: raised under its own name").first)
        XCTAssertEqual(opencode.detail,
                       "Never updated. Orbit retries every 30 min — Update Engines Now tries again right away.")
    }

    /// Antigravity is reported like OpenCode — installed, versioned, updated by the same pass — so
    /// the same case with agy in OpenCode's place raises it under its own CLI name. And never as signed
    /// out, though a workspace runs on it: agy's key comes from its environment, not a sign-in.
    func testAntigravityNeverUpdatedIsRaisedUnderItsOwnNameAndNeverAsSignedOut() throws {
        let agy = try input("OpenCode never updated: raised under its own name") { input in
            guard var runner = input["runner"] as? [String: Any],
                  var engines = runner["engines"] as? [[String: Any]] else { return }
            for index in engines.indices where engines[index]["engine"] as? String == "opencode" {
                engines[index]["engine"] = "antigravity"
                engines[index]["auth"] = "no"
            }
            runner["engines"] = engines
            input["runner"] = runner
            input["workspaces"] = [["id": "ws-agy", "name": "agy", "lastProvider": "antigravity"]]
        }
        let found = RunnerAttention.runnerAttention(agy)
        XCTAssertEqual(found.map(\.title), ["Antigravity CLI update failed"])
        XCTAssertEqual(found.first?.action, RunnerAttentionAction(kind: .updateEngines, engine: "antigravity",
                                                                  workspaceId: nil, command: nil))
    }

    // MARK: disk, Keep Free and versions

    private func workspaces(_ json: String) throws -> [RunnerAttentionWorkspace] {
        try JSONDecoder().decode([RunnerAttentionWorkspace].self, from: Data(json.utf8))
    }

    func testRunnerDiskReadsTheByteCountsTheAPISendsAsStringsAndPlainNumbers() throws {
        let disk = RunnerAttention.runnerDisk(try workspaces(
            #"[{"id":"a","name":"a","workDirFreeBytes":"1073741824","workDirTotalBytes":10737418240}]"#))
        XCTAssertEqual(disk, RunnerDisk(freeBytes: 1_073_741_824, totalBytes: 10_737_418_240, usedPercent: 90))
    }

    func testRunnerDiskIgnoresReadingsItCannotTrust() throws {
        XCTAssertNil(RunnerAttention.runnerDisk([RunnerAttentionWorkspace]()))
        XCTAssertNil(RunnerAttention.runnerDisk(try workspaces("""
        [{"id":"a","name":"a","workDirFreeBytes":"abc","workDirTotalBytes":"100"},
         {"id":"b","name":"b","workDirFreeBytes":"-5","workDirTotalBytes":"100"},
         {"id":"c","name":"c","workDirFreeBytes":"1.5","workDirTotalBytes":"100"}]
        """)))
        XCTAssertNil(RunnerAttention.runnerDisk(try workspaces("""
        [{"id":"a","name":"a","workDirFreeBytes":0,"workDirTotalBytes":0},
         {"id":"b","name":"b","workDirFreeBytes":null,"workDirTotalBytes":"100"},
         {"id":"c","name":"c","workDirFreeBytes":"5","workDirTotalBytes":null}]
        """)))
    }

    func testRunnerDiskNeverReportsMoreThanAHundredPercentUsed() throws {
        let disk = RunnerAttention.runnerDisk(try workspaces(
            #"[{"id":"a","name":"a","workDirFreeBytes":0,"workDirTotalBytes":3}]"#))
        XCTAssertEqual(disk?.usedPercent, 100)
    }

    func testFormatDiskGbCountsBinaryGigabytesWholeFromTenAndOneDecimalBelow() {
        let gib = 1_073_741_824.0
        XCTAssertEqual(RunnerAttention.formatDiskGb(211_157_901_312), "197")
        XCTAssertEqual(RunnerAttention.formatDiskGb(10_087_419_904), "9.4")
        XCTAssertEqual(RunnerAttention.formatDiskGb(Int64(10 * gib)), "10")
        XCTAssertEqual(RunnerAttention.formatDiskGb(Int64(gib)), "1.0")
        XCTAssertEqual(RunnerAttention.formatDiskGb(0), "0.0")
        XCTAssertEqual(RunnerAttention.formatDiskGb(Int64((9.94 * gib).rounded())), "9.9")
        XCTAssertEqual(RunnerAttention.formatDiskGb(Int64((10.5 * gib).rounded())), "11")
        // A value that rounds up to 10 is written the way 10 GB and more are.
        XCTAssertEqual(RunnerAttention.formatDiskGb(Int64((9.96 * gib).rounded())), "10")
    }

    func testKeepFreeOffersOffAndThreeTiersAndShowsAnyOtherFloorAsItIs() {
        XCTAssertEqual(RunnerAttention.KEEP_FREE_TIERS, [
            RunnerKeepFreeTier(mb: nil, label: "Off"),
            RunnerKeepFreeTier(mb: 10_240, label: "10 GB"),
            RunnerKeepFreeTier(mb: 20_480, label: "20 GB"),
            RunnerKeepFreeTier(mb: 51_200, label: "50 GB"),
        ])
        XCTAssertEqual(RunnerAttention.keepFreeLabel(nil), "Off")
        XCTAssertEqual(RunnerAttention.keepFreeLabel(0), "Off")
        XCTAssertEqual(RunnerAttention.keepFreeLabel(20_480), "20 GB")
        XCTAssertEqual(RunnerAttention.keepFreeLabel(15_000), "15 GB")
        XCTAssertEqual(RunnerAttention.keepFreeLabel(5_000), "4.9 GB")
    }

    func testRunnerVersionsCompareSegmentBySegmentAsNumbers() {
        XCTAssertEqual(RunnerAttention.compareRunnerVersions("0.1.197", "0.1.155"), 1)
        XCTAssertEqual(RunnerAttention.compareRunnerVersions("0.1.155", "0.1.197"), -1)
        XCTAssertEqual(RunnerAttention.compareRunnerVersions("0.1.100", "0.1.99"), 1)
        XCTAssertEqual(RunnerAttention.compareRunnerVersions("0.2", "0.1.300"), 1)
        XCTAssertEqual(RunnerAttention.compareRunnerVersions("0.1.197", "0.1.197"), 0)
        XCTAssertEqual(RunnerAttention.compareRunnerVersions("1.0", "1.0.0"), 0)
        XCTAssertEqual(RunnerAttention.compareRunnerVersions("v0.1.197", "0.1.197"), 0)
    }

    func testTheLatestVersionIsThePublishedReleaseOrWhatTheFleetRunsWhicheverIsNewer() {
        let fleet: [String?] = ["0.1.197", "0.1.194", "0.1.155", nil]
        XCTAssertEqual(RunnerAttention.latestRunnerVersion("0.1.197", versions: fleet), "0.1.197")
        XCTAssertEqual(RunnerAttention.latestRunnerVersion(nil, versions: fleet), "0.1.197")
        XCTAssertEqual(RunnerAttention.latestRunnerVersion("0.1.198", versions: fleet), "0.1.198")
        XCTAssertEqual(RunnerAttention.latestRunnerVersion("0.1.190", versions: ["0.1.194"]), "0.1.194")
        XCTAssertNil(RunnerAttention.latestRunnerVersion(nil, versions: []))
        XCTAssertNil(RunnerAttention.latestRunnerVersion("", versions: [nil]))
    }
}
