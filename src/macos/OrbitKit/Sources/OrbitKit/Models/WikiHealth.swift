import Foundation

// A space's health — the Swift mirror of `@orbit/shared`'s `wikiHealth.ts`, which transcribes
// `contracts/wiki.contract.json` `maintenance.health` (criterion 5): what the Wiki home's status line
// reads. `WikiHealthCopyParityTests` holds the looks and the threshold below to that file.
//
// As in `WikiArticles.swift`, a look this build has never heard of decodes as `.unknown`, and every
// field reads as its default when a server one release apart leaves it out: the line then draws less
// instead of the read failing.

/// The looks of the status line's maintenance part, in the order they win (contract `maintenance.health.looks`).
public enum WikiMaintenanceLook: String, Codable, Sendable, CaseIterable {
    case off, failing, running, behind, ok
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiMaintenanceLook(rawValue: raw) ?? .unknown
    }

    /// The five the contract names, in its order.
    public static let contractOrder: [WikiMaintenanceLook] = [.off, .failing, .running, .behind, .ok]
}

/// The numbers the health runs by (contract `maintenance.health`).
public enum WikiHealthRules {
    /// The consecutive failures at which the owner is told, once for the streak (`notify.afterFailures`).
    public static let notifyAfterFailures = 3
}

/// A space's maintenance run, as the status line reads it.
public struct WikiMaintenanceHealth: Codable, Equatable, Sendable {
    /// The run under way: its session, and when it started — and the server's job that runs it (`jobId`, P9),
    /// which a run of a maintenance session has none of.
    public struct Running: Codable, Equatable, Sendable {
        public let sessionId: String?
        public let jobId: String?
        public let startedAt: String

        public init(sessionId: String?, jobId: String? = nil, startedAt: String) {
            self.sessionId = sessionId
            self.jobId = jobId
            self.startedAt = startedAt
        }
    }

    /// The run that ended last, and how — what View run opens: its session, or the server's job (`jobId`, P9)
    /// of a run that has no session, whose row on Activity it opens instead.
    public struct LastRun: Codable, Equatable, Sendable {
        public let sessionId: String?
        public let jobId: String?
        public let outcome: String?
        public let endedAt: String

        public init(sessionId: String?, jobId: String? = nil, outcome: String?, endedAt: String) {
            self.sessionId = sessionId
            self.jobId = jobId
            self.outcome = outcome
            self.endedAt = endedAt
        }
    }

    /// Of the runs whose latest attempt failed, the one that ended last: whose failure it was (`kind`,
    /// `infra` or `content`), its error, and when it ended.
    public struct LastFailure: Codable, Equatable, Sendable {
        public let kind: String
        public let reason: String?
        public let at: String
        public let sessionId: String?
        public let jobId: String?

        public init(kind: String, reason: String?, at: String, sessionId: String?, jobId: String? = nil) {
            self.kind = kind
            self.reason = reason
            self.at = at
            self.sessionId = sessionId
            self.jobId = jobId
        }
    }

    public let look: WikiMaintenanceLook
    public let enabled: Bool
    public let lastOkAt: String?
    public let lastRunAt: String?
    public let consecutiveFailures: Int
    /// The facts after the cursor, counted as the read is made; 0 while maintenance is off.
    public let backlog: Int
    public let oldestPendingAt: String?
    public let lagSeconds: Int
    public let dailyLimitReached: Bool
    public let held: WikiMaintenanceHeld?
    public let running: Running?
    public let lastRun: LastRun?
    public let lastFailure: LastFailure?

    public init(look: WikiMaintenanceLook, enabled: Bool, lastOkAt: String? = nil, lastRunAt: String? = nil,
                consecutiveFailures: Int = 0, backlog: Int = 0, oldestPendingAt: String? = nil, lagSeconds: Int = 0,
                dailyLimitReached: Bool = false, held: WikiMaintenanceHeld? = nil, running: Running? = nil,
                lastRun: LastRun? = nil, lastFailure: LastFailure? = nil) {
        self.look = look
        self.enabled = enabled
        self.lastOkAt = lastOkAt
        self.lastRunAt = lastRunAt
        self.consecutiveFailures = consecutiveFailures
        self.backlog = backlog
        self.oldestPendingAt = oldestPendingAt
        self.lagSeconds = lagSeconds
        self.dailyLimitReached = dailyLimitReached
        self.held = held
        self.running = running
        self.lastRun = lastRun
        self.lastFailure = lastFailure
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        look = (try? c.decodeIfPresent(WikiMaintenanceLook.self, forKey: .look)) ?? .unknown
        enabled = (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? false
        lastOkAt = try? c.decodeIfPresent(String.self, forKey: .lastOkAt)
        lastRunAt = try? c.decodeIfPresent(String.self, forKey: .lastRunAt)
        consecutiveFailures = (try? c.decodeIfPresent(Int.self, forKey: .consecutiveFailures)) ?? 0
        backlog = (try? c.decodeIfPresent(Int.self, forKey: .backlog)) ?? 0
        oldestPendingAt = try? c.decodeIfPresent(String.self, forKey: .oldestPendingAt)
        lagSeconds = (try? c.decodeIfPresent(Int.self, forKey: .lagSeconds)) ?? 0
        dailyLimitReached = (try? c.decodeIfPresent(Bool.self, forKey: .dailyLimitReached)) ?? false
        held = try? c.decodeIfPresent(WikiMaintenanceHeld.self, forKey: .held)
        running = try? c.decodeIfPresent(Running.self, forKey: .running)
        lastRun = try? c.decodeIfPresent(LastRun.self, forKey: .lastRun)
        lastFailure = try? c.decodeIfPresent(LastFailure.self, forKey: .lastFailure)
    }
}

/// What the space's repository steps depend on (contract `repoOps.looks`, P2): whether the machine the space's
/// workspace runs on can be asked for the repository, and why not.
public enum WikiRepoLook: String, Codable, Sendable, CaseIterable {
    case ready
    case noWorkspace = "no_workspace"
    case runnerMissing = "runner_missing"
    case runnerOffline = "runner_offline"
    case runnerUpgrade = "runner_upgrade"
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WikiRepoLook(rawValue: raw) ?? .unknown
    }

    /// The five the contract names, in its order.
    public static let contractOrder: [WikiRepoLook] = [.ready, .noWorkspace, .runnerMissing, .runnerOffline, .runnerUpgrade]
}

/// The repository half of the health read (P2): the look, and how many of the space's repository operations wait.
public struct WikiSpaceRepoHealth: Codable, Equatable, Sendable {
    public let look: WikiRepoLook
    public let pending: Int

    public init(look: WikiRepoLook, pending: Int = 0) {
        self.look = look
        self.pending = pending
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        look = (try? c.decodeIfPresent(WikiRepoLook.self, forKey: .look)) ?? .unknown
        pending = (try? c.decodeIfPresent(Int.self, forKey: .pending)) ?? 0
    }
}

/// `GET /wiki/spaces/:id/health`: every active entry of the space, and where its maintenance run stands — and,
/// from P2 and P9 on, what the server's runs depend on: the repository's look, whether the server executes this
/// account's wiki (`executor`), and the System model's state while it does. Each is absent from an older control
/// plane, which reads as runner and draws the line as it always was.
public struct WikiSpaceHealth: Codable, Equatable, Sendable {
    public let spaceId: String
    /// The space's active entries, every one of them — the status line's `N entries`.
    public let entries: Int
    public let maintenance: WikiMaintenanceHealth
    public let repo: WikiSpaceRepoHealth?
    public let executor: WikiExecutorView?
    public let systemModel: WikiSystemModelStatus?

    public init(spaceId: String, entries: Int, maintenance: WikiMaintenanceHealth, repo: WikiSpaceRepoHealth? = nil,
                executor: WikiExecutorView? = nil, systemModel: WikiSystemModelStatus? = nil) {
        self.spaceId = spaceId
        self.entries = entries
        self.maintenance = maintenance
        self.repo = repo
        self.executor = executor
        self.systemModel = systemModel
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        spaceId = try c.decode(String.self, forKey: .spaceId)
        entries = (try? c.decodeIfPresent(Int.self, forKey: .entries)) ?? 0
        maintenance = try c.decode(WikiMaintenanceHealth.self, forKey: .maintenance)
        repo = try? c.decodeIfPresent(WikiSpaceRepoHealth.self, forKey: .repo)
        executor = try? c.decodeIfPresent(WikiExecutorView.self, forKey: .executor)
        systemModel = try? c.decodeIfPresent(WikiSystemModelStatus.self, forKey: .systemModel)
    }

    /// The server runs this account's wiki: what the status line's server reasons and Activity's Runs ask first.
    public var serverExecutes: Bool { executor?.serverExecutes == true }
}
