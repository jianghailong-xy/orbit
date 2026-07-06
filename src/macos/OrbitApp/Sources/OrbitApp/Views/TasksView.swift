import SwiftUI
import OrbitKit

// Batch C: the Tasks page — list (middle column) + detail (right column), reading the shared
// `TasksModel` off `AppModel`. List/sort/pill logic comes from the verified OrbitKit
// `TaskListLogic`; this file is the SwiftUI surface (parse-checked only — verify on a Mac).

/// Middle column: filter + sort over the live task list; selection drives the detail panel.
struct TasksListView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        if let tasks = model.tasks {
            @Bindable var tasks = tasks
            VStack(spacing: 0) {
                HStack {
                    Picker("Filter", selection: $tasks.filter) {
                        ForEach(TaskFilter.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.menu).labelsHidden().fixedSize()
                    Spacer()
                    Picker("Sort", selection: $tasks.sort) {
                        ForEach(TaskSort.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.menu).labelsHidden().fixedSize()
                    Button { tasks.descending.toggle() } label: {
                        Image(systemName: tasks.descending ? "arrow.down" : "arrow.up")
                    }
                    .buttonStyle(.borderless)
                }
                .padding(.horizontal, 10).padding(.vertical, 6)
                Divider()
                List(selection: $model.selectedTaskID) {
                    ForEach(tasks.visible) { task in
                        TaskRowView(task: task)
                            .tag(task.id)
                            .contextMenu { rowMenu(tasks, task) }
                    }
                }
                .overlay {
                    if tasks.visible.isEmpty {
                        ContentUnavailableView(tasks.loading ? "Loading…" : "No tasks",
                                               systemImage: "checklist")
                    }
                }
            }
            .navigationTitle("Tasks")
            .task { await tasks.load() }
        } else {
            ProgressView()
        }
    }

    @ViewBuilder
    private func rowMenu(_ tasks: TasksModel, _ task: TaskItem) -> some View {
        if task.blocked != true {
            Button("Run") { Task { await tasks.execute(task.id) } }
        }
        Menu("Set status") {
            ForEach([TaskStatus.open, .inProgress, .done, .cancelled], id: \.self) { s in
                Button(s.rawValue.capitalized) { Task { await tasks.setStatus(task.id, s) } }
            }
        }
        Divider()
        Button("Delete", role: .destructive) { Task { await tasks.deleteTask(task.id) } }
    }
}

struct TaskRowView: View {
    let task: TaskItem
    var body: some View {
        HStack(spacing: 8) {
            if task.blocked == true {
                Image(systemName: "lock.fill").font(.orbitMeta).foregroundStyle(.secondary)
                    .help("Blocked by an unfinished dependency")
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(task.title).lineLimit(1)
                HStack(spacing: 6) {
                    TaskStatusPill(pill: TaskListLogic.pill(task))
                    if let name = task.assignee?.name {
                        Text(name).font(.orbitListSubtitle).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
            Spacer()
            if let n = task.commentCount, n > 0 {
                Label("\(n)", systemImage: "text.bubble").font(.orbitMeta).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

/// Encodes status three ways (shape + color + text) so it reads without relying on color: a
/// spinner for running, a colored dot + label otherwise. Mirrors the web StatusPill.
struct TaskStatusPill: View {
    let pill: TaskPill
    var body: some View {
        HStack(spacing: 4) {
            if pill.kind == .running {
                ProgressView().controlSize(.mini)
            } else {
                Circle().fill(color).frame(width: 6, height: 6)
            }
            Text(pill.label).font(.orbitMeta)
        }
        .padding(.horizontal, 6).padding(.vertical, 2)
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

/// Right column: the selected task's detail, keyed so it reloads when the selection changes.
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

struct TaskDetailContent: View {
    let tasks: TasksModel
    let taskID: String
    @State private var newComment = ""

    var body: some View {
        ScrollView {
            if let t = tasks.detail, t.id == taskID {
                VStack(alignment: .leading, spacing: 16) {
                    metaHeader(t)
                    if let desc = t.description, !desc.isEmpty {
                        Text(desc).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    actions(t)
                    dependencies(t)
                    runs(t)
                    comments(t)
                }
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ProgressView().frame(maxWidth: .infinity).padding()
            }
        }
        .navigationTitle(tasks.detail?.title ?? "Task")
        .task { await tasks.loadDetail(taskID) }
    }

    @ViewBuilder private func metaHeader(_ t: TaskItem) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(t.title).font(.title2).bold().textSelection(.enabled)
            HStack(spacing: 8) {
                TaskStatusPill(pill: TaskListLogic.pill(t))
                if let name = t.assignee?.name {
                    Label(name, systemImage: "person").font(.orbitLabel).foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder private func actions(_ t: TaskItem) -> some View {
        HStack(spacing: 10) {
            Button { Task { await tasks.execute(t.id) } } label: { Label("Run", systemImage: "play.fill") }
                .disabled(t.blocked == true || t.running == true)
            Menu {
                ForEach([TaskStatus.open, .inProgress, .done, .cancelled], id: \.self) { s in
                    Button(s.rawValue.capitalized) { Task { await tasks.setStatus(t.id, s) } }
                }
            } label: { Label("Status", systemImage: "flag") }
            .fixedSize()
            Toggle("Auto-run", isOn: Binding(
                get: { t.autoRunWhenReady ?? true },
                set: { v in Task { await tasks.setAutoRun(t.id, v) } }
            ))
            .toggleStyle(.switch).controlSize(.small)
            Spacer()
            Button(role: .destructive) { Task { await tasks.deleteTask(t.id) } } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }

    @ViewBuilder private func dependencies(_ t: TaskItem) -> some View {
        let deps = t.dependsOn ?? []
        let existing = Set(deps.compactMap { $0.dependsOnTask?.id })
        section("Depends on") {
            ForEach(deps.indices, id: \.self) { i in
                if let ref = deps[i].dependsOnTask {
                    HStack {
                        Circle().fill(ref.status == .done ? Color.green : Color.orange).frame(width: 6, height: 6)
                        Text(ref.title ?? ref.id).font(.orbitProseAside)
                        Spacer()
                        Button { Task { await tasks.removeDependency(t.id, dependsOn: ref.id) } } label: {
                            Image(systemName: "xmark.circle.fill")
                        }
                        .buttonStyle(.borderless).foregroundStyle(.secondary)
                    }
                }
            }
            Menu("Add dependency") {
                ForEach(tasks.items.filter { $0.id != t.id && !existing.contains($0.id) }) { other in
                    Button(other.title) { Task { await tasks.addDependency(t.id, dependsOn: other.id) } }
                }
            }
            .font(.orbitLabel).fixedSize()
        }
    }

    @ViewBuilder private func runs(_ t: TaskItem) -> some View {
        if let ss = t.sessions, !ss.isEmpty {
            section("Runs") {
                ForEach(ss) { s in
                    HStack {
                        Text(s.title ?? s.id).font(.orbitProseAside).lineLimit(1)
                        Spacer()
                        if let st = s.status {
                            Text(st.rawValue.capitalized).font(.orbitLabel).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder private func comments(_ t: TaskItem) -> some View {
        section("Comments") {
            ForEach(t.comments ?? []) { c in
                VStack(alignment: .leading, spacing: 2) {
                    Text(c.authorName ?? "—").font(.orbitLabel).foregroundStyle(.secondary)
                    Text(c.body).font(.orbitProse).textSelection(.enabled)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack {
                TextField("Add a comment…", text: $newComment, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                Button {
                    let body = newComment.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !body.isEmpty else { return }
                    newComment = ""
                    Task { await tasks.addComment(t.id, body) }
                } label: { Image(systemName: "paperplane.fill") }
                .disabled(newComment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }

    @ViewBuilder private func section<Content: View>(_ title: String,
                                                     @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.orbitLabel).bold().foregroundStyle(.secondary)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
