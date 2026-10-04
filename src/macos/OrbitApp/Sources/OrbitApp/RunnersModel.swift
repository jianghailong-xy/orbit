import Foundation
import Observation
import OrbitKit

/// Drives the Runners + Skills sections and a runner's pages: the runner list (with quota/slots) plus
/// the agents used for Skills grouping, headers and a runner's Workspaces, and every press a runner
/// page makes — capacity, engines, accounts, token, removal, the list's order, adding a machine.
/// Owned by `AppModel`; shared by both sections.
@MainActor
@Observable
final class RunnersModel {
    private(set) var runners: [Runner] = []
    private(set) var agents: [Agent] = []
    /// GET /sessions/counts: each workspace's Open sessions — a runner's Workspaces rows say how many
    /// are running (`RunnerPageFormat.runningCount`).
    private(set) var sessionCounts: [WorkspaceSessionCounts] = []
    /// The runner release the instance publishes (`APIClient.runnerReleaseVersion`), read once.
    private(set) var publishedVersion: String?
    private var releaseVersionRead = false
    /// How the runner-list fetches have gone, so a failed fetch never reads as "No runners"
    /// (`LoadFailureLogic.presentation`).
    private(set) var loadState = ListLoadState()
    var errorText: String?

    private let api: APIClient

    init(baseURL: URL, tokenStore: TokenStore) {
        api = APIClient(baseURL: baseURL, tokenStore: tokenStore)
    }

    func runner(_ id: String) -> Runner? { runners.first { $0.id == id } }
    func agentName(_ id: String) -> String { agents.first { $0.id == id }?.name ?? id }
    func agents(forRunner id: String) -> [Agent] { agents.filter { $0.runnerId == id } }

    /// The newest runner release anyone can see: what the instance publishes, or any of this account's
    /// runners' own version, whichever is newer (`RunnerAttention.latestRunnerVersion`).
    var latestVersion: String? { RunnerAttention.latestRunnerVersion(publishedVersion, runners: runners) }

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

    /// Once per model: a manifest that can't be read is ordinary — the fleet's own versions still say
    /// what the latest is.
    func loadReleaseVersion() async {
        guard !releaseVersionRead else { return }
        releaseVersionRead = true
        publishedVersion = await api.runnerReleaseVersion()
    }

    /// The running counts; a failed read keeps the last ones rather than showing none.
    func loadSessionCounts() async {
        if let counts = try? await api.sessionCounts() { sessionCounts = counts }
    }

    // MARK: presses — each answers nil once it went through, else why not, in a sentence

    @discardableResult
    func setMaxConcurrent(_ id: String, _ n: Int) async -> String? {
        await press { _ = try await self.api.updateRunner(id, UpdateRunnerRequest(maxConcurrent: n)) }
    }

    /// Keep Free: the reserve under which task runs stop being sent here — nil turns it off.
    @discardableResult
    func setKeepFree(_ id: String, _ mb: Int?) async -> String? {
        let floor: FieldUpdate<Int>
        if let mb { floor = .set(mb) } else { floor = .clear }
        return await press { _ = try await self.api.updateRunner(id, UpdateRunnerRequest(minFreeDiskMb: floor)) }
    }

    /// An empty name clears the alias: the runner goes back to its machine's name.
    @discardableResult
    func rename(_ id: String, _ displayName: String) async -> String? {
        await press { _ = try await self.api.updateRunner(id, UpdateRunnerRequest(displayName: displayName)) }
    }

    @discardableResult
    func delete(_ id: String) async -> String? {
        await press { try await self.api.deleteRunner(id) }
    }

    /// A new credential for the machine, returned exactly once.
    func rotateToken(_ id: String) async -> Result<String, RunnerPressFailure> {
        do {
            return .success(try await api.rotateRunnerToken(id).token)
        } catch {
            return .failure(RunnerPressFailure(reason: APIClient.failureReason(error)))
        }
    }

    /// Every engine CLI on the machine, now rather than on the updater's next half-hour pass.
    @discardableResult
    func updateEngines(_ id: String) async -> String? {
        await press { _ = try await self.api.startEngineUpdate(id) }
    }

    /// The machine re-reads its CLIs' model lists; the new ones arrive on a later check-in.
    @discardableResult
    func refreshModels(_ id: String) async -> String? {
        await press { _ = try await self.api.refreshRunnerModels(id) }
    }

    /// A stuck checkout rescued to a branch and put back on its last commit.
    @discardableResult
    func repair(_ workspaceId: String) async -> String? {
        await press { _ = try await self.api.repoCleanup(workspaceId: workspaceId) }
    }

    /// One account's name, Default's included. Only a label, kept by the control plane: it asks
    /// nothing of the machine, so it works with the runner offline.
    @discardableResult
    func renameAccount(_ id: String, engine: LoginEngine, account: String, name: String) async -> String? {
        await press { _ = try await self.api.renameRunnerAccount(id, engine: engine, account: account, name: name) }
    }

    func pauseAccount(_ id: String, engine: LoginEngine, account: String, durationMinutes: Int?) async -> String? {
        await press {
            try await self.api.pauseRunnerAccount(id, engine: engine, account: account,
                                                  durationMinutes: durationMinutes)
        }
    }

    /// One account off the machine. A refusal the machine makes itself (a session is running on it)
    /// comes back as its own words.
    @discardableResult
    func removeAccount(_ id: String, engine: LoginEngine, account: String) async -> String? {
        do {
            let state = try await api.removeRunnerAccount(id, engine: engine, account: account)
            await load()
            return state.status == "failed" ? state.message : nil
        } catch {
            return APIClient.failureReason(error)
        }
    }

    /// The list in a new order: the rows move at once, and the server's answer — every runner, in the
    /// order it keeps — settles it.
    func reorder(_ ids: [String]) async {
        let before = runners
        runners = ids.compactMap { id in before.first { $0.id == id } }
        do {
            runners = try await api.reorderRunners(ids)
        } catch {
            runners = before
            errorText = APIClient.failureReason(error)
        }
    }

    // MARK: adding a machine

    /// What `orbit register` asked to register under a code, before anyone approves it.
    func device(_ userCode: String) async -> Result<DeviceInfo, RunnerPressFailure> {
        do {
            return .success(try await api.deviceEnrollment(userCode: userCode))
        } catch {
            return .failure(RunnerPressFailure(reason: APIClient.failureReason(error)))
        }
    }

    @discardableResult
    func approveDevice(_ userCode: String) async -> String? {
        await press { try await self.api.approveDevice(userCode: userCode) }
    }

    private func press(_ op: @escaping () async throws -> Void) async -> String? {
        do {
            try await op()
            await load()
            return nil
        } catch {
            return APIClient.failureReason(error)
        }
    }

    private func friendly(_ error: Error) -> String {
        if case APIError.unauthorized = error { return "Session expired — sign in again." }
        return "Request failed — check your connection."
    }
}

/// Why a press on a runner didn't go through, in a sentence (`APIClient.failureReason`).
struct RunnerPressFailure: Error {
    let reason: String
}
