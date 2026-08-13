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

/// How loud a toast is — drives its icon, its tint, and whether it self-dismisses. Ported from
/// web's `SessionNoticeTone` so the same outcome reads the same on every client.
enum ToastTone: Equatable {
    case success, neutral, info, warning, error

    /// Web parity: an outcome you need to read twice — and usually paste somewhere — isn't taken
    /// away on a timer. It stays until the ✕.
    var isPersistent: Bool { self == .warning || self == .error }
}

/// What a console reports to the app's toast host. The session id isn't here: the registry knows
/// which console it handed this sink to and adds it (see `ConsoleRegistry.onToast`).
struct ToastRequest: Equatable {
    let message: String
    var detail: String?
    var tone: ToastTone = .success
}

/// Top-level app state: instance + auth + the Open session list. All UI-driving state lives
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
        // section-specific pushes so each section reads as "at root" again when you return to it.
        didSet {
            if selectedSection != .settings { settingsShowingRunners = false }
            if selectedSection != .tasks { taskListsDirectoryPresented = false }
        }
    }
    /// Latches the one-shot default-landing resolution so it runs only after the first agent-list
    /// load, and never overrides a later user/deep-link choice.
    private var didResolveDefaultLanding = false
    var selectedTaskID: String? {
        didSet {
            // The detail store is a single slot. Clear it synchronously on every selection change
            // so an A response cannot paint under B, and a deleted task cannot leave compact iOS
            // navigation stuck on a spinner with a non-nil selection.
            if selectedTaskID != oldValue { tasks?.clearDetail() }
        }
    }
    var selectedRunnerID: String?
    /// iOS only: whether Tasks has pushed the searchable directory of every named task list.
    /// The drawer shows only a compact preview; this state also tells the shell to leave the
    /// leading edge to the system back-swipe while the directory page is visible.
    var taskListsDirectoryPresented = false
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
    var selectedAgentSessionID: String? {   // the agent session whose console fills the detail pane
        // A console reached any way other than a Recents tap drops the Recents edge-swipe affordance, so
        // list-opened (and deep-linked) consoles keep the system back-swipe. `openRecentSession` sets
        // `recentsConsoleSessionID` *before* the selection so this observer preserves it there.
        didSet {
            if selectedAgentSessionID != recentsConsoleSessionID { recentsConsoleSessionID = nil }
        }
    }
    /// iOS compact: the session id a **Recents** drawer tap pushed into a console. While it equals the
    /// selected session (`consoleFromRecents`), the shell frees the left screen edge for the drawer-open
    /// swipe — you came from the drawer, so the edge returns you there. Cleared by the observer above the
    /// moment the selection moves off it (back to the list, a different session, or leaving Agents).
    var recentsConsoleSessionID: String?
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
    /// Bumped to ask the visible session list (Open or an agent's scoped list) to
    /// take keyboard focus so ↑/↓ resume switching sessions. The composer raises this on Escape,
    /// handing arrow-key control back to the list without the user having to click it first.
    var sessionListFocusRequest = 0
    func focusSessionList() { sessionListFocusRequest &+= 1 }

    /// Exact records fetched to resolve cold deep links / global-search hits. Those routes can point
    /// at Completed or Trash, which are absent from the cross-agent Open list. Keeping the response
    /// lets the header, composer and lifecycle/capability guards share the same authoritative context.
    private var sessionDetails = SessionDetailCache()

    /// The cached `Session` for an open console. Fresh list snapshots win; a cold-routed detail is
    /// the fallback when the record lives outside the currently loaded Open / agent list scopes.
    func session(id: String) -> Session? {
        sessionDetails.resolve(id, preferring: sessions, agents?.agentSessions ?? [])
    }

    /// The drawer's **Recents** feed: every jump-back session across all agents, newest first, derived
    /// from the already-fresh cross-agent Open list (`sessions`) — which the server returns in full,
    /// unpaginated. Uncapped on purpose, but the cut belongs to the drawer, not here: it renders one
    /// page of rows and extends the window as you scroll (`RecentsLogic.pageSize`), which needs the
    /// complete ordering to page through. Empty until the first `loadSessions` lands; kept live by
    /// the same control-plane stream that drives the list.
    ///
    /// Derived ONCE per applied snapshot (see `applySessionSnapshot`) rather than on every read: the
    /// drawer stays mounted behind the content card, so it reads this on every body pass — and it is
    /// a full recency sort of every open session, which as a computed property ran again for each of
    /// those passes (and once more for `selectedSessionInRecents`).
    private(set) var recentSessions: [Session] = []

    /// The compact drawer lists the open session twice when its runner group is expanded — once as the
    /// owning agent's row (`selectedAgentID`) and once as its Recents row (`selectedAgentSessionID`) —
    /// which lit both pills. This flags when the session is genuinely a Recents row, so the agent row can
    /// yield to the more specific Recents pill and only one row highlights. It stays false for a session
    /// with no Recents row (e.g. a deep-linked non-active session), so that agent row keeps its pill.
    var selectedSessionInRecents: Bool {
        guard let id = selectedAgentSessionID else { return false }
        return recentSessions.contains { $0.id == id }
    }

    let tokenStore: TokenStore
    let notifications = NotificationManager()
    private(set) var baseURL: URL?
    private var api: APIClient?
    /// Invalidates async detail reads when logout or an instance switch replaces their scope.
    private var apiGeneration = 0
    private var pollTask: Task<Void, Never>?
    private var lastSnapshot: [Session]?
    /// Sessions known to be leaving Open because somebody FILED them (completed / trashed), rather
    /// than because a run finished. Filing drops the row from Open, which the snapshot diff would
    /// otherwise read as the run finishing and announce with a "Session finished" banner — reporting
    /// the user's own action back to them, and on this device landing on top of the action's own
    /// toast so one tap arrived twice. Two ways in:
    ///   • a row action here, marked BEFORE the request since the filing's own control event can
    ///     bring a snapshot in while it is still in flight (purge needs no entry — it only acts on
    ///     trashed rows, which the Open snapshot never held);
    ///   • a `session.ended` event whose reason isn't `task_done` (see `apply`), which is how a
    ///     completion on web or another client stays quiet here.
    /// Entries are released in `applySessionSnapshot` the moment a snapshot without the row lands:
    /// from then on the row isn't in `lastSnapshot` either, so no later diff can announce it.
    private var filedSessions: Set<String> = []
    /// The last badge string written to the OS (dock tile / app icon). Both writes cross a process
    /// boundary, so an unchanged snapshot skips them — `didWriteBadge` keeps the FIRST snapshot after
    /// launch/sign-in writing even when it matches the initial value, since a badge set by a silent
    /// push while the app was backgrounded has to be reconciled down. See docs/cross-platform-badge-sync.md.
    private var lastBadge: String?
    private var didWriteBadge = false
    /// iOS: the "needs you" id set the delivered-notification reconcile last ran for. nil until the
    /// first snapshot, so it always runs once; after that only a genuine change pays the round-trip.
    private var lastNeedsYou: Set<String>?
    /// The always-on control-plane stream (GET /api/events) and whether it's currently live.
    /// While live it owns list *latency*: a status / approval event updates its row in place the
    /// moment it lands (see `apply`), and the events it can't apply that way trigger a coalesced
    /// snapshot refresh. It does NOT own list *completeness* — the slim event payload carries no
    /// preview line, tag, pin or background count — so the 4s tick keeps fetching underneath it as
    /// the floor for those fields, and as the fallback for any gap (reconnect backoff, an older
    /// server without the endpoint). See `runControlPlane` / `startPolling`.
    private var controlTask: Task<Void, Never>?
    private(set) var controlPlaneLive = false
    private var controlRefreshScheduled = false
    /// Dedup exact refreshes when a control nudge and the fallback poll land together.
    private var sessionDetailRefreshes: Set<String> = []
    /// Same coalescing, for the owner-level lists a control event can dirty (see apply / LibraryTarget).
    private var libraryRefreshScheduled = false
    private var pendingLibraryRefresh: Set<LibraryTarget> = []

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
        apiGeneration &+= 1
        sessionDetails.removeAll()
        baseURL = url
        api = APIClient(baseURL: url, tokenStore: tokenStore)
        tasks = TasksModel(baseURL: url, tokenStore: tokenStore)
        agents = AgentsModel(baseURL: url, tokenStore: tokenStore)
        runners = RunnersModel(baseURL: url, tokenStore: tokenStore)
        admin = AdminModel(baseURL: url, tokenStore: tokenStore)
        consoleRegistry = ConsoleRegistry(baseURL: url, tokenStore: tokenStore,
                                          store: ConsoleRegistry.defaultStore(for: url))
        // A console's fleeting confirmations ("Merged into main", "Committed changes") ride the app's
        // one toast host, not the status line above the composer — see `showToast`.
        consoleRegistry?.onToast = { [weak self] request, sessionID in
            self?.showToast(request.message, sessionID: sessionID,
                            detail: request.detail, tone: request.tone)
        }
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
        apiGeneration &+= 1
        pollTask?.cancel()
        pollTask = nil
        controlTask?.cancel()
        controlTask = nil
        controlPlaneLive = false
        consoleRegistry?.reset()   // persist open transcripts, drop the warm cache
        // Best-effort server-side revoke of the refresh token before we drop it locally. Capture the
        // token by value and hand it to the async call so clearing the store below can't race the read.
        if let baseURL, let api, let refreshToken = tokenStore.refreshToken(for: baseURL) {
            Task { await api.revokeRefreshToken(refreshToken) }
        }
        if let baseURL {
            tokenStore.setToken(nil, for: baseURL)
            tokenStore.setRefreshToken(nil, for: baseURL)
        }
        signedIn = false
        sessions = []
        recentSessions = []
        sessionDetails.removeAll()
        resetNavigation()
        lastSnapshot = nil
        menuSummary = .empty
        updateDockBadge(nil)
        // Clear the write-skip trackers so the next sign-in's first snapshot always reconciles the
        // badge and delivered notifications, whatever the previous account left behind.
        lastBadge = nil
        didWriteBadge = false
        lastNeedsYou = nil
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

    /// Keep Open fresh. The control-plane stream (below) is the primary source of *latency* — a
    /// status or approval change lands on its row the moment the event arrives — but its payload is
    /// a slim summary, so the fields only the list query returns (the preview line, tags, pin,
    /// background count) still need a periodic snapshot. This tick is that floor, and it runs
    /// whether or not the stream is live.
    ///
    /// It used to skip its fetch while the stream was connected, which made those fields ride on
    /// event-driven refreshes instead — and because EVERY event triggered a full refetch, several
    /// sessions running at once pinned the app to one whole-list fetch + re-render every 200ms.
    /// Events now upsert their row in place (see `apply`), leaving this 4s tick as the only
    /// unconditional whole-list fetch.
    ///
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
                if let self { await self.loadSessions() }
                if let self {
                    // The control stream has no purge event, and a Completed / Trash cold route is
                    // absent from Open by definition. Refresh only that one focused fallback so a
                    // remote lifecycle change or permanent deletion cannot leave a ghost console.
                    await self.refreshFocusedSessionDetailIfNeeded()
                    self.consoleRegistry?.flush(self.focusedConsoleSessionID)
                }
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
                        await refreshFocusedSessionDetailIfNeeded()
                        // No replay on this stream, so reconcile the lists that only push can
                        // keep fresh (they have no poll at all) alongside the session snapshot.
                        scheduleLibraryRefresh(.agents)
                        scheduleLibraryRefresh(.tasks)
                    case .event(let ev):
                        apply(ev)
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

    /// Route one control event to the cheapest thing that makes it visible.
    ///
    /// Originally every event — whatever it was about — nudged a full `GET /sessions` refresh. That
    /// cost scales with how much is happening at once, so a handful of sessions running together
    /// held the app at one whole-list fetch, decode and re-render per coalescing window, and an
    /// agent filing a burst of tasks dragged the session list through it too.
    ///
    /// Two rules fix that. Library events only reload the model that owns them (mirroring web's
    /// `groupsFor`), because nothing else does — the agent list, notably, was otherwise fetched once
    /// at launch, so an agent created elsewhere (a teammate's browser, an MCP `agent_create`) never
    /// showed up until the app was relaunched. And the two high-volume session families carry the
    /// authoritative row state in their payload, so they're applied in place — this is the
    /// field-level upsert `ControlSessionSummary` was shaped for (decision Q2). Anything else still
    /// nudges the snapshot: either a row is leaving Open, or the field that changed isn't on the
    /// event. The 4s tick in `startPolling` remains the floor for those slim-payload gaps.
    private func apply(_ ev: ControlEvent) {
        switch ev.type {
        // Task/task-list nudges belong to the task models alone — they change no session row.
        case .taskChanged, .taskListChanged:
            scheduleLibraryRefresh(.tasks)
        // An agent rename changes what session rows render, so the list follows here too (as web
        // does). Providers ride along: AgentsModel.load() fetches the provider catalog with the list.
        case .agentChanged, .providerChanged:
            scheduleLibraryRefresh(.agents)
            scheduleControlRefresh()
        case .sessionCreated, .sessionUpdated:
            if let summary = ev.payload(ControlSessionSummary.self),
               mergeSessionSummary(summary) { return }
            scheduleControlRefresh()
        case .approvalRequested, .approvalResolved:
            if let approval = ev.payload(ControlApproval.self),
               mergePendingApprovals(sessionID: ev.sessionId, pending: approval.pendingApprovals) {
                return
            }
            scheduleControlRefresh()
        // The row is leaving Open, and this event carries the one field that says why. Membership
        // still decides the list, so the refresh runs either way — but a departure the server
        // attributes to a hand filing is marked first, so the snapshot it brings back doesn't read
        // the row's absence as a run finishing (`SessionDelta.announcesFinish`). Without this, a
        // session completed in a browser announced itself as finished on every other client.
        case .sessionEnded:
            if !SessionDelta.announcesFinish(endReason: ev.payload(ControlSessionEnded.self)?.endReason) {
                filedSessions.insert(ev.sessionId)
            }
            scheduleControlRefresh()
        // session.error / background.task (fields the payload doesn't carry), tag.changed, and
        // anything a newer server adds.
        default:
            scheduleControlRefresh()
        }
    }

    /// Fold a `session.created` / `session.updated` summary into the row already on hand. Returns
    /// false when only the list query can answer the change, and the caller should nudge a refresh:
    ///   • the session left Open — the row has to disappear, which membership alone decides;
    ///   • the row isn't loaded — a session created elsewhere can't be built from the slim summary
    ///     (no preview line, tags, runner or background count), and prepending a half-populated row
    ///     would render worse than the ~½s wait for the real snapshot.
    private func mergeSessionSummary(_ summary: ControlSessionSummary) -> Bool {
        if let lifecycle = summary.effectiveLifecycleState, lifecycle != .open { return false }
        guard let index = sessions.firstIndex(where: { $0.id == summary.id }) else { return false }
        let merged = sessions[index].applying(summary)
        guard merged != sessions[index] else { return true }   // nothing user-visible changed
        var list = sessions
        list[index] = merged
        applySessionSnapshot(list)
        return true
    }

    /// Same, for `approval.requested` / `approval.resolved` — the event carries the authoritative
    /// pending count, which is all a row needs to switch between the spinner and the amber
    /// needs-you cue (and to move the badge). False when the row isn't loaded.
    private func mergePendingApprovals(sessionID: String, pending: Int) -> Bool {
        guard let index = sessions.firstIndex(where: { $0.id == sessionID }) else { return false }
        guard sessions[index].pendingApprovals != pending else { return true }
        var list = sessions
        list[index] = list[index].settingPendingApprovals(pending)
        applySessionSnapshot(list)
        return true
    }

    /// The owner-level lists a control event can dirty, each backed by its own model.
    enum LibraryTarget { case agents, tasks }

    /// Coalesce library reloads the same way `scheduleControlRefresh` coalesces list refreshes —
    /// an agent filing five tasks in a row should cost one reload, not five.
    private func scheduleLibraryRefresh(_ target: LibraryTarget) {
        pendingLibraryRefresh.insert(target)
        guard !libraryRefreshScheduled else { return }
        libraryRefreshScheduled = true
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 200_000_000)
            guard let self else { return }
            self.libraryRefreshScheduled = false
            let targets = self.pendingLibraryRefresh
            self.pendingLibraryRefresh.removeAll()
            if targets.contains(.agents) { await self.agents?.load() }
            if targets.contains(.tasks) {
                await self.tasks?.refresh(selectedTaskID: self.selectedTaskID)
            }
        }
    }

    /// Coalesce event-driven refreshes: a burst of control events (a turn ending fires STATUS +
    /// TURN_END back-to-back) folds into one list fetch. Only events `apply` can't upsert in place
    /// reach here, and this is a whole-list fetch + re-render, so the window matches web's 500ms
    /// rather than the old 200ms — with several sessions running, that alone was up to five
    /// full refreshes a second.
    private func scheduleControlRefresh() {
        guard !controlRefreshScheduled else { return }
        controlRefreshScheduled = true
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard let self else { return }
            self.controlRefreshScheduled = false
            await self.loadSessions()
            // A missing Open row is ambiguous: it may be the same stable Completed detail, or a
            // cross-client Complete / Trash / purge transition. Resolve the focused cached row
            // exactly after the control-driven snapshot rather than trusting absence as state.
            await self.refreshFocusedSessionDetailIfNeeded()
        }
    }

    /// Refresh the one exact-detail fallback currently driving a console. Loaded list rows remain
    /// the primary snapshot and need no extra request. Stable cold Completed / Trash consoles cost
    /// at most one bounded GET per poll tick; control events refresh them immediately. A 404 is an
    /// authoritative remote purge, so remove the fallback and close its now-nonexistent console.
    private func refreshFocusedSessionDetailIfNeeded() async {
        guard let id = focusedConsoleSessionID,
              let api,
              sessionDetails.needsExactRefresh(
                id,
                preferring: sessions,
                agents?.agentSessions ?? []
              ),
              sessionDetailRefreshes.insert(id).inserted else { return }
        let generation = apiGeneration
        defer { sessionDetailRefreshes.remove(id) }

        do {
            let resolved = try await api.session(id)
            // An instance switch can complete while the old request is in flight. Never feed that
            // response into the newly configured instance's cache or console registry.
            guard apiGeneration == generation, self.api === api else { return }
            sessionDetails.store(resolved)
            consoleRegistry?.peek(id)?.adoptServerSnapshot(resolved)
        } catch APIError.http(let status, _) where status == 404 {
            guard apiGeneration == generation, self.api === api else { return }
            discardMissingSession(id)
        } catch APIError.unauthorized {
            guard apiGeneration == generation, self.api === api else { return }
            logout()
        } catch {
            // Transient failure: retain the last authoritative detail and retry on the next tick.
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
        // Every focused console needs an exact-detail fallback, not only cold deep links. If an
        // Open row is filed or purged on another client, the next list refresh removes it; retaining
        // this last loaded snapshot makes `needsExactRefresh` detect that absence and GET the new
        // lifecycle state (or authoritative 404) instead of silently losing all session context.
        if let id,
           let loaded = sessions.first(where: { $0.id == id })
                ?? agents?.agentSessions.first(where: { $0.id == id }) {
            sessionDetails.store(loaded)
        }
        consoleRegistry?.focus(id, agentID: id.flatMap { agentID(for: $0) })
        // The delivery layer needs the same focus the diff uses, for the alerts it doesn't author:
        // a server push about the session on screen shouldn't interrupt it (see `willPresent`).
        notifications.focusedSessionID = id
    }

    func loadSessions() async {
        guard let api else { return }
        do {
            applySessionSnapshot(try await api.listSessions(view: .open))
        } catch APIError.unauthorized {
            logout()
        } catch {
            // Transient — keep the last good list.
        }
    }

    /// Adopt a new Open snapshot: the ONE place the list and everything derived from it are written,
    /// so a fetched snapshot and an event-driven in-place upsert can never disagree about row shape,
    /// grouping, badges or which transitions were notified. Everything here is deliberately cheap
    /// enough to run on an event, which is what lets `apply` skip the fetch.
    ///
    /// `notify: false` is for a snapshot whose transitions the caller already accounted for (a local
    /// purge), where the diff would otherwise post a bogus "finished" alert.
    private func applySessionSnapshot(_ list: [Session], notify: Bool = true) {
        // Notify on snapshot-to-snapshot transitions (skip the first load, which only primes). Skip
        // the session whose console is on screen — its own stream already shows the change.
        if notify, let prev = lastSnapshot {
            for event in SessionDelta.diff(previous: prev, current: list,
                                           focusedSessionID: focusedConsoleSessionID,
                                           filed: filedSessions) {
                #if os(iOS)
                // The server already pushes approvals to this device over APNs, in every app state
                // (PushService.notifyApprovalRequest) — posting the diff's banner too would alert
                // twice for one approval. macOS has no APNs path, so it keeps announcing them here.
                if case .needsApproval = event { continue }
                #endif
                notifications.post(Notifications.content(for: event))
            }
        }
        // A filing has done its silencing once a snapshot without the row lands: `lastSnapshot` no
        // longer holds it either, so nothing later can read its absence as a finish. Releasing here
        // (rather than only where the mark was made) is what keeps the set from growing on filings
        // that arrive as events, which have no completion of their own to clean up after.
        if !filedSessions.isEmpty {
            let present = Set(list.map(\.id))
            filedSessions.formIntersection(present)
        }
        lastSnapshot = list
        // Only cached cold-route records are reconciled; the Open list itself remains the
        // primary store. If that row later leaves a loaded scope, its fallback is still the
        // newest lifecycle/capability snapshot we observed rather than the original fetch.
        sessionDetails.reconcile(with: list)
        // Observation invalidates observers on assignment, equal value or not, and these three
        // drive the drawer + every session list — so an identical snapshot (most 4s ticks of an idle
        // app) must not write them at all. The field-wise compare is far cheaper than the re-render
        // it avoids. The badge / notification reconciles below deliberately stay outside this gate:
        // they have their own first-run rules, and a launch whose first snapshot happens to match
        // still has to reconcile whatever a silent push left on the icon.
        if list != sessions {
            sessions = list
            recentSessions = RecentsLogic.recent(list, limit: list.count)
            // The agent pane's Open list is this same snapshot narrowed to one agent, so hand it over
            // here instead of leaving it to fetch the identical payload on its own timer.
            agents?.applyOpenSnapshot(list)
        }
        let summary = MenuBar.summary(from: list)
        if summary != menuSummary { menuSummary = summary }
        if !didWriteBadge || lastBadge != summary.badge {
            didWriteBadge = true
            lastBadge = summary.badge
            updateDockBadge(summary.badge)
        }
        #if os(iOS)
        // Foreground reconcile: drop delivered approval banners for sessions that no longer need
        // a reply (e.g. handled on web/macOS), so Notification Center matches the badge — and to
        // cover the case a silent push couldn't (a force-quit app). See docs/cross-platform-badge-sync.md.
        // Gated on the id set actually changing: this is a cross-process round-trip, and most
        // snapshots (a turn ticking along) don't move it at all.
        let needsYou = Set(SessionGrouping.group(list).needsYou.map(\.id))
        if needsYou != lastNeedsYou {
            lastNeedsYou = needsYou
            NotificationManager.removeDeliveredApprovals(where: { !needsYou.contains($0) })
        }
        #endif
    }

    /// The agent a session runs as, for scoping the composer's `/` autocomplete. Cold Completed /
    /// Trash routes resolve through the exact-detail cache as well as the loaded lists.
    func agentID(for sessionID: String) -> String? {
        guard let s = session(id: sessionID) else { return nil }
        return s.agent?.id ?? s.agentId
    }

    // MARK: session search (⌘K)

    /// Drives the ⌘K palette's sheet. Held here rather than in the view so the menu command (macOS)
    /// and the toolbar button (iOS) open the same one from outside its own view tree.
    var searchOpen = false

    /// Cross-scope session search — every agent, runner and lifecycle scope at once, plus
    /// conversation text. An empty `q` is a real request, answered with recents, which is what
    /// makes ⌘K a session switcher too. Returns nil on any failure; the palette shows "no results"
    /// rather than an error, since it's a transient overlay the user can just retype into.
    func searchSessions(_ q: String) async -> SessionSearchResponse? {
        guard let api else { return nil }
        return try? await api.searchSessions(q: q)
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
        registerCreatedAgentSession(session)
        composingAgentSession = false
        selectedAgentSessionID = session.id
    }

    /// Seed every Native session store for a freshly created record. The compact compose page keeps
    /// its console in place instead of selecting it, but still needs the detail fallback so a later
    /// cross-client lifecycle change / purge can be refreshed and evicted authoritatively.
    ///
    /// The Open snapshot is seeded too — it's the source the drawer's Recents and the agent pane's
    /// list are derived from, so a row missing here is a row those two would drop again the next
    /// time any event applied a snapshot (the iPhone "Select a session" bounce `registerCreatedSession`
    /// exists to prevent). `notify: false`: nothing transitioned, we just learned about a row.
    func registerCreatedAgentSession(_ session: Session) {
        sessionDetails.store(session)
        if !sessions.contains(where: { $0.id == session.id }) {
            applySessionSnapshot([session] + sessions, notify: false)
        }
        agents?.registerCreatedSession(session)
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
    /// the Agents pane pushes its console. The Open list nests the agent, so there's no fetch (unlike
    /// a cold deep link — see `openSession`). A no-op agent switch keeps an already-pushed console; a
    /// real switch clears the prior agent's session/compose state before selecting this session.
    func openRecentSession(_ s: Session) {
        selectedSection = .agents
        if let agentID = s.agent?.id ?? s.agentId, selectedAgentID != agentID {
            selectedAgentID = agentID
        }
        composingAgentSession = false
        // Set BEFORE the selection so its observer preserves the marker (the observer clears it whenever
        // the new selection doesn't match). Flags this as a Recents-opened console so the compact shell
        // frees the left edge for the drawer-open swipe. See `consoleFromRecents`.
        recentsConsoleSessionID = s.id
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

    /// Prefer the server's lifecycle guard when available; a missing capability is an old server and
    /// retains the pre-capability behavior.
    var canCompleteCurrentSession: Bool {
        guard let id = currentSessionID else { return false }
        return session(id: id)?.capabilities?.canComplete ?? true
    }

    /// iOS compact: true when the console currently pushed on the Agents stack was opened from a
    /// **Recents** drawer row (and is still the one showing). The compact shell uses this to free the
    /// left screen edge for the drawer-open swipe on that page — you came from the drawer, so the edge
    /// returns you there — while the nav-bar back button still pops to the agent's session list.
    var consoleFromRecents: Bool {
        selectedSection == .agents
            && !composingAgentSession
            && selectedAgentSessionID != nil
            && selectedAgentSessionID == recentsConsoleSessionID
    }

    /// True when the current section's navigation stack is at its root (nothing pushed) — derived
    /// from the same selection state that drives each stack's push. The compact shell uses this to
    /// yield the left screen edge to its drawer-open gesture only where no pushed page needs the
    /// edge for the system back-swipe.
    var sectionAtRoot: Bool {
        switch selectedSection {
        case .tasks:   return selectedTaskID == nil && !taskListsDirectoryPresented
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

    /// ⌘D: complete the open session. The server ends a live run as part of the same completion
    /// operation, so this is one immediate action for every run state. Clears the selection, then
    /// refreshes Open.
    func completeCurrentSession() {
        guard let id = currentSessionID else { return }
        guard canCompleteCurrentSession else {
            errorText = "This session can't be completed right now."
            return
        }
        performCurrentSessionCompletion(id)
    }

    private func performCurrentSessionCompletion(_ id: String) {
        guard let api else { return }
        guard session(id: id)?.capabilities?.canComplete != false else {
            errorText = "This session can't be completed right now."
            return
        }
        filedSessions.insert(id)
        Task { @MainActor in
            defer { filedSessions.remove(id) }
            do {
                try await api.completeSession(id)
            } catch {
                errorText = "Couldn't complete the session."
                return
            }
            sessionDetails.remove(id)
            dropIfOpen(id)
            await loadSessions()
        }
    }

    /// Clear a session out of the pane that has it open (the agent console selection), so a
    /// completed/trashed session can't linger in the detail view. Used by ⌘D and row actions.
    private func dropIfOpen(_ id: String) {
        if selectedAgentSessionID == id { selectedAgentSessionID = nil }
        if recentsConsoleSessionID == id { recentsConsoleSessionID = nil }
        if composedConsoleSessionID == id {
            composedConsoleSessionID = nil
            // The compact compose page owns its created console in local view state. Dismissing
            // that page is the only way to ensure a remotely purged session is not still rendered.
            composingAgentSession = false
        }
    }

    /// Remove every local fallback for an authoritative detail 404, then close the ghost console.
    private func discardMissingSession(_ id: String) {
        sessionDetails.invalidateNotFound(id)
        agents?.discardSession(id)
        // `notify: false` — a purge is not a run finishing, and the diff would otherwise read the
        // row's disappearance as one. Going through the snapshot path from here is what keeps Recents,
        // the agent list and the badge in step with the removal.
        applySessionSnapshot(SessionFilter.removing(id, from: sessions), notify: false)
        consoleRegistry?.discardMissing(id)
        dropIfOpen(id)
    }

    // MARK: session row actions (shared by the menu-bar quick items + the agent session lists)

    /// A session result floated by the app's single toast host (see `toastHost()`) — the native
    /// port of web's `sessionNotice` card: outcome first, the session it happened in second, an
    /// optional diagnostic third. `sessionID` is that session, so the card doubles as the way into
    /// it; `canUndo` marks the action reversible and adds the inline Undo button, where moving to
    /// Open is the universal undo — the server's `restore` clears both completion and trash state.
    struct Toast: Identifiable, Equatable {
        let id = UUID()
        let message: String
        var sessionTitle: String?
        var detail: String?
        var tone: ToastTone = .success
        /// SF Symbol overriding the tone's default — web passes an `icon` the same way, so a
        /// neutral outcome can still say what it was ("Moved to Trash" gets a trash can).
        var icon: String?
        var sessionID: String?
        var canUndo = false
    }
    var toast: Toast?
    private var toastDismiss: Task<Void, Never>?

    /// Refresh whichever session lists are on screen (Open always; the agent list if
    /// one has been opened) so a row action reflects immediately instead of waiting for the poll.
    private func reloadSessionLists() async {
        await loadSessions()
        await agents?.reloadCurrentSessions()
        sessionDetails.reconcile(with: agents?.agentSessions ?? [])
    }

    /// Float a session result as a toast. One dwell time for every card — web settled on 6s for the
    /// whole surface (see `lib/toast.tsx`'s `sessionNotice`), and the ramp keys on what the toast
    /// asks of you rather than on which client renders it: 4s for a one-line confirmation, 6s once
    /// there's a session name, a diagnostic or an Undo to take in, and a warning/error doesn't leave
    /// on a timer at all (see `ToastTone.isPersistent`). Console-side outcomes arrive here too (see
    /// `ConsoleRegistry.onToast`).
    ///
    /// `sessionTitle` is for a result whose session has already left every loaded scope by the time
    /// the card is built — completing one drops it from Open, so the name has to be taken before the
    /// mutation or the line just disappears. Everything else lets it resolve here.
    func showToast(_ message: String, sessionID: String? = nil, sessionTitle: String? = nil,
                   detail: String? = nil, tone: ToastTone = .success, icon: String? = nil,
                   canUndo: Bool = false) {
        let title = sessionTitle ?? sessionID.flatMap(toastSessionTitle)
        toast = Toast(message: message, sessionTitle: title,
                      detail: detail, tone: tone, icon: icon,
                      sessionID: sessionID, canUndo: canUndo)
        toastDismiss?.cancel()
        guard !tone.isPersistent else { return }
        let isCard = title != nil || detail != nil || canUndo
        let seconds: UInt64 = isCard ? 6 : 4
        toastDismiss = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: seconds * 1_000_000_000)
            guard !Task.isCancelled else { return }
            self?.toast = nil
        }
    }

    /// The session's name for the card's second line. First line only — a title carrying the whole
    /// first prompt would otherwise push the card down the screen (web's `titleFirstLine`). Nil when
    /// the session isn't in any loaded scope, which just drops the line rather than guessing.
    private func toastSessionTitle(_ id: String) -> String? {
        guard let title = session(id: id)?.title else { return nil }
        let firstLine = title.split(separator: "\n").first.map(String.init) ?? title
        let trimmed = firstLine.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty ? nil : trimmed
    }

    func dismissToast() { toastDismiss?.cancel(); toast = nil }

    /// The server's own words for the card's diagnostic line, when it sent any — web shows
    /// `e.message` the same way. Falls back to nothing rather than to a restatement of the headline.
    private static func toastDetail(_ error: Error) -> String? {
        if case APIError.unauthorized = error { return "Session expired — sign in again." }
        guard case APIError.http(_, let body) = error else { return nil }
        let trimmed = body?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    /// Tapping the toast opens the session it reports on — a result you just acted on is usually the
    /// one you want to look at next, and without this the only way back was to find the row by hand.
    /// The card has done its job once it's been followed, so it goes with the navigation.
    func openToastSession() {
        guard let sessionID = toast?.sessionID else { return }
        dismissToast()
        route(to: .session(sessionID))
    }

    /// Complete a session, drop it from any open pane and offer Undo.
    func completeSession(_ id: String) {
        guard let api else { return }
        guard session(id: id)?.capabilities?.canComplete != false else {
            errorText = "This session can't be completed right now."
            return
        }
        let name = toastSessionTitle(id)
        filedSessions.insert(id)
        Task { @MainActor in
            defer { filedSessions.remove(id) }
            do { try await api.completeSession(id) }
            catch {
                showToast("Could not complete session", sessionID: id, sessionTitle: name,
                          detail: Self.toastDetail(error), tone: .error)
                return
            }
            sessionDetails.remove(id)
            dropIfOpen(id)
            await reloadSessionLists()
            showToast("Session completed", sessionID: id, sessionTitle: name, canUndo: true)
        }
    }

    /// Move a completed/trashed session back to Open (also the Undo target).
    func moveSessionToOpen(_ id: String) {
        guard let api else { return }
        guard session(id: id)?.capabilities?.canRestore != false else {
            errorText = "This session can't be moved to Open right now."
            return
        }
        let name = toastSessionTitle(id)
        Task { @MainActor in
            do { try await api.restoreSession(id) }
            catch {
                showToast("Could not move to Open", sessionID: id, sessionTitle: name,
                          detail: Self.toastDetail(error), tone: .error)
                return
            }
            sessionDetails.remove(id)
            await reloadSessionLists()
            showToast("Moved to Open", sessionID: id, sessionTitle: name, tone: .info)
        }
    }

    /// Soft-delete a session to the trash — reversible via Undo (or the Trash view).
    func deleteSession(_ id: String) {
        guard let api else { return }
        let name = toastSessionTitle(id)
        filedSessions.insert(id)
        Task { @MainActor in
            defer { filedSessions.remove(id) }
            do { try await api.deleteSession(id) }
            catch {
                showToast("Could not move to Trash", sessionID: id, sessionTitle: name,
                          detail: Self.toastDetail(error), tone: .error)
                return
            }
            sessionDetails.remove(id)
            dropIfOpen(id)
            await reloadSessionLists()
            showToast("Moved to Trash", sessionID: id, sessionTitle: name,
                      tone: .neutral, icon: "trash", canUndo: true)
        }
    }

    /// Permanently delete a trashed session and all its data — irreversible, so there's no Undo (the
    /// Trash row action gates it behind a confirmation). Mirrors web's `purgeMut`.
    func purgeSession(_ id: String) {
        guard let api else { return }
        Task { @MainActor in
            do { try await api.purgeSession(id) }
            catch { errorText = "Couldn't delete the session permanently."; return }
            discardMissingSession(id)
            await reloadSessionLists()
        }
    }

    /// Rename a session's display title — web parity with the console header's inline rename.
    /// No capability gate: the server treats this as pure metadata and allows it in any status
    /// (dormant, completed, trashed), with no runner reload behind it. A blank or unchanged title is
    /// the same no-op as web's editor closing on an empty field.
    ///
    /// The new name is written into the loaded snapshots first so the header and the row change on
    /// the spot; the reload settles the authoritative value either way, which is also what reverts
    /// the optimistic patch when the server rejects the rename.
    func renameSession(_ id: String, title rawTitle: String) {
        guard let api else { return }
        let title = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, title != session(id: id)?.title else { return }
        patchSessionTitle(id, to: title)
        Task { @MainActor in
            do { try await api.renameSession(id, title: title) }
            catch {
                showToast("Could not rename session", sessionID: id,
                          detail: Self.toastDetail(error), tone: .error)
            }
            await reloadSessionLists()
        }
    }

    /// Write a title into every loaded copy of a row: the cross-agent Open snapshot (which also feeds
    /// the agent pane and Recents), the agent pane's own Completed / Trash list — those rows are not
    /// in the Open snapshot — and the cold-route detail cache the console header falls back to.
    private func patchSessionTitle(_ id: String, to title: String) {
        if let index = sessions.firstIndex(where: { $0.id == id }) {
            var list = sessions
            list[index] = list[index].settingTitle(title)
            applySessionSnapshot(list)
        }
        if let cached = sessionDetails.resolve(id) { sessionDetails.store(cached.settingTitle(title)) }
        agents?.applyRenamedSession(id, title: title)
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
        guard let toast, toast.canUndo, let sessionID = toast.sessionID else { return }
        moveSessionToOpen(sessionID)
        dismissToast()
    }

    // MARK: routing + notification intents

    func route(to route: Route) {
        selectedSection = AppSection.forRoute(route)
        switch route {
        case .active:          if selectedAgentID == nil { selectedAgentID = orderedAgents.first?.id }
        case .session(let id): openSession(id)
        case .task(let id):
            // A deep link or dependency jump may target a task outside the currently selected
            // named list. Aggregate scope guarantees the row and detail can resolve together.
            taskListsDirectoryPresented = false
            tasks?.selectScope(.all)
            tasks?.filter = .all
            tasks?.searchText = ""
            selectedTaskID = id
        case .runner(let id):  selectedRunnerID = id
        }
    }

    /// Open a session's console. There's no standalone session view anymore, so route into its
    /// owning agent's console (the section is already `.agents`, set by `route`). Resolve the agent
    /// from loaded state, then refresh an out-of-Open route with the exact session record. Showing
    /// the id right away lets the console paint while the agent + lifecycle context resolve in the
    /// background; retaining that response is what lets Completed / Trash headers and composers
    /// render correctly on a cold launch.
    private func openSession(_ id: String) {
        composingAgentSession = false
        selectedAgentSessionID = id
        if let aid = agentID(for: id) {
            selectedAgentID = aid
        }
        // The Open snapshot is already control-plane refreshed. Everything else (including an old
        // detail-cache hit) gets an exact refresh so repeated search/deep-link navigation cannot
        // resurrect stale lifecycle or capability state.
        guard !sessions.contains(where: { $0.id == id }), let api else { return }
        // Capture this instance synchronously. Reading `self.api` only after the Task starts could
        // send an old route's id to a newly configured instance before the identity guard exists.
        let generation = apiGeneration
        Task { @MainActor [weak self, api] in
            guard let self else { return }
            do {
                let resolved = try await api.session(id)
                // Logout / instance switch can finish while this cold lookup is in flight.
                guard self.apiGeneration == generation, self.api === api else { return }
                self.sessionDetails.store(resolved)
                // Feed an already-hydrated console immediately too; ComposerView observes the
                // same cache, while this closes the race where its initial observation ran first.
                self.consoleRegistry?.peek(id)?.adoptServerSnapshot(resolved)
                guard self.selectedSection == .agents,
                      self.selectedAgentSessionID == id else { return } // stale navigation resolve
                self.selectedAgentID = resolved.agent?.id ?? resolved.agentId
            } catch APIError.http(let status, _) where status == 404 {
                guard self.apiGeneration == generation, self.api === api else { return }
                self.discardMissingSession(id)
            } catch APIError.unauthorized {
                guard self.apiGeneration == generation, self.api === api else { return }
                self.logout()
            } catch {
                // Keep any prior cached detail on a transient failure; the focused poll retries.
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
