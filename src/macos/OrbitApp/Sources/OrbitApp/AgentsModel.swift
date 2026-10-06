import Foundation
import Observation
import OrbitKit

/// Drives the Agents section: its Workspace list plus edit/delete. macOS keeps the historical
/// runner grouping; iOS follows the web's workspace order and shows Runner as row metadata.
/// Owned by `AppModel` so the list and the edit form share it. Runner names are best-effort.
@MainActor
@Observable
final class AgentsModel {
    private(set) var items: [Agent] = []
    private(set) var runnerNames: [String: String] = [:]
    /// Runner ids in the order `GET /runners` returns them, for the macOS sidebar's groups.
    /// Empty until that fetch lands, which leaves Runner order first-seen.
    private(set) var runnerOrder: [String] = []
    /// runnerId → is-online, for iOS Workspace folder badges.
    /// Populated from the same best-effort `runners()` fetch that feeds `runnerNames`.
    private(set) var runnerOnline: [String: Bool] = [:]
    /// runnerId → runtime model catalog, reported by that runner.
    private(set) var runnerModelCatalog: [String: RunnerModelCatalog] = [:]
    /// runnerId → runtime → the effective default reported by the latest heartbeat.
    private(set) var runnerRuntimeDefaultModels: [String: [String: String]] = [:]
    /// `load()` and the iOS availability cadence may meet at an await boundary. Keep their identical
    /// Runner reads single-flight so an older response cannot overwrite a newer one.
    private var runnerSnapshotRefreshInFlight = false
    /// Control-plane–configured providers (custom slugs borrowing a built-in runtime), merged into
    /// the agent editor's Runtime picker and composer model picker alongside claude/codex. Loaded
    /// with the agent list; left empty by an older server without the endpoint.
    private(set) var configuredProviders: [ConfiguredProvider] = []
    /// Distinguishes an authoritative empty provider list from a request that has not succeeded.
    /// Unknown slugs must not be irreversibly treated as removed before this becomes true.
    private(set) var configuredProvidersLoaded = false
    /// The user's account pools (GET /providers/pools), loaded with the providers. Kept out of
    /// `configuredProviders`, whose other readers (the workspace rows, a task's provider menu) list
    /// keys: a new-session draft is what offers pools, and the draft seed resolves a workspace that
    /// runs on one through them.
    private(set) var providerPools: [ProviderPool] = []
    /// The shared Codex pools this account is in (GET /providers/shared-pools), read into their own
    /// model. A new-session draft offers them beside the account pools (`allPools`), and the
    /// Providers page lists them on their own — which is why the two are kept apart here.
    private(set) var sharedPools: [SharedPool] = []
    /// Every pool a new-session draft may offer, in web's order: the shared ones drawn as account
    /// pools whose members are their keys (`SharedPools.asProviderPool`), then this account's own.
    var allPools: [ProviderPool] { SharedPools.asProviderPools(sharedPools) + providerPools }
    /// The account's own providers as its key list reads them (GET /providers/mine), with the ids and
    /// endpoints the catalogue above leaves out: what tells a DeepSeek key, and what its balance is
    /// asked by. Read for Settings → Providers (`loadDeepSeekBalances`).
    private(set) var personalProviders: [ConfiguredProvider] = []
    /// Each DeepSeek key's account balance by provider id, as the server last answered — or why it
    /// didn't. Absent until asked, which a page reads as loading.
    private(set) var deepSeekBalances: [String: ProviderBalanceReading] = [:]
    /// How the workspace-list fetches have gone: tells a failed fetch from an empty list, and holds
    /// the launch landing open until one succeeds (`LoadFailureLogic`).
    private(set) var loadState = ListLoadState()
    var loading: Bool { loadState.loading }
    var errorText: String?

    // The selected agent's sessions for the current Open/Completed/Trash view.
    private(set) var agentSessions: [Session] = []
    #if os(iOS)
    /// The same scope across every Workspace, for project wording and coordinator placement.
    private(set) var allSessions: [Session] = []
    #endif
    private(set) var sessionsLoading = false
    /// The last (agent, view) `loadSessions` ran for, so a row action can silently refresh the same
    /// list without the view having to thread the agent id / tab back in.
    private var lastSessionQuery: (agentID: String, view: SessionView)?
    /// The app's latest Open snapshot (`applyOpenSnapshot`), kept whichever list is on screen: an
    /// agent's Open list is that snapshot narrowed to the agent, so a first load of one can start
    /// from its rows instead of a blank "Loading…".
    private var openSnapshot: [Session]?
    /// The app's Open-list refresh (`AppModel.loadSessions`), answering the list it adopted — nil
    /// when that fetch failed. An Open list loads through it, so the app fetches that list once.
    @ObservationIgnored var refreshOpen: (@MainActor () async -> [Session]?)?

    private let api: APIClient

    init(baseURL: URL, tokenStore: TokenStore) {
        api = APIClient(baseURL: baseURL, tokenStore: tokenStore)
    }

    var groups: [AgentGroup] { AgentListLogic.grouped(items, runnerOrder: runnerOrder) }
    var orderedItems: [Agent] { AgentListLogic.ordered(items, runnerOrder: runnerOrder) }
    /// What the workspace list shows where its rows would be: a failed fetch is never "no workspaces".
    var listPresentation: ListLoadPresentation {
        LoadFailureLogic.presentation(loadState, isEmpty: items.isEmpty)
    }

    /// Display name for a group header (runner display-name, else id, else "Shared" for host).
    func runnerLabel(_ runnerId: String?) -> String {
        guard let id = runnerId else { return "Shared" }
        return runnerNames[id] ?? id
    }

    /// Whether a runner is authoritatively known to be offline. A missing runner relation and a
    /// runner whose directory row has not loaded yet are both "unknown", not offline — otherwise
    /// Workspace folders flash a false disconnect badge while the best-effort runners fetch lands.
    func runnerIsOffline(_ runnerId: String?) -> Bool {
        WorkspaceRunnerAvailabilityLogic.isOffline(runnerID: runnerId,
                                                    onlineByRunnerID: runnerOnline)
    }

    func modelCatalog(for runnerId: String?) -> RunnerModelCatalog? {
        guard let id = runnerId else { return nil }
        return runnerModelCatalog[id]
    }

    /// The default used to seed a new-session draft. Configured providers keep their own model
    /// space/default; built-in providers use the owning runner's Runtime heartbeat snapshot.
    func effectiveDefaultModel(for agent: Agent) -> String {
        return effectiveDefaultModel(for: agent.defaultProvider, runnerId: agent.runnerId)
    }

    /// The same resolver for an in-progress Agent edit, whose Runtime may differ from the saved
    /// Agent. This keeps model-dependent controls (notably Auto permission mode) aligned with the
    /// model that new Sessions will actually inherit.
    func effectiveDefaultModel(for provider: String, runnerId: String?) -> String {
        let catalog = modelCatalog(for: runnerId)
        return AgentDefaults.effectiveDefaultModel(
            for: provider, catalog: catalog,
            configured: configuredProviders + ProviderPools.asProviders(allPools),
            runtimeDefaults: runnerId.flatMap { runnerRuntimeDefaultModels[$0] })
    }

    func agent(_ id: String) -> Agent? { items.first { $0.id == id } }

    // MARK: a DeepSeek key's account balance

    /// The account's own keys read again, and the balance of each DeepSeek key among them: the server's
    /// last read of it, which the providers holding one key share.
    func loadDeepSeekBalances() async {
        guard let mine = try? await api.personalProviders() else { return }
        personalProviders = mine
        for provider in mine where DeepSeekBalance.applies(to: provider) {
            if let id = provider.providerID { await readBalance(id, refresh: false) }
        }
    }

    /// One key's balance asked of DeepSeek again (the server lets that through once per 10 s for a key),
    /// and read again for the other providers holding the same key, which share it.
    func refreshDeepSeekBalance(_ id: String) async {
        await readBalance(id, refresh: true)
        guard case .answered(let answer)? = deepSeekBalances[id] else { return }
        for sibling in answer.sharedWith ?? [] { await readBalance(sibling.id, refresh: false) }
    }

    private func readBalance(_ id: String, refresh: Bool) async {
        do {
            deepSeekBalances[id] = .answered(try await api.providerBalance(id, refresh: refresh))
        } catch {
            deepSeekBalances[id] = .unreachable(APIClient.failureReason(error))
        }
    }

    // MARK: a Codex pool of one's own — its ChatGPT account (migration 0323)

    /// The pools read again: an account went in or out, or a pool went.
    func reloadPools() async {
        if let pools = try? await api.providerPools() { providerPools = pools }
    }

    func pausePoolMember(_ pool: ProviderPool, member: PoolMember, durationMinutes: Int?) async -> String? {
        do {
            try await api.pausePoolMember(poolID: pool.id, memberID: member.id, durationMinutes: durationMinutes)
            await reloadPools()
            return nil
        } catch {
            return APIClient.failureReason(error)
        }
    }

    /// "Sign in with ChatGPT": the page to open and the one-time code, from the server's device sign-in.
    func startCodexLogin(_ pool: ProviderPool) async throws -> CodexLoginAttempt {
        try await api.startCodexLogin(poolID: pool.id)
    }

    func pollCodexLogin(_ pool: ProviderPool) async throws -> CodexLoginPoll {
        try await api.pollCodexLogin(poolID: pool.id)
    }

    /// Best-effort: a sign-in nobody finishes also runs out on the server by itself.
    func cancelCodexLogin(_ pool: ProviderPool) async {
        _ = try? await api.cancelCodexLogin(poolID: pool.id)
    }

    /// Sign one of the pool's accounts out: the server deletes the sign-in it held, and the pool's other
    /// accounts stay. Why it didn't, or nil.
    func signOutCodexLogin(_ pool: ProviderPool, _ login: CodexLogin) async -> String? {
        do {
            try await api.signOutCodexLogin(poolID: pool.id, fingerprint: login.fingerprint)
            await reloadPools()
            return nil
        } catch {
            return APIClient.failureReason(error)
        }
    }

    /// Delete one of the account's own pools: it is gone from the list. Why it didn't, or nil.
    func deletePool(_ pool: ProviderPool) async -> String? {
        do {
            try await api.deleteProviderPool(pool.id)
            let key = PublicID.storageKey(pool.id)
            providerPools.removeAll { PublicID.storageKey($0.id) == key }
            return nil
        } catch {
            return APIClient.failureReason(error)
        }
    }

    func load() async {
        loadState.begin()
        do {
            items = try await api.agents()
            await refreshRunnerSnapshot()
            // Best-effort too: a transient failure keeps the last good list rather than blanking
            // the pickers (mirrors the runners fetch above).
            if let providers = try? await api.providers() {
                configuredProviders = providers
                configuredProvidersLoaded = true
            }
            if let pools = try? await api.providerPools() { providerPools = pools }
            if let shared = try? await api.sharedPools() { sharedPools = shared }
            loadState.succeed()
        } catch {
            errorText = friendly(error)
            loadState.fail()
        }
    }

    /// Take what a cold launch restores (`AppModel.restoreLaunchSnapshot`): the workspace list and
    /// its runner labels as the previous run had them, with the list pointed at the Open sessions of
    /// the workspace the launch lands on — the app's Open snapshot then fills its rows before the
    /// first frame. `loadState` is left alone: none of this is an answer from the server, and
    /// `load()` replaces it all.
    func adoptLaunchSnapshot(_ snapshot: LaunchSnapshot, showing agentID: String?) {
        items = snapshot.agents
        runnerNames = snapshot.runnerNames
        runnerOrder = snapshot.runnerOrder
        if let agentID { lastSessionQuery = (agentID, .open) }
    }

    /// Refresh only the Runner directory fields consumed by navigation and runtime defaults. This
    /// is intentionally separate from `load()`: iOS can keep online/offline current without
    /// repeatedly fetching the full Workspace and provider libraries. Failure preserves the last
    /// authoritative snapshot, so a transient network gap never manufactures an offline state.
    func refreshRunnerSnapshot() async {
        guard !runnerSnapshotRefreshInFlight else { return }
        runnerSnapshotRefreshInFlight = true
        defer { runnerSnapshotRefreshInFlight = false }
        guard let runners = try? await api.runners() else { return }
        let order = runners.map(\.id)
        let names = Dictionary(runners.map { ($0.id, $0.displayName ?? $0.name) },
                               uniquingKeysWith: { a, _ in a })
        let online = Dictionary(runners.compactMap { runner in
            WorkspaceRunnerAvailabilityLogic.onlineValue(
                explicit: runner.online, status: runner.status).map { (runner.id, $0) }
        }, uniquingKeysWith: { a, _ in a })
        let catalogs = Dictionary(
            runners.compactMap { r in r.modelCatalog.map { (r.id, $0) } },
            uniquingKeysWith: { a, _ in a })
        let runtimeDefaults = Dictionary(
            runners.compactMap { r in r.runtimeDefaultModels.map { (r.id, $0) } },
            uniquingKeysWith: { a, _ in a })
        // Observation invalidates on assignment even when values compare equal. Most 15s refreshes
        // are unchanged, so only write the fields that moved and leave the visible navigation calm.
        if order != runnerOrder { runnerOrder = order }
        if names != runnerNames { runnerNames = names }
        if online != runnerOnline { runnerOnline = online }
        if catalogs != runnerModelCatalog { runnerModelCatalog = catalogs }
        if runtimeDefaults != runnerRuntimeDefaultModels {
            runnerRuntimeDefaultModels = runtimeDefaults
        }
    }

    func save(_ id: String, _ req: UpdateAgentRequest) async {
        do { _ = try await api.updateAgent(id, req); await load() }
        catch { errorText = friendly(error) }
    }

    func delete(_ id: String) async {
        do { try await api.deleteAgent(id); await load() }
        catch { errorText = friendly(error) }
    }

    /// Start a new session for an agent from the draft composer. The runner is derived server-side
    /// from the agent (no `assignedRunnerId` needed). Returns the new session on success, nil on
    /// failure (the message lands in `errorText`).
    func createSession(_ req: CreateSessionRequest) async -> Session? {
        do { return try await api.createSession(req) }
        catch { errorText = friendly(error); return nil }
    }

    /// Prepend a just-created session to the current list so the selection that opens its console has
    /// a matching row *immediately*. The session list is bound to `List(selection:)`, which doubles as
    /// the collapsed-split detail-push driver on iPhone; a selection whose id isn't a row can be reset
    /// back to nil by the List, dropping the freshly-pushed console to the "Select a session" empty
    /// state until the next poll. Deduped; the 4s poll reconciles ordering/fields (the session is
    /// Open, so it re-appears there naturally).
    func registerCreatedSession(_ session: Session) {
        guard !agentSessions.contains(where: { $0.id == session.id }) else { return }
        agentSessions.insert(session, at: 0)
    }

    /// Show a just-typed title on this pane's row. The Open list is handed down whole from the app's
    /// snapshot (`applyOpenSnapshot`), but Completed / Trash are this pane's own query — so those rows
    /// would otherwise keep the old name until the next fetch. See `AppModel.renameSession`.
    func applyRenamedSession(_ id: String, title: String) {
        guard let index = agentSessions.firstIndex(where: { $0.id == id }) else { return }
        agentSessions[index] = agentSessions[index].settingTitle(title)
    }

    #if os(iOS)
    /// File this pane's row in a folder on the spot, for the same reason: a Completed row isn't in
    /// the Open snapshot. See `AppModel.moveSession`.
    func applyMovedSession(_ id: String, folderID: String?) {
        guard let index = agentSessions.firstIndex(where: { $0.id == id }) else { return }
        agentSessions[index] = agentSessions[index].settingFolder(folderID)
    }

    /// Take a row moved to another workspace out of this pane's list, which is one workspace's — for
    /// the same reason: a Completed row isn't in the Open snapshot. See `AppModel.moveSession(_:to:…)`.
    func applyMovedSession(_ id: String, toWorkspace workspaceID: String) {
        guard lastSessionQuery?.agentID != workspaceID else { return }
        agentSessions = SessionFilter.removing(id, from: agentSessions)
    }
    #endif

    /// Update relation metadata even in this pane's independently loaded Completed/Trash rows.
    /// Open rows are refreshed through `applyOpenSnapshot`, but those two scopes otherwise wait for
    /// their polling interval after a coordinator rotation or Project deletion.
    func applyProjectRelation(_ summary: ControlSessionSummary) {
        guard let index = agentSessions.firstIndex(where: { $0.id == summary.id }) else { return }
        let merged = agentSessions[index].applyingProjectRelation(summary)
        if merged != agentSessions[index] { agentSessions[index] = merged }
    }

    /// Remove a session after its exact detail endpoint returned 404. The current Completed / Trash
    /// list may otherwise retain a tappable ghost row until its next successful polling response.
    func discardSession(_ id: String) {
        agentSessions = SessionFilter.removing(id, from: agentSessions)
    }

    /// Load one agent's sessions for a view. The list endpoint filters by view only, so narrow to
    /// the agent client-side (the payload nests `agent.id`), mirroring the web agent console.
    ///
    /// Stale-while-revalidate: `reset` asks to blank the list and show "Loading…", but only when the
    /// rows on screen are for a *different* (agent, view) than the one requested — a genuine scope
    /// switch or the cold first load. Re-entering the same list (e.g. navigating back from a console)
    /// keeps the cached rows up and refreshes them in place, so "back" is instant and holds scroll
    /// position instead of flashing an empty spinner. Background polls pass `reset: false` and never
    /// blank, so a list that legitimately has no sessions doesn't flash the spinner every tick.
    func loadSessions(agentID: String, view: SessionView, reset: Bool = false) async {
        // Only the initial (`reset`) fetch of a *different* list blanks; re-entering the same one
        // revalidates in place. Compare before overwriting `lastSessionQuery` with the new query.
        let sameList = lastSessionQuery.map { $0.agentID == agentID && $0.view == view } ?? false
        lastSessionQuery = (agentID, view)
        if reset && !sameList {
            // With the app's Open snapshot in hand an Open list has its rows already: show them and
            // let the fetch below refresh them in place.
            if view == .open, let openSnapshot {
                agentSessions = SessionFilter.forAgent(openSnapshot, agentID: agentID, view: view)
            } else {
                agentSessions = []
                sessionsLoading = true
            }
        }
        defer { sessionsLoading = false }
        // The app already keeps the Open list: refresh it through the app's one fetch rather than
        // a second of the same list beside it. A failed one falls through to this list's own, which
        // says what went wrong.
        if view == .open, let refreshOpen, let all = await refreshOpen() {
            adoptOpen(all, agentID: agentID)
            return
        }
        do {
            let all = try await api.listSessions(view: view)
            #if os(iOS)
            allSessions = all
            #endif
            agentSessions = SessionFilter.forAgent(all, agentID: agentID, view: view)
        } catch { errorText = friendly(error) }
    }

    /// Silently refresh the currently-shown session list (after a pin/complete/delete row action).
    /// No-op until a list has been loaded.
    func reloadCurrentSessions() async {
        guard let q = lastSessionQuery else { return }
        await loadSessions(agentID: q.agentID, view: q.view)
    }

    /// Adopt the app's shared Open snapshot for the list currently on screen.
    ///
    /// `loadSessions` fetches EVERY open session and narrows client-side (the endpoint has no
    /// per-agent filter), which is exactly the payload `AppModel` already holds — so the pane's own
    /// timer was re-requesting an identical response on a second, independent cadence. Feeding it
    /// from there instead makes the pane as fresh as the control-plane stream (rows update the
    /// moment an event lands, not up to 4s later) for none of the traffic.
    ///
    /// Open only: Completed / Trash are different queries with their own ordering and rows the Open
    /// snapshot doesn't contain, so those keep fetching for themselves. A pane that hasn't loaded yet
    /// (`lastSessionQuery == nil`) is left alone — its `.task` owns the first load, which starts from
    /// the snapshot kept here.
    func applyOpenSnapshot(_ all: [Session]) {
        openSnapshot = all
        guard let q = lastSessionQuery, q.view == .open else { return }
        adoptOpen(all, agentID: q.agentID)
    }

    /// `applyOpenSnapshot` for a list that differs from the last one in one row, held by the
    /// workspaces in `workspaceIDs` (before and after, which differ only for a move): the pane's own
    /// list is re-read only when it is one of them.
    func applyOpenRow(_ all: [Session], workspaceIDs: Set<String?>) {
        openSnapshot = all
        guard let q = lastSessionQuery, q.view == .open else { return }
        #if os(iOS)
        allSessions = all
        #endif
        guard workspaceIDs.contains(q.agentID) else { return }
        let mine = SessionFilter.forAgent(all, agentID: q.agentID, view: .open)
        if agentSessions != mine { agentSessions = mine }
    }

    /// Write the Open list only where it changed: Observation invalidates on assignment, equal or
    /// not, and the list redraws for each — a change in another workspace leaves this one's rows.
    private func adoptOpen(_ all: [Session], agentID: String) {
        #if os(iOS)
        if allSessions != all { allSessions = all }
        #endif
        let mine = SessionFilter.forAgent(all, agentID: agentID, view: .open)
        if agentSessions != mine { agentSessions = mine }
    }

    private func friendly(_ error: Error) -> String {
        if case APIError.unauthorized = error { return "Session expired — sign in again." }
        return "Request failed — check your connection."
    }
}
