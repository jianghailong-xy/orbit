import Foundation
import Observation
import OrbitKit

/// Settings → Terminals: the terminals approved on this account (docs/terminal-session-design.md, "The terminal
/// credential"), and the one press on them — Revoke. Owned by `AppModel`, like Access tokens, so Settings' row and the
/// page it opens read the same answer. Web parity: `TerminalsCard.tsx`.
@MainActor
@Observable
final class TerminalsModel {
    private(set) var terminals: [Terminal] = []
    /// How the list fetches have gone, so a failed fetch never reads as "No terminals are signed in."
    private(set) var loadState = ListLoadState()
    var errorText: String?
    /// The terminal whose revoke is on its way, so its row can say so and not be pressed twice.
    private(set) var revokingID: String?

    private let api: APIClient

    init(baseURL: URL, tokenStore: TokenStore) {
        api = APIClient(baseURL: baseURL, tokenStore: tokenStore)
    }

    /// How many are signed in — nil until a fetch has answered.
    var count: Int? { loadState.hasLoaded ? terminals.count : nil }

    func load() async {
        loadState.begin()
        do {
            terminals = try await api.terminals()
            errorText = nil
            loadState.succeed()
        } catch {
            errorText = Terminals.couldNotLoad + " " + APIClient.failureReason(error)
            loadState.fail()
        }
    }

    /// Revoke this terminal. Answers nil once it is revoked, else why it isn't. The list is read again either way, so
    /// it shows what the server has — a revoked terminal is no longer in it.
    func revoke(_ terminal: Terminal) async -> String? {
        revokingID = terminal.id
        defer { revokingID = nil }
        do {
            try await api.revokeTerminal(terminal.id)
            await load()
            return nil
        } catch {
            let reason = APIClient.failureReason(error)
            await load()
            return reason
        }
    }

    #if DEBUG
    /// Probe and preview fixtures: the list as a read would have answered it.
    func seed(_ terminals: [Terminal]) {
        self.terminals = terminals
        loadState.succeed()
    }
    #endif
}
