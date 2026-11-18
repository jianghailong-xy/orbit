import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Single-flight access-token refresh, shared process-wide per server host (via
/// `SessionRefresherRegistry`) so the many independent `APIClient` instances the app creates coalesce
/// concurrent 401s into ONE `POST /auth/refresh`. Server-side rotation means N racing refreshes of the
/// same token would revoke each other — and a replay of an already-rotated token trips reuse-detection
/// (which revokes the whole family) — so coalescing here is what keeps a burst of 401s from spuriously
/// signing the user out. Holds no token state: it reads the refresh token from, and writes the fresh
/// pair back to, the shared `TokenStore`.
actor SessionRefresher {
    private let baseURL: URL
    private let tokenStore: TokenStore
    private let session: URLSession
    private var inFlight: Task<RefreshOutcome, Never>?

    init(baseURL: URL, tokenStore: TokenStore, session: URLSession) {
        self.baseURL = baseURL
        self.tokenStore = tokenStore
        self.session = session
    }

    /// Attempt a refresh, coalescing concurrent callers onto one in-flight request. Never throws:
    /// the outcome says whether a fresh access token is now stored, and if not, whether the server
    /// refused the refresh token (re-login) or simply could not be reached (keep it, try later).
    func refresh() async -> RefreshOutcome {
        if let inFlight { return await inFlight.value }
        let task = Task<RefreshOutcome, Never> { [self] in await performRefresh() }
        inFlight = task
        let ok = await task.value
        inFlight = nil
        return ok
    }

    private func performRefresh() async -> RefreshOutcome {
        guard let refreshToken = tokenStore.refreshToken(for: baseURL),
              let body = try? JSONEncoder().encode(RefreshRequest(refreshToken: refreshToken))
        else { return .refused }
        var req = URLRequest(url: baseURL.appendingPathComponent("api/auth/refresh"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = body
        guard let (data, status) = try? await rawResponse(req) else { return .unreachable }
        // Only the server saying no to this refresh token ends the session. A 5xx, a 429, a proxy's
        // page or a body we can't read says nothing about the token: keep it and try again later.
        if status == 401 || status == 403 { return .refused }
        guard (200..<300).contains(status),
              let decoded = try? JSONDecoder().decode(RefreshResponse.self, from: data)
        else { return .unreachable }
        tokenStore.setToken(decoded.accessToken, for: baseURL)
        tokenStore.setRefreshToken(decoded.refreshToken, for: baseURL)
        return .refreshed
    }

    /// Raw request → body bytes and status; throws only on a transport failure. Deliberately does NOT
    /// go through `APIClient.send`, so a refresh can never re-enter the 401 refresh-retry path.
    private func rawResponse(_ req: URLRequest) async throws -> (Data, Int) {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<(Data, Int), Error>) in
            let task = session.dataTask(with: req) { data, response, error in
                if let error { cont.resume(throwing: error); return }
                guard let http = response as? HTTPURLResponse else {
                    cont.resume(throwing: APIError.invalidResponse); return
                }
                cont.resume(returning: (data ?? Data(), http.statusCode))
            }
            task.resume()
        }
    }
}

/// How a refresh ended.
enum RefreshOutcome: Sendable {
    /// A fresh token pair is stored.
    case refreshed
    /// The server answered 401/403 to the refresh, or no refresh token is stored: the session is over.
    case refused
    /// The server could not be reached or answered something else (timeout, 5xx, 429, unreadable
    /// body). The stored tokens are left as they were.
    case unreachable
}

/// Process-wide registry: one `SessionRefresher` per server host, so every `APIClient` for that host
/// shares a single-flight refresh without the refresher being threaded through each call site.
actor SessionRefresherRegistry {
    static let shared = SessionRefresherRegistry()
    private var byHost: [String: SessionRefresher] = [:]

    func refresher(baseURL: URL, tokenStore: TokenStore, session: URLSession) -> SessionRefresher {
        let key = baseURL.host ?? baseURL.absoluteString
        if let existing = byHost[key] { return existing }
        let made = SessionRefresher(baseURL: baseURL, tokenStore: tokenStore, session: session)
        byHost[key] = made
        return made
    }
}
