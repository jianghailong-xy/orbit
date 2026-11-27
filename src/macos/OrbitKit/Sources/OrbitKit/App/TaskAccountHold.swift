import Foundation

/// A task whose next automatic start stands down because no account that could run it can run now
/// (docs/account-health-owner-surface-contract.md §3; web `TaskAccountHold.tsx`). Served on the task read,
/// on `GET /tasks` items and on a project's task rows; nil unless a hold stands.
public struct TaskAccountHold: Codable, Equatable, Sendable {
    public struct Account: Codable, Equatable, Sendable {
        public let provider: String
        public let engine: String?
        /// The provider's words, e.g. `Cursor said "Add a payment method to continue"`.
        public let line: String
        public let until: String?

        public init(provider: String, engine: String? = nil, line: String, until: String? = nil) {
            self.provider = provider; self.engine = engine; self.line = line; self.until = until
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            provider = try c.decodeIfPresent(String.self, forKey: .provider) ?? ""
            engine = try c.decodeIfPresent(String.self, forKey: .engine)
            line = try c.decodeIfPresent(String.self, forKey: .line) ?? ""
            until = try c.decodeIfPresent(String.self, forKey: .until)
        }
    }

    /// `ACCOUNT_NEEDS_ACTION`.
    public let kind: String
    /// The sentence to show: the provider's words and the next try.
    public let reason: String
    /// When the first account is tried again (ISO).
    public let until: String?
    public let accounts: [Account]
    /// A pinned task held with relaxation off: `orbit-settings:relaxBlockedPins`.
    public let setting: String?

    public init(kind: String = "ACCOUNT_NEEDS_ACTION", reason: String, until: String? = nil,
                accounts: [Account] = [], setting: String? = nil) {
        self.kind = kind; self.reason = reason; self.until = until; self.accounts = accounts; self.setting = setting
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "ACCOUNT_NEEDS_ACTION"
        reason = try c.decodeIfPresent(String.self, forKey: .reason) ?? ""
        until = try c.decodeIfPresent(String.self, forKey: .until)
        accounts = (try? c.decodeIfPresent([Account].self, forKey: .accounts)) ?? []
        setting = try c.decodeIfPresent(String.self, forKey: .setting)
    }
}

/// The sign-in hold on a task (an engine signed out), read only for whether it stands: it wins over the account hold.
public struct TaskSignInHoldMark: Codable, Equatable, Sendable {
    public init() {}
}

public enum TaskAccountHoldCopy {
    public static let held = "Held"
    public static let openAccount = "Open account"
    public static let runElsewhere = "Run elsewhere"
    /// Where "Run pinned tasks elsewhere" is: Model routing (`SETTING_ROWS.relaxBlockedPins`).
    public static let relaxSettingKey = "relaxBlockedPins"

    /// Model routing on the web, at "Run pinned tasks elsewhere": the apps have no page of their own for it.
    public static func relaxPinsURL(base: URL) -> URL {
        var parts = URLComponents(url: base.appendingPathComponent("settings/providers/routing"),
                                  resolvingAgainstBaseURL: false)
        parts?.fragment = relaxSettingKey
        return parts?.url ?? base
    }

    /// The hold's text for a row: `Held · Cursor said "…" · Next try 13:19`; with no accounts, `Held · <reason>`.
    public static func line(_ hold: TaskAccountHold, now: Date = Date(), timeZone: TimeZone = .current) -> String {
        guard let first = hold.accounts.first else { return "\(held) · \(hold.reason)" }
        var text = "\(held) · \(first.line)"
        if let until = hold.until.flatMap(RelativeTime.parse) {
            text += " · Next try \(AccountHealth.stamp(until, now: now, timeZone: timeZone))"
        }
        return text
    }

    /// The whole sentence, the line's accessible name: `… · Open account`.
    public static func accessibilityLine(_ hold: TaskAccountHold, now: Date = Date(), timeZone: TimeZone = .current) -> String {
        "\(line(hold, now: now, timeZone: timeZone)) · \(openAccount)"
    }

    /// A row draws the line only while nothing else says why it isn't running: not while it runs or is queued,
    /// and not when the sign-in hold stands (that one wins).
    public static func showsOnRow(_ hold: TaskAccountHold?, signInHold: TaskSignInHoldMark?, running: Bool,
                                  queued: Bool) -> Bool {
        hold != nil && signInHold == nil && !running && !queued
    }
}
