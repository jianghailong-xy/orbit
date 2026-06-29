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
    /// The session whose console is actually mounted — trails `selectedSessionID` by a short
    /// debounce so fast arrow-key navigation doesn't open (and immediately discard) a stream for
    /// every session it flies past. Driving the detail pane off this, not `selectedSessionID`, is
    /// the "A" half of the switch-cost fix; the warm cache (`consoleRegistry`) is the rest.
    var activeConsoleSessionID: String?
    private var consoleActivateTask: Task<Void, Never>?
    private static let consoleActivateDebounce: UInt64 = 200_000_000   // 200ms
    // Top-level nav: which AppShell section is showing, and the per-section selection.
    var selectedSection: AppSection = .active
    var selectedTaskID: String?
    var selectedRunnerID: String?
    var selectedAgentID: String?
    var selectedAgentSessionID: String?   // the agent session whose console fills the detail pane
    /// True while composing a brand-new session for the selected agent (the detail pane shows the
    /// draft composer instead of a console). Cleared once a session is selected/created or the
    /// agent changes. See `NewSessionView`.
    var composingAgentSession = false
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
    /// Warm cache of open consoles + their on-disk transcript store, scoped to this instance.
    private(set) var consoleRegistry: ConsoleRegistry?

    private func configure(_ url: URL) {
        baseURL = url
        api = APIClient(baseURL: url, tokenStore: tokenStore)
        tasks = TasksModel(baseURL: url, tokenStore: tokenStore)
        agents = AgentsModel(baseURL: url, tokenStore: tokenStore)
        runners = RunnersModel(baseURL: url, tokenStore: tokenStore)
        admin = AdminModel(baseURL: url, tokenStore: tokenStore)
        consoleRegistry = ConsoleRegistry(baseURL: url, tokenStore: tokenStore,
                                          store: ConsoleRegistry.defaultStore(for: url))
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
        consoleActivateTask?.cancel()
        consoleActivateTask = nil
        consoleRegistry?.reset()   // persist open transcripts, drop the warm cache
        if let baseURL { tokenStore.setToken(nil, for: baseURL) }
        signedIn = false
        sessions = []
        groups = .empty
        selectedSessionID = nil
        activeConsoleSessionID = nil
        selectedSection = .active
        selectedTaskID = nil
        selectedRunnerID = nil
        selectedAgentID = nil
        selectedAgentSessionID = nil
        composingAgentSession = false
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
    /// the SSE stream of a single open session won't show. Each tick also checkpoints the focused
    /// console to disk, so a crash/quit loses at most a few seconds of the open transcript.
    func startPolling() {
        guard pollTask == nil else { return }
        pollTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                await self?.loadSessions()
                if let self { self.consoleRegistry?.flush(self.activeConsoleSessionID) }
                try? await Task.sleep(nanoseconds: 4_000_000_000)
            }
        }
    }

    /// Mount the selected session's console after a short debounce. Called from the view on every
    /// `selectedSessionID` change (and once on appear). Rapid arrow-key changes keep cancelling and
    /// rescheduling, so only the session the user settles on actually opens a stream.
    func scheduleConsoleActivate() {
        let target = selectedSessionID
        guard target != activeConsoleSessionID else { return }
        consoleActivateTask?.cancel()
        consoleActivateTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: Self.consoleActivateDebounce)
            guard let self, !Task.isCancelled, self.selectedSessionID == target else { return }
            // Checkpoint the console we're leaving, then pre-warm the new one so the detail pane
            // renders its cached transcript with no spinner.
            self.consoleRegistry?.flush(self.activeConsoleSessionID)
            if let target { _ = self.consoleRegistry?.model(for: target, agentID: self.agentID(for: target)) }
            self.activeConsoleSessionID = target
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

    // MARK: keyboard commands (⌘N new session · ⌘1…⌘9 switch agent)

    /// Agents in sidebar display order — the order ⌘1…⌘9 index into (and the sidebar renders).
    /// Empty until the agent list loads.
    var orderedAgents: [Agent] { AgentListLogic.ordered(agents?.items ?? []) }

    /// agentID → 0-based position for the first nine agents, so the sidebar can show a faint "⌘N"
    /// hint on each shortcut-addressable row. Agents past the ninth get none.
    var agentShortcutIndex: [String: Int] {
        var map: [String: Int] = [:]
        for (i, a) in orderedAgents.prefix(9).enumerated() { map[a.id] = i }
        return map
    }

    /// The agent ⌘N opens a new session for: the one selected in the Agents section, else the agent
    /// behind the session open in Active, else the first agent. nil only when no agents exist — ⌘N
    /// is disabled then.
    var currentAgentID: String? {
        let all = orderedAgents
        guard !all.isEmpty else { return nil }
        if selectedSection == .agents, let id = selectedAgentID, all.contains(where: { $0.id == id }) {
            return id
        }
        if let sid = activeConsoleSessionID ?? selectedSessionID, let aid = agentID(for: sid),
           all.contains(where: { $0.id == aid }) {
            return aid
        }
        return all.first?.id
    }

    /// ⌘N: open the draft composer for `currentAgentID`, navigating into the Agents section.
    /// Mirrors the "New session" button in `AgentPanes`.
    func newSessionInCurrentAgent() {
        guard let id = currentAgentID else { return }
        selectedSection = .agents
        selectedAgentID = id
        selectedAgentSessionID = nil
        composingAgentSession = true
    }

    /// ⌘1…⌘9: select the agent at `index` (0-based) in sidebar order, navigating into the Agents
    /// section. Out of range (fewer agents than the digit pressed) is a no-op. Mirrors the sidebar's
    /// agent-selection binding.
    func selectAgent(at index: Int) {
        let all = orderedAgents
        guard all.indices.contains(index) else { return }
        let id = all[index].id
        selectedSection = .agents
        if selectedAgentID != id {
            selectedAgentID = id
            selectedAgentSessionID = nil
            composingAgentSession = false
        }
    }

    /// The session whose console fills the detail pane right now — the ⌘D ("Complete Session")
    /// target. In Active that's the mounted console; in Agents it's the selected agent session
    /// (nil while drafting a new one). nil in every other section, which disables the command.
    var currentSessionID: String? {
        switch selectedSection {
        case .active: return activeConsoleSessionID ?? selectedSessionID
        case .agents: return composingAgentSession ? nil : selectedAgentSessionID
        default:      return nil
        }
    }

    /// ⌘D: complete (archive) the open session — the keyboard twin of the web's ✓ on a session row.
    /// The server's archive ends a live session first (reason COMPLETED), so this works whether the
    /// session is running or already idle. Clears the selection so the console pane drops the
    /// archived session, then refreshes the Active list.
    func completeCurrentSession() {
        guard let api, let id = currentSessionID else { return }
        Task { @MainActor in
            do {
                try await api.archiveSession(id)
            } catch {
                errorText = "Couldn't complete the session."
                return
            }
            if selectedSessionID == id { selectedSessionID = nil }
            if activeConsoleSessionID == id { activeConsoleSessionID = nil }
            if selectedAgentSessionID == id { selectedAgentSessionID = nil }
            await loadSessions()
        }
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
