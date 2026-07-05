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

    func agent(_ id: String) -> Agent? { items.first { $0.id == id } }

    func load() async {
        loading = true
        defer { loading = false }
        do {
            items = try await api.agents()
            // Best-effort: map runner ids → names for the group headers.
            if let runners = try? await api.runners() {
                runnerNames = Dictionary(runners.map { ($0.id, $0.displayName ?? $0.name) },
                                         uniquingKeysWith: { a, _ in a })
            }
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
    /// `reset` distinguishes the first fetch (after an agent/view switch) from a background poll:
    /// the first fetch clears the stale list and shows "Loading…"; polls refresh silently so a list
    /// that legitimately has no sessions doesn't flash the spinner every tick.
    func loadSessions(agentID: String, view: SessionView, reset: Bool = false) async {
        lastSessionQuery = (agentID, view)
        if reset {
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
