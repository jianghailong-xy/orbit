import SwiftUI
import OrbitKit

/// Start a new coordinator in… (docs/mocks/coordinator-move-workspace 03-final ④–⑥; web
/// `CoordinatorWorkspaceDialog`): the owner's workspaces in the sidebar's order, each with its brand
/// mark, name and `<Provider> · <runner>`. One a new coordinator can't open in is greyed with why; the
/// one the project is coordinated in now says Current; an away runner says Runner offline. A tap hands
/// the row to the project page, which asks before anything is started.
struct CoordinatorWorkspaceSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let projectTitle: String
    let currentWorkspaceID: String?
    let onPick: (CoordinatorWorkspaceRow) -> Void

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(rows) { row in
                        Button { onPick(row) } label: { label(row) }
                            .buttonStyle(.plain)
                            .disabled(row.reason != nil)
                    }
                } header: {
                    Text(projectTitle)
                } footer: {
                    Text(StartCoordinatorCopy.pickerFoot)
                }
            }
            .navigationTitle(StartCoordinatorCopy.pickerTitle)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(SessionMoveCopy.cancel) { dismiss() }
                }
            }
        }
        #if os(iOS)
        .presentationDetents([.medium, .large])
        #else
        .frame(minWidth: 420, minHeight: 360)
        #endif
    }

    private var rows: [CoordinatorWorkspaceRow] {
        let agents = app.agents
        return CoordinatorWorkspaceLogic.rows(
            agents?.orderedItems ?? [], currentWorkspaceID: currentWorkspaceID,
            runnerName: { agents?.runnerNames[$0] },
            runnerOnline: { agents?.runnerOnline[$0] },
            providerName: { slug in
                ProviderEngines.isEngine(slug) ? ProviderEngines.cliName(slug)
                    : AgentDefaults.providerName(slug, configured: agents?.configuredProviders)
            })
    }

    private func label(_ row: CoordinatorWorkspaceRow) -> some View {
        HStack(spacing: 12) {
            ProviderMark(provider: row.provider, size: 30)
                .opacity(row.reason == nil ? 1 : 0.45)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.name)
                    .foregroundStyle(row.reason == nil ? .primary : .secondary)
                    .lineLimit(1)
                Text(row.detail)
                    .font(.orbitListSubtitle)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
            if row.isCurrent {
                Text(StartCoordinatorCopy.current).foregroundStyle(.secondary)
            }
            if row.runnerOffline {
                Text(StartCoordinatorCopy.runnerOffline).font(.orbitLabel).foregroundStyle(.secondary)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
