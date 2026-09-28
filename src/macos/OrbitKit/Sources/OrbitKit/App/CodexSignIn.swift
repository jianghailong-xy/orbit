import Foundation

/// "Sign in with ChatGPT" on iOS — a sheet over a Codex pool of one's own, in the web dialog's steps and
/// words (components/CodexSignIn.tsx): what signing in means (the account is theirs alone, its sign-in
/// stays on the Orbit server, and it is not to be shared), then the page to open and the one-time code
/// to enter there while the sheet polls the server until the person approved it, then the account by
/// its email and `…AB12` — never a token. The same sheet signs an account OpenAI signed out in again.
/// `CodexSignInCopyParityTests` holds every word to the web source.
public enum CodexSignIn {
    public enum Step: Equatable, Sendable {
        /// What signing in means, before anything starts on the server.
        case consent
        /// The page to open, the code to enter there, and when the code stops working.
        case code(url: String, code: String, expiresAt: String)
        /// It went in: the account, as the pool now holds it.
        case done(CodexLogin?)
        /// Nobody approved the code in time.
        case expired
        /// It stopped without an account, and why — in the server's words.
        case failed(String)
        /// The account signed in is the one the pool already runs on.
        case duplicate
        /// The pool runs on another account.
        case taken
    }

    /// How often the sheet asks whether the code has been approved (web's `POLL_MS`).
    public static let pollInterval: Duration = .seconds(2)

    public static let title = "Sign in with ChatGPT"
    public static let start = "Sign in with ChatGPT"
    public static let cancel = "Cancel"
    public static let close = "Close"
    public static let done = "Done"
    public static let tryAgain = "Try again"
    public static let newCode = "Get a new code"

    // MARK: what signing in means

    /// The lead, as runs around the pool's name, which is set in bold: signing in for the first time…
    public static let leadPrefix = "Sign in with your own ChatGPT account to run "
    public static let leadSuffix = " on it."

    /// …or again, as the account OpenAI signed out.
    public static func againLeadPrefix(_ login: CodexLogin?) -> String {
        "OpenAI signed \(login?.email ?? "this account") out. Sign in with it again to put it back in "
    }
    public static let againLeadSuffix = "."

    /// Whether this sign-in is the account's sign-in again: the pool holds one OpenAI signed out.
    public static func isAgain(_ pool: ProviderPool) -> Bool { pool.login.map { !$0.active } ?? false }

    /// One of the three things signing in means: a bold claim, then what follows from it.
    public struct Fact: Equatable, Sendable {
        public let lead: String
        public let rest: String
    }

    public static func facts(_ pool: ProviderPool) -> [Fact] {
        [
            Fact(lead: "Only you can use it.",
                 rest: " Sessions on \(pool.label) are yours alone — nobody else in Orbit sees this pool or its account."),
            Fact(lead: "The sign-in stays on the Orbit server.",
                 rest: " It never goes to a runner — runners get a session token, not your login — and nobody sees its tokens."),
            Fact(lead: "Sign out any time.",
                 rest: " Its usage, and when it resets, show on this pool’s page."),
        ]
    }

    /// The warning that stays: a ChatGPT account is one person's.
    public static let risk = Fact(
        lead: "Don’t share your account.",
        rest: " OpenAI’s terms don’t allow a ChatGPT account to be shared — an account used that way can be suspended.")

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
    public static let doneDetail = "It’s ready for the next session. Only you can sign it out or sign it in again."
    /// The account's card under it.
    public static func doneRow(_ account: CodexLogin) -> String {
        "\(CodexLoginPool.line(account)) · its sign-in stays on the Orbit server"
    }

    public static let expiredTitle = "The code expired"
    public static let expiredDetail = "It wasn’t approved in time. Get a new code to try again."
    public static let failedTitle = "The sign-in didn’t finish"
    public static func duplicateTitle(_ pool: ProviderPool) -> String { "This ChatGPT account is already in \(pool.label)" }
    public static let duplicateDetail = "It’s the account this pool runs on — signing it in twice adds nothing."
    public static func takenTitle(_ pool: ProviderPool) -> String { "\(pool.label) runs on another account" }
    public static func takenDetail(_ login: CodexLogin?) -> String {
        "Sign in as \(login?.email ?? "the account it runs on") instead — or sign it out first to switch accounts."
    }

    /// A reason in the server's words, as a sentence of its own (web's `sentence`).
    public static func sentence(_ reason: String) -> String {
        let text = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        let capital = (text.first.map { String($0).uppercased() } ?? "") + text.dropFirst()
        guard let last = capital.last, !".!?…".contains(last) else { return capital }
        return capital + "."
    }

    // MARK: reading the server

    /// The server's codes for an account the pool cannot take.
    public static let duplicateCode = "POOL_CODEX_ACCOUNT_DUPLICATE"
    public static let takenCode = "POOL_CODEX_ACCOUNT_TAKEN"

    /// The step a poll's answer moves the sheet to, or nil while it is still waiting on the person
    /// (web's `pollStep`).
    public static func step(after poll: CodexLoginPoll) -> Step? {
        switch poll.status {
        case "PENDING":
            return nil
        case "CONFIRMED":
            return .done(poll.account)
        case "EXPIRED":
            return .expired
        case "CANCELLED":
            return .failed("it was cancelled")
        case "FAILED":
            return .failed(poll.error ?? "the codex CLI stopped without a sign-in")
        default:
            // Nothing in flight here any more (the server restarted, or another device finished it): an
            // account that is in and running is the sign-in done; anything else has to start again.
            if let account = poll.account, account.active { return .done(account) }
            return .failed("the Orbit server has no sign-in in progress for this pool")
        }
    }

    /// A failed poll, read: the pool's two refusals have steps of their own, a pool that is gone ends
    /// the sign-in, and anything else — a dropped request — is no answer at all (nil: ask again).
    public static func step(afterPollFailure error: Error) -> Step? {
        switch APIClient.refusalCode(error) {
        case duplicateCode: return .duplicate
        case takenCode: return .taken
        default: break
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
