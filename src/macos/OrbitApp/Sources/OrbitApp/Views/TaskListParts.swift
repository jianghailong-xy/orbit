import SwiftUI
import OrbitKit

#if os(iOS)
/// The iPhone Tasks list's parts: the header rows above the tasks (progress, the line about the
/// tasks on project pages, the status chips, the scope's tokens), the section headers, the batch
/// rows, and the two sheets the header opens. The page itself — its toolbar, its selection and its
/// rows — is `TasksListView`.
///
/// The arrangement is the web page's, block for block (title, progress, scope note, tabs, search,
/// Happening now, rows); the controls are the sibling pages': the title switcher and the one
/// trailing menu are the Sessions list's, the search field held under the bar is Sessions' and
/// Projects', and a section header is the Projects list's.

// MARK: - Header rows

/// The progress line: a bar and "Done 648 / 704". The other tallies are on the chips below it, so
/// the line says the one number the chips do not.
struct TaskProgressLine: View {
    let overview: TaskOverview

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            ProgressView(value: Double(overview.done), total: Double(max(overview.total, 1)))
                .tint(.green)
            sentence
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    // One `Text` per part, joined afterwards: a single expression mixing String `+` and Text `+`
    // is the shape the type checker gives up on.
    private var sentence: Text {
        let words = TaskListCopy.doneOfTotal(done: overview.done, total: overview.total)
        let lead: Text = Text("\(words.lead) ")
        let done: Text = Text(words.done).fontWeight(.semibold).foregroundColor(.primary)
        let tail: Text = Text(" \(words.tail)")
        return lead + done + tail
    }
}

/// "Tasks outside projects. 111,233 tasks in 71 projects are on their project pages. Projects ›" —
/// the one sentence the page says about the work it does not list, and the way to it.
struct TaskScopeNote: View {
    let inProjects: TaskInProjectsCount
    let openProjects: () -> Void

    var body: some View {
        Button(action: openProjects) {
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Image(systemName: "square.grid.2x2")
                    .font(.orbitMeta)
                    .foregroundStyle(.secondary)
                sentence
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.leading)
            }
        }
        .buttonStyle(.plain)
    }

    private var sentence: Text {
        let words = TaskListCopy.scopeNote(tasks: inProjects.tasks, projects: inProjects.projects)
        let lead: Text = Text("\(words.lead) ")
        let count: Text = Text(words.count).fontWeight(.semibold).foregroundColor(.primary)
        let tail: Text = Text(" \(words.tail) ")
        let link: Text = Text(TaskListCopy.projectsLink).foregroundColor(.accentColor)
        return lead + count + tail + link
    }
}

/// The status tabs as a row of chips, each with its count — the web's tab row in its order, the
/// selected one filled. Scrolls sideways; the selected chip is brought into view when it changes.
struct TaskFilterChips: View {
    let filters: [TaskFilter]
    let overview: TaskOverview
    let selected: TaskFilter
    let select: (TaskFilter) -> Void

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(filters) { filter in
                        chip(filter).id(filter)
                    }
                }
                .padding(.horizontal, 16)
            }
            .onAppear { proxy.scrollTo(selected, anchor: .center) }
            .onChange(of: selected) { _, now in
                withAnimation(.snappy) { proxy.scrollTo(now, anchor: .center) }
            }
        }
    }

    private func chip(_ filter: TaskFilter) -> some View {
        let on = filter == selected
        let count = overview.count(for: filter)
        let countStyle: AnyShapeStyle
        if on { countStyle = AnyShapeStyle(Color.white.opacity(0.75)) }
        else if filter == .failed && count > 0 { countStyle = AnyShapeStyle(Color.red) }
        else { countStyle = AnyShapeStyle(.secondary) }
        return Button { select(filter) } label: {
            HStack(spacing: 6) {
                Text(filter.title)
                Text(count.formatted())
                    .foregroundStyle(countStyle)
                    .monospacedDigit()
            }
            .font(.orbitSubtext.weight(.medium))
            .foregroundStyle(on ? AnyShapeStyle(.white) : AnyShapeStyle(.primary))
            .padding(.horizontal, 13)
            .frame(minHeight: 32)
            .background(on ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(.quaternary), in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(filter.title), \(count)")
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// One scope token under the chips — a label the page is narrowed to — with its ✕.
struct TaskScopeToken: View {
    let text: String
    let remove: () -> Void

    var body: some View {
        HStack(spacing: 5) {
            Text(text).lineLimit(1).truncationMode(.tail)
            Button(action: remove) { Image(systemName: "xmark.circle.fill") }
                .buttonStyle(.plain)
                .foregroundStyle(Color.accentColor.opacity(0.6))
                .accessibilityLabel("Remove \(text)")
        }
        .font(.orbitLabel.weight(.medium))
        .foregroundStyle(Color.accentColor)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(Color.accentColor.opacity(0.12), in: Capsule())
    }
}

/// A list's own entry to the conversation it is steered from — the web's button beside the title.
struct TaskSteeringSessionButton: View {
    let opening: Bool
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 6) {
                if opening { SpinnerGlyph(color: .accentColor) }
                else { Image(systemName: "bubble.left") }
                Text(TaskListCopy.steeringSession)
            }
            .font(.orbitSubtext.weight(.semibold))
            .foregroundStyle(Color.accentColor)
            .padding(.horizontal, 13)
            .frame(minHeight: 32)
            .background(Color.accentColor.opacity(0.12), in: Capsule())
        }
        .buttonStyle(.plain)
        .disabled(opening)
    }
}

/// A section header written as the section's first row, not as a `Section` header: iOS 26 pins a
/// plain list's section header without a background, so it would draw over the rows scrolling
/// under it. The Projects list's weight — bold title, grey count.
struct TaskListSectionHeader: View {
    let title: String
    var count: Int?
    var hint: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(title).font(.orbitSubtext.weight(.bold)).foregroundStyle(Color.primary)
            if let count {
                Text(count.formatted()).font(.orbitLabel.weight(.semibold)).foregroundStyle(Color.secondary)
            }
            Spacer(minLength: 0)
            if let hint {
                Text(hint).font(.orbitLabel).foregroundStyle(Color.secondary)
            }
        }
        .padding(.top, 10)
        .accessibilityAddTraits(.isHeader)
    }
}

// MARK: - Batches

/// One label's progress — the web's Batches table row as two lines: the label and how many are
/// done, then a bar and how many are left. Tapping it lists that batch.
struct TaskBatchRow: View {
    let row: TaskLabelRow

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(row.label).font(.body.weight(.medium)).lineLimit(1)
                Spacer(minLength: 8)
                Text("\(row.done.formatted()) / \(row.total.formatted())")
                    .font(.orbitListSubtitle)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                Image(systemName: "chevron.right")
                    .font(.orbitMeta.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            HStack(spacing: 10) {
                ProgressView(value: Double(row.done), total: Double(max(row.total, 1)))
                    .tint(.green)
                    .frame(maxWidth: 150)
                Text(TaskListCopy.left(max(row.total - row.done, 0)))
                    .font(.orbitListSubtitle)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }
}

// MARK: - Labels sheet

/// The web's Labels picker as a sheet: searchable, several at once, each with its count. What is
/// picked narrows the rows and the chips alike (the server applies labels before it counts).
struct TaskLabelsSheet: View {
    let rows: [TaskLabelRow]
    let initial: [String]
    let apply: ([String]) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var picked: Set<String> = []
    @State private var query = ""

    var body: some View {
        NavigationStack {
            List {
                ForEach(filtered, id: \.label) { row in
                    Button {
                        if picked.contains(row.label) { picked.remove(row.label) } else { picked.insert(row.label) }
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "checkmark")
                                .font(.orbitLabel.weight(.semibold))
                                .foregroundStyle(Color.accentColor)
                                .opacity(picked.contains(row.label) ? 1 : 0)
                                .frame(width: 18)
                            Text(row.label).foregroundStyle(Color.primary).lineLimit(1)
                            Spacer(minLength: 8)
                            Text(row.total.formatted()).font(.orbitListSubtitle).foregroundStyle(.secondary)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .listStyle(.plain)
            .navigationTitle(TaskListCopy.labelsTitle)
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always),
                        prompt: TaskListCopy.searchLabels)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(TaskListCopy.clearLabels) { picked = [] }
                        .disabled(picked.isEmpty)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        // In the order the table lists them, so the tokens do not reshuffle.
                        apply(rows.map(\.label).filter(picked.contains))
                        dismiss()
                    }
                    .fontWeight(.semibold)
                }
            }
            .onAppear { picked = Set(initial) }
        }
        .presentationDetents([.medium, .large])
    }

    private var filtered: [TaskLabelRow] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return rows }
        return rows.filter { $0.label.localizedCaseInsensitiveContains(needle) }
    }
}
#endif

#if os(iOS)
/// The bulk bar's four actions (Select Tasks), each confirmed before it is sent — the web's.
enum TaskBatchAction: Identifiable {
    case run, stop, assign, delete
    var id: Self { self }
}
#endif
