import Foundation
import Observation
import OrbitKit

/// Top-level app state: instance + auth + the Active session list. All UI-driving state lives
/// here; the heavy protocol logic stays in OrbitKit (APIClient, SessionGrouping, ServerURL).
@MainActor
@Observable
final class AppModel {
    // auth / instance
    var signedIn = false
    var instanceField = "orbit.wikova.com"
    var email = ""
    var password = ""
    var errorText: String?
    var busy = false

    // data
    var user: User?
    var sessions: [Session] = []
    var groups: SessionGroups = .empty
    var selectedSessionID: String?

    let tokenStore: TokenStore
    private(set) var baseURL: URL?
    private var api: APIClient?
    private var pollTask: Task<Void, Never>?

    private static let instanceKey = "orbit.instance"

    init() {
        #if canImport(Security)
        tokenStore = KeychainTokenStore()
        #else
        tokenStore = InMemoryTokenStore()
        #endif

        // Restore the last instance; if its token is still in the Keychain, skip the login screen.
        if let saved = UserDefaults.standard.string(forKey: Self.instanceKey),
           let url = ServerURL.normalize(saved) {
            instanceField = saved
            configure(url)
            if tokenStore.token(for: url) != nil { signedIn = true }
        }
    }

    private func configure(_ url: URL) {
        baseURL = url
        api = APIClient(baseURL: url, tokenStore: tokenStore)
    }

    func login() async {
        errorText = nil
        guard let url = ServerURL.normalize(instanceField) else {
            errorText = "Enter a valid instance URL"
            return
        }
        configure(url)
        UserDefaults.standard.set(instanceField, forKey: Self.instanceKey)

        busy = true
        defer { busy = false }
        do {
            _ = try await api!.login(email: email, password: password)
            user = try? await api!.me()
            password = ""
            signedIn = true
        } catch APIError.unauthorized {
            errorText = "Invalid email or password"
        } catch {
            errorText = "Sign-in failed — check the instance URL and that the server is reachable."
        }
    }

    func logout() {
        pollTask?.cancel()
        pollTask = nil
        if let baseURL { tokenStore.setToken(nil, for: baseURL) }
        signedIn = false
        sessions = []
        groups = .empty
        selectedSessionID = nil
    }

    /// Poll the Active list every 4s (the same cadence the web UI uses) to catch status changes
    /// the SSE stream of a single open session won't show.
    func startPolling() {
        guard pollTask == nil else { return }
        pollTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                await self?.loadSessions()
                try? await Task.sleep(nanoseconds: 4_000_000_000)
            }
        }
    }

    func loadSessions() async {
        guard let api else { return }
        do {
            let list = try await api.listSessions(view: "active")
            sessions = list
            groups = SessionGrouping.group(list)
        } catch APIError.unauthorized {
            logout()
        } catch {
            // Transient — keep the last good list.
        }
    }
}
