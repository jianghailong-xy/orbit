import Foundation

/// "Sign in with ChatGPT" on iOS — a sheet over a Codex pool of one's own, in the web dialog's steps and
/// words (components/CodexSignIn.tsx): what signing in means (the account runs the sessions of everyone
/// in the pool, its sign-in stays on the Orbit server, and only the owner's own accounts may go in), then
/// the page to open and the one-time code to enter there while the sheet polls the server until the
/// person approved it, then the account by its email and `…AB12` — never a token — and how many accounts
/// the pool holds now. One account goes in per sign-in, as many as its owner signs in; the same sheet
/// puts an account OpenAI signed out back in. `CodexSignInCopyParityTests` holds every word to the web
/// source.
public enum CodexSignIn {
    public enum Step: Equatable, Sendable {
        /// What signing in means, before anything starts on the server.
        case consent
        /// The page to open, the code to enter there, and when the code stops working.
        case code(url: String, code: String, expiresAt: String)
        /// It went in: the account, and every account the pool holds now.
        case done(CodexLogin?, logins: [CodexLogin])
        /// Nobody approved the code in time.
        case expired
        /// It stopped without an account, and why — in the server's words.
        case failed(String)
        /// The account signed in is already one of the pool's — by its email, when the server names it.
        case duplicate(email: String?)
    }

    /// How often the sheet asks whether the code has been approved (web's `POLL_MS`).
    public static let pollInterval: Duration = .seconds(2)

    public static let title = "Sign in with ChatGPT"
    /// The notice's press: what it gets is the one-time code to enter on OpenAI's page, which is what
    /// comes next — the sign-in itself finishes there.
    public static let start = "Get a code"
    public static let cancel = "Cancel"
    public static let close = "Close"
    public static let done = "Done"
    public static let tryAgain = "Try again"
    public static let newCode = "Get a new code"

    // MARK: what signing in means

    /// The lead, as runs around the pool's name, which is set in bold: signing in its first account…
    public static let leadPrefix = "Sign in with your own ChatGPT account to run "
    public static let leadSuffix = " on it."

    /// …or again, as the account OpenAI signed out.
    public static func againLeadPrefix(_ login: CodexLogin?) -> String {
        "OpenAI signed \(login?.email ?? "this account") out. Sign in with it again to put it back in "
    }
    public static let againLeadSuffix = "."

    /// One of the three things signing in means: a bold claim, then what follows from it.
    public struct Fact: Equatable, Sendable {
        public let lead: String
        public let rest: String
    }

    /// `mine` is the reader: the pool's owner, or one of the people it is shared with, who signs an
    /// account of their own in (migration 0371) — everyone here runs on it from the moment it is in.
    public static func facts(_ pool: ProviderPool, mine: Bool = true) -> [Fact] {
        [
            mine
                ? Fact(lead: "Yours, and whoever you add.",
                       rest: " A pool that is just yours runs your sessions alone; add people and their sessions start on this account too.")
                : Fact(lead: "Everyone in this pool runs on it.",
                       rest: " Add it, and everyone here — you included — runs their sessions on this account."),
            Fact(lead: "The sign-in stays on the Orbit server.",
                 rest: " It never goes to a runner — runners get a session token, not your login — and nobody sees its tokens."),
            Fact(lead: "Sign out any time.",
                 rest: " Its usage, and when it resets, show on this pool’s page."),
        ]
    }

    /// The warning that stays: the people in the pool run on the account, and OpenAI's terms treat that as
    /// sharing it — read by its owner, whose the adding is, or by one of the people there, whose account the
    /// whole pool runs on once it is in.
    public static func risk(mine: Bool = true) -> Fact {
        Fact(lead: mine ? "Adding people shares your account." : "Everyone here runs on your account.",
             rest: " Their sessions run on it — OpenAI’s terms treat account sharing as a violation, and an account used that way can be suspended.")
    }

    // MARK: …and adding one more

    /// Whether this sign-in adds one more account to a pool that already runs on one of the owner's own —
    /// not one OpenAI signed out going back in (`again`) — which has a notice of its own: what the pool
    /// runs on now, that everyone in the pool runs on this account too once it is shared, and what the
    /// pool does without it.
    public static func addsAnother(_ pool: ProviderPool, again: CodexLogin?) -> Bool {
        again == nil && !CodexLoginPool.logins(pool).isEmpty
    }

    /// Its lead, as runs around the pool's name, which is set in bold.
    public static let anotherLeadPrefix = "Sign in with another ChatGPT account of yours to add it to "
    public static func anotherLeadSuffix(_ pool: ProviderPool) -> String {
        let accounts = CodexLoginPool.logins(pool).count
        return ". It runs on \(accounts) account\(accounts == 1 ? "" : "s") now."
    }

    public static func anotherFacts(_ pool: ProviderPool, mine: Bool = true) -> [Fact] {
        [
            Fact(lead: "Everyone in the pool runs on it.",
                 rest: mine
                    ? " Once \(pool.label) is shared, the people you add run their sessions on this account too — and see it, with its usage, on the pool’s page."
                    : " Everyone here runs their sessions on this account too — you included — and sees it, with its usage, on the pool’s page."),
            Fact(lead: "The sign-in stays on the Orbit server.",
                 rest: " It never goes to a runner. Runners get a session token, not your login."),
            Fact(lead: "Sign out any time.",
                 rest: " \(pool.label) keeps running on its other accounts."),
        ]
    }

    /// Its warning: someone else's account signed in here is that account shared, and so is the owner's in
    /// a pool others run on.
    public static let anotherRisk = Fact(
        lead: "Only your own accounts.",
        rest: " Signing in with someone else’s ChatGPT account is sharing it, and so is putting yours in a pool others run on: OpenAI’s terms treat both as a violation, and an account used that way can be suspended.")

    // MARK: the code

    public static let openPage = "Open the sign-in page"
    public static let enterCode = "Sign in there, then enter this one-time code:"
    /// Signing in again: the account to sign in as, set in bold between the two runs.
    public static let enterCodeAsPrefix = "Sign in there as "
    public static let enterCodeAsSuffix = ", then enter this one-time code:"
    public static let copyCode = "Copy code"
    public static let copied = "Copied"
    public static let waiting = "Waiting for you to approve it…"

    /// "The code works until 19:50." — nil for a time this build cannot read.
    public static func expiry(_ iso: String, now: Date = Date(), timeZone: TimeZone = .current) -> String? {
        ProviderPools.formatResetTime(iso, now: now, timeZone: timeZone).map { "The code works until \($0)." }
    }

    // MARK: how it ended

    /// "wikova@orbitd.io is in My Codex".
    public static func doneTitle(_ account: CodexLogin?, pool: ProviderPool) -> String {
        "\(account.map(CodexLoginPool.name) ?? "Your ChatGPT account") is in \(pool.label)"
    }
    /// How many accounts the pool holds now, and what the one just in is for.
    public static func doneDetail(_ pool: ProviderPool, logins: [CodexLogin]) -> String {
        "\(pool.label) has \(logins.count) account\(logins.count == 1 ? "" : "s") now. "
            + "A session moves to this one when the account it’s on runs out."
    }
    /// The account's card under it.
    public static func doneRow(_ account: CodexLogin) -> String {
        "\(CodexLoginPool.line(account)) · its sign-in stays on the Orbit server"
    }

    public static let expiredTitle = "The code expired"
    public static let expiredDetail = "It wasn’t approved in time. Get a new code to try again."
    public static let failedTitle = "The sign-in didn’t finish"
    public static func duplicateTitle(_ pool: ProviderPool) -> String { "This ChatGPT account is already in \(pool.label)" }
    /// The account by its email when the server named it — an older one names only the pool, and the
    /// sentence then reads without the address.
    public static func duplicateDetail(_ email: String?) -> String {
        guard let email else {
            return "It’s one of its accounts, and signing it in twice adds no quota. Sign in with a different account."
        }
        return "\(email) is one of its accounts, and signing it in twice adds no quota. Sign in with a different account."
    }

    /// A reason in the server's words, as a sentence of its own (web's `sentence`).
    public static func sentence(_ reason: String) -> String {
        let text = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        let capital = (text.first.map { String($0).uppercased() } ?? "") + text.dropFirst()
        guard let last = capital.last, !".!?…".contains(last) else { return capital }
        return capital + "."
    }

    // MARK: reading the server

    /// The server's code for an account the pool already holds.
    public static let duplicateCode = "POOL_CODEX_ACCOUNT_DUPLICATE"

    /// The step a poll's answer moves the sheet to, or nil while it is still waiting on the person
    /// (web's `pollStep`).
    public static func step(after poll: CodexLoginPoll) -> Step? {
        switch poll.status {
        case "PENDING":
            return nil
        case "CONFIRMED":
            return .done(poll.account, logins: poll.logins ?? poll.account.map { [$0] } ?? [])
        case "EXPIRED":
            return .expired
        case "CANCELLED":
            return .failed("it was cancelled")
        case "FAILED":
            return .failed(poll.error ?? "the codex CLI stopped without a sign-in")
        default:
            // Nothing in flight here any more (the server restarted, or another device finished it): an
            // account that is in and running is the sign-in done; anything else has to start again.
            if let account = poll.account, account.active { return .done(account, logins: poll.logins ?? [account]) }
            return .failed("the Orbit server has no sign-in in progress for this pool")
        }
    }

    /// A failed poll, read: the same account signed in twice has a step of its own, a pool that is gone
    /// ends the sign-in, and anything else — a dropped request — is no answer at all (nil: ask again).
    public static func step(afterPollFailure error: Error) -> Step? {
        if APIClient.refusalCode(error) == duplicateCode {
            return .duplicate(email: APIClient.refusalString(error, "email"))
        }
        if case APIError.http(let status, _) = error, status == 404 {
            return .failed("this pool no longer exists")
        }
        return nil
    }

    /// A failed start, read: why, as the step that says so.
    public static func step(afterStartFailure error: Error) -> Step {
        .failed(APIClient.failureReason(error))
    }
}
