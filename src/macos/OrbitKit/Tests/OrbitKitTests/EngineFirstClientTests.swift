import Foundation
import XCTest
@testable import OrbitKit

/// The rest of the clients' engine-first reading (docs/provider-engine-contract.md §1, §6): the wire's
/// `engine` fields, a task's run pins (board 6), the Infrastructure page's API keys and a DeepSeek key's
/// page (boards iOS 1 and 2), and the composer's Provider level (boards iOS 4 and 5).
final class EngineFirstClientTests: XCTestCase {
    private func json(_ value: some Encodable) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any])
    }

    private let deepseek = ConfiguredProvider(slug: "deepseek", label: "DeepSeek", runtime: "claude",
                                              models: [ConfiguredProviderModel(value: "deepseek-v4-pro", label: "DeepSeek V4 Pro")],
                                              defaultModel: "deepseek-v4-pro", presetSlug: "deepseek",
                                              baseUrl: "https://api.deepseek.com/anthropic", hasApiKey: true,
                                              engines: ["claude", "opencode", "dsh"])
    private let glm = ConfiguredProvider(slug: "glm", label: "Z.AI (GLM)", runtime: "claude", presetSlug: "glm",
                                         engines: ["claude", "opencode"])
    private let moonshot = ConfiguredProvider(slug: "moonshot", label: "Kimi (Moonshot)", runtime: "kimi",
                                              presetSlug: "moonshot", engines: ["kimi", "opencode"])

    // MARK: the wire

    /// A session's engine rides beside its provider, an Agent's last engine beside its last provider, and
    /// a task's engine pin beside its provider pin; a row from an older server says none.
    func testTheWireCarriesTheEngineBesideTheProvider() throws {
        let session = try JSONDecoder().decode(Session.self, from: Data(#"""
        {"id":"s1","status":"RUNNING","engine":"dsh","provider":"deepseek-2"}
        """#.utf8))
        XCTAssertEqual(session.engine, "dsh")
        XCTAssertEqual(session.provider, "deepseek-2")
        let older = try JSONDecoder().decode(Session.self, from: Data(#"{"id":"s2","status":"RUNNING","provider":"deepseek"}"#.utf8))
        XCTAssertNil(older.engine)
        XCTAssertEqual(ProviderEngines.sessionEngine(older.engine, provider: older.provider, configured: [deepseek]), "claude")
        // A control-plane summary never carries the engine, so folding one in keeps the row's.
        let summary = try JSONDecoder().decode(ControlSessionSummary.self, from: Data(#"""
        {"id":"s1","status":"RUNNING","pendingApprovals":1}
        """#.utf8))
        XCTAssertEqual(session.applying(summary).engine, "dsh")

        let workspace = try JSONDecoder().decode(Agent.self, from: Data(#"""
        {"id":"w1","name":"builds","lastEngine":"dsh","lastProvider":"deepseek-2"}
        """#.utf8))
        XCTAssertEqual(workspace.lastEngine, "dsh")
        XCTAssertEqual(workspace.defaultEngine(configured: [deepseek]), "dsh")
        let olderWorkspace = try JSONDecoder().decode(Agent.self, from: Data(#"{"id":"w2","name":"orbit","lastProvider":"glm"}"#.utf8))
        XCTAssertEqual(olderWorkspace.defaultEngine(configured: [glm]), "claude")

        let task = try JSONDecoder().decode(TaskItem.self, from: Data(#"""
        {"id":"t1","title":"T","status":"OPEN","engine":"dsh","provider":"deepseek-2"}
        """#.utf8))
        XCTAssertEqual(task.engine, "dsh")

        // A new session names the pair; leaving both off keeps the workspace's.
        let create = try json(CreateSessionRequest(prompt: "hi", agentId: "w1", engine: "dsh", provider: "deepseek-2"))
        XCTAssertEqual(create["engine"] as? String, "dsh")
        XCTAssertEqual(create["provider"] as? String, "deepseek-2")
        let inherit = try json(CreateSessionRequest(prompt: "hi", agentId: "w1"))
        XCTAssertNil(inherit["engine"])
        XCTAssertNil(inherit["provider"])

        // A task's engine pin is three-state like its provider pin.
        XCTAssertFalse(try json(UpdateTaskRequest(title: "x")).keys.contains("engine"))
        XCTAssertEqual(try json(UpdateTaskRequest(engine: .set("codex")))["engine"] as? String, "codex")
        XCTAssertTrue(try json(UpdateTaskRequest(engine: .clear))["engine"] is NSNull)
    }

    // MARK: a task's run pins (board 6)

    private func task(engine: String? = nil, provider: String? = nil) throws -> TaskItem {
        var fields = [#""id":"t1""#, #""title":"T""#, #""status":"OPEN""#]
        if let engine { fields.append(#""engine":"\#(engine)""#) }
        if let provider { fields.append(#""provider":"\#(provider)""#) }
        return try JSONDecoder().decode(TaskItem.self, from: Data("{\(fields.joined(separator: ","))}".utf8))
    }

    private func assignee() throws -> Agent {
        try JSONDecoder().decode(Agent.self, from: Data(#"{"id":"w1","name":"orbit","lastEngine":"claude","lastProvider":"claude"}"#.utf8))
    }

    func testAnUnpinnedTaskRunsOnItsAssigneesEngineAndAProviderPinnedAloneOnItsOwn() throws {
        let configured = [deepseek, glm]
        let unpinned = TaskRunPin(task: try task(), assignee: try assignee(), configured: configured)
        XCTAssertEqual(unpinned.runEngine, "claude")
        XCTAssertEqual(unpinned.inheritedEngine, "Assignee's · Claude Code")
        XCTAssertEqual(unpinned.runProvider(firstDeepSeekKey: "deepseek"), "claude")
        // An older client pinned a provider alone: its runs are on that provider's engine.
        let legacy = TaskRunPin(task: try task(provider: "moonshot"), assignee: try assignee(), configured: [moonshot])
        XCTAssertEqual(legacy.runEngine, "kimi")
        XCTAssertEqual(legacy.inheritedEngine, "Kimi Code")
        // An engine pinned alone runs on its default credential: DeepSeek Harness's first DeepSeek key.
        let harness = TaskRunPin(task: try task(engine: "dsh"), assignee: try assignee(), configured: configured)
        XCTAssertEqual(harness.runEngine, "dsh")
        XCTAssertEqual(harness.runProvider(firstDeepSeekKey: "deepseek"), "deepseek")
        XCTAssertEqual(TaskRunPin(task: try task(engine: "codex"), assignee: try assignee(), configured: configured)
            .runProvider(firstDeepSeekKey: nil), "codex")
    }

    /// Board 6 ③: a pinned credential the new engine does not run gives way, one it runs stays, and the
    /// model never survives the move; back on the assignee's, nothing stays pinned.
    func testMovingTheEnginePinKeepsOnlyACredentialItRuns() throws {
        let configured = [deepseek, glm]
        let pinned = TaskRunPin(task: try task(engine: "dsh", provider: "deepseek"), assignee: try assignee(),
                                configured: configured)
        let toClaude = try json(XCTUnwrap(pinned.engineRequest("claude", configured: configured)))
        XCTAssertEqual(toClaude["engine"] as? String, "claude")
        XCTAssertNil(toClaude["provider"], "Claude Code runs the DeepSeek key: the pin stays")
        XCTAssertTrue(toClaude["model"] is NSNull)
        let toCodex = try json(XCTUnwrap(pinned.engineRequest("codex", configured: configured)))
        XCTAssertEqual(toCodex["engine"] as? String, "codex")
        XCTAssertTrue(toCodex["provider"] is NSNull, "Codex does not run it: back to Codex's default")
        let back = try json(XCTUnwrap(pinned.engineRequest(nil, configured: configured)))
        XCTAssertTrue(back["engine"] is NSNull)
        XCTAssertTrue(back["provider"] is NSNull)
        XCTAssertNil(pinned.engineRequest("dsh", configured: configured), "the engine it already has")
    }

    /// A credential is pinned with the engine it runs on, so a task names the pair; Engine default takes
    /// the credential pin back.
    func testPinningACredentialNamesThePair() throws {
        let pin = TaskRunPin(task: try task(engine: "dsh"), assignee: try assignee(), configured: [deepseek])
        let picked = try json(XCTUnwrap(pin.providerRequest("deepseek")))
        XCTAssertEqual(picked["engine"] as? String, "dsh")
        XCTAssertEqual(picked["provider"] as? String, "deepseek")
        XCTAssertTrue(picked["model"] is NSNull)
        XCTAssertNil(pin.providerRequest(nil), "nothing pinned to take back")
        let pinned = TaskRunPin(task: try task(engine: "dsh", provider: "deepseek"), assignee: try assignee(),
                                configured: [deepseek])
        let cleared = try json(XCTUnwrap(pinned.providerRequest(nil)))
        XCTAssertTrue(cleared["provider"] is NSNull)
        XCTAssertNil(cleared["engine"], "the engine pin stays")
        XCTAssertNil(pinned.providerRequest("deepseek"))
    }

    // MARK: Infrastructure's API keys (board iOS 1 ③)

    /// Each vendor's keys together, in the order of each vendor's first key: a key from the retired
    /// DeepSeek Harness preset is DeepSeek's, a self-maintained endpoint Custom's.
    func testTheKeysAreListedWithEachVendorsTogether() {
        func key(_ slug: String, _ preset: String?) -> ConfiguredProvider {
            ConfiguredProvider(slug: slug, label: slug, runtime: "claude", presetSlug: preset)
        }
        let keys = [key("deepseek", "deepseek"), key("gemini", "gemini"), key("own", nil), key("deepseek-2", "deepseek-harness"),
                    key("gemini-2", "gemini"), key("own-2", "")]
        XCTAssertEqual(ProvidersOverview.byVendor(keys).map(\.slug),
                       ["deepseek", "deepseek-2", "gemini", "gemini-2", "own", "own-2"])
    }

    // MARK: a DeepSeek key's page (board iOS 2)

    func testTheKeysPageSaysWhereItWorksAndWhatTurningItOffStops() {
        XCTAssertEqual(DeepSeekBalance.engines(of: deepseek), ["Claude Code", "OpenCode", "DeepSeek Harness"])
        XCTAssertEqual(DeepSeekBalance.turnOffNote(deepseek),
                       "Adding or changing a key happens on the web. Turning it off there stops it on Claude Code, OpenCode and DeepSeek Harness.")
        XCTAssertEqual(DeepSeekBalance.turnOffNote(ConfiguredProvider(slug: "max", label: "Max", runtime: "claude", engines: ["claude"])),
                       "Adding or changing a key happens on the web. Turning it off there stops it on Claude Code.")
        XCTAssertEqual(DeepSeekBalance.worksWithFooter,
                       "Pick it for a session on any of these in the composer's model menu → Provider.")
        XCTAssertEqual(DeepSeekBalance.defaultModelName(deepseek), "DeepSeek V4 Pro")
        XCTAssertEqual(SessionProviderChoices.runtimeSummary(deepseek.runtime), "Anthropic-compatible")
        XCTAssertEqual(SessionProviderChoices.runtimeSummary("codex"), "OpenAI-compatible")
        XCTAssertEqual(SessionProviderChoices.runtimeSummary("kimi"), "Moonshot API")
        XCTAssertEqual(SessionProviderChoices.runtimeSummary("antigravity"), "Gemini API")
    }

    /// The protocol is named as the web's connect form names it.
    func testTheProtocolIsTheWebsWord() throws {
        let web = try source("src/web/src/lib/sessionProviderChoices.ts")
        for runtime in ["codex", "kimi", "antigravity", "claude"] {
            XCTAssertTrue(web.contains("'\(SessionProviderChoices.runtimeSummary(runtime))'"), runtime)
        }
    }

    // MARK: DeepSeek Harness's engine page (board iOS 1 ⑥⑦)

    func testHarnessHasNoSignInToSpeakOf() {
        XCTAssertEqual(DshRuntime.readyLine, "Ready · each session uses the DeepSeek key it was started with")
        XCTAssertEqual(DshRuntime.enginePageFooter,
                       "Orbit keeps DeepSeek Harness updated every 30 min. It has no sign-in: every session runs on a DeepSeek key.")
        XCTAssertEqual(RunnerPageFormat.engineName("dsh"), "DeepSeek Harness")
        XCTAssertEqual(SessionProviderChoices.enginePreset["dsh"], "deepseek", "the whale, the keys it runs on")
    }

    // MARK: the composer's Provider level (boards iOS 4 and 5)

    /// A key the session's engine no longer lists: turned off — its own keys still hold it — or deleted;
    /// nothing for a key still served, a sign-in, OpenCode's own configuration or the legacy `dsh`.
    func testWhatBecameOfTheSessionsKey() {
        var off = ConfiguredProvider(slug: "deepseek-2", label: "DeepSeek 2", runtime: "claude", enabled: false)
        off.providerID = "p9"
        XCTAssertEqual(SessionProviderChoices.keyGone(provider: "deepseek-2", listed: false, configured: [deepseek],
                                                     ownKeys: [deepseek, off]), .turnedOff(providerID: "p9"))
        XCTAssertEqual(SessionProviderChoices.keyGone(provider: "deepseek-harness", listed: false, configured: [deepseek],
                                                     ownKeys: [deepseek]), .deleted)
        XCTAssertNil(SessionProviderChoices.keyGone(provider: "deepseek-harness", listed: false, configured: [deepseek],
                                                   ownKeys: nil), "not before the account's own keys are read")
        XCTAssertNil(SessionProviderChoices.keyGone(provider: "deepseek", listed: false, configured: [deepseek],
                                                   ownKeys: [deepseek]))
        XCTAssertNil(SessionProviderChoices.keyGone(provider: "claude", listed: false, configured: [], ownKeys: []))
        XCTAssertNil(SessionProviderChoices.keyGone(provider: "opencode", listed: false, configured: [], ownKeys: []))
        XCTAssertNil(SessionProviderChoices.keyGone(provider: "dsh", listed: false, configured: [], ownKeys: []))
        XCTAssertNil(SessionProviderChoices.keyGone(provider: "deepseek-2", listed: true, configured: [], ownKeys: [off]))
    }

    /// What the Provider row says: Automatic while Orbit picks the account, else the account in use;
    /// OpenCode's own configuration as its own sign-in; a key or a pool by its name.
    func testWhatTheProviderRowSays() {
        let login = ProviderChoice(slug: "claude", label: "Default", kind: .login, brandKey: "anthropic", modelLabel: "")
        XCTAssertEqual(SessionProviderChoices.providerValue(login, provider: "claude", automatic: true, accountLabel: "Work"),
                       "Automatic")
        XCTAssertEqual(SessionProviderChoices.providerValue(login, provider: "claude", automatic: false, accountLabel: "Work"),
                       "Work")
        XCTAssertEqual(SessionProviderChoices.providerValue(login, provider: "claude", automatic: false, accountLabel: nil),
                       "Default")
        let key = ProviderChoice(slug: "deepseek-2", label: "DeepSeek 2", kind: .key, brandKey: "deepseek", modelLabel: "")
        XCTAssertEqual(SessionProviderChoices.providerValue(key, provider: "deepseek-2", automatic: false, accountLabel: nil),
                       "DeepSeek 2")
        XCTAssertEqual(SessionProviderChoices.providerValue(nil, provider: "gone", automatic: false, accountLabel: nil), "gone")
    }

    /// Board iOS 4 ③④⑤: DeepSeek Harness's keys under API keys; Claude Code's sign-in, pools and keys; and
    /// OpenCode's own sign-in "on" the machine with its keys.
    func testTheProviderLevelIsGroupedByWhereACredentialComesFrom() {
        let sources = ChoiceSources(configured: [deepseek, glm, moonshot], dshState: .ready)
        let dsh = SessionProviderChoices.providers(for: "dsh", sources: sources)
        XCTAssertEqual(SessionProviderChoices.menuGroups(dsh, listed: true, runnerName: "hpc").map(\.title), ["API keys"])
        let claude = SessionProviderChoices.providers(for: "claude", sources: sources)
        XCTAssertEqual(SessionProviderChoices.menuGroups(claude, listed: true, runnerName: "hpc").map(\.title),
                       ["Signed in on hpc", "API keys"])
        let openCode = SessionProviderChoices.providers(for: "opencode", sources: sources)
        let groups = SessionProviderChoices.menuGroups(openCode, listed: true, runnerName: "hpc")
        XCTAssertEqual(groups.map(\.title), ["On hpc", "API keys"])
        XCTAssertEqual(groups[1].choices.map(\.label), ["DeepSeek", "Z.AI (GLM)", "Kimi (Moonshot)"])
        XCTAssertEqual(SessionProviderChoices.menuGroups(claude, listed: true, runnerName: nil).first?.title,
                       "Signed in on this runner")
    }

    private func source(_ relative: String) throws -> String {
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let file = directory.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: file.path) {
                return try String(contentsOf: file, encoding: .utf8)
            }
            directory.deleteLastPathComponent()
        }
        XCTFail("Missing counterpart: \(relative)")
        throw CocoaError(.fileReadNoSuchFile)
    }
}
