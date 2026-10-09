import Foundation
import XCTest
@testable import OrbitKit

/// The top of the Infrastructure page on iOS and macOS — what needs a person, and what each engine can
/// run on — held to the web's own cases (src/web/src/pages/InfrastructurePage.overview.test.tsx): the
/// same three machines, keys and pool, and the same lines out of them. Then a machine's row in the list
/// (03-ios.png), and what an engine's page offers to install.
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

    private var anthropic: ConfiguredProvider { key("Anthropic (Claude)") }
    private var anthropicWork: ConfiguredProvider { key("Anthropic · Work", defaultModel: "claude-sonnet-5") }
    private var deepseek: ConfiguredProvider { deepseek("DeepSeek") }
    private func deepseek(_ label: String) -> ConfiguredProvider {
        key(label, preset: "deepseek", models: [("deepseek-v4-pro", "DeepSeek V4 Pro"), ("deepseek-v4-flash", "DeepSeek V4 Flash")],
            defaultModel: "deepseek-v4-pro", engines: ["claude", "opencode", "dsh"])
    }
    private var moonshot: ConfiguredProvider {
        key("Kimi (Moonshot)", runtime: "kimi", preset: "moonshot", models: [("kimi-k2.7-code", "Kimi K2.7 Code")],
            defaultModel: "kimi-k2.7-code", engines: ["kimi", "opencode"])
    }
    private var openAIOff: ConfiguredProvider {
        key("OpenAI", runtime: "codex", preset: "openai", models: [("gpt-5.6-sol", "GPT-5.6 Sol")],
            defaultModel: "gpt-5.6-sol", enabled: false, engines: ["codex", "opencode"])
    }

    private func claudePool(unavailable: String? = nil) -> ProviderPool {
        ProviderPool(id: "pool", slug: "claude-keys", label: "Claude keys", unavailable: unavailable,
                     members: [PoolMember(id: "m1", slug: "anthropic", label: "Anthropic (Claude)",
                                          presetSlug: "anthropic", state: .noQuota, next: true)])
    }

    private func attention(_ runners: [Runner], own: [ProviderPool] = [], member: [ProviderPool] = [])
        -> [Infrastructure.Attention] {
        Infrastructure.attention(runners: runners, memberPools: member, ownPools: own, now: Self.now)
    }

    private func says(_ line: Infrastructure.Attention) -> String { "\(line.line) · \(line.detail)" }

    // MARK: - Needs you

    /// An engine signed out on a machine that is online gets a line, signed in again on its page; the
    /// same engine signed out on a machine that is offline doesn't — the machine's line is its line.
    func testAnEngineSignedOutOnAMachineOnlineIsALine() throws {
        let lines = attention(try fleet(), own: [claudePool()])
        XCTAssertEqual(says(lines[0]), "Codex is signed out on Mac Studio · Sessions there can’t use it")
        XCTAssertEqual(lines[0].kind, .signedOut(runnerID: "mac", engine: .codex))
        XCTAssertEqual(lines[0].names, ["Codex", "Mac Studio"], "the names the line sets in bold")
        XCTAssertEqual(lines.filter { $0.line.contains("signed out") }.count, 1)
        XCTAssertEqual(Infrastructure.signedOutEngines(try thinkPad()), [], "offline: its line says so instead")
    }

    /// Nothing for an engine still signed in on another account, one whose CLI would not say, or one not
    /// installed — and no block at all while nothing needs a person.
    func testNothingForAnEngineStillInOnAnotherAccountOrOneThatWouldNotSay() throws {
        let box = try runner(#"""
        {"id":"hpc","name":"HPC","online":true,"engines":[
          {"engine":"claude","installed":true,"auth":"no","accounts":[
            {"id":"default","auth":"no"},{"id":"slot-2","name":"Work","auth":"yes"}]},
          {"engine":"codex","installed":true,"auth":"unknown"},
          {"engine":"kimi","installed":false,"auth":"no"}]}
        """#)
        XCTAssertEqual(attention([box]), [])
        XCTAssertEqual(attention([try hpc()], own: [claudePool()]), [], "nothing needs a person")
    }

    /// A machine that is offline: when it was last seen, and that its subscriptions are gone with it.
    func testAMachineOfflineIsALine() throws {
        let lines = attention(try fleet(), own: [claudePool()])
        XCTAssertEqual(says(lines[1]),
                       "ThinkPad is offline · Last seen 1d ago · its subscriptions are unavailable until it’s back")
        XCTAssertEqual(lines[1].kind, .offline(runnerID: "thinkpad"))
        let never = try runner(#"{"id":"new","name":"New box","online":false}"#)
        XCTAssertEqual(says(attention([never])[0]),
                       "New box is offline · Never checked in · its subscriptions are unavailable until it’s back")
    }

    /// A pool no session can start on: its own reason, and its page — the account's own, or one it is in,
    /// which come first, as the page lists them.
    func testAPoolNoSessionCanStartOnIsALine() throws {
        let lines = attention(try fleet(), own: [claudePool(unavailable: "No account can run")])
        XCTAssertEqual(says(lines[2]), "Claude keys is unavailable · No account can run · no session can start on it")
        XCTAssertEqual(lines[2].kind, .poolUnavailable(poolID: "pool", own: true))

        let shared = ProviderPool(id: "shared", slug: "team", label: "Team Codex", unavailable: "No keys", engine: "codex")
        let both = attention([], own: [claudePool(unavailable: "No account can run")], member: [shared])
        XCTAssertEqual(both.map(\.kind), [.poolUnavailable(poolID: "shared", own: false),
                                          .poolUnavailable(poolID: "pool", own: true)])
    }

    /// Antigravity is only a line where its Google sign-in can be started — the one way back in.
    func testAntigravitySignedOutIsALineOnlyWhereGoogleSignInCanStart() throws {
        let json = { (login: String) in #"""
            {"id":"r","name":"Box","online":true,
             "antigravity":{"supported":true,"installed":true,"envKeyAvailable":false,"googleLogin":"\#(login)"},
             "engines":[{"engine":"antigravity","installed":true,"auth":"no"}]}
            """# }
        XCTAssertEqual(Infrastructure.signedOutEngines(try runner(json("available"))), [.antigravity])
        let line = attention([try runner(json("available"))])[0]
        XCTAssertEqual(says(line), "Antigravity CLI is signed out on Box · Sessions there can’t use it")
        XCTAssertEqual(line.names, ["Antigravity CLI", "Box"], "the engine by its CLI's name, as every list names it")
        XCTAssertEqual(Infrastructure.signedOutEngines(try runner(json("needs_update"))), [])
        XCTAssertEqual(Infrastructure.signedOutEngines(try runner(json("unsupported_platform"))), [])
    }

    // MARK: - What your agents can run on

    /// An engine to a card, each Ready with what can pay for it now — online machines by how many of their
    /// accounts, keys beside their models, pools — and Antigravity, with none, Not set up.
    func testEachEngineIsReadyWithWhatCanPayForItNow() throws {
        let engines = Infrastructure.engines(runners: try fleet(), keys: [anthropic, anthropicWork, deepseek],
                                             pools: [claudePool()])
        XCTAssertEqual(engines.map(\.engine), [.claude, .codex, .kimi, .antigravity])
        XCTAssertEqual(engines.map(\.ready), [true, true, true, false])
        XCTAssertEqual(engines[0].machines, ["Mac Studio ×2", "HPC"])
        XCTAssertEqual(engines[0].keys, [.init(label: "Anthropic (Claude)", model: "Claude Opus 5"),
                                         .init(label: "Anthropic · Work", model: "Claude Sonnet 5"),
                                         .init(label: "DeepSeek", model: "DeepSeek V4 Pro")])
        XCTAssertEqual(engines[0].pools, ["Claude keys"])
        // Mac Studio's Codex is signed out, and ThinkPad's is on a machine that is offline.
        XCTAssertEqual(engines[1].machines, ["HPC ×2"])
        XCTAssertEqual(engines[1].keys, [])
        XCTAssertEqual(engines[2].machines, ["HPC"])
        XCTAssertEqual(engines[3], Infrastructure.Engine(engine: .antigravity, machines: [], keys: [], pools: []))
    }

    /// Every engine a session can run on is a card, by its CLI's name in the pickers' order — the same keys
    /// again under each engine they run on: OpenCode runs every one of them, DeepSeek Harness the DeepSeek
    /// key. The app's four cards are the four a machine signs in.
    func testEveryEngineIsACardWithEveryKeyThatRunsOnIt() throws {
        let cards = Infrastructure.engineCards(runners: try fleet(), keys: [anthropic, anthropicWork, deepseek],
                                               pools: [claudePool()])
        XCTAssertEqual(cards.map(\.name), ["Claude Code", "Codex", "Kimi Code", "Antigravity CLI", "OpenCode", "DeepSeek Harness"])
        XCTAssertEqual(cards.map(\.ready), [true, true, true, false, true, true])
        let three: [Infrastructure.Engine.Key] = [.init(label: "Anthropic (Claude)", model: "Claude Opus 5"),
                                                  .init(label: "Anthropic · Work", model: "Claude Sonnet 5"),
                                                  .init(label: "DeepSeek", model: "DeepSeek V4 Pro")]
        XCTAssertEqual(cards[0].keys, three)
        XCTAssertEqual(cards[4], Infrastructure.EngineCard(engine: "opencode", machines: [], keys: three, pools: []))
        // Harness lists its models on each machine, and none here has reported them: the key, and no model.
        XCTAssertEqual(cards[5], Infrastructure.EngineCard(engine: "dsh", machines: [],
                                                           keys: [.init(label: "DeepSeek", model: nil)], pools: []))
        let four = Infrastructure.engines(runners: try fleet(), keys: [anthropic, anthropicWork, deepseek], pools: [claudePool()])
        XCTAssertEqual(four.map(\.engine.rawValue), cards.prefix(4).map(\.engine))
        XCTAssertEqual(four.map(\.keys), cards.prefix(4).map(\.keys))
    }

    /// A key is listed under every engine it runs on, beside the model it starts on there; one switched off
    /// is nothing any engine can run on.
    func testAKeyIsUnderEveryEngineItRunsOn() {
        let cards = Infrastructure.engineCards(runners: [], keys: [deepseek, moonshot, openAIOff], pools: [])
        XCTAssertEqual(cards[0].keys, [.init(label: "DeepSeek", model: "DeepSeek V4 Pro")])
        XCTAssertEqual(cards[2].keys, [.init(label: "Kimi (Moonshot)", model: "Kimi K2.7 Code")])
        XCTAssertEqual(cards[4].keys, [.init(label: "DeepSeek", model: "DeepSeek V4 Pro"),
                                       .init(label: "Kimi (Moonshot)", model: "Kimi K2.7 Code")])
        XCTAssertEqual(cards[5].keys, [.init(label: "DeepSeek", model: nil)])
        XCTAssertFalse(cards[1].ready, "an OpenAI key switched off")
    }

    /// A DeepSeek Harness session's model is a machine's Harness catalogue's — the same for every DeepSeek
    /// key — where Claude Code and OpenCode start each key on its own list's default.
    func testAHarnessSessionsModelIsFromAMachinesCatalogue() throws {
        let box = try runner(#"""
        {"id":"hpc","name":"HPC","online":true,"capabilities":["provider:dsh"],
         "engines":[{"engine":"dsh","installed":true,"auth":"unknown","version":"0.2.0-rc.2"}],
         "modelCatalog":{"dsh":[{"value":"[\"deepseek\", \"deepseek-v4-pro\"]","label":"DeepSeek V4 Pro"},
                                {"value":"[\"deepseek\", \"deepseek-v4-flash\"]","label":"DeepSeek V4 Flash"}]},
         "runtimeDefaultModels":{"dsh":"[\"deepseek\", \"deepseek-v4-flash\"]"}}
        """#)
        let cards = Infrastructure.engineCards(runners: [box], keys: [deepseek, deepseek("DeepSeek 2")], pools: [])
        XCTAssertEqual(cards[5].keys, [.init(label: "DeepSeek", model: "DeepSeek V4 Flash"),
                                       .init(label: "DeepSeek 2", model: "DeepSeek V4 Flash")])
        XCTAssertEqual(cards[0].keys.map(\.model), ["DeepSeek V4 Pro", "DeepSeek V4 Pro"])
        XCTAssertEqual(cards[4].keys.map(\.model), ["DeepSeek V4 Pro", "DeepSeek V4 Pro"])
    }

    /// A Claude subscription token is under Claude Code alone, as the server answers for it, and its line
    /// says what it is; OpenCode runs the API key beside it.
    func testASubscriptionTokenIsUnderClaudeCodeAlone() {
        let max = key("Claude Max", engines: ["claude"])
        let cards = Infrastructure.engineCards(runners: [], keys: [max, anthropicWork], pools: [])
        XCTAssertEqual(cards[0].keys.map(\.label), ["Claude Max", "Anthropic · Work"])
        XCTAssertEqual(cards[4].keys.map(\.label), ["Anthropic · Work"])
        XCTAssertEqual(ProvidersOverview.keyLine(max), "Claude Code · subscription token")
        XCTAssertEqual(ProvidersOverview.keyLine(anthropicWork), "Claude Code · OpenCode")
    }

    /// OpenCode's machines are the ones its own sign-in is set up on, beside the keys it runs.
    func testOpenCodesOwnSignInIsWhereItIsSetUp() throws {
        let hpc = try runner(#"""
        {"id":"hpc","name":"HPC","online":true,"engines":[{"engine":"opencode","installed":true,"auth":"yes","version":"1.18.35"}]}
        """#)
        let mac = try runner(#"""
        {"id":"mac","name":"Mac Studio","online":true,"engines":[{"engine":"opencode","installed":true,"auth":"no","version":"1.18.35"}]}
        """#)
        let openCode = Infrastructure.engineCards(runners: [hpc, mac], keys: [moonshot], pools: [])[4]
        XCTAssertEqual(openCode.machinesLabel, "Own sign-in")
        XCTAssertEqual(openCode.machines, ["HPC"])
        XCTAssertEqual(openCode.keys, [.init(label: "Kimi (Moonshot)", model: "Kimi K2.7 Code")])
    }

    /// Not set up on what cannot be used now: a machine offline, a key switched off, a pool nothing can
    /// start on — and with no machine online, Install on a machine has nothing to open but registering one.
    func testWhatCannotBeUsedNowIsNotSetUp() throws {
        let offline = try runner(#"{"id":"t","name":"ThinkPad","online":false,"engines":[{"engine":"codex","installed":true,"auth":"yes"}]}"#)
        let codex = ProviderPool(id: "c", slug: "my-codex", label: "My Codex", unavailable: "Not signed in", engine: "codex")
        let engines = Infrastructure.engines(runners: [offline], keys: [openAIOff], pools: [codex])
        XCTAssertEqual(engines[1], Infrastructure.Engine(engine: .codex, machines: [], keys: [], pools: []))
        XCTAssertNil(Infrastructure.installTarget([offline]))
        XCTAssertEqual(Infrastructure.installTarget(try fleet())?.id, "mac", "the first machine online")
    }

    /// A pool is its engine's: a shared or ChatGPT pool Codex's, any other Claude Code's.
    func testAPoolIsItsEnginesSource() {
        let shared = ProviderPool(id: "s", slug: "team", label: "Team keys", engine: "codex")
        let engines = Infrastructure.engines(runners: [], keys: [], pools: [claudePool(), shared])
        XCTAssertEqual(engines[0].pools, ["Claude keys"])
        XCTAssertEqual(engines[1].pools, ["Team keys"])
    }

    /// Antigravity on a machine's own Gemini key: the server's answer stands for its install and its
    /// credential, and Default on that key counts as a login.
    func testAntigravityOnTheMachinesOwnKeyIsASubscription() throws {
        let box = try runner(#"""
        {"id":"r","name":"Box","online":true,
         "antigravity":{"supported":true,"installed":true,"envKeyAvailable":true,"googleLogin":"available"},
         "engines":[{"engine":"antigravity","installed":true,"auth":"yes","accounts":[{"id":"default","auth":"no"}]}]}
        """#)
        let engines = Infrastructure.engines(runners: [box], keys: [], pools: [])
        XCTAssertEqual(engines[3].machines, ["Box"])
        XCTAssertEqual(Infrastructure.signedOutEngines(box), [])
    }

    /// The model a key starts on, by the name its own list gives it; its first model without a default;
    /// the id itself when the list doesn't name it.
    func testAKeysModelIsNamedAsItsListNamesIt() {
        XCTAssertEqual(Infrastructure.defaultModel(anthropicWork), "Claude Sonnet 5")
        XCTAssertEqual(Infrastructure.defaultModel(key("A", defaultModel: nil)), "Claude Opus 5")
        XCTAssertEqual(Infrastructure.defaultModel(key("A", defaultModel: "")), "Claude Opus 5")
        XCTAssertEqual(Infrastructure.defaultModel(key("A", defaultModel: "claude-haiku-5")), "claude-haiku-5")
        XCTAssertNil(Infrastructure.defaultModel(key("A", models: [], defaultModel: nil)))
        XCTAssertEqual(Infrastructure.keyLabel("Gemini", presetSlug: "gemini"), "Gemini", "a Gemini key keeps its own name")
        XCTAssertEqual(Infrastructure.keyLabel("My Gemini", presetSlug: "gemini"), "My Gemini")
        XCTAssertEqual(Infrastructure.keyLabel("Gemini", presetSlug: nil), "Gemini")
    }

    // MARK: - A machine's row (03-ios.png)

    /// "2 / 4 running · 1 engine signed out"; "5 / 8 running · All signed in"; offline, where its engines
    /// stood: "1 of 3 signed in".
    func testAMachinesLineSaysItsSlotsAndItsEnginesSignedOut() throws {
        XCTAssertEqual(Infrastructure.machineLine(try macStudio(), now: Self.now), "2 / 4 running · 1 engine signed out")
        XCTAssertEqual(Infrastructure.machineLine(try hpc(), now: Self.now), "5 / 8 running · All signed in")
        XCTAssertEqual(Infrastructure.machineLine(try thinkPad(), now: Self.now), "1 of 3 signed in")
        XCTAssertEqual(Infrastructure.signedOutCount(2), "2 engines signed out")
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
}
