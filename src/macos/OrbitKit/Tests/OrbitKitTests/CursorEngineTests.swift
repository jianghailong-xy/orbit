import XCTest
@testable import OrbitKit

/// Cursor CLI, the seventh engine (project P1; shared `cursor-engine.spec.ts`). The mirror knows it, so a
/// session, a task, a workspace or a runner's report on it decodes as what it is; and until P7b builds
/// its screens no list of engines here offers it (`ProviderEngines.appleShowsEngine`, web
/// `webShowsEngine`): each list reads as it did before Cursor CLI was registered.
final class CursorEngineTests: XCTestCase {
    /// 2026-10-17T09:00:00Z.
    private let nowMs: Int64 = 1_792_227_600_000

    private let claude = #"{"engine":"claude","installed":true,"auth":"yes"}"#
    /// Cursor CLI as a runner reports it once it can (P3): installed, signed out, its updates failing
    /// for a fortnight.
    private let cursor = #"""
    {"engine":"cursor","installed":true,"auth":"no","version":"2026.10.14-941492e",
     "update":{"status":"failed","at":"2026-10-17T08:30:00.000Z","okAt":"2026-10-01T00:00:00.000Z",
               "latest":"2026.10.16-e3cb207","behindSince":"2026-10-01T00:00:00.000Z"}}
    """#
    /// A key that runs on Cursor CLI alone, as GET /providers would list one (P2).
    private let cursorKey = ConfiguredProvider(slug: "cursor-key", label: "Cursor key", runtime: "cursor",
                                               enabled: true, engines: ["cursor"])
    private let glm = ConfiguredProvider(slug: "glm", label: "Z.AI (GLM)", runtime: "claude", presetSlug: "glm",
                                         enabled: true, engines: ["claude", "opencode"])
    /// A workspace whose last session ran on this runner's Cursor CLI sign-in.
    private let onCursor = #"{"id":"w","name":"orbit","lastProvider":"cursor","lastEngine":"cursor"}"#

    private func runner(_ engines: String...) throws -> Runner {
        let json = #"{"id":"r","name":"hpc","online":true,"lastHeartbeatAt":"2026-10-17T08:59:50.000Z","#
            + #""capabilities":["provider:cursor"],"engines":["# + engines.joined(separator: ",") + "]}"
        return try JSONDecoder().decode(Runner.self, from: Data(json.utf8))
    }

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    func testARunnerSignInToCursorRunsOnCursorAloneAndNoOtherCredentialRunsOnIt() {
        let login = ProviderEngines.Credential.login(engine: "cursor")
        XCTAssertEqual(ProviderEngines.credentialEngines(login), ["cursor"])
        XCTAssertEqual(ProviderEngines.defaultEngine(of: login), "cursor")
        for engine in ProviderEngines.all {
            XCTAssertEqual(ProviderEngines.isCompatible(engine, login), engine == "cursor", engine)
        }
        var others = ["claude", "codex", "kimi", "antigravity"].map { ProviderEngines.Credential.login(engine: $0) }
        others += [
            .pool(engine: "claude"), .pool(engine: "codex"), .opencode,
            .key(runtime: "claude", presetSlug: "glm", baseUrl: "https://api.z.ai/api/anthropic", subscriptionToken: false),
            .key(runtime: "claude", presetSlug: "deepseek", baseUrl: "https://api.deepseek.com/anthropic", subscriptionToken: false),
            .key(runtime: "dsh", presetSlug: "deepseek-harness", baseUrl: "https://api.deepseek.com/anthropic", subscriptionToken: false),
            .key(runtime: "claude", presetSlug: "anthropic", baseUrl: "https://api.anthropic.com", subscriptionToken: true),
            .key(runtime: "codex", presetSlug: "openai", baseUrl: "https://api.openai.com/v1", subscriptionToken: false),
            .key(runtime: "kimi", presetSlug: "moonshot", baseUrl: "https://api.moonshot.ai/v1", subscriptionToken: false),
            .key(runtime: "antigravity", presetSlug: "gemini", baseUrl: "https://generativelanguage.googleapis.com",
                 subscriptionToken: false),
        ]
        for credential in others {
            XCTAssertFalse(ProviderEngines.credentialEngines(credential).contains("cursor"), "\(credential)")
            XCTAssertFalse(ProviderEngines.isCompatible("cursor", credential), "\(credential)")
        }
        // No key dialect is Cursor CLI's (its API key is P2's): a row on a `cursor` runtime runs nowhere.
        XCTAssertNil(OpenCodeKeys.dialect("cursor"))
        XCTAssertEqual(ProviderEngines.credentialEngines(.key(runtime: "cursor", presetSlug: nil,
                                                              baseUrl: "https://api2.cursor.sh", subscriptionToken: false)), [])
        for near in ["Cursor", "cursor-cli", "cursor-agent", "agent", " cursor"] {
            XCTAssertFalse(ProviderEngines.isEngine(near), near)
        }
    }

    func testCursorCLIAloneIsNotDrawnYet() {
        XCTAssertFalse(ProviderEngines.appleShowsEngine("cursor"))
        XCTAssertEqual(ProviderEngines.all.filter(ProviderEngines.appleShowsEngine),
                       ["claude", "codex", "kimi", "antigravity", "opencode", "dsh"])
    }

    /// A runner reporting Cursor CLI and a key that runs it change no list of engines: the new-session
    /// hero's, Infrastructure's cards, a machine's Engines rows and both attention lists read as they do
    /// without them.
    func testNoListOfEnginesOffersCursorCLIThoughARunnerReportsItAndAKeyRunsIt() throws {
        let withCursor = try runner(claude, cursor)
        let without = try runner(claude)
        let hero = SessionProviderChoices.engines(sources: ChoiceSources(configured: [cursorKey, glm], engines: withCursor.engines))
        XCTAssertEqual(hero, SessionProviderChoices.engines(sources: ChoiceSources(configured: [glm], engines: without.engines)))
        XCTAssertFalse(hero.contains { $0.slug == "cursor" })
        let cards = Infrastructure.engineCards(runners: [withCursor], keys: [cursorKey, glm], pools: [])
        XCTAssertEqual(cards.map(\.name), ["Claude Code", "Codex", "Kimi Code", "Antigravity CLI", "OpenCode", "DeepSeek Harness"])
        XCTAssertEqual(cards, Infrastructure.engineCards(runners: [without], keys: [glm], pools: []))
        // A machine's rows: its report of Cursor CLI is not drawn, while an engine this build doesn't know
        // yet still is, after the rest.
        XCTAssertEqual(RunnerPageFormat.engines(withCursor).map(\.engine), ["claude", "antigravity"])
        XCTAssertEqual(RunnerPageFormat.engines(try runner(cursor, claude, #"{"engine":"next-cli","installed":true}"#)).map(\.engine),
                       ["claude", "antigravity", "next-cli"])
        // Neither attention list raises Cursor CLI: not its failing updates, nor its sign-in out under a
        // workspace that runs on it.
        let workspace = try decode(Agent.self, onCursor)
        let items = RunnerAttention.runnerAttention(runner: withCursor, workspaces: [workspace], nowMs: nowMs, latestVersion: nil)
        XCTAssertEqual(items, RunnerAttention.runnerAttention(runner: without, workspaces: [workspace], nowMs: nowMs,
                                                               latestVersion: nil))
        XCTAssertFalse(items.contains { ($0.short + $0.title + $0.detail).contains("Cursor") })
        XCTAssertEqual(Infrastructure.attention(runners: [withCursor], memberPools: [], ownPools: []), [])
    }

    /// The Engine field lists what these apps draw; a task the API pinned to Cursor CLI keeps its pin as
    /// a choice, so the field still says what is pinned.
    func testATasksEngineFieldListsTheEnginesDrawnAndItsOwnPin() throws {
        func pin(_ json: String) throws -> TaskRunPin {
            TaskRunPin(task: try decode(TaskItem.self, json), assignee: nil, configured: [cursorKey])
        }
        let six = ["claude", "codex", "kimi", "antigravity", "opencode", "dsh"]
        XCTAssertEqual(try pin(#"{"id":"1","title":"a","status":"OPEN"}"#).engineChoices, six)
        XCTAssertEqual(try pin(#"{"id":"2","title":"a","status":"OPEN","engine":"codex"}"#).engineChoices, six)
        let onCursor = try pin(#"{"id":"3","title":"a","status":"OPEN","engine":"cursor","provider":"cursor"}"#)
        XCTAssertEqual(onCursor.pinnedEngine, "cursor")
        XCTAssertEqual(onCursor.runEngine, "cursor")
        XCTAssertEqual(onCursor.engineChoices, six + ["cursor"])
        XCTAssertEqual(ProviderEngines.cliName(onCursor.runEngine), "Cursor CLI")
    }

    /// What the server says of Cursor CLI decodes as what it is: a session's own engine, never another's;
    /// a runner's whole row, its report of Cursor CLI included; a key that runs it; a workspace that last
    /// ran on it; and the refusal that now names seven engines, in the server's own words.
    func testASessionARunnerAWorkspaceAndARefusalOnCursorDecode() throws {
        let session = try decode(Session.self, #"{"id":"s","status":"RUNNING","engine":"cursor","provider":"cursor","model":"default[]"}"#)
        XCTAssertEqual(session.engine, "cursor")
        XCTAssertEqual(ProviderEngines.sessionEngine(session.engine, provider: session.provider, configured: [cursorKey]), "cursor")
        XCTAssertEqual(SessionProviderChoices.engineTitle("cursor"), "Cursor CLI")
        let reported = try runner(claude, cursor)
        XCTAssertEqual(reported.engines?.map(\.engine), ["claude", "cursor"])
        XCTAssertEqual(reported.engines?.last?.update?.latest, "2026.10.16-e3cb207")
        XCTAssertEqual(ProviderEngines.of(cursorKey), ["cursor"])
        XCTAssertEqual(ProviderEngines.engines(ofProvider: "cursor-key", configured: [cursorKey]), ["cursor"])
        XCTAssertEqual(try decode(Agent.self, onCursor).defaultEngine(configured: []), "cursor")
        let message = #"engine "gpt" is not one of claude, codex, kimi, antigravity, opencode, dsh, cursor"#
        let body = #"{"statusCode":400,"code":"ENGINE_UNKNOWN","message":"engine \"gpt\" is not one of claude, codex, kimi, antigravity, opencode, dsh, cursor"}"#
        XCTAssertEqual(APIClient.failureReason(APIError.http(status: 400, body: body)), message)
    }
}
