import Foundation
import Observation
import OrbitKit

/// The account's owner requests, behind the "Waiting on you" inbox, each conversation's request cards
/// and the push actions. Owned by `AppModel` and rebuilt per instance, like the other section stores.
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
    /// The Done and Declined tabs' own reads.
    private(set) var ended: [OwnerRequests.InboxTab: [OwnerRequest]] = [:]
    private(set) var savedSecrets: [AccountSecret] = []
    /// The coordinators' open questions: one inbox and one count with the requests (web `WaitingOnYouPage`).
    private(set) var questions: [OwnerInboxQuestion] = []
    /// Answer on a question's row: its card, in the coordinator conversation it was asked in.
    var onAnswerQuestion: (OwnerInboxQuestion) -> Void = { _ in }
    /// The titles of the tasks requests hold up, by id, read once each.
    private(set) var taskTitles: [String: String] = [:]
    private(set) var snoozes: [String: Date]
    /// The list answered 404: the server predates owner requests.
    private(set) var unsupported = false

    /// The inbox is up, and the request a link or a push opened in it (its card open, its input focused).
    var inboxPresented = false
    var focusedRequestID: String?
    /// The tab the inbox shows.
    var tab: OwnerRequests.InboxTab = .open

    /// A runner's name for "Delivered to Runner HPC", from the app's runner snapshot.
    var runnerName: (String) -> String = { _ in "this runner" }

    private let api: APIClient
    private let store: OwnerRequestSnoozes

    init(baseURL: URL, tokenStore: TokenStore, store: OwnerRequestSnoozes = OwnerRequestSnoozes()) {
        api = APIClient(baseURL: baseURL, tokenStore: tokenStore)
        self.store = store
        snoozes = store.all()
    }

    var waitingCount: Int { OwnerRequests.waitingCount(open, questions: questions, snoozes: snoozes) }

    /// The Open tab: pending requests and open questions, newest first.
    var openEntries: [OwnerInboxEntry] { OwnerRequests.openEntries(open, questions: questions) }

    /// Every request this client has read, the newest read of each winning.
    var known: [OwnerRequest] { OwnerRequests.merged(all, ended[.done] ?? [], ended[.declined] ?? [], open) }

    func request(_ id: String) -> OwnerRequest? { OwnerRequests.find(id, in: known) }

    func forSession(_ sessionID: String) -> [OwnerRequest] { OwnerRequests.forSession(known, sessionID: sessionID) }

    func rows(_ tab: OwnerRequests.InboxTab) -> [OwnerRequest] {
        tab == .open ? open : (ended[tab] ?? [])
    }

    func load() async {
        guard !unsupported else { return }
        do {
            open = try await api.ownerRequests(state: "open").requests
            all = try await api.ownerRequests(state: "all").requests
            if tab != .open { await loadTab(tab) }
            await loadQuestions()
        } catch APIError.http(let status, _) where status == 404 {
            unsupported = true
        } catch {
            // The next tick reads again; what was drawn stays.
        }
        snoozes = store.all()
    }

    /// The open projects whose coordinator asked the owner something, and each one's open questions.
    /// A project that cannot be read keeps the questions it had.
    func loadQuestions() async {
        guard let projects = try? await api.projects(status: .open) else { return }
        var next: [OwnerInboxQuestion] = []
        for project in OwnerRequests.projectsAsking(projects) {
            guard let items = try? await api.projectOpenItems(projectID: project.id) else {
                next += questions.filter { $0.projectID == project.id }
                continue
            }
            let document = try? await api.project(project.id)
            next += OwnerRequests.questions(project: project, items: items,
                                            coordinatorSessionID: document?.coordinatorSessionId,
                                            coordinatorWorkspaceID: document?.coordinatorWorkspaceId)
        }
        questions = next
    }

    func loadTab(_ tab: OwnerRequests.InboxTab) async {
        guard tab != .open, let list = try? await api.ownerRequests(state: tab.filter) else { return }
        ended[tab] = list.requests
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

    /// The inbox, with this request's card open and its input focused: a push's first action, an
    /// `orbit://owner-request/<id>` link. A request no list holds yet is read on its own.
    func show(_ requestID: String) {
        tab = .open
        focusedRequestID = requestID
        inboxPresented = true
        store.wake(requestID)
        snoozes = store.all()
        guard request(requestID) == nil else { return }
        Task { [weak self] in
            guard let self, let read = try? await self.api.ownerRequest(requestID) else { return }
            self.adopt(read)
        }
    }

    // MARK: the doors

    func complete(_ request: OwnerRequest, _ body: OwnerRequestDoneBody) async throws {
        adopt(try await api.completeOwnerRequest(request.id, body))
    }

    /// A WIKI_CREATE card's Create wiki: the server makes the wiki and answers with the card, DONE.
    func createWiki(_ request: OwnerRequest) async throws {
        adopt(try await api.createWikiFromOwnerRequest(request.id))
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
        for tab in ended.keys { ended[tab] = replace(ended[tab] ?? []) }
    }

    #if DEBUG
    /// Probe and preview fixtures: the lists as a read would have answered them.
    func seed(open: [OwnerRequest], all: [OwnerRequest], ended: [OwnerRequests.InboxTab: [OwnerRequest]] = [:],
              saved: [AccountSecret] = [], taskTitles: [String: String] = [:],
              questions: [OwnerInboxQuestion] = []) {
        self.questions = questions
        self.taskTitles = Dictionary(uniqueKeysWithValues: taskTitles.map { (PublicID.storageKey($0.key), $0.value) })
        self.open = open
        self.all = all
        self.ended = ended
        self.savedSecrets = saved
    }
    #endif
}
