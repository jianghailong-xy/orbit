import Foundation

// Agent write DTOs mirroring src/apiserver/src/agents/dto.ts. The `Agent` response struct lives
// in DTOs.swift (extended with the form's fields). Update uses plain optionals: Swift's
// synthesized `Encodable` emits optionals via `encodeIfPresent`, so `nil` omits the key — exactly
// PATCH's "send only what changed". None of the agent fields need null=clear, so no FieldUpdate.
// (mcpConfig — the one nested-object field — is deferred to a later batch.)

/// POST /agents
public struct CreateAgentRequest: Encodable, Sendable {
    public let name: String
    public let description: String?
    public let provider: String?
    public let model: String?
    public let appendSystemPrompt: String?
    public let systemPrompt: String?
    public let allowedTools: [String]?
    public let disallowedTools: [String]?
    public let permissionMode: String?
    public let effort: String?
    public let maxTurns: Int?
    public let maxBudgetUsd: Double?
    public let targetRunnerId: String?
    public let targetLabels: [String]?
    public let runnerId: String?
    public let workDir: String?
    public let env: [String: String]?
    public let enabled: Bool?
    public let autoInitGit: Bool?

    public init(name: String, description: String? = nil, provider: String? = nil,
                model: String? = nil,
                appendSystemPrompt: String? = nil, systemPrompt: String? = nil,
                allowedTools: [String]? = nil, disallowedTools: [String]? = nil,
                permissionMode: String? = nil, effort: String? = nil,
                maxTurns: Int? = nil, maxBudgetUsd: Double? = nil,
                targetRunnerId: String? = nil, targetLabels: [String]? = nil,
                runnerId: String? = nil, workDir: String? = nil, env: [String: String]? = nil,
                enabled: Bool? = nil, autoInitGit: Bool? = nil) {
        self.name = name
        self.description = description
        self.provider = provider
        self.model = model
        self.appendSystemPrompt = appendSystemPrompt
        self.systemPrompt = systemPrompt
        self.allowedTools = allowedTools
        self.disallowedTools = disallowedTools
        self.permissionMode = permissionMode
        self.effort = effort
        self.maxTurns = maxTurns
        self.maxBudgetUsd = maxBudgetUsd
        self.targetRunnerId = targetRunnerId
        self.targetLabels = targetLabels
        self.runnerId = runnerId
        self.workDir = workDir
        self.env = env
        self.enabled = enabled
        self.autoInitGit = autoInitGit
    }
}

/// PATCH /agents/:id — every field optional; nil omits (synthesized `encodeIfPresent`).
public struct UpdateAgentRequest: Encodable, Sendable {
    public var name: String?
    public var description: String?
    public var provider: String?
    public var model: String?
    public var appendSystemPrompt: String?
    public var systemPrompt: String?
    public var allowedTools: [String]?
    public var disallowedTools: [String]?
    public var permissionMode: String?
    public var effort: String?
    public var maxTurns: Int?
    public var maxBudgetUsd: Double?
    public var targetRunnerId: String?
    public var targetLabels: [String]?
    public var runnerId: String?
    public var workDir: String?
    public var env: [String: String]?
    public var enabled: Bool?
    public var autoInitGit: Bool?

    public init(name: String? = nil, description: String? = nil, provider: String? = nil,
                model: String? = nil,
                appendSystemPrompt: String? = nil, systemPrompt: String? = nil,
                allowedTools: [String]? = nil, disallowedTools: [String]? = nil,
                permissionMode: String? = nil, effort: String? = nil,
                maxTurns: Int? = nil, maxBudgetUsd: Double? = nil,
                targetRunnerId: String? = nil, targetLabels: [String]? = nil,
                runnerId: String? = nil, workDir: String? = nil, env: [String: String]? = nil,
                enabled: Bool? = nil, autoInitGit: Bool? = nil) {
        self.name = name
        self.description = description
        self.provider = provider
        self.model = model
        self.appendSystemPrompt = appendSystemPrompt
        self.systemPrompt = systemPrompt
        self.allowedTools = allowedTools
        self.disallowedTools = disallowedTools
        self.permissionMode = permissionMode
        self.effort = effort
        self.maxTurns = maxTurns
        self.maxBudgetUsd = maxBudgetUsd
        self.targetRunnerId = targetRunnerId
        self.targetLabels = targetLabels
        self.runnerId = runnerId
        self.workDir = workDir
        self.env = env
        self.enabled = enabled
        self.autoInitGit = autoInitGit
    }
}

/// POST /agents/reorder — the full id list in the desired sidebar order.
public struct ReorderAgentsRequest: Encodable, Sendable {
    public let ids: [String]
    public init(ids: [String]) { self.ids = ids }
}
