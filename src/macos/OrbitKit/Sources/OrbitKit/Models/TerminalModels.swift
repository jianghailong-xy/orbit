import Foundation

// The owner's terminals (docs/terminal-session-design.md, "The terminal credential"): a machine where `orbit` asked to
// be approved, and the terminals approved since. Mirrors `src/web/src/lib/terminals.ts` and what
// `TerminalLoginService.pending` / `.list` answer — never a credential, only what the card and Settings → Terminals show.

/// A terminal sign-in waiting for the owner: what the approve card shows. `GET /terminals/requests`.
public struct TerminalRequest: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    /// The code the terminal shows ("7KQ-4MZ"), compared by eye before Approve.
    public let userCode: String
    public let machineName: String
    public let runnerId: String
    public let createdAt: String
    public let expiresAt: String

    public init(id: String, userCode: String, machineName: String, runnerId: String, createdAt: String, expiresAt: String) {
        self.id = id
        self.userCode = userCode
        self.machineName = machineName
        self.runnerId = runnerId
        self.createdAt = createdAt
        self.expiresAt = expiresAt
    }
}

public struct TerminalRequestList: Codable, Equatable, Sendable {
    public let requests: [TerminalRequest]
}

/// A live terminal — approved, not revoked, not expired. `GET /terminals`.
public struct Terminal: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let machineName: String
    public let runnerId: String
    public let createdAt: String
    public let approvedAt: String
    public let lastUsedAt: String?
    public let expiresAt: String

    public init(id: String, machineName: String, runnerId: String, createdAt: String, approvedAt: String,
                lastUsedAt: String?, expiresAt: String) {
        self.id = id
        self.machineName = machineName
        self.runnerId = runnerId
        self.createdAt = createdAt
        self.approvedAt = approvedAt
        self.lastUsedAt = lastUsedAt
        self.expiresAt = expiresAt
    }
}

public struct TerminalList: Codable, Equatable, Sendable {
    public let terminals: [Terminal]
}
