import Foundation

/// The Agent Tools guide (src/runner-go/agent_tools_guide.go): how agents use Orbit, the instructions each
/// engine reads and in what order, what each permission mode means for Orbit's calls, and the words for a
/// session's connection. The same document the web's drawer reads (src/web/src/lib/agentToolsGuide.generated.json),
/// carried here as `agentToolsGuideJSON` (AgentToolsGuide.generated.swift) and decoded once.
///
/// Decoding is strict on purpose: the document is generated beside this model, and `AgentToolsTests` fails the
/// moment the two stop agreeing. Only the fields the sheet draws are read; the rest of the document is ignored.
public struct AgentToolsGuide: Decodable, Sendable {
    /// One section of "How agents use Orbit".
    public struct Section: Decodable, Sendable, Identifiable {
        public let id: String
        public let title: String
        public let lead: String
        public let points: [String]
        public let asks: [String]?
    }

    /// One symptom of "When something is missing", with its cause and its fix.
    public struct Trouble: Decodable, Sendable, Identifiable {
        public let id: String
        public let symptom: String
        public let cause: String
        public let fix: String
        public let code: String?
    }

    /// One of the worked examples under "Try asking".
    public struct Example: Decodable, Sendable, Identifiable {
        public let id: String
        public let title: String
        public let ask: String
        public let does: String
        public let proof: String
    }

    /// A family of Orbit's tools, by what they act on.
    public struct Family: Decodable, Sendable, Identifiable {
        public let id: String
        public let label: String
        public let tools: [String]?
    }

    /// One layer of what an engine's model reads; `when` names the conditions it needs (`AgentTools.layers`).
    public struct Layer: Decodable, Sendable, Equatable {
        public let id: String
        public let title: String
        public let role: String
        public let roleLabel: String
        public let detail: String
        public let source: String
        public let when: [String]?
    }

    /// What one permission mode means for Orbit's calls.
    public struct PermissionModeText: Decodable, Sendable, Equatable {
        public let mode: String
        public let label: String
        public let orbit: String
    }

    public struct Orchestration: Decodable, Sendable {
        public let on: String
        public let off: String
    }

    public struct Skill: Decodable, Sendable {
        public let claude: String
        public let codex: String
        public let purpose: String
    }

    public private(set) var guideVersion = ""
    public private(set) var sections: [Section] = []
    public private(set) var troubleshooting: [Trouble] = []
    public private(set) var examples: [Example] = []
    public private(set) var families: [Family] = []
    public private(set) var instructions: [String: [Layer]] = [:]
    public private(set) var instructionsNote = ""
    public private(set) var permissionModes: [PermissionModeText] = []
    public private(set) var orchestration = Orchestration(on: "", off: "")
    public private(set) var status: [String: String] = [:]
    public private(set) var skill = Skill(claude: "", codex: "", purpose: "")
    public private(set) var switchReasons: [String: String] = [:]
    public private(set) var engineNames: [String: String] = [:]

    /// An empty guide: what `shared` falls back to if the generated document ever failed to decode, so a
    /// broken build shows an empty sheet instead of stopping the app (the tests make sure it never ships).
    public init() {}

    public static func decode(_ json: String) throws -> AgentToolsGuide {
        try JSONDecoder().decode(AgentToolsGuide.self, from: Data(json.utf8))
    }

    /// The guide this build carries.
    public static let shared: AgentToolsGuide = (try? decode(agentToolsGuideJSON)) ?? AgentToolsGuide()
}
