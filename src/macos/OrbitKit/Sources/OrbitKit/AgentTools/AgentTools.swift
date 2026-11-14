import Foundation

// What the Agent Tools sheet says (docs/mocks/agent-tools/01-board.png ⑤), worked out from two sources, as the
// web's drawer works it out (src/web/src/lib/agentTools.ts, docs/orbit-agent-contract.md §2.7):
//
//   - the session's Agent Tools report (`SessionDetail.agentTools`), which the runner sends from the engine's own
//     word — Claude Code's system/init frame, Codex's mcpServer/startupStatus/updated — and the control plane keeps;
//   - the Agent Tools guide (`AgentToolsGuide.shared`), generated from the runner's operation catalogue.
//
// Nothing here is a setting: the sheet explains, and the switches stay where they are.

/// The runner's report on one session (src/runner-go/agent_tools_report.go, version 1). Read leniently: a field
/// that is missing or of another type takes its empty value, so an older or newer runner's report still reads.
public struct AgentToolsReport: Codable, Equatable, Sendable {
    public struct Versions: Codable, Equatable, Sendable {
        public var contract: String
        public var catalog: String
        public var primer: String
        public var guide: String
        public var playbooks: String
    }

    public struct MCP: Codable, Equatable, Sendable {
        /// connected | starting | failed | needs_auth | cancelled | not_configured, as the engine said it.
        public var status: String
        /// The engine's own words when it gave a reason.
        public var detail: String?
        /// How many of Orbit's tools the session lists.
        public var tools: Int
    }

    public struct Family: Codable, Equatable, Sendable {
        public var id: String
        public var served: Int
        public var total: Int
        /// Why the family is short: not_connected, or the switch that withholds it (orchestration, watches, wiki).
        public var reason: String?
    }

    /// The account's switches as the engine was started with them.
    public struct Switches: Codable, Equatable, Sendable {
        public var orchestration: Bool
        public var watches: Bool
        public var wiki: Bool
    }

    /// How Orbit's runtime instructions reached the engine, and what the workspace added.
    public struct Instructions: Codable, Equatable, Sendable {
        public var carrier: String?
        public var base: Bool?
        public var workspace: Bool?
        public var workspaceChars: Int?
    }

    /// The playbooks skill: whether it was offered, and whether the engine listed it.
    public struct Skill: Codable, Equatable, Sendable {
        public var name: String
        public var offered: Bool
        public var loaded: Bool?
        public var reason: String?
    }

    public var v: Int
    public var at: String?
    public var engine: String
    public var engineVersion: String?
    public var runnerVersion: String?
    public var versions: Versions?
    public var mcp: MCP
    public var families: [Family]
    public var switches: Switches?
    public var permissionMode: String?
    public var instructions: Instructions?
    public var skill: Skill?
}

extension AgentToolsReport {
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        v = c.lenient(Int.self, .v) ?? 0
        at = c.lenient(String.self, .at).nonEmpty
        engine = c.lenient(String.self, .engine) ?? ""
        engineVersion = c.lenient(String.self, .engineVersion).nonEmpty
        runnerVersion = c.lenient(String.self, .runnerVersion).nonEmpty
        versions = c.lenient(Versions.self, .versions)
        mcp = c.lenient(MCP.self, .mcp) ?? MCP(status: "", detail: nil, tools: 0)
        families = c.lenient([Family].self, .families) ?? []
        switches = c.lenient(Switches.self, .switches)
        permissionMode = c.lenient(String.self, .permissionMode).nonEmpty
        instructions = c.lenient(Instructions.self, .instructions)
        skill = c.lenient(Skill.self, .skill)
    }
}

extension AgentToolsReport.Versions {
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        contract = c.lenient(String.self, .contract) ?? ""
        catalog = c.lenient(String.self, .catalog) ?? ""
        primer = c.lenient(String.self, .primer) ?? ""
        guide = c.lenient(String.self, .guide) ?? ""
        playbooks = c.lenient(String.self, .playbooks) ?? ""
    }
}

extension AgentToolsReport.MCP {
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = c.lenient(String.self, .status) ?? ""
        detail = c.lenient(String.self, .detail).nonEmpty
        tools = c.lenient(Int.self, .tools) ?? 0
    }
}

extension AgentToolsReport.Family {
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenient(String.self, .id) ?? ""
        served = c.lenient(Int.self, .served) ?? 0
        total = c.lenient(Int.self, .total) ?? 0
        reason = c.lenient(String.self, .reason).nonEmpty
    }
}

extension AgentToolsReport.Switches {
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        orchestration = c.lenient(Bool.self, .orchestration) ?? false
        watches = c.lenient(Bool.self, .watches) ?? false
        wiki = c.lenient(Bool.self, .wiki) ?? false
    }
}

extension AgentToolsReport.Instructions {
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        carrier = c.lenient(String.self, .carrier).nonEmpty
        base = c.lenient(Bool.self, .base)
        workspace = c.lenient(Bool.self, .workspace)
        workspaceChars = c.lenient(Int.self, .workspaceChars)
    }
}

extension AgentToolsReport.Skill {
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = c.lenient(String.self, .name) ?? ""
        offered = c.lenient(Bool.self, .offered) ?? false
        loaded = c.lenient(Bool.self, .loaded)
        reason = c.lenient(String.self, .reason).nonEmpty
    }
}

private extension KeyedDecodingContainer {
    /// The value at `key`, or nil when it is absent, null or of another type: one field this build cannot read
    /// leaves the rest of the report readable.
    func lenient<T: Decodable>(_ type: T.Type, _ key: Key) -> T? {
        try? decodeIfPresent(type, forKey: key)
    }
}

private extension Optional where Wrapped == String {
    /// An empty string is no value, as the web reads one (`report.at && …`, `!f.reason`).
    var nonEmpty: String? { self.flatMap { $0.isEmpty ? nil : $0 } }
}

/// What the sheet says about a session's report and a workspace's instructions: agentTools.ts, word for word,
/// and the Tools rows board ⑤ draws.
public enum AgentTools {
    /// The engines whose instructions Orbit measured and lays out (`layers`).
    public static let engines = ["claude", "codex"]

    /// How a person reads an engine's name.
    public static func engineName(_ engine: String?, guide: AgentToolsGuide = .shared) -> String {
        guard let engine, !engine.isEmpty else { return "This engine" }
        return guide.engineNames[engine] ?? engine.prefix(1).uppercased() + engine.dropFirst()
    }

    public enum Tone: String, Equatable, Sendable {
        case ok, bad, quiet
    }

    /// The status at the top of the sheet: the word beside the dot, and the line under it.
    public struct Status: Equatable, Sendable {
        public let word: String
        public let tone: Tone
        public let line: String
        /// The engine's own words, when it gave a reason.
        public let detail: String?
        /// What still works when the server is not connected.
        public let fallback: String?
    }

    /// The session's report read for a person; `engine` is the session's, for a session with no report.
    public static func status(_ report: AgentToolsReport?, engine: String?,
                              guide: AgentToolsGuide = .shared) -> Status {
        let text = guide.status
        guard let report else {
            let line = engines.contains(engine ?? "")
                ? "\(engineName(engine, guide: guide)) has not reported its connection yet: the runner sends it when the engine starts, and a runner older than this feature never does."
                : text["not_reported"] ?? ""
            return Status(word: "Not reported", tone: .quiet, line: line, detail: nil, fallback: nil)
        }
        let who = [engineName(report.engine, guide: guide), report.engineVersion ?? ""]
            .filter { !$0.isEmpty }.joined(separator: " ")
        func fill(_ template: String?) -> String {
            (template ?? "").replacingFirst("{engine}", with: who)
                .replacingFirst("{tools}", with: String(report.mcp.tools))
        }
        switch report.mcp.status {
        case "connected":
            return Status(word: "Connected", tone: .ok, line: fill(text["connected"]), detail: nil, fallback: nil)
        case "starting":
            return Status(word: "Starting", tone: .quiet, line: fill(text["starting"]), detail: nil, fallback: nil)
        default:
            return Status(word: "Not connected", tone: .bad, line: fill(text[report.mcp.status] ?? text["failed"]),
                          detail: report.mcp.detail, fallback: text["fallback"])
        }
    }

    /// "Reported 3m ago": when the runner last sent the report (the web's `ago`, `RunnerAttention.ago`).
    public static func reported(_ report: AgentToolsReport, now: Date) -> String? {
        guard let at = report.at else { return nil }
        return "Reported " + RunnerAttention.ago(at, nowMs: Int64((now.timeIntervalSince1970 * 1_000).rounded()))
    }

    /// The versions row: the agent contract, operation catalogue and primer the session's runner carries.
    public static func versions(_ report: AgentToolsReport) -> String? {
        guard let v = report.versions else { return nil }
        let parts = [("Contract", v.contract), ("Catalogue", v.catalog), ("Primer", v.primer)]
            .filter { !$0.1.isEmpty }.map { "\($0.0) \($0.1)" }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// One family: its label, how many of its tools the session has, and why not all.
    public struct FamilyRow: Equatable, Sendable, Identifiable {
        public let id: String
        public let label: String
        public let served: Int
        public let total: Int
        public let tone: Tone
        public let reason: String?
    }

    public static func familyRows(_ report: AgentToolsReport, guide: AgentToolsGuide = .shared) -> [FamilyRow] {
        let labels = Dictionary(guide.families.map { ($0.id, $0.label) }, uniquingKeysWith: { first, _ in first })
        return report.families.map { family in
            let tone: Tone = family.served > 0 ? .ok : family.reason == "not_connected" ? .bad : .quiet
            return FamilyRow(id: family.id, label: labels[family.id] ?? family.id, served: family.served,
                             total: family.total, tone: tone, reason: family.reason)
        }
    }

    /// One row of the sheet's Tools section (board ⑤): the families in one state, each with its count —
    /// "Tasks 21 · Projects 19 · …" — beside the state's word. Session orchestration's family keeps a row of its
    /// own, "Sessions, agents and runners · 22", as the switch it answers to does.
    public struct ToolsRow: Equatable, Sendable, Identifiable {
        public let id: String
        public let text: String
        public let word: String
        public let tone: Tone
    }

    public static func toolsRows(_ report: AgentToolsReport, guide: AgentToolsGuide = .shared) -> [ToolsRow] {
        var groups: [(word: String, tone: Tone, parts: [String])] = []
        var own: [ToolsRow] = []
        for row in familyRows(report, guide: guide) {
            let (word, tone) = state(row)
            let count = row.served > 0 && row.served < row.total ? "\(row.served) of \(row.total)" : "\(row.total)"
            if row.id == "orchestration" {
                own.append(ToolsRow(id: row.id, text: "\(row.label) · \(count)", word: word, tone: tone))
            } else if let index = groups.firstIndex(where: { $0.word == word }) {
                groups[index].parts.append("\(row.label) \(count)")
            } else {
                groups.append((word, tone, ["\(row.label) \(count)"]))
            }
        }
        return groups.map { ToolsRow(id: $0.word, text: $0.parts.joined(separator: " · "), word: $0.word, tone: $0.tone) }
            + own
    }

    /// A family's word on the Tools rows: some served, the server down, a switch, or none listed by the engine.
    private static func state(_ row: FamilyRow) -> (word: String, tone: Tone) {
        if row.served > 0 { return ("Available", .ok) }
        if row.reason == "not_connected" { return ("Not connected", .bad) }
        if row.reason != nil { return ("Off", .quiet) }
        return ("Not listed", .quiet)
    }

    /// Why families are short, each reason once, in the person's words; `excluding` leaves out reasons said
    /// elsewhere (the sheet says Session orchestration's on its own row).
    public static func withheldReasons(_ report: AgentToolsReport, excluding: Set<String> = [],
                                       guide: AgentToolsGuide = .shared) -> [String] {
        var seen = excluding
        var out: [String] = []
        for family in report.families {
            guard let reason = family.reason, seen.insert(reason).inserted else { continue }
            switch reason {
            case "orchestration":
                out.append(guide.orchestration.off)
            case "not_connected":
                out.append("Not connected: none of these reach the agent while the MCP server is down.")
            default:
                if let text = guide.switchReasons[reason] { out.append(text) }
            }
        }
        return out
    }

    /// What Session orchestration means for the agent, as the account's switch is now.
    public static func orchestration(_ on: Bool, guide: AgentToolsGuide = .shared) -> String {
        on ? guide.orchestration.on : guide.orchestration.off
    }

    /// What changed since the engine started, when the account's switch is no longer the one it was started with.
    public static func orchestrationChanged(_ report: AgentToolsReport?, orchestrationOn: Bool) -> String? {
        guard let started = report?.switches?.orchestration, started != orchestrationOn else { return nil }
        return orchestrationOn
            ? "Session orchestration was turned on after this engine started: its session, agent and runner tools arrive when the engine next starts."
            : "Session orchestration was turned off after this engine started: the tools may still be listed, and Orbit refuses every call to them."
    }

    /// What one permission mode means for Orbit's calls; nil for a mode the guide does not know.
    public static func mode(_ mode: String?, guide: AgentToolsGuide = .shared) -> AgentToolsGuide.PermissionModeText? {
        guide.permissionModes.first { $0.mode == mode }
    }

    /// The facts a layer's conditions are read against.
    public struct LayerFacts: Equatable, Sendable {
        public var base: Bool
        public var workspace: Bool
        public var carrier: String

        public init(base: Bool, workspace: Bool, carrier: String) {
            self.base = base
            self.workspace = workspace
            self.carrier = carrier
        }
    }

    /// The layers an engine's model reads, in the order it reads them, kept to the ones this session or workspace
    /// has: a layer is there when every condition it names holds (agentToolsLayer.When in the runner).
    public static func layers(_ engine: String, _ facts: LayerFacts,
                              guide: AgentToolsGuide = .shared) -> [AgentToolsGuide.Layer] {
        (guide.instructions[engine] ?? []).filter { layer in
            (layer.when ?? []).allSatisfy { condition in
                switch condition {
                case "base": return facts.base
                case "no_base": return !facts.base
                case "workspace": return facts.workspace
                default: return condition == facts.carrier
                }
            }
        }
    }

    /// The carrier an engine's runtime instructions travel by when nothing else is known: today's engines.
    public static func defaultCarrier(_ engine: String) -> String {
        engine == "codex" ? "additional_context" : "append_system_prompt"
    }

    /// A session's facts, from its report; without one, no base or workspace instructions and the engine's carrier.
    public static func facts(_ report: AgentToolsReport?, engine: String) -> LayerFacts {
        let instructions = report?.instructions
        return LayerFacts(base: instructions?.base ?? false, workspace: instructions?.workspace ?? false,
                          carrier: instructions?.carrier ?? defaultCarrier(engine))
    }

    /// A workspace's runtime instructions as the runner counts them: trimmed, in characters (Unicode scalars,
    /// Go's runes, the web's `Array.from`).
    public static func characters(_ instructions: String) -> Int {
        instructions.trimmingCharacters(in: .whitespacesAndNewlines).unicodeScalars.count
    }

    /// What became of the playbooks on this session, ahead of what they are.
    public static func skillWord(_ skill: AgentToolsReport.Skill) -> String {
        if !skill.offered { return skill.reason.map { "Not offered: \($0) " } ?? "Not offered. " }
        if skill.loaded == true { return "Loaded. " }
        if skill.loaded == false { return "Offered, but the engine did not list it. " }
        return "Offered. "
    }

    /// A layer's line: the playbooks' fate on this session, what the layer is, and the workspace's length.
    public static func detail(_ layer: AgentToolsGuide.Layer, skill: AgentToolsReport.Skill?,
                              workspaceChars: Int?) -> String {
        var line = ""
        if layer.id == "skill", let skill { line += skillWord(skill) }
        line += layer.detail
        if layer.id == "workspace", let chars = workspaceChars, chars > 0 { line += " \(chars) characters." }
        return line
    }
}

/// The sheet's own words. Where the web's drawer says the same thing they are its words
/// (`AgentToolsCopyParityTests` holds them to it); the Mac's titles follow board ⑤.
public enum AgentToolsCopy {
    public static let title = "Agent Tools"
    public static func workspaceTitle(_ workspace: String) -> String { "\(title) · \(workspace)" }
    /// The workspace settings row's button, and the line under it (the web's settings row).
    public static let settingsButton = "Agent Tools…"
    public static let workspaceRow = "What agents here are given: Orbit's tools, the instructions they read and in what order, and the playbooks."
    public static let sessionLead = "What the agent in this session can reach in Orbit, and what it was told."
    /// The web's lead names its More actions menu; on the Mac the way in is the session's toolbar.
    public static let workspaceLead = "What a session in this workspace is given. Its live connection is on the session: Agent Tools in its toolbar."
    public static let thisSession = "This session"
    public static let versions = "Versions"
    public static let permissionMode = "Permission mode"
    public static let orchestration = "Session orchestration"
    public static let on = "On"
    public static let off = "Off"
    public static let tools = "Tools"
    /// The Tools header once the engine has reported: how many of Orbit's tools the session lists.
    public static func toolsListed(_ count: Int) -> String { "\(tools) · \(count)" }
    public static let toolsPending = "Shown once this session's engine reports the tools it has."
    public static func instructions(_ engine: String) -> String { "Instructions, in the order \(AgentTools.engineName(engine)) reads them" }
    public static let instructionsUnmeasured = "Instructions"
    /// For an engine whose order was not measured.
    public static func unmeasured(_ engine: String) -> String {
        "\(AgentTools.engineName(engine)) reads Orbit's runtime instructions, which begin with the primer, in the place its runner gives them; the order is laid out here for Claude Code and Codex, where it was measured."
    }
    public static let engine = "Engine"
    public static let edit = "Edit"
    public static let howAgentsUseOrbit = "How agents use Orbit"
    public static let tryAsking = "Try asking"
    public static func symptoms(_ count: Int) -> String { "\(count) symptoms" }
    public static func examples(_ count: Int) -> String { "\(count) examples" }
    public static func asks(_ asks: [String]) -> String { "Try asking: " + asks.map(quoted).joined(separator: " · ") }
    public static func quoted(_ words: String) -> String { "“\(words)”" }
    public static func proof(_ proof: String) -> String { "Proof: \(proof)" }
    public static let done = "Done"
}

private extension String {
    /// The first `target` replaced, as JavaScript's `String.replace` with a string does.
    func replacingFirst(_ target: String, with replacement: String) -> String {
        guard let range = range(of: target) else { return self }
        return replacingCharacters(in: range, with: replacement)
    }
}
