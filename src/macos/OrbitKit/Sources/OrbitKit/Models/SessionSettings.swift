import Foundation

// A session's Settings panel (docs/mocks/session-settings, native.html ①–④): what `GET /sessions/:id`
// carries as `settings`, `usage` and `engineVersion`, what `PATCH /sessions/:id/settings` takes and
// answers, and what `POST /sessions/:id/restart` answers. Mirrors `SessionSettingsValues`, `SessionUsage`,
// `SessionSettingsPatch` and `SessionRestartResponse` in src/shared/src/dto.ts.

/// A per-session notification choice: follow the account preference, or always / never notify. A
/// value this build does not know reads as `inherit`, which is what the server does with none.
public enum SessionNotifyOverride: String, Codable, Equatable, Sendable, CaseIterable {
    case inherit, on, off

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SessionNotifyOverride(rawValue: raw) ?? .inherit
    }
}

/// `settings` on the session detail, and the body `PATCH /sessions/:id/settings` answers with.
public struct SessionSettingsValues: Codable, Equatable, Sendable {
    /// The session's own variables, laid over the workspace's when the engine starts (session wins).
    public var env: [String: String]
    /// The session workspace's variables; read-only here.
    public var workspaceEnv: [String: String]
    public var notifyTurnFinished: SessionNotifyOverride
    /// Approvals and questions.
    public var notifyNeedsYou: SessionNotifyOverride
    /// No pushes at all for this session while true.
    public var muted: Bool
    /// The engine is live and started before the session's env last changed: a restart is owed.
    public var envPendingRestart: Bool

    public init(env: [String: String] = [:], workspaceEnv: [String: String] = [:],
                notifyTurnFinished: SessionNotifyOverride = .inherit, notifyNeedsYou: SessionNotifyOverride = .inherit,
                muted: Bool = false, envPendingRestart: Bool = false) {
        self.env = env
        self.workspaceEnv = workspaceEnv
        self.notifyTurnFinished = notifyTurnFinished
        self.notifyNeedsYou = notifyNeedsYou
        self.muted = muted
        self.envPendingRestart = envPendingRestart
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        env = (try? c.decodeIfPresent([String: String].self, forKey: .env)) ?? [:]
        workspaceEnv = (try? c.decodeIfPresent([String: String].self, forKey: .workspaceEnv)) ?? [:]
        notifyTurnFinished = try c.decodeIfPresent(SessionNotifyOverride.self, forKey: .notifyTurnFinished) ?? .inherit
        notifyNeedsYou = try c.decodeIfPresent(SessionNotifyOverride.self, forKey: .notifyNeedsYou) ?? .inherit
        muted = try c.decodeIfPresent(Bool.self, forKey: .muted) ?? false
        envPendingRestart = try c.decodeIfPresent(Bool.self, forKey: .envPendingRestart) ?? false
    }
}

/// `usage` on the session detail: what the session has spent over all its turns.
public struct SessionUsage: Codable, Equatable, Sendable {
    public var inputTokens: Int
    public var outputTokens: Int
    public var cacheReadTokens: Int
    public var cacheCreationTokens: Int
    public var costUsd: Double
    public var numTurns: Int

    public init(inputTokens: Int = 0, outputTokens: Int = 0, cacheReadTokens: Int = 0,
                cacheCreationTokens: Int = 0, costUsd: Double = 0, numTurns: Int = 0) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheReadTokens = cacheReadTokens
        self.cacheCreationTokens = cacheCreationTokens
        self.costUsd = costUsd
        self.numTurns = numTurns
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        inputTokens = try c.decodeIfPresent(Int.self, forKey: .inputTokens) ?? 0
        outputTokens = try c.decodeIfPresent(Int.self, forKey: .outputTokens) ?? 0
        cacheReadTokens = try c.decodeIfPresent(Int.self, forKey: .cacheReadTokens) ?? 0
        cacheCreationTokens = try c.decodeIfPresent(Int.self, forKey: .cacheCreationTokens) ?? 0
        costUsd = try c.decodeIfPresent(Double.self, forKey: .costUsd) ?? 0
        numTurns = try c.decodeIfPresent(Int.self, forKey: .numTurns) ?? 0
    }
}

/// What the Settings panel reads off `GET /sessions/:id` beyond the `Session` row the app already
/// holds: the three keys above, and the workspace's working directory and the assigned runner's name
/// and engines that the Environment and Info groups show. Every key is optional, so an older server
/// decodes to nils and the panel leaves those rows out.
public struct SessionSettingsDetail: Decodable, Equatable, Sendable {
    public struct WorkspaceRef: Decodable, Equatable, Sendable {
        public let name: String?
        public let workDir: String?
        public init(name: String? = nil, workDir: String? = nil) {
            self.name = name
            self.workDir = workDir
        }
    }

    public struct RunnerRef: Decodable, Equatable, Sendable {
        public let id: String?
        public let name: String?
        public let engines: [RunnerEngineHealth]?

        public init(id: String? = nil, name: String? = nil, engines: [RunnerEngineHealth]? = nil) {
            self.id = id
            self.name = name
            self.engines = engines
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try? c.decodeIfPresent(String.self, forKey: .id)
            name = try? c.decodeIfPresent(String.self, forKey: .name)
            // One engine this build cannot read must not cost the panel the runner's name.
            engines = (try? c.decodeIfPresent([LossyDecodable<RunnerEngineHealth>].self, forKey: .engines))?
                .compactMap(\.value)
        }

        private enum CodingKeys: String, CodingKey { case id, name, engines }
    }

    public let settings: SessionSettingsValues?
    public let usage: SessionUsage?
    /// The assigned runner's reported version of the session's engine; nil when unknown.
    public let engineVersion: String?
    public let workspace: WorkspaceRef?
    public let assignedRunner: RunnerRef?

    public init(settings: SessionSettingsValues? = nil, usage: SessionUsage? = nil, engineVersion: String? = nil,
                workspace: WorkspaceRef? = nil, assignedRunner: RunnerRef? = nil) {
        self.settings = settings
        self.usage = usage
        self.engineVersion = engineVersion
        self.workspace = workspace
        self.assignedRunner = assignedRunner
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = try c.decodeIfPresent(SessionSettingsValues.self, forKey: .settings)
        usage = try c.decodeIfPresent(SessionUsage.self, forKey: .usage)
        engineVersion = try? c.decodeIfPresent(String.self, forKey: .engineVersion)
        workspace = try? c.decodeIfPresent(WorkspaceRef.self, forKey: .workspace)
        assignedRunner = try? c.decodeIfPresent(RunnerRef.self, forKey: .assignedRunner)
    }

    private enum CodingKeys: String, CodingKey { case settings, usage, engineVersion, workspace, assignedRunner }
}

/// `PATCH /sessions/:id/settings`. A nil field is left out of the body and so left unchanged; `env`
/// replaces the session's whole map.
public struct SessionSettingsPatch: Encodable, Equatable, Sendable {
    public var env: [String: String]?
    public var notifyTurnFinished: SessionNotifyOverride?
    public var notifyNeedsYou: SessionNotifyOverride?
    public var muted: Bool?

    public init(env: [String: String]? = nil, notifyTurnFinished: SessionNotifyOverride? = nil,
                notifyNeedsYou: SessionNotifyOverride? = nil, muted: Bool? = nil) {
        self.env = env
        self.notifyTurnFinished = notifyTurnFinished
        self.notifyNeedsYou = notifyNeedsYou
        self.muted = muted
    }
}

/// `POST /sessions/:id/restart` (202).
public struct SessionRestartResponse: Decodable, Equatable, Sendable {
    public let queued: Bool
    /// A turn is running now: the reload waits for it to end.
    public let afterTurn: Bool

    public init(queued: Bool = true, afterTurn: Bool) {
        self.queued = queued
        self.afterTurn = afterTurn
    }
}
