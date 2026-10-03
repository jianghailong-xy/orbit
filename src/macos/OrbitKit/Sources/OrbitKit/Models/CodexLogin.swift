import Foundation

/// One of the ChatGPT accounts a Codex pool of one's own runs on (migration 0323): the owner's own
/// subscription, signed in by the Orbit server with the official codex CLI's device flow and kept
/// there encrypted — never on a runner, never in a response. What a pool carries of it is this: its
/// email, its plan, `…AB12`, whether OpenAI still takes it, and its quota once something has read it.
/// Mirrors web's `CodexLogin` (lib/codexLogin.ts) field for field.
///
/// A pool of this kind is drawn the way every pool is: each of its accounts is one of the pool's members
/// (`CodexLoginPool.drawn`), attached as `PoolMember.login` the way a shared pool's key is attached as
/// `PoolMember.key` — so the Providers list, the picker and the composer take it as they take any pool.
public struct CodexLogin: Codable, Equatable, Sendable {
    /// ACTIVE, or SIGNED_OUT once OpenAI refused it — which only its owner's sign-in again undoes.
    public let state: String
    public let email: String?
    /// The plan the account's sign-in names (`plus`, `pro`, …), when it names one.
    public let plan: String?
    /// `…AB12`: all any response says of the account's id — and what signing that one account out names.
    public let fingerprint: String
    public let lastError: String?
    public let expiresAt: String?
    public let linkedAt: String?
    /// Its quota, once something has read it; nil until then — which is not a refusal, and it runs.
    public let usage: PlanUsageSnapshot?
    public let usageUnavailable: String?
    /// The account the reader's next session would run on, on a pool read as one of its people
    /// (`SharedPool.logins`, which the server marks); absent from the owner's own reads, where Next is
    /// worked out from the order and each account's state.
    public let next: Bool
    /// Who signed it in — a person of the pool (migration 0371). They alone may sign it in again, and with
    /// the pool's admins they may take it out; an older server sends none, which no page reads as anybody.
    public let userId: String?

    public init(state: String = "ACTIVE", email: String?, plan: String? = nil, fingerprint: String,
                lastError: String? = nil, expiresAt: String? = nil, linkedAt: String? = nil,
                usage: PlanUsageSnapshot? = nil, usageUnavailable: String? = nil, next: Bool = false,
                userId: String? = nil) {
        self.state = state
        self.email = email
        self.plan = plan
        self.fingerprint = fingerprint
        self.lastError = lastError
        self.expiresAt = expiresAt
        self.linkedAt = linkedAt
        self.usage = usage
        self.usageUnavailable = usageUnavailable
        self.next = next
        self.userId = userId
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = try c.decodeIfPresent(String.self, forKey: .state) ?? "ACTIVE"
        email = try c.decodeIfPresent(String.self, forKey: .email)
        plan = try c.decodeIfPresent(String.self, forKey: .plan)
        fingerprint = try c.decodeIfPresent(String.self, forKey: .fingerprint) ?? ""
        lastError = try c.decodeIfPresent(String.self, forKey: .lastError)
        expiresAt = try c.decodeIfPresent(String.self, forKey: .expiresAt)
        linkedAt = try c.decodeIfPresent(String.self, forKey: .linkedAt)
        // A quota in a shape this build cannot read is no reason to lose the account.
        usage = (try? c.decodeIfPresent(PlanUsageSnapshot.self, forKey: .usage)) ?? nil
        usageUnavailable = try c.decodeIfPresent(String.self, forKey: .usageUnavailable)
        // Absent from an owner's own read, and from an older server: no mark.
        next = (try? c.decodeIfPresent(Bool.self, forKey: .next)) ?? false
        userId = try c.decodeIfPresent(String.self, forKey: .userId)
    }

    /// Whether OpenAI still takes it.
    public var active: Bool { state == "ACTIVE" }
}

/// What starting a sign-in answers (POST /api/providers/pools/:id/codex-login): the page to open and
/// the one-time code to enter there, and when the code stops working.
public struct CodexLoginAttempt: Codable, Equatable, Sendable {
    public let status: String
    public let verificationUrl: String
    public let userCode: String
    public let expiresAt: String

    public init(status: String = "PENDING", verificationUrl: String, userCode: String, expiresAt: String) {
        self.status = status
        self.verificationUrl = verificationUrl
        self.userCode = userCode
        self.expiresAt = expiresAt
    }
}

/// Where a sign-in stands (GET /api/providers/pools/:id/codex-login), and the accounts the pool holds —
/// before and after. `status` is PENDING, CONFIRMED, EXPIRED, CANCELLED, FAILED or NONE (nothing in
/// flight on this server); a status this build does not know is read as still waiting by nobody —
/// `CodexSignIn.step(after:)` ends on it.
public struct CodexLoginPoll: Codable, Equatable, Sendable {
    public let status: String
    public let verificationUrl: String?
    public let userCode: String?
    public let expiresAt: String?
    /// The pool's first account — or, once CONFIRMED, the account this sign-in stored.
    public let account: CodexLogin?
    /// Every account the pool holds, oldest first, once this poll stored the one it was waiting on.
    /// Absent from an older server, which names only `account`.
    public let logins: [CodexLogin]?
    /// Why it failed, in the server's words.
    public let error: String?

    public init(status: String, verificationUrl: String? = nil, userCode: String? = nil,
                expiresAt: String? = nil, account: CodexLogin? = nil, logins: [CodexLogin]? = nil,
                error: String? = nil) {
        self.status = status
        self.verificationUrl = verificationUrl
        self.userCode = userCode
        self.expiresAt = expiresAt
        self.account = account
        self.logins = logins
        self.error = error
    }
}

/// What signing an account out answers: how many accounts went (0 or 1).
public struct CodexLoginSignOut: Codable, Equatable, Sendable {
    public let removed: Int?
}
