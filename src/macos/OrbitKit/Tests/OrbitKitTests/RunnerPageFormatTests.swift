import Foundation
import XCTest
@testable import OrbitKit

/// What the runner list and a runner's pages build out of the rule and the words: the head's status
/// line, a row's slots, an engine's version and sign-in state, each account's own quota, times in the
/// reader's zone — held to the mocks' own lines, on the 09-29 machines they were drawn from (wikova
/// online and busy, the Mac mini offline for two weeks).
final class RunnerPageFormatTests: XCTestCase {

    /// 2026-09-29 00:15 UTC, the moment runnerAttention.cases.json's real runners were read.
    private let now = Date(timeIntervalSince1970: 1_790_640_900)
    /// The owner's time zone — the one the mocks' times are written in.
    private let shanghai = TimeZone(identifier: "Asia/Shanghai")!
    private let utc = TimeZone(identifier: "UTC")!

    private static let wikovaJSON = """
    {"id":"0199a0c4-7a1e-7c3e-9d4f-2a6b8c0d1e2f","name":"wikova","displayName":null,
     "hostname":"vmi3129740","status":"ONLINE","online":true,"version":"0.1.197",
     "lastHeartbeatAt":"2026-09-29T00:14:52Z","enrolledAt":"2026-06-18T02:00:00Z",
     "maxConcurrent":12,"activeSessions":4,"runsAsRoot":true,"minFreeDiskMb":null,
     "reposRoot":"/root/orbit-repos",
     "engines":[
       {"engine":"opencode","installed":true,"version":"1.18.33","auth":"yes"},
       {"engine":"claude","installed":true,"version":"2.1.284 (Claude Code)","auth":"yes",
        "update":{"status":"checked","at":"2026-09-29T00:08:00Z","okAt":"2026-09-29T00:08:00Z",
                  "latest":"2.1.284"}},
       {"engine":"codex","installed":true,"version":"codex-cli 0.158.0","auth":"yes",
        "accounts":[{"id":"default","home":"/root/.codex","auth":"yes"},
                    {"id":"1fda3f43","name":"Work","home":"/root/.orbit/codex-accounts/1fda3f43",
                     "auth":"yes"}]},
       {"engine":"kimi","installed":true,"version":"2.1.1","auth":"yes"}
     ],
     "planUsage":{"provider":"claude",
                  "fiveHour":{"utilization":14,"resetsAt":"2026-09-29T02:59:59Z"},
                  "sevenDay":{"utilization":98,"resetsAt":"2026-10-02T03:59:59Z"},
                  "codex":{"provider":"codex",
                           "primary":{"utilization":20,"windowDurationMins":300},
                           "accounts":{"1fda3f43":{"provider":"codex",
                                                   "primary":{"utilization":91,"windowDurationMins":300}}}}}}
    """

    private static let macMiniJSON = """
    {"id":"0199a0c4-7a1e-7c3e-9d4f-2a6b8c0d1e30","name":"longdeMac-mini.local","displayName":null,
     "hostname":"longdeMac-mini.local","status":"OFFLINE","online":false,"version":"0.1.155",
     "lastHeartbeatAt":"2026-09-14T14:25:09Z","enrolledAt":"2025-11-02T10:00:00Z",
     "maxConcurrent":16,"activeSessions":0,"runsAsRoot":false,"minFreeDiskMb":null,
     "engines":[
       {"engine":"claude","installed":true,"version":"2.1.266 (Claude Code)","auth":"no",
        "update":{"status":"failed","at":"2026-09-13T16:54:10Z","okAt":"2026-09-09T14:38:06Z",
                  "latest":"2.1.270","behindSince":"2026-09-10T14:37:56Z"}},
       {"engine":"codex","installed":false,"auth":"unknown"}
     ],
     "planUsage":null}
    """

    private static let wikovaWorkspacesJSON = """
    [
      {"id":"0199b111-0000-7000-8000-000000000001","name":"orbit","lastProvider":"anthropic-2",
       "runnerId":"0199a0c4-7a1e-7c3e-9d4f-2a6b8c0d1e2f","workDir":"/root/orbit","enableWorktree":true,
       "workDirFreeBytes":"10087419904","workDirTotalBytes":"211157901312"},
      {"id":"0199b111-0000-7000-8000-000000000002","name":"wikova-develop","lastProvider":"claude",
       "runnerId":"0199a0c4-7a1e-7c3e-9d4f-2a6b8c0d1e2f","workDir":"~/wikova-develop",
       "enableWorktree":true,"workDirFreeBytes":"10087419904","workDirTotalBytes":"211157901312"},
      {"id":"0199b111-0000-7000-8000-000000000003","name":"wikova-prod","lastProvider":"deepseek",
       "runnerId":"0199a0c4-7a1e-7c3e-9d4f-2a6b8c0d1e2f","workDir":"~/wikova","enableWorktree":false,
       "workDirFreeBytes":"10087419904","workDirTotalBytes":"211157901312"}
    ]
    """

    private func runner(_ json: String) throws -> Runner {
        try JSONDecoder().decode(Runner.self, from: Data(json.utf8))
    }

    /// The same machine with some of its row replaced, as another moment would report it.
    private func runner(_ json: String, _ changes: [String: Any]) throws -> Runner {
        var object = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        for (key, value) in changes { object[key] = value }
        return try JSONDecoder().decode(Runner.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private func wikova() throws -> Runner { try runner(Self.wikovaJSON) }
    private func macMini() throws -> Runner { try runner(Self.macMiniJSON) }

    private func workspaces() throws -> [Agent] {
        try JSONDecoder().decode([Agent].self, from: Data(Self.wikovaWorkspacesJSON.utf8))
    }

    private func engine(_ runner: Runner, _ name: String) throws -> RunnerEngineHealth {
        try XCTUnwrap(runner.engines?.first { $0.engine == name }, "no \(name) on \(runner.name)")
    }

    // MARK: the list row and the page head

    func testTheHeadAndTheRowSayWhereTheMachineStands() throws {
        let wikova = try wikova()
        XCTAssertEqual(RunnerPageFormat.presence(wikova, now: now), .online)
        XCTAssertEqual(RunnerPageFormat.statusWord(wikova, now: now), "Online")
        XCTAssertEqual(RunnerPageFormat.statusLine(wikova, now: now, timeZone: shanghai), "Online · 4 of 12 running")
        XCTAssertEqual(RunnerPageFormat.hostLine(wikova), "vmi3129740 · v0.1.197")
        let slots = try XCTUnwrap(RunnerPageFormat.slots(wikova, now: now))
        XCTAssertEqual(slots.text, "4/12")
        XCTAssertEqual(slots.fraction, 4.0 / 12.0, accuracy: 0.0001)
        XCTAssertFalse(slots.full)

        let mini = try macMini()
        XCTAssertEqual(RunnerPageFormat.presence(mini, now: now), .offline)
        XCTAssertEqual(RunnerPageFormat.statusWord(mini, now: now), "Offline")
        XCTAssertEqual(RunnerPageFormat.statusLine(mini, now: now, timeZone: shanghai),
                       "Offline · last seen Sep 14, 10:25 PM")
        XCTAssertEqual(RunnerPageFormat.hostLine(mini), "v0.1.155",
                       "a hostname that is the name shown is left out")
        XCTAssertNil(RunnerPageFormat.slots(mini, now: now), "an offline machine draws no count and no bar")

        let neverSeen = try runner(Self.macMiniJSON, ["lastHeartbeatAt": NSNull()])
        XCTAssertEqual(RunnerPageFormat.statusLine(neverSeen, now: now), "Offline")
    }

    func testDrainingAndAFullMachine() throws {
        let draining = try runner(Self.wikovaJSON, ["status": "DRAINING"])
        XCTAssertEqual(RunnerPageFormat.presence(draining, now: now), .draining)

        let full = try runner(Self.wikovaJSON, ["activeSessions": 12])
        XCTAssertEqual(RunnerPageFormat.slots(full, now: now)?.full, true)
        XCTAssertEqual(RunnerPageFormat.slots(full, now: now)?.fraction, 1)

        let noLimit = try runner(Self.wikovaJSON, ["maxConcurrent": 0])
        XCTAssertNil(RunnerPageFormat.slots(noLimit, now: now))
        XCTAssertEqual(RunnerPageFormat.statusLine(noLimit, now: now), "Online")
    }

    func testTheShownNameIsTheAliasAndTheHostnameShowsBesideIt() throws {
        let renamed = try runner(Self.macMiniJSON, ["displayName": "Mac mini"])
        XCTAssertEqual(RunnerPageFormat.displayName(renamed), "Mac mini")
        XCTAssertEqual(RunnerPageFormat.hostLine(renamed), "longdeMac-mini.local · v0.1.155")
        let blankAlias = try runner(Self.macMiniJSON, ["displayName": "  "])
        XCTAssertEqual(RunnerPageFormat.displayName(blankAlias), "longdeMac-mini.local")
    }

    func testTheListLineTakesTheMostSevereItemsColour() throws {
        let wikova = try wikova()
        let items = RunnerAttention.runnerAttention(runner: wikova, workspaces: try workspaces(),
                                                    nowMs: RunnerPageFormat.nowMs(now), latestVersion: "0.1.197")
        XCTAssertEqual(items.map(\.kind), [.quotaNearLimit, .diskLow])
        XCTAssertEqual(RunnerPageFormat.listTone(items), .warn)

        let mini = try macMini()
        let offline = RunnerAttention.runnerAttention(runner: mini, workspaces: [],
                                                      nowMs: RunnerPageFormat.nowMs(now), latestVersion: "0.1.197")
        XCTAssertNil(RunnerPageFormat.listTone(offline), "an offline row has no third line to colour")
    }

    // MARK: Needs Attention

    func testANearlySpentQuotaSaysWhenItResetsInTheReadersZone() throws {
        let items = RunnerAttention.runnerAttention(runner: try wikova(), workspaces: try workspaces(),
                                                    nowMs: RunnerPageFormat.nowMs(now), latestVersion: "0.1.197")
        let quota = try XCTUnwrap(items.first { $0.kind == .quotaNearLimit })
        XCTAssertEqual(quota.title, "Claude weekly limit at 98%")
        XCTAssertEqual(RunnerPageFormat.attentionDetail(quota, now: now, timeZone: shanghai),
                       "Resets Fri, Oct 2 at 11:59 AM. wikova-develop runs on this machine’s Claude login — "
                           + "its sessions pause if the limit runs out.")
        XCTAssertEqual(RunnerPageFormat.attentionNames(quota), ["wikova-develop"])

        let disk = try XCTUnwrap(items.first { $0.kind == .diskLow })
        XCTAssertEqual(RunnerPageFormat.attentionDetail(disk, now: now), disk.detail,
                       "only the quota item leads with a time")
        XCTAssertEqual(RunnerPageFormat.attentionNames(disk), [])
    }

    func testTheUpgradeCommandIsSetApartInItsSentence() throws {
        let items = RunnerAttention.runnerAttention(runner: try macMini(), workspaces: [],
                                                    nowMs: RunnerPageFormat.nowMs(now), latestVersion: "0.1.197")
        XCTAssertEqual(items.map(\.kind), [.offline, .cannotSelfUpdate])
        XCTAssertEqual(RunnerPageFormat.attentionCode(items[1]), ["sudo orbit upgrade"])
        XCTAssertEqual(RunnerPageFormat.attentionCode(items[0]), [])
    }

    // MARK: Capacity

    func testTheDiskIsReadInGBAndTurnsAmberWhenTight() throws {
        let disk = try XCTUnwrap(RunnerAttention.runnerDisk(try workspaces()))
        XCTAssertEqual(RunnerPageFormat.diskUsedLine(disk), "187 of 197 GB used")
        XCTAssertTrue(RunnerPageFormat.diskIsTight(disk, minFreeDiskMb: nil), "95% used")

        let roomy = RunnerDisk(freeBytes: 15 * 1_073_741_824, totalBytes: 30 * 1_073_741_824, usedPercent: 50)
        XCTAssertFalse(RunnerPageFormat.diskIsTight(roomy, minFreeDiskMb: nil))
        XCTAssertFalse(RunnerPageFormat.diskIsTight(roomy, minFreeDiskMb: 10_240))
        XCTAssertTrue(RunnerPageFormat.diskIsTight(roomy, minFreeDiskMb: 20_480), "under the 20 GB it keeps free")
        XCTAssertFalse(RunnerPageFormat.diskIsTight(roomy, minFreeDiskMb: 0), "a zero reserve is none")
    }

    func testKeepFreeOffersItsTiersAndShowsAValueSetElsewhereAsItIs() {
        XCTAssertEqual(RunnerPageFormat.keepFreeChoices(nil).map(\.label), ["Off", "10 GB", "20 GB", "50 GB"])
        XCTAssertEqual(RunnerPageFormat.keepFreeChoices(20_480).map(\.label), ["Off", "10 GB", "20 GB", "50 GB"])
        let odd = RunnerPageFormat.keepFreeChoices(30_000)
        XCTAssertEqual(odd.map(\.label), ["Off", "10 GB", "20 GB", "50 GB", "29 GB"])
        XCTAssertEqual(odd.last?.mb, 30_000)
        XCTAssertNil(RunnerPageFormat.keepFreeValue(0))
        XCTAssertNil(RunnerPageFormat.keepFreeValue(nil))
        XCTAssertEqual(RunnerPageFormat.keepFreeValue(51_200), 51_200)
    }

    // MARK: Engines

    func testEnginesAreListedInThePagesOrder() throws {
        XCTAssertEqual(RunnerPageFormat.engines(try wikova()).map(\.engine), ["claude", "codex", "kimi", "opencode"])
        let extra = try runner(Self.macMiniJSON, ["engines": [["engine": "gemini", "installed": true],
                                                             ["engine": "codex", "installed": false]]])
        XCTAssertEqual(RunnerPageFormat.engines(extra).map(\.engine), ["codex", "gemini"],
                       "an engine the page doesn't know yet comes after the ones it does")
        XCTAssertEqual(RunnerPageFormat.engineName("claude"), "Claude Code")
        XCTAssertEqual(RunnerPageFormat.engineName("kimi"), "Kimi Code")
        XCTAssertEqual(RunnerPageFormat.engineName("opencode"), "OpenCode")
        XCTAssertEqual(RunnerPageFormat.engineName("gemini"), "gemini")
    }

    func testAnEnginesVersionLosesWhatItsCLIPrintedAroundIt() {
        XCTAssertEqual(RunnerPageFormat.engineVersion("2.1.284 (Claude Code)"), "2.1.284")
        XCTAssertEqual(RunnerPageFormat.engineVersion("codex-cli 0.158.0"), "0.158.0")
        XCTAssertEqual(RunnerPageFormat.engineVersion("2.1.1"), "2.1.1")
        XCTAssertEqual(RunnerPageFormat.engineVersion("v1.18.33"), "1.18.33")
        XCTAssertEqual(RunnerPageFormat.engineVersion("nightly-build"), "nightly-build", "nothing to take out")
        XCTAssertNil(RunnerPageFormat.engineVersion("  "))
        XCTAssertNil(RunnerPageFormat.engineVersion(nil))
    }

    func testEachEngineSaysWhereItsSignInsStand() throws {
        let wikova = try wikova()
        XCTAssertEqual(RunnerPageFormat.engineStatus(try engine(wikova, "claude")),
                       RunnerPageFormat.Status(text: "Signed in", tone: .ok))
        XCTAssertEqual(RunnerPageFormat.engineStatus(try engine(wikova, "codex")),
                       RunnerPageFormat.Status(text: "2 accounts signed in", tone: .ok))
        XCTAssertNil(RunnerPageFormat.engineStatus(try engine(wikova, "opencode")),
                     "OpenCode's sign-in is its provider's, so the row says nothing about one")

        let mini = try macMini()
        XCTAssertEqual(RunnerPageFormat.engineStatus(try engine(mini, "claude")),
                       RunnerPageFormat.Status(text: "Signed out", tone: .warn))
        XCTAssertEqual(RunnerPageFormat.engineStatus(try engine(mini, "codex")),
                       RunnerPageFormat.Status(text: "Not installed", tone: .muted))
        XCTAssertTrue(RunnerPageFormat.needsSignIn(try engine(mini, "claude")))
        XCTAssertFalse(RunnerPageFormat.needsSignIn(try engine(mini, "codex")))
        XCTAssertFalse(RunnerPageFormat.needsSignIn(try engine(wikova, "claude")))

        let oneOut = RunnerEngineHealth(engine: "codex", installed: true, auth: "yes",
                                        accounts: [RunnerEngineAccount(id: "default", auth: "yes"),
                                                   RunnerEngineAccount(id: "a1", name: "Work", auth: "no")])
        XCTAssertEqual(RunnerPageFormat.engineStatus(oneOut)?.text, "Signed out",
                       "one account signed out is the engine's to say")
        XCTAssertTrue(RunnerPageFormat.needsSignIn(oneOut))
        let unsure = RunnerEngineHealth(engine: "kimi", installed: true, auth: "unknown")
        XCTAssertNil(RunnerPageFormat.engineStatus(unsure), "a CLI that wouldn't say is neither")
    }

    func testTheRowShowsDefaultsQuotaAndEachAccountHasItsOwn() throws {
        let wikova = try wikova()
        let claude = RunnerPageFormat.engineWindows(wikova, engine: "claude")
        XCTAssertEqual(claude.map(\.label), ["5-hour limit", "Weekly · all models"])
        XCTAssertEqual(claude.map(\.percent), [14, 98])
        XCTAssertEqual(RunnerPageFormat.engineWindows(wikova, engine: "codex"), [],
                       "with two accounts each one's quota is on the engine page")
        XCTAssertEqual(RunnerPageFormat.accountWindows(wikova, engine: "codex", account: "default").map(\.percent),
                       [20])
        XCTAssertEqual(RunnerPageFormat.accountWindows(wikova, engine: "codex", account: "1fda3f43").map(\.percent),
                       [91])
        XCTAssertEqual(RunnerPageFormat.accountWindows(wikova, engine: "codex", account: "gone"), [])
        XCTAssertEqual(RunnerPageFormat.engineWindows(try macMini(), engine: "claude"), [],
                       "a signed-out engine shows no quota")
    }

    func testAFailedUpdateIsTheRowsOnlyOnceItIsAProblem() throws {
        let mini = try macMini()
        XCTAssertEqual(RunnerPageFormat.updateFailedLine(try engine(mini, "claude"), now: now, timeZone: utc),
                       "Update to 2.1.270 failed Sep 13")
        let fresh = RunnerEngineHealth(engine: "claude", installed: true, version: "2.1.284", auth: "yes",
                                       update: RunnerEngineUpdate(status: "failed", at: "2026-09-29T00:00:00Z",
                                                                  okAt: "2026-09-28T12:00:00Z", latest: "2.1.290"))
        XCTAssertNil(RunnerPageFormat.updateFailedLine(fresh, now: now),
                     "a failed pass the updater retries in half an hour is not the row's news")
    }

    func testTheEnginesHeaderSaysWhenItWasChecked() throws {
        XCTAssertEqual(RunnerPageFormat.enginesNote(try wikova(), now: now, timeZone: shanghai), "Checked 7m ago")
        XCTAssertEqual(RunnerPageFormat.enginesNote(try macMini(), now: now, timeZone: shanghai), "Reported Sep 14")
        let unchecked = try runner(Self.wikovaJSON, ["engines": [["engine": "kimi", "installed": true]]])
        XCTAssertNil(RunnerPageFormat.enginesNote(unchecked, now: now))
    }

    func testTheEnginePageListsDefaultAndEachAccountTheRunnerAdded() throws {
        let lines = RunnerPageFormat.accountLines(try engine(try wikova(), "codex"))
        XCTAssertEqual(lines.map(\.name), ["Default", "Work"])
        XCTAssertEqual(lines.map(\.home), ["~/.codex", "~/.orbit/codex-accounts/1fda3f43"])
        XCTAssertEqual(lines.map(\.signInAccount), ["default", "1fda3f43"],
                       "with several, a sign-in names the account it is for")
        XCTAssertEqual(lines.map(\.isDefault), [true, false])

        let single = RunnerPageFormat.accountLines(try engine(try macMini(), "claude"))
        XCTAssertEqual(single.count, 1)
        XCTAssertEqual(single[0].name, "Default")
        XCTAssertEqual(single[0].auth, "no", "the engine's own answer")
        XCTAssertNil(single[0].signInAccount, "and a sign-in for the runner's own login names none")

        let unnamed = RunnerEngineHealth(engine: "claude", installed: true, auth: "yes",
                                         accounts: [RunnerEngineAccount(id: "default", auth: "yes"),
                                                    RunnerEngineAccount(id: "9f00", auth: "yes")])
        XCTAssertEqual(RunnerPageFormat.accountLines(unnamed).map(\.name), ["Default", "Account 9f00"])
    }

    func testARenamedDefaultSaysUnderItsNameThatItIsStillTheMachinesOwnLogin() throws {
        let health = RunnerEngineHealth(engine: "claude", installed: true, auth: "yes", accounts: [
            RunnerEngineAccount(id: "default", name: "jianghailong.main", auth: "yes", home: "/root/.claude"),
            RunnerEngineAccount(id: "29e631a9", name: "jianghailong.orbit", auth: "yes",
                                home: "/root/.orbit/claude-accounts/29e631a9"),
        ])
        let lines = RunnerPageFormat.accountLines(health)
        XCTAssertEqual(lines.map(\.name), ["jianghailong.main", "jianghailong.orbit"])
        XCTAssertEqual(lines.map(\.subtitle), ["~/.claude · Default", "~/.orbit/claude-accounts/29e631a9"])
        XCTAssertEqual(lines.map(\.isDefault), [true, false])

        // Default as it was says nothing more than where it lives.
        let plain = RunnerPageFormat.accountLines(try engine(try wikova(), "codex"))
        XCTAssertEqual(plain.map(\.subtitle), ["~/.codex", "~/.orbit/codex-accounts/1fda3f43"])
    }

    func testARemovalIsTheAccountsItWasAskedFor() {
        let pending = RunnerAccountRemoveState(engine: "codex", account: "1fda3f43", status: "pending", message: nil)
        XCTAssertEqual(RunnerPageFormat.removal(pending, engine: "codex", account: "1fda3f43"),
                       RunnerPageFormat.AccountRemoval(pending: true, refused: nil))
        XCTAssertNil(RunnerPageFormat.removal(pending, engine: "codex", account: "default"))
        XCTAssertNil(RunnerPageFormat.removal(pending, engine: "claude", account: "1fda3f43"))
        let refused = RunnerAccountRemoveState(engine: "codex", account: "1fda3f43", status: "failed",
                                               message: "a session is running on this account")
        XCTAssertEqual(RunnerPageFormat.removal(refused, engine: "codex", account: "1fda3f43")?.refused,
                       "a session is running on this account")
    }

    func testUpdateEnginesNowSaysWhereItGot() {
        let queued = RunnerInstallState(status: "pending", engine: nil, command: nil, message: nil, mode: "update")
        XCTAssertEqual(RunnerPageFormat.updateRelayLine(queued),
                       "Queued — the runner picks this up on its next check-in.")
        XCTAssertTrue(RunnerPageFormat.engineUpdateInFlight(queued))
        let running = RunnerInstallState(status: "installing", engine: nil, command: nil, message: nil, mode: "update")
        XCTAssertEqual(RunnerPageFormat.updateRelayLine(running), "Updating this machine’s engine CLIs…")
        let done = RunnerInstallState(status: "done", engine: nil, command: nil,
                                      message: "claude 2.1.284 → 2.1.290", mode: "update")
        XCTAssertEqual(RunnerPageFormat.updateRelayLine(done), "claude 2.1.284 → 2.1.290")
        XCTAssertFalse(RunnerPageFormat.engineUpdateInFlight(done))
        let quiet = RunnerInstallState(status: "done", engine: nil, command: nil, message: nil, mode: "update")
        XCTAssertEqual(RunnerPageFormat.updateRelayLine(quiet), "Nothing to update.")
        let install = RunnerInstallState(status: "pending", engine: "kimi", command: nil, message: nil, mode: "install")
        XCTAssertNil(RunnerPageFormat.updateRelayLine(install), "an install is not an update")
        XCTAssertFalse(RunnerPageFormat.engineUpdateInFlight(install))
    }

    // MARK: Workspaces

    func testAWorkspaceRowSaysWhereItWorks() throws {
        let rows = try workspaces()
        XCTAssertEqual(rows.map(RunnerPageFormat.workspaceLine),
                       ["~/orbit · Worktrees", "~/wikova-develop · Worktrees", "~/wikova"])
        XCTAssertEqual(RunnerPageFormat.tildePath("/root"), "~")
        XCTAssertEqual(RunnerPageFormat.tildePath("/home/longde/src/app"), "~/src/app")
        XCTAssertEqual(RunnerPageFormat.tildePath("/Users/longde"), "~")
        XCTAssertEqual(RunnerPageFormat.tildePath("/rootless/x"), "/rootless/x")
        XCTAssertEqual(RunnerPageFormat.tildePath("/home/"), "/home/")
        XCTAssertEqual(RunnerPageFormat.tildePath("/srv/orbit"), "/srv/orbit")
    }

    /// The count and the workspace row spell one id two ways — a public id on the row, the stored UUID
    /// where a count came from somewhere that never passed the rewrite — and are still one workspace.
    func testRunningCountsAreMatchedByTheIdItself() throws {
        let rows = try workspaces()
        let uuid = "0199b111-0000-7000-8000-000000000001"
        let counts = [
            WorkspaceSessionCounts(workspaceId: PublicID.toPublic(uuid), active: 5, running: 4, jobs: 0, needsYou: 1),
            WorkspaceSessionCounts(workspaceId: "0199b111-0000-7000-8000-000000000002", active: 1, running: nil,
                                   jobs: nil, needsYou: nil),
        ]
        XCTAssertNotEqual(PublicID.toPublic(uuid), uuid, "the fixture has to spell it the other way")
        XCTAssertEqual(rows.map { RunnerPageFormat.runningCount($0, counts: counts) }, [4, 0, 0])
    }

    // MARK: About This Runner

    func testAboutSaysWhetherTheVersionIsTheLatestOrWhenItWillBe() throws {
        let wikova = try wikova()
        XCTAssertEqual(RunnerPageFormat.versionValue(wikova, latest: "0.1.197"), "0.1.197 · Latest")
        XCTAssertEqual(RunnerPageFormat.versionValue(wikova, latest: "0.1.180"), "0.1.197 · Latest")
        XCTAssertEqual(RunnerPageFormat.versionValue(wikova, latest: "0.1.198"),
                       "0.1.197 · 0.1.198 installs when no turn is running")
        XCTAssertEqual(RunnerPageFormat.versionValue(wikova, latest: nil), "0.1.197")
        XCTAssertEqual(RunnerPageFormat.versionValue(try macMini(), latest: "0.1.197"), "0.1.155",
                       "a runner that can't update itself says so in Needs Attention, not here")
        XCTAssertEqual(RunnerPageFormat.runsAsValue(wikova), "root")
        XCTAssertEqual(RunnerPageFormat.runsAsValue(try macMini()), "regular user")
        XCTAssertNil(RunnerPageFormat.runsAsValue(try runner(Self.wikovaJSON, ["runsAsRoot": NSNull()])))
        XCTAssertEqual(RunnerPageFormat.lastCheckIn(wikova, now: now), "Just now")
        XCTAssertEqual(RunnerPageFormat.lastCheckIn(try macMini(), now: now), "14d ago")
        XCTAssertEqual(RunnerPageFormat.registered(wikova, now: now, timeZone: shanghai), "Jun 18")
        XCTAssertEqual(RunnerPageFormat.registered(try macMini(), now: now, timeZone: shanghai), "Nov 2, 2025")
    }

    // MARK: times

    func testTimesAreTheReadersAndInTheMocksWords() throws {
        XCTAssertEqual(RunnerPageFormat.resetsWhen("2026-09-29T02:59:59Z", now: now, timeZone: shanghai), "10:59 AM")
        XCTAssertEqual(RunnerPageFormat.resetsWhen("2026-10-02T03:59:59Z", now: now, timeZone: shanghai),
                       "Fri, Oct 2 at 11:59 AM")
        XCTAssertEqual(RunnerPageFormat.resetsWhen("2026-09-29T02:59:59Z", now: now, timeZone: utc),
                       "2:59 AM", "the same instant, read where the reader is")
        XCTAssertNil(RunnerPageFormat.resetsWhen("not a time", now: now))
        let row = try XCTUnwrap(RunnerPageFormat.engineWindows(try wikova(), engine: "claude").first)
        XCTAssertEqual(RunnerPageFormat.resetsLine(row, now: now, timeZone: shanghai), "Resets 10:59 AM")
        XCTAssertEqual(RunnerPageFormat.lastSeen("2026-09-14T14:25:09Z", timeZone: shanghai), "Sep 14, 10:25 PM")
        XCTAssertEqual(RunnerPageFormat.day("2026-09-13T16:54:10Z", now: now, timeZone: utc), "Sep 13")
        XCTAssertEqual(RunnerPageFormat.day("2025-12-31T20:00:00Z", now: now, timeZone: utc), "Dec 31, 2025")
    }

    // MARK: Add Runner

    func testTheInstallCommandIsTheInstancesOwn() throws {
        XCTAssertEqual(RunnerPageFormat.origin(try XCTUnwrap(URL(string: "https://orbitd.io"))), "https://orbitd.io")
        XCTAssertEqual(RunnerPageFormat.origin(try XCTUnwrap(URL(string: "https://orbitd.io/"))), "https://orbitd.io")
        XCTAssertEqual(RunnerPageFormat.origin(try XCTUnwrap(URL(string: "http://127.0.0.1:8787/"))),
                       "http://127.0.0.1:8787")
        XCTAssertEqual(RunnerPageFormat.installCommand(.macOS, origin: "https://orbitd.io"),
                       "curl -fsSL https://orbitd.io/install.sh | bash")
        XCTAssertEqual(RunnerPageFormat.installCommand(.linux, origin: "https://orbitd.io"),
                       "curl -fsSL https://orbitd.io/install.sh | bash")
        XCTAssertEqual(RunnerPageFormat.installCommand(.windows, origin: "https://orbitd.io"),
                       "irm https://orbitd.io/install.ps1 | iex")
        XCTAssertEqual(RunnerPageFormat.Platform.allCases.map(\.label), ["macOS", "Linux", "Windows"])
    }

    func testTheDeviceCodeIsReadOnceItIsAllThere() {
        XCTAssertEqual(RunnerPageFormat.deviceCode("ABCDE-FGH23"), "ABCDE-FGH23")
        XCTAssertEqual(RunnerPageFormat.deviceCode(" abcde fgh23 "), "ABCDE-FGH23", "as typed on a phone")
        XCTAssertEqual(RunnerPageFormat.deviceCode("abcdefgh23"), "ABCDE-FGH23", "without its dash")
        XCTAssertNil(RunnerPageFormat.deviceCode("ABCD-1234"), "not all there yet")
        XCTAssertNil(RunnerPageFormat.deviceCode("ABCDE-FGH234"))
        XCTAssertNil(RunnerPageFormat.deviceCode(""))
    }

    func testTheWaitEndsOnTheFirstRunnerThatWasNotOnlineWhenItBegan() throws {
        let wikova = try wikova()
        let mini = try macMini()
        let baseline = RunnerPageFormat.onlineIDs([wikova, mini])
        XCTAssertEqual(baseline, [wikova.id])
        XCTAssertNil(RunnerPageFormat.newlyOnline([wikova, mini], baseline: baseline))
        let fresh = try runner(Self.macMiniJSON, ["id": "0199a0c4-7a1e-7c3e-9d4f-2a6b8c0d1eff", "name": "new-box",
                                                  "online": true, "status": "ONLINE"])
        XCTAssertEqual(RunnerPageFormat.newlyOnline([wikova, mini, fresh], baseline: baseline)?.name, "new-box")
    }
}
