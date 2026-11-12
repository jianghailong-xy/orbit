import Foundation
import Observation
import OrbitKit

/// The account's owner requests: each conversation's request cards and the push actions that open
/// them. Owned by `AppModel` and rebuilt per instance, like the other section stores.
///
/// Read on the app poll's floor and after every press; what the server answered is what is drawn. A
/// secret's value never passes through here as state: a card hands it to `submitSecret` at the press
/// and keeps nothing (design docs/design/owner-request-secrets.md §7.2).
@MainActor
@Observable
final class OwnerRequestsModel {
    /// Pending requests, newest first.
    private(set) var open: [OwnerRequest] = []
    /// Every state, newest first: what a conversation draws its ended requests from.
    private(set) var all: [OwnerRequest] = []
    private(set) var savedSecrets: [AccountSecret] = []
    /// The titles of the tasks requests hold up, by id, read once each.
    private(set) var taskTitles: [String: String] = [:]
    private(set) var snoozes: [String: Date]

    /// A runner's name for "Delivered to Runner HPC", from the app's runner snapshot.
    var runnerName: (String) -> String = { _ in "this runner" }

    private let api: APIClient
    private let store: OwnerRequestSnoozes

    init(baseURL: URL, tokenStore: TokenStore, store: OwnerRequestSnoozes = OwnerRequestSnoozes()) {
        api = APIClient(baseURL: baseURL, tokenStore: tokenStore)
        self.store = store
        snoozes = store.all()
    }

    /// Every request this client has read, the newest read of each winning.
    var known: [OwnerRequest] { OwnerRequests.merged(all, open) }

    func request(_ id: String) -> OwnerRequest? { OwnerRequests.find(id, in: known) }

    func forSession(_ sessionID: String) -> [OwnerRequest] { OwnerRequests.forSession(known, sessionID: sessionID) }

    func load() async {
        do {
            open = try await api.ownerRequests(state: "open").requests
            all = try await api.ownerRequests(state: "all").requests
        } catch {
            // The next tick reads again; what was drawn stays.
        }
        snoozes = store.all()
    }

    /// The one request a door that holds only its id names — a link, a push's action, a reminder.
    /// The account's lists usually already hold it; otherwise it is read on its own and adopted, so
    /// the conversation that asked draws it on the next pass.
    func read(_ id: String) async -> OwnerRequest? {
        if let known = request(id) { return known }
        guard let read = try? await api.ownerRequest(id) else { return nil }
        adopt(read)
        return read
    }

    func taskTitle(_ id: String) -> String { taskTitles[PublicID.storageKey(id)] ?? "Task" }

    func loadTaskTitles(_ ids: [String]) async {
        for id in ids where taskTitles[PublicID.storageKey(id)] == nil {
            guard let task = try? await api.taskRow(id) else { continue }
            taskTitles[PublicID.storageKey(id)] = task.title
        }
    }

    func loadSavedSecrets() async {
        guard let list = try? await api.accountSecrets() else { return }
        savedSecrets = list.secrets
    }

    // MARK: the doors

    func complete(_ request: OwnerRequest, _ body: OwnerRequestDoneBody) async throws {
        adopt(try await api.completeOwnerRequest(request.id, body))
    }

    func decline(_ request: OwnerRequest, reason: String) async throws {
        adopt(try await api.declineOwnerRequest(request.id, reason: reason))
    }

    /// The key goes in the body of one request and nowhere else; the answer never carries it back.
    func submitSecret(_ request: OwnerRequest, _ body: OwnerRequestSecretBody) async throws {
        adopt(try await api.submitOwnerSecret(request.id, body))
    }

    func cancelSecret(_ request: OwnerRequest) async throws {
        adopt(try await api.cancelOwnerSecret(request.id))
    }

    func revokeSecret(_ request: OwnerRequest) async throws {
        adopt(try await api.revokeOwnerSecret(request.id))
    }

    // MARK: reminders

    func snooze(_ id: String, for seconds: TimeInterval) {
        store.snooze(id, until: Date().addingTimeInterval(seconds))
        snoozes = store.all()
    }

    func wake(_ id: String) {
        store.wake(id)
        snoozes = store.all()
    }

    func snoozedUntil(_ id: String) -> Date? {
        snoozes[PublicID.storageKey(id)].flatMap { $0 > Date() ? $0 : nil }
    }

    /// One request as a door or a read answered it, in every list that holds it.
    private func adopt(_ request: OwnerRequest) {
        func replace(_ list: [OwnerRequest]) -> [OwnerRequest] {
            let key = PublicID.storageKey(request.id)
            guard let at = list.firstIndex(where: { PublicID.storageKey($0.id) == key }) else { return list }
            var next = list
            next[at] = request
            return next
        }
        let key = PublicID.storageKey(request.id)
        if request.state == .pending {
            open = open.contains(where: { PublicID.storageKey($0.id) == key }) ? replace(open) : [request] + open
        } else {
            open.removeAll { PublicID.storageKey($0.id) == key }
        }
        all = all.contains(where: { PublicID.storageKey($0.id) == key }) ? replace(all) : [request] + all
    }

    #if DEBUG
    /// Probe and preview fixtures: the lists as a read would have answered them.
    func seed(open: [OwnerRequest], all: [OwnerRequest], saved: [AccountSecret] = [],
              taskTitles: [String: String] = [:]) {
        self.taskTitles = Dictionary(uniqueKeysWithValues: taskTitles.map { (PublicID.storageKey($0.key), $0.value) })
        self.open = open
        self.all = all
        self.savedSecrets = saved
    }
    #endif
}
