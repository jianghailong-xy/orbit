import Foundation

/// New workspace on a machine that may have workspaces already (docs/mocks/new-workspace-form/02-apple-entry, owner A
/// 2026-11-20): the + on the Workspaces group, its menu of machines, the machine page's row and the page's title. The
/// card on the page says `MachineSetupCopy`'s sentences.
public enum NewWorkspaceCopy {
    /// The page's title, the machine page's row, and the +'s accessibility label.
    public static let NEW_WORKSPACE = "New workspace"
    /// Heads the + menu's machines.
    public static let NEW_WORKSPACE_ON = "New workspace on"

    /// What a machine in that menu holds, and whether it is here.
    public static func machineDetail(workspaces: Int, online: Bool) -> String {
        let held = workspaces == 0 ? "No workspaces yet" : workspaces == 1 ? "1 workspace" : "\(workspaces) workspaces"
        return online ? held : "Offline · \(held)"
    }
}
