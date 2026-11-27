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
    /// The scheduled tasks' four kinds (failed, held, a run's approval, a run asking for more), pending: their
    /// cards head the Scheduled page (docs/scheduled-tasks-design.md §6.4). There is no Waiting on you sheet
    /// (docs/mocks/waiting-on-you-removal; the owner, 2026-11-16).
    private(set) var scheduleItems: [ScheduleWaitingItem] = []
    /// A condition's two kinds, pending: the can't-read card and the 30-day question (docs/condition-triggers-design.md
    /// §5.3, §6.2). They head the Scheduled page with the schedule's.
    private(set) var conditionItems: [ConditionWaitingItem] = []
    /// Terminals asking to be approved (docs/terminal-session-design.md). Each waits ten minutes at most.
    /// Read here for the machine page's Needs you section (docs/mocks/waiting-on-you-removal/02).
    private(set) var terminalRequests: [TerminalRequest] = []
    /// The titles of the tasks requests hold up, by id, read once each.
    private(set) var taskTitles: [String: String] = [:]
    private(set) var snoozes: [String: Date]

    /// A runner's name for "Delivered to Runner HPC", from the app's runner snapshot.
    var runnerName: (String) -> String = { _ in "this runner" }
    /// A runner's live row (Max Concurrent, sessions running) for a CHANGE card.
    var runnerRow: (String) -> Runner? = { _ in nil }

    /// Called after every read of the waiting terminals, whether or not the list moved: the app's
    /// one-time notice takes its stock on the first read and speaks on the ones after it (iOS).
    var onTerminalRequestsRead: (() -> Void)?

    private let api: APIClient
    private let store: OwnerRequestSnoozes

    init(baseURL: URL, tokenStore: TokenStore, store: OwnerRequestSnoozes = OwnerRequestSnoozes()) {
        api = APIClient(baseURL: baseURL, tokenStore: tokenStore)
        self.store = store
        snoozes = store.all()
    }

    /// The store over a transport handed in (the observation tests): the app builds `api` above.
    init(api: APIClient, store: OwnerRequestSnoozes = OwnerRequestSnoozes()) {
        self.api = api
        self.store = store
        snoozes = store.all()
    }

    /// Every request this client has read, the newest read of each winning.
    var known: [OwnerRequest] { OwnerRequests.merged(all, open) }

    func request(_ id: String) -> OwnerRequest? { OwnerRequests.find(id, in: known) }

    func forSession(_ sessionID: String) -> [OwnerRequest] { OwnerRequests.forSession(known, sessionID: sessionID) }

    func load() async {
        do {
            let openList = try await api.ownerRequests(state: "open")
            assignIfChanged(\.open, openList.requests)
            assignIfChanged(\.scheduleItems, openList.scheduleItems.filter { $0.state == "PENDING" })
            assignIfChanged(\.conditionItems, openList.conditionItems.filter { $0.state == "PENDING" })
            assignIfChanged(\.all, try await api.ownerRequests(state: "all").requests)
            await loadTerminalRequests()
        } catch {
            // The next tick reads again; what was drawn stays.
        }
        assignIfChanged(\.snoozes, store.all())
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

    /// The terminals waiting for a decision. A server that predates terminals answers 404: no cards.
    func loadTerminalRequests() async {
        do {
            assignIfChanged(\.terminalRequests, try await api.terminalRequests())
        } catch APIError.http(let status, _) where status == 404 {
            assignIfChanged(\.terminalRequests, [])
        } catch {
            // The next tick reads again; what was drawn stays.
        }
        onTerminalRequestsRead?()
    }

    /// Approve or Deny a terminal: the card leaves at once, and the list is read again either way.
    func decideTerminal(_ request: TerminalRequest, approve: Bool) async throws {
        defer { Task { await loadTerminalRequests() } }
        if approve {
            try await api.approveTerminalRequest(request.id)
        } else {
            try await api.denyTerminalRequest(request.id)
        }
        terminalRequests.removeAll { $0.id == request.id }
        onTerminalRequestsRead?()
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
        assignIfChanged(\.savedSecrets, list.secrets)
    }

    // MARK: the doors

    /// The 30-day question answered: Keep waiting (0) or Stop (1). The server's refusal in its own words, or nil.
    func answerCondition(_ item: ConditionWaitingItem, option: Int) async -> String? {
        do {
            try await api.answerConditionItem(item.id, option: option)
            assignIfChanged(\.conditionItems, conditionItems.filter { $0.id != item.id })
            return nil
        } catch {
            return ScheduledModel.refusal(error)
        }
    }

    func complete(_ request: OwnerRequest, _ body: OwnerRequestDoneBody) async throws {
        adopt(try await api.completeOwnerRequest(request.id, body))
    }

    /// A WIKI_CREATE card's Create wiki: the server makes the wiki and answers with the card, DONE.
    func createWiki(_ request: OwnerRequest) async throws {
        adopt(try await api.createWikiFromOwnerRequest(request.id))
    }

    /// A SETTINGS_CHANGE card's Save changes (design §5.2): the server writes the values and answers with the card,
    /// DONE. A refusal 409 SETTINGS_STALE is thrown for the card to say so.
    func applySettings(_ request: OwnerRequest) async throws {
        adopt(try await api.applyOwnerRequestSettings(request.id))
    }

    /// A CHANGE card's Apply: the server writes the runner's Max Concurrent and answers with the card, DONE.
    func applyChange(_ request: OwnerRequest, maxConcurrent: Int) async throws {
        adopt(try await api.applyOwnerRequestChange(request.id, OwnerRequestApplyBody(maxConcurrent: maxConcurrent)))
    }

    /// A PROJECT_REOPEN card's Reopen: the server reopens the project as the project page's press does, settles every
    /// pending reopen request of it, and answers with this card, DONE.
    func reopenProject(_ request: OwnerRequest) async throws {
        adopt(try await api.reopenProjectFromOwnerRequest(request.id))
    }

    func decline(_ request: OwnerRequest, reason: String, sendAsWritten: Bool = false) async throws {
        adopt(try await api.declineOwnerRequest(request.id, reason: reason, sendAsWritten: sendAsWritten))
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
              taskTitles: [String: String] = [:], terminalRequests: [TerminalRequest] = []) {
        self.terminalRequests = terminalRequests
        self.taskTitles = Dictionary(uniqueKeysWithValues: taskTitles.map { (PublicID.storageKey($0.key), $0.value) })
        self.open = open
        self.all = all
        self.savedSecrets = saved
    }
    #endif
}
