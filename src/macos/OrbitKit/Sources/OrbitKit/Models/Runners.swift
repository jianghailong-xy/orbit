import Foundation

// Runner write DTOs + the skill/command payload, mirroring runners.controller / runners.service.
// Skills are NOT a standalone endpoint: runners report what they found on disk via heartbeat and
// it rides the GET /runners payload as `skills` / `commands` (both `SlashCommandInfo[]`). The
// `Runner` response struct (DTOs.swift) is extended with those plus `displayName`.

/// A slash command or skill a runner discovered. `agentId` empty/nil ⇒ host-level (shared by
/// all agents); else project-scoped to that agent's workDir. `provider` identifies a runtime-owned
/// registry entry; nil is a legacy Claude entry. Local Orbit commands have `type == "local"` and
/// remain available under every provider.
public struct SlashCommandInfo: Codable, Equatable, Sendable, Identifiable {
    public let name: String
    public let description: String?
    public let type: String?        // "command" | "skill"
    public let agentId: String?
    public let provider: String?
    /// True for a name the Claude CLI registers itself (built-in skill like `/loop`, a plugin
    /// skill, a namespaced command), learned from its init handshake rather than found on
    /// disk. Listed after the user's own assets. Nil on runners too old to report it.
    public let builtin: Bool?
    /// Stable identity for SwiftUI lists (the same name can exist host-level and per-agent).
    public var id: String { "\(provider ?? "legacy"):\(agentId ?? "host"):\(type ?? ""):\(name)" }

    public init(name: String, description: String? = nil, type: String? = nil,
                agentId: String? = nil, builtin: Bool? = nil, provider: String? = nil) {
        self.name = name
        self.description = description
        self.type = type
        self.agentId = agentId
        self.builtin = builtin
        self.provider = provider
    }
}

/// One model option reported by a runner runtime. Codex and OpenCode discover these locally.
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
    public let kimi: [RunnerModelInfo]?
    public let opencode: [RunnerModelInfo]?

    public init(claude: [RunnerModelInfo]? = nil, codex: [RunnerModelInfo]? = nil,
                kimi: [RunnerModelInfo]? = nil, opencode: [RunnerModelInfo]? = nil) {
        self.claude = claude
        self.codex = codex
        self.kimi = kimi
        self.opencode = opencode
    }

    public func models(for provider: String) -> [ModelOption]? {
        let rows: [RunnerModelInfo]?
        switch provider {
        case "codex": rows = codex
        case "kimi":     rows = kimi
        case "opencode": rows = opencode
        default:         rows = claude
        }
        guard let rows, !rows.isEmpty else { return nil }
        return rows.map { ModelOption(id: $0.value, name: $0.label) }
    }

    public func contextWindow(for id: String) -> Int? {
        let all = (claude ?? []) + (codex ?? []) + (kimi ?? []) + (opencode ?? [])
        return all.first { $0.value == id }?.contextWindow
    }

    /// The exact runtime-catalog row for a provider/model pair. Keeping row lookup separate from
    /// `reasoningLevels` lets callers distinguish an unknown (possibly project-only) OpenCode model
    /// from a known model whose authoritative variant list is empty.
    public func modelInfo(for provider: String, model: String) -> RunnerModelInfo? {
        let rows: [RunnerModelInfo]?
        switch provider {
        case "codex": rows = codex
        case "kimi": rows = kimi
        case "opencode": rows = opencode
        default: rows = claude
        }
        return rows?.first { $0.value == model }
    }

    /// Runtimes whose reasoning levels are declared per model: OpenCode's variants, and Kimi's
    /// `supportEfforts` (K2.7 Coding declares none; K3 declares low/high/max).
    public func reasoningLevels(for provider: String, model: String) -> [String]? {
        guard provider == "opencode" || provider == "kimi" else { return nil }
        return modelInfo(for: provider, model: model)?.reasoningLevels
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

/// One coding-engine CLI's health on a runner, reported each heartbeat (shared `RunnerEngineHealth`).
/// `engine` stays a raw string rather than `LoginEngine`: a server that starts reporting a fourth
/// engine must not fail the decode of the whole runner row and blank the list.
public struct RunnerEngineHealth: Codable, Equatable, Sendable, Identifiable {
    public let engine: String
    public let installed: Bool?
    /// Whatever `<engine> --version` printed; absent when not installed or the CLI wouldn't say.
    public let version: String?
    /// The CLI's own answer to "am I signed in": `yes` / `no` / `unknown`.
    public let auth: String?
    public var id: String { engine }
    /// Only the CLI's own "yes" counts — the third state exists precisely so an engine that
    /// wouldn't answer is never shown as signed in (web's `rowKindOf`).
    public var signedIn: Bool { auth == "yes" }

    public init(engine: String, installed: Bool? = nil, version: String? = nil, auth: String? = nil) {
        self.engine = engine
        self.installed = installed
        self.version = version
        self.auth = auth
    }
}

/// Where a runner's sign-in relay has got to (shared `RunnerLoginState`).
public enum RunnerLoginStatus: String, Codable, Equatable, Sendable {
    case pending
    case awaitingCode = "awaiting_code"
    case awaitingApproval = "awaiting_approval"
    case done
    case failed

    /// A sign-in still under way — what the card polls on, and what makes an outcome that follows
    /// this card's own news rather than a leftover from an earlier attempt.
    public var inFlight: Bool {
        self == .pending || self == .awaitingCode || self == .awaitingApproval
    }
}

/// GET/POST/DELETE /runners/:id/login — the client-facing view of that relay. An unrecognized
/// status decodes as nil (nothing in flight) rather than throwing.
public struct RunnerLoginState: Codable, Equatable, Sendable {
    public let status: RunnerLoginStatus?
    /// Which engine this relay is signing in; nil when nothing is in flight.
    public let engine: String?
    public let url: String?
    /// Set with `awaitingApproval`: the code to type on the page at `url` (device flow).
    public let userCode: String?
    public let message: String?

    public init(status: RunnerLoginStatus? = nil, engine: String? = nil, url: String? = nil,
                userCode: String? = nil, message: String? = nil) {
        self.status = status
        self.engine = engine
        self.url = url
        self.userCode = userCode
        self.message = message
    }

    private enum CodingKeys: String, CodingKey { case status, engine, url, userCode, message }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = (try? c.decodeIfPresent(String.self, forKey: .status))
            .flatMap { $0 }
            .flatMap(RunnerLoginStatus.init(rawValue:))
        engine = try? c.decodeIfPresent(String.self, forKey: .engine)
        url = try? c.decodeIfPresent(String.self, forKey: .url)
        userCode = try? c.decodeIfPresent(String.self, forKey: .userCode)
        message = try? c.decodeIfPresent(String.self, forKey: .message)
    }
}

/// POST /runners/:id/login — start the sign-in for one engine on that machine.
public struct StartLoginRequest: Encodable, Sendable {
    public let engine: String
    public init(engine: LoginEngine) { self.engine = engine.rawValue }
}

/// POST /runners/:id/login/code — hand back the code the sign-in page gave the user.
public struct SubmitLoginCodeRequest: Encodable, Sendable {
    public let code: String
    public init(code: String) { self.code = code }
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

public struct PlanUsageRateLimit: Codable, Equatable, Sendable {
    public let limitId: String?
    public let limitName: String?
    public let primary: PlanUsageWindow?
    public let secondary: PlanUsageWindow?
    public let credits: PlanUsageCredits?

    public init(limitId: String? = nil, limitName: String? = nil,
                primary: PlanUsageWindow? = nil, secondary: PlanUsageWindow? = nil,
                credits: PlanUsageCredits? = nil) {
        self.limitId = limitId
        self.limitName = limitName
        self.primary = primary
        self.secondary = secondary
        self.credits = credits
    }
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
    public let rateLimits: [PlanUsageRateLimit]?
    public let fetchedAt: String?

    public init(provider: String? = nil, fiveHour: PlanUsageWindow? = nil,
                sevenDay: PlanUsageWindow? = nil, sevenDayOpus: PlanUsageWindow? = nil,
                sevenDaySonnet: PlanUsageWindow? = nil, primary: PlanUsageWindow? = nil,
                secondary: PlanUsageWindow? = nil, limitId: String? = nil,
                limitName: String? = nil, planType: String? = nil,
                rateLimitReachedType: String? = nil, credits: PlanUsageCredits? = nil,
                rateLimits: [PlanUsageRateLimit]? = nil,
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
        self.rateLimits = rateLimits
        self.fetchedAt = fetchedAt
    }
}

/// Provider quota for a runner's account. Old runners report a flat Claude snapshot;
/// newer runners may nest provider snapshots under `claude`, `codex`, and `kimi`.
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
    public let rateLimits: [PlanUsageRateLimit]?
    public let claude: PlanUsageSnapshot?
    public let codex: PlanUsageSnapshot?
    public let kimi: PlanUsageSnapshot?
    public let fetchedAt: String?

    public init(provider: String? = nil, fiveHour: PlanUsageWindow? = nil,
                sevenDay: PlanUsageWindow? = nil, sevenDayOpus: PlanUsageWindow? = nil,
                sevenDaySonnet: PlanUsageWindow? = nil, primary: PlanUsageWindow? = nil,
                secondary: PlanUsageWindow? = nil, limitId: String? = nil,
                limitName: String? = nil, planType: String? = nil,
                rateLimitReachedType: String? = nil, credits: PlanUsageCredits? = nil,
                rateLimits: [PlanUsageRateLimit]? = nil,
                claude: PlanUsageSnapshot? = nil, codex: PlanUsageSnapshot? = nil,
                kimi: PlanUsageSnapshot? = nil,
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
        self.rateLimits = rateLimits
        self.claude = claude
        self.codex = codex
        self.kimi = kimi
        self.fetchedAt = fetchedAt
    }
}

/// One labelled window for the composer's plan-usage popover (mirrors web's PLAN_USAGE_ROWS).
public struct PlanUsageRow: Equatable, Sendable, Identifiable {
    public let key: String
    public let label: String
    public let groupLabel: String?
    public let window: PlanUsageWindow
    public var id: String { key }
    /// Orbit displays percent consumed for every provider.
    public var percent: Int {
        min(100, max(0, Int(window.utilization.rounded())))
    }
}

private func isApproximateWindow(_ minutes: Int, _ expected: Int) -> Bool {
    Double(minutes) >= Double(expected) * 0.95 && Double(minutes) <= Double(expected) * 1.05
}

private func codexWindowLabel(_ window: PlanUsageWindow, secondary: Bool) -> String {
    if let minutes = window.windowDurationMins {
        if isApproximateWindow(minutes, 5 * 60) { return "5h limit" }
        if isApproximateWindow(minutes, 24 * 60) { return "Daily limit" }
        if isApproximateWindow(minutes, 7 * 24 * 60) { return "Weekly limit" }
        if isApproximateWindow(minutes, 30 * 24 * 60) { return "Monthly limit" }
        if isApproximateWindow(minutes, 365 * 24 * 60) { return "Annual limit" }
    }
    if window.label == "5-hour limit" { return "5h limit" }
    return window.label ?? (secondary ? "Secondary usage limit" : "Usage limit")
}

public extension PlanUsageSnapshot {
    /// Present windows in provider order, preserving every Codex TUI rate-limit bucket.
    var rows: [PlanUsageRow] {
        let codex = provider == "codex" || primary != nil || secondary != nil || rateLimits?.isEmpty == false
        if codex {
            let buckets = (rateLimits?.isEmpty == false
                ? rateLimits!
                : [PlanUsageRateLimit(limitId: limitId ?? "codex", limitName: limitName,
                                      primary: primary, secondary: secondary, credits: credits)])
                .sorted { ($0.limitId ?? "codex") < ($1.limitId ?? "codex") }
            return buckets.enumerated().flatMap { bucketIndex, bucket -> [PlanUsageRow] in
                let windows: [(String, Bool, PlanUsageWindow)] = [
                    bucket.primary.map { ("primary", false, $0) },
                    bucket.secondary.map { ("secondary", true, $0) }
                ].compactMap { $0 }
                let bucketLabel = bucket.limitName ?? bucket.limitId ?? "codex"
                let prefixed = bucketLabel.caseInsensitiveCompare("codex") != .orderedSame
                return windows.enumerated().map { windowIndex, entry in
                    let baseLabel = codexWindowLabel(entry.2, secondary: entry.1)
                    return PlanUsageRow(
                        key: "\(bucket.limitId ?? bucketLabel)-\(bucketIndex)-\(entry.0)",
                        label: prefixed && windows.count == 1 ? "\(bucketLabel) \(baseLabel)" : baseLabel,
                        groupLabel: prefixed && windows.count > 1 && windowIndex == 0 ? "\(bucketLabel) limit" : nil,
                        window: entry.2)
                }
            }
        }
        let raw: [(String, String, PlanUsageWindow?)] = [
            ("fiveHour", "5-hour limit", fiveHour),
            ("sevenDay", "Weekly · all models", sevenDay),
            ("sevenDayOpus", "Weekly · Opus", sevenDayOpus),
            ("sevenDaySonnet", "Weekly · Sonnet", sevenDaySonnet)]
        return raw
            .compactMap { key, label, window in
                window.map { PlanUsageRow(key: key, label: $0.label ?? label,
                                          groupLabel: nil, window: $0) }
            }
    }

    /// The first displayed window's percent, or nil when no windows are reported.
    var primaryPercent: Int? { rows.first?.percent }
}

public extension PlanUsage {
    var flatSnapshot: PlanUsageSnapshot {
        PlanUsageSnapshot(provider: provider, fiveHour: fiveHour, sevenDay: sevenDay,
                          sevenDayOpus: sevenDayOpus, sevenDaySonnet: sevenDaySonnet,
                          primary: primary, secondary: secondary, limitId: limitId,
                          limitName: limitName, planType: planType,
                          rateLimitReachedType: rateLimitReachedType, credits: credits,
                          rateLimits: rateLimits,
                          fetchedAt: fetchedAt)
    }

    func snapshot(for provider: String) -> PlanUsageSnapshot? {
        // OpenCode may use any underlying provider and Orbit does not collect a
        // provider-specific quota snapshot for it. Never mislabel Claude usage.
        if provider == "opencode" { return nil }
        if provider == "codex" {
            if let codex { return codex }
            let flat = flatSnapshot
            return flat.provider == "codex" || flat.primary != nil || flat.secondary != nil || flat.rateLimits?.isEmpty == false ? flat : nil
        }
        if provider == "kimi" {
            if let kimi { return kimi }
            let flat = flatSnapshot
            // Kimi must be explicit: its session must never inherit a legacy flat Claude quota.
            return flat.provider == "kimi" ? flat : nil
        }
        // Only the built-in Claude engine spends the runner's Claude login. A configured provider
        // slug bills its own credential and is answered by `AgentDefaults.planUsage(for:...)`;
        // falling through to here would show it the runner's subscription numbers instead.
        guard provider == "claude" else { return nil }
        if let claude { return claude }
        let flat = flatSnapshot
        return flat.provider == nil || flat.provider == "claude" ? flat : nil
    }

    var snapshots: [(String, PlanUsageSnapshot)] {
        if claude != nil || codex != nil || kimi != nil {
            return [("Claude quota", claude), ("Codex quota", codex), ("Kimi quota", kimi)].compactMap { entry in
                entry.1.map { (entry.0, $0) }
            }
        }
        let flat = flatSnapshot
        let title: String
        if flat.provider == "kimi" {
            title = "Kimi quota"
        } else if flat.provider == "codex" || flat.primary != nil || flat.secondary != nil
                    || flat.rateLimits?.isEmpty == false {
            title = "Codex quota"
        } else {
            title = "Claude quota"
        }
        return [(title, flat)]
    }

    var rows: [PlanUsageRow] { flatSnapshot.rows }
    var primaryPercent: Int? { flatSnapshot.primaryPercent }
}
