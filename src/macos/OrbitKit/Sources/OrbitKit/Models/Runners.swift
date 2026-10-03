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
    /// The permission modes this model accepts, as the runner's own CLI answered for it — Claude
    /// gates Auto per model, and which models have it belongs to the installed CLI rather than to
    /// a set in this app. nil is "this runner could not say" (an older runner, a failed probe) and
    /// falls back to `AgentDefaults.autoCapableModels`; a list that came back is authoritative,
    /// including when it withholds a mode. Does not encode the runner's own root-ness.
    public let permissionModes: [String]?
    /// Whether this model has the runtime's fast lane, from the same probe. nil is "could not say".
    public let fastMode: Bool?
    public var id: String { value }

    /// Spelled out rather than synthesized so the two fields above can be added without every
    /// construction site having to name them.
    public init(value: String, label: String, priority: Int? = nil, contextWindow: Int? = nil,
                reasoningLevels: [String]? = nil, defaultReasoningLevel: String? = nil,
                serviceTiers: [String]? = nil, permissionModes: [String]? = nil,
                fastMode: Bool? = nil) {
        self.value = value
        self.label = label
        self.priority = priority
        self.contextWindow = contextWindow
        self.reasoningLevels = reasoningLevels
        self.defaultReasoningLevel = defaultReasoningLevel
        self.serviceTiers = serviceTiers
        self.permissionModes = permissionModes
        self.fastMode = fastMode
    }
}

/// Models a runner says its local runtimes can use.
public struct RunnerModelCatalog: Codable, Equatable, Sendable {
    public let claude: [RunnerModelInfo]?
    public let codex: [RunnerModelInfo]?
    public let kimi: [RunnerModelInfo]?
    public let opencode: [RunnerModelInfo]?
    /// From `agy models`, whose slugs carry their level (`gemini-3.8-flash-high`): the runner folds
    /// them into one row per base model (`gemini-3.8-flash`) with its levels as `reasoningLevels`,
    /// and a session passes the two back as `--model` and `--effort`.
    public let antigravity: [RunnerModelInfo]?

    public init(claude: [RunnerModelInfo]? = nil, codex: [RunnerModelInfo]? = nil,
                kimi: [RunnerModelInfo]? = nil, opencode: [RunnerModelInfo]? = nil,
                antigravity: [RunnerModelInfo]? = nil) {
        self.claude = claude
        self.codex = codex
        self.kimi = kimi
        self.opencode = opencode
        self.antigravity = antigravity
    }

    public func models(for provider: String) -> [ModelOption]? {
        let rows: [RunnerModelInfo]?
        switch provider {
        case "codex": rows = codex
        case "kimi":     rows = kimi
        case "opencode": rows = opencode
        case "antigravity": rows = antigravity
        default:         rows = claude
        }
        guard let rows, !rows.isEmpty else { return nil }
        return rows.map { ModelOption(id: $0.value, name: $0.label) }
    }

    public func contextWindow(for id: String) -> Int? {
        // A list rather than one `(rows ?? []) + …` chain: at five runtimes that expression is past
        // what the Swift type-checker resolves in reasonable time, and it fails the build outright.
        let runtimes: [[RunnerModelInfo]?] = [claude, codex, kimi, opencode, antigravity]
        let all = runtimes.flatMap { $0 ?? [] }
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
        case "antigravity": rows = antigravity
        default: rows = claude
        }
        return rows?.first { $0.value == model }
    }

    /// Runtimes whose reasoning levels are declared per model: Codex efforts, OpenCode variants,
    /// Kimi's `supportEfforts` (K2.7 Coding declares none; K3 declares low/high/max), and the
    /// levels agy lists per Gemini model (3.1 Pro has low/high only).
    public func reasoningLevels(for provider: String, model: String) -> [String]? {
        guard provider == "codex" || provider == "opencode" || provider == "kimi"
                || provider == "antigravity" else { return nil }
        return modelInfo(for: provider, model: model)?.reasoningLevels
    }

    /// The permission modes this runner's CLI accepts for one model, or nil where it has not said.
    /// Only Claude gates a mode per model, so only Claude rows are consulted; every other runtime
    /// has its modes runtime-wide and a row there says nothing about them.
    public func permissionModes(for provider: String, model: String) -> [String]? {
        guard provider == "claude" else { return nil }
        return modelInfo(for: provider, model: model)?.permissionModes
    }
}

/// PATCH /runners/:id — `displayName` empty string clears the alias (falls back to machine name);
/// nil omits. `maxConcurrent` 1…64. `minFreeDiskMb` is three-state because omitting it leaves the
/// reserve alone while an explicit JSON null turns the reserve off.
public struct UpdateRunnerRequest: Encodable, Sendable {
    public var displayName: String?
    public var maxConcurrent: Int?
    public var minFreeDiskMb: FieldUpdate<Int>

    public init(displayName: String? = nil, maxConcurrent: Int? = nil,
                minFreeDiskMb: FieldUpdate<Int> = .keep) {
        self.displayName = displayName
        self.maxConcurrent = maxConcurrent
        self.minFreeDiskMb = minFreeDiskMb
    }

    private enum CodingKeys: String, CodingKey { case displayName, maxConcurrent, minFreeDiskMb }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(displayName, forKey: .displayName)
        try c.encodeIfPresent(maxConcurrent, forKey: .maxConcurrent)
        try minFreeDiskMb.encode(into: &c, forKey: .minFreeDiskMb)
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
    /// The accounts this engine is signed into on the runner, Default first — reported for an engine
    /// whose CLI keeps a login per directory (Codex, Claude). Absent from an older runner.
    public let accounts: [RunnerEngineAccount]?
    public let update: RunnerEngineUpdate?
    public var id: String { engine }
    /// Only the CLI's own "yes" counts — the third state exists precisely so an engine that
    /// wouldn't answer is never shown as signed in (web's `rowKindOf`).
    public var signedIn: Bool { auth == "yes" }

    public init(engine: String, installed: Bool? = nil, version: String? = nil, auth: String? = nil,
                accounts: [RunnerEngineAccount]? = nil, update: RunnerEngineUpdate? = nil) {
        self.engine = engine
        self.installed = installed
        self.version = version
        self.auth = auth
        self.accounts = accounts
        self.update = update
    }
}

/// One of a runner's accounts of an engine (shared `RunnerEngineAccount`): `default`, the directory
/// the runner's own environment selects, or a slot it added. Only what the clients read is modelled.
public struct RunnerEngineAccount: Codable, Equatable, Sendable, Identifiable {
    /// `default`, or the slot's id — what a session is created with (`codexAccount`).
    public let id: String
    /// What the user called it: the name it was renamed to in Orbit, else the one it was added under.
    /// Absent for a Default never renamed.
    public let name: String?
    /// The CLI's own answer for this account: `yes` / `no` / `unknown`.
    public let auth: String?
    /// The account's directory on that machine: a CODEX_HOME or a CLAUDE_CONFIG_DIR.
    public let home: String?
    /// The same directory under Codex's historical field name, Codex accounts only: read
    /// `home ?? codexHome`.
    public let codexHome: String?
    /// `cxa1_` and the first 8 hex digits of the account's fingerprint; absent until the runner has
    /// read one. Two accounts showing the same one are the same account.
    public let fingerprintPrefix: String?

    public init(id: String, name: String? = nil, auth: String? = nil,
                home: String? = nil, codexHome: String? = nil,
                fingerprintPrefix: String? = nil) {
        self.id = id
        self.name = name
        self.auth = auth
        self.home = home
        self.codexHome = codexHome
        self.fingerprintPrefix = fingerprintPrefix
    }
}

/// The updater's last word on one engine. Status is intentionally raw: a new updater state must
/// not make the containing runner (or the complete runner list) fail to decode.
public struct RunnerEngineUpdate: Codable, Equatable, Sendable {
    public let status: String?
    public let at: String?
    public let okAt: String?
    public let latest: String?
    public let behindSince: String?
    public let updatedAt: String?
    public let message: String?

    public init(status: String? = nil, at: String? = nil, okAt: String? = nil,
                latest: String? = nil, behindSince: String? = nil,
                updatedAt: String? = nil, message: String? = nil) {
        self.status = status
        self.at = at
        self.okAt = okAt
        self.latest = latest
        self.behindSince = behindSince
        self.updatedAt = updatedAt
        self.message = message
    }
}

/// Browser-facing engine install/update relay. Raw strings preserve forward compatibility.
public struct RunnerInstallState: Codable, Equatable, Sendable {
    public let status: String?
    public let engine: String?
    public let command: String?
    public let message: String?
    public let mode: String?
}

/// Browser-facing account-removal relay. Raw engine/status strings preserve forward compatibility.
public struct RunnerAccountRemoveState: Codable, Equatable, Sendable {
    public let engine: String?
    public let account: String?
    public let status: String?
    public let message: String?
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
    public let account: String?

    public init(status: RunnerLoginStatus? = nil, engine: String? = nil, url: String? = nil,
                userCode: String? = nil, message: String? = nil, account: String? = nil) {
        self.status = status
        self.engine = engine
        self.url = url
        self.userCode = userCode
        self.message = message
        self.account = account
    }

    private enum CodingKeys: String, CodingKey { case status, engine, url, userCode, message, account }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = (try? c.decodeIfPresent(String.self, forKey: .status))
            .flatMap { $0 }
            .flatMap(RunnerLoginStatus.init(rawValue:))
        engine = try? c.decodeIfPresent(String.self, forKey: .engine)
        url = try? c.decodeIfPresent(String.self, forKey: .url)
        userCode = try? c.decodeIfPresent(String.self, forKey: .userCode)
        message = try? c.decodeIfPresent(String.self, forKey: .message)
        account = try? c.decodeIfPresent(String.self, forKey: .account)
    }
}

/// POST /runners/:id/login — start the sign-in for one engine on that machine.
public struct StartLoginRequest: Encodable, Sendable {
    public let engine: String
    public let account: String?
    public let accountName: String?

    public init(engine: LoginEngine, account: String? = nil, accountName: String? = nil) {
        self.engine = engine.rawValue
        self.account = account
        self.accountName = accountName
    }
}

/// PATCH /runners/:id/accounts/:engine/:account — a new name for one of the runner's accounts,
/// Default included. Only a label, kept by the control plane: nothing on the machine changes.
public struct RenameRunnerAccountRequest: Encodable, Sendable {
    public let name: String
    public init(name: String) { self.name = name }
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

/// GET /sessions/counts — one workspace's Open-session tallies.
public struct WorkspaceSessionCounts: Codable, Equatable, Sendable, Identifiable {
    public let workspaceId: String
    public let active: Int
    public let running: Int?
    public let jobs: Int?
    public let needsYou: Int?
    public var id: String { workspaceId }
}

/// GET /runners/device/:userCode — enough identity to approve the machine from another device.
public struct DeviceInfo: Codable, Equatable, Sendable {
    public let userCode: String?
    public let name: String?
    public let hostname: String?
    public let labels: [String]?
    public let maxConcurrent: Int?
    public let status: String?
    public let nameConflict: Bool?
}

/// POST /runners/:id/refresh-models acknowledges when the refresh was requested.
public struct RunnerModelRefresh: Codable, Equatable, Sendable {
    public let requestedAt: String?
}

/// POST /runners/reorder — the full id list in the desired order.
public struct ReorderRunnersRequest: Encodable, Sendable {
    public let ids: [String]
    public init(ids: [String]) { self.ids = ids }
}

/// The shared checkout state attached to a GET /workspaces row. State stays raw so a runner adding
/// a new git state cannot blank the workspace list.
public struct RunnerRepoHealth: Codable, Equatable, Sendable {
    public let root: String?
    public let state: String?
    public let branch: String?
    public let paths: [String]?
}

/// Last word from the repo-cleanup relay attached to a GET /workspaces row.
public struct RunnerRepoCleanup: Codable, Equatable, Sendable {
    public let status: String?
    public let branch: String?
    public let message: String?
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

/// The support answer reported by the runner for earned Codex rate-limit resets.
///
/// This remains a raw string instead of an enum on purpose: the runner may learn a new support
/// state before this client is updated, and an unknown value must not make the whole runner row
/// undecodable.
public typealias CodexRateLimitResetSupport = String

/// One earned Codex reset credit. The provider owns these values; the client only displays them.
public struct PlanUsageRateLimitResetCredit: Codable, Equatable, Sendable {
    public let id: String
    public let resetType: String
    public let status: String
    public let grantedAt: String
    public let expiresAt: String?
    public let title: String?
    public let description: String?

    public init(id: String, resetType: String, status: String, grantedAt: String,
                expiresAt: String? = nil, title: String? = nil, description: String? = nil) {
        self.id = id
        self.resetType = resetType
        self.status = status
        self.grantedAt = grantedAt
        self.expiresAt = expiresAt
        self.title = title
        self.description = description
    }
}

/// The provider's authoritative reset-credit count and optional detail rows.
public struct PlanUsageRateLimitResetCredits: Codable, Equatable, Sendable {
    public let availableCount: Int
    public let credits: [PlanUsageRateLimitResetCredit]?

    public init(availableCount: Int, credits: [PlanUsageRateLimitResetCredit]? = nil) {
        self.availableCount = availableCount
        self.credits = credits
    }
}

/// Earned reset state for the runner's default Codex account.
public struct PlanUsageRateLimitReset: Codable, Equatable, Sendable {
    public let protocolVersion: Int
    public let support: CodexRateLimitResetSupport
    public let accountFingerprint: String?
    public let rateLimitResetCredits: PlanUsageRateLimitResetCredits?
    public let fetchedAt: String
    public let generation: String
    public let sequence: Int

    public init(protocolVersion: Int = 1, support: CodexRateLimitResetSupport,
                accountFingerprint: String? = nil,
                rateLimitResetCredits: PlanUsageRateLimitResetCredits? = nil,
                fetchedAt: String, generation: String, sequence: Int) {
        self.protocolVersion = protocolVersion
        self.support = support
        self.accountFingerprint = accountFingerprint
        self.rateLimitResetCredits = rateLimitResetCredits
        self.fetchedAt = fetchedAt
        self.generation = generation
        self.sequence = sequence
    }

    /// The contract's v1 support values that can be rendered by the reset card.
    public var isSupported: Bool { support == "SUPPORTED" }
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
    /// Earned Codex reset state (absent on older runners and non-Codex snapshots).
    public let rateLimitReset: PlanUsageRateLimitReset?
    public let fetchedAt: String?
    /// The runner's other accounts of this engine, by account id, each as its own windows: this
    /// snapshot's windows are Default's (web `codexAccountSnapshot`).
    public var accounts: [String: PlanUsageSnapshot]? = nil

    public init(provider: String? = nil, fiveHour: PlanUsageWindow? = nil,
                sevenDay: PlanUsageWindow? = nil, sevenDayOpus: PlanUsageWindow? = nil,
                sevenDaySonnet: PlanUsageWindow? = nil, primary: PlanUsageWindow? = nil,
                secondary: PlanUsageWindow? = nil, limitId: String? = nil,
                limitName: String? = nil, planType: String? = nil,
                rateLimitReachedType: String? = nil, credits: PlanUsageCredits? = nil,
                rateLimits: [PlanUsageRateLimit]? = nil,
                rateLimitReset: PlanUsageRateLimitReset? = nil,
                fetchedAt: String? = nil, accounts: [String: PlanUsageSnapshot]? = nil) {
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
        self.rateLimitReset = rateLimitReset
        self.fetchedAt = fetchedAt
        self.accounts = accounts
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
    /// Earned Codex reset state on a flat (legacy) provider snapshot.
    public let rateLimitReset: PlanUsageRateLimitReset?
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
                rateLimitReset: PlanUsageRateLimitReset? = nil,
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
        self.rateLimitReset = rateLimitReset
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
    /// At or past 90% used, judged on the reading rather than its rounding: 89.6 shows as 90% and
    /// is not near the limit (web's `PlanUsageDisplayRow.nearLimit`).
    public var nearLimit: Bool { window.utilization >= 90 }
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

    /// `rows` as they stand at `now` (web's `currentPlanUsageRows`). A window whose reset has passed
    /// reads as the fresh window it now is — nothing used, no reset to name — rather than as the
    /// reading taken before it rolled over: the runner reads again just after a reset, so a past one
    /// outlives it only on a reading that has stopped refreshing.
    func currentRows(at now: Date = Date()) -> [PlanUsageRow] {
        rows.map { row in
            guard let resets = planUsageResetDate(row.window), resets <= now else { return row }
            return PlanUsageRow(key: row.key, label: row.label, groupLabel: row.groupLabel,
                                window: PlanUsageWindow(utilization: 0, label: row.window.label,
                                                        windowDurationMins: row.window.windowDurationMins))
        }
    }

    /// The window that stops this login, or will stop it first (web's `bindingPlanUsageRow`): a spent
    /// one before any other — of several, the one that resets last, since the login is back only once
    /// every spent one has — else the one closest to its limit, a tie going to the first. Whatever
    /// shows one number for a login shows this one: a Claude login's 5-hour window can read 6% while
    /// its weekly one is spent.
    func bindingRow(at now: Date = Date()) -> PlanUsageRow? {
        let current = currentRows(at: now)
        let spent = current.filter { $0.window.utilization >= 100 }
        if let first = spent.first {
            // A spent window with no reset named holds the login for as long as anyone can tell.
            let reset = { (row: PlanUsageRow) in planUsageResetDate(row.window) ?? .distantFuture }
            return spent.dropFirst().reduce(first) { reset($1) > reset($0) ? $1 : $0 }
        }
        return current.dropFirst().reduce(current.first) { tightest, row in
            guard let tightest else { return row }
            return row.window.utilization > tightest.window.utilization ? row : tightest
        }
    }
}

/// When a window resets, or nil when it names no time this can read.
private func planUsageResetDate(_ window: PlanUsageWindow) -> Date? {
    guard let at = window.resetsAt else { return nil }
    let withFraction = ISO8601DateFormatter()
    withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return withFraction.date(from: at) ?? ISO8601DateFormatter().date(from: at)
}

public extension PlanUsage {
    var flatSnapshot: PlanUsageSnapshot {
        PlanUsageSnapshot(provider: provider, fiveHour: fiveHour, sevenDay: sevenDay,
                          sevenDayOpus: sevenDayOpus, sevenDaySonnet: sevenDaySonnet,
                          primary: primary, secondary: secondary, limitId: limitId,
                          limitName: limitName, planType: planType,
                          rateLimitReachedType: rateLimitReachedType, credits: credits,
                          rateLimits: rateLimits,
                          rateLimitReset: rateLimitReset,
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
}

/// The request that confirms one earned Codex reset credit. The client request id makes a retried
/// confirmation idempotent; the provider's private idempotency key never leaves the control plane.
public struct CreateCodexRateLimitResetRequest: Codable, Equatable, Sendable {
    public let clientRequestId: String
    public let accountFingerprint: String
    public let workspaceId: String?

    public init(clientRequestId: String, accountFingerprint: String, workspaceId: String? = nil) {
        self.clientRequestId = clientRequestId
        self.accountFingerprint = accountFingerprint
        self.workspaceId = workspaceId
    }
}

/// The public view of one reset-credit operation. Status values stay raw so a newer server can be
/// read by an older client without making the runner response undecodable.
public struct CodexRateLimitResetOperation: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let runnerId: String
    public let clientRequestId: String
    public let accountFingerprint: String
    public let status: String
    public let consumeState: String
    public let consumeOutcome: String?
    public let refreshState: String
    public let failureCode: String?
    public let lastErrorCode: String?
    public let createdAt: String
    public let updatedAt: String
    public let consumeConfirmedAt: String?
    public let completedAt: String?

    public init(id: String, runnerId: String, clientRequestId: String, accountFingerprint: String,
                status: String, consumeState: String, consumeOutcome: String? = nil,
                refreshState: String, failureCode: String? = nil, lastErrorCode: String? = nil,
                createdAt: String, updatedAt: String, consumeConfirmedAt: String? = nil,
                completedAt: String? = nil) {
        self.id = id
        self.runnerId = runnerId
        self.clientRequestId = clientRequestId
        self.accountFingerprint = accountFingerprint
        self.status = status
        self.consumeState = consumeState
        self.consumeOutcome = consumeOutcome
        self.refreshState = refreshState
        self.failureCode = failureCode
        self.lastErrorCode = lastErrorCode
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.consumeConfirmedAt = consumeConfirmedAt
        self.completedAt = completedAt
    }

    public var isActive: Bool {
        switch status {
        case "PENDING", "CONSUMING", "REFRESHING": return true
        case "SUCCEEDED", "REFRESH_FAILED", "NOTHING_TO_RESET", "NO_CREDIT", "NOT_ATTEMPTED", "UNRESOLVED":
            return false
        default:
            // A newer server may add an active checkpoint before this client knows its spelling.
            // Fail closed so the UI cannot submit a second credit while that operation is moving.
            return true
        }
    }
}

/// Name used by the shared wire contract; the shorter operation name remains convenient in the UI.
public typealias CodexRateLimitResetOperationView = CodexRateLimitResetOperation

/// The operation currently in flight and the most recent settled operation for a runner.
public struct CodexRateLimitResetOperations: Codable, Equatable, Sendable {
    public let active: CodexRateLimitResetOperation?
    public let latest: CodexRateLimitResetOperation?

    public init(active: CodexRateLimitResetOperation?, latest: CodexRateLimitResetOperation?) {
        self.active = active
        self.latest = latest
    }
}

/// The response to a reset-credit confirmation. A replay returns the original operation.
public struct CreateCodexRateLimitResetResponse: Codable, Equatable, Sendable {
    public let operation: CodexRateLimitResetOperation
    public let replayed: Bool

    public init(operation: CodexRateLimitResetOperation, replayed: Bool) {
        self.operation = operation
        self.replayed = replayed
    }
}
