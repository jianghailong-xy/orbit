import Foundation
import Observation
import OrbitKit

/// Settings → Access tokens: every personal access token this account has issued, and the one press
/// the apps make on them — revoking one, say for a laptop that was lost. Issuing is the web's alone
/// (docs/personal-access-token-design.md §9). Owned by `AppModel`, like the other per-account lists,
/// so the count on Settings' row and the page it opens read the same answer.
@MainActor
@Observable
final class AccessTokensModel {
    private(set) var tokens: [AccessToken] = []
    /// How the list fetches have gone, so a failed fetch never reads as "No active tokens".
    private(set) var loadState = ListLoadState()
    var errorText: String?
    /// The token whose revoke is on its way, so its row can say so and not be pressed twice.
    private(set) var revokingID: String?

    private let api: APIClient

    init(baseURL: URL, tokenStore: TokenStore) {
        api = APIClient(baseURL: baseURL, tokenStore: tokenStore)
    }

    /// The tokens that still work — nil until a fetch has answered.
    var activeCount: Int? {
        loadState.hasLoaded ? AccessTokensList.tokens(tokens, in: .active).count : nil
    }

    func load() async {
        loadState.begin()
        do {
            tokens = try await api.accessTokens()
            errorText = nil
            loadState.succeed()
        } catch {
            errorText = AccessTokensList.couldNotLoad + " " + APIClient.failureReason(error)
            loadState.fail()
        }
    }

    /// Revoke this token. Answers nil once it is revoked, else why it isn't. The list is read again
    /// either way, so it shows what the server has.
    func revoke(_ token: AccessToken) async -> String? {
        revokingID = token.id
        defer { revokingID = nil }
        do {
            try await api.revokeAccessToken(token.id)
            await load()
            return nil
        } catch {
            let reason = APIClient.failureReason(error)
            await load()
            return reason
        }
    }
}
