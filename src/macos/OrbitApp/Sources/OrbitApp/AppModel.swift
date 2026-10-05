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

/// What a console reports to the app's toast host. The session id isn't here: the registry knows
/// which console it handed this sink to and adds it (see `ConsoleRegistry.onToast`). `key` names the
/// operation ("merge", "commit") so its result takes its progress pill's place; the app scopes it to
/// the session. `ToastTone` lives in OrbitKit with the rest of the toast rules (`ToastFeed`).
struct ToastRequest: Equatable {
    let message: String
    var detail: String?
    var tone: ToastTone = .success
    var key: String?
    var inProgress = false
    var mergeConflict: ToastMergeConflict?
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
    var user: User? {
        didSet { refreshAvatar() }
    }
    private var pendingDefaultModels: [String: String] = [:]
    @ObservationIgnored private var defaultModelWrite: Task<Void, Never>?
    var defaultModels: [String: String] {
        (user?.preferences?.defaultModels ?? [:]).merging(pendingDefaultModels) { _, picked in picked }
    }
    /// The account's profile photo, once fetched — drawn wherever the account's avatar is
    /// (`AccountAvatar`). Nil while the account has none, or before it has arrived; the name's first
    /// letter stands in.
    private(set) var avatarImage: PlatformImage?
    /// Whose photo, at which version, `avatarImage` is — so a new `user` refetches only on a change.
    private var avatarImageKey: String?
    var sessions: [Session] = []
    /// The owner's session-tag library — the 7 seeded system tags plus any custom ones, fetched from
    /// `GET /session-tags`. Drives the tag picker sheet and the list's tag filter/group chips; empty
    /// on an older server without the endpoint. See `loadSessionTags` / `setSessionTags`.
    var sessionTags: [SessionTag] = []
    #if os(iOS)
    /// The owner's session folders, every workspace's (`GET /session-folders`, by name) — the Move
    /// panel lists the ones in the session's own workspace. iOS only, as the panel is: macOS shows no
    /// folders (docs/session-folders-move-design.md §1). See `loadSessionFolders`.
    var sessionFolders: [SessionFolder] = []
    #endif
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
            // The detail store names the task page on top of the stack on screen, and a switch
            // changes which stack that is: a task page a console opened over itself (its card's
            // rows), or the Tasks stack's own. Without this, coming back to a Tasks page left while
            // a console's task page held the slot is that page refused its load — a spinner.
            syncTaskDetailStore()
        }
    }
    /// Latches the one-shot default-landing resolution so it runs only after the first successful
    /// agent-list load, and never overrides a later user/deep-link choice.
    private var didResolveDefaultLanding = false
    /// The workspace a cold launch landed on from its snapshot (`restoreLaunchSnapshot`) before the
    /// workspace fetch answered. While it is still the one selected nobody has chosen anything, so
    /// `resolveDefaultLanding` decides afresh once the fetch succeeds.
    private var provisionalLandingAgentID: String?
    /// Whether the launch landing is still to come — the workspace pane then keeps its spinner rather
    /// than asking for a pick the landing is about to make (`AgentContentColumn`).
    var launchLandingPending: Bool { !didResolveDefaultLanding }
    /// Whether Settings is up as a sheet (iOS) — a read of the navigation state like every other
    /// fact about what is on screen. On iOS Settings is presented over the section you are in rather
    /// than switched to: the drawer's gear and the iPad sidebar's row both set this, so closing it
    /// lands back on the very page it covered. Opening it starts from Settings' own list
    /// (`NavState.openSettings`).
    var settingsPresented: Bool {
        get { nav.settingsPresented }
        set {
            if newValue { nav.openSettings() } else { nav.settingsPresented = false }
        }
    }
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
            // pops the record that is there. Either way the record's own pages (an engine's, its
            // name's) come off first, so a route still lands one page deep.
            nav.popRunnerPages()
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
    /// The project whose page fills the Projects pane — the row the three-column list draws as
    /// selected, and the page the compact stack pushes. A read of the section's stack.
    var selectedProjectID: String? {
        get { nav.selectedProjectID }
        set {
            // The list's selection is a project. With one of its tasks open over it, selecting that
            // same project again is no change; selecting another, or clearing it, takes the task
            // page with it — a task shows over its own project's page and nowhere else.
            if nav.projectBeneathTask != nil {
                guard newValue.map(PublicID.storageKey) != nav.selectedProjectID.map(PublicID.storageKey)
                else { return }
                nav.pop()
            }
            if let id = newValue {
                nav.replaceTop(with: .projectDetail(projectID: id))
            } else if case .projectDetail = nav.path.last {
                nav.pop()
            }
        }
    }
    /// The wiki entry whose page fills the Wiki pane — the row the three-column shells select, and the
    /// page the compact stack pushes. A read of the section's stack.
    var selectedWikiEntryID: String? {
        get { nav.selectedWikiEntryID }
        set {
            if let id = newValue {
                nav.replaceTop(with: .wikiEntry(entryID: id))
            } else if case .wikiEntry = nav.path.last {
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
            // Selecting in a three-column shell replaces the page the detail pane shows — or, with a
            // folder's page showing, is pushed over it, so the folder stays the list's page beside
            // the console (`NavState.selectConsole`); clearing pops the console that is there —
            // never a draft or a deeper frame.
            if let id = newValue {
                nav.selectConsole(.console(sessionID: id, origin: .list))
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
    /// The folder the draft on screen was opened from — a folder page's ✎ — whose sessions it
    /// files the one it creates in (`POST /sessions` with a `folderId`, design §3.3). Nil for a
    /// draft opened from a list. Read off the same frame as ``composingAgentSession``.
    var composingFolderID: String? {
        if case .compose(_, let folderID) = nav.path.last { return folderID }
        return nil
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

    /// The Open sessions blocked on an approval, and agentID → how many of them each agent holds —
    /// what the "needs you" banner and the drawer's per-agent badge read. Derived ONCE per applied
    /// snapshot (see `applySessionSnapshot`) rather than on every read: the drawer stays mounted behind
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
    /// Workspace ids with a background job in flight and nobody generating — read off the same
    /// glyph, so the two marks can never disagree about one row. Drawn quieter than the spinner.
    private(set) var jobWorkspaceIDs: Set<String> = []
    /// Each project's coordinator conversation as the Open list shows it, by project — what the
    /// drawer's project rows read beside their fetched summaries (`ProjectCoordinatorPulse`).
    private(set) var projectCoordinators: [String: ProjectCoordinatorPulse] = [:]
    #endif

    let tokenStore: TokenStore
    let notifications = NotificationManager()
    private(set) var baseURL: URL?
    private var api: APIClient?
    /// The cards for the Orbit links the open conversations are showing — read through one store for
    /// the whole app, so two conversations showing the same object ask for it once. Built where the
    /// API client is (see `configure`), and nil before that or after a sign-out.
    private(set) var linkCards: OrbitLinkCards?
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
    /// True from a cold launch's restore (`restoreLaunchSnapshot`) until the first fetched Open
    /// snapshot lands. The list in hand until then is the previous run's, or built on it by an
    /// in-place update, and a diff against it would announce everything that changed while the app
    /// was gone — so it never becomes `lastSnapshot`, and that first fetch only primes.
    private var openListFromLaunchSnapshot = false
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
    /// The earliest moment a loaded row's review is due, and the re-read scheduled for a second after
    /// it (`scheduleReviewDueRefresh`).
    private var reviewDueAt: Date?
    private var reviewDueTask: Task<Void, Never>?
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
    /// `loadSessions`'s single flight: the fetch on the wire, whether a call is waiting for one more,
    /// and how the last one went. The generation retires a flight across an instance switch.
    private var sessionsLoadTask: Task<Void, Never>?
    private var sessionsLoadPending = false
    private var sessionsLoadSucceeded = false
    private var sessionsLoadGeneration = 0

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

        // Restore the last instance; if its token is still in the Keychain, skip the login screen —
        // and draw the first frame from what the last run left rather than from nothing.
        if let saved = UserDefaults.standard.string(forKey: Self.instanceKey),
           let url = ServerURL.normalize(saved) {
            instanceField = saved
            configure(url)
            if tokenStore.token(for: url) != nil {
                signedIn = true
                restoreLaunchSnapshot()
            }
        }
    }

    /// Per-section shared stores (list + detail observe the same instance). Rebuilt per instance.
    private(set) var tasks: TasksModel?
    private(set) var agents: AgentsModel?
    private(set) var runners: RunnersModel?
    private(set) var admin: AdminModel?
    /// Every public link the account has made: Settings → Shared links, and the count on its row.
    private(set) var sharedLinks: SharedLinksModel?
    /// The shared pools the account is in: Settings → Providers, and each pool's page.
    private(set) var sharedPools: SharedPoolsModel?
    /// The account's watches: Following, the console's Watching card, and every session's row and header.
    private(set) var watches: WatchesModel?
    /// The account's projects: the Projects section and the drawer's project rows.
    private(set) var projects: ProjectsModel?
    /// The account's wiki: the Wiki section, the drawer's Wiki row and every entry page.
    private(set) var wiki: WikiModel?
    /// Warm cache of open consoles + their on-disk transcript store, scoped to this instance.
    private(set) var consoleRegistry: ConsoleRegistry?
    /// What the next cold launch draws first (`persistLaunchSnapshot` / `restoreLaunchSnapshot`),
    /// scoped to this instance.
    @ObservationIgnored private var launchSnapshots: LaunchSnapshotStore?
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
        sessionsLoadGeneration &+= 1
        sessionsLoadTask?.cancel()
        sessionsLoadTask = nil
        sessionsLoadPending = false
        apiGeneration &+= 1
        sessionDetails.removeAll()
        baseURL = url
        let client = APIClient(baseURL: url, tokenStore: tokenStore)
        api = client
        // One link-preview store for the app, with an age on its answers: a screen that stays open
        // asks for its cards again as it redraws, and only what has gone stale costs a request.
        linkCards = OrbitLinkCards(baseURL: url,
                                   store: OrbitLinkPreviewStore(client: client,
                                                                maxAge: OrbitLinkCards.maxAge))
        let tasksModel = TasksModel(baseURL: url, tokenStore: tokenStore)
        tasksModel.onSelectedDetailMissing = { [weak self] id in
            guard self?.selectedTaskID == id else { return }
            self?.selectedTaskID = nil
        }
        tasksModel.setSectionActive(selectedSection == .tasks)
        tasksModel.setSelectedDetailID(selectedTaskID)
        tasks = tasksModel
        let agentsModel = AgentsModel(baseURL: url, tokenStore: tokenStore)
        agentsModel.refreshOpen = { [weak self] in
            guard let self, await self.loadSessions() else { return nil }
            return self.sessions
        }
        agents = agentsModel
        runners = RunnersModel(baseURL: url, tokenStore: tokenStore)
        admin = AdminModel(baseURL: url, tokenStore: tokenStore)
        sharedLinks = SharedLinksModel(baseURL: url, tokenStore: tokenStore)
        sharedPools = SharedPoolsModel(baseURL: url, tokenStore: tokenStore)
        let watchesModel = WatchesModel(baseURL: url, tokenStore: tokenStore)
        #if os(macOS)
        // macOS has no APNs path, so a NOTIFY_USER watch that matched is announced from the refetch;
        // iOS already gets the server's push for it (PushService.notifyWatchMatched).
        watchesModel.onMatched = { [weak self] event in
            self?.notifications.post(Notifications.content(for: event))
        }
        #endif
        watches = watchesModel
        projects = ProjectsModel(baseURL: url, tokenStore: tokenStore)
        wiki = WikiModel(baseURL: url, tokenStore: tokenStore)
        consoleRegistry = ConsoleRegistry(baseURL: url, tokenStore: tokenStore,
                                          store: ConsoleRegistry.defaultStore(for: url))
        launchSnapshots = LaunchSnapshotStore.defaultStore(for: url)
        // A console's fleeting confirmations ("Merged into main", "Committed changes") ride the app's
        // one toast host, not the status line above the composer — see `showToast`.
        consoleRegistry?.onToast = { [weak self] request, sessionID in
            self?.showToast(request.message, sessionID: sessionID,
                            detail: request.detail, tone: request.tone,
                            mergeConflict: request.mergeConflict,
                            key: request.key.map { "\($0):\(sessionID ?? "")" }, inProgress: request.inProgress)
        }
        // The permission posture a session inherits when it stores none, and where a Mode picked in
        // the composer is remembered — both live on the account (Settings → Default permission).
        consoleRegistry?.accountDefaultPermissionMode = { [weak self] in
            self?.user?.preferences?.defaultPermissionMode
        }
        consoleRegistry?.rememberDefaultPermissionMode = { [weak self] raw in
            self?.rememberDefaultPermissionMode(raw)
        }
        consoleRegistry?.accountDefaultModels = { [weak self] in self?.defaultModels ?? [:] }
        consoleRegistry?.seedSessionContext = { [weak self] console in
            guard let self, let session = self.session(id: console.sessionID) else { return }
            console.seedSessionContext(
                session,
                modelCatalog: self.agents?.modelCatalog(for: session.assignedRunnerId),
                runtimeDefaultModels: session.assignedRunnerId.flatMap {
                    self.agents?.runnerRuntimeDefaultModels[$0]
                },
                configuredProviders: self.agents?.configuredProviders ?? [],
                configuredProvidersLoaded: self.agents?.configuredProvidersLoaded ?? false,
                providerPools: self.agents?.providerPools ?? [],
                sharedPools: self.agents?.sharedPools ?? [])
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

    /// Keep a model pick available to the next draft immediately, then sync it. Serialize writes
    /// so quickly choosing two models cannot leave the account remembering the older choice.
    func rememberDefaultModel(_ model: String, for provider: String) {
        guard let api, defaultModels[provider] != model else { return }
        pendingDefaultModels[provider] = model
        let previous = defaultModelWrite
        let generation = apiGeneration
        defaultModelWrite = Task {
            await previous?.value
            guard generation == apiGeneration else { return }
            if let updated = try? await api.updatePreferences(
                UpdatePreferencesRequest(defaultModels: [provider: model])),
               generation == apiGeneration {
                user = updated
                if pendingDefaultModels[provider] == model {
                    pendingDefaultModels.removeValue(forKey: provider)
                }
            }
        }
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

    /// Rename the account. Returns nil once the server has the name — `user` then carries it, so
    /// every place that shows the account follows — else what went wrong, for the edit card to say.
    func saveName(_ name: String) async -> String? {
        do {
            guard let api else { throw APIError.notConfigured }
            user = try await api.updateProfile(UpdateProfileRequest(name: ProfileEdit.name(name)))
            return nil
        } catch {
            return SettingsCopy.nameNotSaved(APIClient.failureReason(error))
        }
    }

    /// Set the account's profile photo: a square JPEG already cropped and scaled
    /// (`PlatformImage.orbitAvatarJPEG`). Returns nil once the server has it, else what went wrong.
    /// The bytes sent are the ones shown, so nothing is fetched back.
    func saveAvatar(_ jpeg: Data) async -> String? {
        do {
            guard let api else { throw APIError.notConfigured }
            let account = try await api.setAvatar(jpeg: jpeg)
            if let version = account.avatarUpdatedAt {
                avatarImageKey = "\(account.id)|\(version)"
                avatarImage = PlatformImage(data: jpeg)
            }
            user = account
            return nil
        } catch {
            return SettingsCopy.photoNotSaved(APIClient.failureReason(error))
        }
    }

    /// Take the account's profile photo away, so its avatar is the name's first letter again.
    func removeAvatar() async -> String? {
        do {
            guard let api else { throw APIError.notConfigured }
            user = try await api.removeAvatar()
            return nil
        } catch {
            return SettingsCopy.photoNotSaved(APIClient.failureReason(error))
        }
    }

    /// Fetch the photo `user` names when it is not the one held; drop it when there is none. A fetch
    /// that fails is tried again by the next `user`.
    private func refreshAvatar() {
        guard let user, let version = user.avatarUpdatedAt else {
            avatarImage = nil
            avatarImageKey = nil
            return
        }
        let key = "\(user.id)|\(version)"
        guard key != avatarImageKey, let api else { return }
        // Never another account's photo under this one's name while the new one loads.
        if avatarImageKey?.hasPrefix("\(user.id)|") != true { avatarImage = nil }
        avatarImageKey = key
        Task {
            do {
                let data = try await api.avatar()
                if avatarImageKey == key { avatarImage = PlatformImage(data: data) }
            } catch {
                if avatarImageKey == key { avatarImageKey = nil }
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
        pendingDefaultModels = [:]
        defaultModelWrite?.cancel()
        defaultModelWrite = nil
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
        sessionsLoadGeneration &+= 1
        sessionsLoadTask?.cancel()
        sessionsLoadTask = nil
        sessionsLoadPending = false
        controlPlaneLive = false
        consoleRegistry?.reset()   // persist open transcripts, drop the warm cache
        // The account's lists leave with it: the next launch here may be someone else's.
        launchSnapshots?.remove()
        // Cards read from this account are not ones to draw against the next: the store behind them
        // holds its answers, and a new sign-in builds a new one anyway.
        linkCards?.removeAll()
        linkCards = nil
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
        needsYouSessions = []
        agentNeedsYou = [:]
        #if os(iOS)
        runningWorkspaceIDs = []
        jobWorkspaceIDs = []
        projectCoordinators = [:]
        sessionFolders = []
        projectSessions = []
        projectSessionsAddress = nil
        projectSessionsError = nil
        #endif
        sessionDetails.removeAll()
        resetNavigation()
        lastSnapshot = nil
        openListFromLaunchSnapshot = false
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
        provisionalLandingAgentID = nil
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
        // The push names the session by its stored UUID; the card takes the lists' spelling, or its
        // title lookup and the needs-you check that takes it down both miss the row.
        notifications.onForegroundApproval = { [weak self] sessionID, line in
            self?.showToast(line, sessionID: PublicID.toPublic(sessionID), tone: .warning,
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
            // `user` is nil or the launch snapshot's copy — read it once so the account footer shows
            // the real name and the preferences are this run's. A failed read keeps what is there.
            if let self, let me = try? await self.api?.me() { self.user = me }
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
                    await self.projects?.refreshIfDue()
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
                        nudgeCreatedTasks()
                        // No event carries a watch either: re-read the list the stream can't replay.
                        if let watches { Task { await watches.load() } }
                        // `wiki.changed` has no replay either, and nothing depends on it arriving:
                        // re-read what the Wiki has loaded, the drawer's number with it.
                        if let wiki { Task { await wiki.reloadLoaded() } }
                        #if os(iOS)
                        // Nor has `folder.changed`: re-read the folders the Move panel offers.
                        Task { await loadSessionFolders() }
                        #endif
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
        // A reviewer's own conversation moving can end the review of another row (contract §5 N5):
        // that run's row says "Under review" until then, and nothing names it, so read the list again.
        switch ev.type {
        case .sessionCreated, .sessionUpdated, .sessionEnded:
            if sessions.contains(where: { $0.confirmationUnderReview?.reviewerSessionId == ev.sessionId }) {
                scheduleControlRefresh()
            }
        default:
            break
        }
        // A project's lanes move when one of its tasks does, and an owner item rides the approval
        // count, so a loaded index refetches shortly after either.
        switch ev.type {
        case .taskChanged, .taskListChanged, .approvalRequested, .approvalResolved:
            projects?.nudge()
        default:
            break
        }
        switch ev.type {
        // A task event carries the changed row ids. Fold those exact rows into the loaded page;
        // only an explicit coarse invalidation (or an older/malformed payload) needs a snapshot.
        case .taskChanged:
            // The focused session may have just created the task, or one its card draws moved.
            nudgeCreatedTasks()
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
        // A project changed — including its title or progress — so refresh its summaries.
        case .projectChanged:
            projects?.nudge()
        // A wiki space changed — a proposal filed, ops decided, a binding moved. The event names the
        // space and nothing else, so the loaded Wiki re-reads what it shows (the drawer's number
        // included). It moves no session row: falling through to the snapshot below would be the web's
        // `groupsFor` default of `['sessions']`, a list refetch for an event about something else.
        case .wikiChanged:
            wiki?.nudge()
        #if os(iOS)
        // A folder was created, renamed or deleted, here or on another device: re-read the library
        // the Move panel lists (docs/session-folders-move-design.md §5.6). The event names the folder
        // and nothing else, and a session moved between folders is a `session.updated` of its own,
        // so this refetches no list — `default` below refetched Open and left the folders stale.
        case .folderChanged:
            Task { await loadSessionFolders() }
        #endif
        // AgentsModel.load() fetches the provider catalog with the list; provider edits do not
        // change task-row membership or live overlays.
        case .providerChanged:
            scheduleLibraryRefresh(.agents)
            scheduleControlRefresh()
            // A shared pool's people are told of every change to it — a key going in, a rule — so a
            // pool page that is open shows it. Read only once Providers has asked for the list.
            if sharedPools?.loadState.hasLoaded == true {
                Task { await sharedPools?.load() }
            }
        case .sessionCreated, .sessionUpdated:
            if let summary = ev.payload(ControlSessionSummary.self) {
                // Progress comes from the sidebar read rather than the session summary. Include
                // a former member too, so removing its relation refreshes that project at once.
                if summary.projectMembership.flatMap({ $0 }) != nil
                    || sessions.contains(where: { $0.id == summary.id && $0.projectMembership != nil }) {
                    projects?.nudge()
                }
                // Session state is the authority for a task row's running/queued overlays. The
                // summary names that task on current servers, so starting, claiming and settling a
                // run update one lightweight row instead of waiting for the minute reconciliation.
                if let taskID = summary.taskId {
                    scheduleTaskRefresh([taskID])
                    nudgeCreatedTasks(taskID: taskID)
                }
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

    /// A row saying "Under review" stops saying it when its review's window runs out, which nothing on
    /// the server announces (contract §5 N5): the window is read, never swept. So the list reads again
    /// a second after the earliest such row is due — web's `reviewDueAt` effect.
    private func scheduleReviewDueRefresh(_ list: [Session]) {
        let due = list.compactMap { $0.confirmationUnderReview.flatMap { RelativeTime.parse($0.dueAt) } }.min()
        guard due != reviewDueAt else { return }
        reviewDueAt = due
        reviewDueTask?.cancel()
        reviewDueTask = nil
        guard let due else { return }
        let wait = max(0, due.timeIntervalSinceNow + 1)
        reviewDueTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            self.reviewDueAt = nil
            self.scheduleControlRefresh()
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
        guard summary.projectId != nil || summary.projectTitle != nil || summary.projectMembership != nil else { return }
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

    /// Refresh the Open list, one fetch at a time. A call while one is on the wire doesn't start a
    /// second beside it — the Open list is the app's largest response, and launch alone asks for it
    /// from the poll, the stream connecting and the list appearing. It asks for one more fetch after
    /// that one instead, since the one in flight may have left before whatever the caller refreshes
    /// for (the stream connecting, an event), and every call meanwhile shares it. Each call returns
    /// once a fetch that started after it has finished: true when that fetch adopted a list.
    @discardableResult
    func loadSessions() async -> Bool {
        sessionsLoadPending = true
        if sessionsLoadTask == nil {
            let generation = sessionsLoadGeneration
            sessionsLoadTask = Task { @MainActor [weak self] in
                while let self, self.sessionsLoadGeneration == generation, self.sessionsLoadPending {
                    self.sessionsLoadPending = false
                    self.sessionsLoadSucceeded = await self.fetchOpenSessions()
                }
                if let self, self.sessionsLoadGeneration == generation { self.sessionsLoadTask = nil }
            }
        }
        await sessionsLoadTask?.value
        return sessionsLoadSucceeded
    }

    private func fetchOpenSessions() async -> Bool {
        guard let api else { return false }
        do {
            let list = try await api.listSessions(view: .open)
            openListFromLaunchSnapshot = false
            applySessionSnapshot(list)
            return true
        } catch APIError.unauthorized {
            logout()
        } catch {
            // Transient — keep the last good list.
        }
        return false
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
        if !openListFromLaunchSnapshot { lastSnapshot = list }
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
        if list != sessions { adoptOpenList(list) }
        scheduleReviewDueRefresh(list)
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
            // A server banner's thread id is the session's stored UUID; `needsYou` is list-spelled.
            NotificationManager.removeDeliveredApprovals(where: { !needsYou.contains(PublicID.toPublic($0)) })
            // The foreground card standing in for one of those banners has to come down with them.
            // It's persistent by design, so an approval answered on web or macOS would otherwise
            // leave a card asking for something that's already been decided.
            toasts.clearApprovals(stillWaiting: needsYou)
        }
        #endif
    }

    /// The Open list and everything the drawer and the session lists derive from it. Written by a
    /// fetched snapshot (`applySessionSnapshot`) and by a cold launch's restore, which draws from the
    /// previous run's list without announcing anything from it.
    private func adoptOpenList(_ list: [Session]) {
        sessions = list
        needsYouSessions = SessionGrouping.group(list).needsYou
        agentNeedsYou = NeedsYouLogic.byAgent(list)
        #if os(iOS)
        runningWorkspaceIDs = WorkspaceActivityLogic.runningWorkspaceIDs(list)
        jobWorkspaceIDs = WorkspaceActivityLogic.jobWorkspaceIDs(list)
        projectCoordinators = ProjectAttention.coordinatorPulses(list)
        #endif
        // The agent pane's Open list is this same snapshot narrowed to one agent, so hand it over
        // here instead of leaving it to fetch the identical payload on its own timer.
        agents?.applyOpenSnapshot(list)
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
        if composingAgentSession {
            nav.replaceTop(with: .console(sessionID: session.id, origin: .list))
        } else {
            // The draft an iPad draws at its pane's root has no frame to replace
            // (`AgentConsoleDetail.showsDraft`): its session is selected as a row's is — over a
            // folder's page it goes on top, so the folder stays the column's page.
            selectedAgentSessionID = session.id
        }
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
        show(.compose(agentID: id, folderID: nil), agent: id)
    }

    /// Open the draft composer for the agent pane already on screen (the "New session" toolbar
    /// button): the draft replaces whatever the detail column was showing / pushes onto the stack.
    /// Deliberately not an entry point — it leaves the pane's agent where it is (a draft for the
    /// agent you are looking at, falling back to the first one), so unlike ``show`` it does not move
    /// the section or the agent, only the page.
    ///
    func startComposingSession() {
        guard let id = currentAgentID else { return }
        nav.openDraft(agentID: id, folderID: nil)
    }

    /// ✎ on a folder's page (§3.3): the draft goes *over* the folder — the back swipe returns to it
    /// — and the session it creates is filed in that folder. The workspace comes from the page's
    /// own frame, so the draft is for the workspace the folder belongs to, whatever the pane's
    /// selection has moved on to.
    func startComposingSession(inFolder folderID: String, of agentID: String) {
        nav.openDraft(agentID: agentID, folderID: folderID)
    }

    /// Switch the agent the new-session draft is composing for while staying on the compose page —
    /// the hero's agent switcher. Unlike `openAgent` (which pops back to the agent's session list),
    /// this swaps the draft's own frame for one naming `id`, so the pushed/inline `NewSessionView`
    /// just rebuilds for it (a fresh draft via its `.id(agent.id)`). A folder the draft was opened
    /// from belongs to the old workspace, so the reborn draft files in none.
    func composeWithAgent(_ id: String) {
        show(.compose(agentID: id, folderID: nil), agent: id)
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

    /// The same press, when the bar named one of the four owner items (§7.6 V13): it is going to a
    /// CARD and not only to a conversation.
    ///
    /// Not a fifth way into a console — it opens the same frame through the same entry above, which
    /// is what `NavigationEntrancesWiringTests` holds every entrance to. What it adds is telling
    /// the console which card first, so the read that console runs on appearing is the one that
    /// spends the press: a card delivered by that read is scrolled to as it arrives, rather than a
    /// moment after the reader has looked away.
    func openNeedsYouItem(_ s: Session, _ item: SessionOwnerItem) {
        consoleRegistry?.model(for: s.id, agentID: s.agent?.id ?? s.agentId).focus(ownerItem: item)
        openNeedsYouSession(s)
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

    /// The drawer row the screen belongs to (`NavState.drawerDestination`): the row drawn as
    /// selected, and the one whose tap only closes the drawer.
    var drawerDestination: DrawerDestination { nav.drawerDestination(agentID: selectedAgentID) }

    /// iOS compact: the page on top is its drawer destination's own — a section's list or a
    /// project's sessions page — so the left screen edge opens the drawer; over any page pushed above
    /// it the edge is the system back-swipe's.
    var atDestinationRoot: Bool { nav.atDestinationRoot }

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
        // A project's page over the index: the same one read.
        case .projects: return nav.sectionAtRoot
        // An entry's page, or Review, over the Wiki's home: the same one read.
        case .wiki: return nav.sectionAtRoot
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

    /// What the app's toast host draws (see `toastHost()`): the toasts that wait for you, pinned, and
    /// the one transient toast under them, ruled by `ToastFeed` (docs/mocks/toast-system). A toast
    /// names what happened, then what it happened to — the session, or an entry's title — then any
    /// diagnostic; one that names a session doubles as the way into it, and `canUndo` adds Undo,
    /// where moving to Open is the universal undo (the server's `restore` clears both completion and
    /// trash state).
    private(set) var toasts = ToastFeed()
    @ObservationIgnored private var toastExpiry: Task<Void, Never>?
    @ObservationIgnored private var heldToastID: ToastItem.ID?
    @ObservationIgnored private var toastFold: Task<Void, Never>?

    /// Refresh whichever session lists are on screen (Open always; the agent list if
    /// one has been opened) so a row action reflects immediately instead of waiting for the poll.
    private func reloadSessionLists() async {
        await loadSessions()
        await agents?.reloadCurrentSessions()
        sessionDetails.reconcile(with: agents?.agentSessions ?? [])
        #if os(iOS)
        if let address = nav.projectSessionsColumn { await loadProjectSessions(address) }
        #endif
    }

    /// Float a result as a toast. What it asks of you decides how long it stays (`ToastItem.dwell`),
    /// the same ramp on every client: 3s for a confirmation (web's Message layer, see `main.tsx`) —
    /// even one that names its entry, which is still something you just did and expected — 6s for a
    /// card with an Undo or a diagnostic (web's `sessionNotice`), and a failure or an approval
    /// doesn't leave on a timer at all: it pins, and nothing that comes after it can replace it.
    /// Console-side outcomes arrive here too (see `ConsoleRegistry.onToast`).
    ///
    /// `subtitle` names what a confirmation happened to — a Wiki entry's title. `sessionTitle` is
    /// for a result whose session has already left every loaded scope by the time the card is
    /// built — completing one drops it from Open, so the name has to be taken before the mutation
    /// or the line just disappears. Everything else lets it resolve here. `key` makes one operation
    /// one toast: a result posted with its progress pill's key takes the pill's place.
    func showToast(_ message: String, subtitle: String? = nil, sessionID: String? = nil,
                   sessionTitle: String? = nil, detail: String? = nil, tone: ToastTone = .success,
                   icon: String? = nil, canUndo: Bool = false, awaitsApproval: Bool = false,
                   mergeConflict: ToastMergeConflict? = nil,
                   key: String? = nil, inProgress: Bool = false) {
        let line = subtitle ?? sessionTitle ?? sessionID.flatMap(toastSessionTitle)
        let item = ToastItem(message: message, subtitle: line, detail: detail, tone: tone, icon: icon,
                             sessionID: sessionID, canUndo: canUndo, awaitsApproval: awaitsApproval,
                             key: key, inProgress: inProgress, mergeConflict: mergeConflict)
        guard let id = toasts.post(item, at: Date()), let shown = toasts.item(id) else { return }
        announce(shown)
        if shown.level == .attention {
            foldToastLater(id)
        } else if let dwell = shown.dwell, heldToastID != id {
            expireToastLater(id, after: dwell)
        }
    }

    /// A card that only paints is invisible to VoiceOver — read it out as it arrives, with what it
    /// happened to and the diagnostic, which on a failure is the part worth hearing.
    private func announce(_ toast: ToastItem) {
        let spoken = [toast.message, toast.subtitle, toast.detail].compactMap { $0 }.joined(separator: ". ")
        AccessibilityNotification.Announcement(spoken).post()
    }

    /// Takes the transient toast down when its dwell runs out — unless something replaced it first.
    private func expireToastLater(_ id: ToastItem.ID, after seconds: TimeInterval) {
        toastExpiry?.cancel()
        toastExpiry = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.toasts.expire(id)
        }
    }

    /// On a phone an open ③ card folds into its pill after six seconds: it stops covering the top of
    /// the page and stays one tap away. Wide layouts draw every pinned card open regardless.
    private func foldToastLater(_ id: ToastItem.ID) {
        toastFold?.cancel()
        toastFold = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            guard !Task.isCancelled else { return }
            self?.toasts.fold(id)
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

    /// ✕ or a swipe.
    func dismissToast(_ id: ToastItem.ID) { toasts.dismiss(id) }

    /// A folded ③ pill tapped open; it folds again after six seconds.
    func unfoldToast(_ id: ToastItem.ID) {
        toasts.unfold(id)
        foldToastLater(id)
    }

    /// A finger or pointer resting on a toast keeps it; its dwell starts over when released.
    func holdToast(_ id: ToastItem.ID) {
        guard toasts.transient?.id == id else { return }
        heldToastID = id
        toastExpiry?.cancel()
    }

    func releaseToast(_ id: ToastItem.ID) {
        if heldToastID == id { heldToastID = nil }
        guard let toast = toasts.transient, toast.id == id, let dwell = toast.dwell else { return }
        expireToastLater(id, after: dwell)
    }

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
    func openToastSession(_ id: ToastItem.ID) {
        guard let sessionID = toasts.item(id)?.sessionID else { return }
        toasts.dismiss(id)
        route(to: .session(sessionID))
    }

    /// The conflict card hands the same branch and target to the session as the worktree bar does.
    func resolveToastConflict(_ id: ToastItem.ID) {
        guard let toast = toasts.item(id), let sessionID = toast.sessionID,
              let conflict = toast.mergeConflict, let registry = consoleRegistry else { return }
        toasts.dismiss(id)
        route(to: .session(sessionID))
        Task {
            await registry.resolveInSession(sessionID: sessionID,
                                            branch: conflict.branch, target: conflict.target)
        }
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
                showToast("Couldn't complete the session", sessionID: id, sessionTitle: name,
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
                showToast("Couldn't move to Open", sessionID: id, sessionTitle: name,
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
                showToast("Couldn't move to Trash", sessionID: id, sessionTitle: name,
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
                showToast("Couldn't rename the session", sessionID: id,
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

    func undoSessionAction(_ id: ToastItem.ID) {
        guard let toast = toasts.item(id), toast.canUndo, let sessionID = toast.sessionID else { return }
        moveSessionToOpen(sessionID)
        toasts.dismiss(id)
    }

    // MARK: session folders (iOS — docs/session-folders-move-design.md §3–4)

    #if os(iOS)
    private(set) var projectSessions: [Session] = []
    private(set) var projectSessionsLoading = false
    private(set) var projectSessionsError: String?
    /// The project's landing read, for the summary card's landing line (`ProjectPage.landingLine`).
    private(set) var projectSessionsIntegration: ProjectIntegrationView?
    private(set) var projectSessionsIntegrationReadAt: Date?
    private(set) var projectSessionsIntegrationReadFailed = false
    private var projectSessionsAddress: SessionProjectAddress?

    var projectSessionsColumn: SessionProjectAddress? { nav.projectSessionsColumn }

    func openProjectSessions(_ address: SessionProjectAddress) {
        nav.enterProjectSessions(address)
    }

    /// Every drawer row's tap. The row of the destination already showing only closes the drawer;
    /// any other lands on its destination's root. On a phone that is the destination's whole stack;
    /// in the iPad's sidebar column only the list column changes, and the detail keeps its page.
    func openDrawerDestination(_ destination: DrawerDestination, inColumn: Bool) {
        guard destination != drawerDestination else { return }
        switch destination {
        case .section(let section):
            selectedSection = section
            guard !inColumn else { return }
            nav.popToRoot()
            if section == .tasks { tasks?.selectScope(.all) }
            syncTaskDetailStore()
        case .workspace(let agentID):
            selectedSection = .agents
            if selectedAgentID != agentID {
                selectedAgentID = agentID
                nav.popToRoot()
            } else if inColumn {
                nav.leaveProjectSessions()
            } else {
                nav.popToRoot()
            }
        case .project(let projectID):
            openProjectSessions(projectID, inColumn: inColumn)
        }
    }

    /// A project's sessions page over its coordinator's workspace (or the one already showing).
    /// Without any workspace it opens the project's page.
    private func openProjectSessions(_ projectID: String, inColumn: Bool) {
        let key = PublicID.storageKey(projectID)
        let coordinator = (sessions + (agents?.allSessions ?? [])).first {
            $0.projectMembership?.role == .coordinator
                && $0.projectMembership.map { PublicID.storageKey($0.projectId) } == key
        }
        guard let agentID = coordinator.flatMap({ $0.agent?.id ?? $0.agentId })
                ?? selectedAgentID ?? orderedAgents.first?.id else { return openProject(projectID) }
        selectedSection = .agents
        if selectedAgentID != agentID {
            selectedAgentID = agentID
            nav.popToRoot()
        }
        let address = SessionProjectAddress(projectID: projectID, agentID: agentID, view: .open)
        if inColumn {
            nav.enterProjectSessions(address)
        } else {
            nav.path = [.sessionProject(address)]
        }
    }

    func leaveProjectSessions(_ projectID: String? = nil) {
        nav.leaveProjectSessions(projectID)
    }

    /// Project membership spans Workspaces; this request deliberately has no runner/agent filter.
    func loadProjectSessions(_ address: SessionProjectAddress) async {
        guard let api else { return }
        if projectSessionsAddress != address {
            projectSessionsAddress = address
            projectSessions = []
            projectSessionsError = nil
            projectSessionsIntegration = nil
            projectSessionsIntegrationReadAt = nil
            projectSessionsIntegrationReadFailed = false
        }
        projectSessionsLoading = true
        defer { if projectSessionsAddress == address { projectSessionsLoading = false } }
        let integrationRead = Task { try await api.projectIntegration(address.projectID) }
        defer { integrationRead.cancel() }
        do {
            let openRead = Task { try await api.listSessions(view: .open, projectId: address.projectID) }
            let completedRead = Task { try await api.listSessions(view: .completed, projectId: address.projectID) }
            defer {
                openRead.cancel()
                completedRead.cancel()
            }
            let rows = try await openRead.value + completedRead.value
            guard projectSessionsAddress == address, !Task.isCancelled else { return }
            // An older server may ignore projectId. It must never put unrelated sessions here.
            var seen = Set<String>()
            projectSessions = rows.filter {
                $0.projectMembership?.projectId == address.projectID &&
                    $0.effectiveLifecycleState != .trash && seen.insert($0.id).inserted
            }.sorted { ($0.lastTurnAt ?? $0.createdAt ?? "") > ($1.lastTurnAt ?? $1.createdAt ?? "") }
            projectSessionsError = nil
            for row in projectSessions { sessionDetails.store(row) }
        } catch {
            guard projectSessionsAddress == address, !Task.isCancelled else { return }
            projectSessionsError = APIClient.failureReason(error)
        }
        let integration = try? await integrationRead.value
        guard projectSessionsAddress == address, !Task.isCancelled else { return }
        if let integration {
            projectSessionsIntegration = integration
            projectSessionsIntegrationReadAt = Date()
            projectSessionsIntegrationReadFailed = false
        } else {
            projectSessionsIntegrationReadFailed = true
        }
    }

    /// A member may belong to another Workspace. Carry its record into the console's cache and
    /// change the Workspace without replacing the project page underneath that console.
    func openProjectMember(_ session: Session, push: Bool) {
        sessionDetails.store(session)
        if let agentID = session.agent?.id ?? session.agentId { selectedAgentID = agentID }
        let node = NavNode.console(sessionID: session.id, origin: .list)
        if push { self.push(node) } else { nav.selectConsole(node) }
    }

    /// Load the owner's folder library: when a workspace's session list appears, and again when
    /// `folder.changed` says one was created, renamed or deleted, here or on another device.
    /// Best-effort like the tag library — an older server without the endpoint leaves it empty, and
    /// the Move panel then offers No Folder and New Folder… alone.
    func loadSessionFolders() async {
        guard let api else { return }
        guard let folders = try? await api.listSessionFolders() else { return }
        sessionFolders = folders
        // A folder deleted on another device while its page is up: the page goes back to the
        // workspace's list (§3.3 — the folder is gone, so there is no page to be on). Only an
        // answer that landed can say that; a failed read leaves the library as it stands.
        if let open = nav.folderPage ?? nav.folderColumn,
           !folders.contains(where: { $0.id == open.folderID }) {
            nav.leaveFolder(open.folderID)
        }
    }

    /// The folder page showing on a phone, if one is (design §3.3) — the compact stack's top frame.
    var folderPage: SessionFolderAddress? { nav.folderPage }

    /// The folder the wide shells' session column is showing, if one is — the frame the column's
    /// list draws, with the console the detail pane follows above it. Nil on macOS, which shows no
    /// folders (§1): nothing there ever puts one on the stack.
    var folderColumn: SessionFolderAddress? { nav.folderColumn }

    /// Open a folder's page from a folder row at the top of a workspace's session list (§3.3). One
    /// entry point for both shells: the frame lands at the bottom of the section's stack, which is
    /// the page on top on a phone and the list's page in a wide shell's column.
    func openFolder(_ address: SessionFolderAddress) {
        nav.enterFolder(address)
    }

    /// Back out of a folder's page — the wide shell's column back button. A phone's system back
    /// pops the frame itself, and lands here all the same through `nav.path`.
    func leaveFolder(_ folderID: String? = nil) {
        nav.leaveFolder(folderID)
    }

    /// File a session in one of its workspace's folders, or in none (`folderID` nil) — the Move
    /// panel's tap. The row moves at once: the folder is written into every loaded copy before the
    /// request goes, and written back as it was if the server refuses. Either way the lists are
    /// re-read afterwards, which settles what the server holds.
    func moveSession(_ id: String, toFolder folderID: String?) {
        guard let api, let row = session(id: id), row.folderId != folderID else { return }
        let origin = row.folderId
        let name = toastSessionTitle(id)
        let moved = SessionMoveCopy.moved(to: sessionFolder(folderID), from: sessionFolder(origin))
        patchSessionFolder(id, to: folderID)
        Task { @MainActor in
            do {
                try await api.moveSession(id, folderID: folderID)
                showToast(moved, sessionID: id, sessionTitle: name, tone: .info, icon: "folder")
            } catch {
                patchSessionFolder(id, to: origin)
                showToast(SessionMoveCopy.moveFailed, sessionID: id, sessionTitle: name,
                          detail: APIClient.failureReason(error), tone: .error)
            }
            await reloadSessionLists()
        }
    }

    /// New Folder… in the Move panel: create the folder in the session's workspace, then move the
    /// session into it. Nil once the folder exists and the move is under way; otherwise why the
    /// folder wasn't created, as the sentence the panel shows (`SessionMoveCopy.createFailure` — a
    /// name the workspace already has is said as such).
    func createSessionFolder(named name: String, in workspace: Agent, moving sessionID: String) async -> String? {
        guard let api else { return nil }
        do {
            let folder = try await api.createSessionFolder(workspaceID: workspace.id, name: name)
            if !sessionFolders.contains(where: { $0.id == folder.id }) { sessionFolders.append(folder) }
            moveSession(sessionID, toFolder: folder.id)
            return nil
        } catch {
            return SessionMoveCopy.createFailure(error, name: name, workspace: workspace.name)
        }
    }

    /// New Folder… in the list's ≡ menu (§3.4): make the folder in this workspace and nothing else —
    /// the row appears at the top of the Open list, empty. Nil once it exists; otherwise why it
    /// wasn't created, in the same words the Move panel uses (`SessionMoveCopy.createFailure`).
    func createSessionFolder(named name: String, in workspace: Agent) async -> String? {
        guard let api else { return nil }
        do {
            let folder = try await api.createSessionFolder(workspaceID: workspace.id, name: name)
            if !sessionFolders.contains(where: { $0.id == folder.id }) { sessionFolders.append(folder) }
            return nil
        } catch {
            return SessionMoveCopy.createFailure(error, name: name, workspace: workspace.name)
        }
    }

    /// Rename… (§3.4): the folder's new name, everywhere it is read. Nil once the server has it;
    /// otherwise why it wasn't renamed, in one sentence (`SessionFolderCopy.renameFailure` — a name
    /// its workspace already has is said as such).
    func renameSessionFolder(_ id: String, to name: String) async -> String? {
        guard let api else { return nil }
        do {
            let renamed = try await api.renameSessionFolder(id, name: name)
            if let index = sessionFolders.firstIndex(where: { $0.id == id }) {
                sessionFolders[index] = renamed
            } else {
                sessionFolders.append(renamed)
            }
            return nil
        } catch {
            let workspace = sessionFolders.first { $0.id == id }
                .flatMap { folder in agents?.agent(folder.workspaceId)?.name } ?? "this workspace"
            return SessionFolderCopy.renameFailure(error, name: name, workspace: workspace)
        }
    }

    /// Delete Folder… (§3.4): the folder goes, the sessions in it stay — the server clears their
    /// `folder_id` (the column's `ON DELETE SET NULL`), and the list draws them loose again the
    /// moment the folder leaves the library (`SessionFolderGrouping.listing`). Nil once it is gone;
    /// otherwise why it wasn't deleted. The page comes down with it (§3.3).
    func deleteSessionFolder(_ id: String) async -> String? {
        guard let api else { return nil }
        do {
            try await api.deleteSessionFolder(id)
        } catch {
            return SessionFolderCopy.deleteFailure(error)
        }
        sessionFolders.removeAll { $0.id == id }
        nav.leaveFolder(id)
        // The rows it held were drawn behind its row a moment ago; read the lists again so they are
        // back in the time sections even if an event from another device hasn't landed yet.
        Task { await reloadSessionLists() }
        return nil
    }

    private func sessionFolder(_ id: String?) -> SessionFolder? {
        guard let id else { return nil }
        return sessionFolders.first { $0.id == id }
    }

    /// Write a folder into every loaded copy of a row, as `patchSessionTitle` writes a title: the Open
    /// snapshot (and through it the pane's Open list), the pane's own Completed list, and the cold-route
    /// detail cache.
    private func patchSessionFolder(_ id: String, to folderID: String?) {
        if let index = sessions.firstIndex(where: { $0.id == id }) {
            var list = sessions
            list[index] = list[index].settingFolder(folderID)
            applySessionSnapshot(list)
        }
        if let cached = sessionDetails.resolve(id) { sessionDetails.store(cached.settingFolder(folderID)) }
        agents?.applyMovedSession(id, folderID: folderID)
    }

    // MARK: moving a session to another workspace (iOS — docs/session-folders-move-design.md §4, §5)

    /// What the Move panel's second group lists and its confirmation says (`GET /sessions/:id/
    /// move-targets`): each other workspace with whether the session can go there and why not, and
    /// whether it has to be ended first. Throws what the server answered, for the panel to say.
    func sessionMoveTargets(_ id: String) async throws -> SessionMoveTargets {
        guard let api else { throw APIError.notConfigured }
        return try await api.sessionMoveTargets(id)
    }

    /// New Folder… on a workspace's page in the Move panel: a folder in the workspace the session is
    /// about to move to, which the confirmation then files it in. Throws the server's refusal — a name
    /// that workspace already has is a 409 — for the page to put into words.
    func createTargetFolder(named name: String, inWorkspace workspaceID: String) async throws -> SessionFolder {
        guard let api else { throw APIError.notConfigured }
        let folder = try await api.createSessionFolder(workspaceID: workspaceID, name: name)
        if !sessionFolders.contains(where: { $0.id == folder.id }) { sessionFolders.append(folder) }
        return folder
    }

    /// Move a session to another workspace, filed in one of its folders or in none — the
    /// confirmation's Move, or its End and Move (§5.3–5.4): end the session, wait until it has
    /// ended, then move it (`SessionWorkspaceMove.run`). `phase` follows those steps for the panel.
    ///
    /// Nil once the session is there: every loaded copy of the row names the new workspace, which
    /// takes it out of the list it was moved from at once, the toast says where it went, and the
    /// lists are read again behind it. Otherwise why not, as the sentence the panel shows — the lists
    /// are read again all the same, since an End and Move stopped after the end has still ended the
    /// session.
    func moveSession(_ id: String, to target: SessionMoveTarget, folder folderID: String?,
                     endingFirst: Bool,
                     phase: @escaping (SessionWorkspaceMove.Phase) -> Void) async -> String? {
        guard let api else { return SessionMoveCopy.moveFailed(APIError.notConfigured) }
        let name = toastSessionTitle(id)
        let outcome = await SessionWorkspaceMove.run(
            endingFirst: endingFirst,
            end: { try await api.endSession(id) },
            status: { try await api.session(id).effectiveRunStatus },
            move: { try await api.moveSession(id, toWorkspace: target.workspaceId, folderID: folderID) },
            phase: { phase($0) })
        defer { Task { await reloadSessionLists() } }
        switch outcome {
        case .moved:
            patchSessionWorkspace(id, to: target, folder: folderID)
            showToast(SessionMoveCopy.movedToWorkspace(target.name), sessionID: id, sessionTitle: name,
                      tone: .info, icon: "folder")
            return nil
        case .failed(let reason):
            return reason
        }
    }

    /// Write a move to another workspace into every loaded copy of a row, as `patchSessionFolder`
    /// writes a folder: the Open snapshot — whose agent filter is what takes the row out of the
    /// workspace's Open list — the pane's own Completed rows, and the detail cache.
    private func patchSessionWorkspace(_ id: String, to target: SessionMoveTarget, folder folderID: String?) {
        let workspace = agents?.agent(target.workspaceId)
        let moved = { (row: Session) in
            row.settingWorkspace(id: target.workspaceId, name: target.name, model: workspace?.model,
                                 effort: workspace?.effort, folder: folderID)
        }
        if let index = sessions.firstIndex(where: { $0.id == id }) {
            var list = sessions
            list[index] = moved(list[index])
            applySessionSnapshot(list)
        }
        if let cached = sessionDetails.resolve(id) { sessionDetails.store(moved(cached)) }
        agents?.applyMovedSession(id, toWorkspace: target.workspaceId)
    }
    #endif

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
        // frame a row pushed by hand is still a write to it — as is a task page a console pushes
        // over itself on a phone (its "Tasks created here" rows), which reads the same store the
        // moment it appears. Otherwise guarded, because that store is read off the stack *on
        // screen*: syncing while another section's non-task page goes up would name nil and drop
        // the detail a still-pushed Tasks page is about to read (the section switch re-syncs it).
        if nav.section == .tasks || nav.taskDetailOnTop != nil { syncTaskDetailStore() }
    }

    /// One page of every task `sessionID`'s agent created — the list a console's `View all in
    /// Tasks ›` pushes over itself on a phone. Nil before sign-in.
    func tasksCreated(inSession sessionID: String, cursor: String?) async throws -> TaskPage? {
        guard let api else { return nil }
        return try await api.taskPage(cursor: cursor, limit: 50, counts: .none, creatorSessionId: sessionID)
    }

    /// Open one project's page from outside the Projects list: the section's list at the root and
    /// the project on top, whatever was showing there before.
    func openProject(_ id: String) {
        selectedSection = .projects
        nav.path = [.projectDetail(projectID: id)]
    }

    /// The project line on a task's page. Over that project's own page — one of its rows opened the
    /// task, on the phone's Projects stack or in the wide shells' Projects pane — it goes back down
    /// to that page instead of stacking a second copy of it; anywhere else it opens the project.
    func openTaskProject(_ id: String) {
        if nav.returnToProject(id) { return }
        openProject(id)
    }

    /// A project's page opened from inside a conversation — a coordinator conversation's title, a
    /// project link in a transcript — or from a project's sessions page. On a phone (`overConsole`)
    /// it is pushed over that page, so the back swipe returns to it; on the wide shells it opens in
    /// the Projects section, whose sidebar is the way back.
    func openProjectFromConversation(_ id: String, overConsole: Bool) {
        let id = PublicID.toPublic(id)
        guard overConsole else { return openProject(id) }
        push(.projectDetail(projectID: id))
    }

    /// Open a project's coordinator conversation, and — when a press named one of the owner's items
    /// — land on that item's card there: the same entry the needs-you banner takes, so a card is
    /// answered in one place.
    ///
    /// A project page a phone opened over this very conversation goes back down to it: putting the
    /// conversation on top again would stack a second copy of it over the first.
    func openProjectCoordinator(sessionID: String, agentID: String?, focus item: SessionOwnerItem? = nil,
                                focusStartCard: Bool = false) {
        let id = PublicID.toPublic(sessionID)
        let agent = agentID.map(PublicID.toPublic) ?? self.agentID(for: id)
        if let item { consoleRegistry?.model(for: id, agentID: agent).focus(ownerItem: item) }
        // The start card is the same kind of landing — Review on the project page's request to
        // start — through the same door, so the page it opens is the one Answer's opens.
        if focusStartCard { consoleRegistry?.model(for: id, agentID: agent).focusStartCard() }
        if nav.returnToConsole(id) { return }
        show(.console(sessionID: id, origin: .list), agent: agent)
    }

    /// Open one wiki entry's page from outside the Wiki's home — an `orbit-wiki:` link. On a phone a
    /// link in a conversation pushes it over that console, so the back swipe returns to it; anywhere
    /// else it opens in the Wiki section, the home at the root and the entry on top.
    func openWikiEntry(_ id: String, overConsole: Bool = false) {
        if overConsole {
            push(.wikiEntry(entryID: id))
            return
        }
        selectedSection = .wiki
        nav.path = [.wikiEntry(entryID: id)]
    }

    /// The project's page on the web — a signed-in address, for the project menu's Copy Link.
    func projectWebURL(_ projectID: String) -> URL? {
        baseURL?.appendingPathComponent("projects").appendingPathComponent(PublicID.toPublic(projectID))
    }

    /// The task's page on the web — a signed-in address, for the task menu's Copy Link.
    func taskWebURL(_ taskID: String) -> URL? {
        baseURL?.appendingPathComponent("tasks").appendingPathComponent(PublicID.toPublic(taskID))
    }

    /// The session's signed-in address, separate from its public sharing link.
    func sessionWebURL(_ sessionID: String) -> URL? {
        baseURL?.appendingPathComponent("sessions").appendingPathComponent(PublicID.toPublic(sessionID))
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
        // A link or a notification goes somewhere, and Settings would cover it — and while Settings
        // is up a push lands on its stack, not on the route's.
        settingsPresented = false
        selectedSection = AppSection.forRoute(route)
        switch route {
        case .active:          if selectedAgentID == nil { selectedAgentID = orderedAgents.first?.id }
        // A push names its session by the stored UUID (an APNs body never passes the server's
        // public-id rewrite), while every list row and detail record spells it base62 — and the
        // console finds its record by `==`. A UUID frame found none, so its header fell back to the
        // agent's name. The frame takes the lists' spelling here, once, for everything downstream.
        case .session(let id): openSession(PublicID.toPublic(id))
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
            // …and a project's task goes on over its project's page once its row says so.
            rehomeProjectTask(id)
        case .list(let id):
            // A named list is a scope of the Tasks page, not a page of its own: the scope follows the
            // link, and any task page that was open comes off so the list is what is showing. The
            // filter is opened up the way a task route opens it — somebody following a link to a list
            // wants the list, not just the part of it that happens to be runnable.
            taskListsDirectoryPresented = false
            tasks?.selectScope(.list(id))
            tasks?.filter = .all
            selectedTaskID = nil
        case .runner(let id):  selectedRunnerID = id
        case .watch(let id):   openWatch(id)
        }
    }

    /// A task a route opened in Tasks, moved over its project's page once its row says it has one.
    ///
    /// Tasks' every-task scope is the tasks outside projects (2026-09-26), so a project's task routed
    /// there — a notification, a link, ⌘K, a dependency jumped to from another task's page — sits
    /// over a list it is not in, and back lands on that list. The web sends `/tasks/<id>` on to the
    /// project's page for the same reason. The route still lands at once; the row read (the light
    /// one, without comments or runs) says where the task lives, and when that is a project and the
    /// reader is still on this task, it moves over the project's page — the pair the project's own
    /// rows push. A task in no project, a server without the row route, or a reader who has moved
    /// on: nothing moves.
    private func rehomeProjectTask(_ id: String) {
        guard let api else { return }
        Task { @MainActor [weak self] in
            guard let row = try? await api.taskRow(id), let project = row.projectId else { return }
            guard let self, self.selectedSection == .tasks,
                  self.selectedTaskID.map(PublicID.storageKey) == PublicID.storageKey(id) else { return }
            self.nav.moveTaskOverProject(id, project: PublicID.toPublic(project))
            // The section's setter re-points the detail store at the task now on screen — the same
            // task, so its page does not load again.
            self.selectedSection = .projects
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
        refreshUnlistedSession(id, adoptingAgent: true)
    }

    /// Another session's conversation over the one on screen — a link in a conversation, on a phone —
    /// so the back swipe returns to the conversation the link was in rather than to a session list.
    /// Its record is refreshed as a route's is; the agent whose sessions the stack's root lists is
    /// left alone, since that list is under both conversations.
    func pushConsole(_ id: String) {
        let id = PublicID.toPublic(id)
        guard nav.focusedConsoleSessionID != id else { return }
        push(.console(sessionID: id, origin: .conversation))
        refreshUnlistedSession(id, adoptingAgent: false)
    }

    /// What a page opened from inside a conversation does — a link in it, a row of its Watching or
    /// Tasks created here card. On a phone (`overConsole`, which the console's own environment says;
    /// the model is not told its shell) a task or another session is pushed over the console, so the
    /// back swipe returns to the conversation. Anything else, and every page on the wide shells,
    /// goes where ``route(to:)`` sends it: their sidebar is the way back.
    func openFromConversation(_ route: Route, overConsole: Bool) {
        guard overConsole else { return self.route(to: route) }
        switch route {
        case .task(let id):    push(.taskDetail(taskID: id))
        case .session(let id): pushConsole(id)
        default:               self.route(to: route)
        }
    }

    /// The exact refresh a session opened from outside its list gets. The Open snapshot is already
    /// control-plane refreshed; everything else (including an old detail-cache hit) is read again so
    /// repeated search/deep-link navigation cannot resurrect stale lifecycle or capability state.
    /// `adoptingAgent`: a route also makes the session's agent the one whose sessions are listed.
    private func refreshUnlistedSession(_ id: String, adoptingAgent: Bool) {
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
                guard adoptingAgent, self.selectedSection == .agents,
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
    ///
    /// A landing the launch snapshot made is decided again here, unless something has been opened
    /// over it since — a draft or a console makes it a place someone chose to be.
    private func resolveDefaultLanding() {
        guard !didResolveDefaultLanding, let agents else { return }
        let landing = LoadFailureLogic.defaultLanding(
            agents: agents.loadState,
            orderedAgentIDs: orderedAgents.map(\.id),
            lastAgentID: UserDefaults.standard.string(forKey: Self.lastAgentKey),
            section: selectedSection,
            selectedAgentID: selectedAgentID,
            selectedSessionID: selectedAgentSessionID,
            provisionalAgentID: nav.sectionAtRoot ? provisionalLandingAgentID : nil)
        switch landing {
        case .undecided: return
        case .keepCurrent: break
        case .agent(let id): if selectedAgentID != id { selectedAgentID = id }
        case .runners: selectedSection = .runners
        }
        didResolveDefaultLanding = true
        provisionalLandingAgentID = nil
    }

    /// Draw a cold launch from what the previous run left (`persistLaunchSnapshot`): the account, the
    /// workspace list and the Open sessions, landed on the workspace you were in — so the first frame
    /// is that workspace's session list rather than a spinner. Nothing here is treated as an answer:
    /// the launch's own fetches replace every list as they land, and the landing made here is only
    /// provisional (see `resolveDefaultLanding`). Nothing is announced off this list either: see
    /// `openListFromLaunchSnapshot`.
    private func restoreLaunchSnapshot() {
        guard let snapshot = launchSnapshots?.load(), let agents else { return }
        let landing = snapshot.landingAgentID(
            lastAgentID: UserDefaults.standard.string(forKey: Self.lastAgentKey))
        user = snapshot.user
        // Points the landing's list at its Open rows, which `adoptOpenList` then fills.
        agents.adoptLaunchSnapshot(snapshot, showing: landing)
        openListFromLaunchSnapshot = true
        adoptOpenList(snapshot.openSessions)
        guard let landing else { return }
        provisionalLandingAgentID = landing
        selectedAgentID = landing
    }

    /// Write what the next cold launch draws first. Called as the app leaves the foreground — the
    /// last moment it is sure of the CPU — and synchronous for the same reason
    /// `ConsoleRegistry.persistAll` is. Only once this run's workspace fetch has answered: a run that
    /// never reached the server leaves the previous snapshot as it was.
    func persistLaunchSnapshot() {
        guard signedIn, let agents, agents.loadState.hasLoaded, let launchSnapshots else { return }
        launchSnapshots.save(LaunchSnapshot(user: user, agents: agents.items,
                                            runnerNames: agents.runnerNames,
                                            runnerOrder: agents.runnerOrder,
                                            openSessions: sessions))
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
