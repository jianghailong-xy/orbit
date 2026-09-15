import Foundation
import Observation
import OrbitKit

/// The account's watches, behind the Following page, the console's Watching card and every session's
/// header, row and glyph. Owned by `AppModel` and rebuilt per instance, like the other section stores.
///
/// The control plane has no watch event, so the list is refetched: when the stream connects, on a
/// short coalesced nudge after an event that can move a target, on the app poll's 30s floor, and
/// after each control. What the server answered is always what's drawn.
@MainActor
@Observable
final class WatchesModel {
    /// Newest first. The live states and the watches that need attention are fetched on their own, so neither a
    /// live watch nor a failure nobody has seen yet can be pushed out of the server's newest 100
    /// (`APIClient.followedWatches`).
    private(set) var watches: [Watch] = []
    /// Observed session → its live watches, rebuilt with the list so a row finds its own in one lookup.
    private(set) var summaries: [String: WatchSessionSummary] = [:]
    private(set) var loadState = ListLoadState()
    /// The list answered 404: the server predates watches, so there is nothing to show or retry.
    private(set) var unsupported = false
    /// A NOTIFY_USER watch this client saw live has matched (see `WatchDelta`).
    var onMatched: ((NotificationEvent) -> Void)?

    private let api: APIClient
    private var nudgeTask: Task<Void, Never>?

    init(baseURL: URL, tokenStore: TokenStore) {
        api = APIClient(baseURL: baseURL, tokenStore: tokenStore)
    }

    /// By either spelling of its id: a push names the UUID.
    func watch(_ id: String) -> Watch? { WatchIndex.find(id, in: watches) }

    func summary(for sessionID: String) -> WatchSessionSummary? {
        summaries[PublicID.storageKey(sessionID)]
    }

    func load() async {
        guard !unsupported else { return }
        loadState.begin()
        do {
            let active = try await api.watches(state: .active)
            let paused = try await api.watches(state: .paused)
            let recent = try await api.watches()
            adopt(WatchIndex.merge([active, paused, recent]))
            loadState.succeed()
        } catch APIError.http(let status, _) where status == 404 {
            unsupported = true
            loadState.succeed()
        } catch {
            loadState.fail()
        }
    }

    /// One watch the list doesn't hold — a deep link or a push for an older one.
    func fetch(_ id: String) async {
        guard let fetched = try? await api.watch(id) else { return }
        adopt(WatchIndex.replacing(fetched, in: watches))
    }

    /// A session or task moved, and a target with it maybe: refetch shortly, once for a burst. Skipped
    /// while nothing is live, when no target can move; a new watch is left to the poll.
    func nudge() {
        guard nudgeTask == nil, watches.contains(where: { WatchStateMachine.isLive($0.state) }) else { return }
        nudgeTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard let self else { return }
            self.nudgeTask = nil
            await self.load()
        }
    }

    /// Pause, resume or stop. Nil when it went through; otherwise the sentence to show by the controls.
    /// A refusal usually means the watch moved on (it matched, or somebody else stopped it), so the
    /// list is read again before answering.
    func perform(_ control: WatchControl, on watch: Watch) async -> String? {
        do {
            let updated: Watch
            switch control {
            case .pause: updated = try await api.pauseWatch(watch.id)
            case .resume: updated = try await api.resumeWatch(watch.id)
            case .stop: updated = try await api.cancelWatch(watch.id)
            case .view, .edit: return nil
            }
            adopt(WatchIndex.replacing(updated, in: watches))
            return nil
        } catch {
            await load()
            return WatchProjection.failureMessage(error, verb: control.rawValue)
        }
    }

    /// Save an edit. Nil when it went through; otherwise the sentence to show in the sheet.
    func save(_ request: UpdateWatchRequest, for watch: Watch) async -> String? {
        do {
            let updated = try await api.updateWatch(watch.id, request)
            adopt(WatchIndex.replacing(updated, in: watches))
            return nil
        } catch {
            return WatchProjection.failureMessage(error, verb: "save")
        }
    }

    /// The one writer of `watches` and `summaries`. An identical list writes nothing: Observation
    /// invalidates on assignment, equal or not, and every session row reads `summaries`.
    private func adopt(_ list: [Watch]) {
        for event in WatchDelta.matched(previous: watches, current: list) { onMatched?(event) }
        guard list != watches else { return }
        watches = list
        summaries = WatchIndex.summariesByObserver(list)
    }
}
