import Foundation

/// One SubAgent run as a client reads it (`GET /sessions/:id/subagents`), keyed by the `delegate` call
/// it belongs to: what the transcript's SubAgent block shows beside the call — tier, model, Why, time
/// and cost (docs/subagent-design.md §6.4). Mirrors `@orbit/shared`'s `SubagentRunView`.
public struct SubagentRunView: Codable, Equatable, Sendable, Identifiable {
    /// The `delegate` call's tool_use id.
    public let toolUseId: String
    /// `explore` | `general` | a definition file's name.
    public let type: String
    public let background: Bool
    /// `RUNNING`, `DONE`, `FAILED`, `INTERRUPTED`, `STOPPED`.
    public let status: String
    /// The tier Orbit picked: S, M, L or XL.
    public let level: String?
    /// The model it runs on, and how the provider's table names it (the id itself when it does not).
    public let model: String?
    public let modelLabel: String?
    public let effort: String?
    /// The router's full reasons, English: what the Why line's Details open to.
    public let reasons: [String]
    /// The Why line itself, one clause per part: where the tier came from, the pick and why, any move,
    /// and how many candidates were removed — each provider named once. Nil from a server before it
    /// kept one, and on rows from before then, whose Why is their reasons.
    public let why: String?
    /// Every candidate the router removed, with its reason: the rest of what Details open to. Nil from
    /// a server before it sent them.
    public let removed: [Removed]?
    /// The workspace a remote SubAgent ran on; nil on the parent's machine.
    public let workspaceName: String?
    /// The `delegate` call's description, which the session's list of Agents names each run by. Nil on
    /// older rows and from a server before it sent one.
    public let description: String?
    /// The engine it runs on now (`claude`, `codex`, …). Nil on a shadow row, which runs on the parent's
    /// engine, and from a server before it sent one.
    public let engine: String?
    /// The definition is read-only. Nil from a server before it sent one.
    public let readonly: Bool?
    /// The paths the child's edit tools wrote. Nil from a server before it sent them.
    public let changedFiles: [String]?
    public let costUsd: Double
    /// What it handed back, truncated: the result of a background run, whose call only returned its receipt.
    public let resultSummary: String?
    public let createdAt: String
    public let endedAt: String?
    /// The Orbit workflow this run is a call of: its `WorkflowRunView.id`. Such a run's `toolUseId` is
    /// `<the workflow call's tool_use id>#<callIndex>`. Nil, as are the three below, on a `delegate`
    /// call's run and from a server before it sent them.
    public let workflowRunId: String?
    /// The call's place in the script, from 0 in the order the script made its `agent()` calls.
    public let callIndex: Int?
    /// The `agent()` call's `label` and `phase`, as the script gave them.
    public let label: String?
    public let phase: String?

    public var id: String { toolUseId }

    public init(toolUseId: String, type: String, background: Bool, status: String, level: String? = nil,
                model: String? = nil, modelLabel: String? = nil, effort: String? = nil,
                reasons: [String] = [], costUsd: Double = 0, resultSummary: String? = nil,
                createdAt: String, endedAt: String? = nil, why: String? = nil,
                removed: [Removed]? = nil, workspaceName: String? = nil, description: String? = nil, engine: String? = nil,
                readonly: Bool? = nil, changedFiles: [String]? = nil, workflowRunId: String? = nil,
                callIndex: Int? = nil, label: String? = nil, phase: String? = nil) {
        self.toolUseId = toolUseId
        self.type = type
        self.background = background
        self.status = status
        self.level = level
        self.model = model
        self.modelLabel = modelLabel
        self.effort = effort
        self.reasons = reasons
        self.costUsd = costUsd
        self.resultSummary = resultSummary
        self.createdAt = createdAt
        self.endedAt = endedAt
        self.why = why
        self.removed = removed
        self.workspaceName = workspaceName
        self.description = description
        self.engine = engine
        self.readonly = readonly
        self.changedFiles = changedFiles
        self.workflowRunId = workflowRunId
        self.callIndex = callIndex
        self.label = label
        self.phase = phase
    }

    /// A candidate the router removed, and why.
    public struct Removed: Codable, Equatable, Sendable {
        public let provider: String
        public let engine: String?
        public let model: String?
        public let effort: String?
        public let reason: String

        public init(provider: String, engine: String? = nil, model: String? = nil, effort: String? = nil,
                    reason: String) {
            self.provider = provider
            self.engine = engine
            self.model = model
            self.effort = effort
            self.reason = reason
        }
    }

    /// Whether the run is still going. A background call answers at once, so its card's own status
    /// cannot say.
    public var isRunning: Bool { status == "RUNNING" }
}
