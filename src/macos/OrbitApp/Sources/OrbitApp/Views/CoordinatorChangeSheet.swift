import SwiftUI
import OrbitKit

/// Change workspace (docs/mocks/coordinator-move-workspace/04-change; web `CoordinatorChangeDialog`):
/// where a project is coordinated from. With a coordinator conversation that exists and is not in
/// Trash, the rows are the server's `move-targets` — each other workspace saying whether the
/// conversation comes along or a new one opens there, or greyed with why not; with none, the owner's
/// workspaces in the sidebar's order, each taking a new one. The current workspace leads, marked
/// Current. A tap hands the row (and the targets it was read from) to the project page, which asks
/// before anything happens.
struct CoordinatorChangeSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let projectTitle: String
    /// The conversation that can come along; nil when it is in Trash or was never opened.
    let sessionID: String?
    let currentWorkspaceID: String?
    let currentWorkspaceName: String?
    let onPick: (CoordinatorChangeRow, SessionMoveTargets?) -> Void

    @State private var targets: SessionMoveTargets?
    @State private var targetsFailure: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if let rows {
                        ForEach(rows) { row in
                            Button { onPick(row, targets) } label: { label(row) }
                                .buttonStyle(.plain)
                                .disabled(row.way == nil)
                        }
                    } else if let targetsFailure {
                        Text(targetsFailure).foregroundStyle(.secondary)
                    } else {
                        Text(SessionMoveCopy.loadingWorkspaces).foregroundStyle(.secondary)
                    }
                } header: {
                    Text(CoordinatorChangeCopy.sub(projectTitle, from: currentWorkspaceName))
                } footer: {
                    Text(CoordinatorChangeCopy.foot)
                }
            }
            .navigationTitle(CoordinatorChangeCopy.title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(CoordinatorChangeCopy.cancel) { dismiss() }
                }
            }
        }
        .task { await loadTargets() }
        #if os(iOS)
        .presentationDetents([.medium, .large])
        #else
        .frame(minWidth: 420, minHeight: 360)
        #endif
    }

    /// Nil while the server's targets are being read (or couldn't be).
    private var rows: [CoordinatorChangeRow]? {
        let agents = app.agents
        guard sessionID != nil else {
            return CoordinatorChangeLogic.rows(
                agents?.orderedItems ?? [], currentWorkspaceID: currentWorkspaceID,
                runnerName: { agents?.runnerNames[$0] },
                runnerOnline: { agents?.runnerOnline[$0] },
                providerName: providerName)
        }
        guard let targets, let currentWorkspaceID else { return nil }
        return CoordinatorChangeLogic.rows(
            targets, currentID: currentWorkspaceID, currentName: currentWorkspaceName ?? "",
            currentProvider: agents?.agent(currentWorkspaceID)?.defaultProvider ?? "claude",
            providerName: providerName)
    }

    private func providerName(_ slug: String) -> String {
        ProviderEngines.isEngine(slug) ? ProviderEngines.cliName(slug)
            : AgentDefaults.providerName(slug, configured: app.agents?.configuredProviders)
    }

    private func loadTargets() async {
        guard let sessionID else { return }
        do {
            targets = try await app.sessionMoveTargets(sessionID)
        } catch {
            targetsFailure = SessionMoveCopy.targetsFailed(error)
        }
    }

    private func label(_ row: CoordinatorChangeRow) -> some View {
        HStack(spacing: 12) {
            ProviderMark(provider: row.provider, size: 30)
                .opacity(row.way == nil ? 0.45 : 1)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.name)
                    .foregroundStyle(row.way == nil ? .secondary : .primary)
                    .lineLimit(1)
                if !row.subtitle.isEmpty {
                    Text(row.subtitle)
                        .font(.orbitListSubtitle)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            if row.isCurrent {
                Text(CoordinatorChangeCopy.current).foregroundStyle(.secondary)
            }
            if row.runnerOffline {
                Text(CoordinatorChangeCopy.runnerOffline).font(.orbitLabel).foregroundStyle(.secondary)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
