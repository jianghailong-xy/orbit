import Foundation
import Observation
import OrbitKit

/// The signed-in owner's managed runner (docs/managed-runner-design.md, "Server and three client
/// interfaces"). Owned by `AppModel` like the other per-account stores and read again by its polling
/// task: the capability first, and only when it offers managed runners the status — every few
/// seconds while the state moves by itself, every half minute otherwise. With the capability
/// missing or off nothing else is ever read and `display` stays nil, so every screen that asks is
/// what it was. A read that fails is no managed UI, never a wait.
@MainActor
@Observable
final class ManagedRunnerModel {
    /// The status as the server last answered, and its display (`ManagedRunnerLogic.display`).
    private(set) var status: ManagedRunnerStatus?
    private(set) var display: ManagedRunnerDisplay?
    /// A Retry or Set up is in flight.
    private(set) var acting = false
    /// Why the last Retry or Set up did not go through, in the server's words.
    var errorText: String?
    /// A Set up was accepted: the mapping brings its runner and default workspace with it.
    @ObservationIgnored var onEnsured: () -> Void = {}

    private let api: APIClient
    private var offered: Bool?
    private var capabilityReadAt = Date.distantPast
    private var refreshNotBefore = Date.distantPast

    /// The switch changes only when the server restarts; read the capability again this rarely.
    private static let capabilityInterval: TimeInterval = 300

    init(baseURL: URL, tokenStore: TokenStore) {
        api = APIClient(baseURL: baseURL, tokenStore: tokenStore)
    }

    /// What a console shows: nil unless `runnerID` is the managed runner's (`ManagedRunnerLogic.console`).
    func console(runnerID: String?, agentID: String?, isDraft: Bool) -> ManagedRunnerConsole? {
        ManagedRunnerLogic.console(status: status, runnerID: runnerID, agentID: agentID, isDraft: isDraft)
    }

    /// Called by the app's polling task, which stops on sign-out.
    func refreshIfDue(now: Date = Date()) async {
        guard now >= refreshNotBefore else { return }
        // Claimed before awaiting, so a re-entrant tick cannot start a second read.
        refreshNotBefore = now.addingTimeInterval(ManagedRunnerLogic.pollSeconds.settled)
        await load(now: now)
    }

    func load(now: Date = Date()) async {
        if offered == nil || now.timeIntervalSince(capabilityReadAt) >= Self.capabilityInterval {
            // A failed read is no capability until the next one.
            offered = ManagedRunnerLogic.offered(try? await api.serverCapabilities())
            capabilityReadAt = now
        }
        guard offered == true else {
            adopt(nil)
            return
        }
        do {
            adopt(try await api.managedRunnerStatus())
        } catch {
            adopt(nil)
        }
    }

    /// Retry a failure the server allows it for, with the revision it was read at.
    func retry() async {
        guard let status, display?.retry == true, !acting else { return }
        await act { try await self.api.retryManagedRunner(revision: status.revision) }
    }

    /// Ask for a managed runner where the server offers one.
    func ensure() async {
        guard display?.ensure == true, !acting else { return }
        if await act({ try await self.api.ensureManagedRunner() }) { onEnsured() }
    }

    /// Signed out: nothing of this account's is shown to the next one.
    func reset() {
        status = nil
        display = nil
        errorText = nil
        offered = nil
        refreshNotBefore = .distantPast
    }

    @discardableResult
    private func act(_ request: () async throws -> ManagedRunnerStatus) async -> Bool {
        acting = true
        defer { acting = false }
        do {
            adopt(try await request())
            errorText = nil
            return true
        } catch {
            errorText = "Couldn't reach the managed runner: " + APIClient.failureReason(error)
            await load()
            return false
        }
    }

    private func adopt(_ answer: ManagedRunnerStatus?) {
        status = answer
        display = ManagedRunnerLogic.display(answer)
        refreshNotBefore = Date().addingTimeInterval(ManagedRunnerLogic.refreshInterval(display))
    }
}
