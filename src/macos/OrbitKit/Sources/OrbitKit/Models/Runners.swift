import Foundation

// Runner write DTOs + the skill/command payload, mirroring runners.controller / runners.service.
// Skills are NOT a standalone endpoint: runners report what they found on disk via heartbeat and
// it rides the GET /runners payload as `skills` / `commands` (both `SlashCommandInfo[]`). The
// `Runner` response struct (DTOs.swift) is extended with those plus `displayName`.

/// A slash command (`.claude/commands/*.md`) or skill (`.claude/skills/<name>/SKILL.md`) a runner
/// discovered. `agentId` empty/nil ⇒ host-level (shared by all agents); else project-scoped to
/// that agent's workDir — the web composer scopes `/` autocomplete to host + the session's agent.
public struct SlashCommandInfo: Codable, Equatable, Sendable, Identifiable {
    public let name: String
    public let description: String?
    public let type: String?        // "command" | "skill"
    public let agentId: String?
    /// Stable identity for SwiftUI lists (the same name can exist host-level and per-agent).
    public var id: String { "\(agentId ?? "host"):\(type ?? ""):\(name)" }
}

/// One model option reported by a runner runtime. Codex entries come from `codex debug models`.
public struct RunnerModelInfo: Codable, Equatable, Sendable, Identifiable {
    public let value: String
    public let label: String
    public let priority: Int?
    public let contextWindow: Int?
    public let reasoningLevels: [String]?
    public let defaultReasoningLevel: String?
    public let serviceTiers: [String]?
    public var id: String { value }
}

/// Models a runner says its local runtimes can use.
public struct RunnerModelCatalog: Codable, Equatable, Sendable {
    public let claude: [RunnerModelInfo]?
    public let codex: [RunnerModelInfo]?

    public func models(for provider: String) -> [ModelOption]? {
        let rows = provider == "codex" ? codex : claude
        guard let rows, !rows.isEmpty else { return nil }
        return rows.map { ModelOption(id: $0.value, name: $0.label) }
    }

    public func contextWindow(for id: String) -> Int? {
        let all = (claude ?? []) + (codex ?? [])
        return all.first { $0.value == id }?.contextWindow
    }
}

/// PATCH /runners/:id — `displayName` empty string clears the alias (falls back to machine name);
/// nil omits. `maxConcurrent` 1…64.
public struct UpdateRunnerRequest: Encodable, Sendable {
    public var displayName: String?
    public var maxConcurrent: Int?
    public init(displayName: String? = nil, maxConcurrent: Int? = nil) {
        self.displayName = displayName
        self.maxConcurrent = maxConcurrent
    }
}

/// POST /runners/enrollment-tokens
public struct CreateEnrollmentTokenRequest: Encodable, Sendable {
    public var label: String?
    public var ttlHours: Int?
    public init(label: String? = nil, ttlHours: Int? = nil) {
        self.label = label
        self.ttlHours = ttlHours
    }
}

/// POST /runners/:id/rotate-token → the new token, returned exactly once.
public struct RotateTokenResponse: Codable, Equatable, Sendable {
    public let token: String
}

/// Enrollment token. `token` is present only on create (one-shot); the list omits it.
public struct EnrollmentTokenInfo: Codable, Equatable, Sendable {
    public let id: String?
    public let token: String?
    public let label: String?
    public let expiresAt: String?
}

/// Generic `{ ok: true }` ack (delete runner, etc.).
public struct OkResponse: Codable, Equatable, Sendable {
    public let ok: Bool?
}

/// One provider rate-limit window (mirrors shared `PlanUsageWindow`).
public struct PlanUsageWindow: Codable, Equatable, Sendable {
    public let utilization: Double   // 0…100
    public let resetsAt: String?
    public let label: String?
    public let windowDurationMins: Int?

    public init(utilization: Double, resetsAt: String? = nil,
                label: String? = nil, windowDurationMins: Int? = nil) {
        self.utilization = utilization
        self.resetsAt = resetsAt
        self.label = label
        self.windowDurationMins = windowDurationMins
    }
}

public struct PlanUsageCredits: Codable, Equatable, Sendable {
    public let hasCredits: Bool
    public let unlimited: Bool
    public let balance: String?
}

/// One provider's usage snapshot. Claude fills fiveHour/sevenDay; Codex fills primary/secondary.
public struct PlanUsageSnapshot: Codable, Equatable, Sendable {
    public let provider: String?
    public let fiveHour: PlanUsageWindow?
    public let sevenDay: PlanUsageWindow?
    public let sevenDayOpus: PlanUsageWindow?
    public let sevenDaySonnet: PlanUsageWindow?
    public let primary: PlanUsageWindow?
    public let secondary: PlanUsageWindow?
    public let limitId: String?
    public let limitName: String?
    public let planType: String?
    public let rateLimitReachedType: String?
    public let credits: PlanUsageCredits?
    public let fetchedAt: String?

    public init(provider: String? = nil, fiveHour: PlanUsageWindow? = nil,
                sevenDay: PlanUsageWindow? = nil, sevenDayOpus: PlanUsageWindow? = nil,
                sevenDaySonnet: PlanUsageWindow? = nil, primary: PlanUsageWindow? = nil,
                secondary: PlanUsageWindow? = nil, limitId: String? = nil,
                limitName: String? = nil, planType: String? = nil,
                rateLimitReachedType: String? = nil, credits: PlanUsageCredits? = nil,
                fetchedAt: String? = nil) {
        self.provider = provider
        self.fiveHour = fiveHour
        self.sevenDay = sevenDay
        self.sevenDayOpus = sevenDayOpus
        self.sevenDaySonnet = sevenDaySonnet
        self.primary = primary
        self.secondary = secondary
        self.limitId = limitId
        self.limitName = limitName
        self.planType = planType
        self.rateLimitReachedType = rateLimitReachedType
        self.credits = credits
        self.fetchedAt = fetchedAt
    }
}

/// Provider quota for a runner's account. Old runners report a flat Claude snapshot;
/// newer runners may nest provider snapshots under `claude` and `codex`.
public struct PlanUsage: Codable, Equatable, Sendable {
    public let provider: String?
    public let fiveHour: PlanUsageWindow?
    public let sevenDay: PlanUsageWindow?
    public let sevenDayOpus: PlanUsageWindow?
    public let sevenDaySonnet: PlanUsageWindow?
    public let primary: PlanUsageWindow?
    public let secondary: PlanUsageWindow?
    public let limitId: String?
    public let limitName: String?
    public let planType: String?
    public let rateLimitReachedType: String?
    public let credits: PlanUsageCredits?
    public let claude: PlanUsageSnapshot?
    public let codex: PlanUsageSnapshot?
    public let fetchedAt: String?

    public init(provider: String? = nil, fiveHour: PlanUsageWindow? = nil,
                sevenDay: PlanUsageWindow? = nil, sevenDayOpus: PlanUsageWindow? = nil,
                sevenDaySonnet: PlanUsageWindow? = nil, primary: PlanUsageWindow? = nil,
                secondary: PlanUsageWindow? = nil, limitId: String? = nil,
                limitName: String? = nil, planType: String? = nil,
                rateLimitReachedType: String? = nil, credits: PlanUsageCredits? = nil,
                claude: PlanUsageSnapshot? = nil, codex: PlanUsageSnapshot? = nil,
                fetchedAt: String? = nil) {
        self.provider = provider
        self.fiveHour = fiveHour
        self.sevenDay = sevenDay
        self.sevenDayOpus = sevenDayOpus
        self.sevenDaySonnet = sevenDaySonnet
        self.primary = primary
        self.secondary = secondary
        self.limitId = limitId
        self.limitName = limitName
        self.planType = planType
        self.rateLimitReachedType = rateLimitReachedType
        self.credits = credits
        self.claude = claude
        self.codex = codex
        self.fetchedAt = fetchedAt
    }
}

/// One labelled window for the composer's plan-usage popover (mirrors web's PLAN_USAGE_ROWS).
public struct PlanUsageRow: Equatable, Sendable, Identifiable {
    public let key: String
    public let label: String
    public let window: PlanUsageWindow
    public var id: String { key }
    /// Utilization rounded to a whole percent (0…100).
    public var percent: Int { Int(window.utilization.rounded()) }
}

public extension PlanUsageSnapshot {
    /// Present windows in provider order: Claude 5-hour first, Codex primary first.
    var rows: [PlanUsageRow] {
        let codex = provider == "codex" || primary != nil || secondary != nil
        let raw: [(String, String, PlanUsageWindow?)]
        if codex {
            raw = [("primary", primary?.label ?? "Primary limit", primary),
                   ("secondary", secondary?.label ?? "Secondary limit", secondary)]
        } else {
            raw = [("fiveHour", "5-hour limit", fiveHour),
                   ("sevenDay", "Weekly · all models", sevenDay),
                   ("sevenDayOpus", "Weekly · Opus", sevenDayOpus),
                   ("sevenDaySonnet", "Weekly · Sonnet", sevenDaySonnet)]
        }
        return raw
            .compactMap { key, label, window in
                window.map { PlanUsageRow(key: key, label: label, window: $0) }
            }
    }

    /// The binding window's percent (5-hour when present, else the first available), or nil
    /// when the runner reports no windows.
    var primaryPercent: Int? { rows.first?.percent }
}

public extension PlanUsage {
    var flatSnapshot: PlanUsageSnapshot {
        PlanUsageSnapshot(provider: provider, fiveHour: fiveHour, sevenDay: sevenDay,
                          sevenDayOpus: sevenDayOpus, sevenDaySonnet: sevenDaySonnet,
                          primary: primary, secondary: secondary, limitId: limitId,
                          limitName: limitName, planType: planType,
                          rateLimitReachedType: rateLimitReachedType, credits: credits,
                          fetchedAt: fetchedAt)
    }

    func snapshot(for provider: String) -> PlanUsageSnapshot? {
        if provider == "codex" {
            if let codex { return codex }
            let flat = flatSnapshot
            return flat.provider == "codex" || flat.primary != nil || flat.secondary != nil ? flat : nil
        }
        if let claude { return claude }
        let flat = flatSnapshot
        return flat.provider == nil || flat.provider == "claude" || flat.fiveHour != nil || flat.sevenDay != nil ? flat : nil
    }

    var snapshots: [(String, PlanUsageSnapshot)] {
        if claude != nil || codex != nil {
            return [("Claude quota", claude), ("Codex quota", codex)].compactMap { entry in
                entry.1.map { (entry.0, $0) }
            }
        }
        let flat = flatSnapshot
        let title = flat.provider == "codex" || flat.primary != nil || flat.secondary != nil ? "Codex quota" : "Claude quota"
        return [(title, flat)]
    }

    var rows: [PlanUsageRow] { flatSnapshot.rows }
    var primaryPercent: Int? { flatSnapshot.primaryPercent }
}
