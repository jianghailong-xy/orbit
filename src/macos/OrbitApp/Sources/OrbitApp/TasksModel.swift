import Foundation
import Observation
import OrbitKit

/// Drives the shared native Tasks section. Aggregate/No-list scopes use the interactive paged
/// endpoint; named lists use their detail endpoint, matching Web. One instance is owned by
/// `AppModel`, so list navigation, selection and the open detail all observe one snapshot.
@MainActor
@Observable
final class TasksModel {
    private(set) var items: [TaskItem] = []
    private(set) var lists: [TaskListSummary] = []
    private(set) var unlistedCount = 0

    var scope: TaskScope = .all
    var filter: TaskFilter = .runnable
    var searchText = ""
    var sort: TaskSort = .created {
        didSet {
            guard sort != oldValue else { return }
            // Web starts a newly selected field ascending; Created's natural baseline is newest-first.
            descending = sort == .created
        }
    }
    var descending = true

    private(set) var nextCursor: String?
    private(set) var total = 0
    private(set) var pageCounts: TaskPageCounts?
    private(set) var loading = false
    private(set) var loadingMore = false
    private(set) var navigationLoading = false

    private(set) var detail: TaskItem?
    private(set) var detailLoading = false
    private(set) var detailMissing = false
    private(set) var detailErrorText: String?
    private(set) var dependencyCandidates: [TaskItem] = []
    private(set) var dependencyCandidatesLoading = false
    private(set) var mutatingTaskIDs: Set<String> = []
    var errorText: String?

    private let api: APIClient
    private var listGeneration = 0
    private var loadMoreGeneration = 0
    private var navigationGeneration = 0
    private var detailGeneration = 0
    private var dependencyGeneration = 0
    private var loadedListTitle: String?

    init(baseURL: URL, tokenStore: TokenStore) {
        api = APIClient(baseURL: baseURL, tokenStore: tokenStore)
    }

    var activeLists: [TaskListSummary] {
        lists.filter { !TaskListLogic.listIsCompleted($0) }
    }

    var completedLists: [TaskListSummary] {
        lists.filter(TaskListLogic.listIsCompleted)
    }

    var scopeTitle: String {
        switch scope {
        case .all:      return "All tasks"
        case .unlisted: return "No list"
        case .list(let id):
            return lists.first(where: { $0.id == id })?.title ?? loadedListTitle ?? "Task List"
        }
    }

    /// The rows after the active filter/search and client-side sort. Applying filter/search again
    /// to server-filtered pages is intentional and harmless; named-list responses need both locally.
    var visible: [TaskItem] {
        let filtered = TaskListLogic.filtered(items, filter)
        let searched = TaskListLogic.searched(filtered, query: searchText)
        return TaskListLogic.sorted(searched, by: sort, descending: descending)
    }

    var overview: TaskOverview {
        if case .list = scope { return TaskListLogic.overview(items) }
        if let pageCounts { return TaskListLogic.overview(pageCounts) }
        return TaskListLogic.overview(items)
    }

    var availableFilters: [TaskFilter] {
        TaskListLogic.availableFilters(overview: overview, current: filter)
    }

    var hasMore: Bool { nextCursor != nil }
    var hasBusyTasks: Bool { overview.running > 0 || overview.queued > 0 }

    /// Drives SwiftUI `.task(id:)`. Named lists filter/search locally; aggregate scopes ask the
    /// server, so only those query fields restart their request.
    var queryKey: String {
        switch scope {
        case .list:
            return scope.id
        case .all, .unlisted:
            let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
            return "\(scope.id)|\(filter.rawValue)|\(q)"
        }
    }

    func item(_ id: String) -> TaskItem? {
        items.first { $0.id == id }
    }

    func isMutating(_ id: String) -> Bool { mutatingTaskIDs.contains(id) }

    /// Switch list scope as one UI transaction. Web scopes filter/search state to the route, so a
    /// newly opened list starts at Ready with a clean search and created-desc ordering.
    func selectScope(_ newScope: TaskScope) {
        guard scope != newScope else { return }
        scope = newScope
        filter = .runnable
        searchText = ""
        sort = .created
        descending = true
        items = []
        pageCounts = nil
        nextCursor = nil
        loadMoreGeneration &+= 1
        loadingMore = false
        total = 0
        loadedListTitle = nil
        errorText = nil
    }

    // MARK: list/navigation loading

    /// Load the selected scope from scratch. Late responses are discarded when navigation or a
    /// debounced search has already moved to a different query.
    func load() async {
        listGeneration &+= 1
        loadMoreGeneration &+= 1
        loadingMore = false
        let generation = listGeneration
        let key = queryKey
        loading = true
        errorText = nil
        defer { if generation == listGeneration { loading = false } }

        do {
            switch scope {
            case .list(let id):
                let response = try await api.taskList(id)
                guard generation == listGeneration, key == queryKey else { return }
                items = response.tasks
                loadedListTitle = response.title
                pageCounts = nil
                nextCursor = nil
                total = response.tasks.count

            case .all, .unlisted:
                let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
                let response = try await api.taskPage(limit: 200, status: filter.queryValue,
                                                      listId: scope.listQueryValue,
                                                      query: query.isEmpty ? nil : query)
                guard generation == listGeneration, key == queryKey else { return }
                items = response.items
                pageCounts = response.counts
                nextCursor = response.nextCursor
                total = response.total
            }
        } catch {
            guard generation == listGeneration, key == queryKey else { return }
            errorText = friendly(error)
        }
    }

    func loadMore() async {
        guard case .list = scope else {
            guard let cursor = nextCursor, !loadingMore, !loading else { return }
            let generation = listGeneration
            loadMoreGeneration &+= 1
            let moreGeneration = loadMoreGeneration
            let key = queryKey
            loadingMore = true
            defer {
                if moreGeneration == loadMoreGeneration { loadingMore = false }
            }
            do {
                let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
                let response = try await api.taskPage(cursor: cursor, limit: 200,
                                                      status: filter.queryValue,
                                                      listId: scope.listQueryValue,
                                                      query: query.isEmpty ? nil : query)
                guard generation == listGeneration, key == queryKey else { return }
                let existing = Set(items.map(\.id))
                items.append(contentsOf: response.items.filter { !existing.contains($0.id) })
                pageCounts = response.counts
                nextCursor = response.nextCursor
                total = response.total
            } catch {
                guard generation == listGeneration, key == queryKey else { return }
                errorText = friendly(error)
            }
            return
        }
    }

    /// Navigation data is independent from the open list query: task-list summaries feed the
    /// Active/Completed drawer groups, while a one-row page supplies the No-list aggregate count.
    func loadNavigation() async {
        navigationGeneration &+= 1
        let generation = navigationGeneration
        navigationLoading = true
        defer { if generation == navigationGeneration { navigationLoading = false } }

        if let response = try? await api.taskLists(), generation == navigationGeneration {
            lists = response
        }
        if let response = try? await api.taskPage(limit: 1, listId: "none"),
           generation == navigationGeneration {
            unlistedCount = response.counts.total
        }
    }

    /// Reconcile every Tasks surface after a control event/reconnect: drawer summaries, selected
    /// list and the open detail. This is the native equivalent of Web invalidating all task keys.
    func refresh(selectedTaskID: String?) async {
        await loadNavigation()
        await load()
        if let selectedTaskID { _ = await loadDetail(selectedTaskID) }
    }

    // MARK: detail loading

    /// Returns true when the task loaded. `detailMissing` distinguishes a remote deletion (404)
    /// from a transient error so the view can pop only for the former.
    @discardableResult
    func loadDetail(_ id: String) async -> Bool {
        detailGeneration &+= 1
        let generation = detailGeneration
        if detail?.id != id { detail = nil }
        detailLoading = true
        detailMissing = false
        detailErrorText = nil
        defer { if generation == detailGeneration { detailLoading = false } }
        do {
            let response = try await api.task(id)
            guard generation == detailGeneration else { return false }
            detail = response
            return true
        } catch APIError.http(let status, _) where status == 404 {
            guard generation == detailGeneration else { return false }
            detail = nil
            detailMissing = true
            return false
        } catch {
            guard generation == detailGeneration else { return false }
            detailErrorText = friendly(error)
            return false
        }
    }

    func clearDetail() {
        detailGeneration &+= 1
        detail = nil
        detailLoading = false
        detailMissing = false
        detailErrorText = nil
    }

    func clearDetailError() {
        detailErrorText = nil
    }

    // MARK: actions

    @discardableResult
    func execute(_ id: String) async -> Bool {
        await mutate(id) { try await self.api.executeTask(id) }
    }

    @discardableResult
    func deleteTask(_ id: String) async -> Bool {
        guard !mutatingTaskIDs.contains(id) else { return false }
        mutatingTaskIDs.insert(id)
        errorText = nil
        defer { mutatingTaskIDs.remove(id) }
        do {
            try await api.deleteTask(id)
            if detail?.id == id { clearDetail() }
            await loadNavigation()
            await load()
            return true
        } catch {
            errorText = friendly(error)
            return false
        }
    }

    func setStatus(_ id: String, _ status: TaskStatus) async {
        _ = await mutate(id) { _ = try await self.api.updateTask(id, UpdateTaskRequest(status: status)) }
    }

    func setAutoRun(_ id: String, _ on: Bool) async {
        _ = await mutate(id) { _ = try await self.api.updateTask(id, UpdateTaskRequest(autoRunWhenReady: on)) }
    }

    func setAssignee(_ id: String, _ assigneeId: String?) async {
        let field: FieldUpdate<String> = assigneeId.map { .set($0) } ?? .clear
        _ = await mutate(id) {
            _ = try await self.api.updateTask(id, UpdateTaskRequest(assigneeId: field))
        }
    }

    func setList(_ id: String, _ listId: String?) async {
        let field: FieldUpdate<String> = listId.map { .set($0) } ?? .clear
        _ = await mutate(id) {
            _ = try await self.api.updateTask(id, UpdateTaskRequest(listId: field))
        }
    }

    @discardableResult
    func addComment(_ id: String, _ body: String, mentions: [String] = []) async -> Bool {
        await mutate(id) {
            try await self.api.addTaskComment(
                taskID: id,
                CreateTaskCommentRequest(body: body, mentions: mentions.isEmpty ? nil : mentions)
            )
        }
    }

    @discardableResult
    func addDependency(_ id: String, dependsOn: String) async -> Bool {
        await mutate(id) {
            try await self.api.addTaskDependency(
                taskID: id, AddDependencyRequest(dependsOnTaskId: dependsOn)
            )
        }
    }

    func removeDependency(_ id: String, dependsOn: String) async {
        _ = await mutate(id) {
            try await self.api.removeTaskDependency(taskID: id, dependsOnTaskID: dependsOn)
        }
    }

    /// Server-side prerequisite search, matching Web's bounded 50-row picker instead of limiting
    /// candidates to whichever filtered task rows happen to be loaded in the current list.
    func loadDependencyCandidates(query: String) async {
        dependencyGeneration &+= 1
        let generation = dependencyGeneration
        dependencyCandidatesLoading = true
        defer { if generation == dependencyGeneration { dependencyCandidatesLoading = false } }
        do {
            let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
            let response = try await api.taskPage(
                limit: 50, query: q.isEmpty ? nil : q
            )
            guard generation == dependencyGeneration else { return }
            dependencyCandidates = response.items
        } catch {
            guard generation == dependencyGeneration else { return }
            errorText = friendly(error)
        }
    }

    func clearDependencyCandidates() {
        dependencyGeneration &+= 1
        dependencyCandidates = []
        dependencyCandidatesLoading = false
    }

    func beginDependencyCandidateSearch() {
        dependencyGeneration &+= 1
        dependencyCandidates = []
        dependencyCandidatesLoading = true
    }

    /// Run one mutation at a time per task, then refresh every affected task surface.
    private func mutate(_ id: String, _ operation: @escaping () async throws -> Void) async -> Bool {
        guard !mutatingTaskIDs.contains(id) else { return false }
        mutatingTaskIDs.insert(id)
        errorText = nil
        defer { mutatingTaskIDs.remove(id) }
        do {
            try await operation()
            await loadNavigation()
            await load()
            if detail?.id == id { _ = await loadDetail(id) }
            return true
        } catch {
            errorText = friendly(error)
            return false
        }
    }

    private func friendly(_ error: Error) -> String {
        if case APIError.unauthorized = error { return "Session expired — sign in again." }
        if case APIError.http(_, let body) = error,
           let body, let data = body.data(using: .utf8),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let message = object["message"] as? String, !message.isEmpty {
            return message
        }
        return "Request failed — check your connection."
    }
}
