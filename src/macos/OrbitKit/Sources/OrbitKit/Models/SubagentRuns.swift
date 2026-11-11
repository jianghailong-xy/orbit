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
    /// The router's reasons, English: the block's Why line.
    public let reasons: [String]
    public let costUsd: Double
    /// What it handed back, truncated: the result of a background run, whose call only returned its receipt.
    public let resultSummary: String?
    public let createdAt: String
    public let endedAt: String?

    public var id: String { toolUseId }

    public init(toolUseId: String, type: String, background: Bool, status: String, level: String? = nil,
                model: String? = nil, modelLabel: String? = nil, effort: String? = nil,
                reasons: [String] = [], costUsd: Double = 0, resultSummary: String? = nil,
                createdAt: String, endedAt: String? = nil) {
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
    }

    /// Whether the run is still going. A background call answers at once, so its card's own status
    /// cannot say.
    public var isRunning: Bool { status == "RUNNING" }
}
