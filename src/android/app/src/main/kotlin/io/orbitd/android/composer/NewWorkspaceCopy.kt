package io.orbitd.android.composer

/**
 * New workspace on a machine that may have workspaces already (docs/mocks/new-workspace-form/02-apple-entry, owner A 2026-11-20): the
 * + on the drawer's Workspaces heading, its menu of machines, the machine page's row and the page's title. Words of iOS's
 * `NewWorkspaceCopy.swift`; the card on the page says `MachineSetupCopy`'s sentences.
 */
object NewWorkspaceCopy {
    /** The page's title, the machine page's row, and the +'s accessibility label. */
    const val NEW_WORKSPACE = "New workspace"
    /** Heads the + menu's machines. */
    const val NEW_WORKSPACE_ON = "New workspace on"

    /** What a machine in that menu holds, and whether it is here. */
    fun machineDetail(workspaces: Int, online: Boolean): String {
        val held = if (workspaces == 0) "No workspaces yet" else if (workspaces == 1) "1 workspace" else "$workspaces workspaces"
        return if (online) held else "Offline · $held"
    }
}
