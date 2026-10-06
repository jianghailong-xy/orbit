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

    public static func message(for error: Error) -> String {
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

    /// The email as it is sent: surrounding whitespace dropped, everything between left alone.
    public static func submittedEmail(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
