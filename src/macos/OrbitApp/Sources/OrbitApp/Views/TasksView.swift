import Foundation
import SwiftUI
import UniformTypeIdentifiers
import OrbitKit

/// Native Tasks list. Its information architecture and predicates mirror Web, while controls use
/// mobile-native menus/search/swipes instead of squeezing the desktop table onto an iPhone.
struct TasksListView: View {
    @Environment(AppModel.self) private var model
    /// How this list's rows navigate — the container fact the Agents column already names
    /// (`SessionRowNavigation`): a plain `List` in a `NavigationStack` takes no selection taps at
    /// all in non-edit mode, so the compact shell's rows carry their own destinations and push
    /// them (`AppModel.push`), while the three-column shells keep the `List`'s selection. Defaults
    /// to the selection shape, which is what the split shells want.
    var rowNavigation: SessionRowNavigation = .selection
    @State private var taskToDelete: TaskItem?

    var body: some View {
        if let tasks = model.tasks {
            @Bindable var tasks = tasks
            VStack(spacing: 0) {
                #if !os(iOS)
                if tasks.overview.total > 0 { TaskProgressSummary(overview: tasks.overview) }
                #endif
                if let error = tasks.errorText { errorBanner(error, tasks: tasks) }
                if let conflict = tasks.runConflict { runConflictBanner(conflict, tasks: tasks) }
                if let creator = tasks.creatorFilter { creatorChip(creator, tasks: tasks) }
                #if !os(iOS)
                toolbar(tasks)
                Divider()
                #endif
                taskList(tasks, selection: listSelection)
            }
            .navigationTitle(tasks.scopeTitle)
            .searchable(text: $tasks.searchText, prompt: "Search tasks")
            .task { await navigationRefreshLoop(tasks) }
            .task(id: tasks.queryKey) { await listRefreshLoop(tasks) }
            .confirmationDialog("Delete this task?", isPresented: deletePresented,
                                titleVisibility: .visible) {
                if let task = taskToDelete {
                    Button("Delete \(task.title)", role: .destructive) {
                        let id = task.id
                        taskToDelete = nil
                        Task {
                            if await tasks.deleteTask(id), model.selectedTaskID == id {
                                model.selectedTaskID = nil
                            }
                        }
                    }
                    .disabled(tasks.isMutating(task.id))
                }
                Button("Cancel", role: .cancel) { taskToDelete = nil }
            } message: {
                Text("This can't be undone. Finished run sessions are kept; a run still in flight is stopped.")
            }
            #if os(iOS)
            .toolbar {
                // Match the compact Sessions list: keep the content surface for rows and move
                // secondary controls into small, familiar navigation-bar menus. A long list name
                // can now never compete with the status and sort controls for horizontal space.
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Section("Status") {
                            ForEach(tasks.availableFilters) { filter in
                                Button { tasks.filter = filter } label: {
                                    if tasks.filter == filter {
                                        Label("\(filter.title) (\(tasks.overview.count(for: filter)))",
                                              systemImage: "checkmark")
                                    } else {
                                        Text("\(filter.title) (\(tasks.overview.count(for: filter)))")
                                    }
                                }
                            }
                        }

                        Menu {
                            scopeButton(.all, title: "All tasks", tasks: tasks)
                            if tasks.unlistedCount > 0 || tasks.scope == .unlisted {
                                scopeButton(.unlisted, title: "No list (\(tasks.unlistedCount))", tasks: tasks)
                            }
                            if !tasks.activeLists.isEmpty {
                                Section("Lists") {
                                    ForEach(tasks.activeLists) { list in
                                        scopeButton(.list(list.id),
                                                    title: "\(list.title) (\(list.taskCount))", tasks: tasks)
                                    }
                                }
                            }
                            if !tasks.completedLists.isEmpty {
                                Section("Completed lists") {
                                    ForEach(tasks.completedLists) { list in
                                        scopeButton(.list(list.id),
                                                    title: "\(list.title) (\(list.taskCount))", tasks: tasks)
                                    }
                                }
                            }
                        } label: {
                            Label("List: \(tasks.scopeTitle)", systemImage: "list.bullet")
                        }
                    } label: {
                        Image(systemName: compactFilterIcon(tasks))
                    }
                    .accessibilityLabel("Task filters, \(tasks.scopeTitle), \(tasks.filter.title)")
                }

                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Section("Sort by") {
                            ForEach(TaskSort.allCases) { sort in
                                Button { tasks.sort = sort } label: {
                                    if tasks.sort == sort { Label(sort.title, systemImage: "checkmark") }
                                    else { Text(sort.title) }
                                }
                            }
                        }
                        Button { tasks.descending.toggle() } label: {
                            Label(tasks.descending ? "Descending" : "Ascending",
                                  systemImage: tasks.descending ? "arrow.down" : "arrow.up")
                        }
                    } label: {
                        Image(systemName: "arrow.up.arrow.down")
                    }
                    .accessibilityLabel("Sort by \(tasks.sort.title), "
                                        + (tasks.descending ? "descending" : "ascending"))
                }
            }
            #endif
        } else {
            ProgressView()
        }
    }

    private var deletePresented: Binding<Bool> {
        Binding(
            get: { taskToDelete != nil },
            set: { if !$0 { taskToDelete = nil } }
        )
    }

    /// What the List's selection is bound to: the projection onto the Tasks stack in the
    /// three-column shape — the same projection the Agents column binds — and nothing at all in the
    /// compact one, whose rows carry their own destinations. Written as its own property so its
    /// type is decided here, not at the call site.
    private var listSelection: Binding<String?>? {
        guard rowNavigation == .selection else { return nil }
        return Binding(
            get: { model.selectedTaskID },
            set: { model.selectedTaskID = $0 })
    }

    private func scopeBinding(_ tasks: TasksModel) -> Binding<TaskScope> {
        Binding(
            get: { tasks.scope },
            set: { scope in
                model.selectedTaskID = nil
                tasks.selectScope(scope)
            }
        )
    }

    #if os(iOS)
    private func compactFilterIcon(_ tasks: TasksModel) -> String {
        tasks.scope == .all && tasks.filter == .runnable
            ? "line.3.horizontal.decrease"
            : "line.3.horizontal.decrease.circle.fill"
    }

    private func scopeButton(_ scope: TaskScope, title: String, tasks: TasksModel) -> some View {
        Button {
            model.selectedTaskID = nil
            tasks.selectScope(scope)
        } label: {
            if tasks.scope == scope { Label(title, systemImage: "checkmark") }
            else { Text(title) }
        }
    }
    #endif

    @ViewBuilder
    private func toolbar(_ tasks: TasksModel) -> some View {
        @Bindable var tasks = tasks
        HStack(spacing: 10) {
            Picker("List", selection: scopeBinding(tasks)) {
                Text("All tasks").tag(TaskScope.all)
                if tasks.unlistedCount > 0 || tasks.scope == .unlisted {
                    Text("No list (\(tasks.unlistedCount))").tag(TaskScope.unlisted)
                }
                ForEach(tasks.lists) { list in
                    Text("\(list.title) (\(list.taskCount))").tag(TaskScope.list(list.id))
                }
            }
            .pickerStyle(.menu)
            .labelsHidden()

            Picker("Filter", selection: $tasks.filter) {
                ForEach(tasks.availableFilters) { filter in
                    Text("\(filter.title) (\(tasks.overview.count(for: filter)))").tag(filter)
                }
            }
            .pickerStyle(.menu)
            .labelsHidden()

            Spacer(minLength: 0)

            Picker("Sort", selection: $tasks.sort) {
                ForEach(TaskSort.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.menu)
            .labelsHidden()
            .fixedSize()

            Button { tasks.descending.toggle() } label: {
                Image(systemName: tasks.descending ? "arrow.down" : "arrow.up")
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(tasks.descending ? "Sort descending" : "Sort ascending")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
    }

    private func taskList(_ tasks: TasksModel, selection: Binding<String?>?) -> some View {
        List(selection: selection) {
            #if os(iOS)
            // The progress overview scrolls with the content instead of permanently consuming
            // vertical space. Zero row insets let its own 12pt padding line up with the list rows.
            if tasks.overview.total > 0 {
                TaskProgressSummary(overview: tasks.overview)
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
            }
            #endif
            ForEach(tasks.visible) { task in
                taskRow(tasks, task)
            }
            if tasks.hasMore {
                Button {
                    Task { await tasks.loadMore() }
                } label: {
                    HStack {
                        Spacer()
                        if tasks.loadingMore { ProgressView().controlSize(.small) }
                        Text(tasks.loadingMore ? "Loading…" : "Load more")
                        Spacer()
                    }
                }
                .disabled(tasks.loadingMore)
            }
        }
        .orbitRevealSurface()
        #if os(iOS)
        // Sessions use a calm, full-width plain list on iPhone. Tasks now share that surface
        // instead of inheriting inset-grouped cards from the split-view environment.
        .listStyle(.plain)
        #endif
        .overlay { emptyOverlay(tasks) }
    }

    /// One row, wrapped for the container it is in — the same shape as `AgentPanes.sessionRow`. The
    /// row view itself is the same either way, actions included; what changes is who moves the
    /// screen: the three-column `List`'s selection, or the row's own destination value on the
    /// compact stack. There is no third state for "highlighted but not openable" to live in, because
    /// the highlight IS the pushed detail in both shapes.
    @ViewBuilder
    private func taskRow(_ tasks: TasksModel, _ task: TaskItem) -> some View {
        let row = TaskRowView(task: task)
        switch rowNavigation {
        case .selection:
            rowActions(row, tasks, task).tag(task.id)
        case .push:
            // A `Button`, not a `NavigationLink(value:)`: the link's disclosure indicator has no
            // usable hiding place on iOS 17/18 (see `AppModel.push` — which also keeps the detail
            // store in step with the page this puts up). `.foregroundStyle(.primary)`: a button's
            // label otherwise inherits the accent tint, and the row is unchanged by design (only
            // the wrapper is new). The row's actions wrap that `Button` — a `Button` does not pass
            // `.swipeActions` / `.contextMenu` up from its label, so nested inside it (where they
            // were) a swipe and a long press do nothing; see `rowActions`.
            rowActions(Button { model.push(.taskDetail(taskID: task.id)) } label: {
                row.foregroundStyle(.primary)
            }, tasks, task)
        }
    }

    /// The row's swipe actions and long-press menu, attached to the row itself rather than to the
    /// row's content: `.swipeActions` and `.contextMenu` are read off the view the `List` hosts as
    /// its row, and a `Button` does not pass them up from its label — leaving them inside the
    /// compact row's label (where they were) is a swipe and a long press that do nothing.
    private func rowActions<V: View>(_ row: V, _ tasks: TasksModel, _ task: TaskItem) -> some View {
        row
            .swipeActions(edge: .leading, allowsFullSwipe: false) {
                if TaskListLogic.canStart(task) {
                    runButton(tasks, task)
                        .tint(task.status == .failed ? .orange : .blue)
                }
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                Button(role: .destructive) { taskToDelete = task } label: {
                    Label("Delete", systemImage: "trash")
                }
                .disabled(tasks.isMutating(task.id))
            }
            .contextMenu { rowMenu(tasks, task) }
    }

    @ViewBuilder
    private func rowMenu(_ tasks: TasksModel, _ task: TaskItem) -> some View {
        // A task that is already going offers the run instead of a press that can only be refused
        // — and that entry is offered whether or not the task would otherwise be startable, since
        // "something of this is running" is precisely why `canStart` says no.
        let entry = TaskRunHandoff.entry(for: task)
        if entry.kind == .openRun { openRunButton(entry, task) }
        else if TaskListLogic.canStart(task) { runButton(tasks, task) }
        Button(role: .destructive) { taskToDelete = task } label: {
            Label("Delete", systemImage: "trash")
        }
        .disabled(tasks.isMutating(task.id))
    }

    private func runButton(_ tasks: TasksModel, _ task: TaskItem) -> some View {
        let entry = TaskRunHandoff.entry(for: task)
        return Button {
            Task { _ = await tasks.execute(task.id) }
        } label: {
            Label(entry.label,
                  systemImage: entry.kind == .retry ? "arrow.clockwise" : "play.fill")
        }
        .disabled(tasks.isMutating(task.id))
    }

    /// Where a row sends a reader when the task is already going. A list row carries the live flags
    /// but no session ids, so there is nothing here to route to — it opens the task, where the run
    /// is named. Guessing at a run from a row that has none is the mistake this whole change is
    /// about, in the other direction.
    private func openRunButton(_ entry: TaskRunHandoff.Entry, _ task: TaskItem) -> some View {
        Button {
            if let id = entry.sessionID { model.route(to: .session(id)) }
            else { model.route(to: .task(task.id)) }
        } label: {
            Label(entry.label, systemImage: "arrow.right")
        }
    }

    @ViewBuilder
    private func emptyOverlay(_ tasks: TasksModel) -> some View {
        if tasks.loading && tasks.items.isEmpty {
            ProgressView().controlSize(.large)
        } else if tasks.items.isEmpty, let error = tasks.errorText {
            VStack(spacing: 10) {
                ContentUnavailableView("Tasks couldn't be loaded", systemImage: "wifi.exclamationmark",
                                       description: Text(error))
                Button("Retry") { Task { await tasks.load() } }
            }
        } else if tasks.visible.isEmpty {
            let query = tasks.searchText.trimmingCharacters(in: .whitespacesAndNewlines)
            ContentUnavailableView(
                query.isEmpty
                    ? (tasks.filter == .runnable ? "No tasks are ready" : "No tasks")
                    : "No matching tasks",
                systemImage: query.isEmpty ? "checklist" : "magnifyingglass",
                description: query.isEmpty ? nil : Text("No task title matches “\(query)”.")
            )
        }
    }

    private func errorBanner(_ error: String, tasks: TasksModel) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            Text(error).font(.orbitLabel).lineLimit(2)
            Spacer(minLength: 0)
            Button { tasks.errorText = nil } label: { Image(systemName: "xmark") }
                .buttonStyle(.borderless)
                .accessibilityLabel("Dismiss error")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.orange.opacity(0.12))
    }

    /// `Created in ‹session›`: the page is narrowed to what that session created — where its "Tasks
    /// created here" card's `View all in Tasks ›` lands. The ✕ takes only that narrowing off.
    private func creatorChip(_ creator: TaskCreatorFilter, tasks: TasksModel) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "checkmark.square").font(.orbitMeta).foregroundStyle(.secondary)
            Text(SessionCreatedTasksCopy.createdIn(creator.sessionTitle))
                .font(.orbitLabel).lineLimit(1).truncationMode(.tail)
            Button { tasks.clearCreatorFilter() } label: { Image(systemName: "xmark.circle.fill") }
                .buttonStyle(.plain).foregroundStyle(.secondary)
                .accessibilityLabel("Remove the Created in filter")
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(Color.accentColor.opacity(0.1), in: Capsule())
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }

    /// The same card the console shows, over the list — where a Run press is made and so where its
    /// answer belongs. A list row names no run, so `Open the run` appears only when the refusal
    /// itself named one, which it does.
    private func runConflictBanner(_ conflict: TaskRunHandoff.Conflict,
                                   tasks: TasksModel) -> some View {
        let clearPin: (() -> Void)? = conflict.taskID.map { id in
            { Task { await tasks.setProvider(id, nil) } }
        }
        return TaskRunHandoffCard(conflict: conflict,
                                  onOpenRun: { model.route(to: .session($0)) },
                                  onClearPin: clearPin,
                                  onDismiss: { tasks.clearRunConflict() })
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
    }

    private func listRefreshLoop(_ tasks: TasksModel) async {
        // Debounce server-backed filter/search changes for every scope, including named lists;
        // their contents now use the same bounded page endpoint as All and No-list.
        do { try await Task.sleep(nanoseconds: 250_000_000) }
        catch { return }
        let loaded = await tasks.load()
        var lastSnapshot = loaded ? Date() : .distantPast
        while !Task.isCancelled {
            let delay: UInt64 = tasks.hasBusyTasks ? 5_000_000_000 : 15_000_000_000
            do { try await Task.sleep(nanoseconds: delay) }
            catch { return }
            // The owner stream now applies task.changed by id. Polling the same page underneath a
            // healthy stream both duplicates that work and, on a large Ready scope, repeats its
            // aggregate query forever. Keep a slow one-minute reconciliation for count drift and
            // rolling-version gaps; reconnect also performs an immediate snapshot.
            if model.controlPlaneLive, Date().timeIntervalSince(lastSnapshot) < 60 { continue }
            let now = Date()
            let refreshCounts = tasks.countsRefreshedAt.map {
                now.timeIntervalSince($0) >= 60
            } ?? false
            if await tasks.load(refreshCounts: refreshCounts) { lastSnapshot = now }
        }
    }

    private func navigationRefreshLoop(_ tasks: TasksModel) async {
        await tasks.loadNavigation()
        var lastSnapshot = Date()
        while !Task.isCancelled {
            let busy = tasks.lists.contains { ($0.runningTasks ?? 0) > 0 }
            do { try await Task.sleep(nanoseconds: busy ? 5_000_000_000 : 15_000_000_000) }
            catch { return }
            if model.controlPlaneLive, Date().timeIntervalSince(lastSnapshot) < 60 { continue }
            await tasks.loadNavigation()
            lastSnapshot = Date()
        }
    }
}

#if os(iOS)
/// The complete task-list directory lives one level deeper than the drawer. This keeps the drawer
/// useful as a quick switcher while giving large workspaces a native searchable, grouped surface.
struct TaskListsDirectoryView: View {
    @Environment(AppModel.self) private var model
    let tasks: TasksModel
    @State private var query = ""

    var body: some View {
        List {
            if normalizedQuery.isEmpty {
                Section {
                    scopeRow(.unlisted, title: "No List", count: tasks.unlistedCount,
                             systemImage: "tray")
                }
            }

            if !matchingActiveLists.isEmpty {
                Section("Active") {
                    ForEach(matchingActiveLists) { list in listRow(list, completed: false) }
                }
            }

            if !matchingCompletedLists.isEmpty {
                Section("Completed") {
                    ForEach(matchingCompletedLists) { list in listRow(list, completed: true) }
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle("Task Lists")
        .navigationBarTitleDisplayMode(.large)
        .searchable(text: $query, prompt: "Search lists")
        .refreshable { await tasks.loadNavigation() }
        .overlay {
            if !normalizedQuery.isEmpty
                && matchingActiveLists.isEmpty
                && matchingCompletedLists.isEmpty {
                ContentUnavailableView(
                    "No Matching Lists",
                    systemImage: "magnifyingglass",
                    description: Text("No task list matches “\(normalizedQuery)”.")
                )
            }
        }
        .task {
            if tasks.lists.isEmpty { await tasks.loadNavigation() }
        }
    }

    private var normalizedQuery: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var matchingActiveLists: [TaskListSummary] {
        matching(tasks.activeLists)
    }

    private var matchingCompletedLists: [TaskListSummary] {
        matching(tasks.completedLists)
    }

    private func matching(_ lists: [TaskListSummary]) -> [TaskListSummary] {
        guard !normalizedQuery.isEmpty else { return lists }
        return lists.filter { $0.title.localizedCaseInsensitiveContains(normalizedQuery) }
    }

    private func scopeRow(_ scope: TaskScope, title: String, count: Int?,
                          systemImage: String) -> some View {
        Button { open(scope) } label: {
            HStack(spacing: 12) {
                Label(title, systemImage: systemImage)
                    .foregroundStyle(.primary)
                Spacer(minLength: 8)
                if let count {
                    Text("\(count)").font(.orbitMeta).foregroundStyle(.secondary)
                }
                if tasks.scope == scope {
                    Image(systemName: "checkmark")
                        .font(.orbitMeta.weight(.semibold))
                        .foregroundStyle(Color.accentColor)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func listRow(_ list: TaskListSummary, completed: Bool) -> some View {
        let running = (list.runningTasks ?? 0) > 0
        let selected = tasks.scope == .list(list.id)
        return Button { open(.list(list.id)) } label: {
            HStack(spacing: 12) {
                Group {
                    if running {
                        ProgressView().controlSize(.mini).tint(.blue)
                    } else {
                        Image(systemName: completed ? "checkmark.circle.fill" : "circle.fill")
                            .font(.orbitMeta)
                            .foregroundStyle(completed ? Color.green : Color.secondary.opacity(0.5))
                    }
                }
                .frame(width: 20)

                Text(list.title)
                    .lineLimit(1)
                    .foregroundStyle(completed ? .secondary : .primary)
                Spacer(minLength: 8)
                Text("\(list.taskCount)")
                    .font(.orbitMeta)
                    .foregroundStyle(.secondary)
                if selected {
                    Image(systemName: "checkmark")
                        .font(.orbitMeta.weight(.semibold))
                        .foregroundStyle(Color.accentColor)
                }
            }
            .padding(.vertical, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityValue("\(list.taskCount) tasks"
                            + (running ? ", running" : completed ? ", completed" : ""))
    }

    /// Picking a list closes the directory onto it. The close is a pop of this page off the Tasks
    /// stack now, so the list you pick is the page underneath rather than a boolean being lowered
    /// over whatever the shell happened to be showing.
    private func open(_ scope: TaskScope) {
        model.selectedTaskID = nil
        tasks.selectScope(scope)
        model.taskListsDirectoryPresented = false
    }
}

/// The directory of every named task list, pushed onto the compact Tasks stack — the
/// `.taskListsDirectory` frame. Its one entry point is the drawer's "View All Lists" row.
struct TaskListsDirectoryPage: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let tasks = model.tasks {
            TaskListsDirectoryView(tasks: tasks)
        } else {
            ProgressView()
        }
    }
}
#endif

private struct TaskProgressSummary: View {
    let overview: TaskOverview

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            ProgressView(value: Double(overview.done), total: Double(max(overview.total, 1)))
                .tint(.green)
            Text(summary)
                .font(.orbitMeta)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 4)
    }

    private var summary: String {
        var parts = ["Done \(overview.done) / \(overview.total)",
                     "Open \(overview.open + overview.inProgress)"]
        if overview.running > 0 { parts.append("Running \(overview.running)") }
        if overview.queued > 0 { parts.append("Queued \(overview.queued)") }
        if overview.failed > 0 { parts.append("Failed \(overview.failed)") }
        return parts.joined(separator: " · ")
    }
}

struct TaskRowView: View {
    let task: TaskItem

    var body: some View {
        #if os(iOS)
        compactRow
        #else
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(task.title).lineLimit(2)
                    if TaskListLogic.isBlocked(task) {
                        Image(systemName: "lock.fill")
                            .font(.orbitMeta)
                            .foregroundStyle(task.dependencyState == "BLOCKED_FAILED" ? .red : .secondary)
                            .help(task.dependencyState == "BLOCKED_FAILED"
                                  ? "A prerequisite failed or was cancelled"
                                  : "Waiting for prerequisites")
                    }
                }
                HStack(spacing: 7) {
                    TaskStatusPill(pill: TaskListLogic.pill(task))
                    Text(task.assignee?.name ?? "Unassigned")
                        .font(.orbitListSubtitle)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 4)
            if let count = task.commentCount, count > 0 {
                Label("\(count)", systemImage: "text.bubble")
                    .font(.orbitMeta)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 3)
        #endif
    }

    #if os(iOS)
    /// The same two-line rhythm as the compact Session row: identity and recency on top,
    /// state and owner below. Keeping titles to one line makes a long batch of similarly named
    /// tasks much faster to scan while the detail screen remains the place for the full title.
    private var compactRow: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(task.title).lineLimit(1)
                if TaskListLogic.isBlocked(task) {
                    Image(systemName: "lock.fill")
                        .font(.orbitMeta)
                        .foregroundStyle(task.dependencyState == "BLOCKED_FAILED" ? .red : .secondary)
                }
                Spacer(minLength: 8)
                if let relativeTime {
                    Text(relativeTime)
                        .font(.orbitMeta)
                        .foregroundStyle(.secondary)
                }
            }
            HStack(spacing: 7) {
                TaskStatusPill(pill: TaskListLogic.pill(task))
                Text(task.assignee?.name ?? "Unassigned")
                    .font(.orbitListSubtitle)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 4)
                if let count = task.commentCount, count > 0 {
                    Label("\(count)", systemImage: "text.bubble")
                        .font(.orbitMeta)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private var relativeTime: String? {
        guard let timestamp = task.updatedAt ?? task.createdAt else { return nil }
        return RelativeTime.format(timestamp)
    }
    #endif
}

/// Shape + color + text makes status readable without relying on color alone.
struct TaskStatusPill: View {
    let pill: TaskPill

    var body: some View {
        HStack(spacing: 4) {
            if pill.kind == .running { ProgressView().controlSize(.mini) }
            else { Circle().fill(color).frame(width: 6, height: 6) }
            Text(pill.label).font(.orbitMeta)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(color.opacity(0.15), in: Capsule())
        .foregroundStyle(color)
    }

    private var color: Color {
        switch pill.kind {
        case .running, .inProgress: return .blue
        case .queued:               return .orange
        case .done:                 return .green
        case .open:                 return .secondary
        case .failed:               return .red
        case .cancelled:            return .gray
        }
    }
}

/// Selected task detail. Busy/blocked state is derived from detail sessions/dependencyState rather
/// than absent list-only flags, fixing duplicate Run actions on iOS.
struct TaskDetailView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let tasks = model.tasks, let id = model.selectedTaskID {
            TaskDetailContent(tasks: tasks, taskID: id).id(id)
        } else {
            ContentUnavailableView("Select a task", systemImage: "checklist",
                                   description: Text("Task details appear here."))
        }
    }
}

/// One task's detail, pushed onto the compact Tasks stack — the `.taskDetail` frame. The
/// three-column shells render the same content inline in the detail pane (`TaskDetailView`); the
/// container is what differs, not the page, so this one renders the task the frame carries instead
/// of reading a second selection back out of the stack.
struct TaskDetailPage: View {
    @Environment(AppModel.self) private var model
    let taskID: String

    var body: some View {
        if let tasks = model.tasks {
            TaskDetailContent(tasks: tasks, taskID: taskID).id(taskID)
        } else {
            ProgressView()
        }
    }
}

private struct TaskDetailContent: View {
    @Environment(AppModel.self) private var model
    let tasks: TasksModel
    let taskID: String

    @State private var newComment = ""
    @State private var confirmingDelete = false
    @State private var confirmingReopen = false
    @State private var showingDependencyPicker = false
    /// The Share panel, and whether the task has a public link open — what the menu's Share… says
    /// under itself. Read when the task opens; the panel hands back every change made in it.
    @State private var sharing = false
    @State private var shareRead: ShareLinkRead?
    /// Whether the page's own header is on screen; once it scrolls away the bar takes the title.
    @State private var headerOnScreen = true
    @State private var editingSchedule = false
    @State private var editingAcceptance = false
    @State private var following = false
    @State private var importingInput = false
    @State private var inputToRemove: TaskInput?
    @State private var prerequisiteToRemove: TaskDependencyListRow?
    /// The reader's Graph/List choice; nil follows the component (`TaskDetailLogic.prefersGraph`).
    @State private var dependencyView: DependencyView?

    private enum DependencyView: Hashable { case graph, list }

    var body: some View {
        Group {
            if let task = tasks.detail, task.id == taskID {
                page(task)
            } else if let error = tasks.detailErrorText {
                VStack(spacing: 12) {
                    ContentUnavailableView("Task couldn't be loaded", systemImage: "exclamationmark.triangle",
                                           description: Text(error))
                    Button("Retry") { Task { await loadDetail() } }
                }
            } else {
                ProgressView().controlSize(.large).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        #if os(iOS)
        // The session and project pages' bar: nothing while the page's own header shows the title,
        // then the title over a status line, centred, once it has scrolled away.
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        #else
        .navigationTitle(tasks.detail?.id == taskID ? (tasks.detail?.title ?? "Task") : "Task")
        #endif
        .toolbar {
            #if os(iOS)
            if !headerOnScreen, let task = tasks.detail, task.id == taskID {
                ToolbarItem(placement: .principal) { TaskNavTitle(task: task) }
            }
            #endif
            if tasks.detail?.id == taskID {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        // Two words for two links (docs/share-links-design.md §8). Copy Link is the
                        // signed-in address, for yourself; Share… is the public read-only link, and
                        // says under itself whether one is open. Copy as Markdown needs neither.
                        if let url = model.taskWebURL(taskID) {
                            Button {
                                PlatformPasteboard.copyString(url.absoluteString)
                                PlatformHaptics.success()
                                model.showToast(SharePanelCopy.linkCopied)
                            } label: {
                                Label(SharePanelCopy.copyLink, systemImage: "link")
                            }
                        }
                        Button { sharing = true } label: {
                            Label(SharePanelCopy.share, systemImage: "globe")
                            if let status = SharePanel.menuStatus(shareRead) { Text(status) }
                        }
                        if let task = tasks.detail, let url = model.taskWebURL(taskID) {
                            Button {
                                PlatformPasteboard.copyString(ShareMarkdown.task(task, link: url.absoluteString))
                                PlatformHaptics.success()
                                model.showToast(SharePanelCopy.markdownCopied)
                            } label: {
                                Label(SharePanelCopy.copyAsMarkdown, systemImage: "doc.plaintext")
                            }
                        }
                        // Setting the status by hand starts nothing and confirms nothing, so it is held
                        // here rather than beside the presses under the title — where, on a task its
                        // owner confirms, it read as a second `Confirm done`.
                        if let task = tasks.detail, task.status != .done {
                            Divider()
                            Button {
                                Task { await tasks.setStatus(task.id, .done) }
                            } label: {
                                Label("Mark done", systemImage: "checkmark")
                            }
                            .disabled(tasks.isMutating(taskID))
                        }
                        Divider()
                        Button(role: .destructive) { confirmingDelete = true } label: {
                            Label("Delete task", systemImage: "trash")
                        }
                        .disabled(tasks.isMutating(taskID))
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .accessibilityLabel("Task actions")
                }
            }
        }
        .task(id: taskID) {
            await loadDetail()
            // After the detail, so the panel's owner-confirmation rule has both halves of what it
            // reads: this task's criterion and status, and what a run of it is waiting on.
            await tasks.loadOwnerConfirmation(taskID)
            await tasks.loadAttribution(taskID)
            await tasks.loadDependencyGraph(taskID)
            if model.agents?.items.isEmpty == true { await model.agents?.load() }
            await tasks.loadNavigation()
            await model.watches?.load()
        }
        .task(id: detailPollKey) { await pollBusyDetail() }
        .task(id: taskID) {
            guard let baseURL = model.baseURL else { return }
            // Nil when it could not be read: the menu then says nothing rather than guessing.
            shareRead = try? await APIClient(baseURL: baseURL, tokenStore: model.tokenStore).shareLink(.task, taskID)
        }
        .sheet(isPresented: $sharing) {
            if let baseURL = model.baseURL {
                ShareSheet(kind: .task, rootID: taskID, baseURL: baseURL, tokenStore: model.tokenStore) {
                    shareRead = $0
                }
            }
        }
        .sheet(isPresented: $showingDependencyPicker) {
            let existing = Set((tasks.detail?.dependsOn ?? []).compactMap { $0.dependsOnTask?.id })
            TaskDependencyPicker(tasks: tasks, taskID: taskID, existing: existing)
        }
        .sheet(isPresented: $editingSchedule) {
            if let task = tasks.detail, task.id == taskID {
                TaskScheduleSheet(task: task, onSave: { date in
                    let saved = await tasks.setRunAt(task.id, date)
                    if saved { model.showToast(TaskDetailCopy.scheduleSaved) }
                    return saved
                }, onCancelSchedule: {
                    let cancelled = await tasks.setRunAt(task.id, nil)
                    if cancelled { model.showToast(TaskDetailCopy.scheduleCancelled) }
                    return cancelled
                })
            }
        }
        .sheet(isPresented: $editingAcceptance) {
            if let task = tasks.detail, task.id == taskID {
                TaskAcceptanceSheet(current: TaskAcceptanceDraft(task: task)) { request in
                    let saved = await tasks.saveAcceptance(task.id, request)
                    if saved { model.showToast(TaskDetailCopy.acceptanceSaved) }
                    return saved
                }
            }
        }
        .sheet(isPresented: $following) {
            if let task = tasks.detail, task.id == taskID, let store = model.watches {
                TaskFollowSheet(task: task, store: store) { watch in
                    model.showToast(TaskDetailLogic.followedToast(watch))
                }
            }
        }
        .fileImporter(isPresented: $importingInput, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            Task { await addInputs(urls) }
        }
        .confirmationDialog("Delete this task?", isPresented: $confirmingDelete,
                            titleVisibility: .visible) {
            Button("Delete task", role: .destructive) {
                Task {
                    if await tasks.deleteTask(taskID), model.selectedTaskID == taskID {
                        model.selectedTaskID = nil
                    }
                }
            }
            .disabled(tasks.isMutating(taskID))
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("This can't be undone. Finished run sessions are kept; a run still in flight is stopped.")
        }
        // The way back from a status already written — offered on the three statuses that mean the
        // work has stopped, and asked once. Answered with `TaskReopen.modalOK` rather than the
        // question's words: the press has already been made once.
        .confirmationDialog(TaskReopenCopy.modalTitle, isPresented: $confirmingReopen,
                            titleVisibility: .visible) {
            Button(TaskReopenCopy.modalOK) {
                Task { _ = await tasks.reopen(taskID) }
            }
            .disabled(tasks.isMutating(taskID))
            Button("Cancel", role: .cancel) { }
        } message: {
            // The sentences the browser's question carries, in the same order — the conditional ones
            // are included by `paragraphs` only when they are true of this row.
            Text(TaskReopen.paragraphs(tasks.detail).joined(separator: "\n\n"))
        }
        .confirmationDialog(TaskDetailCopy.removeInputTitle,
                            isPresented: Binding(get: { inputToRemove != nil },
                                                 set: { if !$0 { inputToRemove = nil } }),
                            titleVisibility: .visible, presenting: inputToRemove) { input in
            Button(TaskDetailCopy.remove, role: .destructive) {
                Task { await tasks.removeInput(taskID, inputID: input.id) }
            }
            Button("Cancel", role: .cancel) { }
        } message: { _ in
            Text(TaskDetailCopy.removeInputDetail)
        }
        .confirmationDialog(TaskDetailCopy.removePrerequisiteTitle,
                            isPresented: Binding(get: { prerequisiteToRemove != nil },
                                                 set: { if !$0 { prerequisiteToRemove = nil } }),
                            titleVisibility: .visible, presenting: prerequisiteToRemove) { row in
            Button(TaskDetailCopy.remove, role: .destructive) {
                Task { await tasks.removeDependency(taskID, dependsOn: row.id) }
            }
            Button("Cancel", role: .cancel) { }
        } message: { _ in
            Text(TaskDetailCopy.removePrerequisiteDetail)
        }
    }

    private var detailPollKey: String {
        let busy = tasks.detail.map(TaskListLogic.isBusy) ?? false
        return "\(taskID)|\(busy)"
    }

    private func loadDetail() async {
        let loaded = await tasks.loadDetail(taskID)
        if !loaded, tasks.detailMissing, model.selectedTaskID == taskID {
            model.selectedTaskID = nil
        }
    }

    /// Pull to refresh: the detail and every read beside it.
    private func reload() async {
        await loadDetail()
        await tasks.loadOwnerConfirmation(taskID)
        await tasks.loadAttribution(taskID)
        await tasks.loadDependencyGraph(taskID)
        await model.watches?.load()
    }

    private func pollBusyDetail() async {
        // This task fires when the detail's busy flag flips — which is exactly when a run ended its
        // turn, and therefore when the owner may have just been asked something. The read is what
        // turns that into the card's pointer rather than into a stale `Confirm done`.
        await tasks.loadOwnerConfirmation(taskID)
        guard let task = tasks.detail, task.id == taskID, TaskListLogic.isBusy(task) else { return }
        while !Task.isCancelled {
            do { try await Task.sleep(nanoseconds: 4_000_000_000) }
            catch { return }
            guard model.selectedTaskID == taskID else { return }
            _ = await tasks.loadDetail(taskID)
            guard let current = tasks.detail, TaskListLogic.isBusy(current) else { return }
        }
    }

    // MARK: the page

    /// The web's `TaskDetailPanel`, block for block and in its order: the head and its presses,
    /// [the check that settles the row], Details, Dependencies, Description, Acceptance, Inputs,
    /// Attribution, Followed by, Runs, Comments — and the comment box, which stays on screen.
    private func page(_ task: TaskItem) -> some View {
        List {
            Section {
                header(task)
                    .onAppear { headerOnScreen = true }
                    .onDisappear { headerOnScreen = false }
                banners(task)
                actions(task)
            }
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            // A row settled by a check always gets the card — with the check, or with the fact that
            // there isn't one. That empty state is where a reader otherwise reads the header hint's
            // sentence and finds nothing behind it.
            if TaskJudgment.isGateRow(task) || task.verifier != nil { verifierSection(task) }
            detailsSection(task)
            dependenciesSection(task)
            descriptionSection(task)
            acceptanceSection(task)
            inputsSection(task)
            attributionSection(task)
            followedBySection(task)
            runsSection(task)
            commentsSection(task)
        }
        .taskPageListStyle()
        .safeAreaInset(edge: .bottom) { composer(task) }
        .refreshable { await reload() }
    }

    private func header(_ task: TaskItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(task.title)
                .font(.title2.weight(.bold))
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            // The browser's meta line: the status, who has the task, and when it was made.
            HStack(spacing: 8) {
                TaskStatusPill(pill: TaskListLogic.pill(task))
                if let assignee = task.assignee {
                    HStack(spacing: 5) {
                        TaskAvatar(name: assignee.name)
                        Text(assignee.name ?? "Unassigned").lineLimit(1)
                    }
                }
                if let created = task.createdAt, let relative = RelativeTime.format(created) {
                    Text("· \(relative)").foregroundStyle(.secondary).lineLimit(1)
                }
            }
            .font(.orbitSubtext)
            // How this row is judged, which nothing else on the page said.
            if let chip = TaskJudgment.chip(task) { judgmentChip(chip) }
        }
        .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 4))
    }

    /// The judgment chip: a gate row reads apart from the method chips, because it says something
    /// different in kind — not which method settles the row, but that no run of it can.
    private func judgmentChip(_ chip: TaskJudgmentChip) -> some View {
        HStack(spacing: 4) {
            Image(systemName: chip.isGate ? "checkmark.shield" : "checkmark.seal")
                .foregroundStyle(chip.isGate ? Color.orange : Color.green)
            Text(chip.text).foregroundStyle(chip.isGate ? Color.orange : Color.secondary)
        }
        .font(.orbitLabel)
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .overlay(Capsule().strokeBorder((chip.isGate ? Color.orange : Color.secondary).opacity(0.35), lineWidth: 0.5))
        .background(chip.isGate ? Color.orange.opacity(0.1) : Color.clear, in: Capsule())
    }

    /// What went wrong the last time, above the presses it is about.
    @ViewBuilder
    private func banners(_ task: TaskItem) -> some View {
        if let error = tasks.detailErrorText {
            detailErrorBanner(error, canRetry: true)
        }
        if let error = tasks.errorText { detailErrorBanner(error) }
        if let conflict = tasks.runConflict {
            // Offered only when the refusal named the task — clearing a pin edits the TASK, so
            // without one there is nothing for the button to act on.
            let clearPin: (() -> Void)? = conflict.taskID.map { id in
                { Task { await tasks.setProvider(id, nil) } }
            }
            TaskRunHandoffCard(conflict: conflict,
                               onOpenRun: { model.route(to: .session($0)) },
                               onClearPin: clearPin,
                               onDismiss: { tasks.clearRunConflict() })
        }
    }

    // MARK: actions

    private func actionRow(_ task: TaskItem) -> TaskDetailActionRow {
        let read = tasks.ownerConfirmation?.taskId == task.id ? tasks.ownerConfirmation : nil
        let owner = OwnerConfirmations.panelAction(
            read,
            taskIsOwnerConfirmed: task.completionCriterion == OwnerConfirmations.ownerConfirmedCriterion,
            taskUnsettled: task.status == .open || task.status == .inProgress,
            taskHasRuns: !(task.sessions ?? []).isEmpty)
        // The detail carries the task's sessions, so when a run has it this knows WHICH one and
        // links straight there. The live run wins over `status`, which lags.
        return TaskDetailLogic.actionRow(owner: owner, reopenable: TaskReopen.isOffered(task), status: task.status,
                                         gate: TaskJudgment.isGateRow(task), entry: TaskRunHandoff.entry(for: task))
    }

    /// At most two presses, each half the row and on one line: the one that concludes the task on
    /// the left, the one that moves it forward on the right. The pointer to a waiting run's card is
    /// too long to share the row, so in that one state the two stack.
    @ViewBuilder
    private func actions(_ task: TaskItem) -> some View {
        let row = actionRow(task)
        if !row.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                if row.stacked {
                    if let leading = row.leading { leadingButton(leading, task) }
                    if let trailing = row.trailing { trailingButton(trailing, task, prominent: false) }
                } else {
                    HStack(spacing: 10) {
                        if let leading = row.leading { leadingButton(leading, task) }
                        if let trailing = row.trailing { trailingButton(trailing, task, prominent: true) }
                    }
                }
                // Said only when the press cannot be taken: a live run's button already says where it goes.
                if let trailing = row.trailing, !isOpenRun(trailing), !canStart(task),
                   let hint = runDisabledHint(task) {
                    Text(hint).font(.orbitLabel).foregroundStyle(.secondary)
                }
            }
            .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 4, trailing: 0))
        }
    }

    private func isOpenRun(_ trailing: TaskDetailActionRow.Trailing) -> Bool {
        if case .openRun = trailing { return true }
        return false
    }

    private func canStart(_ task: TaskItem) -> Bool {
        TaskListLogic.canStart(task, assigneeHasRunner: assigneeHasRunner(task))
    }

    /// The owner's confirmation, for a task an OWNER_CONFIRMED criterion settles: a pointer to the
    /// card while a run of it is waiting on the owner, `Confirm done` when no run is — one state, one
    /// place to answer (`OwnerConfirmations.panelAction`). Or, on a stopped task, the way back.
    @ViewBuilder
    private func leadingButton(_ leading: TaskDetailActionRow.Leading, _ task: TaskItem) -> some View {
        switch leading {
        case .waitingForConfirmation(let sessionID):
            Button { model.route(to: .session(sessionID)) } label: {
                Label(OwnerConfirmations.waitingForConfirmation, systemImage: "arrow.turn.down.right")
                    .lineLimit(1)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(.orange)
            .controlSize(.large)
        case .confirmDone:
            Button { Task { _ = await tasks.confirmOwner(task.id) } } label: {
                Label(OwnerConfirmations.confirmAction, systemImage: "checkmark.seal")
                    .lineLimit(1)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .disabled(tasks.isMutating(task.id))
        case .reopen:
            // Beside Run/Retry rather than instead of it, and deliberately not the prominent press:
            // this one starts nothing. It only takes the status back — the sole move for a DONE task,
            // and the only one that lifts a supersession record a replaced attempt's Run is refused by.
            Button { confirmingReopen = true } label: {
                Label(TaskReopenCopy.actionLabel, systemImage: "arrow.uturn.backward")
                    .lineLimit(1)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .disabled(tasks.isMutating(task.id))
        }
    }

    /// The press that moves the task forward: into its live run when one is going, else the run it
    /// can start. A gate row's button says what it cannot do rather than naming the press it will
    /// not take.
    @ViewBuilder
    private func trailingButton(_ trailing: TaskDetailActionRow.Trailing, _ task: TaskItem,
                                prominent: Bool) -> some View {
        let busy = tasks.isMutating(task.id)
        let button = Group {
            switch trailing {
            case .openRun(let sessionID):
                Button { if let sessionID { model.route(to: .session(sessionID)) } } label: {
                    Label(TaskRunHandoff.openTheRun, systemImage: "arrow.right")
                        .lineLimit(1)
                        .frame(maxWidth: .infinity)
                }
                .disabled(sessionID == nil)
            case .runNow, .retry:
                Button { Task { _ = await tasks.execute(task.id) } } label: {
                    Label(trailing == .retry ? TaskRunHandoff.retryEntryLabel : TaskDetailCopy.runNow,
                          systemImage: trailing == .retry ? "arrow.clockwise" : "play.fill")
                        .lineLimit(1)
                        .frame(maxWidth: .infinity)
                }
                .disabled(!canStart(task) || busy)
            case .gate:
                Button { Task { _ = await tasks.execute(task.id) } } label: {
                    Label(TaskJudgmentCopy.gateActionLabel, systemImage: "checkmark.shield")
                        .lineLimit(1)
                        .frame(maxWidth: .infinity)
                }
                .disabled(!canStart(task) || busy)
            }
        }
        .controlSize(.large)
        if prominent {
            button.buttonStyle(.borderedProminent)
        } else {
            button.buttonStyle(.bordered)
        }
    }

    private func assigneeHasRunner(_ task: TaskItem) -> Bool {
        if let summary = tasks.item(task.id), summary.assignee?.id == task.assignee?.id,
           summary.assignee?.runner?.id != nil {
            return true
        }
        guard let id = task.assignee?.id else { return false }
        return model.agents?.agent(id)?.runnerId != nil
    }

    private func runDisabledHint(_ task: TaskItem) -> String? {
        // Asked first, like the browser's: a gate row is not waiting for a prerequisite or a
        // workspace, and telling it about one would describe a press it was never going to take.
        if TaskJudgment.isGateRow(task) { return TaskJudgment.gateHint(task.verificationState) }
        if TaskListLogic.isBlocked(task) {
            return task.dependencyState == "BLOCKED_FAILED"
                ? "A prerequisite failed or was cancelled — resolve it first."
                : "Waiting for all prerequisites to finish."
        }
        if TaskListLogic.isBusy(task) { return "This task is already running or queued." }
        if task.assignee == nil { return "Assign an agent before running this task." }
        if !assigneeHasRunner(task) { return "The assigned agent isn't bound to a runner." }
        return nil
    }

    // MARK: verification task

    /// The check that settles this row, under the row it checks — the relation the database has
    /// always held and no native surface showed: what the check is called, where it stands, and the
    /// way into it.
    private func verifierSection(_ task: TaskItem) -> some View {
        Section {
            if let verifier = task.verifier {
                HStack(spacing: 8) {
                    Text(verifier.title ?? "Untitled task").font(.orbitSubtext).lineLimit(2)
                    TaskStatusPill(pill: TaskJudgment.pill(verifier))
                    Spacer(minLength: 8)
                    Button(TaskJudgmentCopy.verifierCardEntry) { model.route(to: .task(verifier.id)) }
                        .buttonStyle(.bordered)
                }
            } else {
                Text(TaskJudgmentCopy.verifierCardEmpty)
                    .font(.orbitSubtext)
                    .foregroundStyle(.secondary)
            }
        } header: {
            sectionHeader(TaskJudgmentCopy.verifierCardHeading)
        }
    }

    // MARK: details

    /// The fields that can be changed, as the platform's form rows: the label on the left, the value
    /// on the right in grey with its chooser mark. The one row that goes somewhere carries `›`, and
    /// who made the task and when read under the card.
    private func detailsSection(_ task: TaskItem) -> some View {
        Section {
            assigneePicker(task)
            providerPicker(task)
            modelPicker(task)
            listPicker(task)
            Button { editingSchedule = true } label: {
                detailRow(TaskDetailCopy.startAtLabel, value: TaskDetailLogic.scheduleValue(task.runAt),
                          glyph: "chevron.up.chevron.down")
            }
            .disabled(tasks.isMutating(task.id))
            if let source = task.creatorSession {
                Button { model.route(to: .session(source.id)) } label: {
                    detailRow(TaskDetailCopy.createdFromLabel, value: source.title ?? "Untitled session",
                              glyph: "chevron.right")
                }
            }
        } header: {
            sectionHeader(TaskDetailCopy.detailsHeading)
        } footer: {
            if let footnote = TaskDetailLogic.createdFootnote(
                creatorName: task.creatorName ?? tasks.item(task.id)?.creatorName, createdAt: task.createdAt) {
                Text(footnote)
            }
        }
    }

    /// A row that opens something — a sheet, a session — drawn like the pickers beside it. Concrete
    /// colours rather than hierarchical styles: a button's label otherwise inherits the accent tint.
    private func detailRow(_ label: String, value: String, glyph: String) -> some View {
        HStack(spacing: 8) {
            Text(label).foregroundStyle(Color.primary)
            Spacer(minLength: 12)
            Text(value)
                .foregroundStyle(Color.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
            Image(systemName: glyph)
                .font(.orbitLabel.weight(.semibold))
                .foregroundStyle(Color.secondary.opacity(0.7))
        }
        .contentShape(Rectangle())
    }

    private func assigneePicker(_ task: TaskItem) -> some View {
        let agents = model.agents?.items ?? []
        let current = task.assignee
        return Picker(TaskDetailCopy.assigneeLabel, selection: Binding(
            get: { task.assignee?.id },
            set: { id in Task { await tasks.setAssignee(task.id, id) } }
        )) {
            Text("Unassigned").tag(String?.none)
            ForEach(agents) { agent in
                Text(agent.name).tag(Optional(agent.id))
            }
            // The assignee keeps its name before the agent list has loaded, or when it is not in it.
            if let current, !agents.contains(where: { $0.id == current.id }) {
                Text(current.name ?? current.id).tag(Optional(current.id))
            }
        }
        .pickerStyle(.menu)
        .disabled(tasks.isMutating(task.id))
    }

    /// The agent this task runs on, resolved from the loaded agent list — its provider is what an
    /// unpinned task inherits, and its runner is where the model catalogue comes from.
    private func assigneeAgent(_ task: TaskItem) -> Agent? {
        guard let id = task.assignee?.id else { return nil }
        return model.agents?.items.first { $0.id == id }
    }

    /// The provider whose model space the Model menu lists: this task's pin, else the assignee's.
    private func effectiveProvider(_ task: TaskItem) -> String {
        task.provider ?? assigneeAgent(task)?.provider ?? "claude"
    }

    private func providerPicker(_ task: TaskItem) -> some View {
        let configured = model.agents?.configuredProviders
        let inherited = assigneeAgent(task).map {
            AgentDefaults.providerName($0.provider ?? "claude", configured: configured)
        }
        let options = AgentDefaults.providers(configured: configured)
        return Picker(TaskDetailCopy.providerLabel, selection: Binding(
            get: { task.provider },
            set: { provider in Task { await tasks.setProvider(task.id, provider) } }
        )) {
            Text(inherited.map { "Assignee's (\($0))" } ?? "Assignee's").tag(String?.none)
            ForEach(options) { option in
                Text(option.name).tag(Optional(option.id))
            }
            if let pinned = task.provider, !options.contains(where: { $0.id == pinned }) {
                Text(AgentDefaults.providerName(pinned, configured: configured)).tag(Optional(pinned))
            }
        }
        .pickerStyle(.menu)
        .disabled(tasks.isMutating(task.id))
    }

    private func modelPicker(_ task: TaskItem) -> some View {
        let provider = effectiveProvider(task)
        let options = AgentDefaults.models(
            for: provider,
            catalog: model.agents?.modelCatalog(for: assigneeAgent(task)?.runnerId),
            configured: model.agents?.configuredProviders)
        return Picker(TaskDetailCopy.modelLabel, selection: Binding(
            get: { task.model },
            set: { id in Task { await tasks.setModel(task.id, id) } }
        )) {
            Text("Provider default").tag(String?.none)
            ForEach(options) { option in
                Text(option.name).tag(Optional(option.id))
            }
            // A pinned id the catalogue doesn't name still has to read as itself, not vanish.
            if let pinned = task.model, !options.contains(where: { $0.id == pinned }) {
                Text(pinned).tag(Optional(pinned))
            }
        }
        .pickerStyle(.menu)
        .disabled(tasks.isMutating(task.id))
    }

    private func listPicker(_ task: TaskItem) -> some View {
        Picker(TaskDetailCopy.listLabel, selection: Binding(
            get: { task.listId },
            set: { id in Task { await tasks.setList(task.id, id) } }
        )) {
            Text("No list").tag(String?.none)
            ForEach(tasks.lists) { list in
                Text(list.title).tag(Optional(list.id))
            }
            if let listId = task.listId, !tasks.lists.contains(where: { $0.id == listId }) {
                Text("Task List").tag(Optional(listId))
            }
        }
        .pickerStyle(.menu)
        .disabled(tasks.isMutating(task.id))
    }

    // MARK: dependencies

    private func dependenciesSection(_ task: TaskItem) -> some View {
        let graph = TaskDetailLogic.dependencyGraph(for: task, loaded: tasks.dependencyGraph)
        let related = TaskDetailLogic.hasDependencies(task)
        let showGraph = (dependencyView ?? (TaskDetailLogic.prefersGraph(graph) ? .graph : .list)) == .graph
        return Section {
            if let summary = TaskDetailLogic.dependencySummary(for: task, graph: graph) {
                Text(summary).font(.orbitLabel).foregroundStyle(.secondary)
            }
            if let notice = TaskDetailLogic.blockedNotice(for: task) {
                Label(notice.text, systemImage: notice.failed ? "exclamationmark.lock.fill" : "lock.fill")
                    .font(.orbitSubtext)
                    .foregroundStyle(notice.failed ? Color.red : Color.orange)
            }
            if !related {
                Text(TaskDetailCopy.noDependencies).foregroundStyle(.secondary)
            } else {
                Picker(TaskDetailCopy.dependenciesHeading, selection: Binding(
                    get: { showGraph ? DependencyView.graph : .list },
                    set: { dependencyView = $0 }
                )) {
                    Text(TaskDetailCopy.graphView).tag(DependencyView.graph)
                    Text(TaskDetailCopy.listView).tag(DependencyView.list)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                if showGraph {
                    TaskDependencyGraphView(graph: graph) { model.route(to: .task($0)) }
                } else {
                    ForEach(TaskDetailLogic.dependencyRows(graph)) { row in dependencyRow(row) }
                }
                if let notice = TaskDetailLogic.truncationNotice(graph) {
                    Text(notice).font(.orbitLabel).foregroundStyle(.secondary)
                }
            }
            if !(task.dependsOn ?? []).isEmpty {
                Toggle(TaskDetailCopy.autoRunWhenReady, isOn: Binding(
                    get: { task.autoRunWhenReady ?? true },
                    set: { value in Task { await tasks.setAutoRun(task.id, value) } }
                ))
                .disabled(tasks.isMutating(task.id))
            }
            Button { showingDependencyPicker = true } label: {
                Label(TaskDetailCopy.addPrerequisite, systemImage: "plus.circle")
            }
            .disabled(tasks.isMutating(task.id))
        } header: {
            sectionHeader(TaskDetailCopy.dependenciesHeading)
        }
    }

    /// One task of the component: its status, its title (the task being read says so), how it
    /// relates to its neighbours, and — for a direct prerequisite — the way to drop it.
    private func dependencyRow(_ row: TaskDependencyListRow) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Button {
                if !row.isFocus { model.route(to: .task(row.id)) }
            } label: {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        TaskStatusPill(pill: TaskDetailLogic.pill(row.node))
                        Text(row.node.title)
                            .font(.orbitSubtext.weight(row.isFocus ? .semibold : .regular))
                            .foregroundStyle(Color.primary)
                            .lineLimit(2)
                        if row.isFocus {
                            Text(TaskDetailCopy.currentTask)
                                .font(.orbitMeta.weight(.semibold))
                                .foregroundStyle(Color.accentColor)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1)
                                .background(Color.accentColor.opacity(0.12), in: Capsule())
                        }
                    }
                    Text(row.relationships)
                        .font(.orbitLabel)
                        .foregroundStyle(Color.secondary)
                        .lineLimit(2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if row.removable {
                Button { prerequisiteToRemove = row } label: {
                    Image(systemName: "xmark.circle.fill")
                }
                .buttonStyle(.borderless)
                .foregroundStyle(.secondary)
                .accessibilityLabel("Remove \(row.node.title) as a prerequisite")
                .disabled(tasks.isMutating(taskID))
            }
        }
    }

    // MARK: description, acceptance

    @ViewBuilder
    private func descriptionSection(_ task: TaskItem) -> some View {
        if let description = task.description, !description.isEmpty {
            Section {
                // Descriptions are written as agent-ready prompts, so render their Markdown like
                // comments do; a long one folds under `Show more`.
                FoldableMarkdown(source: description, foldedHeight: 300)
            } header: {
                sectionHeader(TaskDetailCopy.descriptionHeading)
            }
        }
    }

    /// What "done" means for this task, and who decides it: the criteria, and the command with the
    /// exit code that settles it with nobody in the loop. Under the description, because it is the
    /// work's other statement about itself, and above the runs, because a reader about to start one
    /// — or to confirm it — is deciding against this.
    private func acceptanceSection(_ task: TaskItem) -> some View {
        let draft = TaskAcceptanceDraft(task: task)
        return Section {
            VStack(alignment: .leading, spacing: 6) {
                Text(TaskDetailCopy.acceptanceCriteriaLabel).font(.orbitLabel).foregroundStyle(.secondary)
                if let criteria = TaskAcceptanceDraft.blankToNull(draft.criteria) {
                    FoldableMarkdown(source: criteria, foldedHeight: 360)
                } else {
                    Text(TaskDetailCopy.acceptanceEmpty).foregroundStyle(.secondary)
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(TaskDetailCopy.automaticJudgementLabel).font(.orbitLabel).foregroundStyle(.secondary)
                let command = draft.command.trimmingCharacters(in: .whitespacesAndNewlines)
                let exit = draft.exitCode.trimmingCharacters(in: .whitespacesAndNewlines)
                if !command.isEmpty, !exit.isEmpty {
                    Text(command).font(.orbitMono).textSelection(.enabled)
                    (Text("\(TaskDetailCopy.doneWhenItExits) ") + Text(exit).font(.orbitMono))
                        .font(.orbitSubtext)
                        .foregroundStyle(.secondary)
                } else {
                    Text(TaskDetailCopy.acceptancePairEmpty)
                }
            }
        } header: {
            sectionHeader(TaskDetailCopy.acceptanceHeading) {
                Button(TaskDetailCopy.edit) { editingAcceptance = true }
                    .disabled(tasks.isMutating(task.id))
            }
        } footer: {
            Text(TaskDetailCopy.acceptanceAutomaticHint)
        }
    }

    // MARK: inputs

    private func inputsSection(_ task: TaskItem) -> some View {
        let inputs = task.attachments ?? []
        return Section {
            Text(TaskDetailCopy.inputsHint).font(.orbitSubtext).foregroundStyle(.secondary)
            ForEach(inputs) { input in
                HStack(spacing: 10) {
                    TaskInputThumbnail(input: input)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(input.fileName ?? input.mimeType).lineLimit(1).truncationMode(.middle)
                        Text(TaskDetailLogic.humanSize(input.sizeBytes))
                            .font(.orbitLabel)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                    Button { inputToRemove = input } label: {
                        Image(systemName: "trash")
                    }
                    .buttonStyle(.borderless)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Remove input")
                    .disabled(tasks.isMutating(task.id))
                }
            }
            Button { importingInput = true } label: {
                Label(TaskDetailCopy.addFile, systemImage: "paperclip")
            }
            .disabled(tasks.isMutating(task.id))
        } header: {
            sectionHeader(TaskDetailCopy.inputsHeading, detail: "\(inputs.count)")
        }
    }

    /// Upload the picked files, one input each, then say how it went once.
    private func addInputs(_ urls: [URL]) async {
        var added = 0
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else { continue }
            let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            if await tasks.addInput(taskID, filename: url.lastPathComponent, mimeType: mime, data: data) {
                added += 1
            }
        }
        if added > 0 { PlatformHaptics.success() }
    }

    // MARK: attribution

    private func attributionSection(_ task: TaskItem) -> some View {
        Section {
            if let view = tasks.attribution {
                ForEach(TaskDetailLogic.attributionRows(view)) { row in attributionRow(row) }
            } else if tasks.attributionFailed {
                Label(TaskDetailCopy.attributionUnavailable, systemImage: "exclamationmark.triangle")
                    .font(.orbitSubtext)
                    .foregroundStyle(.orange)
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        } header: {
            sectionHeader(TaskDetailCopy.attributionHeading)
        }
    }

    @ViewBuilder
    private func attributionRow(_ row: TaskAttributionRow) -> some View {
        let fact = VStack(alignment: .leading, spacing: 3) {
            Text(row.label).font(.orbitLabel).foregroundStyle(Color.secondary)
            Text(row.text)
                .font(.orbitSubtext)
                .foregroundStyle(row.absent ? Color.secondary : Color.primary)
                .fixedSize(horizontal: false, vertical: true)
            if !row.tags.isEmpty || !row.notes.isEmpty {
                ForEach(Array(row.notes.enumerated()), id: \.offset) { _, note in
                    Text(note).font(.orbitLabel).foregroundStyle(Color.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack(spacing: 5) {
                    ForEach(row.tags, id: \.self) { tag in
                        Text(tag)
                            .font(.orbitMeta.weight(.semibold))
                            .foregroundStyle(Color.secondary)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(Color.secondary.opacity(0.4),
                                                                                    lineWidth: 0.5))
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        if let link = row.link {
            Button { open(link) } label: {
                HStack(spacing: 8) {
                    fact
                    Image(systemName: "chevron.right")
                        .font(.orbitLabel.weight(.semibold))
                        .foregroundStyle(Color.secondary.opacity(0.7))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        } else {
            fact
        }
    }

    private func open(_ link: TaskAttributionRow.Link) {
        switch link {
        case .session(let id): model.route(to: .session(id))
        case .task(let id): model.route(to: .task(id))
        case .project(let id): model.openProject(id)
        }
    }

    // MARK: followed by

    private func followedBySection(_ task: TaskItem) -> some View {
        let store = model.watches
        let followers = TaskDetailLogic.followers(of: task.id, in: store?.watches ?? [])
        return Section {
            if let store, !store.loadState.hasLoaded, store.loadState.loading {
                Text(TaskDetailCopy.loadingWatches).foregroundStyle(.secondary)
            } else if let store, store.loadState.lastLoadFailed, !store.loadState.hasLoaded {
                Text(TaskDetailCopy.watchesUnavailable).foregroundStyle(.secondary)
            } else if followers.live.isEmpty {
                Text(TaskDetailCopy.nothingWatching).foregroundStyle(.secondary)
            } else {
                ForEach(followers.live) { watch in
                    Button { model.route(to: .watch(watch.id)) } label: {
                        FollowingRow(watch: watch, now: Date()).foregroundStyle(Color.primary)
                    }
                    .buttonStyle(.plain)
                }
            }
            if followers.ended > 0 {
                Text(TaskDetailCopy.endedWatches(followers.ended))
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
            }
            Button { following = true } label: {
                Label(TaskDetailCopy.followTask, systemImage: "eye")
            }
            .disabled(store == nil)
        } header: {
            sectionHeader(TaskDetailCopy.followedByHeading, detail: "\(followers.live.count)")
        }
    }

    // MARK: runs, comments

    private func runsSection(_ task: TaskItem) -> some View {
        let sessions = task.sessions ?? []
        return Section {
            if sessions.isEmpty {
                Text(TaskDetailCopy.noRuns).foregroundStyle(.secondary)
            }
            ForEach(sessions) { session in
                Button { model.route(to: .session(session.id)) } label: { runRow(session) }
                    .buttonStyle(.plain)
            }
        } header: {
            sectionHeader(TaskDetailCopy.runsHeading, detail: "\(sessions.count)")
        }
    }

    /// The session list's rhythm: who ran it and when on the first line, where it stands on the
    /// second; a spinner while it runs.
    private func runRow(_ session: SessionRef) -> some View {
        HStack(spacing: 10) {
            Group {
                if session.resolvedRunState == .running {
                    ProgressView().controlSize(.small)
                } else {
                    Circle().fill(sessionColor(session)).frame(width: 8, height: 8)
                }
            }
            .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Text(session.agent?.name ?? session.title ?? "Untitled session")
                        .foregroundStyle(Color.primary)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    if let created = session.createdAt, let when = runTime(session, created) {
                        Text(when).font(.orbitSubtext).foregroundStyle(Color.secondary)
                    }
                }
                Text(sessionLabel(session))
                    .font(.orbitSubtext)
                    .foregroundStyle(session.resolvedRunState == .running ? Color.accentColor : sessionColor(session))
            }
            Image(systemName: "chevron.right")
                .font(.orbitLabel.weight(.semibold))
                .foregroundStyle(Color.secondary.opacity(0.7))
        }
        .contentShape(Rectangle())
    }

    /// How long a run has been going while it goes; when it started, once it has stopped.
    private func runTime(_ session: SessionRef, _ created: String) -> String? {
        session.resolvedRunState == .running ? RelativeTime.elapsed(created) : RelativeTime.format(created)
    }

    private func sessionLabel(_ session: SessionRef) -> String {
        switch session.resolvedRunState {
        case .queued:        return "Queued"
        case .running:       return "Running"
        case .awaitingInput: return "Awaiting reply"
        case .succeeded:     return "Succeeded"
        case .failed:        return "Failed"
        case .interrupted:   return "Interrupted"
        case .ended:         return "Ended"
        case .unknown, nil:  return "—"
        }
    }

    private func sessionColor(_ session: SessionRef) -> Color {
        switch session.resolvedRunState {
        case .running:             return .blue
        case .queued, .awaitingInput: return .orange
        case .succeeded:           return .green
        case .failed:              return .red
        default:                   return .secondary
        }
    }

    private func commentsSection(_ task: TaskItem) -> some View {
        let comments = task.comments ?? []
        return Section {
            if comments.isEmpty {
                Text(TaskDetailCopy.noComments).foregroundStyle(.secondary)
            }
            ForEach(comments) { comment in
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 6) {
                        TaskAvatar(name: comment.authorName)
                        Text(comment.authorName ?? "Unknown").font(.orbitSubtext.weight(.semibold))
                        if let created = comment.createdAt, let relative = RelativeTime.format(created) {
                            Text("· \(relative)").font(.orbitSubtext).foregroundStyle(.secondary)
                        }
                    }
                    FoldableMarkdown(source: comment.body, foldedHeight: 140)
                }
                .padding(.vertical, 2)
            }
        } header: {
            sectionHeader(TaskDetailCopy.commentsHeading, detail: "\(comments.count)")
        }
    }

    /// The comment box, held at the bottom of the screen rather than at the bottom of the page, so a
    /// comment — the way an agent is asked about this task — is one tap away wherever the reader is.
    private func composer(_ task: TaskItem) -> some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Add a comment… type @Workspace to mention", text: $newComment, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...4)
                .padding(.vertical, 6)
            Button {
                let body = newComment.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !body.isEmpty else { return }
                Task {
                    if await tasks.addComment(task.id, body, mentions: mentionedAgentIDs(in: body)) {
                        newComment = ""
                    }
                }
            } label: {
                Image(systemName: "paperplane.fill")
                    .frame(width: 30, height: 30)
            }
            .buttonStyle(.borderless)
            .disabled(newComment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                      || tasks.isMutating(task.id))
            .accessibilityLabel("Send comment")
        }
        .padding(.leading, 16)
        .padding(.trailing, 8)
        .padding(.vertical, 5)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Color.primary.opacity(0.08),
                                                                                    lineWidth: 0.5))
        .padding(.horizontal, 16)
        .padding(.top, 6)
        .padding(.bottom, 8)
    }

    private func mentionedAgentIDs(in body: String) -> [String] {
        guard let agents = model.agents?.items else { return [] }
        return agents.compactMap { agent in
            let name = NSRegularExpression.escapedPattern(for: agent.name)
            let pattern = "(?:^|\\s)@\(name)(?![\\w])"
            guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
                return nil
            }
            let range = NSRange(body.startIndex..<body.endIndex, in: body)
            return regex.firstMatch(in: body, range: range) == nil ? nil : agent.id
        }
    }

    private func detailErrorBanner(_ error: String, canRetry: Bool = false) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            Text(error).font(.orbitLabel)
            Spacer(minLength: 0)
            if canRetry {
                Button("Retry") { Task { await loadDetail() } }
                    .buttonStyle(.borderless)
            }
            Button {
                if canRetry { tasks.clearDetailError() }
                else { tasks.errorText = nil }
            } label: {
                Image(systemName: "xmark")
            }
                .buttonStyle(.borderless)
                .accessibilityLabel("Dismiss error")
        }
        .padding(10)
        .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
    }

    /// A section's heading, the project page's way: the word, then a count or a short fact beside it
    /// in grey, and — for a block with an editor — the press that opens it at the far end.
    private func sectionHeader(_ title: String, detail: String? = nil) -> some View {
        sectionHeader(title, detail: detail) { EmptyView() }
    }

    private func sectionHeader<Trailing: View>(_ title: String, detail: String? = nil,
                                               @ViewBuilder trailing: () -> Trailing) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(title)
            if let detail {
                Text(detail).font(.orbitLabel).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
            trailing().font(.orbitControl).textCase(nil)
        }
        .textCase(nil)
    }
}

/// A person or an agent as the browser draws one beside its name: the initial on the accent's tint.
private struct TaskAvatar: View {
    let name: String?

    var body: some View {
        Text(String((name ?? "?").prefix(1)).uppercased())
            .font(.orbitMeta.weight(.bold))
            .foregroundStyle(Color.accentColor)
            .frame(width: 20, height: 20)
            .background(Color.accentColor.opacity(0.14), in: Circle())
            .accessibilityHidden(true)
    }
}

private extension View {
    /// Grouped cards on iOS — the project page's — and the platform's plain inset list on macOS.
    @ViewBuilder func taskPageListStyle() -> some View {
        #if os(iOS)
        self.listStyle(.insetGrouped)
            .headerProminence(.increased)
        #else
        self.listStyle(.inset)
        #endif
    }
}

/// Bounded, server-searched prerequisite picker.
private struct TaskDependencyPicker: View {
    @Environment(\.dismiss) private var dismiss
    let tasks: TasksModel
    let taskID: String
    let existing: Set<String>
    @State private var query = ""

    var body: some View {
        NavigationStack {
            List {
                if tasks.dependencyCandidatesLoading && tasks.dependencyCandidates.isEmpty {
                    ProgressView().frame(maxWidth: .infinity)
                } else {
                    ForEach(candidates) { candidate in
                        Button {
                            Task {
                                if await tasks.addDependency(taskID, dependsOn: candidate.id) {
                                    dismiss()
                                }
                            }
                        } label: {
                            HStack(spacing: 8) {
                                TaskStatusPill(pill: TaskListLogic.pill(candidate))
                                Text(candidate.title).foregroundStyle(.primary).lineLimit(2)
                            }
                        }
                        .disabled(tasks.isMutating(taskID))
                    }
                }
            }
            .overlay {
                if !tasks.dependencyCandidatesLoading && candidates.isEmpty {
                    ContentUnavailableView("No matching tasks", systemImage: "magnifyingglass")
                }
            }
            .navigationTitle("Add prerequisite")
            .searchable(text: $query, prompt: "Search tasks")
            .task(id: query) {
                tasks.beginDependencyCandidateSearch()
                do { try await Task.sleep(nanoseconds: 250_000_000) }
                catch { return }
                await tasks.loadDependencyCandidates(query: query)
            }
            .onDisappear { tasks.clearDependencyCandidates() }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
    }

    private var candidates: [TaskItem] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return tasks.dependencyCandidates.filter { candidate in
            candidate.id != taskID
                && !existing.contains(candidate.id)
                && (needle.isEmpty || candidate.title.localizedCaseInsensitiveContains(needle))
        }
    }
}
