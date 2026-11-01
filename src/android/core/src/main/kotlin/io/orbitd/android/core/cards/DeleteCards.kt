package io.orbitd.android.core.cards

import kotlinx.serialization.json.JsonObject

/** One workspace deleted with a runner: what the owner may not have had in mind. */
data class DeleteWorkspace(val name: String, val workDir: String?)

/**
 * What a delete would take away, read off the card the server filed for it (OrbitKit `DeleteApprovalPreview`, web `deleteInput`).
 * The asker sends only an id: the name, where it stands and what goes with it are the server's own reading
 * (`runner-api/runner-delete-approval.ts`), so a card cannot name one machine and delete another.
 */
data class DeleteCard(val isRunner: Boolean, val name: String, val online: Boolean = false, val lastHeartbeatAt: String? = null,
    val host: String? = null, val workDir: String? = null, val workspaces: List<DeleteWorkspace> = emptyList())

/** The delete cards' names and words. The server deletes only on a card a person answered, so there is no standing yes to offer. */
object DeleteCards {
    const val runnerTool = "orbit_runner_delete"
    const val workspaceTool = "orbit_agent_delete"
    const val goesWith = "Deleted with it"
    const val noWorkspaces = "No workspaces are bound to it."
    const val runnerNote = "This removes the runner and its workspaces from your account. Re-register the machine to add it back."
    const val workspaceNote = "The workspace leaves your list but is not erased — its sessions and tasks are kept and stay linked to it."

    fun title(tool: String) = if (tool == runnerTool) "Delete this runner?" else "Delete this workspace?"

    /** The runner a workspace is on. */
    fun onRunner(host: String?) = host?.let { "On $it" } ?: "On no runner"

    fun read(tool: String, input: JsonObject): DeleteCard {
        fun JsonObject.filled(key: String) = text(key)?.takeIf { it.isNotEmpty() }
        if (tool != runnerTool) return DeleteCard(false, input.filled("name").orEmpty(), workDir = input.filled("workDir"),
            host = input.obj("runner")?.let { it.filled("displayName") ?: it.filled("name") })
        return DeleteCard(true, input.filled("displayName") ?: input.filled("name").orEmpty(), input.flag("online"), input.filled("lastHeartbeatAt"),
            workspaces = input.objects("workspaces").map { DeleteWorkspace(it.text("name").orEmpty(), it.filled("workDir")) })
    }
}
