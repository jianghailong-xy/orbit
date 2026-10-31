import Foundation
import XCTest
@testable import OrbitKit

/// The top of the Infrastructure page on iOS and macOS — what needs a person — held to the cases the web
/// had for the same block until it dropped it (src/web/src/pages/InfrastructurePage.overview.test.tsx):
/// the same three machines and pool, and the same lines out of them. Then a key's row, a machine's row in
/// the list (03-ios.png), and what an engine's page offers to install.
final class InfrastructureTests: XCTestCase {

    // MARK: - The mock's account, as the web's cases have it

    private static let now = RelativeTime.parse("2026-10-07T09:00:00.000Z")!

    private func runner(_ json: String) throws -> Runner {
        try JSONDecoder().decode(Runner.self, from: Data(json.utf8))
    }

    /// Mac Studio: two Claude accounts, Codex signed out, Kimi not installed.
    private func macStudio() throws -> Runner {
        try runner(#"""
        {"id":"mac","name":"Mac Studio","online":true,"activeSessions":2,"maxConcurrent":4,
         "lastHeartbeatAt":"2026-10-07T08:59:50.000Z","engines":[
          {"engine":"claude","installed":true,"auth":"yes","accounts":[
            {"id":"default","name":"Personal Max","auth":"yes"},{"id":"slot-2","name":"Work","auth":"yes"}]},
          {"engine":"codex","installed":true,"auth":"no"},
          {"engine":"kimi","installed":false,"auth":"unknown"}]}
        """#)
    }

    /// HPC: Claude, two Codex accounts and Kimi, all signed in.
    private func hpc() throws -> Runner {
        try runner(#"""
        {"id":"hpc","name":"HPC","online":true,"activeSessions":5,"maxConcurrent":8,
         "lastHeartbeatAt":"2026-10-07T08:59:50.000Z","engines":[
          {"engine":"claude","installed":true,"auth":"yes"},
          {"engine":"codex","installed":true,"auth":"yes","accounts":[
            {"id":"default","auth":"yes"},{"id":"slot-2","name":"Team","auth":"yes"}]},
          {"engine":"kimi","installed":true,"auth":"yes"}]}
        """#)
    }

    /// ThinkPad: gone since yesterday, its Codex signed out when it was last seen.
    private func thinkPad() throws -> Runner {
        try runner(#"""
        {"id":"thinkpad","name":"ThinkPad","online":false,"activeSessions":0,"maxConcurrent":4,
         "lastHeartbeatAt":"2026-10-06T08:00:00.000Z","engines":[
          {"engine":"claude","installed":true,"auth":"yes"},
          {"engine":"codex","installed":true,"auth":"no"}]}
        """#)
    }

    private func fleet() throws -> [Runner] { [try macStudio(), try hpc(), try thinkPad()] }

    /// A key as GET /providers/mine lists it, with the engines the server says it runs on, default first.
    private func key(_ label: String, runtime: String = "claude", preset: String? = "anthropic",
                     models: [(String, String)] = [("claude-opus-5", "Claude Opus 5"), ("claude-sonnet-5", "Claude Sonnet 5")],
                     defaultModel: String? = "claude-opus-5", enabled: Bool = true,
                     engines: [String] = ["claude", "opencode"]) -> ConfiguredProvider {
        ConfiguredProvider(slug: label.lowercased(), label: label, runtime: runtime,
                           models: models.map { ConfiguredProviderModel(value: $0.0, label: $0.1) },
                           defaultModel: defaultModel, presetSlug: preset, enabled: enabled, engines: engines)
    }

    private var anthropicWork: ConfiguredProvider { key("Anthropic · Work", defaultModel: "claude-sonnet-5") }

    private func claudePool(unavailable: String? = nil) -> ProviderPool {
        ProviderPool(id: "pool", slug: "claude-keys", label: "Claude keys", unavailable: unavailable,
                     members: [PoolMember(id: "m1", slug: "anthropic", label: "Anthropic (Claude)",
                                          presetSlug: "anthropic", state: .noQuota, next: true)])
    }

    private func attention(_ runners: [Runner], workspaces: [Agent] = [], own: [ProviderPool] = [],
                           member: [ProviderPool] = []) -> [Infrastructure.Attention] {
        Infrastructure.attention(runners: runners, workspaces: workspaces, memberPools: member, ownPools: own,
                                 now: Self.now)
    }

    private func says(_ line: Infrastructure.Attention) -> String { "\(line.line) · \(line.detail)" }

    // MARK: - Needs you

    /// An engine signed out is no line: the web's machine card draws it nothing, and the machine's own page
    /// says so and signs it in. Mac Studio's Codex is out, and only ThinkPad, offline, needs a person — no
    /// block at all while nothing does.
    func testAnEngineSignedOutIsNoLine() throws {
        XCTAssertEqual(attention(try fleet(), own: [claudePool()]).map(\.kind), [.offline(runnerID: "thinkpad")])
        XCTAssertEqual(attention([try hpc()], own: [claudePool()]), [], "nothing needs a person")
    }

    /// A machine that is offline: when it was last seen, and that its subscriptions are gone with it.
    func testAMachineOfflineIsALine() throws {
        let lines = attention(try fleet(), own: [claudePool()])
        XCTAssertEqual(says(lines[0]),
                       "ThinkPad is offline · Last seen 1d ago · its subscriptions are unavailable until it’s back")
        XCTAssertEqual(lines[0].kind, .offline(runnerID: "thinkpad"))
        let never = try runner(#"{"id":"new","name":"New box","online":false}"#)
        XCTAssertEqual(says(attention([never])[0]),
                       "New box is offline · Never checked in · its subscriptions are unavailable until it’s back")
    }

    /// orbit@austin on 2026-10-31: online, Claude Code and Codex installed, neither signed in.
    private func austin(online: Bool = true) throws -> Runner {
        try runner(#"""
        {"id":"austin","name":"orbit@austin","online":\#(online),"activeSessions":0,"maxConcurrent":16,
         "lastHeartbeatAt":"2026-10-07T08:59:50.000Z","engines":[
          {"engine":"claude","installed":true,"auth":"no"},{"engine":"codex","installed":true,"auth":"no"}]}
        """#)
    }

    private func workspace(_ provider: String?, on runner: String = "austin") throws -> Agent {
        let last = provider.map { #","lastProvider":"\#($0)""# } ?? ""
        return try JSONDecoder().decode(Agent.self, from: Data(
            #"{"id":"w-\#(runner)","name":"app","runnerId":"\#(runner)"\#(last)}"#.utf8))
    }

    /// A machine online where no coding CLI is signed in and no workspace runs on a key: nothing can run
    /// there, which its page says (RunnerAttention's noCliSignedIn) — a line after the machines offline,
    /// before the pools, that opens its record. Settings counts it (docs/mocks/first-workspace-in-conversation,
    /// rule 10 of 04).
    func testAMachineWithNoCodingCLISignedInIsALine() throws {
        let lines = attention([try thinkPad(), try austin()], own: [claudePool(unavailable: "No account can run")])
        XCTAssertEqual(lines.map(\.kind), [.offline(runnerID: "thinkpad"), .noCliSignedIn(runnerID: "austin"),
                                           .poolUnavailable(poolID: "pool", own: true)])
        XCTAssertEqual(says(lines[1]), "orbit@austin has no coding CLI signed in · Nothing can run on this machine "
                           + "until one is. Claude Code and Codex are installed here.")
        XCTAssertEqual(lines[1].names, ["orbit@austin"])
        // With workspaces on those logins, or one that has not run yet, it is the same line.
        XCTAssertEqual(attention([try austin()], workspaces: [try workspace("codex")]).map(\.kind),
                       [.noCliSignedIn(runnerID: "austin")])
        XCTAssertEqual(attention([try austin()], workspaces: [try workspace(nil)]).count, 1)
    }

    /// A workspace there on a key or a pool runs without any sign-in: no line. Nor once one CLI is signed in,
    /// and an offline machine is the one line it is offline.
    func testAMachineThatCanRunSomethingIsNoLine() throws {
        XCTAssertEqual(attention([try austin()], workspaces: [try workspace("deepseek")]), [])
        XCTAssertEqual(attention([try austin()], workspaces: [try workspace("anthropic-2")]), [])
        XCTAssertEqual(attention([try austin()], workspaces: [try workspace("deepseek", on: "hpc")]).count, 1,
                       "another machine's key does nothing for this one")
        XCTAssertEqual(attention([try austin(online: false)]).map(\.kind), [.offline(runnerID: "austin")])
        XCTAssertEqual(attention([try macStudio()]), [], "Claude signed in, Codex out")
    }

    /// A pool no session can start on: its own reason, and its page — the account's own, or one it is in,
    /// which come first, as the page lists them.
    func testAPoolNoSessionCanStartOnIsALine() throws {
        let lines = attention(try fleet(), own: [claudePool(unavailable: "No account can run")])
        XCTAssertEqual(says(lines[1]), "Claude keys is unavailable · No account can run · no session can start on it")
        XCTAssertEqual(lines[1].kind, .poolUnavailable(poolID: "pool", own: true))

        let shared = ProviderPool(id: "shared", slug: "team", label: "Team Codex", unavailable: "No keys", engine: "codex")
        let both = attention([], own: [claudePool(unavailable: "No account can run")], member: [shared])
        XCTAssertEqual(both.map(\.kind), [.poolUnavailable(poolID: "shared", own: false),
                                          .poolUnavailable(poolID: "pool", own: true)])
    }

    // MARK: - A key's row

    /// The model a key starts on, by the name its own list gives it; its first model without a default;
    /// the id itself when the list doesn't name it. A key keeps the name its owner gave it, and a Claude
    /// subscription token's line says what it is.
    func testAKeysModelIsNamedAsItsListNamesIt() {
        XCTAssertEqual(Infrastructure.defaultModel(anthropicWork), "Claude Sonnet 5")
        XCTAssertEqual(Infrastructure.defaultModel(key("A", defaultModel: nil)), "Claude Opus 5")
        XCTAssertEqual(Infrastructure.defaultModel(key("A", defaultModel: "")), "Claude Opus 5")
        XCTAssertEqual(Infrastructure.defaultModel(key("A", defaultModel: "claude-haiku-5")), "claude-haiku-5")
        XCTAssertNil(Infrastructure.defaultModel(key("A", models: [], defaultModel: nil)))
        XCTAssertEqual(Infrastructure.keyLabel("Gemini", presetSlug: "gemini"), "Gemini", "a Gemini key keeps its own name")
        XCTAssertEqual(Infrastructure.keyLabel("My Gemini", presetSlug: "gemini"), "My Gemini")
        XCTAssertEqual(Infrastructure.keyLabel("Gemini", presetSlug: nil), "Gemini")
        XCTAssertEqual(ProvidersOverview.keyLine(key("Claude Max", engines: ["claude"])), "Claude Code · subscription token")
        XCTAssertEqual(ProvidersOverview.keyLine(anthropicWork), "Claude Code · OpenCode")
    }

    // MARK: - A machine's row (03-ios.png)

    /// "2 / 4 running · 1 of 3 signed in" — Mac Studio's Codex is signed out, and the line says where its
    /// engines stand rather than counting that, as the web's card does; "5 / 8 running · All signed in";
    /// offline, where its engines stood: "1 of 3 signed in".
    func testAMachinesLineSaysItsSlotsAndWhereItsEnginesStand() throws {
        XCTAssertEqual(Infrastructure.machineLine(try macStudio(), now: Self.now), "2 / 4 running · 1 of 3 signed in")
        XCTAssertEqual(Infrastructure.machineLine(try hpc(), now: Self.now), "5 / 8 running · All signed in")
        XCTAssertEqual(Infrastructure.machineLine(try thinkPad(), now: Self.now), "1 of 3 signed in")
        XCTAssertEqual(Infrastructure.machinesCount(try fleet()), "3 machines · 7 / 12 slots busy")
        XCTAssertEqual(Infrastructure.machinesCount([try hpc()]), "1 machine · 5 / 8 slots busy")
        XCTAssertNil(Infrastructure.machinesCount([]))
    }

    /// The web card's folded summary: an install or update under way or failed first, then engines not
    /// keeping current on a machine online, then how many of the listed engines are signed in.
    func testAMachinesSummaryIsTheWebCards() throws {
        let relay = { (status: String, mode: String) in
            try self.runner(#"{"id":"r","name":"r","online":true,"engines":[],"install":{"status":"\#(status)","engine":"claude","mode":"\#(mode)"}}"#)
        }
        XCTAssertEqual(Infrastructure.summary(try relay("failed", "install")), "Install failed")
        XCTAssertEqual(Infrastructure.summary(try relay("failed", "update")), "Update failed")
        XCTAssertEqual(Infrastructure.summary(try relay("installing", "install")), "Installing…")
        XCTAssertEqual(Infrastructure.summary(try relay("pending", "update")), "Updating…")
        XCTAssertEqual(Infrastructure.summary(try runner(#"{"id":"r","name":"r","online":true}"#)), "Engines not reported")
        let behind = try runner(#"""
        {"id":"r","name":"r","online":true,"engines":[
          {"engine":"claude","installed":true,"auth":"yes","update":{"status":"ok","behindSince":"2026-09-01T00:00:00.000Z","latest":"2.1.300"}}]}
        """#)
        XCTAssertEqual(Infrastructure.summary(behind, now: Self.now), "1 engine not updating")
        // An account signed out leaves its engine short of all signed in.
        let half = try runner(#"""
        {"id":"r","name":"r","online":true,"engines":[
          {"engine":"claude","installed":true,"auth":"yes","accounts":[{"id":"default","auth":"yes"},{"id":"slot-2","auth":"no"}]},
          {"engine":"codex","installed":true,"auth":"yes"},{"engine":"kimi","installed":true,"auth":"yes"}]}
        """#)
        XCTAssertEqual(Infrastructure.summary(half, now: Self.now), "2 of 3 signed in")
    }

    // MARK: - What an engine's page installs

    /// Install for an engine the machine doesn't have, Retry after a failed install; nothing while one is
    /// under way, for one installed, or for an Antigravity the runner can't run.
    func testAnEnginesPageInstallsWhatTheMachineLacks() throws {
        let mac = try macStudio()
        XCTAssertTrue(Infrastructure.installable(mac, .kimi))
        XCTAssertFalse(Infrastructure.installable(mac, .claude))
        XCTAssertTrue(Infrastructure.installable(mac, .antigravity), "not reported, and the runner says nothing against it")

        let installing = try runner(#"{"id":"r","name":"r","online":true,"engines":[],"install":{"status":"installing","engine":"kimi"}}"#)
        XCTAssertEqual(Infrastructure.rowKind(Infrastructure.engineHealth(installing, .kimi), install: installing.install, engine: .kimi),
                       .installing)
        XCTAssertFalse(Infrastructure.installable(installing, .kimi))
        let failed = try runner(#"{"id":"r","name":"r","online":true,"engines":[],"install":{"status":"failed","engine":"kimi"}}"#)
        XCTAssertEqual(Infrastructure.rowKind(Infrastructure.engineHealth(failed, .kimi), install: failed.install, engine: .kimi),
                       .installFailed)
        XCTAssertTrue(Infrastructure.installable(failed, .kimi))
        let unsupported = try runner(#"""
        {"id":"r","name":"r","online":true,"antigravity":{"supported":false,"envKeyAvailable":false}}
        """#)
        XCTAssertFalse(Infrastructure.installable(unsupported, .antigravity))
    }

    /// OpenCode signs in nowhere here, so its page's one press is its install (web's OpenCode row): on a
    /// machine that reports it missing, and Retry after a failed install — none while one is under way, for
    /// one installed, or on a runner that never mentions OpenCode, where the web draws it no row either.
    func testOpenCodesPageInstallsItWhereTheMachineReportsItMissing() throws {
        let missing = try runner(#"""
        {"id":"r","name":"r","online":true,"engines":[{"engine":"opencode","installed":false,"auth":"unknown"}]}
        """#)
        XCTAssertTrue(Infrastructure.installsOpenCode(missing))
        let installed = try runner(#"""
        {"id":"r","name":"r","online":true,"engines":[{"engine":"opencode","installed":true,"auth":"unknown"}]}
        """#)
        XCTAssertFalse(Infrastructure.installsOpenCode(installed))
        let silent = try runner(#"{"id":"r","name":"r","online":true,"engines":[{"engine":"claude","installed":true,"auth":"yes"}]}"#)
        XCTAssertFalse(Infrastructure.installsOpenCode(silent))

        let installing = try runner(#"""
        {"id":"r","name":"r","online":true,"engines":[{"engine":"opencode","installed":false,"auth":"unknown"}],
         "install":{"status":"installing","engine":"opencode"}}
        """#)
        XCTAssertEqual(Infrastructure.rowKind(installing.engines?.first, install: installing.install, slug: "opencode"),
                       .installing)
        XCTAssertFalse(Infrastructure.installsOpenCode(installing))
        let failed = try runner(#"""
        {"id":"r","name":"r","online":true,"engines":[{"engine":"opencode","installed":false,"auth":"unknown"}],
         "install":{"status":"failed","engine":"opencode"}}
        """#)
        XCTAssertEqual(Infrastructure.rowKind(failed.engines?.first, install: failed.install, slug: "opencode"),
                       .installFailed)
        XCTAssertTrue(Infrastructure.installsOpenCode(failed))
    }

    /// A machine's row for an engine it lacks opens that engine's page where the page installs it — Install,
    /// Retry, or the install running — as the web's row offers Install itself: never for an Antigravity the
    /// runner can't run, OpenCode on a runner that never mentions it, or a DeepSeek Harness that is there.
    func testAMissingEnginesRowOpensThePageThatInstallsIt() throws {
        let mac = try macStudio()
        XCTAssertTrue(Infrastructure.installsFromPage(mac, engine: "kimi"))
        XCTAssertFalse(Infrastructure.installsFromPage(mac, engine: "claude"))
        XCTAssertFalse(Infrastructure.installsFromPage(mac, engine: "opencode"), "a runner that never mentions it")
        let installing = try runner(#"{"id":"r","name":"r","online":true,"engines":[],"install":{"status":"installing","engine":"kimi"}}"#)
        XCTAssertTrue(Infrastructure.installsFromPage(installing, engine: "kimi"), "its page says how the install is going")
        let unsupported = try runner(#"""
        {"id":"r","name":"r","online":true,"antigravity":{"supported":false,"envKeyAvailable":false}}
        """#)
        XCTAssertFalse(Infrastructure.installsFromPage(unsupported, engine: "antigravity"))
        let openCode = try runner(#"""
        {"id":"r","name":"r","online":true,"engines":[{"engine":"opencode","installed":false,"auth":"unknown"}]}
        """#)
        XCTAssertTrue(Infrastructure.installsFromPage(openCode, engine: "opencode"))
        let harness = { (installed: Bool) in try self.runner(#"""
            {"id":"r","name":"r","online":true,"capabilities":["provider:dsh"],
             "engines":[{"engine":"dsh","installed":\#(installed),"auth":"unknown"}]}
            """#) }
        XCTAssertTrue(Infrastructure.installsFromPage(try harness(false), engine: "dsh"))
        XCTAssertFalse(Infrastructure.installsFromPage(try harness(true), engine: "dsh"))
    }
}
