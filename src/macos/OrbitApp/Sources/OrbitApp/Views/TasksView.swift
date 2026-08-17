import Foundation
import SwiftUI
import OrbitKit

/// Native Tasks list. Its information architecture and predicates mirror Web, while controls use
/// mobile-native menus/search/swipes instead of squeezing the desktop table onto an iPhone.
struct TasksListView: View {
    @Environment(AppModel.self) private var model
    @State private var taskToDelete: TaskItem?

    var body: some View {
        @Bindable var model = model
        if let tasks = model.tasks {
            @Bindable var tasks = tasks
            VStack(spacing: 0) {
                #if !os(iOS)
                if tasks.overview.total > 0 { TaskProgressSummary(overview: tasks.overview) }
                #endif
                if let error = tasks.errorText { errorBanner(error, tasks: tasks) }
                #if !os(iOS)
                toolbar(tasks)
                Divider()
                #endif
                taskList(tasks, selection: $model.selectedTaskID)
            }
            .navigationTitle(tasks.scopeTitle)
            .searchable(text: $tasks.searchText, prompt: "Search tasks")
            #if os(iOS)
            .navigationDestination(isPresented: $model.taskListsDirectoryPresented) {
                TaskListsDirectoryView(tasks: tasks)
            }
            #endif
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

    private func taskList(_ tasks: TasksModel, selection: Binding<String?>) -> some View {
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
                TaskRowView(task: task)
                    .tag(task.id)
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

    @ViewBuilder
    private func rowMenu(_ tasks: TasksModel, _ task: TaskItem) -> some View {
        if TaskListLogic.canStart(task) { runButton(tasks, task) }
        Button(role: .destructive) { taskToDelete = task } label: {
            Label("Delete", systemImage: "trash")
        }
        .disabled(tasks.isMutating(task.id))
    }

    private func runButton(_ tasks: TasksModel, _ task: TaskItem) -> some View {
        Button {
            Task { _ = await tasks.execute(task.id) }
        } label: {
            Label(task.status == .failed ? "Retry" : "Run",
                  systemImage: task.status == .failed ? "arrow.clockwise" : "play.fill")
        }
        .disabled(tasks.isMutating(task.id))
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

    private func listRefreshLoop(_ tasks: TasksModel) async {
        // Debounce server-backed filter/search changes. Named lists use the same harmless delay,
        // but their local filter/search does not change queryKey and therefore never restarts this.
        do { try await Task.sleep(nanoseconds: 250_000_000) }
        catch { return }
        await tasks.load()
        while !Task.isCancelled {
            let delay: UInt64 = tasks.hasBusyTasks ? 5_000_000_000 : 15_000_000_000
            do { try await Task.sleep(nanoseconds: delay) }
            catch { return }
            await tasks.load()
        }
    }

    private func navigationRefreshLoop(_ tasks: TasksModel) async {
        await tasks.loadNavigation()
        while !Task.isCancelled {
            let busy = tasks.lists.contains { ($0.runningTasks ?? 0) > 0 }
            do { try await Task.sleep(nanoseconds: busy ? 5_000_000_000 : 15_000_000_000) }
            catch { return }
            await tasks.loadNavigation()
        }
    }
}

#if os(iOS)
/// The complete task-list directory lives one level deeper than the drawer. This keeps the drawer
/// useful as a quick switcher while giving large workspaces a native searchable, grouped surface.
private struct TaskListsDirectoryView: View {
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

    private func open(_ scope: TaskScope) {
        model.selectedTaskID = nil
        tasks.selectScope(scope)
        model.taskListsDirectoryPresented = false
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

private struct TaskDetailContent: View {
    @Environment(AppModel.self) private var model
    let tasks: TasksModel
    let taskID: String

    @State private var newComment = ""
    @State private var confirmingDelete = false
    @State private var showingDependencyPicker = false

    var body: some View {
        Group {
            if let task = tasks.detail, task.id == taskID {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        header(task)
                        if let error = tasks.detailErrorText {
                            detailErrorBanner(error, canRetry: true)
                        }
                        if let error = tasks.errorText { detailErrorBanner(error) }
                        if TaskListLogic.isBlocked(task) { blockedNotice(task) }
                        actions(task)
                        details(task)
                        dependencies(task)
                        if let description = task.description, !description.isEmpty {
                            section("Description") {
                                // Descriptions are written as agent-ready prompts, so render their
                                // Markdown like comments do. `parseMarkdownBlocks` keeps soft
                                // newlines, so a plain multi-line description still lays out as typed.
                                MarkdownView(source: description)
                                    .font(.orbitProse)
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                        runs(task)
                        comments(task)
                    }
                    .padding()
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
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
        .navigationTitle(tasks.detail?.id == taskID ? (tasks.detail?.title ?? "Task") : "Task")
        .toolbar {
            if tasks.detail?.id == taskID {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
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
            if model.agents?.items.isEmpty == true { await model.agents?.load() }
            await tasks.loadNavigation()
        }
        .task(id: detailPollKey) { await pollBusyDetail() }
        .sheet(isPresented: $showingDependencyPicker) {
            let existing = Set((tasks.detail?.dependsOn ?? []).compactMap { $0.dependsOnTask?.id })
            TaskDependencyPicker(tasks: tasks, taskID: taskID, existing: existing)
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

    private func pollBusyDetail() async {
        guard let task = tasks.detail, task.id == taskID, TaskListLogic.isBusy(task) else { return }
        while !Task.isCancelled {
            do { try await Task.sleep(nanoseconds: 4_000_000_000) }
            catch { return }
            guard model.selectedTaskID == taskID else { return }
            _ = await tasks.loadDetail(taskID)
            guard let current = tasks.detail, TaskListLogic.isBusy(current) else { return }
        }
    }

    private func header(_ task: TaskItem) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(task.title).font(.title2).bold().textSelection(.enabled)
            HStack(spacing: 8) {
                TaskStatusPill(pill: TaskListLogic.pill(task))
                if let created = task.createdAt, let relative = RelativeTime.format(created) {
                    Text(relative).font(.orbitLabel).foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder
    private func actions(_ task: TaskItem) -> some View {
        let busy = tasks.isMutating(task.id)
        let canStart = TaskListLogic.canStart(task, assigneeHasRunner: assigneeHasRunner(task))
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 10) {
                if task.status != .done {
                    Button {
                        Task { _ = await tasks.execute(task.id) }
                    } label: {
                        Label(task.status == .failed ? "Retry" : "Run",
                              systemImage: task.status == .failed ? "arrow.clockwise" : "play.fill")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!canStart || busy)
                }
                if task.status != .done {
                    Button {
                        Task { await tasks.setStatus(task.id, .done) }
                    } label: {
                        Label("Mark done", systemImage: "checkmark")
                    }
                    .buttonStyle(.bordered)
                    .disabled(busy)
                }
            }
            if task.status != .done, !canStart, let hint = runDisabledHint(task) {
                Text(hint).font(.orbitMeta).foregroundStyle(.secondary)
            }
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

    private func blockedNotice(_ task: TaskItem) -> some View {
        let failed = task.dependencyState == "BLOCKED_FAILED"
        return Label(
            failed ? "A prerequisite failed or was cancelled." : "Waiting for prerequisites.",
            systemImage: failed ? "exclamationmark.lock.fill" : "lock.fill"
        )
        .font(.orbitLabel)
        .foregroundStyle(failed ? Color.red : Color.orange)
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background((failed ? Color.red : Color.orange).opacity(0.1),
                    in: RoundedRectangle(cornerRadius: 8))
    }

    private func details(_ task: TaskItem) -> some View {
        section("Details") {
            detailRow("Assignee") { assigneeMenu(task) }
            detailRow("Provider") { providerMenu(task) }
            detailRow("Model") { modelMenu(task) }
            detailRow("List") { listMenu(task) }
            if let creator = task.creatorName ?? tasks.item(task.id)?.creatorName {
                detailRow("Created by") { Text(creator) }
            }
            if let source = task.creatorSession {
                detailRow("Created from") {
                    Button(source.title ?? "Untitled session") { model.route(to: .session(source.id)) }
                        .buttonStyle(.plain)
                        .foregroundStyle(Color.accentColor)
                }
            }
            if let created = task.createdAt {
                detailRow("Created") { Text(RelativeTime.format(created) ?? created) }
            }
        }
    }

    private func assigneeMenu(_ task: TaskItem) -> some View {
        Menu {
            Button { Task { await tasks.setAssignee(task.id, nil) } } label: {
                Label("Unassigned", systemImage: task.assignee == nil ? "checkmark" : "person.slash")
            }
            if let agents = model.agents, !agents.items.isEmpty {
                Divider()
                ForEach(agents.items) { agent in
                    Button { Task { await tasks.setAssignee(task.id, agent.id) } } label: {
                        Label(agent.name, systemImage: task.assignee?.id == agent.id ? "checkmark" : "person")
                    }
                }
            }
        } label: {
            Label(task.assignee?.name ?? "Unassigned", systemImage: "chevron.up.chevron.down")
                .labelStyle(.titleAndIcon)
        }
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

    private func providerMenu(_ task: TaskItem) -> some View {
        let configured = model.agents?.configuredProviders
        let inherited = assigneeAgent(task).map {
            AgentDefaults.providerName($0.provider ?? "claude", configured: configured)
        }
        return Menu {
            Button { Task { await tasks.setProvider(task.id, nil) } } label: {
                Label(inherited.map { "Assignee's (\($0))" } ?? "Assignee's",
                      systemImage: task.provider == nil ? "checkmark" : "person")
            }
            Divider()
            ForEach(AgentDefaults.providers(configured: configured)) { option in
                Button { Task { await tasks.setProvider(task.id, option.id) } } label: {
                    Label(option.name, systemImage: task.provider == option.id ? "checkmark" : "cpu")
                }
            }
        } label: {
            Label(task.provider.map { AgentDefaults.providerName($0, configured: configured) }
                    ?? inherited.map { "Assignee's (\($0))" } ?? "Assignee's",
                  systemImage: "chevron.up.chevron.down")
                .labelStyle(.titleAndIcon)
        }
        .disabled(tasks.isMutating(task.id))
    }

    private func modelMenu(_ task: TaskItem) -> some View {
        let provider = effectiveProvider(task)
        let options = AgentDefaults.models(
            for: provider,
            catalog: model.agents?.modelCatalog(for: assigneeAgent(task)?.runnerId),
            configured: model.agents?.configuredProviders)
        return Menu {
            Button { Task { await tasks.setModel(task.id, nil) } } label: {
                Label("Provider default", systemImage: task.model == nil ? "checkmark" : "sparkles")
            }
            if !options.isEmpty {
                Divider()
                ForEach(options) { option in
                    Button { Task { await tasks.setModel(task.id, option.id) } } label: {
                        Label(option.name, systemImage: task.model == option.id ? "checkmark" : "cube")
                    }
                }
            }
        } label: {
            // A pinned id the catalogue doesn't name still has to read as itself, not vanish.
            Label(task.model.map { id in options.first { $0.id == id }?.name ?? id }
                    ?? "Provider default",
                  systemImage: "chevron.up.chevron.down")
                .labelStyle(.titleAndIcon)
        }
        .disabled(tasks.isMutating(task.id))
    }

    private func listMenu(_ task: TaskItem) -> some View {
        Menu {
            Button { Task { await tasks.setList(task.id, nil) } } label: {
                Label("No list", systemImage: task.listId == nil ? "checkmark" : "tray")
            }
            if !tasks.lists.isEmpty {
                Divider()
                ForEach(tasks.lists) { list in
                    Button { Task { await tasks.setList(task.id, list.id) } } label: {
                        Label(list.title, systemImage: task.listId == list.id ? "checkmark" : "checklist")
                    }
                }
            }
        } label: {
            Label(listTitle(task.listId), systemImage: "chevron.up.chevron.down")
                .labelStyle(.titleAndIcon)
        }
        .disabled(tasks.isMutating(task.id))
    }

    private func listTitle(_ id: String?) -> String {
        guard let id else { return "No list" }
        return tasks.lists.first(where: { $0.id == id })?.title ?? "Task List"
    }

    @ViewBuilder
    private func dependencies(_ task: TaskItem) -> some View {
        let prerequisites = (task.dependsOn ?? []).compactMap(\.dependsOnTask)
        let dependents = (task.dependedOnBy ?? []).compactMap(\.task)
        section("Dependencies") {
            if prerequisites.isEmpty && dependents.isEmpty {
                Text("No dependencies").font(.orbitProseAside).foregroundStyle(.secondary)
            }
            if !prerequisites.isEmpty {
                Text("Prerequisites").font(.orbitLabel).foregroundStyle(.secondary)
                ForEach(prerequisites) { reference in
                    dependencyRow(reference, removableFrom: task.id)
                }
            }
            if !dependents.isEmpty {
                Text("Downstream").font(.orbitLabel).foregroundStyle(.secondary)
                ForEach(dependents) { reference in dependencyRow(reference) }
            }
            Button { showingDependencyPicker = true } label: {
                Label("Add prerequisite", systemImage: "plus")
            }
            .font(.orbitLabel)
            .disabled(tasks.isMutating(task.id))

            if !prerequisites.isEmpty {
                Toggle("Auto-run when all prerequisites finish", isOn: Binding(
                    get: { task.autoRunWhenReady ?? true },
                    set: { value in Task { await tasks.setAutoRun(task.id, value) } }
                ))
                .toggleStyle(.switch)
                .controlSize(.small)
                .disabled(tasks.isMutating(task.id))
            }
        }
    }

    private func dependencyRow(_ reference: TaskRef, removableFrom taskID: String? = nil) -> some View {
        HStack(spacing: 8) {
            Circle()
                .fill(reference.status == .done ? Color.green :
                      reference.status == .failed || reference.status == .cancelled ? Color.red : Color.orange)
                .frame(width: 7, height: 7)
            Button(reference.title ?? reference.id) { model.route(to: .task(reference.id)) }
                .buttonStyle(.plain)
                .font(.orbitProseAside)
                .lineLimit(2)
            Spacer(minLength: 4)
            if let taskID {
                Button {
                    Task { await tasks.removeDependency(taskID, dependsOn: reference.id) }
                } label: {
                    Image(systemName: "xmark.circle.fill")
                }
                .buttonStyle(.borderless)
                .foregroundStyle(.secondary)
                .accessibilityLabel("Remove prerequisite")
                .disabled(tasks.isMutating(taskID))
            }
        }
    }

    private func runs(_ task: TaskItem) -> some View {
        let sessions = task.sessions ?? []
        return section("Runs (\(sessions.count))") {
            if sessions.isEmpty {
                Text("No runs yet").font(.orbitProseAside).foregroundStyle(.secondary)
            } else {
                ForEach(sessions) { session in
                    Button { model.route(to: .session(session.id)) } label: {
                        HStack(spacing: 8) {
                            Circle().fill(sessionColor(session)).frame(width: 7, height: 7)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(session.agent?.name ?? session.title ?? "Untitled session")
                                    .font(.orbitProseAside)
                                    .lineLimit(1)
                                if let created = session.createdAt,
                                   let relative = RelativeTime.format(created) {
                                    Text(relative).font(.orbitMeta).foregroundStyle(.secondary)
                                }
                            }
                            Spacer(minLength: 8)
                            Text(sessionLabel(session)).font(.orbitLabel).foregroundStyle(.secondary)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
        }
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

    private func comments(_ task: TaskItem) -> some View {
        let comments = task.comments ?? []
        return section("Comments (\(comments.count))") {
            if comments.isEmpty {
                Text("No comments yet").font(.orbitProseAside).foregroundStyle(.secondary)
            }
            ForEach(comments) { comment in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(comment.authorName ?? "Unknown").font(.orbitLabel).bold()
                        Spacer()
                        if let created = comment.createdAt,
                           let relative = RelativeTime.format(created) {
                            Text(relative).font(.orbitMeta).foregroundStyle(.secondary)
                        }
                    }
                    MarkdownView(source: comment.body)
                        .font(.orbitProse)
                        .textSelection(.enabled)
                }
                .padding(.vertical, 3)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Add a comment… type @Workspace to mention", text: $newComment, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...4)
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
                }
                .disabled(newComment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                          || tasks.isMutating(task.id))
                .accessibilityLabel("Send comment")
            }
        }
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

    private func detailRow<Content: View>(_ label: String,
                                           @ViewBuilder value: () -> Content) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(label).font(.orbitLabel).foregroundStyle(.secondary).frame(width: 88, alignment: .leading)
            value().font(.orbitProseAside)
            Spacer(minLength: 0)
        }
    }

    private func section<Content: View>(_ title: String,
                                         @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.orbitLabel).bold().foregroundStyle(.secondary)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Bounded, server-searched prerequisite picker. This remains a list on iPhone instead of trying
/// to fit the Web DAG canvas onto a compact detail view.
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
