import Foundation

/// "Add a key" on iOS — a sheet over a shared pool's page, in the web dialog's steps and words: what
/// putting a key in means (with the warning that stays: a key can't be resold, and whoever adds it
/// answers for it), then its name, the key and the monthly limit, then what the pool shows of it — its
/// fingerprint, never the key. `SharedPoolCopyParityTests` holds the words to the web source.
public enum AddPoolKey {
    public enum Step: Equatable, Sendable {
        /// What putting a key in means.
        case consent
        /// Name, key, limit.
        case form
        /// It went in: its name and its fingerprint.
        case done(label: String, fingerprint: String)
        /// The same key is in the pool already, put in by `contributor` (nil when that can't be told).
        case duplicate(contributor: String?)
    }

    public static let title = "Add a key"
    public static let continueLabel = "Continue"
    public static let cancel = "Cancel"
    public static let submit = "Add key"
    public static let done = "Done"
    public static let close = "Close"
    public static let addAnother = "Add another key"
    public static let consentNext = "Next: name it, paste it, and set what the others may spend on it."
    public static let formLead = "Name it, paste it, and set what the others may spend on it."
    public static let name = "Name"
    public static let key = "Key"
    public static let limit = "Limit"
    public static let limitPrefix = "$"
    public static let limitSuffix = "a month"
    public static let keyPlaceholder = "sk-…"

    /// The lead, as two runs — the pool's name is set in bold.
    public static let leadPrefix = "Paste an OpenAI API key to put in "

    /// One of the three things putting a key in means: a bold claim, then what follows from it.
    public struct Fact: Equatable, Sendable {
        public let lead: String
        public let rest: String
    }

    public static func facts(_ pool: SharedPool) -> [Fact] {
        let n = pool.people.count
        return [
            Fact(lead: "Everyone in \(pool.label) can run sessions on it",
                 rest: " — \(n) \(n == 1 ? "person" : "people"). Their sessions spend this key’s budget."),
            Fact(lead: "The key stays on the Orbit server.",
                 rest: " It never goes to a runner — runners get a session token, not the key — and nobody in the pool sees it or its full value."),
            Fact(lead: "Take it out, or replace it, any time.",
                 rest: " Its usage shows on the pool’s page for everyone in it."),
        ]
    }

    /// The warning that stays: a key isn't to be passed on, and its contributor answers for it.
    public static let risk = Fact(
        lead: "Keys can’t be resold.",
        rest: " Everything run with this key is billed to its account, and the person who adds it is responsible for it.")

    /// The Key field's note, around the fingerprint the pool will show for what is typed.
    public static let keyHintPrefix = "Checked once, then only its fingerprint ("
    public static let keyHintSuffix = ") is shown — the key itself stays on the Orbit server."

    public static func limitHint(_ pool: SharedPool) -> String {
        "Others in \(pool.label) can spend up to this on the key each month. Your own sessions aren’t limited by it."
    }

    /// "wikova-org-1" is in Team Codex.
    public static func doneTitle(label: String, pool: SharedPool) -> String { "\(label) is in \(pool.label)" }
    public static let doneDetail = " · ready for the next session. Only you and the pool’s admins can replace it."
    /// The key's row as the pool now lists it.
    public static func doneRow(me: String, fingerprint: String) -> String {
        "\(me) · \(fingerprint) · only its fingerprint is ever shown"
    }

    public static func duplicateTitle(_ pool: SharedPool) -> String { "This key is already in \(pool.label)" }
    public static func duplicateDetail(contributor: String?) -> String {
        let rest = "The same key twice doesn’t add budget — add a different one."
        guard let contributor, !contributor.isEmpty else { return rest }
        return "\(contributor) added it. \(rest)"
    }

    // MARK: replacing a key OpenAI refused

    public static let replaceTitle = "Replace key"
    public static func replaceLead(_ key: SharedPoolKey) -> String {
        "Paste a working key to put \(key.label) back in the pool."
    }

    // MARK: working it out

    /// What the pool will show of what is typed: `sk-…` and its last four characters — the server's own
    /// `maskedKey`. Plain `sk-…` until there is enough of a key to take four from.
    public static func fingerprint(of typed: String) -> String {
        let key = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard key.count >= 8 else { return "sk-…" }
        return "sk-…" + key.suffix(4)
    }

    /// A name for the caller's next key that no key in the pool has: `wikova-org-1`, then `-2`, ….
    public static func suggestedName(for pool: SharedPool) -> String {
        let me = pool.people.first(where: \.you)?.name ?? ""
        let first = me.split(separator: " ").first.map { String($0).lowercased() } ?? ""
        let stem = first.isEmpty ? "key" : "\(first)-org"
        let taken = Set(pool.keys.map(\.label))
        var n = 1
        while taken.contains("\(stem)-\(n)") { n += 1 }
        return "\(stem)-\(n)"
    }

    /// The limit as the server takes it: whole dollars, or nil for none. Nil too for what isn't a
    /// whole number of dollars, which the form refuses before it asks.
    public static func shareCap(_ typed: String) -> Int? {
        Int(typed.trimmingCharacters(in: .whitespaces))
    }

    /// Whether the form can be sent: a name, a key, and a limit that is empty or whole dollars.
    public static func canSubmit(name: String, key: String, limit: String) -> Bool {
        let trimmedLimit = limit.trimmingCharacters(in: .whitespaces)
        return !name.trimmingCharacters(in: .whitespaces).isEmpty
            && !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && (trimmedLimit.isEmpty || (shareCap(trimmedLimit).map { $0 >= 0 } ?? false))
    }

    /// How sending a key went.
    public enum Outcome: Equatable, Sendable {
        /// It went in: the pool as it now stands.
        case added(SharedPool)
        /// It is in the pool already, put in by this person (nil when that can't be told).
        case duplicate(contributor: String?)
        /// Refused for another reason, in the server's words — a key of the wrong shape, say.
        case refused(String)
    }

    /// A failed send, read: the server's duplicate refusal names who put the key in; anything else
    /// is its reason, as one sentence.
    public static func outcome(of error: Error, typed: String, pool: SharedPool) -> Outcome {
        guard APIClient.refusalCode(error) == duplicateCode else {
            return .refused(APIClient.failureReason(error))
        }
        var message: String?
        if case APIError.http(_, let body) = error { message = ComposerLogic.serverMessage(body) }
        return .duplicate(contributor: duplicateContributor(typed: typed, pool: pool, message: message))
    }

    /// The key the server just put in for the caller: the newest of theirs by that name.
    public static func added(_ label: String, in pool: SharedPool) -> SharedPoolKey? {
        pool.keys.last { $0.contributor.you && $0.label == label }
    }

    /// The server's code for a key that is in the pool already.
    public static let duplicateCode = "POOL_KEY_DUPLICATE"

    /// Who put in the key the server refused as a duplicate. The pool shows each key's last four
    /// characters, so the key of the typed one's four is the one — the server's refusal names them too
    /// ("… — Wikova put it in"), which is the fallback when the pool has since moved.
    public static func duplicateContributor(typed: String, pool: SharedPool, message: String?) -> String? {
        let fingerprint = fingerprint(of: typed)
        if fingerprint != "sk-…", let key = pool.keys.first(where: { $0.fingerprint == fingerprint }) {
            return key.contributor.name
        }
        guard let message, let dash = message.range(of: " — ", options: .backwards),
              message.hasSuffix(" put it in") else { return nil }
        let name = message[dash.upperBound...].dropLast(" put it in".count)
        return name.isEmpty ? nil : String(name)
    }
}
