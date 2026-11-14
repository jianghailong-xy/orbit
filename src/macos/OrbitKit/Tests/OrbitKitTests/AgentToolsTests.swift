import Foundation
import XCTest
@testable import OrbitKit

/// What the Agent Tools sheet says (docs/mocks/agent-tools/01-board.png ⑤), read off the session's report and the
/// generated guide (src/runner-go/agent_tools_guide.go): the connection in the engine's own words, the tools and
/// why some are short, and the instructions the engine reads in the order measured on Claude Code 2.1.325 and
/// Codex 0.167.2. The same expectations as the web's (src/web/src/lib/agentTools.test.ts).
final class AgentToolsTests: XCTestCase {
    private let guide = AgentToolsGuide.shared

    /// The report as the runner sends it (agent_tools_report.go): connected, every family served, with any
    /// top-level field replaced by the JSON given for it.
    private func report(_ overrides: [String: String] = [:]) throws -> AgentToolsReport {
        var fields: [String: String] = [
            "v": "1",
            "at": #""2026-11-14T13:00:00Z""#,
            "engine": #""claude""#,
            "engineVersion": #""2.1.325""#,
            "runnerVersion": #""0.1.261""#,
            "versions": #"{"contract": "1.8.0", "catalog": "1.7.0", "primer": "1.2.0", "guide": "1.1.0", "playbooks": "1.0.0"}"#,
            "mcp": #"{"status": "connected", "tools": 102}"#,
            "families": families { #""served": \#($0.tools?.count ?? 1), "total": \#($0.tools?.count ?? 1)"# },
            "switches": #"{"orchestration": true, "watches": true, "wiki": true}"#,
            "permissionMode": #""default""#,
            "instructions": #"{"carrier": "append_system_prompt", "workspace": true, "workspaceChars": 412}"#,
            "skill": #"{"name": "orbit:playbooks", "offered": true, "loaded": true}"#,
        ]
        fields.merge(overrides) { _, override in override }
        let json = "{" + fields.map { "\"\($0.key)\": \($0.value)" }.joined(separator: ", ") + "}"
        return try JSONDecoder().decode(AgentToolsReport.self, from: Data(json.utf8))
    }

    /// Every family the guide declares, as JSON, with the counts `counts` writes for each.
    private func families(_ counts: (AgentToolsGuide.Family) -> String) -> String {
        "[" + guide.families.map { #"{"id": "\#($0.id)", \#(counts($0))}"# }.joined(separator: ", ") + "]"
    }

    /// Codex could not start Orbit's server, with orchestration off: the web drawer test's `failed`.
    private func failed() throws -> AgentToolsReport {
        try report([
            "engine": #""codex""#,
            "engineVersion": #""0.167.2""#,
            "mcp": #"{"status": "failed", "tools": 0, "detail": "MCP client for `orbit` failed to start: handshaking with MCP server failed: connection closed"}"#,
            "families": families {
                #""served": 0, "total": \#($0.tools?.count ?? 1), "reason": "\#($0.id == "orchestration" ? "orchestration" : "not_connected")""#
            },
            "switches": #"{"orchestration": false, "watches": true, "wiki": true}"#,
            "instructions": #"{"carrier": "additional_context"}"#,
            "skill": #"{"name": "orbit-playbooks", "offered": true}"#,
        ])
    }

    // MARK: - The guide

    func testTheGeneratedGuideDecodes() throws {
        let decoded = try AgentToolsGuide.decode(agentToolsGuideJSON)
        XCTAssertFalse(decoded.guideVersion.isEmpty)
        XCTAssertEqual(decoded.sections.map(\.title), [
            "MCP first, the CLI by exception",
            "Your record and the agent's private plan",
            "Which object a request belongs to",
            "Creating is not starting",
            "When the CLI is the right tool",
            "When something is missing",
        ])
        XCTAssertEqual(decoded.examples.count, 4)
        XCTAssertFalse(decoded.troubleshooting.isEmpty)
        XCTAssertEqual(decoded.families.map(\.id), [
            "tasks", "projects", "task-lists", "waits", "files", "background", "owner", "wiki", "providers",
            "merge-receipts", "guide", "orchestration",
        ])
        XCTAssertEqual(Set(decoded.instructions.keys), ["claude", "codex"])
        XCTAssertEqual(Set(decoded.permissionModes.map(\.mode)),
                       Set(PermissionMode.allCases.map(\.rawValue)), "every mode the composer offers is explained")
        XCTAssertFalse(decoded.instructionsNote.isEmpty)
        XCTAssertFalse(decoded.orchestration.on.isEmpty)
        XCTAssertFalse(decoded.orchestration.off.isEmpty)
        // And the copy the app reads is that document, not the empty fallback.
        XCTAssertEqual(guide.guideVersion, decoded.guideVersion)
        XCTAssertEqual(guide.sections.count, 6)
    }

    // MARK: - Status

    func testConnectedSaysTheEngineAndItsToolCountInTheGuidesWords() throws {
        let status = AgentTools.status(try report(), engine: "claude")
        XCTAssertEqual(status.word, "Connected")
        XCTAssertEqual(status.tone, .ok)
        XCTAssertEqual(status.line, "Claude Code 2.1.325 started Orbit's MCP server and lists 102 Orbit tools.")
        XCTAssertNil(status.detail)
        XCTAssertNil(status.fallback)
    }

    func testFailedCarriesTheEnginesOwnReasonAndWhatStillWorks() throws {
        let status = AgentTools.status(try failed(), engine: "codex")
        XCTAssertEqual(status.word, "Not connected")
        XCTAssertEqual(status.tone, .bad)
        XCTAssertEqual(status.line, "Codex 0.167.2 could not start Orbit's MCP server.")
        XCTAssertEqual(status.detail,
                       "MCP client for `orbit` failed to start: handshaking with MCP server failed: connection closed")
        XCTAssertEqual(status.fallback, guide.status["fallback"])
        XCTAssertNotNil(status.fallback)
    }

    func testASessionWithNoReportHasNotReportedAndSaysWhyByEngine() {
        XCTAssertEqual(AgentTools.status(nil, engine: "claude").word, "Not reported")
        XCTAssertEqual(AgentTools.status(nil, engine: "claude").line,
                       "Claude Code has not reported its connection yet: the runner sends it when the engine starts, and a runner older than this feature never does.")
        XCTAssertEqual(AgentTools.status(nil, engine: "kimi").line, guide.status["not_reported"])
        XCTAssertEqual(AgentTools.status(nil, engine: nil).tone, .quiet)
    }

    func testEveryStatusTheRunnerSendsReads() throws {
        for status in ["connected", "starting", "failed", "needs_auth", "cancelled", "not_configured", "something_newer"] {
            let line = AgentTools.status(try report(["mcp": #"{"status": "\#(status)", "tools": 0}"#]), engine: "claude").line
            XCTAssertFalse(line.isEmpty, status)
            XCTAssertFalse(line.contains("{engine}"), status)
            XCTAssertFalse(line.contains("{tools}"), status)
        }
    }

    func testReportedAndVersions() throws {
        let connected = try report()
        let now = try XCTUnwrap(RelativeTime.parse("2026-11-14T13:03:00Z"))
        XCTAssertEqual(AgentTools.reported(connected, now: now), "Reported 3m ago")
        XCTAssertEqual(AgentTools.versions(connected), "Contract 1.8.0 · Catalogue 1.7.0 · Primer 1.2.0")
        XCTAssertNil(AgentTools.reported(try report(["at": #""""#]), now: now))
    }

    // MARK: - Tools

    func testFamiliesAreLabelledAndEachReasonIsSaidOnce() throws {
        let short = try report([
            "families": #"""
            [{"id": "tasks", "served": 21, "total": 21},
             {"id": "wiki", "served": 0, "total": 5, "reason": "wiki"},
             {"id": "orchestration", "served": 0, "total": 22, "reason": "orchestration"}]
            """#,
            "switches": #"{"orchestration": false, "watches": true, "wiki": false}"#,
        ])
        let wikiOff = try XCTUnwrap(guide.switchReasons["wiki"])
        XCTAssertEqual(AgentTools.familyRows(short).map(\.label), ["Tasks", "Wiki", "Sessions, agents and runners"])
        XCTAssertEqual(AgentTools.familyRows(short).map(\.tone), [.ok, .quiet, .quiet])
        XCTAssertEqual(AgentTools.withheldReasons(short), [wikiOff, guide.orchestration.off])
        // The sheet says Session orchestration's reason on that row, and the rest under the tools.
        XCTAssertEqual(AgentTools.withheldReasons(short, excluding: ["orchestration"]), [wikiOff])
        XCTAssertEqual(AgentTools.toolsRows(short).map { "\($0.text)|\($0.word)" }, [
            "Tasks 21|Available",
            "Wiki 5|Off",
            "Sessions, agents and runners · 22|Off",
        ])
    }

    func testToolsRowsGroupAsTheBoardDraws() throws {
        let rows = AgentTools.toolsRows(try report())
        XCTAssertEqual(rows.count, 2, "every family but orchestration on one row, orchestration on its own")
        let others = guide.families.filter { $0.id != "orchestration" }
        XCTAssertEqual(rows[0].text, others.map { "\($0.label) \($0.tools?.count ?? 1)" }.joined(separator: " · "))
        XCTAssertTrue(rows[0].text.hasPrefix("Tasks 21 · Projects 19 · Task lists 6"), rows[0].text)
        XCTAssertEqual(rows[0].word, "Available")
        XCTAssertEqual(rows[0].tone, .ok)
        XCTAssertEqual(rows[1].text, "Sessions, agents and runners · 22")
        XCTAssertEqual(rows[1].word, "Available")

        let down = AgentTools.toolsRows(try failed())
        XCTAssertEqual(down.map(\.word), ["Not connected", "Off"])
        XCTAssertEqual(down.map(\.tone), [.bad, .quiet])
        XCTAssertEqual(AgentTools.withheldReasons(try failed(), excluding: ["orchestration"]),
                       ["Not connected: none of these reach the agent while the MCP server is down."])

        // A family the engine lists only some of keeps its count; one it lists none of, for no switch, is unlisted.
        let partial = AgentTools.toolsRows(try report(["families": #"""
            [{"id": "waits", "served": 1, "total": 6, "reason": "watches"}, {"id": "files", "served": 0, "total": 4}]
            """#]))
        XCTAssertEqual(partial.map { "\($0.text)|\($0.word)" }, ["Waits 1 of 6|Available", "Files 4|Not listed"])
    }

    // MARK: - Instructions

    private func layers(_ engine: String, base: Bool = false, workspace: Bool, carrier: String) -> [String] {
        AgentTools.layers(engine, AgentTools.LayerFacts(base: base, workspace: workspace, carrier: carrier))
            .map { "\($0.id):\($0.roleLabel)" }
    }

    func testClaudeCodeIsLaidOutAsMeasured() {
        XCTAssertEqual(layers("claude", workspace: true, carrier: "append_system_prompt"), [
            "engine:System",
            "workspace:System · appended",
            "orbit:System · appended",
            "repository:Project context",
            "person:User",
            "mcp:System message",
            "skill:On demand",
        ])
        // No workspace instructions, no workspace layer.
        XCTAssertFalse(layers("claude", workspace: false, carrier: "append_system_prompt")
            .contains { $0.hasPrefix("workspace") })
    }

    func testBaseInstructionsTakeTheEnginesPlace() {
        XCTAssertEqual(Array(layers("claude", base: true, workspace: false, carrier: "append_system_prompt").prefix(2)), [
            "workspace-base:System",
            "orbit:System · appended",
        ])
        let codex = layers("codex", base: true, workspace: false, carrier: "additional_context")
        XCTAssertEqual(codex.first, "workspace-base:Developer")
        XCTAssertFalse(codex.contains("engine:Developer"))
    }

    func testCodexIsLaidOutByItsCarrierWithDeveloperForTheRuntimeInstructions() {
        XCTAssertEqual(layers("codex", workspace: true, carrier: "additional_context"), [
            "engine:Developer",
            "skill:On demand",
            "repository:Project context",
            "workspace:Developer",
            "orbit:Developer",
            "person:User",
            "mcp:With the tools",
        ])
        XCTAssertTrue(layers("codex", workspace: false, carrier: "turn_input").contains("orbit:User · turn input"))
        XCTAssertTrue(layers("codex", workspace: false, carrier: "developer_message").contains("orbit:Developer"))
        XCTAssertEqual(layers("kimi", workspace: true, carrier: "append_system_prompt"), [], "only measured engines")
    }

    func testASessionsFactsComeFromItsReportElseTheEnginesCarrier() throws {
        XCTAssertEqual(AgentTools.facts(try failed(), engine: "codex"),
                       AgentTools.LayerFacts(base: false, workspace: false, carrier: "additional_context"))
        XCTAssertEqual(AgentTools.facts(nil, engine: "codex").carrier, "additional_context")
        XCTAssertEqual(AgentTools.facts(nil, engine: "claude").carrier, "append_system_prompt")
        XCTAssertEqual(AgentTools.facts(try report(), engine: "claude"),
                       AgentTools.LayerFacts(base: false, workspace: true, carrier: "append_system_prompt"))
    }

    func testALayersLineSaysThePlaybooksFateAndTheWorkspacesLength() throws {
        let connected = try report()
        let claude = AgentTools.layers("claude", AgentTools.facts(connected, engine: "claude"))
        let skill = try XCTUnwrap(claude.first { $0.id == "skill" })
        let workspace = try XCTUnwrap(claude.first { $0.id == "workspace" })
        XCTAssertEqual(AgentTools.detail(skill, skill: connected.skill, workspaceChars: 412), "Loaded. " + skill.detail)
        XCTAssertEqual(AgentTools.detail(workspace, skill: connected.skill, workspaceChars: 412),
                       workspace.detail + " 412 characters.")
        XCTAssertEqual(AgentTools.detail(workspace, skill: nil, workspaceChars: nil), workspace.detail)
        XCTAssertEqual(AgentTools.skillWord(.init(name: "x", offered: false, loaded: nil, reason: nil)), "Not offered. ")
        XCTAssertEqual(AgentTools.skillWord(.init(name: "x", offered: true, loaded: false, reason: nil)),
                       "Offered, but the engine did not list it. ")
        XCTAssertEqual(AgentTools.skillWord(.init(name: "x", offered: true, loaded: nil, reason: nil)), "Offered. ")
        // Counted as the runner counts it: trimmed, in characters.
        XCTAssertEqual(AgentTools.characters("  Use pnpm, never npm.\n"), 20)
        XCTAssertEqual(AgentTools.characters("   "), 0)
    }

    // MARK: - Modes and switches

    func testEachPermissionModeSaysWhatItMeansForOrbitsCalls() {
        XCTAssertTrue(AgentTools.mode("plan")?.orbit.contains("SESSION_IN_PLAN_MODE") == true)
        XCTAssertEqual(AgentTools.mode("default")?.label, "Default")
        XCTAssertNil(AgentTools.mode("bogus"))
        XCTAssertNil(AgentTools.mode(nil))
    }

    func testOrchestrationSaysTheSwitchAndWhatChangedSinceTheEngineStarted() throws {
        XCTAssertEqual(AgentTools.orchestration(true), guide.orchestration.on)
        XCTAssertEqual(AgentTools.orchestration(false), guide.orchestration.off)
        let startedOff = try failed()
        XCTAssertEqual(AgentTools.orchestrationChanged(startedOff, orchestrationOn: true),
                       "Session orchestration was turned on after this engine started: its session, agent and runner tools arrive when the engine next starts.")
        XCTAssertNil(AgentTools.orchestrationChanged(startedOff, orchestrationOn: false))
        XCTAssertNil(AgentTools.orchestrationChanged(nil, orchestrationOn: true))
        XCTAssertNil(AgentTools.orchestrationChanged(try report(["switches": "null"]), orchestrationOn: false),
                     "a report that names no switches is not a change")
    }

    // MARK: - The sheet's own words (board ⑤)

    func testTheSheetsHeadersAreTheBoards() {
        XCTAssertEqual(AgentToolsCopy.title, "Agent Tools")
        XCTAssertEqual(AgentToolsCopy.workspaceTitle("orbit-op"), "Agent Tools · orbit-op")
        XCTAssertEqual(AgentToolsCopy.settingsButton, "Agent Tools…")
        XCTAssertEqual(AgentToolsCopy.toolsListed(102), "Tools · 102")
        XCTAssertEqual(AgentToolsCopy.instructions("claude"), "Instructions, in the order Claude Code reads them")
        XCTAssertEqual(AgentToolsCopy.instructions("codex"), "Instructions, in the order Codex reads them")
        XCTAssertEqual(AgentToolsCopy.symptoms(13), "13 symptoms")
        XCTAssertEqual(AgentToolsCopy.examples(4), "4 examples")
        XCTAssertEqual(AgentToolsCopy.quoted("Run it now."), "“Run it now.”")
        XCTAssertEqual(AgentToolsCopy.proof("the receipt"), "Proof: the receipt")
    }

    // MARK: - On the session's detail

    private func detail(_ json: String) throws -> SessionDetail {
        try JSONDecoder().decode(SessionDetail.self, from: Data(json.utf8))
    }

    func testTheSessionDetailCarriesTheReport() throws {
        let read = try detail("""
        {"id": "s1", "branch": "orbit/x", "agentTools": {
          "v": 1, "at": "2026-11-14T13:00:00Z", "engine": "claude", "engineVersion": "2.1.325",
          "versions": {"contract": "1.8.0", "catalog": "1.7.0", "primer": "1.2.0", "guide": "1.1.0", "playbooks": "1.0.0"},
          "mcp": {"status": "connected", "tools": 102},
          "families": [{"id": "tasks", "served": 21, "total": 21}, {"id": "wiki", "served": 0, "total": 5, "reason": "wiki"}],
          "switches": {"orchestration": true, "watches": true, "wiki": false},
          "permissionMode": "plan",
          "instructions": {"carrier": "append_system_prompt", "workspace": true, "workspaceChars": 412},
          "skill": {"name": "orbit:playbooks", "offered": true, "loaded": true}
        }}
        """)
        let tools = try XCTUnwrap(read.agentTools)
        XCTAssertEqual(read.branch, "orbit/x")
        XCTAssertEqual(tools.engine, "claude")
        XCTAssertEqual(tools.mcp, .init(status: "connected", detail: nil, tools: 102))
        XCTAssertEqual(tools.families.map(\.id), ["tasks", "wiki"])
        XCTAssertEqual(tools.families.last?.reason, "wiki")
        XCTAssertEqual(tools.switches?.wiki, false)
        XCTAssertEqual(tools.permissionMode, "plan")
        XCTAssertEqual(tools.instructions?.workspaceChars, 412)
        XCTAssertEqual(tools.skill?.loaded, true)
        XCTAssertEqual(AgentTools.status(tools, engine: nil).line,
                       "Claude Code 2.1.325 started Orbit's MCP server and lists 102 Orbit tools.")
        // And it survives the detail's own round trip.
        XCTAssertEqual(try JSONDecoder().decode(SessionDetail.self, from: JSONEncoder().encode(read)), read)
    }

    func testADetailWithoutAReportHasNone() throws {
        XCTAssertNil(try detail(#"{"id": "s1"}"#).agentTools)
        XCTAssertNil(try detail(#"{"id": "s1", "agentTools": null}"#).agentTools)
        XCTAssertNil(SessionDetail(id: "s1").agentTools)
    }

    func testAReportThisBuildCannotReadNeverCostsTheDetail() throws {
        for value in [#""garbage""#, "[1, 2]", "42", "true"] {
            let read = try detail(#"{"id": "s1", "branch": "orbit/x", "agentTools": \#(value)}"#)
            XCTAssertEqual(read.id, "s1", value)
            XCTAssertEqual(read.branch, "orbit/x", value)
            XCTAssertNil(read.agentTools, value)
        }
        // A report with fields of the wrong type keeps the fields it can read.
        let odd = try detail(#"{"id": "s1", "agentTools": {"engine": "codex", "mcp": 5, "families": "x", "skill": {"offered": "yes"}}}"#)
        let tools = try XCTUnwrap(odd.agentTools)
        XCTAssertEqual(tools.engine, "codex")
        XCTAssertEqual(tools.mcp.status, "")
        XCTAssertEqual(tools.families, [])
        XCTAssertEqual(tools.skill?.offered, false)
        XCTAssertEqual(AgentTools.status(tools, engine: "codex").word, "Not connected")
    }
}

/// Where the sheet says what the web's drawer says, it says it in the drawer's words: each is looked up in the web
/// source it came from (whitespace folded, as JSX breaks lines where it likes). A missing web file is a failure,
/// never a skip.
final class AgentToolsCopyParityTests: XCTestCase {
    private static let lib = "src/web/src/lib/agentTools.ts"
    private static let drawer = "src/web/src/components/AgentToolsDrawer.tsx"
    private static let settings = "src/web/src/components/settings/WorkspaceSettingsPage.tsx"

    private struct Missing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "\(path) was not found above this test file. The Mac's Agent Tools sheet is one half of a pair; "
                + "if the web half moved, move this check with it rather than deleting it."
        }
    }

    private func web(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
                    .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw Missing(path: relative)
    }

    private func assertSays(_ source: String, _ literal: String, in file: String,
                            file testFile: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(source.contains(literal), "\(file) no longer says \(literal)", file: testFile, line: line)
    }

    func testTheStatusAndTheReasonsAreTheLibsWords() throws {
        let lib = try web(Self.lib)
        for word in ["Not reported", "Connected", "Starting", "Not connected"] {
            assertSays(lib, "word: '\(word)'", in: Self.lib)
        }
        let unreported = AgentTools.status(nil, engine: "claude").line
        assertSays(lib, String(unreported.dropFirst("Claude Code ".count)), in: Self.lib)
        assertSays(lib, "'Not connected: none of these reach the agent while the MCP server is down.'", in: Self.lib)
        assertSays(lib, "return 'This engine'", in: Self.lib)
        assertSays(lib, "'additional_context' : 'append_system_prompt'", in: Self.lib)
    }

    func testTheSheetSaysWhatTheDrawerSays() throws {
        let drawer = try web(Self.drawer)
        for words in [AgentToolsCopy.sessionLead, AgentToolsCopy.toolsPending, AgentToolsCopy.howAgentsUseOrbit,
                      AgentToolsCopy.tryAsking, AgentToolsCopy.permissionMode] {
            assertSays(drawer, words, in: Self.drawer)
        }
        // The workspace's lead, up to where the web names its menu and the Mac its toolbar.
        assertSays(drawer, "What a session in this workspace is given. Its live connection is on the session:",
                   in: Self.drawer)
        XCTAssertTrue(AgentToolsCopy.workspaceLead.hasPrefix(
            "What a session in this workspace is given. Its live connection is on the session:"))
        func started(_ on: Bool) throws -> AgentToolsReport {
            try JSONDecoder().decode(AgentToolsReport.self, from: Data(#"{"switches": {"orchestration": \#(on)}}"#.utf8))
        }
        for note in [AgentTools.orchestrationChanged(try started(false), orchestrationOn: true),
                     AgentTools.orchestrationChanged(try started(true), orchestrationOn: false)] {
            assertSays(drawer, try XCTUnwrap(note), in: Self.drawer)
        }
        for skill in [AgentToolsReport.Skill(name: "", offered: false, loaded: nil, reason: nil),
                      .init(name: "", offered: true, loaded: true, reason: nil),
                      .init(name: "", offered: true, loaded: false, reason: nil),
                      .init(name: "", offered: true, loaded: nil, reason: nil)] {
            assertSays(drawer, "'\(AgentTools.skillWord(skill))'", in: Self.drawer)
        }
        assertSays(drawer, "`Not offered: ${skill.reason} `", in: Self.drawer)
        assertSays(drawer, String(AgentToolsCopy.unmeasured("kimi").dropFirst("Kimi ".count)), in: Self.drawer)
        assertSays(drawer, "` ${workspaceChars} characters.`", in: Self.drawer)
        assertSays(drawer, "symptoms", in: Self.drawer)
        assertSays(drawer, "examples", in: Self.drawer)
        assertSays(drawer, "Proof: {ex.proof}", in: Self.drawer)
        assertSays(drawer, "`“${a}”`).join(' · ')", in: Self.drawer)
        XCTAssertEqual(AgentToolsCopy.asks(["a", "b"]), "Try asking: “a” · “b”")
    }

    func testTheSettingsRowSaysWhatTheWebsDoes() throws {
        assertSays(try web(Self.settings), AgentToolsCopy.workspaceRow, in: Self.settings)
    }
}
