import Foundation
import Observation
import OrbitKit

/// Drives the Agents section: the list (grouped by runner via OrbitKit `AgentListLogic`) plus
/// edit/delete. Owned by `AppModel` so the list and the edit form share it. Also fetches runner
/// names (best-effort) for the group headers.
@MainActor
@Observable
final class AgentsModel {
    private(set) var items: [Agent] = []
    private(set) var runnerNames: [String: String] = [:]
    /// runnerId → is-online, for the drawer's collapsible runner rows (a leading connection dot).
    /// Populated from the same best-effort `runners()` fetch that feeds `runnerNames`.
    private(set) var runnerOnline: [String: Bool] = [:]
    /// runnerId → runtime model catalog, reported by that runner.
    private(set) var runnerModelCatalog: [String: RunnerModelCatalog] = [:]
    /// Control-plane–configured providers (custom slugs borrowing a built-in runtime), merged into
    /// the agent editor's Runtime/Model pickers alongside claude/codex. Loaded with the agent list;
    /// left empty by an older server without the endpoint.
    private(set) var configuredProviders: [ConfiguredProvider] = []
    private(set) var loading = false
    var errorText: String?

    // The selected agent's sessions for the current Active/Completed/System view.
    private(set) var agentSessions: [Session] = []
    private(set) var sessionsLoading = false
    /// The last (agent, view) `loadSessions` ran for, so a row action can silently refresh the same
    /// list without the view having to thread the agent id / tab back in.
    private var lastSessionQuery: (agentID: String, view: SessionView)?

    private let api: APIClient

    init(baseURL: URL, tokenStore: TokenStore) {
        api = APIClient(baseURL: baseURL, tokenStore: tokenStore)
    }

    var groups: [AgentGroup] { AgentListLogic.grouped(items) }

    /// Display name for a group header (runner display-name, else id, else "Shared" for host).
    func runnerLabel(_ runnerId: String?) -> String {
        guard let id = runnerId else { return "Shared" }
        return runnerNames[id] ?? id
    }

    /// Whether a runner is currently reachable — drives the drawer runner row's connection dot.
    /// Host-level agents (nil runner) and not-yet-loaded runners read as offline (no green dot).
    func runnerIsOnline(_ runnerId: String?) -> Bool {
        guard let id = runnerId else { return false }
        return runnerOnline[id] ?? false
    }

    func modelCatalog(for runnerId: String?) -> RunnerModelCatalog? {
        guard let id = runnerId else { return nil }
        return runnerModelCatalog[id]
    }

    func agent(_ id: String) -> Agent? { items.first { $0.id == id } }

    func load() async {
        loading = true
        defer { loading = false }
        do {
            items = try await api.agents()
            // Best-effort: map runner ids → names (group headers) and → online (connection dots).
            if let runners = try? await api.runners() {
                runnerNames = Dictionary(runners.map { ($0.id, $0.displayName ?? $0.name) },
                                         uniquingKeysWith: { a, _ in a })
                runnerOnline = Dictionary(runners.map { ($0.id, $0.online ?? ($0.status == .online)) },
                                          uniquingKeysWith: { a, _ in a })
                runnerModelCatalog = Dictionary(
                    runners.compactMap { r in r.modelCatalog.map { (r.id, $0) } },
                    uniquingKeysWith: { a, _ in a })
            }
            // Best-effort too: a transient failure keeps the last good list rather than blanking
            // the pickers (mirrors the runners fetch above).
            if let providers = try? await api.providers() { configuredProviders = providers }
        } catch { errorText = friendly(error) }
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
    /// Active, so it re-appears there naturally).
    func registerCreatedSession(_ session: Session) {
        guard !agentSessions.contains(where: { $0.id == session.id }) else { return }
        agentSessions.insert(session, at: 0)
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
            let all = try await api.listSessions(view: view.queryValue)
            agentSessions = SessionFilter.forAgent(all, agentID: agentID, view: view)
        } catch { errorText = friendly(error) }
    }

    /// Silently refresh the currently-shown session list (after a pin/complete/delete row action).
    /// No-op until a list has been loaded.
    func reloadCurrentSessions() async {
        guard let q = lastSessionQuery else { return }
        await loadSessions(agentID: q.agentID, view: q.view)
    }

    private func friendly(_ error: Error) -> String {
        if case APIError.unauthorized = error { return "Session expired — sign in again." }
        return "Request failed — check your connection."
    }
}
