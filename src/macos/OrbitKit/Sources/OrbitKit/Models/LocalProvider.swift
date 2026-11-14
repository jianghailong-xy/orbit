import Foundation

/// A runner-scoped provider — a model server on one runner's machine, reached by that runner alone
/// (docs/ollama-local-provider-contract.md). Ollama is the first one; on the wire it is an ordinary
/// `ModelProvider` row whose `scope` is `runner`, whose `authMode` is `none`, and whose `local` block
/// is what the bound runner last probed.
///
/// This file mirrors `src/shared/src/localProvider.ts` case for case: the same states, the same
/// refusal codes and the same sentences, so a Web picker and a native one answer alike from one
/// server response. `contracts/ollama-provider.fixtures.json` holds both to the same cases.
public enum LocalProviderState: String, Codable, Equatable, Sendable, CaseIterable {
    case ready = "READY"
    case unreachable = "UNREACHABLE"
    case malformed = "MALFORMED"
    case cloudEnabled = "CLOUD_ENABLED"
    case noModels = "NO_MODELS"
    case modelMissing = "MODEL_MISSING"
    case capabilityMissing = "CAPABILITY_MISSING"
    case refused = "REFUSED"
    case unknown = "UNKNOWN"
    case stale = "STALE"
    case disabled = "DISABLED"
    case noRunner = "NO_RUNNER"

    /// The states a probe itself can store (shared `LOCAL_PROBE_STATES`). UNKNOWN, STALE, DISABLED and
    /// NO_RUNNER are read-time answers and never come from the probe.
    public static let probeStates: Set<LocalProviderState> = [
        .ready, .unreachable, .malformed, .cloudEnabled, .noModels, .modelMissing,
        .capabilityMissing, .refused,
    ]

    /// What the row says at a glance, in the picker.
    public var label: String {
        switch self {
        case .ready: return "Ready"
        case .unreachable: return "Not answering"
        case .malformed, .refused: return "Misconfigured"
        case .cloudEnabled: return "Cloud enabled"
        case .noModels: return "No models"
        case .modelMissing: return "Model missing"
        case .capabilityMissing: return "Model can't run Claude Code"
        case .unknown: return "Not checked yet"
        case .stale: return "Status stale"
        case .disabled: return "Turned off"
        case .noRunner: return "No runner"
        }
    }
}

/// One model the instance serves, as the runner discovered it (`LocalInstanceModel`).
public struct LocalInstanceModel: Codable, Equatable, Sendable, Identifiable {
    public let value: String
    public let label: String?
    public let contextWindow: Int?
    /// Whether the model advertises tool calling; absent when the runner could not tell.
    public let tools: Bool?
    public let parameterSize: String?
    public let quantization: String?
    public var id: String { value }

    public init(value: String, label: String? = nil, contextWindow: Int? = nil, tools: Bool? = nil,
                parameterSize: String? = nil, quantization: String? = nil) {
        self.value = value
        self.label = label
        self.contextWindow = contextWindow
        self.tools = tools
        self.parameterSize = parameterSize
        self.quantization = quantization
    }
}

/// A runner-scoped provider's status block on a provider read (`LocalProviderStatus`): never an
/// endpoint and never a key.
public struct LocalProviderStatus: Codable, Equatable, Sendable {
    /// One of `LocalProviderState`.
    public let state: String
    /// SUPPORTED when the bound runner declared `ollama-probe/v1`; UNKNOWN for a runner too old to say.
    public let capability: String
    public let probedAt: String?
    public let version: String?
    public let latencyMs: Int?
    public let models: [LocalInstanceModel]?

    public init(state: String, capability: String, probedAt: String? = nil, version: String? = nil,
                latencyMs: Int? = nil, models: [LocalInstanceModel]? = nil) {
        self.state = state
        self.capability = capability
        self.probedAt = probedAt
        self.version = version
        self.latencyMs = latencyMs
        self.models = models
    }

    public var stateValue: LocalProviderState? { LocalProviderState(rawValue: state) }
}

/// Every refusal a local provider gives a session, with the same codes as the server
/// (`LOCAL_PROVIDER_REFUSAL_CODES`). A client reads them to say *why* before a submit, not to decide
/// dispatch: the doors refuse on their own.
public enum LocalProviderRefusalCode: String, Codable, Equatable, Sendable, CaseIterable {
    case disabled = "LOCAL_PROVIDER_DISABLED"
    case noRunner = "LOCAL_PROVIDER_NO_RUNNER"
    case elsewhere = "LOCAL_PROVIDER_ELSEWHERE"
    case runnerOutdated = "LOCAL_PROVIDER_RUNNER_OUTDATED"
    case unprobed = "LOCAL_PROVIDER_UNPROBED"
    case stale = "LOCAL_PROVIDER_STALE"
    case unreachable = "LOCAL_PROVIDER_UNREACHABLE"
    case misconfigured = "LOCAL_PROVIDER_MISCONFIGURED"
    case noModels = "LOCAL_PROVIDER_NO_MODELS"
    case modelMissing = "LOCAL_PROVIDER_MODEL_MISSING"
    case capabilityMissing = "LOCAL_PROVIDER_CAPABILITY_MISSING"

    /// The refusals that clear on their own: the runner's next probe answers them.
    public var isTransient: Bool {
        switch self {
        case .unprobed, .stale, .unreachable: return true
        default: return false
        }
    }

    /// Where a person goes to clear it. A provider's own page is fixed on the Web app, which is
    /// where a local provider is connected and edited in the first release; a runner's page is in
    /// these apps, and is where a runner is bound, updated or seen to be probing.
    public var remedy: LocalProviderRemedy {
        switch self {
        case .disabled, .noRunner, .misconfigured, .noModels, .modelMissing, .capabilityMissing:
            return .manageProvider
        case .elsewhere, .runnerOutdated, .unprobed, .stale, .unreachable:
            return .runnerPage
        }
    }
}

/// What a picker offers beside a refusal: the two pages that fix one, or nothing while a probe is
/// on its way.
public enum LocalProviderRemedy: Equatable, Sendable {
    /// The provider's own page on the Web app, where it is turned on, bound or edited.
    case manageProvider
    /// The bound runner's page — in these apps — where it is updated, or where its probe is seen.
    case runnerPage
}

/// One refusal, its code and the sentence the session waits with — the same words the server uses.
public struct LocalProviderRefusal: Equatable, Sendable {
    public let code: LocalProviderRefusalCode
    public let transient: Bool
    public let message: String

    public init(code: LocalProviderRefusalCode, transient: Bool, message: String) {
        self.code = code
        self.transient = transient
        self.message = message
    }

    public var remedy: LocalProviderRemedy { code.remedy }
}

/// The row facts the rules read — what the server keeps about a runner-scoped provider, with or
/// without the `local` block it serves. Decodable so a contract fixture can hold both clients to it.
public struct LocalProviderFacts: Codable, Equatable, Sendable {
    public let slug: String?
    public let enabled: Bool
    public let runnerId: String?
    public let probeState: String?
    public let probedAt: String?
    public let probeVersion: String?
    public let probeLatencyMs: Int?
    public let instanceModels: [LocalInstanceModel]?
    /// The models the row names, and the one it names as its default.
    public let defaultModel: String?
    public let models: [ConfiguredProviderModel]?

    public init(slug: String? = nil, enabled: Bool = true, runnerId: String? = nil,
                probeState: String? = nil, probedAt: String? = nil, probeVersion: String? = nil,
                probeLatencyMs: Int? = nil, instanceModels: [LocalInstanceModel]? = nil,
                defaultModel: String? = nil, models: [ConfiguredProviderModel]? = nil) {
        self.slug = slug
        self.enabled = enabled
        self.runnerId = runnerId
        self.probeState = probeState
        self.probedAt = probedAt
        self.probeVersion = probeVersion
        self.probeLatencyMs = probeLatencyMs
        self.instanceModels = instanceModels
        self.defaultModel = defaultModel
        self.models = models
    }
}

/// What a runner reports of one heartbeat's capabilities (`Runner.capabilities`), and whether it has
/// reported at all — a missing report is never read as health.
public struct LocalProviderRunnerFacts: Codable, Equatable, Sendable {
    public let capabilities: [String]?
    public let reported: Bool

    public init(capabilities: [String]? = nil, reported: Bool = false) {
        self.capabilities = capabilities
        self.reported = reported
    }

    /// A runner as GET /runners serves it: a `capabilities` list that is present is a report, and a
    /// missing one claims nothing.
    public static func reported(_ capabilities: [String]?) -> LocalProviderRunnerFacts {
        LocalProviderRunnerFacts(capabilities: capabilities, reported: capabilities != nil)
    }
}

/// The session a readiness answer is about: the runner it would run on, that runner's report, and
/// the model it would run.
public struct LocalProviderTarget: Equatable, Sendable {
    public let runnerId: String?
    public let runner: LocalProviderRunnerFacts?
    public let model: String?

    public init(runnerId: String?, runner: LocalProviderRunnerFacts?, model: String?) {
        self.runnerId = runnerId
        self.runner = runner
        self.model = model
    }
}

public enum LocalProviders {
    /// The vendor preset of the first local server.
    public static let presetSlug = "ollama"
    /// What a runner declares once it can probe the instance.
    public static let probeCapability = "ollama-probe/v1"
    /// What a runner declares once it keeps a local session off every other route.
    public static let runCapability = "ollama-run/v1"
    /// The smallest context a model may serve Claude Code with (64K tokens).
    public static let minContextWindow = 65_536
    /// A probe older than this reads as STALE: five probe intervals.
    public static let staleInterval: TimeInterval = 5 * 60
    /// Every refusal sentence begins with this, as on the server.
    public static let errorPrefix = "Local provider "

    // MARK: one probe's facts

    public static func declaresProbe(_ capabilities: [String]?) -> Bool {
        (capabilities ?? []).contains { $0.trimmingCharacters(in: .whitespaces).lowercased() == probeCapability }
    }

    public static func declaresRun(_ capabilities: [String]?) -> Bool {
        (capabilities ?? []).contains { $0.trimmingCharacters(in: .whitespaces).lowercased() == runCapability }
    }

    /// A model id Ollama would forward to ollama.com rather than serving itself.
    public static func isCloudModel(_ id: String) -> Bool {
        let value = id.trimmingCharacters(in: .whitespaces).lowercased()
        return value.hasSuffix("-cloud") || value.hasSuffix(":cloud")
    }

    /// The instance's entry for `model`: Ollama serves `llama3` as `llama3:latest`, so a name
    /// without a tag matches its `:latest`.
    public static func instanceModel(_ catalogue: [LocalInstanceModel]?,
                                     model: String) -> LocalInstanceModel? {
        let name = model.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return nil }
        let tagged = name.contains(":") ? name : "\(name):latest"
        return catalogue?.first { $0.value == name || $0.value == tagged }
    }

    /// The model a session on a local provider would run: its own, else the row's default, else the
    /// first the row lists. Never the built-in Claude default — a local provider has no such model.
    public static func targetModel(defaultModel: String?, models: [ConfiguredProviderModel]?,
                                   sessionModel: String?) -> String? {
        let own = (sessionModel ?? "").trimmingCharacters(in: .whitespaces)
        if !own.isEmpty { return own }
        let fallback = (defaultModel ?? "").trimmingCharacters(in: .whitespaces)
        if !fallback.isEmpty { return fallback }
        guard let first = models?.first?.value.trimmingCharacters(in: .whitespaces), !first.isEmpty else {
            return nil
        }
        return first
    }

    public static func targetModel(row: ConfiguredProvider, sessionModel: String?) -> String? {
        targetModel(defaultModel: row.defaultModel, models: row.models, sessionModel: sessionModel)
    }

    // MARK: the status a picker shows

    /// A runner-scoped row's status, from the row and its bound runner, exactly as the server derives
    /// it: DISABLED, then NO_RUNNER, then UNKNOWN for a runner too old to probe or a row never
    /// probed, then STALE for a probe older than `staleInterval`, then the probe's own state.
    public static func status(_ row: LocalProviderFacts, runner: LocalProviderRunnerFacts?,
                              now: Date = Date()) -> LocalProviderStatus {
        let capability = (runner?.reported == true && declaresProbe(runner?.capabilities))
            ? "SUPPORTED" : "UNKNOWN"
        let probed = row.probeState.flatMap(LocalProviderState.init(rawValue:))
        // A client that keeps what the server served reads a derived state back in, STALE included
        // (a picker row carries the served `local` block, not the stored columns). STALE therefore
        // reads as one, as it does in the shared rule.
        let probedState = probed.flatMap {
            LocalProviderState.probeStates.contains($0) || $0 == .stale ? $0 : nil
        }
        let probedAt = parseDate(row.probedAt)
        let stale = probedAt.map { now.timeIntervalSince($0) > staleInterval } ?? true
        let state: LocalProviderState
        if !row.enabled {
            state = .disabled
        } else if runner == nil {
            state = .noRunner
        } else if capability == "UNKNOWN" || probedState == nil {
            state = .unknown
        } else if stale || probedState == .stale {
            state = .stale
        } else {
            state = probedState!
        }
        return LocalProviderStatus(
            state: state.rawValue,
            capability: capability,
            probedAt: probedAt.map(isoString),
            version: row.probeVersion,
            latencyMs: row.probeLatencyMs,
            models: row.instanceModels)
    }

    // MARK: dispatch readiness

    /// The one rule every door applies, mirrored for the clients: whether a session may run on this
    /// runner-scoped provider now, and the refusal when it may not. Fails closed — a missing runner
    /// report, a missing probe and a missing catalogue entry all refuse.
    public static func readiness(_ row: LocalProviderFacts, target: LocalProviderTarget,
                                 now: Date = Date()) -> LocalProviderRefusal? {
        let name = "\"\(row.slug ?? "")\""
        func refuse(_ code: LocalProviderRefusalCode, _ rest: String) -> LocalProviderRefusal {
            LocalProviderRefusal(code: code, transient: code.isTransient,
                                 message: "\(errorPrefix)\(name) \(rest)")
        }
        if !row.enabled {
            return refuse(.disabled, "is disabled; enable it, or switch this session to another provider")
        }
        guard let bound = row.runnerId, !bound.isEmpty else {
            return refuse(.noRunner, "runs only on its own runner, and it has none; bind it to one of your runners")
        }
        if target.runnerId != bound {
            return refuse(.elsewhere, "runs only on the runner it is bound to; start this session on that runner")
        }
        let runner = target.runner
        if runner == nil || !runner!.reported || !declaresProbe(runner!.capabilities)
            || !declaresRun(runner!.capabilities) {
            return refuse(.runnerOutdated,
                          "needs a runner that keeps its session on the local endpoint: update the runner it is "
                          + "bound to, or see that runner's log for why it stopped offering local providers")
        }
        // Read the stored probe at this moment: a READY that has gone stale since the server answered
        // is stale here too.
        let status = status(row, runner: runner, now: now)
        switch LocalProviderState(rawValue: status.state) {
        case .unknown?, nil:
            return refuse(.unprobed, "has not been checked by its runner yet; this session starts once it is")
        case .stale?:
            return refuse(.stale, "has not been checked recently; its runner may be offline. This session starts once it reports again")
        case .unreachable?:
            return refuse(.unreachable, "is not answering on its runner (stopped, still loading, or busy); this session starts once it answers")
        case .malformed?, .refused?, .cloudEnabled?:
            return refuse(.misconfigured, "is not an endpoint its runner can use; check its address on that runner")
        case .noModels?:
            return refuse(.noModels, "serves no local model; pull one on its runner")
        case .ready?, .modelMissing?, .capabilityMissing?, .disabled?, .noRunner?:
            break
        }
        let model = (target.model ?? "").trimmingCharacters(in: .whitespaces)
        if model.isEmpty {
            return refuse(.modelMissing, "names no model; choose one of the models it serves")
        }
        if isCloudModel(model) {
            return refuse(.misconfigured, "would forward model \"\(model)\" to Ollama's cloud; choose a local model")
        }
        guard let entry = instanceModel(row.instanceModels, model: model) else {
            return refuse(.modelMissing, "does not serve model \"\(model)\"; pull it on its runner or choose another")
        }
        if entry.tools != true {
            return refuse(.capabilityMissing, "serves model \"\(model)\" without tool calling; choose a model with tools")
        }
        guard let window = entry.contextWindow, window >= minContextWindow else {
            return refuse(.capabilityMissing,
                          "serves model \"\(model)\" with less than \(minContextWindow) tokens of context; choose a larger model")
        }
        return nil
    }

    public static func readiness(row: ConfiguredProvider, target: LocalProviderTarget,
                                 now: Date = Date()) -> LocalProviderRefusal? {
        readiness(facts(from: row), target: target, now: now)
    }

    /// A provider read as the rule's facts. The server's `local` block is the bound runner's probe, so
    /// its state goes back in as the stored state; the session's runner facts decide capability.
    public static func facts(from row: ConfiguredProvider) -> LocalProviderFacts {
        LocalProviderFacts(
            slug: row.slug,
            // The served block is a derived state: DISABLED is the row's own reason even when a
            // caller that lists disabled rows did not carry the `enabled` column.
            enabled: (row.enabled ?? true) && row.local?.state != "DISABLED",
            runnerId: row.runnerId,
            probeState: row.local?.state,
            probedAt: row.local?.probedAt,
            probeVersion: row.local?.version,
            probeLatencyMs: row.local?.latencyMs,
            instanceModels: row.local?.models,
            defaultModel: row.defaultModel,
            models: row.models)
    }

    /// Whether the session's runner can probe and run a local provider — the same two declarations the
    /// server's gate requires.
    public static func runnerCanRun(_ capabilities: [String]?) -> Bool {
        declaresProbe(capabilities) && declaresRun(capabilities)
    }

    // MARK: one model's readiness

    /// Why `model` cannot be chosen on this row, or nil when it can. The probe-level states are the
    /// provider's own answer (readiness); this is the per-model half a picker needs to grey out one
    /// row of the model menu while another can run.
    public static func modelReadiness(_ row: ConfiguredProvider, model: String,
                                      now: Date = Date()) -> LocalProviderRefusal? {
        let facts = facts(from: row)
        let providerRefusal = readiness(facts, target: LocalProviderTarget(
            runnerId: row.runnerId,
            runner: LocalProviderRunnerFacts(capabilities: [probeCapability, runCapability], reported: true),
            model: model), now: now)
        // A provider-level refusal that names the model is the model's own; a runner/probe refusal
        // belongs to the whole row and is already shown there.
        guard let providerRefusal else { return nil }
        switch providerRefusal.code {
        case .modelMissing, .capabilityMissing, .misconfigured: return providerRefusal
        default: return nil
        }
    }

    /// The efforts a local model declares on Claude Code (`reasoningLevels` on the row), or nil when it
    /// declares none. The Composer already reads this through `AgentDefaults`; exposed here so a
    /// fixture can state it without building a whole `ChoiceSources`.
    public static func declaredEfforts(_ row: ConfiguredProvider, model: String?) -> [String]? {
        guard let model else { return nil }
        return row.models.first { $0.value == model }?.reasoningLevels
    }

    // MARK: dates

    static func parseDate(_ value: String?) -> Date? {
        guard let value, !value.isEmpty else { return nil }
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: value) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: value)
    }

    static func isoString(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}
