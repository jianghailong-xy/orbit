import XCTest
@testable import OrbitKit

/// Cursor CLI, the seventh engine (project P1; shared `cursor-engine.spec.ts`). The mirror knows it, so a
/// session, a task, a workspace or a runner's report on it decodes as what it is; and no list of engines
/// here offers it until a runner of the account knows it (`ProviderEngines.appleShowsEngine`, web
/// `webShowsEngine`, P7b): before that each list reads as it did before Cursor CLI was registered.
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
                                               presetSlug: "cursor-api", enabled: true, engines: ["cursor"])
    private let glm = ConfiguredProvider(slug: "glm", label: "Z.AI (GLM)", runtime: "claude", presetSlug: "glm",
                                         enabled: true, engines: ["claude", "opencode"])
    /// A workspace whose last session ran on this runner's Cursor CLI sign-in.
    private let onCursor = #"{"id":"w","name":"orbit","lastProvider":"cursor","lastEngine":"cursor"}"#

    private func runner(_ engines: String...) throws -> Runner {
        try runner(capabilities: #"["provider:cursor"]"#, engines)
    }

    /// A runner that predates Cursor CLI: it declares nothing of it and reports no such engine.
    private func olderRunner(_ engines: String...) throws -> Runner {
        try runner(capabilities: "[]", engines, id: "old", name: "mac-studio")
    }

    private func runner(capabilities: String, _ engines: [String], id: String = "r", name: String = "hpc") throws -> Runner {
        let json = #"{"id":""# + id + #"","name":""# + name + #"","online":true,"lastHeartbeatAt":"2026-10-17T08:59:50.000Z","#
            + #""capabilities":"# + capabilities + #","engines":["# + engines.joined(separator: ",") + "]}"
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
        // A Cursor User API Key speaks Cursor's own dialect (shared `keyDialect('cursor')`, P2): only Cursor
        // CLI spends it — no other engine, OpenCode neither, which has no model API to call with it.
        XCTAssertEqual(OpenCodeKeys.dialect("cursor"), .cursor)
        let key = ProviderEngines.Credential.key(runtime: "cursor", presetSlug: "cursor-api",
                                                 baseUrl: "https://api2.cursor.sh", subscriptionToken: false)
        XCTAssertEqual(ProviderEngines.credentialEngines(key), ["cursor"])
        XCTAssertEqual(ProviderEngines.defaultEngine(of: key), "cursor")
        for engine in ProviderEngines.all {
            XCTAssertEqual(ProviderEngines.isCompatible(engine, key), engine == "cursor", engine)
        }
        // A row from a server that predates `engines` reads the same, OpenCode or not.
        let older = ConfiguredProvider(slug: "cursor-api", label: "Cursor", runtime: "cursor", runsOnOpenCode: true)
        XCTAssertEqual(ProviderEngines.of(older), ["cursor"])
        for near in ["Cursor", "cursor-cli", "cursor-agent", "agent", " cursor"] {
            XCTAssertFalse(ProviderEngines.isEngine(near), near)
        }
    }

    /// Cursor CLI is drawn once a runner of the account knows it — declares `provider:cursor`, or reports
    /// the engine, installed or not — and not before (P9: the runners first, then the entrances).
    func testCursorCLIIsDrawnOnceARunnerOfTheAccountKnowsIt() throws {
        let six = ["claude", "codex", "kimi", "antigravity", "opencode", "dsh"]
        for runners in [nil, [], [try olderRunner(claude)]] as [[Runner]?] {
            XCTAssertFalse(ProviderEngines.appleShowsEngine("cursor", runners: runners))
            XCTAssertEqual(ProviderEngines.all.filter { ProviderEngines.appleShowsEngine($0, runners: runners) }, six)
        }
        let declares = try runner(claude)
        let reports = try runner(capabilities: "[]", [#"{"engine":"cursor","installed":false,"auth":"unknown"}"#])
        for known in [declares, reports] {
            XCTAssertTrue(ProviderEngines.appleShowsEngine("cursor", runners: [try olderRunner(claude), known]))
        }
        XCTAssertEqual(ProviderEngines.all.filter { ProviderEngines.appleShowsEngine($0, runners: [declares]) },
                       six + ["cursor"])
    }

    /// Until a runner knows Cursor CLI, a key that runs it changes no list of engines: the new-session
    /// hero's, a machine's Engines rows and both attention lists read as they do without it. Once one
    /// does, Cursor CLI is the last of each — on a machine that predates it too, whose row says so.
    func testCursorCLIJoinsEveryListOfEnginesLastOnceARunnerKnowsIt() throws {
        let older = try olderRunner(claude)
        let hero = SessionProviderChoices.engines(sources: ChoiceSources(configured: [cursorKey, glm], engines: older.engines))
        XCTAssertEqual(hero, SessionProviderChoices.engines(sources: ChoiceSources(configured: [glm], engines: older.engines)))
        XCTAssertFalse(hero.contains { $0.slug == "cursor" })
        XCTAssertEqual(RunnerPageFormat.engines(older).map(\.engine), ["claude", "antigravity"])

        let withCursor = try runner(claude, cursor)
        let shown = SessionProviderChoices.engines(sources: ChoiceSources(
            configured: [cursorKey, glm], engines: withCursor.engines,
            cursorState: CursorRuntime.state(of: withCursor), showsCursor: true))
        XCTAssertEqual(shown.last?.slug, "cursor")
        XCTAssertEqual(shown.last?.label, "Cursor CLI")
        // A machine's rows: Cursor CLI last, after an engine this build doesn't know yet — and on the machine
        // that predates it, beside a fleet that knows it, a row of its own to say it needs an update.
        XCTAssertEqual(RunnerPageFormat.engines(try runner(cursor, claude, #"{"engine":"next-cli","installed":true}"#)).map(\.engine),
                       ["claude", "antigravity", "next-cli", "cursor"])
        XCTAssertEqual(RunnerPageFormat.engines(older, fleet: [withCursor, older]).map(\.engine), ["claude", "antigravity", "cursor"])
        XCTAssertEqual(RunnerPageFormat.engineStatus(RunnerPageFormat.engines(older, fleet: [withCursor, older]).last!, runner: older),
                       RunnerPageFormat.Status(text: "Update runner", tone: .warn))
    }

    /// The Engine field lists what these apps draw with the account's runners in view; a task the API
    /// pinned to Cursor CLI keeps its pin as a choice, so the field still says what is pinned.
    func testATasksEngineFieldListsTheEnginesDrawnAndItsOwnPin() throws {
        func pin(_ json: String, runners: [Runner]? = nil) throws -> TaskRunPin {
            TaskRunPin(task: try decode(TaskItem.self, json), assignee: nil, configured: [cursorKey], runners: runners)
        }
        let six = ["claude", "codex", "kimi", "antigravity", "opencode", "dsh"]
        XCTAssertEqual(try pin(#"{"id":"1","title":"a","status":"OPEN"}"#).engineChoices, six)
        XCTAssertEqual(try pin(#"{"id":"2","title":"a","status":"OPEN","engine":"codex"}"#).engineChoices, six)
        XCTAssertEqual(try pin(#"{"id":"1","title":"a","status":"OPEN"}"#, runners: [try runner(claude)]).engineChoices,
                       six + ["cursor"])
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
