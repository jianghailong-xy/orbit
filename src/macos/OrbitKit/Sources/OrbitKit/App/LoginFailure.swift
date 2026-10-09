import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// What the sign-in page says when `auth/login` fails, by why it failed: the server turned the
/// credentials down, the server couldn't be reached, or the server broke. A single catch-all once
/// told a user with a stray space in their email to check the instance URL and their network.
public enum LoginFailure {
    public static let rejected = "Incorrect email or password."
    public static let unreachable = "Couldn't reach the server — check the instance URL and your network connection."
    public static let serverError = "The server ran into an error. Try again in a moment."
    public static let tokenNotStored = "Signed in, but this device couldn't save the session to the Keychain."
    public static let unexpected = "Sign-in failed — the server's answer wasn't an Orbit sign-in. Check the instance URL."

    /// A Google sign-in that failed for a reason with no sentence of its own: an unknown code.
    public static let googleFailed = "Couldn't sign in with Google. Continue with Google to try again, or sign in with your password."
    /// The person closed the sheet, or turned Google down on its page (GOOGLE_CANCELLED).
    public static let googleCancelled = "Google sign-in was cancelled. Continue with Google to try again, or sign in with your password."
    /// The sheet couldn't be shown.
    public static let googleUnavailable = "Couldn't open Google sign-in on this device. Try again, or sign in with your password."
    /// The answer that came back was to another sign-in: its ticket wasn't used.
    public static let googleStateMismatch = "That Google sign-in didn't match the one this app started, so it wasn't used. Continue with Google again."
    /// The per-address budget: the exchange's 429, which has no code, and /start's GOOGLE_RATE_LIMITED.
    public static let googleTooMany = "Too many Google sign-ins from your network. Wait a minute, then continue with Google again."

    /// The refusals the server names by `code` (docs/google-sign-in-design.md §4.1–4.3, §5.2, §5.5),
    /// each in words that say what to do next. Read before the status, so that none of them reads as
    /// a wrong password.
    public static let refusals: [String: String] = [
        "ACCOUNT_DISABLED": "This Orbit account is disabled. Ask an administrator to enable it again.",
        "GOOGLE_NOT_CONFIGURED": "Google sign-in is turned off on this server. Sign in with your email and password, or ask an administrator to turn it on.",
        "GOOGLE_RATE_LIMITED": googleTooMany,
        "GOOGLE_SIGN_IN_BUSY": "Too many Google sign-ins are in progress on this Orbit server. Wait a few minutes, then continue with Google again, or sign in with your password.",
        "GOOGLE_BAD_REQUEST": "Orbit couldn't start Google sign-in from this app. Continue with Google to try again; if it keeps failing, sign in with your password.",
        "GOOGLE_FLOW_EXPIRED": "That Google sign-in expired before it finished. Continue with Google to try again.",
        "GOOGLE_CANCELLED": googleCancelled,
        "GOOGLE_EXCHANGE_FAILED": "Orbit couldn't confirm your sign-in with Google. Try again in a moment; if it keeps failing, ask an administrator to check this server's Google sign-in settings.",
        "GOOGLE_EMAIL_UNVERIFIED": "Your Google account's email address isn't verified. Verify it with Google, then continue with Google again.",
        "GOOGLE_FLOW_MISMATCH": "This Google sign-in expired or was already used. Continue with Google to try again.",
        "SETUP_REQUIRED": "This Orbit server has no accounts yet. Create its first administrator in a browser at /setup, with an email and a password.",
        "GOOGLE_EMAIL_AMBIGUOUS": "More than one Orbit account uses this email address, differing only in capital letters. Ask an administrator to remove the duplicate, or sign in with your password.",
        "GOOGLE_ACCOUNT_MISMATCH": "The Orbit account with this email address is connected to a different Google account. Continue with that Google account, or sign in with your password.",
        "GOOGLE_EMAIL_NOT_AUTHORITATIVE": "Google can't confirm that this email address is still yours. Sign in with your password, then connect Google on your profile page in Orbit on the web.",
        "GOOGLE_ACCOUNT_NOT_FOUND": "No Orbit account uses this Google account yet. Ask an administrator to create one for your email address, then continue with Google again.",
    ]

    public static func message(for error: Error) -> String {
        if let refusal = refusal(error) { return refusal }
        if error is URLError { return unreachable }
        if error is TokenNotStoredError { return tokenNotStored }
        switch error as? APIError {
        case .unauthorized?:
            return rejected
        // 400 is the server refusing the form itself (e.g. an email it can't read as one).
        case .http(let status, _)? where [400, 401, 403, 422].contains(status):
            return rejected
        case .http(let status, _)? where (500..<600).contains(status):
            return serverError
        default:
            return unexpected
        }
    }

    /// What the page says when Continue with Google fails. Never that the password is wrong: none
    /// was asked for.
    public static func googleMessage(for error: Error) -> String {
        if let error = error as? GoogleSignInError {
            switch error {
            case .refused(let code): return refusals[code] ?? googleFailed
            case .cancelled: return googleCancelled
            case .unavailable: return googleUnavailable
            case .stateMismatch: return googleStateMismatch
            case .malformedCallback: return unexpected
            }
        }
        if let refusal = refusal(error) { return refusal }
        switch error as? APIError {
        case .http(429, _)?:
            return googleTooMany
        case .http(let status, _)? where status < 500:
            return googleFailed
        case .unauthorized?:
            return googleFailed
        default:
            return message(for: error)
        }
    }

    /// The email as it is sent: surrounding whitespace dropped, everything between left alone.
    public static func submittedEmail(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func refusal(_ error: Error) -> String? {
        APIClient.refusalCode(error).flatMap { refusals[$0] }
    }
}
