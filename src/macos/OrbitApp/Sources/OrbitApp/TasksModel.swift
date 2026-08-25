import Foundation
import Observation
import OrbitKit

/// Drives the shared native Tasks section. Every scope uses the interactive paged endpoint;
/// named-list detail may contain tens of thousands of embedded tasks and is never a list refresh
/// primitive. One instance is owned by `AppModel`, so navigation, selection and detail share state.
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
    private(set) var pageCounts: TaskPageCounts?
    private(set) var countsRefreshedAt: Date?
    private(set) var loading = false
    private(set) var loadingMore = false
    private(set) var navigationLoading = false
    private(set) var sectionActive = false

    private(set) var detail: TaskItem?
    private(set) var detailLoading = false
    private(set) var detailMissing = false
    private(set) var detailErrorText: String?
    private(set) var selectedDetailID: String?
    var onSelectedDetailMissing: ((String) -> Void)?
    private(set) var dependencyCandidates: [TaskItem] = []
    private(set) var dependencyCandidatesLoading = false
    private(set) var mutatingTaskIDs: Set<String> = []
    var errorText: String?

    private let api: APIClient
    private var listGeneration = 0
    private var loadMoreGeneration = 0
    private var navigationGeneration = 0
    private var countsGeneration = 0
    private var countsTask: Task<Void, Never>?
    private var countsScopeKey: String?
    private var pendingForcedCountsRefresh = false
    private var countsInvalidationVersion = 0
    private var countsCommittedVersion = 0
    private var countsRetryNotBefore = Date.distantPast
    private var detailGeneration = 0
    private var dependencyGeneration = 0
    private var loadedListTitle: String?
    /// A request can be in flight without ever becoming the page the UI committed. Keeping these
    /// keys separate prevents an event from treating old-scope counts as the seed for a new query.
    private var requestedSnapshotKey: String?
    private var committedSnapshotKey: String?
    private var eventSeedRetryKey: String?
    private var eventSeedRetryNotBefore = Date.distantPast
    /// AppModel serializes control events, but local mutations and pull/periodic refreshes have
    /// independent callers. Fold coarse and exact control work through one trailing-edge drain so
    /// a one-row read can never invalidate and silently replace a required delete/cascade resync.
    private var refreshDrainRunning = false
    private var pendingFullRefresh = false
    private var pendingChangedTaskIDs: Set<String> = []

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
    /// to server-filtered pages is intentional and keeps event-inserted rows on the same predicate.
    var visible: [TaskItem] {
        let filtered = TaskListLogic.filtered(items, filter)
        let searched = TaskListLogic.searched(filtered, query: searchText)
        return TaskListLogic.sorted(searched, by: sort, descending: descending)
    }

    var overview: TaskOverview {
        if let pageCounts { return TaskListLogic.overview(pageCounts) }
        return TaskListLogic.overview(items)
    }

    var availableFilters: [TaskFilter] {
        TaskListLogic.availableFilters(overview: overview, current: filter)
    }

    var hasMore: Bool { nextCursor != nil }
    var hasBusyTasks: Bool { overview.running > 0 || overview.queued > 0 }

    /// Drives SwiftUI `.task(id:)`. Every scope is paged and filtered by the server; named lists
    /// used to embed their complete task collection, which made opening a large list a multi-MB
    /// response and made every event-driven refresh repeat it.
    var queryKey: String {
        let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        return "\(scope.id)|\(filter.rawValue)|\(q)"
    }

    func item(_ id: String) -> TaskItem? {
        items.first { $0.id == id }
    }

    func isMutating(_ id: String) -> Bool { mutatingTaskIDs.contains(id) }

    /// Switch list scope as one UI transaction. Web scopes filter/search state to the route, so a
    /// newly opened list starts at Ready with a clean search and created-desc ordering.
    func selectScope(_ newScope: TaskScope) {
        guard scope != newScope else { return }
        countsGeneration &+= 1
        countsTask?.cancel()
        countsTask = nil
        countsScopeKey = nil
        pendingForcedCountsRefresh = false
        countsInvalidationVersion = 0
        countsCommittedVersion = 0
        countsRetryNotBefore = .distantPast
        scope = newScope
        filter = .runnable
        searchText = ""
        sort = .created
        descending = true
        items = []
        pageCounts = nil
        countsRefreshedAt = nil
        nextCursor = nil
        loadMoreGeneration &+= 1
        loadingMore = false
        loadedListTitle = nil
        requestedSnapshotKey = nil
        committedSnapshotKey = nil
        eventSeedRetryKey = nil
        eventSeedRetryNotBefore = .distantPast
        errorText = nil
    }

    /// The section, not its list column, owns event-driven work. On compact iPhone navigation the
    /// list disappears while its detail is pushed, but the Tasks section is still foreground.
    func setSectionActive(_ active: Bool) {
        guard sectionActive != active else { return }
        sectionActive = active
        if active {
            if countsInvalidationVersion != countsCommittedVersion {
                scheduleCountsRefresh(force: true)
            }
        } else {
            listGeneration &+= 1
            loadMoreGeneration &+= 1
            detailGeneration &+= 1
            loading = false
            loadingMore = false
            detailLoading = false
        }
    }

    /// Mirror AppModel's live selection into the detail store. Background refreshes consult this
    /// value after every await, so a response captured for A can never replace a newly selected B.
    func setSelectedDetailID(_ id: String?) {
        guard selectedDetailID != id else { return }
        selectedDetailID = id
        clearDetail()
    }

    // MARK: list/navigation loading

    /// Load the selected query from scratch. The page returns only bounded rows + cursor;
    /// scope-wide tab/progress counts have an independent single-flight keyed by scope, so neither
    /// filter/search nor pagination runs an unneeded table-wide count.
    @discardableResult
    func load(refreshCounts: Bool = false) async -> Bool {
        listGeneration &+= 1
        loadMoreGeneration &+= 1
        loadingMore = false
        let generation = listGeneration
        let key = queryKey
        requestedSnapshotKey = key
        loading = true
        errorText = nil
        defer { if generation == listGeneration { loading = false } }

        scheduleCountsRefresh(force: refreshCounts)

        do {
            // Deep links can select a list before the navigation summaries arrive. Fetch only its
            // header in that rare case; task rows always come from the bounded page endpoint.
            if case .list(let id) = scope,
               lists.first(where: { $0.id == id }) == nil,
               let header = try? await api.taskListHeader(id),
               generation == listGeneration, key == queryKey {
                loadedListTitle = header.title
            }
            // Header hydration can be slower than a task event or a scope change. Do not launch a
            // page request that is already known to be obsolete just because the optional header
            // request finally returned.
            guard generation == listGeneration, key == queryKey else { return false }

            let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
            let response = try await api.taskPage(limit: 200, status: filter.queryValue,
                                                  listId: scope.listQueryValue,
                                                  query: query.isEmpty ? nil : query,
                                                  counts: .none)
            guard generation == listGeneration, key == queryKey else { return false }
            items = response.items
            // Be liberal toward a transitional server that still includes this block, but current
            // `counts=none` responses omit it and the independent scope request owns the value.
            if let counts = response.counts { pageCounts = counts }
            nextCursor = response.nextCursor
            committedSnapshotKey = key
            if eventSeedRetryKey == key {
                eventSeedRetryKey = nil
                eventSeedRetryNotBefore = .distantPast
            }
            return true
        } catch {
            if isCancellation(error) {
                if generation == listGeneration, key == queryKey,
                   committedSnapshotKey != key {
                    requestedSnapshotKey = nil
                }
                return false
            }
            guard generation == listGeneration, key == queryKey else { return false }
            errorText = friendly(error)
            return false
        }
    }

    /// Start at most one scope-count request. This unstructured task deliberately survives a
    /// SwiftUI query task being cancelled when the user types another search character: the count
    /// depends only on scope, so restarting it would repeat the expensive work for no new answer.
    private func scheduleCountsRefresh(force: Bool) {
        let key = scope.id
        let requestedForce = force || pendingForcedCountsRefresh
        guard requestedForce || pageCounts == nil else { return }
        if countsScopeKey == key, countsTask != nil {
            // A force can represent a mutation committed after the active request took its DB
            // snapshot. Reuse it for display latency, but always follow it with one fresh pass.
            if force { pendingForcedCountsRefresh = true }
            return
        }

        guard Date() >= countsRetryNotBefore else {
            if requestedForce { pendingForcedCountsRefresh = true }
            return
        }

        countsGeneration &+= 1
        let generation = countsGeneration
        let listID = scope.listQueryValue
        let coveredInvalidationVersion = countsInvalidationVersion
        countsTask?.cancel()
        pendingForcedCountsRefresh = false
        countsScopeKey = key
        countsTask = Task { @MainActor [weak self] in
            guard let self else { return }
            let response = try? await self.api.taskCounts(listId: listID)
            guard !Task.isCancelled,
                  self.countsGeneration == generation,
                  self.scope.id == key else { return }
            if let response {
                self.pageCounts = response
                self.countsRefreshedAt = Date()
                self.countsCommittedVersion = coveredInvalidationVersion
                self.countsRetryNotBefore = .distantPast
            } else {
                self.countsRetryNotBefore = Date().addingTimeInterval(15)
            }
            self.countsTask = nil
            self.countsScopeKey = nil
            if self.pendingForcedCountsRefresh {
                self.pendingForcedCountsRefresh = false
                self.scheduleCountsRefresh(force: true)
            }
        }
    }

    func loadMore() async {
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
            // Later pages need rows and a cursor only. Repeating the owner-wide Ready/count
            // aggregates for every 200 rows was pure duplicate database work.
            let response = try await api.taskPage(cursor: cursor, limit: 200,
                                                  status: filter.queryValue,
                                                  listId: scope.listQueryValue,
                                                  query: query.isEmpty ? nil : query,
                                                  counts: .none)
            guard generation == listGeneration, key == queryKey else { return }
            let existing = Set(items.map(\.id))
            items.append(contentsOf: response.items.filter { !existing.contains($0.id) })
            nextCursor = response.nextCursor
        } catch {
            if isCancellation(error) { return }
            guard generation == listGeneration, key == queryKey else { return }
            errorText = friendly(error)
        }
    }

    /// Navigation data is independent from the open list query: task-list summaries feed the
    /// drawer preview and searchable Active/Completed directory, while a one-row page supplies
    /// the No-list aggregate count.
    func loadNavigation() async {
        navigationGeneration &+= 1
        let generation = navigationGeneration
        navigationLoading = true
        defer { if generation == navigationGeneration { navigationLoading = false } }

        if let response = try? await api.taskLists(), generation == navigationGeneration {
            lists = response
        }
        guard generation == navigationGeneration else { return }
        // This surface needs one number, not the scope-wide status/running/Ready aggregate block.
        if let response = try? await api.taskPage(limit: 1, listId: "none", counts: .total),
           generation == navigationGeneration {
            unlistedCount = response.total ?? 0
        }
    }

    /// Reconcile every Tasks surface after reconnect or an explicit coarse invalidation. Ordinary
    /// `task.changed` events use `refreshChangedTasks` and never reach this snapshot path.
    func refresh() async {
        countsInvalidationVersion &+= 1
        pendingFullRefresh = true
        await drainRefreshQueue()
    }

    private func performFullRefresh() async {
        await loadNavigation()
        // The drawer owns navigation summaries even before a task page mounts. Do not turn a
        // reconnect/coarse nudge into a speculative page read; a live selected detail, if any, is
        // still reconciled below.
        guard sectionActive else { return }
        scheduleCountsRefresh(force: true)
        let key = queryKey
        if requestedSnapshotKey == key || committedSnapshotKey == key || loading {
            await load()
        }
        guard sectionActive else { return }
        if let id = selectedDetailID {
            _ = await loadDetail(id)
        }
    }

    /// Apply one coalesced batch of `task.changed` ids without re-reading the task page or its
    /// owner-wide aggregates. Each request returns the same lightweight row shape as the page;
    /// A full snapshot already in flight is generation-invalidated so it cannot land afterwards
    /// and overwrite the newer event state. A row 404 is deliberately coarse-fallback rather than
    /// deletion: during a rolling server upgrade the event can come from a new instance while the
    /// row request lands on an old instance that has no such route. Protocol deletions already
    /// arrive as `resync`, so no valid incremental deletion depends on interpreting this 404.
    func refreshChangedTasks(_ ids: Set<String>) async {
        guard !ids.isEmpty else { return }
        countsInvalidationVersion &+= 1
        pendingChangedTaskIDs.formUnion(ids)
        await drainRefreshQueue()
    }

    /// One model-level worker for coarse and exact task refreshes.
    ///
    /// A full pass subsumes IDs that were already pending when it starts: its reads begin after
    /// those mutations committed. IDs arriving while the awaited full pass is in flight remain in
    /// fresh pending state and run as one trailing exact pass, so neither direction can lose work.
    private func drainRefreshQueue() async {
        guard !refreshDrainRunning else { return }
        refreshDrainRunning = true
        defer { refreshDrainRunning = false }

        while pendingFullRefresh || !pendingChangedTaskIDs.isEmpty {
            if pendingFullRefresh {
                pendingFullRefresh = false
                // Claimed before the await: anything enqueued afterwards belongs to the trailing
                // pass and is therefore not cleared here.
                pendingChangedTaskIDs.removeAll(keepingCapacity: true)
                await performFullRefresh()
                continue
            }

            let batch = pendingChangedTaskIDs
            pendingChangedTaskIDs.removeAll(keepingCapacity: true)
            await performChangedTaskRefresh(batch)
        }
    }

    private func performChangedTaskRefresh(_ ids: Set<String>) async {
        guard sectionActive else { return }
        await performChangedTaskPageRefresh(ids)
        // Detail is independent from the list request generation. Even if a periodic page load
        // superseded the row pass (or the row endpoint failed), the selected detail must still be
        // read after this event; `loadDetail` rechecks the live selection before committing.
        guard sectionActive, let id = selectedDetailID, ids.contains(id) else { return }
        _ = await loadDetail(id)
    }

    private func performChangedTaskPageRefresh(_ ids: Set<String>) async {
        let key = queryKey
        // AppModel exists even when the Tasks screen has never been opened. In that state there is
        // no page to keep fresh, so doing one row read per background event is pure load; opening
        // the screen will request its bounded snapshot. A failed/active request remains eligible so
        // the next event can heal an unseeded visible page.
        guard sectionActive else { return }
        guard requestedSnapshotKey == key || committedSnapshotKey == key || loading else { return }

        // A page request that began before this event may have read its database snapshot before
        // the mutation committed. Invalidating it is correct. If no snapshot for this exact query
        // has ever committed, retry the bounded page directly instead of first hydrating one row
        // that would only flash as the entire page and then be replaced by that snapshot.
        let needsSnapshotSeed = committedSnapshotKey != key
        listGeneration &+= 1
        loadMoreGeneration &+= 1
        loading = false
        loadingMore = false
        let generation = listGeneration
        if needsSnapshotSeed {
            if eventSeedRetryKey != key {
                eventSeedRetryKey = key
                eventSeedRetryNotBefore = .distantPast
            }
            guard Date() >= eventSeedRetryNotBefore else { return }
            eventSeedRetryNotBefore = Date().addingTimeInterval(15)
            _ = await load()
            return
        }
        var needsPageReconcile = false

        for id in ids.sorted() {
            let changed: TaskItem
            do {
                changed = try await api.taskRow(id)
            } catch APIError.http(let status, _) where status == 404 {
                guard generation == listGeneration, key == queryKey else { return }
                await refresh()
                return
            } catch {
                if isCancellation(error) { return }
                guard generation == listGeneration, key == queryKey else { return }
                errorText = friendly(error)
                continue
            }
            guard generation == listGeneration, key == queryKey else { return }

            needsPageReconcile = applyChangedTask(changed, id: id) || needsPageReconcile
        }
        if needsPageReconcile {
            await reconcileFirstPageRows(generation: generation, key: key)
        }
    }

    @discardableResult
    private func applyChangedTask(_ changed: TaskItem?, id: String) -> Bool {
        let result = TaskPageIncrementalReducer.reduce(
            items: items,
            changed: changed,
            taskID: id,
            scope: scope,
            filter: filter,
            search: searchText,
            hasMore: nextCursor != nil
        )
        items = result.items
        return result.needsPageReconcile
    }

    /// Refresh only the bounded first-page rows/cursor after an insertion crosses a partial page
    /// boundary. Aggregate counts stay cached; the next one-minute reconciliation updates them.
    private func reconcileFirstPageRows(generation: Int, key: String) async {
        do {
            let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
            let response = try await api.taskPage(limit: 200, status: filter.queryValue,
                                                  listId: scope.listQueryValue,
                                                  query: query.isEmpty ? nil : query,
                                                  counts: .none)
            guard generation == listGeneration, key == queryKey else { return }
            items = response.items
            nextCursor = response.nextCursor
        } catch {
            if isCancellation(error) { return }
            guard generation == listGeneration, key == queryKey else { return }
            errorText = friendly(error)
        }
    }

    // MARK: detail loading

    /// Returns true when the task loaded. `detailMissing` distinguishes a remote deletion (404)
    /// from a transient error so the view can pop only for the former.
    @discardableResult
    func loadDetail(_ id: String) async -> Bool {
        guard selectedDetailID == id else { return false }
        detailGeneration &+= 1
        let generation = detailGeneration
        if detail?.id != id { detail = nil }
        detailLoading = true
        detailMissing = false
        detailErrorText = nil
        defer { if generation == detailGeneration { detailLoading = false } }
        do {
            let response = try await api.task(id)
            guard generation == detailGeneration, selectedDetailID == id else { return false }
            detail = response
            return true
        } catch APIError.http(let status, _) where status == 404 {
            guard generation == detailGeneration, selectedDetailID == id else { return false }
            detail = nil
            detailMissing = true
            onSelectedDetailMissing?(id)
            return false
        } catch {
            guard generation == detailGeneration, selectedDetailID == id else { return false }
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

    /// Run now. The press is NAMED, once, here — this method IS the gesture, called straight from
    /// the button's action, and nothing between it and the wire redraws the name.
    ///
    /// Everything below this line is the same request and reuses it: the 401 refresh-and-retry
    /// inside `APIClient.send` re-sends the very `URLRequest` it built, body included, so the
    /// server answers the second delivery from the first one's receipt instead of starting a
    /// second run. A NEW press draws a new name unconditionally — including a press over the error
    /// the last one left on screen, which is a person deciding to run the task again rather than a
    /// resend of something already in flight.
    @discardableResult
    func execute(_ id: String) async -> Bool {
        let triggerId = PublicID.newToken()
        return await mutate(id) { try await self.api.executeTask(id, triggerId: triggerId) }
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
            // Apply the known deletion immediately. The server emits a coarse resync for delete
            // because cascaded dependency changes can affect other rows; that one trailing
            // snapshot, not every ordinary task event, reconciles the wider graph.
            listGeneration &+= 1
            loadMoreGeneration &+= 1
            loading = false
            loadingMore = false
            applyChangedTask(nil, id: id)
            // The delete can cascade into dependency/runnable rows. Queue a full pass explicitly:
            // if an older coarse pass was in flight, the generation bump above invalidated it and
            // this becomes its required trailing retry rather than losing the cascade update.
            await refresh()
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

    /// Pin (nil = clear) the provider this task's runs use instead of the assignee agent's.
    /// The model is cleared along with it: a model id only means something inside one provider's
    /// model space, so carrying it across a provider change would pin a stale id.
    func setProvider(_ id: String, _ provider: String?) async {
        let field: FieldUpdate<String> = provider.map { .set($0) } ?? .clear
        _ = await mutate(id) {
            _ = try await self.api.updateTask(id, UpdateTaskRequest(provider: field, model: .clear))
        }
    }

    /// Pin (nil = clear) the model this task's runs use, within its effective provider.
    func setModel(_ id: String, _ model: String?) async {
        let field: FieldUpdate<String> = model.map { .set($0) } ?? .clear
        _ = await mutate(id) {
            _ = try await self.api.updateTask(id, UpdateTaskRequest(model: field))
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
                limit: 50, query: q.isEmpty ? nil : q, counts: .none
            )
            guard generation == dependencyGeneration else { return }
            dependencyCandidates = response.items
        } catch {
            if isCancellation(error) { return }
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

    /// Run one mutation at a time per task, then read back that task's lightweight row. The old
    /// implementation refreshed navigation, the complete current page and detail after every
    /// button press, duplicating the control event and paying owner-wide aggregates for a one-row
    /// change.
    private func mutate(_ id: String, _ operation: @escaping () async throws -> Void) async -> Bool {
        guard !mutatingTaskIDs.contains(id) else { return false }
        mutatingTaskIDs.insert(id)
        errorText = nil
        defer { mutatingTaskIDs.remove(id) }
        do {
            try await operation()
            await refreshChangedTasks([id])
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

    private func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        return (error as? URLError)?.code == .cancelled
    }
}
