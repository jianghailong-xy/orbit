import Foundation

/// One currency of a DeepSeek account's balance (GET /api/providers/mine/:id/balance), the amounts
/// as the decimal strings DeepSeek wrote them. Mirrors shared `ProviderBalanceAmount`.
public struct ProviderBalanceAmount: Codable, Equatable, Sendable {
    public let currency: String
    public let totalBalance: String
    public let grantedBalance: String
    public let toppedUpBalance: String

    public init(currency: String, totalBalance: String, grantedBalance: String, toppedUpBalance: String) {
        self.currency = currency
        self.totalBalance = totalBalance
        self.grantedBalance = grantedBalance
        self.toppedUpBalance = toppedUpBalance
    }
}

/// Another of the account's DeepSeek providers holding the very same key — the same account, so
/// the same balance.
public struct ProviderBalanceSibling: Codable, Equatable, Sendable {
    public let id: String
    public let label: String

    public init(id: String, label: String) {
        self.id = id
        self.label = label
    }
}

/// The server's answer about the whole DeepSeek account behind a DeepSeek key: DeepSeek's balance
/// (`ok`), or why there is none — `reason` KEY_REJECTED, NETWORK or UPSTREAM_ERROR, and `message` —
/// with no amount at all. Mirrors shared `ProviderBalance`; `DeepSeekBalance.state` reads it.
public struct ProviderBalance: Codable, Equatable, Sendable {
    public let ok: Bool
    public let balances: [ProviderBalanceAmount]?
    public let isAvailable: Bool?
    public let reason: String?
    public let message: String?
    /// When the server asked DeepSeek; providers holding one key share it.
    public let fetchedAt: String
    public let sharedWith: [ProviderBalanceSibling]?

    public init(ok: Bool, balances: [ProviderBalanceAmount]? = nil, isAvailable: Bool? = nil, reason: String? = nil,
                message: String? = nil, fetchedAt: String, sharedWith: [ProviderBalanceSibling]? = nil) {
        self.ok = ok
        self.balances = balances
        self.isAvailable = isAvailable
        self.reason = reason
        self.message = message
        self.fetchedAt = fetchedAt
        self.sharedWith = sharedWith
    }
}

/// What asking for a balance came to: the server's answer, or — when the request never got one —
/// why, in words. Either way there is no number until DeepSeek gave one.
public enum ProviderBalanceReading: Equatable, Sendable {
    case answered(ProviderBalance)
    case unreachable(String)
}
