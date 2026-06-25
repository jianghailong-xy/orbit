import SwiftUI
import OrbitKit

struct MainView: View {
    @Environment(AppModel.self) private var model
    @State private var showRunner = false

    var body: some View {
        @Bindable var model = model
        NavigationSplitView {
            ActiveSidebar(selection: $model.selectedSessionID)
                .navigationSplitViewColumnWidth(min: 240, ideal: 300, max: 420)
                .navigationTitle("Active")
        } detail: {
            if let id = model.selectedSessionID, let baseURL = model.baseURL {
                ConsoleView(sessionID: id, baseURL: baseURL, tokenStore: model.tokenStore)
                    .id(id)   // rebuild (and restart the stream) when the selection changes
            } else {
                ContentUnavailableView("Select a session",
                                       systemImage: "bubble.left.and.bubble.right",
                                       description: Text("Live transcript appears here."))
            }
        }
        .toolbar {
            ToolbarItem {
                Button { showRunner = true } label: {
                    Label("Local runner", systemImage: "desktopcomputer")
                }
                .help("Manage the runner on this Mac")
            }
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    if let email = model.user?.email { Text(email) }
                    Button("Sign out", role: .destructive) { model.logout() }
                } label: {
                    Label(model.user?.name ?? model.user?.email ?? "Account", systemImage: "person.crop.circle")
                }
            }
        }
        .task { model.startPolling() }
        .sheet(isPresented: $showRunner) {
            if let url = model.baseURL {
                RunnerControlPane(baseURL: url, tokenStore: model.tokenStore)
            }
        }
    }
}

struct ActiveSidebar: View {
    @Environment(AppModel.self) private var model
    @Binding var selection: String?

    var body: some View {
        List(selection: $selection) {
            bucket("Needs you", model.groups.needsYou, tint: .orange)
            bucket("Running", model.groups.running, tint: .green)
            bucket("Queued", model.groups.queued, tint: .secondary)
        }
        .overlay {
            if model.groups.isEmpty {
                ContentUnavailableView("No active sessions", systemImage: "moon.zzz")
            }
        }
    }

    @ViewBuilder
    private func bucket(_ title: String, _ items: [Session], tint: Color) -> some View {
        if !items.isEmpty {
            Section(title) {
                ForEach(items) { session in
                    SessionRow(session: session, tint: tint).tag(session.id)
                }
            }
        }
    }
}

struct SessionRow: View {
    let session: Session
    let tint: Color

    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(tint).frame(width: 7, height: 7)
            VStack(alignment: .leading, spacing: 2) {
                Text(session.title ?? "Untitled session")
                    .lineLimit(1)
                Text(statusLabel).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if let n = session.pendingApprovals, n > 0 {
                Text("\(n)")
                    .font(.caption2.bold())
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(.orange, in: Capsule())
                    .foregroundStyle(.white)
            }
        }
        .padding(.vertical, 2)
    }

    private var statusLabel: String {
        switch session.status {
        case .running: return "Running"
        case .awaitingInput: return "Awaiting input"
        case .pending: return "Queued"
        case .interrupted: return "Interrupted"
        default: return session.status.rawValue.capitalized
        }
    }
}
