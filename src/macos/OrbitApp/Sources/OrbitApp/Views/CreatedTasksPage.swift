import SwiftUI
import OrbitKit

/// Every task one session's agent created — the card's `View all in Tasks ›` on a phone, pushed over
/// the console that asked so the back swipe returns to it. The Tasks page's own rows, newest first,
/// fifty at a time; a row opens its task on this same stack. (The three-column shells go to the
/// Tasks page itself, narrowed by the session — `AppModel.showTasksCreated`.)
struct CreatedTasksPage: View {
    @Environment(AppModel.self) private var app
    let sessionID: String

    @State private var rows: [TaskItem] = []
    @State private var cursor: String?
    @State private var loaded = false
    @State private var loading = false
    @State private var errorText: String?

    var body: some View {
        List {
            ForEach(rows) { task in
                // `Color.primary`, not `.primary`: a button's label resolves the hierarchical style
                // to its tint on device, which would draw every title blue.
                Button { app.push(.taskDetail(taskID: task.id)) } label: {
                    TaskRowView(task: task).foregroundStyle(Color.primary)
                }
            }
            if cursor != nil {
                Button {
                    Task { await load(more: true) }
                } label: {
                    HStack {
                        Spacer()
                        if loading { ProgressView().controlSize(.small) }
                        Text(loading ? "Loading…" : "Load more")
                        Spacer()
                    }
                }
                .disabled(loading)
            }
        }
        #if os(iOS)
        .listStyle(.plain)
        #endif
        .overlay {
            if !loaded {
                ProgressView()
            } else if rows.isEmpty, let errorText {
                ContentUnavailableView("Couldn't load the tasks", systemImage: "exclamationmark.triangle",
                                       description: Text(errorText))
            } else if rows.isEmpty {
                ContentUnavailableView("No tasks", systemImage: "checkmark.square")
            }
        }
        .navigationTitle(SessionCreatedTasksCopy.title)
        .task(id: sessionID) { await load(more: false) }
        .refreshable { await load(more: false) }
    }

    private func load(more: Bool) async {
        if more && loading { return }
        loading = true
        defer {
            loading = false
            loaded = true
        }
        do {
            guard let page = try await app.tasksCreated(inSession: sessionID, cursor: more ? cursor : nil)
            else { return }
            rows = more ? rows + page.items : page.items
            cursor = page.nextCursor
            errorText = nil
        } catch is CancellationError {
            return
        } catch {
            errorText = error.localizedDescription
        }
    }
}
