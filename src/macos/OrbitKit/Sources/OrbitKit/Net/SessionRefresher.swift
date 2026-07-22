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
    private var inFlight: Task<Bool, Never>?

    init(baseURL: URL, tokenStore: TokenStore, session: URLSession) {
        self.baseURL = baseURL
        self.tokenStore = tokenStore
        self.session = session
    }

    /// Attempt a refresh, coalescing concurrent callers onto one in-flight request. Resolves to
    /// whether a fresh access token is now stored. Never throws — a failure just means "couldn't
    /// refresh", and the caller falls through to its normal 401 handling (re-login).
    func refresh() async -> Bool {
        if let inFlight { return await inFlight.value }
        let task = Task<Bool, Never> { [self] in await performRefresh() }
        inFlight = task
        let ok = await task.value
        inFlight = nil
        return ok
    }

    private func performRefresh() async -> Bool {
        guard let refreshToken = tokenStore.refreshToken(for: baseURL),
              let body = try? JSONEncoder().encode(RefreshRequest(refreshToken: refreshToken))
        else { return false }
        var req = URLRequest(url: baseURL.appendingPathComponent("api/auth/refresh"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = body
        guard let data = try? await rawData(req),
              let decoded = try? JSONDecoder().decode(RefreshResponse.self, from: data)
        else { return false }
        tokenStore.setToken(decoded.accessToken, for: baseURL)
        tokenStore.setRefreshToken(decoded.refreshToken, for: baseURL)
        return true
    }

    /// Raw request → body bytes for a 2xx only; throws otherwise. Deliberately does NOT go through
    /// `APIClient.send`, so a refresh can never re-enter the 401 refresh-retry path (no recursion).
    private func rawData(_ req: URLRequest) async throws -> Data {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Data, Error>) in
            let task = session.dataTask(with: req) { data, response, error in
                if let error { cont.resume(throwing: error); return }
                guard let http = response as? HTTPURLResponse, let data,
                      (200..<300).contains(http.statusCode) else {
                    cont.resume(throwing: APIError.invalidResponse); return
                }
                cont.resume(returning: data)
            }
            task.resume()
        }
    }
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
