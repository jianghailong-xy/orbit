import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Why a Google sign-in ended before the server was asked for a session.
public enum GoogleSignInError: Error, Equatable {
    /// The person closed the sign-in sheet: nothing to report.
    case cancelled
    /// The sheet couldn't be shown — no window to present it over, or the system wouldn't start it.
    case unavailable
    /// The server sent the app back with this code instead of a ticket (§4.1, §4.2).
    case refused(code: String)
    /// The answer carries a state this sign-in didn't send: whatever it holds isn't this sign-in's.
    case stateMismatch
    /// The answer isn't `orbit://auth/google` with a ticket or an error.
    case malformedCallback
}

/// One Google sign-in the app started (docs/google-sign-in-design.md §3.2): the PKCE verifier only
/// the app keeps and only the exchange is shown, and the state the server has to send back.
public struct GoogleSignInRequest: Equatable, Sendable {
    public let verifier: String
    public let state: String

    public init(verifier: String = GoogleSignIn.randomToken(), state: String = GoogleSignIn.randomToken()) {
        self.verifier = verifier
        self.state = state
    }

    /// The verifier's S256 challenge, which /start takes.
    public var challenge: String { GoogleSignIn.challenge(for: verifier) }
}

/// Signing in to Orbit with Google from the apps (§3.1, §8.2). The server runs the OAuth flow: the
/// app opens its /start in the system's web authentication sheet, which answers with
/// `orbit://auth/google?ticket=…&state=…`, and trades the ticket and its own verifier for the session
/// `POST /auth/login` answers with.
public enum GoogleSignIn {
    /// The scheme the server sends a native sign-in back on: the app's own, registered on both platforms.
    public static let callbackScheme = DeepLink.scheme

    /// `<instance>/api/auth/google/start?client=native&code_challenge=…&client_state=…` (§4.1).
    public static func startURL(baseURL: URL, request: GoogleSignInRequest) -> URL {
        var components = URLComponents(url: baseURL.appendingPathComponent("api/auth/google/start"),
                                       resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "client", value: "native"),
                                 URLQueryItem(name: "code_challenge", value: request.challenge),
                                 URLQueryItem(name: "client_state", value: request.state)]
        return components.url!
    }

    /// The ticket in the server's answer, `orbit://auth/google?ticket=T&state=S` (§4.2), once `S` is
    /// this sign-in's own state. `orbit://auth/google?error=CODE&state=S` throws its code.
    public static func ticket(from callback: URL, state: String) throws -> String {
        guard callback.scheme?.lowercased() == callbackScheme, callback.host?.lowercased() == "auth",
              callback.path == "/google",
              let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems
        else { throw GoogleSignInError.malformedCallback }
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
        guard value("state") == state else { throw GoogleSignInError.stateMismatch }
        if let code = value("error"), !code.isEmpty { throw GoogleSignInError.refused(code: code) }
        guard let ticket = value("ticket"), !ticket.isEmpty else { throw GoogleSignInError.malformedCallback }
        return ticket
    }

    /// One whole sign-in against `api`'s server. `authenticate` shows the start URL in a browser and
    /// answers with the `orbit://` URL the server sent it to (`GoogleWebAuthentication` in the apps).
    /// On success the session is in `api`'s token store, exactly as after `login`.
    public static func signIn(api: APIClient, request: GoogleSignInRequest = GoogleSignInRequest(),
                              authenticate: (URL) async throws -> URL) async throws -> LoginResponse {
        let callback = try await authenticate(startURL(baseURL: api.baseURL, request: request))
        let ticket = try ticket(from: callback, state: request.state)
        return try await api.exchangeGoogleTicket(ticket, codeVerifier: request.verifier)
    }

    /// 32 random bytes as 43 base64url characters: a PKCE verifier (RFC 7636 §4.1), or a state.
    public static func randomToken() -> String {
        var generator = SystemRandomNumberGenerator()
        return base64url((0..<32).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
    }

    /// base64url of the verifier's SHA-256, unpadded (RFC 7636 §4.2).
    public static func challenge(for verifier: String) -> String {
        let hex = Array(RunnerDownload.sha256Hex(Data(verifier.utf8)).utf8)
        return base64url(stride(from: 0, to: hex.count, by: 2).map {
            UInt8(String(decoding: hex[$0..<$0 + 2], as: UTF8.self), radix: 16)!
        })
    }

    private static func base64url(_ bytes: [UInt8]) -> String {
        Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

#if canImport(AuthenticationServices)
import AuthenticationServices

/// The system's web authentication sheet (`ASWebAuthenticationSession`) for one Google sign-in,
/// presented over `anchor`: the window the login page is in, which macOS has to be told. It shares
/// the browser's cookies (`prefersEphemeralWebBrowserSession = false`), so a Google account already
/// signed in there only has to be picked. The sheet catches the `orbit://` answer itself; it never
/// reaches the app's `onOpenURL`.
public final class GoogleWebAuthentication: NSObject, ASWebAuthenticationPresentationContextProviding {
    private let anchor: ASPresentationAnchor
    /// The sheet while it is up. A session nothing holds is torn down before it answers.
    private var session: ASWebAuthenticationSession?

    public init(anchor: ASPresentationAnchor) {
        self.anchor = anchor
    }

    /// Show `url` and answer with the `orbit://` URL the server sends the sheet to.
    @MainActor
    public func authenticate(_ url: URL) async throws -> URL {
        defer { session = nil }
        return try await withCheckedThrowingContinuation { continuation in
            let answer = Answer(continuation)
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: GoogleSignIn.callbackScheme) {
                @Sendable callback, error in
                if let callback {
                    answer.resume(.success(callback))
                } else if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin {
                    answer.resume(.failure(GoogleSignInError.cancelled))
                } else {
                    answer.resume(.failure(GoogleSignInError.unavailable))
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            if !session.start() { answer.resume(.failure(GoogleSignInError.unavailable)) }
        }
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        anchor
    }

    /// The continuation, resumed once: a sheet that fails to start may still call its handler.
    private final class Answer: @unchecked Sendable {
        private let lock = NSLock()
        private var continuation: CheckedContinuation<URL, Error>?

        init(_ continuation: CheckedContinuation<URL, Error>) { self.continuation = continuation }

        func resume(_ result: Result<URL, Error>) {
            lock.lock()
            let pending = continuation
            continuation = nil
            lock.unlock()
            pending?.resume(with: result)
        }
    }
}
#endif
