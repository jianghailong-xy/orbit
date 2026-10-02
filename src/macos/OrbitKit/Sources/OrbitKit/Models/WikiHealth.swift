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
    /// The run under way: its session, and when it started.
    public struct Running: Codable, Equatable, Sendable {
        public let sessionId: String?
        public let startedAt: String

        public init(sessionId: String?, startedAt: String) {
            self.sessionId = sessionId
            self.startedAt = startedAt
        }
    }

    /// The run that ended last, and how — what View run opens.
    public struct LastRun: Codable, Equatable, Sendable {
        public let sessionId: String?
        public let outcome: String?
        public let endedAt: String

        public init(sessionId: String?, outcome: String?, endedAt: String) {
            self.sessionId = sessionId
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

        public init(kind: String, reason: String?, at: String, sessionId: String?) {
            self.kind = kind
            self.reason = reason
            self.at = at
            self.sessionId = sessionId
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

/// `GET /wiki/spaces/:id/health`: every active entry of the space, and where its maintenance run stands.
public struct WikiSpaceHealth: Codable, Equatable, Sendable {
    public let spaceId: String
    /// The space's active entries, every one of them — the status line's `N entries`.
    public let entries: Int
    public let maintenance: WikiMaintenanceHealth

    public init(spaceId: String, entries: Int, maintenance: WikiMaintenanceHealth) {
        self.spaceId = spaceId
        self.entries = entries
        self.maintenance = maintenance
    }
}
