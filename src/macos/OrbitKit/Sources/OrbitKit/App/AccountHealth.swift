import Foundation

/// One blocked account as `GET /account-health` serves it (docs/account-health-owner-surface-contract.md §2;
/// docs/routing-account-health-design.md §8). `kind` is a classified refusal the provider stated, or
/// `UNCLASSIFIED_ADMISSION`, Orbit's own guess after runs failed to start.
public struct AccountHealthBlock: Codable, Equatable, Sendable, Identifiable {
    /// What `POST /account-health/:id/check` takes.
    public let id: String
    public let subjectKey: String
    public let runnerId: String?
    public let engine: String?
    public let account: String?
    public let providerId: String?
    public let poolId: String?
    /// `""` for the whole account; a model id for a one-model block.
    public let scopeModel: String
    public let kind: String
    public let said: String?
    public let trips: Int
    public let since: String
    public let nextTrialAt: String?
    public let trialRunning: Bool
    public let line: String

    public init(id: String, subjectKey: String = "", runnerId: String? = nil, engine: String? = nil,
                account: String? = nil, providerId: String? = nil, poolId: String? = nil, scopeModel: String = "",
                kind: String, said: String? = nil, trips: Int = 1, since: String, nextTrialAt: String? = nil,
                trialRunning: Bool = false, line: String = "") {
        self.id = id; self.subjectKey = subjectKey; self.runnerId = runnerId; self.engine = engine
        self.account = account; self.providerId = providerId; self.poolId = poolId; self.scopeModel = scopeModel
        self.kind = kind; self.said = said; self.trips = trips; self.since = since
        self.nextTrialAt = nextTrialAt; self.trialRunning = trialRunning; self.line = line
    }

    /// Lenient on what only shapes the sentence: a row missing one of them still draws.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        subjectKey = try c.decodeIfPresent(String.self, forKey: .subjectKey) ?? ""
        runnerId = try c.decodeIfPresent(String.self, forKey: .runnerId)
        engine = try c.decodeIfPresent(String.self, forKey: .engine)
        account = try c.decodeIfPresent(String.self, forKey: .account)
        providerId = try c.decodeIfPresent(String.self, forKey: .providerId)
        poolId = try c.decodeIfPresent(String.self, forKey: .poolId)
        scopeModel = try c.decodeIfPresent(String.self, forKey: .scopeModel) ?? ""
        kind = try c.decode(String.self, forKey: .kind)
        said = try c.decodeIfPresent(String.self, forKey: .said)
        trips = try c.decodeIfPresent(Int.self, forKey: .trips) ?? 1
        since = try c.decode(String.self, forKey: .since)
        nextTrialAt = try c.decodeIfPresent(String.self, forKey: .nextTrialAt)
        trialRunning = try c.decodeIfPresent(Bool.self, forKey: .trialRunning) ?? false
        line = try c.decodeIfPresent(String.self, forKey: .line) ?? ""
    }
}

public struct AccountHealthAnswer: Codable, Equatable, Sendable {
    public let blocks: [AccountHealthBlock]?
    public init(blocks: [AccountHealthBlock]?) { self.blocks = blocks }
}

public enum AccountHealth {
    public static let unclassifiedKind = "UNCLASSIFIED_ADMISSION"
    public static let checkAgainTitle = "Check again"
    /// The push kind of §8 item 1: a tap opens the machine's page.
    public static let pushKind = "account-needs-action"

    /// The whole-account block of a runner's sign-in, if there is one (`account` is `default` for the machine's one login).
    public static func block(_ blocks: [AccountHealthBlock], runnerID: String, engine: String,
                             account: String) -> AccountHealthBlock? {
        blocks.first {
            $0.runnerId.map(PublicID.storageKey) == PublicID.storageKey(runnerID)
                && $0.engine == engine && $0.account == account && $0.scopeModel.isEmpty
        }
    }

    /// The whole-account block of a key, or of a Claude pool member (which is a key): `provider:<id>`.
    public static func block(_ blocks: [AccountHealthBlock], providerID: String) -> AccountHealthBlock? {
        blocks.first {
            $0.providerId.map(PublicID.storageKey) == PublicID.storageKey(providerID) && $0.scopeModel.isEmpty
        }
    }

    /// The whole-account block of a Codex pool login: `pool-login:<pool>:<account>`, where the account is the
    /// login's fingerprint (a member's `login:` prefix is not part of it).
    public static func block(_ blocks: [AccountHealthBlock], poolID: String, account: String) -> AccountHealthBlock? {
        let account = account.hasPrefix("login:") ? String(account.dropFirst("login:".count)) : account
        return blocks.first {
            $0.poolId.map(PublicID.storageKey) == PublicID.storageKey(poolID) && $0.account == account
                && $0.scopeModel.isEmpty
        }
    }

    public static func isClassified(_ block: AccountHealthBlock) -> Bool { block.kind != unclassifiedKind }

    private static let product = ["claude": "Claude Code", "codex": "Codex", "kimi": "Kimi Code",
                                  "antigravity": "Antigravity", "cursor": "Cursor"]

    /// `Needs action · Cursor said "Add a payment method to continue" · since Nov 22, 17:19 · tried again at 21:19`;
    /// the breaker's guess reads `Not used for now · failed to start 2 runs · since … · tried again at …`.
    public static func line(_ block: AccountHealthBlock, now: Date = Date(), calendar: Calendar = .current,
                            timeZone: TimeZone = .current) -> String {
        let name = block.engine.flatMap { product[$0] } ?? "The provider"
        let lead: String
        if !block.line.isEmpty {
            lead = block.line
        } else if isClassified(block) {
            lead = block.said.map { "Needs action · \(name) said \"\($0)\"" } ?? "Needs action · \(name) refused this account"
        } else {
            lead = "Not used for now · failed to start \(block.trips + 1) runs"
        }
        var parts = [lead]
        if let since = RelativeTime.parse(block.since) { parts.append("since \(stamp(since, now: nil, timeZone: timeZone))") }
        if block.trialRunning {
            parts.append("trying it now")
        } else if let next = block.nextTrialAt.flatMap(RelativeTime.parse) {
            parts.append("tried again at \(stamp(next, now: now, timeZone: timeZone))")
        }
        return parts.joined(separator: " · ")
    }

    /// `HH:mm` for today, `Nov 22, 17:19` otherwise; with no `now` always the date form.
    static func stamp(_ date: Date, now: Date?, timeZone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let time = DateFormatter()
        time.locale = Locale(identifier: "en_US_POSIX"); time.timeZone = timeZone; time.dateFormat = "HH:mm"
        if let now, calendar.isDate(date, inSameDayAs: now) { return time.string(from: date) }
        let day = DateFormatter()
        day.locale = Locale(identifier: "en_US_POSIX"); day.timeZone = timeZone; day.dateFormat = "MMM d, HH:mm"
        return day.string(from: date)
    }
}
