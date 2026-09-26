import Foundation
import Observation
import OrbitKit

/// Settings → Shared links: every public link this account has made, and the one press the list
/// makes on them — turning links off. Owned by `AppModel`, like the other per-account lists, so
/// the count on Settings' row and the page it opens read the same answer.
@MainActor
@Observable
final class SharedLinksModel {
    private(set) var links: [ShareLink] = []
    /// How the list fetches have gone, so a failed fetch never reads as "Nothing is shared".
    private(set) var loadState = ListLoadState()
    var errorText: String?

    private let api: APIClient

    init(baseURL: URL, tokenStore: TokenStore) {
        api = APIClient(baseURL: baseURL, tokenStore: tokenStore)
    }

    /// The links that open for anyone who has them — nil until a fetch has answered.
    var activeCount: Int? {
        loadState.hasLoaded ? SharedLinksList.links(links, in: .active).count : nil
    }

    func load() async {
        loadState.begin()
        do {
            links = try await api.shareLinks()
            errorText = nil
            loadState.succeed()
        } catch {
            errorText = SharedLinksList.couldNotLoad + " " + APIClient.failureReason(error)
            loadState.fail()
        }
    }

    /// Turn these links off. Answers how many were still on, or nil when the request failed — the
    /// reason is in `errorText`. The list is read again either way, so it shows what the server has.
    func turnOff(_ ids: [String]) async -> Int? {
        do {
            let count = try await api.turnOffShareLinks(ids)
            await load()
            return count
        } catch {
            errorText = "Couldn’t turn that off: " + APIClient.failureReason(error)
            return nil
        }
    }
}
