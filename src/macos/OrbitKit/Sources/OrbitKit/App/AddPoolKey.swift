import Foundation

/// "Add a key" on iOS — a sheet over a shared pool's page, in the web dialog's steps and words: what
/// putting a key in means (with the warning that stays: a key can't be resold, and whoever adds it
/// answers for it), then its name, the key and the monthly limit, then what the pool shows of it — its
/// fingerprint, never the key. The same sheet replaces a key OpenAI refused (web's "Replace key").
/// `SharedPoolCopyParityTests` holds the words to the web source.
public enum AddPoolKey {
    public enum Step: Equatable, Sendable {
        /// What putting a key in means.
        case consent
        /// Name, key, limit — or, replacing a refused key, the key alone.
        case form
        /// It went in: its name and its fingerprint.
        case done(label: String, fingerprint: String)
        /// The same key is in the pool already.
        case duplicate(AddedBy)
    }

    /// Who put in the key a second add was refused over, as the server's refusal names them.
    public struct AddedBy: Equatable, Sendable {
        public let name: String?
        /// The caller did.
        public let you: Bool

        public init(name: String?, you: Bool = false) {
            self.name = name
            self.you = you
        }
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
    public static let noLimit = "No limit"
    public static let keyPlaceholder = "sk-…"

    /// The lead, as two runs — the pool's name is set in bold. The web dialog carries the name in its
    /// title ("Add a key to Team Codex") and says "this pool" here; a sheet's bar has room for less.
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

    /// "wikova-org-1 is in Team Codex".
    public static func doneTitle(label: String, pool: SharedPool) -> String { "\(label) is in \(pool.label)" }
    public static let doneDetail = " · ready for the next session. Only you and the pool’s admins can replace it."
    /// The key's row as the pool now lists it.
    public static func doneRow(me: String, fingerprint: String) -> String {
        "\(me) · \(fingerprint) · only its fingerprint is ever shown"
    }

    public static func duplicateTitle(_ pool: SharedPool) -> String { "This key is already in \(pool.label)" }
    public static func duplicateDetail(_ by: AddedBy) -> String {
        "\(by.you ? "You" : by.name ?? "Someone") added it. The same key twice doesn’t add budget — add a different one."
    }

    // MARK: replacing a key OpenAI refused

    public static func replaceTitle(_ key: SharedPoolKey) -> String { "Replace \(key.label)" }
    public static func replaceLead(_ key: SharedPoolKey) -> String {
        "OpenAI rejected \(key.fingerprint). Paste a working key to put \(key.label) back in the pool."
    }
    public static func replaced(_ key: SharedPoolKey, in pool: SharedPool) -> String {
        "\(key.label) is back in \(pool.label)"
    }
    /// A replacement that is some other key of the pool's already.
    public static func replaceDuplicate(_ by: AddedBy, pool: SharedPool) -> String {
        "This key is already in \(pool.label) — \(by.you ? "you" : by.name ?? "Someone") added it."
    }

    // MARK: working it out

    /// What the pool will show of what is typed (web's `maskTyped`): `sk-…` and its last four characters.
    public static func fingerprint(of typed: String) -> String {
        "sk-…" + typed.trimmingCharacters(in: .whitespacesAndNewlines).suffix(4)
    }

    /// The limit field keeps digits only: whole dollars.
    public static func limitDigits(_ typed: String) -> String { typed.filter(\.isASCIIDigit) }

    /// The limit as the server takes it: whole dollars, or nil for none.
    public static func shareCap(_ typed: String) -> Int? { Int(typed) }

    /// Whether the form can be sent: a name and a key.
    public static func canSubmit(name: String, key: String) -> Bool {
        !name.trimmingCharacters(in: .whitespaces).isEmpty
            && !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// How sending a key went.
    public enum Outcome: Equatable, Sendable {
        /// It went in: the pool as it now stands.
        case added(SharedPool)
        /// It is in the pool already.
        case duplicate(AddedBy)
        /// Refused for another reason, in the server's words — a key of the wrong shape, say.
        case refused(String)
    }

    /// The server's code for a key that is in the pool already.
    public static let duplicateCode = "POOL_KEY_DUPLICATE"

    /// A failed send, read: the duplicate refusal carries who put the key in (`addedBy`); anything else
    /// is its reason, as one sentence.
    public static func outcome(of error: Error) -> Outcome {
        guard APIClient.refusalCode(error) == duplicateCode else {
            return .refused(APIClient.failureReason(error))
        }
        var by = AddedBy(name: nil)
        if case APIError.http(_, let body) = error, let data = body?.data(using: .utf8),
           let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
           let addedBy = object["addedBy"] as? [String: Any] {
            by = AddedBy(name: addedBy["name"] as? String, you: addedBy["you"] as? Bool ?? false)
        }
        return .duplicate(by)
    }

    /// The key a send just put in: the one in `after` that wasn't in `before`.
    public static func added(before: SharedPool, after: SharedPool) -> SharedPoolKey? {
        let old = Set(before.keys.map { PublicID.storageKey($0.id) })
        return after.keys.first { !old.contains(PublicID.storageKey($0.id)) }
    }
}

private extension Character {
    var isASCIIDigit: Bool { ("0"..."9").contains(self) }
}
