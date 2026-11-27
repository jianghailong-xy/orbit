import SwiftUI
import OrbitKit

/// The Workspaces group's + (docs/mocks/new-workspace-form/02-apple-entry, owner A 2026-11-20): New workspace on a
/// machine. A menu of the account's machines, each with what it holds, or straight to the page with only one machine.
/// Nothing while the account has none.
struct NewWorkspaceButton: View {
    let machines: [NewWorkspaceMachine]
    let open: (String) -> Void

    var body: some View {
        if machines.count == 1, let only = machines.first {
            Button { open(only.id) } label: { plus }
                .buttonStyle(.borderless)
                .accessibilityLabel(NewWorkspaceCopy.NEW_WORKSPACE)
                .accessibilityIdentifier("new-workspace")
        } else if !machines.isEmpty {
            Menu {
                Section(NewWorkspaceCopy.NEW_WORKSPACE_ON) {
                    ForEach(machines) { machine in
                        Button { open(machine.id) } label: { item(machine) }
                    }
                }
            } label: { plus }
            .menuIndicator(.hidden)
            #if os(macOS)
            .menuStyle(.button)
            .buttonStyle(.borderless)
            .fixedSize()
            #endif
            .accessibilityLabel(NewWorkspaceCopy.NEW_WORKSPACE)
            .accessibilityIdentifier("new-workspace")
        }
    }

    /// The machine's name, and under it (beside it on a Mac's one-line menu) what it holds.
    @ViewBuilder private func item(_ machine: NewWorkspaceMachine) -> some View {
        let detail = NewWorkspaceCopy.machineDetail(workspaces: machine.workspaces, online: machine.online)
        #if os(macOS)
        Text(verbatim: "\(machine.name) · \(detail)")
        #else
        Text(machine.name)
        Text(detail)
        #endif
    }

    private var plus: some View {
        Image(systemName: "plus")
            .font(.orbitLabel.weight(.semibold))
            .foregroundStyle(Color.accentColor)
            .frame(width: 24, height: 22)
            .contentShape(Rectangle())
    }
}
