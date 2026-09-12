import Foundation
import Observation
import OrbitKit

/// Drives the Runners + Skills sections: the runner list (with quota/slots) plus the agents used
/// for Skills grouping + headers, and the runner mutations (rename, concurrency, rotate token,
/// delete, enrollment). Owned by `AppModel`; shared by both sections.
@MainActor
@Observable
final class RunnersModel {
    private(set) var runners: [Runner] = []
    private(set) var agents: [Agent] = []
    /// How the runner-list fetches have gone, so a failed fetch never reads as "No runners"
    /// (`LoadFailureLogic.presentation`).
    private(set) var loadState = ListLoadState()
    var errorText: String?
    /// A freshly-minted runner token or enrollment token — surfaced once for the user to copy.
    var revealedToken: String?

    private let api: APIClient

    init(baseURL: URL, tokenStore: TokenStore) {
        api = APIClient(baseURL: baseURL, tokenStore: tokenStore)
    }

    func runner(_ id: String) -> Runner? { runners.first { $0.id == id } }
    func agentName(_ id: String) -> String { agents.first { $0.id == id }?.name ?? id }
    func agents(forRunner id: String) -> [Agent] { agents.filter { $0.runnerId == id } }

    func load() async {
        loadState.begin()
        do {
            runners = try await api.runners()
            agents = (try? await api.agents()) ?? agents
            loadState.succeed()
        } catch {
            errorText = friendly(error)
            loadState.fail()
        }
    }

    func setMaxConcurrent(_ id: String, _ n: Int) async {
        await mutate { _ = try await self.api.updateRunner(id, UpdateRunnerRequest(maxConcurrent: n)) }
    }
    func rename(_ id: String, _ displayName: String) async {
        await mutate { _ = try await self.api.updateRunner(id, UpdateRunnerRequest(displayName: displayName)) }
    }
    func rotateToken(_ id: String) async {
        do { revealedToken = try await api.rotateRunnerToken(id).token }
        catch { errorText = friendly(error) }
    }
    func delete(_ id: String) async {
        await mutate { try await self.api.deleteRunner(id) }
    }
    func createEnrollmentToken(label: String?) async {
        do { revealedToken = try await api.createEnrollmentToken(CreateEnrollmentTokenRequest(label: label)).token }
        catch { errorText = friendly(error) }
    }

    private func mutate(_ op: @escaping () async throws -> Void) async {
        do { try await op(); await load() }
        catch { errorText = friendly(error) }
    }

    private func friendly(_ error: Error) -> String {
        if case APIError.unauthorized = error { return "Session expired — sign in again." }
        return "Request failed — check your connection."
    }
}
