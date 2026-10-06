import Foundation

// Personal access tokens (docs/personal-access-token-design.md §3, §6.5, §9): what the account has
// issued so its scripts and the `orbit` CLI can call the API as its owner. The apps list them and
// revoke them — a lost laptop's token ended from the phone — and never issue one (§9). Mirrors
// `src/web/src/api.ts` (`AccessToken`) and what `PatService.list` answers: every column but the
// hash, so never the token itself.

/// ACTIVE works; EXPIRED ran past its expiry; REVOKED was ended by someone (`revokedReason`). A state
/// this build does not know reads as `unknown` rather than failing the list that carried it.
public enum AccessTokenState: String, Codable, Sendable {
    case active = "ACTIVE"
    case expired = "EXPIRED"
    case revoked = "REVOKED"
    case unknown = "UNKNOWN"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AccessTokenState(rawValue: raw) ?? .unknown
    }
}

/// A workspace a confined token reaches, by name — the server names them, since an administrator
/// reading someone else's list could not look them up.
public struct AccessTokenWorkspace: Codable, Equatable, Sendable {
    public let id: String
    public let name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

/// One token as its owner's list shows it.
public struct AccessToken: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    /// The token's last four characters, so it can be told apart from the others.
    public let tokenHint: String
    public let scopes: [String]
    /// Empty: not confined to any workspace.
    public let workspaceIds: [String]
    /// Those workspaces, named; one deleted since is missing.
    public let workspaces: [AccessTokenWorkspace]
    /// Nil: never expires.
    public let expiresAt: String?
    /// `WEB` (issued in Settings) or `CLI_DEVICE` (by `orbit login`).
    public let createdVia: String
    public let lastUsedAt: String?
    public let lastUsedIp: String?
    public let lastUsedUserAgent: String?
    public let revokedAt: String?
    /// `USER`, `EXPIRED`, `PASSWORD_CHANGED`, `USER_DELETED` or `ADMIN`; nil while it works.
    public let revokedReason: String?
    public let createdAt: String
    public let state: AccessTokenState

    public init(id: String, name: String, tokenHint: String = "", scopes: [String] = [],
                workspaceIds: [String] = [], workspaces: [AccessTokenWorkspace] = [],
                expiresAt: String? = nil, createdVia: String = "WEB", lastUsedAt: String? = nil,
                lastUsedIp: String? = nil, lastUsedUserAgent: String? = nil, revokedAt: String? = nil,
                revokedReason: String? = nil, createdAt: String = "", state: AccessTokenState = .active) {
        self.id = id
        self.name = name
        self.tokenHint = tokenHint
        self.scopes = scopes
        self.workspaceIds = workspaceIds
        self.workspaces = workspaces
        self.expiresAt = expiresAt
        self.createdVia = createdVia
        self.lastUsedAt = lastUsedAt
        self.lastUsedIp = lastUsedIp
        self.lastUsedUserAgent = lastUsedUserAgent
        self.revokedAt = revokedAt
        self.revokedReason = revokedReason
        self.createdAt = createdAt
        self.state = state
    }
}

/// `GET /access-tokens`: every token the account has issued, newest first, revoked and expired
/// ones included.
public struct AccessTokenList: Codable, Equatable, Sendable {
    public let tokens: [AccessToken]

    public init(tokens: [AccessToken]) {
        self.tokens = tokens
    }
}

/// `DELETE /access-tokens/:id`: the token as it now stands. Revoking one already revoked answers it
/// as it was.
public struct RevokedAccessToken: Codable, Equatable, Sendable {
    public let id: String
    public let revokedAt: String?
    public let revokedReason: String?
}
