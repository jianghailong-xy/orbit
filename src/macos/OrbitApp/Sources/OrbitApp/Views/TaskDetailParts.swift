import SwiftUI
import OrbitKit

// The pieces of the task page that are not the page itself: the bar's title once the header has
// scrolled away, the three sheets its rows open (Start at, Acceptance, Follow task), the dependency
// graph, an input's thumbnail and long text that folds. Every word comes from `TaskDetailCopy`.

#if os(iOS)
/// The bar's title once the page's own header has scrolled away — the session and project pages'
/// shape: the name over a status line, centred, cut short rather than wrapped.
struct TaskNavTitle: View {
    let task: TaskItem

    var body: some View {
        VStack(spacing: 1) {
            Text(task.title)
                .font(.headline)
                .lineLimit(1)
                .truncationMode(.tail)
            Text([TaskListLogic.pill(task).label, task.assignee?.name].compactMap { $0 }.joined(separator: " · "))
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(maxWidth: 240)
        .clipped()
    }
}
#endif

/// A description or a comment: drawn whole when it is short, folded with `Show more` when it is not.
/// Whether it folds is decided from the text (`TaskDetailLogic.folds`), never from a measured height.
struct FoldableMarkdown: View {
    let source: String
    let foldedHeight: CGFloat
    @State private var open = false

    var body: some View {
        let folds = TaskDetailLogic.folds(source)
        let folded = folds && !open
        VStack(alignment: .leading, spacing: 6) {
            MarkdownView(source: source)
                .font(.orbitProse)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .frame(maxHeight: folded ? foldedHeight : nil, alignment: .top)
                .clipped()
                .mask {
                    if folded {
                        LinearGradient(stops: [.init(color: .black, location: 0), .init(color: .black, location: 0.72),
                                               .init(color: .clear, location: 1)],
                                       startPoint: .top, endPoint: .bottom)
                    } else {
                        Rectangle()
                    }
                }
            if folds {
                Button(open ? TaskDetailCopy.showLess : TaskDetailCopy.showMore) {
                    withAnimation(.easeOut(duration: 0.2)) { open.toggle() }
                }
                .font(.orbitSubtext.weight(.semibold))
                .buttonStyle(.borderless)
            }
        }
    }
}

/// The dependency component drawn with the project graph's layout and marks, scaled to the row's
/// width, the task being read outlined. Tapping another task opens it.
struct TaskDependencyGraphView: View {
    let graph: TaskDependencyGraph
    let onOpenTask: (String) -> Void

    @State private var width: CGFloat = 0

    private static let maxInlineHeight: CGFloat = 420
    private static let minInlineScale: CGFloat = 0.5

    var body: some View {
        let drawn = TaskDetailLogic.graphMarks(graph)
        VStack(spacing: 0) {
            if width > 0 {
                let layout = ProjectGraph.layout(marks: drawn.marks, edges: drawn.edges, availableWidth: Double(width))
                let scale = inlineScale(layout)
                ProjectGraphCanvas(layout: layout, edges: drawn.edges, onOpenMark: { mark in
                    guard mark.id != graph.focusTaskId else { return }
                    onOpenTask(mark.taskId ?? mark.id)
                }, focusID: graph.focusTaskId)
                .scaleEffect(scale, anchor: .topLeading)
                .frame(width: CGFloat(layout.width) * scale,
                       height: min(CGFloat(layout.height) * scale, Self.maxInlineHeight),
                       alignment: .topLeading)
                .clipped()
                .frame(maxWidth: .infinity, alignment: .center)
            }
        }
        .frame(maxWidth: .infinity)
        .background {
            GeometryReader { geo in
                Color.clear.onChange(of: geo.size.width, initial: true) { _, w in width = w }
            }
        }
    }

    private func inlineScale(_ layout: ProjectGraph.Layout) -> CGFloat {
        let fit = CGFloat(layout.fit(width: Double(width)))
        let tall = layout.height > 0 ? Self.maxInlineHeight / CGFloat(layout.height) : 1
        return max(Self.minInlineScale, min(fit, tall))
    }
}

/// An input's picture when it is one, its kind otherwise.
struct TaskInputThumbnail: View {
    @Environment(AppModel.self) private var model
    let input: TaskInput
    @State private var image: PlatformImage?

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 7, style: .continuous)
        Group {
            if let image {
                Image(platformImage: image).resizable().scaledToFill()
            } else {
                Image(systemName: input.isImage ? "photo" : "doc")
                    .font(.orbitGlyph)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: 36, height: 36)
        .background(Color.secondary.opacity(0.1), in: shape)
        .clipShape(shape)
        .task(id: input.id) {
            // A thumbnail that will not load is not worth a banner: the file's name stands beside it.
            guard input.isImage, image == nil, let baseURL = model.baseURL else { return }
            let api = APIClient(baseURL: baseURL, tokenStore: model.tokenStore)
            if let data = try? await api.downloadAttachment(input.id), let decoded = PlatformImage(data: data) {
                image = decoded
            }
        }
    }
}

/// `Start at`: the one time the task starts by itself. Saved explicitly — a wheel scrolled through
/// past times must not schedule each of them on the way.
struct TaskScheduleSheet: View {
    @Environment(\.dismiss) private var dismiss
    let task: TaskItem
    /// True when the write went through; the page says so.
    let onSave: (Date) async -> Bool
    let onCancelSchedule: () async -> Bool

    @State private var date: Date
    @State private var saving = false

    init(task: TaskItem, onSave: @escaping (Date) async -> Bool, onCancelSchedule: @escaping () async -> Bool) {
        self.task = task
        self.onSave = onSave
        self.onCancelSchedule = onCancelSchedule
        let stored = task.runAt.flatMap { RelativeTime.parse($0) }
        _date = State(initialValue: stored ?? Self.nextHour())
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    DatePicker(TaskDetailCopy.startAtLabel, selection: $date, in: Date()...,
                               displayedComponents: [.date, .hourAndMinute])
                        .datePickerStyle(.graphical)
                } footer: {
                    Text(TaskDetailLogic.scheduleHint(task.runAt))
                }
                if task.runAt != nil {
                    Section {
                        Button(TaskDetailCopy.cancelSchedule, role: .destructive) { cancelSchedule() }
                            .disabled(saving)
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(TaskDetailCopy.startAtLabel)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(TaskDetailCopy.cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(TaskDetailCopy.saveSchedule) { save() }
                        .disabled(saving)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 420, minHeight: 560)
        #endif
    }

    private func save() {
        saving = true
        Task {
            if await onSave(date) { dismiss() } else { saving = false }
        }
    }

    private func cancelSchedule() {
        saving = true
        Task {
            if await onCancelSchedule() { dismiss() } else { saving = false }
        }
    }

    private static func nextHour() -> Date {
        let calendar = Calendar.current
        let now = Date()
        let hour = calendar.dateInterval(of: .hour, for: now)?.start ?? now
        return calendar.date(byAdding: .hour, value: 1, to: hour) ?? now.addingTimeInterval(3_600)
    }
}

/// The acceptance block's editor: the criteria, and the command with the exit code that counts as
/// done — saved together or not at all (`TaskAcceptanceDraft`).
struct TaskAcceptanceSheet: View {
    @Environment(\.dismiss) private var dismiss
    let current: TaskAcceptanceDraft
    let onSave: (UpdateTaskRequest) async -> Bool

    @State private var draft: TaskAcceptanceDraft
    @State private var saving = false

    init(current: TaskAcceptanceDraft, onSave: @escaping (UpdateTaskRequest) async -> Bool) {
        self.current = current
        self.onSave = onSave
        _draft = State(initialValue: current)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(TaskDetailCopy.acceptanceCriteriaPlaceholder, text: $draft.criteria, axis: .vertical)
                        .lineLimit(3...10)
                } header: {
                    Text(TaskDetailCopy.acceptanceCriteriaLabel)
                }
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(TaskDetailCopy.acceptanceCommandLabel)
                            .font(.orbitLabel)
                            .foregroundStyle(.secondary)
                        TextField(TaskDetailCopy.acceptanceCommandPlaceholder, text: $draft.command)
                            .font(.orbitMono)
                            .autocorrectionDisabled()
                            #if os(iOS)
                            .textInputAutocapitalization(.never)
                            #endif
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text(TaskDetailCopy.doneWhenItExits)
                            .font(.orbitLabel)
                            .foregroundStyle(.secondary)
                        TextField("0", text: $draft.exitCode)
                            .font(.orbitMono)
                            #if os(iOS)
                            .keyboardType(.numbersAndPunctuation)
                            #endif
                    }
                } header: {
                    Text(TaskDetailCopy.automaticJudgementLabel)
                } footer: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(TaskDetailCopy.acceptanceAutomaticHint)
                        if let problem = draft.problem {
                            Text(problem).foregroundStyle(.red)
                        }
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(TaskDetailCopy.acceptanceHeading)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(TaskDetailCopy.cancel) { dismiss() }
                        .disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(TaskDetailCopy.saveAcceptance) { save() }
                        .disabled(saving || !draft.canSave(over: current))
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 520)
        #endif
    }

    private func save() {
        saving = true
        let request = draft.patch(over: current)
        Task {
            if await onSave(request) { dismiss() } else { saving = false }
        }
    }
}

/// Follow task: wait for a condition on this task, then notify you — until a deadline. The web's
/// Follow dialog over one task target; resuming a session is the browser's alone for now.
struct TaskFollowSheet: View {
    @Environment(\.dismiss) private var dismiss
    let task: TaskItem
    let store: WatchesModel
    let onFollowed: (Watch) -> Void

    @State private var condition: WatchPredicate = TaskDetailLogic.followConditions.first ?? .all(.taskTerminal)
    @State private var ttlSeconds = TaskDetailLogic.defaultFollowDeadline
    @State private var saving = false
    @State private var errorText: String?
    /// One key per sheet: a retried Follow returns the watch the first press made.
    @State private var idempotencyKey = UUID().uuidString.lowercased()

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(task.title).lineLimit(3)
                } header: {
                    Text(TaskDetailCopy.watchingLabel)
                }
                Section {
                    Picker(TaskDetailCopy.waitUntilTheTask, selection: $condition) {
                        ForEach(TaskDetailLogic.followConditions, id: \.self) { predicate in
                            Text(WatchProjection.condition(predicate, targetCount: 1)).tag(predicate)
                        }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                } header: {
                    Text(TaskDetailCopy.waitUntilTheTask)
                }
                Section {
                    Label(TaskDetailCopy.notifyMe, systemImage: "bell")
                } header: {
                    Text(TaskDetailCopy.thenLabel)
                }
                Section {
                    Picker(TaskDetailCopy.stopWatchingAfter, selection: $ttlSeconds) {
                        ForEach(TaskDetailLogic.followDeadlines, id: \.self) { seconds in
                            Text(WatchEditing.deadlineTitle(seconds)).tag(seconds)
                        }
                    }
                } footer: {
                    Text(TaskDetailCopy.followDeadlineHint)
                }
                if let errorText {
                    Section {
                        Text(errorText).foregroundStyle(.red)
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(TaskDetailCopy.followTask)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(TaskDetailCopy.cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(TaskDetailCopy.follow) { follow() }
                        .disabled(saving)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 520)
        #endif
    }

    private func follow() {
        saving = true
        errorText = nil
        let request = CreateWatchRequest(taskID: task.id, predicate: condition, ttlSeconds: ttlSeconds,
                                         idempotencyKey: idempotencyKey)
        Task {
            let result = await store.create(request)
            if let watch = result.watch {
                onFollowed(watch)
                dismiss()
            } else {
                errorText = result.failure
                saving = false
            }
        }
    }
}
