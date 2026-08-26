import Foundation
import Observation
import OrbitKit

/// Drives the Agents section: its Workspace list plus edit/delete. macOS keeps the historical
/// runner grouping; iOS flattens the same stable order and shows Runner as row metadata instead.
/// Owned by `AppModel` so the list and the edit form share it. Runner names are best-effort.
@MainActor
@Observable
final class AgentsModel {
    private(set) var items: [Agent] = []
    private(set) var runnerNames: [String: String] = [:]
    /// Runner ids in the order `GET /runners` returns them (the user's persisted runner order), so
    /// flat iOS Workspace rows and macOS groups match the web sidebar. Empty until that fetch lands,
    /// which leaves Runner order first-seen.
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
    private(set) var loading = false
    var errorText: String?

    // The selected agent's sessions for the current Open/Completed/Trash view.
    private(set) var agentSessions: [Session] = []
    private(set) var sessionsLoading = false
    /// The last (agent, view) `loadSessions` ran for, so a row action can silently refresh the same
    /// list without the view having to thread the agent id / tab back in.
    private var lastSessionQuery: (agentID: String, view: SessionView)?

    private let api: APIClient

    init(baseURL: URL, tokenStore: TokenStore) {
        api = APIClient(baseURL: baseURL, tokenStore: tokenStore)
    }

    var groups: [AgentGroup] { AgentListLogic.grouped(items, runnerOrder: runnerOrder) }
    var orderedItems: [Agent] { AgentListLogic.ordered(items, runnerOrder: runnerOrder) }

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
            for: provider, catalog: catalog, configured: configuredProviders,
            runtimeDefaults: runnerId.flatMap { runnerRuntimeDefaultModels[$0] })
    }

    func agent(_ id: String) -> Agent? { items.first { $0.id == id } }

    func load() async {
        loading = true
        defer { loading = false }
        do {
            items = try await api.agents()
            await refreshRunnerSnapshot()
            // Best-effort too: a transient failure keeps the last good list rather than blanking
            // the pickers (mirrors the runners fetch above).
            if let providers = try? await api.providers() {
                configuredProviders = providers
                configuredProvidersLoaded = true
            }
        } catch { errorText = friendly(error) }
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

    /// Grant or revoke session orchestration across every agent at once, then reload so the count
    /// in Settings reflects what was actually written. Returns how many agents changed hands, nil
    /// on failure (the message lands in `errorText`).
    func setOrchestrationForAll(_ enabled: Bool) async -> Int? {
        do {
            let updated = try await api.setOrchestrationForAllAgents(enabled: enabled)
            await load()
            return updated
        } catch { errorText = friendly(error); return nil }
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
            agentSessions = []
            sessionsLoading = true
        }
        defer { sessionsLoading = false }
        do {
            let all = try await api.listSessions(view: view)
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
    /// (`lastSessionQuery == nil`) is left alone — its `.task` owns the first load.
    func applyOpenSnapshot(_ all: [Session]) {
        guard let q = lastSessionQuery, q.view == .open else { return }
        agentSessions = SessionFilter.forAgent(all, agentID: q.agentID, view: q.view)
    }

    private func friendly(_ error: Error) -> String {
        if case APIError.unauthorized = error { return "Session expired — sign in again." }
        return "Request failed — check your connection."
    }
}
