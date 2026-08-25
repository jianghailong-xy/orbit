import Foundation

/// Applies one authoritative task-row read to a loaded filtered page without refetching the page.
///
/// The reducer mirrors `GET /tasks/page` membership (scope, status filter and title search) and its
/// `(createdAt DESC, id DESC)` order. It deliberately reports an optional total delta: when a page
/// has a next cursor and the changed task was not loaded, the previous membership of that task is
/// unknowable from the current window, so claiming either zero or one would corrupt the total.
public enum TaskPageIncrementalReducer {
    public struct Result: Equatable, Sendable {
        public let items: [TaskItem]
        /// Change to the server's filtered total, or nil when the loaded page cannot prove it.
        public let filteredTotalDelta: Int?
        /// The changed row belongs inside a partial loaded window, but inserting it locally would
        /// invalidate the server's opaque cursor. The caller should reload page one with
        /// `counts=none` to obtain both the authoritative window and its new cursor.
        public let needsPageReconcile: Bool

        fileprivate init(items: [TaskItem], filteredTotalDelta: Int?, needsPageReconcile: Bool = false) {
            self.items = items
            self.filteredTotalDelta = filteredTotalDelta
            self.needsPageReconcile = needsPageReconcile
        }
    }

    /// Reconcile one `task.changed` id.
    ///
    /// - `changed == nil` is a caller-known removal and removes a loaded row.
    /// - A loaded row is replaced when it still matches, or removed when it leaves the query.
    /// - A matching row absent from a complete result is inserted locally. For a partial window,
    ///   rows older than the tail stay off-page and rows before the tail request a cheap page/cursor
    ///   reconciliation from the caller.
    public static func reduce(items: [TaskItem],
                              changed: TaskItem?,
                              taskID: String,
                              scope: TaskScope,
                              filter: TaskFilter,
                              search: String,
                              hasMore: Bool) -> Result {
        let taskKey = PublicID.storageKey(taskID)
        let existingIndex = items.firstIndex { PublicID.storageKey($0.id) == taskKey }

        guard let changed else {
            guard let existingIndex else {
                return Result(items: items, filteredTotalDelta: hasMore ? nil : 0)
            }
            var next = items
            next.remove(at: existingIndex)
            return Result(items: next, filteredTotalDelta: -1)
        }

        let belongs = matches(changed, scope: scope, filter: filter, search: search)
        if let existingIndex {
            var next = items
            if belongs {
                next[existingIndex] = changed
                next.sort(by: precedes)
                return Result(items: next, filteredTotalDelta: 0)
            }
            next.remove(at: existingIndex)
            return Result(items: next, filteredTotalDelta: -1)
        }

        guard belongs else {
            return Result(items: items, filteredTotalDelta: hasMore ? nil : 0)
        }

        let belongsInLoadedWindow = !hasMore || items.last.map { precedes(changed, $0) } == true
        guard belongsInLoadedWindow else {
            return Result(items: items, filteredTotalDelta: nil)
        }

        if hasMore {
            // The cursor is opaque and exclusive of the old tail. Inserting the new row and
            // evicting that tail would make load-more skip it forever; retaining both would let
            // repeated creates grow this window without bound. Ask for one cheap rows-only page
            // so the server supplies the matching new cursor.
            return Result(items: items, filteredTotalDelta: nil, needsPageReconcile: true)
        }
        var next = items
        next.append(changed)
        next.sort(by: precedes)
        return Result(items: next, filteredTotalDelta: 1)
    }

    private static func matches(_ task: TaskItem,
                                scope: TaskScope,
                                filter: TaskFilter,
                                search: String) -> Bool {
        guard matchesScope(task, scope), filter.matches(task) else { return false }
        // The server trims and bounds q to 200 characters before applying case-insensitive
        // containment. Native search uses the same localized case-insensitive comparison.
        let query = String(search.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))
        return query.isEmpty || task.title.localizedCaseInsensitiveContains(query)
    }

    private static func matchesScope(_ task: TaskItem, _ scope: TaskScope) -> Bool {
        switch scope {
        case .all:
            return true
        case .unlisted:
            return task.listId == nil
        case .list(let id):
            guard let listID = task.listId else { return false }
            return PublicID.storageKey(listID) == PublicID.storageKey(id)
        }
    }

    /// PostgreSQL's page cursor order: newest creation first, UUID descending as the deterministic
    /// tie-break. `createdAt` is non-null on current servers; nil stays oldest for old payloads.
    private static func precedes(_ lhs: TaskItem, _ rhs: TaskItem) -> Bool {
        let leftCreated = lhs.createdAt ?? ""
        let rightCreated = rhs.createdAt ?? ""
        if leftCreated != rightCreated { return leftCreated > rightCreated }
        return PublicID.storageKey(lhs.id) > PublicID.storageKey(rhs.id)
    }
}
