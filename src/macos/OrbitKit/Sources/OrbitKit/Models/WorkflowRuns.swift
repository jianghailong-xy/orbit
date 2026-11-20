import Foundation

/// One Orbit workflow as a client reads it (`GET /sessions/:id/workflows`, docs/subagent-workflow-design.md
/// §5.1), keyed by the `mcp__orbit__workflow` call it belongs to. Its calls are SubAgent runs whose
/// `workflowRunId` is this `id`. Mirrors `@orbit/shared`'s `WorkflowRunView`.
public struct WorkflowRunView: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    /// The `mcp__orbit__workflow` call's tool_use id.
    public let toolUseId: String
    /// The script's `meta`: its name, description and phase titles, in the script's order.
    public let name: String
    public let description: String?
    public let phases: [String]
    /// `RUNNING`, `DONE`, `FAILED`, `INTERRUPTED`, `STOPPED`.
    public let status: String
    /// Calls that finished, and calls that ended any other way; with `costUsd`, counted from the calls'
    /// runs while the workflow runs, and the runner's report once it has ended.
    public let callsDone: Int
    public let callsFailed: Int
    public let costUsd: Double
    /// The cost limit the call set; nil when it set none (the default).
    public let maxCostUsd: Double?
    /// Why it did not finish, truncated; nil while it runs and when it finished.
    public let error: String?
    public let createdAt: String
    public let endedAt: String?

    public init(id: String, toolUseId: String, name: String, description: String? = nil, phases: [String] = [],
                status: String, callsDone: Int = 0, callsFailed: Int = 0, costUsd: Double = 0,
                maxCostUsd: Double? = nil, error: String? = nil, createdAt: String, endedAt: String? = nil) {
        self.id = id
        self.toolUseId = toolUseId
        self.name = name
        self.description = description
        self.phases = phases
        self.status = status
        self.callsDone = callsDone
        self.callsFailed = callsFailed
        self.costUsd = costUsd
        self.maxCostUsd = maxCostUsd
        self.error = error
        self.createdAt = createdAt
        self.endedAt = endedAt
    }

    public var isRunning: Bool { status == "RUNNING" }
}
