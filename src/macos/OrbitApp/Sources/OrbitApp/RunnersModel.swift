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
    /// Told every list `load` reads: the app's runner snapshot takes it, so a page polling the runners
    /// and the app's tick do not each read `/runners` (`AppModel.adoptRunnerRows`).
    @ObservationIgnored var onRead: (([Runner]) -> Void)?

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
            onRead?(runners)
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

    /// GET /runners/:id/resources, by runner: a runner page's Resources (`MachineResources`).
    private(set) var resources: [String: RunnerResourcesAnswer] = [:]

    /// A failed read keeps the last answer rather than showing none.
    func loadResources(_ id: String) async {
        if let answer = try? await api.runnerResources(id) { resources[id] = answer }
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

    /// Install the pinned DeepSeek Harness CLI on the machine (the same install relay as Antigravity's).
    @discardableResult
    func installDsh(_ id: String) async -> String? {
        await press { _ = try await self.api.installDsh(id) }
    }

    /// Install one engine's CLI on the machine — the same relay, for an engine it doesn't have.
    @discardableResult
    func installEngine(_ id: String, engine: String) async -> String? {
        await press { _ = try await self.api.installEngine(id, engine: engine) }
    }

    /// The machine re-reads its CLIs' model lists; the new ones arrive on a later check-in.
    @discardableResult
    func refreshModels(_ id: String) async -> String? {
        await press { _ = try await self.api.refreshRunnerModels(id) }
    }

    /// The machine checks for its own release now rather than at its next 10-minute check — by the
    /// same rules, so a turn in flight still holds the install.
    @discardableResult
    func updateRunner(_ id: String) async -> String? {
        await press { _ = try await self.api.requestRunnerSelfUpdate(id) }
    }

    /// Later: the machine ends its drain for the waiting release now and puts it off until `until`, in
    /// the reader's zone (the server caps it at 09:00 tomorrow). Nil once taken; else why not.
    @discardableResult
    func postponeUpdate(_ id: String, until: Date) async -> String? {
        await press { _ = try await self.api.postponeRunnerSelfUpdate(id, until: until) }
    }

    /// Update Now: the machine interrupts the reader's turns in flight, installs the waiting release and
    /// restarts; each interrupted turn continues once it is back. Nil once taken; else why not.
    @discardableResult
    func updateNow(_ id: String) async -> String? {
        await press { _ = try await self.api.updateRunnerNow(id) }
    }

    /// The runners whose Check again is on its way (`checkRegion`): their presses hold until the check
    /// they asked for is answered.
    private(set) var regionChecking: Set<String> = []

    /// Check again (docs/claude-region-check-contract.md §7): the runner checks its Claude region at
    /// once, and the answer lands in `Runner.region` like any other check's — so the runners are read
    /// again every two seconds until that one's `checkedAt` reaches the request, for up to 30 seconds.
    /// Nil once asked; else why not (offline, too old to check), in the server's words.
    func checkRegion(_ id: String) async -> String? {
        guard !regionChecking.contains(id) else { return nil }
        regionChecking.insert(id)
        defer { regionChecking.remove(id) }
        let asked: ClaudeRegionCheckRequest
        do {
            asked = try await api.requestRunnerRegionCheck(id)
        } catch {
            return APIClient.failureReason(error)
        }
        let askedAt = asked.requestedAt ?? ISO8601DateFormatter().string(from: Date())
        let started = Date()
        while !Task.isCancelled, Date().timeIntervalSince(started) < ClaudeRegion.checkWait {
            try? await Task.sleep(for: .seconds(ClaudeRegion.checkPollInterval))
            await load()
            if ClaudeRegion.checkAnswered(checkedAt: runner(id)?.region?.checkedAt, askedAt: askedAt) { break }
        }
        return nil
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

    /// One account off the machine — or Default off Orbit's list alone, which asks nothing of the
    /// machine and so works with the runner offline. A refusal the machine makes itself (a session is
    /// running on it) comes back as its own words, and the control plane's (Default with no other account
    /// beside it) as its own.
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

    /// Use again: the Default removed from Orbit back in its use. Orbit's own record, as the removal is,
    /// so it works with the runner offline too.
    @discardableResult
    func restoreDefault(_ id: String, engine: LoginEngine) async -> String? {
        await press { try await self.api.restoreRunnerDefault(id, engine: engine) }
    }

    /// Dismiss an engine's update warning until its next release. Orbit's own record, so it works with
    /// the runner offline; the list read after it carries the dismissal, which quiets the warning.
    @discardableResult
    func dismissEngineUpdateWarning(_ id: String, engine: String) async -> String? {
        await press { try await self.api.dismissEngineUpdateWarning(id, engine: engine) }
    }

    /// Fix with an agent: one press starts the session, then the list is read again — its `agentFix`
    /// carries the session as `fixing`, which turns the button into the fixing line. Nothing navigates.
    /// A refusal (a 409's own sentence) comes back to show, and the list is read again then too.
    @discardableResult
    func fixAttention(_ id: String, target: RunnerAgentFixTarget) async -> String? {
        let body = RunnerAgentFixLogic.request(target, latestVersion: latestVersion)
        let failure = await press { _ = try await self.api.fixRunnerAttention(id, kind: target.kind, body: body) }
        if failure != nil { await load() }
        return failure
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

    /// Nothing is added, and `orbit register` on that machine stops.
    @discardableResult
    func denyDevice(_ userCode: String) async -> String? {
        await press { try await self.api.denyDevice(userCode: userCode) }
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
