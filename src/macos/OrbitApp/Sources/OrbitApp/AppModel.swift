import Foundation
import Observation
import OrbitKit
import SwiftUI
import UserNotifications
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

/// Top-level app state: instance + auth + the Active session list. All UI-driving state lives
/// here; the heavy protocol logic stays in OrbitKit (APIClient, SessionGrouping, ServerURL).
@MainActor
@Observable
final class AppModel {
    // auth / instance
    var signedIn = false
    var instanceField = "orbitd.io"
    var email = ""
    var password = ""
    var errorText: String?
    var busy = false

    // data
    var user: User?
    var sessions: [Session] = []
    /// The owner's session-tag library — the 7 seeded system tags plus any custom ones, fetched from
    /// `GET /session-tags`. Drives the tag picker sheet and the list's tag filter/group chips; empty
    /// on an older server without the endpoint. See `loadSessionTags` / `setSessionTags`.
    var sessionTags: [SessionTag] = []
    // Top-level nav: which AppShell section is showing, and the per-section selection. The app
    // lands on the Agents section (the first agent's session list); the agent is selected once the
    // list loads — see `loadAgentsThenLand`.
    var selectedSection: AppSection = .agents {
        // Switching sections tears down the other stacks (compact renders one at a time); drop the
        // in-Settings Runners push so Settings reads as "at root" again when you return to it.
        didSet { if selectedSection != .settings { settingsShowingRunners = false } }
    }
    /// Latches the one-shot default-landing resolution so it runs only after the first agent-list
    /// load, and never overrides a later user/deep-link choice.
    private var didResolveDefaultLanding = false
    var selectedTaskID: String?
    var selectedRunnerID: String?
    /// iOS only: whether Settings has pushed its Runners sub-page (Runners was moved off the drawer
    /// rail into Settings). Drives the `.settings` branch of `sectionAtRoot` so the pushed runner
    /// pages yield the screen edge to the system back-swipe.
    var settingsShowingRunners = false
    /// Written through to `lastAgentKey` on every non-nil set so the launch default can restore your
    /// last agent (see `loadAgentsThenLand`); a nil (navigation reset) must not erase the memory.
    var selectedAgentID: String? {
        didSet {
            if let id = selectedAgentID { UserDefaults.standard.set(id, forKey: Self.lastAgentKey) }
        }
    }
    var selectedAgentSessionID: String?   // the agent session whose console fills the detail pane
    /// True while composing a brand-new session for the selected agent (the detail pane shows the
    /// draft composer instead of a console). Cleared once a session is selected/created or the
    /// agent changes. See `NewSessionView`.
    var composingAgentSession = false
    /// On compact, the session a *pushed* compose page created and is now hosting the console for in
    /// place (`AgentComposePush`). It's deliberately not the list selection, and `composingAgentSession`
    /// stays true so that page stays pushed — so the normal `.agents` focus rule would resolve to nil
    /// and never stream it. Surfacing it here makes it the focused (streaming) console. Set when the
    /// draft creates the session, cleared when that page is dismissed. See `focusedConsoleSessionID`.
    var composedConsoleSessionID: String?
    var selectedUserID: String?
    var menuSummary: MenuBarSummary = .empty
    /// Bumped to ask the visible session list (the Active sidebar or an agent's session list) to
    /// take keyboard focus so ↑/↓ resume switching sessions. The composer raises this on Escape,
    /// handing arrow-key control back to the list without the user having to click it first.
    var sessionListFocusRequest = 0
    func focusSessionList() { sessionListFocusRequest &+= 1 }

    /// The cached `Session` for an open console — searched across the Active list and the selected
    /// agent's sessions, mirroring how web's console header reads `selected` from the session list.
    /// Nil when the session isn't in a loaded list yet (e.g. a fresh deep link), in which case the
    /// header falls back to the live stream's agent + status.
    func session(id: String) -> Session? {
        sessions.first { $0.id == id } ?? agents?.agentSessions.first { $0.id == id }
    }

    /// The drawer's **Recents** feed: every jump-back session across all agents, newest first, derived
    /// from the already-fresh cross-agent Active list (`sessions`) — which the server returns in full,
    /// unpaginated. Uncapped on purpose: the drawer's Recents List is lazy, so it renders rows as you
    /// scroll rather than stopping at a fixed count. Empty until the first `loadSessions` lands; kept
    /// live by the same control-plane stream that drives the list.
    var recentSessions: [Session] { RecentsLogic.recent(sessions, limit: sessions.count) }

    let tokenStore: TokenStore
    let notifications = NotificationManager()
    private(set) var baseURL: URL?
    private var api: APIClient?
    private var pollTask: Task<Void, Never>?
    private var lastSnapshot: [Session]?
    /// The always-on control-plane stream (GET /api/events) and whether it's currently live.
    /// While live it owns list freshness (events trigger coalesced snapshot refreshes) and the
    /// 4s poll tick skips its fetch; any gap — reconnect backoff, an older server without the
    /// endpoint — falls back to polling automatically. See `runControlPlane`.
    private var controlTask: Task<Void, Never>?
    private(set) var controlPlaneLive = false
    private var controlRefreshScheduled = false

    private static let instanceKey = "orbit.instance"
    /// Remembers the last agent you selected so a cold launch lands there instead of always the
    /// first agent in the list. Read in `loadAgentsThenLand`, written by `selectedAgentID`'s didSet.
    private static let lastAgentKey = "orbit.lastAgent"

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
    #if os(macOS)
    /// The local runner this Mac may host. Shared between the menu-bar tray (status + quick
    /// Start/Stop) and the runner-manager window (log + enroll). Created per instance. macOS-only:
    /// controlling a launchd service is impossible in the iOS sandbox, so the iOS client is a
    /// pure remote console with no local-runner surface.
    private(set) var runnerControl: RunnerControl?
    #endif

    private func configure(_ url: URL) {
        baseURL = url
        api = APIClient(baseURL: url, tokenStore: tokenStore)
        tasks = TasksModel(baseURL: url, tokenStore: tokenStore)
        agents = AgentsModel(baseURL: url, tokenStore: tokenStore)
        runners = RunnersModel(baseURL: url, tokenStore: tokenStore)
        admin = AdminModel(baseURL: url, tokenStore: tokenStore)
        consoleRegistry = ConsoleRegistry(baseURL: url, tokenStore: tokenStore,
                                          store: ConsoleRegistry.defaultStore(for: url))
        #if os(macOS)
        runnerControl = RunnerControl(baseURL: url, tokenStore: tokenStore)
        #endif
    }

    // MARK: settings (preferences + password live on the user; no separate store needed)

    /// The saved `theme` preference as a SwiftUI color scheme, or nil to follow the system
    /// appearance ("system" or an unknown future value). Applied via `.preferredColorScheme` at
    /// each shell's root — without it the dynamic `Color(light:dark:)` tokens (and the system
    /// colors) resolve against the device appearance only, so picking Light/Dark in Settings was
    /// stored and synced but never changed anything on screen.
    var preferredColorScheme: ColorScheme? {
        switch user?.preferences?.theme {
        case "light": return .light
        case "dark": return .dark
        default: return nil
        }
    }

    func savePreferences(_ req: UpdatePreferencesRequest) async {
        guard let api else { return }
        do { user = try await api.updatePreferences(req) }
        catch { errorText = "Couldn't save preferences." }
    }

    /// Persist the composer's last-picked reasoning effort as the account default (synced across
    /// devices), so the next new session — here or on web/another device — seeds this effort.
    /// Fire-and-forget and quiet: the local pill already reflects the pick, so a failed sync is
    /// non-fatal (mirrors web's best-effort preferences write). Skips a no-op re-select, and only
    /// adopts the refreshed `user` on success so a transient failure never wipes it.
    func rememberDefaultEffort(_ raw: String) {
        guard let api, user?.preferences?.defaultEffort != raw else { return }
        Task {
            if let updated = try? await api.updatePreferences(UpdatePreferencesRequest(defaultEffort: raw)) {
                user = updated
            }
        }
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
        controlTask?.cancel()
        controlTask = nil
        controlPlaneLive = false
        consoleRegistry?.reset()   // persist open transcripts, drop the warm cache
        if let baseURL { tokenStore.setToken(nil, for: baseURL) }
        signedIn = false
        sessions = []
        resetNavigation()
        lastSnapshot = nil
        menuSummary = .empty
        updateDockBadge(nil)
    }

    /// Reset every navigation/selection field to the signed-out baseline. The ONE place they are
    /// cleared wholesale — when adding a navigation field to this model, add its reset here, or a
    /// stale selection leaks into the next sign-in.
    private func resetNavigation() {
        selectedSection = .agents
        didResolveDefaultLanding = false
        selectedTaskID = nil
        selectedRunnerID = nil
        selectedAgentID = nil
        selectedAgentSessionID = nil
        composingAgentSession = false
        composedConsoleSessionID = nil
        selectedUserID = nil
    }

    /// Wire up notifications. Call once at launch.
    func bootstrap() {
        notifications.configure()
        notifications.onIntent = { [weak self] intent in self?.handle(intent) }
        #if os(macOS)
        // Frozen-runner upkeep: a Sparkle app update ships a newer bundled runner than the installed
        // ~/.orbit/bin copy (its network self-update is off), so re-sync it once at launch.
        Task { await runnerControl?.syncBundledRunner() }
        #endif
    }

    /// Keep the Active list fresh. The control-plane stream (below) is the primary source: while
    /// it's live, its events drive coalesced refreshes and the 4s tick here skips its fetch. The
    /// tick remains as the universal fallback — an older server without `/api/events`, or any
    /// reconnect gap, degrades back to exactly the old polling behavior with no user action.
    /// Each tick also checkpoints the focused console to disk regardless, so a crash/quit loses
    /// at most a few seconds of the open transcript.
    func startPolling() {
        guard pollTask == nil else { return }
        startControlPlane()
        pollTask = Task { @MainActor [weak self] in
            // A restored-token launch sets `signedIn` in `init` without going through `login()`, so
            // `user` is still nil — prime it once so the sidebar account footer shows the real name
            // instead of the "Account" placeholder.
            if let self, self.user == nil { self.user = try? await self.api?.me() }
            while !Task.isCancelled {
                if let self, !self.controlPlaneLive { await self.loadSessions() }
                if let self { self.consoleRegistry?.flush(self.focusedConsoleSessionID) }
                try? await Task.sleep(nanoseconds: 4_000_000_000)
            }
        }
    }

    // MARK: control-plane stream (GET /api/events)

    private func startControlPlane() {
        guard controlTask == nil, baseURL != nil else { return }
        controlTask = Task { @MainActor [weak self] in await self?.runControlPlane() }
    }

    /// Force the control-plane stream to reconnect now — called when the app returns to the
    /// foreground, where a socket suspended in the background can be dead but not yet erroring
    /// (the watchdog would catch it, but a relaunch is immediate). No-op when signed out.
    func kickControlPlane() {
        guard controlTask != nil else { return }
        controlTask?.cancel()
        controlTask = nil
        controlPlaneLive = false
        startControlPlane()
    }

    /// The always-on control-plane consume loop: one per-user SSE stream carries lifecycle /
    /// status / approval / background events for ALL sessions, replacing the poll as the driver
    /// of the list, badges and notifications (docs/realtime-control-plane-stream.md §5.2).
    ///
    /// Freshness model — "snapshot + follow" (§4.5): on every (re)connect, one REST snapshot
    /// rebuilds the derived list state; after that each control event triggers a coalesced
    /// `loadSessions()` (200ms window). Reusing the snapshot path for event application keeps a
    /// single source of truth for row shape, grouping, badges AND the notification diff — a
    /// field-level upsert can come later if event volume ever warrants it.
    private func runControlPlane() async {
        guard let baseURL else { return }
        let stream = URLSessionControlStream(baseURL: baseURL,
                                             token: { [tokenStore] in tokenStore.token(for: baseURL) })
        var policy = ReconnectPolicy()
        while !Task.isCancelled {
            do {
                for try await item in stream.events() {
                    policy.noteHealthy()
                    switch item {
                    case .connected:
                        controlPlaneLive = true
                        await loadSessions()   // rebuild from snapshot, then follow
                    case .event:
                        scheduleControlRefresh()
                    }
                }
                // Clean close — reconnect after a beat.
                controlPlaneLive = false
                switch policy.next(after: .ended) {
                case .stop: return
                case .reconnect(let ms): if ms > 0 { await sleepMs(ms) }
                }
            } catch is CancellationError {
                controlPlaneLive = false
                return
            } catch APIError.http(let status, _) where status == 404 || status == 401 {
                // 404: an older server without /api/events — polling stays in charge for this
                // sign-in. 401: the token died; the polling path handles the logout.
                controlPlaneLive = false
                return
            } catch {
                controlPlaneLive = false
                switch policy.next(after: .failed) {
                case .stop: return
                case .reconnect(let ms): if ms > 0 { await sleepMs(ms) }
                }
            }
        }
        controlPlaneLive = false
    }

    /// Coalesce event-driven refreshes: a burst of control events (a turn ending fires STATUS +
    /// TURN_END back-to-back) folds into one list fetch.
    private func scheduleControlRefresh() {
        guard !controlRefreshScheduled else { return }
        controlRefreshScheduled = true
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 200_000_000)
            guard let self else { return }
            self.controlRefreshScheduled = false
            await self.loadSessions()
        }
    }

    private func sleepMs(_ ms: Int) async {
        try? await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000)
    }

    /// The session whose console is currently on screen (whichever section) — and therefore the one
    /// that should be live-streaming. Nil when a list / placeholder / new-session draft is showing.
    /// Section-aware so switching sections (or backing out to a list) stops the previous console's
    /// stream even if SwiftUI keeps its view cached.
    var focusedConsoleSessionID: String? {
        switch selectedSection {
        // A compose page hosting its just-created console in place (`composedConsoleSessionID`) wins
        // over the compose/selection rule: `composingAgentSession` is still true there, so without this
        // the session would render but never stream.
        case .agents: return composedConsoleSessionID ?? (composingAgentSession ? nil : selectedAgentSessionID)
        default:      return nil
        }
    }

    /// Push the current console focus to the registry, which starts exactly that session's SSE stream
    /// and stops any other. Driven from the always-present shell on any focus change (MainView /
    /// CompactShell `.onChange(of: focusedConsoleSessionID)`), so a stream never outlives its console
    /// by depending on a view unmounting.
    func syncConsoleFocus() {
        let id = focusedConsoleSessionID
        consoleRegistry?.focus(id, agentID: id.flatMap { agentID(for: $0) })
    }

    func loadSessions() async {
        guard let api else { return }
        do {
            let list = try await api.listSessions(view: "active")
            // Notify on poll-to-poll transitions (skip the first load, which only primes). Skip the
            // session whose console is on screen — its own stream already shows the change.
            if let prev = lastSnapshot {
                for event in SessionDelta.diff(previous: prev, current: list, focusedSessionID: focusedConsoleSessionID) {
                    notifications.post(Notifications.content(for: event))
                }
            }
            lastSnapshot = list
            sessions = list
            menuSummary = MenuBar.summary(from: list)
            updateDockBadge(menuSummary.badge)
            #if os(iOS)
            // Foreground reconcile: drop delivered approval banners for sessions that no longer need
            // a reply (e.g. handled on web/macOS), so Notification Center matches the badge — and to
            // cover the case a silent push couldn't (a force-quit app). See docs/cross-platform-badge-sync.md.
            let needsYou = Set(SessionGrouping.group(list).needsYou.map(\.id))
            NotificationManager.removeDeliveredApprovals(where: { !needsYou.contains($0) })
            #endif
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

    /// The agent ⌘N opens a new session for: the one selected in the Agents section, else the first
    /// agent. nil only when no agents exist — ⌘N is disabled then.
    var currentAgentID: String? {
        let all = orderedAgents
        guard !all.isEmpty else { return nil }
        if selectedSection == .agents, let id = selectedAgentID, all.contains(where: { $0.id == id }) {
            return id
        }
        return all.first?.id
    }

    /// A draft composer just created `session`: surface it in the agent's list (so the `List`
    /// selection that pushes its console has a matching row) and open its console. Registering *before*
    /// arming the selection is what keeps the iPhone push from bouncing back to the "Select a session"
    /// empty state — see `AgentsModel.registerCreatedSession`.
    func openCreatedAgentSession(_ session: Session) {
        agents?.registerCreatedSession(session)
        composingAgentSession = false
        selectedAgentSessionID = session.id
    }

    /// ⌘N: open the draft composer for `currentAgentID`, navigating into the Agents section.
    /// Mirrors the "New session" button in `AgentPanes`.
    func newSessionInCurrentAgent() {
        guard let id = currentAgentID else { return }
        selectedSection = .agents
        selectedAgentID = id
        startComposingSession()
    }

    /// Open the draft composer for the agent pane already on screen (the "New session" toolbar
    /// button): drop the session selection so the compose pane takes the detail column / pushes.
    func startComposingSession() {
        selectedAgentSessionID = nil
        composingAgentSession = true
    }

    /// Switch the agent the new-session draft is composing for while staying on the compose page —
    /// the hero's agent switcher. Unlike `openAgent` (which drops compose state to land on the
    /// agent's session list), this keeps `composingAgentSession` true so the pushed/inline
    /// `NewSessionView` just rebuilds for `id` (a fresh draft via its `.id(agent.id)`).
    func composeWithAgent(_ id: String) {
        selectedSection = .agents
        selectedAgentID = id
        selectedAgentSessionID = nil
        composingAgentSession = true
    }

    /// Enter the Agents section focused on agent `id` — the one navigation transition behind the
    /// macOS sidebar row, the compact drawer row, and ⌘1…⌘9. Switching to a *different* agent
    /// clears that agent-scoped state (session selection + draft compose) so its pane opens on the
    /// session list; re-selecting the current agent keeps them (a pushed console stays pushed).
    func openAgent(_ id: String) {
        selectedSection = .agents
        if selectedAgentID != id {
            selectedAgentID = id
            selectedAgentSessionID = nil
            composingAgentSession = false
        }
    }

    /// Open a **Recents** row from the drawer: jump into the session's owning agent and select it so
    /// the Agents pane pushes its console. The Active list nests the agent, so there's no fetch (unlike
    /// a cold deep link — see `openSession`). A no-op agent switch keeps an already-pushed console; a
    /// real switch clears the prior agent's session/compose state before selecting this session.
    func openRecentSession(_ s: Session) {
        selectedSection = .agents
        if let agentID = s.agent?.id ?? s.agentId, selectedAgentID != agentID {
            selectedAgentID = agentID
        }
        composingAgentSession = false
        selectedAgentSessionID = s.id
    }

    /// ⌘1…⌘9: select the agent at `index` (0-based) in sidebar order, navigating into the Agents
    /// section. Out of range (fewer agents than the digit pressed) is a no-op. Mirrors the sidebar's
    /// agent-selection binding.
    func selectAgent(at index: Int) {
        let all = orderedAgents
        guard all.indices.contains(index) else { return }
        openAgent(all[index].id)
    }

    /// The session whose console fills the detail pane right now — the ⌘D ("Complete Session")
    /// target. In Agents it's the selected agent session (nil while drafting a new one). nil in
    /// every other section, which disables the command.
    var currentSessionID: String? {
        switch selectedSection {
        case .agents: return composingAgentSession ? nil : selectedAgentSessionID
        default:      return nil
        }
    }

    /// True when the current section's navigation stack is at its root (nothing pushed) — derived
    /// from the same selection state that drives each stack's push. The compact shell uses this to
    /// yield the left screen edge to its drawer-open gesture only where no pushed page needs the
    /// edge for the system back-swipe.
    var sectionAtRoot: Bool {
        switch selectedSection {
        case .tasks:   return selectedTaskID == nil
        // The compose page (composing) is pushed too, not just a selected session's console — so the
        // agents stack is at root only when neither is up, leaving the edge to the system back-swipe.
        case .agents:  return selectedAgentSessionID == nil && !composingAgentSession
        case .runners: return selectedRunnerID == nil
        // Settings pushes its Runners sub-page (iOS); it's at root only when that isn't up, so the
        // pushed runner pages yield the edge to the system back-swipe.
        case .settings: return !settingsShowingRunners
        case .skills, .admin: return true
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
            dropIfOpen(id)
            await loadSessions()
        }
    }

    /// Clear a session out of the pane that has it open (the agent console selection), so a
    /// completed/deleted session can't linger in the detail view. Used by ⌘D and the row actions.
    private func dropIfOpen(_ id: String) {
        if selectedAgentSessionID == id { selectedAgentSessionID = nil }
    }

    // MARK: session row actions (shared by the menu-bar quick items + the agent session lists)

    /// A just-performed reversible action, surfaced as an Undo toast for a few seconds. Restore is
    /// the universal undo — the server's `restore` clears both archive and trash state.
    struct SessionUndo: Identifiable, Equatable {
        let id = UUID()
        let message: String
        let sessionID: String
    }
    var sessionUndo: SessionUndo?
    private var undoDismiss: Task<Void, Never>?

    /// Refresh whichever session lists are on screen (the Active sidebar always; the agent list if
    /// one has been opened) so a row action reflects immediately instead of waiting for the poll.
    private func reloadSessionLists() async {
        await loadSessions()
        await agents?.reloadCurrentSessions()
    }

    private func offerUndo(_ message: String, sessionID: String) {
        sessionUndo = SessionUndo(message: message, sessionID: sessionID)
        undoDismiss?.cancel()
        undoDismiss = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            guard !Task.isCancelled else { return }
            self?.sessionUndo = nil
        }
    }

    func dismissUndo() { undoDismiss?.cancel(); sessionUndo = nil }

    /// Complete (archive) a session — the server ends a live one first (reason COMPLETED). Drops it
    /// from any open pane and offers Undo.
    func completeSession(_ id: String) {
        guard let api else { return }
        Task { @MainActor in
            do { try await api.archiveSession(id) }
            catch { errorText = "Couldn't complete the session."; return }
            dropIfOpen(id)
            await reloadSessionLists()
            offerUndo("Completed", sessionID: id)
        }
    }

    /// Restore an archived/trashed session back to Active (also the Undo target).
    func restoreSession(_ id: String) {
        guard let api else { return }
        Task { @MainActor in
            try? await api.restoreSession(id)
            await reloadSessionLists()
        }
    }

    /// Soft-delete a session to the trash — reversible via Undo (or the Trash view).
    func deleteSession(_ id: String) {
        guard let api else { return }
        Task { @MainActor in
            try? await api.deleteSession(id)
            dropIfOpen(id)
            await reloadSessionLists()
            offerUndo("Deleted", sessionID: id)
        }
    }

    /// Permanently delete a trashed session and all its data — irreversible, so there's no Undo (the
    /// Trash row action gates it behind a confirmation). Mirrors web's `purgeMut`.
    func purgeSession(_ id: String) {
        guard let api else { return }
        Task { @MainActor in
            do { try await api.purgeSession(id) }
            catch { errorText = "Couldn't delete the session permanently."; return }
            dropIfOpen(id)
            await reloadSessionLists()
        }
    }

    /// Pin or unpin a session; the server floats pinned sessions to the top of every list.
    func setPinned(_ session: Session, pinned: Bool) {
        guard let api else { return }
        Task { @MainActor in
            do {
                if pinned { try await api.pinSession(session.id) }
                else { try await api.unpinSession(session.id) }
            } catch { return }
            await reloadSessionLists()
        }
    }

    // MARK: session tags

    /// Load the owner's tag library (best-effort — an older server without the endpoint leaves it
    /// empty, and the picker/chips simply don't appear).
    func loadSessionTags() async {
        guard let api else { return }
        if let tags = try? await api.listSessionTags() { sessionTags = tags }
    }

    /// Replace the full set of tags on a session (the picker sends its current selection), then
    /// refresh the on-screen lists so the row's dots and any tag grouping update.
    func setSessionTags(_ session: Session, tagIDs: [String]) {
        guard let api else { return }
        Task { @MainActor in
            do { _ = try await api.setSessionTags(session.id, tagIDs: tagIDs) }
            catch { return }
            await reloadSessionLists()
        }
    }

    /// Create a custom tag, then reload the library so the picker and filter chips show it.
    func createSessionTag(name: String, color: String) {
        guard let api else { return }
        Task { @MainActor in
            do { _ = try await api.createSessionTag(name: name, color: color) }
            catch { errorText = "Couldn't create the tag."; return }
            await loadSessionTags()
        }
    }

    /// Rename and/or recolor a custom tag, then reload the library + lists (a recolor changes the
    /// row dots, so the lists refresh too).
    func updateSessionTag(_ id: String, name: String? = nil, color: String? = nil) {
        guard let api else { return }
        Task { @MainActor in
            do { _ = try await api.updateSessionTag(id, name: name, color: color) }
            catch { errorText = "Couldn't update the tag."; return }
            await loadSessionTags()
            await reloadSessionLists()
        }
    }

    /// Delete a custom tag; its links to sessions cascade away server-side, so reload the library
    /// and the lists (rows lose the dot).
    func deleteSessionTag(_ id: String) {
        guard let api else { return }
        Task { @MainActor in
            do { try await api.deleteSessionTag(id) }
            catch { errorText = "Couldn't delete the tag."; return }
            await loadSessionTags()
            await reloadSessionLists()
        }
    }

    func undoSessionAction() {
        guard let undo = sessionUndo else { return }
        restoreSession(undo.sessionID)
        dismissUndo()
    }

    // MARK: routing + notification intents

    func route(to route: Route) {
        selectedSection = AppSection.forRoute(route)
        switch route {
        case .active:          if selectedAgentID == nil { selectedAgentID = orderedAgents.first?.id }
        case .session(let id): openSession(id)
        case .task(let id):    selectedTaskID = id
        case .runner(let id):  selectedRunnerID = id
        }
    }

    /// Open a session's console. There's no standalone session view anymore, so route into its
    /// owning agent's console (the section is already `.agents`, set by `route`). Resolve the agent
    /// from the loaded Active list, else fetch the session to learn it; showing the session id right
    /// away lets the console paint while the agent resolves in the background.
    private func openSession(_ id: String) {
        composingAgentSession = false
        selectedAgentSessionID = id
        if let aid = agentID(for: id) {
            selectedAgentID = aid
        } else {
            Task { @MainActor [weak self] in
                guard let self, let session = try? await self.api?.session(id),
                      self.selectedAgentSessionID == id else { return }   // ignore a stale resolve
                self.selectedAgentID = session.agent?.id ?? session.agentId
            }
        }
    }

    /// Load the agent list, then land on the first agent's session list (the app's home) if we're
    /// still on the launch default. Runs the resolution once; a deep link / notification that
    /// already chose an agent (or another section) is respected. No agents → the Runners section,
    /// the native parallel of web's runners/register onboarding.
    func loadAgentsThenLand() async {
        await agents?.load()
        guard !didResolveDefaultLanding else { return }
        didResolveDefaultLanding = true
        // Only claim the launch default: a deep link / notification that already chose an agent, a
        // session (still resolving its agent), or another section is respected.
        guard selectedSection == .agents, selectedAgentID == nil, selectedAgentSessionID == nil else { return }
        let ordered = orderedAgents
        // Prefer the agent you last used (persisted via `selectedAgentID`) so a cold launch reopens
        // your context; fall back to the first agent, or Runners onboarding when there are none.
        if let last = UserDefaults.standard.string(forKey: Self.lastAgentKey),
           ordered.contains(where: { $0.id == last }) {
            selectedAgentID = last
        } else if let first = ordered.first?.id {
            selectedAgentID = first
        } else {
            selectedSection = .runners
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
        #if os(macOS)
        NSApp.dockTile.badgeLabel = badge
        #elseif os(iOS)
        // Reconcile the app-icon badge with the current "needs you" count on every poll while the
        // app is foreground (the APNs payload sets it while backgrounded). `badge` is the count as a
        // string, or nil when nothing needs a reply → clear to 0.
        UNUserNotificationCenter.current().setBadgeCount(Int(badge ?? "") ?? 0)
        #endif
    }
}
