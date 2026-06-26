import Foundation
import AppKit
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
    // Top-level nav: which AppShell section is showing, and the per-section selection.
    var selectedSection: AppSection = .active
    var selectedTaskID: String?
    var selectedRunnerID: String?
    var selectedAgentID: String?
    var selectedUserID: String?
    var menuSummary: MenuBarSummary = .empty

    let tokenStore: TokenStore
    let notifications = NotificationManager()
    private(set) var baseURL: URL?
    private var api: APIClient?
    private var pollTask: Task<Void, Never>?
    private var lastSnapshot: [Session]?

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

    /// Per-section shared stores (list + detail observe the same instance). Rebuilt per instance.
    private(set) var tasks: TasksModel?
    private(set) var agents: AgentsModel?
    private(set) var runners: RunnersModel?
    private(set) var admin: AdminModel?

    private func configure(_ url: URL) {
        baseURL = url
        api = APIClient(baseURL: url, tokenStore: tokenStore)
        tasks = TasksModel(baseURL: url, tokenStore: tokenStore)
        agents = AgentsModel(baseURL: url, tokenStore: tokenStore)
        runners = RunnersModel(baseURL: url, tokenStore: tokenStore)
        admin = AdminModel(baseURL: url, tokenStore: tokenStore)
    }

    // MARK: settings (preferences + password live on the user; no separate store needed)

    func savePreferences(_ req: UpdatePreferencesRequest) async {
        guard let api else { return }
        do { user = try await api.updatePreferences(req) }
        catch { errorText = "Couldn't save preferences." }
    }

    /// Returns nil on success, else a message. Wrong current password is a 400 (not a 401, so it
    /// won't bounce the session).
    func changePassword(current: String, new: String) async -> String? {
        guard let api else { return "Not signed in." }
        do {
            try await api.changePassword(ChangePasswordRequest(currentPassword: current, newPassword: new))
            return nil
        } catch APIError.http(_, let body) {
            return (body?.isEmpty == false ? body : "Couldn't change password.")
        } catch {
            return "Couldn't change password."
        }
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
        selectedSection = .active
        selectedTaskID = nil
        selectedRunnerID = nil
        selectedAgentID = nil
        selectedUserID = nil
        lastSnapshot = nil
        menuSummary = .empty
        updateDockBadge(nil)
    }

    /// Wire up notifications. Call once at launch.
    func bootstrap() {
        notifications.configure()
        notifications.onIntent = { [weak self] intent in self?.handle(intent) }
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
            // Notify on poll-to-poll transitions (skip the first load, which only primes).
            if let prev = lastSnapshot {
                for event in SessionDelta.diff(previous: prev, current: list, focusedSessionID: selectedSessionID) {
                    notifications.post(Notifications.content(for: event))
                }
            }
            lastSnapshot = list
            sessions = list
            groups = SessionGrouping.group(list)
            menuSummary = MenuBar.summary(from: list)
            updateDockBadge(menuSummary.badge)
        } catch APIError.unauthorized {
            logout()
        } catch {
            // Transient — keep the last good list.
        }
    }

    /// The agent a session runs as, for scoping the composer's `/` autocomplete. The active list
    /// nests `agent`; fall back to the flat `agentId` if present.
    func agentID(for sessionID: String) -> String? {
        guard let s = sessions.first(where: { $0.id == sessionID }) else { return nil }
        return s.agent?.id ?? s.agentId
    }

    // MARK: routing + notification intents

    func route(to route: Route) {
        selectedSection = AppSection.forRoute(route)
        switch route {
        case .active:          break
        case .session(let id): selectedSessionID = id
        case .task(let id):    selectedTaskID = id
        case .runner(let id):  selectedRunnerID = id
        }
    }

    func handle(_ intent: AppIntent) {
        switch intent {
        case .open(let route): self.route(to: route)
        case let .approve(sid, behavior): Task { await approveAll(sessionID: sid, behavior: behavior) }
        case let .reply(sid, text): Task { await reply(sessionID: sid, text: text) }
        }
    }

    /// A notification Allow/Deny decides every pending approval on that session (the
    /// notification doesn't carry a specific approval id).
    private func approveAll(sessionID: String, behavior: ApprovalBehavior) async {
        guard let api,
              let pending = try? await api.approvals(sessionID: sessionID, status: "PENDING") else { return }
        for approval in pending {
            try? await api.decideApproval(sessionID: sessionID, approvalID: approval.id,
                                          ApprovalDecisionRequest(behavior: behavior))
        }
    }

    private func reply(sessionID: String, text: String) async {
        guard let api else { return }
        _ = try? await api.sendTurn(sessionID: sessionID,
                                    SessionTurnRequest(clientTurnId: UUID().uuidString, content: text))
    }

    private func updateDockBadge(_ badge: String?) {
        NSApp.dockTile.badgeLabel = badge
    }
}
