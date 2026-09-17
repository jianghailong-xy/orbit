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
    // Top-level nav: which AppShell section is showing, and every section's navigation stack. The
    // app lands on the Agents section (the first agent's session list); the agent is selected once
    // the list loads — see `loadAgentsThenLand`.
    //
    // `nav` is the ONE copy of the navigation state. The compact shell binds its
    // `NavigationStack(path:)` to the current section's stack, the three-column shells bind their
    // `List(selection:)` to a projection of it, and every fact either of them needs — the
    // highlighted row, what fills the detail pane, which session streams, whether the section is at
    // its root, where the left screen edge goes — is a read of that stack (see OrbitKit
    // `NavState`). Nothing below keeps a second copy of any of them.
    var nav = NavState()
    var selectedSection: AppSection {
        get { nav.section }
        set {
            nav.section = newValue
            // Switching sections tears down the other sections' *views* (the compact shell renders
            // one at a time), but not their navigation: each section keeps its own stack, so coming
            // back lands where you left instead of at the root. Nothing is dropped here — this
            // setter writes which section is showing and nothing else, and no push has to be
            // registered with it by hand.
            tasks?.setSectionActive(newValue == .tasks)   // the data layer's poll, not navigation
        }
    }
    /// Latches the one-shot default-landing resolution so it runs only after the first successful
    /// agent-list load, and never overrides a later user/deep-link choice.
    private var didResolveDefaultLanding = false
    /// Which Settings category the detail column renders on a regular-width iPad. Deliberately not
    /// a navigation frame: the categories are that section's middle-column *content*, the way
    /// sessions are the Agents column's content — `settingsRunners` is the push, and it stays one.
    /// The single-column shells render the whole form and never read this.
    var settingsCategory: SettingsCategory = .account
    /// The task whose detail fills the pane — and, in the three-column shell, the row drawn as
    /// selected. Kept under its old name so its readers (the pane, the deep-link route, the
    /// delete/404 guards, the scope switch) needed no change, with the difference that it is read
    /// off the Tasks stack: the pushed page *is* the selection, so a task deleted under the viewer
    /// takes its own page with it instead of leaving a spinner under a non-nil selection.
    /// Writable because that is what the three-column shells' `List(selection:)` writes.
    var selectedTaskID: String? {
        get { nav.taskDetailOnTop }
        set {
            // Selecting in a three-column shell replaces the page the detail pane shows; clearing
            // pops the task page that is there — never the directory beneath it.
            if let id = newValue {
                nav.replaceTop(with: .taskDetail(taskID: id))
            } else if case .taskDetail = nav.path.last {
                nav.pop()
            }
            syncTaskDetailStore()
        }
    }
    /// The Tasks stack, as the compact shell binds it.
    ///
    /// A row's own `NavigationLink` and the back button move this stack *inside* SwiftUI, so those
    /// pushes and pops arrive here rather than through ``selectedTaskID`` — and the detail store
    /// follows them in the same write. A turn later would be too late: the pushed page reads the
    /// store the moment it appears (`TasksModel.loadDetail` refuses a task that isn't the selected
    /// one), so a late sync is a detail page stuck on its spinner.
    var taskStack: [NavNode] {
        get { nav.path }
        set {
            nav.path = newValue
            syncTaskDetailStore()
        }
    }
    /// Follow the stack's task page into the model that serves it. The store is a single slot —
    /// what a background refresh re-reads, and whose 404 is how a task deleted under the viewer
    /// closes — so it has to name the page on screen and nothing else.
    private func syncTaskDetailStore() {
        tasks?.setSelectedDetailID(selectedTaskID)
    }
    /// The runner whose record fills the Runners pane — the row the three-column list draws as
    /// selected, and the page the compact stack pushes. A read of the section's stack, kept under
    /// its old name so its readers needed no change.
    var selectedRunnerID: String? {
        get { nav.selectedRunnerID }
        set {
            // Selecting in a three-column shell replaces the page the detail pane shows; clearing
            // pops the record that is there.
            if let id = newValue {
                nav.replaceTop(with: .runnerDetail(runnerID: id))
            } else if case .runnerDetail = nav.path.last {
                nav.pop()
            }
        }
    }
    /// The watch whose record fills Following's detail: a public id, or the UUID a push names until
    /// ``openWatch`` replaces it with the list's spelling (see there). The same projection as the
    /// runner's, onto Following's own stack.
    var selectedWatchID: String? {
        get { nav.selectedWatchID }
        set {
            if let id = newValue {
                nav.replaceTop(with: .watchDetail(watchID: id))
            } else if case .watchDetail = nav.path.last {
                nav.pop()
            }
        }
    }
    /// iOS only: whether Tasks has pushed the searchable directory of every named task list.
    /// The drawer shows only a compact preview; the directory is the second page this section
    /// pushes, and pushing it is what leaves the leading edge to the system back-swipe while it is
    /// visible (`sectionAtRoot` reads the stack, not this). Kept under its old name because that is
    /// what its callers write — the drawer row that opens it, and the list pick that closes it.
    var taskListsDirectoryPresented: Bool {
        get { nav.taskListsDirectoryOnTop }
        set {
            if newValue {
                nav.push(.taskListsDirectory)
            } else if case .taskListsDirectory = nav.path.last {
                nav.pop()
            }
            syncTaskDetailStore()
        }
    }
    /// Written through to `lastAgentKey` on every non-nil set so the launch default can restore your
    /// last agent (see `loadAgentsThenLand`); a nil (navigation reset) must not erase the memory.
    var selectedAgentID: String? {
        didSet {
            if let id = selectedAgentID { UserDefaults.standard.set(id, forKey: Self.lastAgentKey) }
        }
    }
    /// The agent session whose console fills the detail pane — the row drawn as selected, the
    /// console pushed on the Agents stack, and the session that streams, all in one read. Kept under
    /// its old name so its readers (the needs-you banner's exclusion, ⌘D's target, the cold-route
    /// stale guard) needed no change, with the difference that it can no longer disagree with what is
    /// on screen. Writable because that is what the three-column shells' `List(selection:)` writes.
    var selectedAgentSessionID: String? {
        get { nav.focusedConsoleSessionID }
        set {
            // Selecting in a three-column shell replaces the page the detail pane shows; clearing
            // pops the console that is there — never a draft or a deeper frame.
            if let id = newValue {
                nav.replaceTop(with: .console(sessionID: id, origin: .list))
            } else if case .console = nav.path.last {
                nav.pop()
            }
        }
    }
    /// True while a new-session draft is showing on the Agents stack: the three-column detail pane
    /// renders it inline, the compact shell pushes it (`NewSessionView` either way). A read of the
    /// stack like every other fact here — the draft is a frame, not a flag beside one. Cleared once a
    /// session is selected, created, or the agent changes.
    var composingAgentSession: Bool {
        if case .compose = nav.path.last { return true }
        return false
    }
    /// The account whose record fills the Admin pane. Compact had nowhere to put this: the section
    /// was a bare `NavigationStack` with no detail column and no push, so a selected user went
    /// nowhere and `sectionAtRoot` had to claim the section was always at its root. The record is a
    /// page of the section's stack now, so the shell can push it and the edge follows.
    var selectedUserID: String? {
        get { nav.selectedUserID }
        set {
            if let id = newValue {
                nav.replaceTop(with: .userDetail(userID: id))
            } else if case .userDetail = nav.path.last {
                nav.pop()
            }
        }
    }
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

    /// The Open sessions blocked on an approval, and agentID → how many of them each agent holds —
    /// what the "needs you" banner and the drawer's per-agent badge read. Derived from the same
    /// applied snapshot as `recentSessions`, and for the same reason: the drawer stays mounted behind
    /// the content card and re-reads its rows on every body pass, so a computed property would
    /// re-scan the whole Open list once per row per pass. `needsYouSessions` holds whole records (not
    /// ids) because the banner needs the target's agent name and id to navigate; it is the handful of
    /// blocked rows, not the list.
    private(set) var needsYouSessions: [Session] = []
    private(set) var agentNeedsYou: [String: Int] = [:]
    #if os(iOS)
    /// Workspace ids with at least one Session that draws the shared running spinner. Cached beside
    /// `agentNeedsYou` so the iPhone drawer and iPad sidebar never rescan Open once per row/render.
    private(set) var runningWorkspaceIDs: Set<String> = []
    #endif

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
    #if os(iOS)
    /// The 4s Open loop also keeps the Workspace navigation's Runner state fresh, but Runner
    /// heartbeats do not need that cadence. This gate yields an approximately 16s refresh on the
    /// existing tick (15s minimum) without starting another long-lived task.
    private var runnerSnapshotRefreshNotBefore = Date.distantPast
    private static let runnerSnapshotRefreshInterval: TimeInterval = 15
    #endif
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
    private var controlRefreshPending = false
    private var controlRefreshTask: Task<Void, Never>?
    private var controlRefreshGeneration = 0
    /// Dedup exact refreshes when a control nudge and the fallback poll land together.
    private var sessionDetailRefreshes: Set<String> = []
    /// Owner-library refreshes share one drain. Task events enqueue their exact ids; reconnects and
    /// coarse invalidations enqueue a full target. Keeping the drain alive across the awaited read
    /// is the single-flight boundary: events received meanwhile become one trailing pass instead
    /// of starting another expensive list query in parallel.
    private var libraryRefreshQueue = CoalescedRefreshQueue<LibraryTarget, String>()
    private var libraryRefreshTask: Task<Void, Never>?
    private var libraryRefreshGeneration = 0

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
    /// The account's watches: Following, the console's Watching card, and every session's row and header.
    private(set) var watches: WatchesModel?
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
        controlRefreshGeneration &+= 1
        controlRefreshTask?.cancel()
        controlRefreshTask = nil
        controlRefreshPending = false
        libraryRefreshGeneration &+= 1
        libraryRefreshTask?.cancel()
        libraryRefreshTask = nil
        libraryRefreshQueue = CoalescedRefreshQueue()
        apiGeneration &+= 1
        sessionDetails.removeAll()
        baseURL = url
        api = APIClient(baseURL: url, tokenStore: tokenStore)
        let tasksModel = TasksModel(baseURL: url, tokenStore: tokenStore)
        tasksModel.onSelectedDetailMissing = { [weak self] id in
            guard self?.selectedTaskID == id else { return }
            self?.selectedTaskID = nil
        }
        tasksModel.setSectionActive(selectedSection == .tasks)
        tasksModel.setSelectedDetailID(selectedTaskID)
        tasks = tasksModel
        agents = AgentsModel(baseURL: url, tokenStore: tokenStore)
        runners = RunnersModel(baseURL: url, tokenStore: tokenStore)
        admin = AdminModel(baseURL: url, tokenStore: tokenStore)
        let watchesModel = WatchesModel(baseURL: url, tokenStore: tokenStore)
        #if os(macOS)
        // macOS has no APNs path, so a NOTIFY_USER watch that matched is announced from the refetch;
        // iOS already gets the server's push for it (PushService.notifyWatchMatched).
        watchesModel.onMatched = { [weak self] event in
            self?.notifications.post(Notifications.content(for: event))
        }
        #endif
        watches = watchesModel
        consoleRegistry = ConsoleRegistry(baseURL: url, tokenStore: tokenStore,
                                          store: ConsoleRegistry.defaultStore(for: url))
        // A console's fleeting confirmations ("Merged into main", "Committed changes") ride the app's
        // one toast host, not the status line above the composer — see `showToast`.
        consoleRegistry?.onToast = { [weak self] request, sessionID in
            self?.showToast(request.message, sessionID: sessionID,
                            detail: request.detail, tone: request.tone)
        }
        // The permission posture a session inherits when it stores none, and where a Mode picked in
        // the composer is remembered — both live on the account (Settings → Default permission).
        consoleRegistry?.accountDefaultPermissionMode = { [weak self] in
            self?.user?.preferences?.defaultPermissionMode
        }
        consoleRegistry?.rememberDefaultPermissionMode = { [weak self] raw in
            self?.rememberDefaultPermissionMode(raw)
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

    /// Persist a Mode the user picked when starting a session as the account default (synced across
    /// devices), so the runs nobody starts from a composer — task-launched, MCP-created — inherit it
    /// server-side. Same fire-and-forget shape as `rememberDefaultEffort`.
    func rememberDefaultPermissionMode(_ raw: String) {
        guard let api, user?.preferences?.defaultPermissionMode != raw else { return }
        Task {
            if let updated = try? await api.updatePreferences(
                UpdatePreferencesRequest(defaultPermissionMode: raw)) {
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
        } catch is TokenNotStoredError {
            errorText = "Signed in, but this device couldn't save the session to the Keychain."
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
        controlRefreshGeneration &+= 1
        controlRefreshTask?.cancel()
        controlRefreshTask = nil
        controlRefreshPending = false
        libraryRefreshGeneration &+= 1
        libraryRefreshTask?.cancel()
        libraryRefreshTask = nil
        libraryRefreshQueue = CoalescedRefreshQueue()
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
        needsYouSessions = []
        agentNeedsYou = [:]
        #if os(iOS)
        runningWorkspaceIDs = []
        #endif
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

    /// Reset navigation to the signed-out baseline. Navigation itself is one value, so this is
    /// `NavState()` and then only what is *not* a page: the agent the pane is on (whose memory
    /// survives as the persisted default, not as this field) and the landing latch — everything the
    /// runtime/watch/user panes show is a stack, cleared with it.
    ///
    /// `selectedTaskID` earns a line of its own despite being a read of the stack, because clearing
    /// it is not a no-op: the write lands in the Tasks model's single detail slot, which would
    /// otherwise go on serving the task that was on screen before the sign-out.
    private func resetNavigation() {
        selectedSection = .agents      // runs the section switch's own housekeeping first
        nav = NavState()               // then clears every section's stack with it
        didResolveDefaultLanding = false
        selectedTaskID = nil
        selectedAgentID = nil
    }

    /// Wire up notifications. Call once at launch.
    func bootstrap() {
        notifications.configure()
        notifications.onIntent = { [weak self] intent in self?.handle(intent) }
        #if os(iOS)
        // An approval that arrives while you're in the app shows as Orbit's own card rather than a
        // system banner (see `NotificationManager.willPresent`). A `.warning`, so it stays until
        // it's dealt with — that's the whole point of it, and it's what a banner's persistence in
        // Notification Center was doing before. Tapping it opens the session it's blocking on.
        notifications.onForegroundApproval = { [weak self] sessionID, line in
            self?.showToast(line, sessionID: sessionID, tone: .warning,
                            icon: "bell.badge.fill", awaitsApproval: true)
        }
        #endif
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
        #if os(iOS)
        // The always-mounted iPhone drawer / iPad sidebar performs the initial Workspace + Runner
        // load. Start the lightweight refresh one interval later instead of duplicating that request.
        runnerSnapshotRefreshNotBefore = Date().addingTimeInterval(Self.runnerSnapshotRefreshInterval)
        #endif
        pollTask = Task { @MainActor [weak self] in
            // A restored-token launch sets `signedIn` in `init` without going through `login()`, so
            // `user` is still nil — prime it once so the sidebar account footer shows the real name
            // instead of the "Account" placeholder.
            if let self, self.user == nil { self.user = try? await self.api?.me() }
            while !Task.isCancelled {
                if let self { await self.loadSessions() }
                if let self {
                    #if os(iOS)
                    await self.refreshRunnerSnapshotIfDue()
                    #endif
                    // The control stream has no purge event, and a Completed / Trash cold route is
                    // absent from Open by definition. Refresh only that one focused fallback so a
                    // remote lifecycle change or permanent deletion cannot leave a ghost console.
                    await self.refreshFocusedSessionDetailIfNeeded()
                    self.consoleRegistry?.flush(self.focusedConsoleSessionID)
                    await self.refreshWatchesIfDue()
                }
                try? await Task.sleep(nanoseconds: 4_000_000_000)
            }
        }
    }

    /// The watch list's floor. No control event names a watch, so this is what brings in one an agent
    /// just created, and the evaluator's newer looks behind every "Last evaluated".
    private var watchesRefreshNotBefore = Date.distantPast
    private static let watchesRefreshInterval: TimeInterval = 30

    private func refreshWatchesIfDue(now: Date = Date()) async {
        guard now >= watchesRefreshNotBefore, let watches else { return }
        watchesRefreshNotBefore = now.addingTimeInterval(Self.watchesRefreshInterval)
        await watches.load()
    }

    #if os(iOS)
    /// Claim one Runner refresh when the shared poll reaches the 15s gate. The claim is recorded
    /// before awaiting so a re-entrant UI task cannot start a duplicate request; cancellation rides
    /// the parent `pollTask`, which logout already cancels.
    private func refreshRunnerSnapshotIfDue(now: Date = Date()) async {
        guard now >= runnerSnapshotRefreshNotBefore, let agents else { return }
        runnerSnapshotRefreshNotBefore = now.addingTimeInterval(Self.runnerSnapshotRefreshInterval)
        await agents.refreshRunnerSnapshot()
    }
    #endif

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
                        // No event carries a watch either: re-read the list the stream can't replay.
                        if let watches { Task { await watches.load() } }
                        // Runners has neither push nor poll: a list that failed while offline
                        // would otherwise stay on its error until someone pulls to refresh.
                        if let runners, runners.loadState.lastLoadFailed {
                            Task { await runners.load() }
                        }
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
        // A watch's target may have moved with this row, and no event names watches: refetch soon.
        case .sessionCreated, .sessionUpdated, .sessionEnded, .approvalRequested, .approvalResolved, .taskChanged:
            watches?.nudge()
        default:
            break
        }
        switch ev.type {
        // A task event carries the changed row ids. Fold those exact rows into the loaded page;
        // only an explicit coarse invalidation (or an older/malformed payload) needs a snapshot.
        case .taskChanged:
            guard let changed = ev.payload(ControlTaskChanged.self),
                  // A legacy server sends only taskId and has no /tasks/:id/row route. Treat that
                  // wire shape as a coarse nudge so a new app remains correct against an older
                  // self-hosted deployment instead of reading the route's 404 as task deletion.
                  changed.canRefreshIncrementally else {
                scheduleLibraryRefresh(.tasks)
                return
            }
            let ids = Set(changed.effectiveTaskIds)
            guard !ids.isEmpty else {
                scheduleLibraryRefresh(.tasks)
                return
            }
            scheduleTaskRefresh(ids)
        // List create/rename/delete is deliberately coarse and rare. It can invalidate the
        // selected scope as well as navigation, so reconcile those surfaces together once.
        case .taskListChanged:
            scheduleLibraryRefresh(.tasks)
        // Workspace runner/enabled changes alter the server's Ready predicate for every assigned
        // task. Agent edits are low-frequency and do not carry that affected set, so reconcile the
        // task page once as well as the agent/session surfaces. A provider-default-only nudge from
        // ordinary session creation explicitly opts out; older servers omit the flag and retain
        // the conservative refresh behavior.
        case .agentChanged:
            scheduleLibraryRefresh(.agents)
            if ev.payload(ControlAgentChanged.self)?.affectsTaskRows != false {
                scheduleLibraryRefresh(.tasks)
                scheduleControlRefresh()
            }
        // AgentsModel.load() fetches the provider catalog with the list; provider edits do not
        // change task-row membership or live overlays.
        case .providerChanged:
            scheduleLibraryRefresh(.agents)
            scheduleControlRefresh()
        case .sessionCreated, .sessionUpdated:
            if let summary = ev.payload(ControlSessionSummary.self) {
                // Session state is the authority for a task row's running/queued overlays. The
                // summary names that task on current servers, so starting, claiming and settling a
                // run update one lightweight row instead of waiting for the minute reconciliation.
                if let taskID = summary.taskId { scheduleTaskRefresh([taskID]) }
                if mergeSessionSummary(summary) { return }
            }
            scheduleControlRefresh()
        case .approvalRequested, .approvalResolved:
            if let approval = ev.payload(ControlApproval.self),
               mergePendingApprovals(sessionID: ev.sessionId, pending: approval.pendingApprovals,
                                     waitingKind: approval.waitingKind) {
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
    ///     would render worse than the ~½s wait for the real snapshot;
    ///   • the run just reached a terminal status — whether that is an outcome or a failure the
    ///     server is about to retry is decided by `retryAt`, which the summary doesn't carry, so
    ///     folding the status in alone would announce a failure that undoes itself a minute later.
    ///     Once per session ended, against a per-turn event: the refetch costs nothing here.
    private func mergeSessionSummary(_ summary: ControlSessionSummary) -> Bool {
        patchSessionProjectRelation(summary)
        if let lifecycle = summary.effectiveLifecycleState, lifecycle != .open { return false }
        if summary.effectiveRunStatus.isTerminal { return false }
        guard let index = sessions.firstIndex(where: { $0.id == summary.id }) else { return false }
        let merged = sessions[index].applying(summary)
        guard merged != sessions[index] else { return true }   // nothing user-visible changed
        var list = sessions
        list[index] = merged
        applySessionSnapshot(list)
        return true
    }

    /// Relation metadata has a different membership rule from run/lifecycle state: a Project can
    /// rotate away from or delete a coordinator while that Session lives in Completed/Trash. Patch
    /// every loaded copy before the ordinary Open-only summary gate, using the payload's
    /// absent/null/value distinction so an older server preserves rather than clears the relation.
    private func patchSessionProjectRelation(_ summary: ControlSessionSummary) {
        guard summary.projectId != nil || summary.projectTitle != nil else { return }
        if let index = sessions.firstIndex(where: { $0.id == summary.id }) {
            let merged = sessions[index].applyingProjectRelation(summary)
            if merged != sessions[index] {
                var list = sessions
                list[index] = merged
                applySessionSnapshot(list)
            }
        }
        if let cached = sessionDetails.resolve(summary.id) {
            sessionDetails.store(cached.applyingProjectRelation(summary))
        }
        agents?.applyProjectRelation(summary)
    }

    /// Same, for `approval.requested` / `approval.resolved` — the event carries the authoritative
    /// pending count, which is all a row needs to switch between the spinner and the amber
    /// needs-you cue (and to move the badge). False when the row isn't loaded.
    ///
    /// The kind comes with the count and replaces the row's, because the event's number is the
    /// whole total: the one that answers an owner confirmation arrives with a count and no kind,
    /// and a row left saying "Waiting for your confirmation" would be pointing at a card that is
    /// gone.
    private func mergePendingApprovals(sessionID: String, pending: Int,
                                       waitingKind: SessionWaitingKind?) -> Bool {
        guard let index = sessions.firstIndex(where: { $0.id == sessionID }) else { return false }
        guard sessions[index].pendingApprovals != pending
                || sessions[index].waitingKind != waitingKind else { return true }
        var list = sessions
        list[index] = list[index].settingPendingApprovals(pending, waitingKind: waitingKind)
        applySessionSnapshot(list)
        return true
    }

    /// The owner-level lists a control event can dirty, each backed by its own model.
    enum LibraryTarget: Hashable, Sendable { case agents, tasks }

    /// Request a full target snapshot. This is reserved for reconnect (the control stream has no
    /// replay), coarse/legacy events and task-list structure changes; ordinary task events use the
    /// id path below.
    private func scheduleLibraryRefresh(_ target: LibraryTarget) {
        guard libraryRefreshQueue.enqueueFull(target) else { return }
        startLibraryRefreshDrain()
    }

    /// Queue exact changed task rows. A Set collapses repeated task events within a turn and while
    /// the previous network read is in flight.
    private func scheduleTaskRefresh(_ ids: Set<String>) {
        var shouldStart = false
        for id in ids {
            shouldStart = libraryRefreshQueue.enqueueChanged(id, for: .tasks) || shouldStart
        }
        if shouldStart { startLibraryRefreshDrain() }
    }

    /// Strict single-flight with trailing-edge drain. `take()` clears only the work already seen;
    /// an event that arrives during either awaited load remains pending for the next pass.
    private func startLibraryRefreshDrain() {
        guard libraryRefreshTask == nil else { return }
        libraryRefreshGeneration &+= 1
        let generation = libraryRefreshGeneration
        libraryRefreshTask = Task { @MainActor [weak self] in
            guard let self else { return }
            while !Task.isCancelled, self.libraryRefreshGeneration == generation {
                do { try await Task.sleep(nanoseconds: 200_000_000) }
                catch { break }
                guard self.libraryRefreshGeneration == generation else { break }

                let pass = self.libraryRefreshQueue.take()
                if pass.fullTargets.contains(.agents) {
                    await self.agents?.load()
                    guard self.libraryRefreshGeneration == generation else { break }
                    // A launch that couldn't reach the server left the landing open; this reload —
                    // the reconnect path — is what finally answers it.
                    self.resolveDefaultLanding()
                }
                if pass.fullTargets.contains(.tasks) {
                    await self.tasks?.refresh()
                } else {
                    let ids = pass.changedIDs(for: .tasks)
                    if !ids.isEmpty {
                        await self.tasks?.refreshChangedTasks(ids)
                    }
                }
                guard self.libraryRefreshGeneration == generation else { break }

                if !self.libraryRefreshQueue.finishPass() { break }
            }
            if self.libraryRefreshGeneration == generation { self.libraryRefreshTask = nil }
        }
    }

    /// Coalesce event-driven refreshes: a burst of control events (a turn ending fires STATUS +
    /// TURN_END back-to-back) folds into one list fetch. Only events `apply` can't upsert in place
    /// reach here, and this is a whole-list fetch + re-render, so the window matches web's 500ms
    /// rather than the old 200ms — with several sessions running, that alone was up to five
    /// full refreshes a second.
    private func scheduleControlRefresh() {
        controlRefreshPending = true
        guard controlRefreshTask == nil else { return }
        controlRefreshGeneration &+= 1
        let generation = controlRefreshGeneration
        controlRefreshTask = Task { @MainActor [weak self] in
            guard let self else { return }
            while !Task.isCancelled, self.controlRefreshGeneration == generation {
                do { try await Task.sleep(nanoseconds: 500_000_000) }
                catch { break }
                guard self.controlRefreshGeneration == generation else { break }
                self.controlRefreshPending = false
                await self.loadSessions()
                guard self.controlRefreshGeneration == generation else { break }
                // A missing Open row is ambiguous: it may be the same stable Completed detail, or
                // a cross-client Complete / Trash / purge transition. Resolve the focused cached
                // row exactly after the control-driven snapshot rather than trusting absence.
                await self.refreshFocusedSessionDetailIfNeeded()
                if !self.controlRefreshPending { break }
            }
            if self.controlRefreshGeneration == generation { self.controlRefreshTask = nil }
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
    /// A read of the current section's stack, so backing out to a list — a pop SwiftUI writes back
    /// into the path — stops the previous console's stream by itself, even if SwiftUI keeps its view
    /// cached. (The old flat selection promised this and could not keep it: the pop happened inside
    /// SwiftUI's private stack, where the model never saw it.)
    var focusedConsoleSessionID: String? { nav.focusedConsoleSessionID }

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
        // Observation invalidates observers on assignment, equal value or not, and these fields
        // drive the drawer + every session list — so an identical snapshot (most 4s ticks of an idle
        // app) must not write them at all. The field-wise compare is far cheaper than the re-render
        // it avoids. The badge / notification reconciles below deliberately stay outside this gate:
        // they have their own first-run rules, and a launch whose first snapshot happens to match
        // still has to reconcile whatever a silent push left on the icon.
        if list != sessions {
            sessions = list
            recentSessions = RecentsLogic.recent(list, limit: list.count)
            needsYouSessions = SessionGrouping.group(list).needsYou
            agentNeedsYou = NeedsYouLogic.byAgent(list)
            #if os(iOS)
            runningWorkspaceIDs = WorkspaceActivityLogic.runningWorkspaceIDs(list)
            #endif
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
            // The foreground card standing in for one of those banners has to come down with them.
            // It's persistent by design, so an approval answered on web or macOS would otherwise
            // leave a card asking for something that's already been decided.
            if let toast, toast.awaitsApproval, let sid = toast.sessionID, !needsYou.contains(sid) {
                dismissToast()
            }
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
    var orderedAgents: [Agent] { AgentListLogic.ordered(agents?.items ?? [], runnerOrder: agents?.runnerOrder ?? []) }

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

    /// A draft composer just created `session`: surface it in the agent's list (so the list has a
    /// matching row) and open its console. Registering *before* the push is what keeps the iPhone
    /// push from bouncing back to the "Select a session" empty state — see
    /// `AgentsModel.registerCreatedSession`.
    ///
    /// The draft's page is *replaced* by the console's, not popped and re-pushed: both shells render
    /// the frame that is on the stack, so one `replaceTop` moves the page you are on to the session
    /// it just created. That is why the push/pop churn that used to strand the compact detail on a
    /// nil selection (opening ~10+ sessions in a row) has nothing left to race.
    func openCreatedAgentSession(_ session: Session) {
        registerCreatedAgentSession(session)
        nav.replaceTop(with: .console(sessionID: session.id, origin: .list))
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
        show(.compose(agentID: id), agent: id)
    }

    /// Open the draft composer for the agent pane already on screen (the "New session" toolbar
    /// button): the draft replaces whatever the detail column was showing / pushes onto the stack.
    /// Deliberately not an entry point — it leaves the pane's agent where it is (a draft for the
    /// agent you are looking at, falling back to the first one), so unlike ``show`` it does not move
    /// the section or the agent, only the page.
    func startComposingSession() {
        guard let id = currentAgentID else { return }
        nav.replaceTop(with: .compose(agentID: id))
    }

    /// Switch the agent the new-session draft is composing for while staying on the compose page —
    /// the hero's agent switcher. Unlike `openAgent` (which pops back to the agent's session list),
    /// this swaps the draft's own frame for one naming `id`, so the pushed/inline `NewSessionView`
    /// just rebuilds for it (a fresh draft via its `.id(agent.id)`).
    func composeWithAgent(_ id: String) {
        show(.compose(agentID: id), agent: id)
    }

    /// Enter the Agents section focused on agent `id` — the one navigation transition behind the
    /// macOS sidebar row, the compact drawer row, and ⌘1…⌘9. Switching to a *different* agent pops
    /// that section's stack, so its pane opens on the session list (the console and the draft on it
    /// belong to the agent you just left); re-selecting the current agent keeps the stack — a pushed
    /// console stays pushed.
    ///
    /// The one entry point that opens no page, which is why it does not go through ``show``: a real
    /// switch *empties* the section's stack instead of naming the frame to put on top of it.
    func openAgent(_ id: String) {
        selectedSection = .agents
        if selectedAgentID != id {
            selectedAgentID = id
            nav.popToRoot()
        }
    }

    /// Open a **Recents** row from the drawer: jump into the session's owning agent and put its
    /// console on screen. The Open list nests the agent, so there's no fetch (unlike a cold deep link
    /// — see ``openSession``). A no-op agent switch leaves the page where it is; a real one replaces
    /// it, which is also the whole of "clear the prior agent's session/compose state": both were
    /// pages of this one stack, and a page cannot outlive the frame it was.
    func openRecentSession(_ s: Session) {
        // The frame records where it came from — a Recents drawer row — so the compact shell frees
        // the left edge for the drawer-open swipe on that console (see `NavState.consoleFromRecents`).
        // Nothing to set first, and no observer with an ordering convention to preserve it.
        show(.console(sessionID: s.id, origin: .drawer), agent: s.agent?.id ?? s.agentId)
    }

    /// The "needs you" banner's state for a screen showing `focused` (nil from a list, which shows no
    /// one session). Cheap enough to read per body pass — it filters the handful of blocked rows, not
    /// the Open list, which `applySessionSnapshot` already narrowed.
    func needsYouBanner(excluding focused: String?) -> NeedsYouBanner? {
        NeedsYouLogic.banner(waiting: needsYouSessions, excluding: focused)
    }

    /// Open the session the banner points at. The same navigation as a Recents tap, minus the origin
    /// that says "drawer": a banner tap didn't come from the drawer, so the console it lands on keeps
    /// the system back-swipe instead of yielding the edge to the drawer gesture. An earlier Recents
    /// tap's origin can't linger either — it rode the frame that tap pushed, and this one replaces it.
    func openNeedsYouSession(_ s: Session) {
        show(.console(sessionID: s.id, origin: .banner), agent: s.agent?.id ?? s.agentId)
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
    /// target. In Agents it's the selected agent session (nil while drafting a new one, since a
    /// draft's frame is not a console). nil in every other section, which disables the command.
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
    var consoleFromRecents: Bool { nav.consoleFromRecents }

    /// True when the current section's navigation stack is at its root (nothing pushed) — the
    /// compact shell uses this to yield the left screen edge to its drawer-open gesture only where
    /// no pushed page needs the edge for the system back-swipe. Every section that pushes reads its
    /// own stack — Tasks (a detail, then the list directory), Agents (a draft, then a console),
    /// Runners, Following, Admin, and Settings (its runners list, then a runner's record).
    var sectionAtRoot: Bool {
        switch selectedSection {
        // Nothing pushed on the Tasks stack: not a task's detail, not the list directory — one
        // read, where this used to ask two fields that the stack could disagree with (the ask ran
        // the other way round, too: "did the drawer not open?" answered with "is a task selected?").
        case .tasks:   return nav.sectionAtRoot
        // Nothing pushed on the Agents stack: no draft, no console — one read, where this used to
        // ask two fields that the stack could disagree with.
        case .agents:  return nav.sectionAtRoot
        // The sections whose pages are frames of their own stack: one read covers both the
        // three-column selection and the compact push. Skills pushes nothing (always at root); Admin
        // pushes a user's record now, which is what replaced the unconditional `true` this used to
        // answer with; Settings pushes two (its runners list, then a runner's record).
        case .skills, .runners, .following, .admin, .settings: return nav.sectionAtRoot
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
        nav.removeConsole(id)
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
        /// Set on the card that stands in for a foreground approval banner (see
        /// `NotificationManager.willPresent`). It's a `.warning`, so nothing takes it down on a
        /// timer — and the approval it names can be answered anywhere, including on another
        /// device, so the snapshot that notices has to clear it.
        var awaitsApproval = false
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
                   canUndo: Bool = false, awaitsApproval: Bool = false) {
        let title = sessionTitle ?? sessionID.flatMap(toastSessionTitle)
        toast = Toast(message: message, sessionTitle: title,
                      detail: detail, tone: tone, icon: icon,
                      sessionID: sessionID, canUndo: canUndo, awaitsApproval: awaitsApproval)
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
    /// (dormant, completed, trashed), with no runner reload behind it. Blank is a no-op; committing
    /// an unchanged title still reaches the server because it is how a Project-managed title opts
    /// out of future synchronization (the same-text/ABA case).
    ///
    /// The new name is written into the loaded snapshots first so the header and the row change on
    /// the spot; the reload settles the authoritative value either way, which is also what reverts
    /// the optimistic patch when the server rejects the rename.
    func renameSession(_ id: String, title rawTitle: String) {
        guard let api else { return }
        let title = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        if title != session(id: id)?.title { patchSessionTitle(id, to: title) }
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

    /// What a compact list row does when it is tapped: put `node` on top of the section's stack.
    ///
    /// The rows used to be `NavigationLink(value:)` — the same push, except the link also draws the
    /// platform's disclosure indicator, and iOS 17/18 has no usable way to hide one (the
    /// `.navigationLinkIndicatorVisibility` modifier is documented from 17.0 but reads an
    /// environment key that 18.5 and earlier don't have, so referencing it crashes at launch).
    /// A row calling this keeps the one push mechanism — the stack is still the only truth — with
    /// no arrow, and every pushing row spells it the same way.
    func push(_ node: NavNode) {
        nav.push(node)
        // Every write to the Tasks stack keeps its detail store in step (see `taskStack`), and a
        // frame a row pushed by hand is still a write to it. Guarded by the section because that
        // store is read off the stack *on screen*: syncing while another section is up would name
        // nil and drop the detail the still-pushed task page is about to read.
        if nav.section == .tasks { syncTaskDetailStore() }
    }

    /// Put `node` on screen in the Agents section — the one transition every Agents entry point
    /// lands on, which is why each of them is now a single line naming the page it opens.
    ///
    /// The two writes beside it are what those entries used to spell out for themselves: enter the
    /// section, and point its pane at the agent the page belongs to. Five hand-rolled copies of them
    /// is five chances to leave one out, and the one that gets left out is silent — the page opens
    /// under a pane still showing another agent's list. A no-op agent switch leaves the frame alone,
    /// so re-opening a session you are already on does not disturb the page beneath it.
    private func show(_ node: NavNode, agent agentID: String? = nil) {
        selectedSection = .agents
        if let agentID, selectedAgentID != agentID { selectedAgentID = agentID }
        nav.replaceTop(with: node)
    }

    /// The app's only door for navigation that arrives from *outside* it: an `orbit://` URL, a
    /// notification's tap, a `[title](orbit-session:<id>)` link in a transcript, the ⌘K palette, the
    /// menu bar. In-app affordances (a list row, the drawer's Recents and Workspace rows, the
    /// needs-you banner, ⌘N, ⌘1…⌘9) call their entry point directly instead: a `Route` carries
    /// neither an origin nor an agent, and a frame pushed for a drawer row has to say both.
    func route(to route: Route) {
        selectedSection = AppSection.forRoute(route)
        switch route {
        case .active:          if selectedAgentID == nil { selectedAgentID = orderedAgents.first?.id }
        case .session(let id): openSession(id)
        case .task(let id):
            // A deep link or dependency jump may target a task outside the currently selected
            // named list. Aggregate scope guarantees the row and detail can resolve together.
            // Both of the next two lines are stack edits now: the directory page comes off, and the
            // task's own page takes the top — so a route lands one page deep, whatever was showing.
            taskListsDirectoryPresented = false
            tasks?.selectScope(.all)
            tasks?.filter = .all
            tasks?.searchText = ""
            selectedTaskID = id
        case .runner(let id):  selectedRunnerID = id
        case .watch(let id):   openWatch(id)
        }
    }

    /// Open a watch's record on Following. A push names the watch by its UUID while the list tags rows
    /// by public id, so the selection takes the list's spelling once the watch is in hand — fetched
    /// first when it's an older one the list doesn't hold.
    private func openWatch(_ id: String) {
        selectedWatchID = watches?.watch(id)?.id ?? id
        guard let watches, watches.watch(id) == nil else { return }
        Task { @MainActor [weak self] in
            await watches.fetch(id)
            // The section guard is load-bearing now that the selection writes through the stack:
            // `replaceTop` edits whatever section is showing, so without it a fetch landing after
            // the user has switched away would put a watch frame on top of another section's page.
            guard let self, self.selectedSection == .following,
                  self.selectedWatchID == id, let watch = watches.watch(id) else { return }
            self.selectedWatchID = watch.id
        }
    }

    /// Open a session's console. There's no standalone session view anymore, so route into its
    /// owning agent's console (the section is already `.agents`, set by `route`). Resolve the agent
    /// from loaded state, then refresh an out-of-Open route with the exact session record. Showing
    /// the id right away lets the console paint while the agent + lifecycle context resolve in the
    /// background; retaining that response is what lets Completed / Trash headers and composers
    /// render correctly on a cold launch.
    private func openSession(_ id: String) {
        // A route replaces what the detail pane / stack top is showing (a draft included) — the same
        // "select this session" act as a list row, so the three-column shells land exactly where
        // they did when this was a selection write.
        show(.console(sessionID: id, origin: .deepLink), agent: agentID(for: id))
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

    /// Load the agent list, then land on the app's home if we're still on the launch default — see
    /// `resolveDefaultLanding`.
    func loadAgentsThenLand() async {
        await agents?.load()
        resolveDefaultLanding()
    }

    /// The one-shot launch landing: the agent you last used (persisted via `selectedAgentID`), else
    /// the first agent, else the Runners section when the server says there are none — the native
    /// parallel of web's runners/register onboarding. A deep link / notification that already chose
    /// an agent, a session or another section is respected. Decided only off a successful agent
    /// fetch: an offline launch leaves it unlatched, and the control plane's reconnect reload decides
    /// instead. The rules live in `LoadFailureLogic.defaultLanding`.
    private func resolveDefaultLanding() {
        guard !didResolveDefaultLanding, let agents else { return }
        let landing = LoadFailureLogic.defaultLanding(
            agents: agents.loadState,
            orderedAgentIDs: orderedAgents.map(\.id),
            lastAgentID: UserDefaults.standard.string(forKey: Self.lastAgentKey),
            section: selectedSection,
            selectedAgentID: selectedAgentID,
            selectedSessionID: selectedAgentSessionID)
        switch landing {
        case .undecided: return
        case .keepCurrent: break
        case .agent(let id): selectedAgentID = id
        case .runners: selectedSection = .runners
        }
        didResolveDefaultLanding = true
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
