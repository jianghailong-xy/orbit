package io.orbitd.android.core.cards

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/** One variable on a workspace write's card, with its whole value. */
data class WorkspaceWriteVariable(val name: String, val value: String) {
    /** The way the engine will see it, on one block however long the value is. */
    val line get() = "$name=$value"
}

/** One more thing the write changes, in the card's own words. */
data class WorkspaceWriteField(val caption: String, val value: String)

/**
 * What a workspace write would do, read off the card the server filed for it (OrbitKit `WorkspaceWritePreview`, web
 * `workspaceWriteInput`): which workspace, each variable by name and whole value, and what else it changes. The owner decides by
 * reading the values, and the server erases them from the card once it is answered.
 */
data class WorkspaceWriteCard(val isCreate: Boolean, val name: String, val host: String?, val workDir: String?,
    val env: List<WorkspaceWriteVariable>?, val envRemoved: List<String>, val fields: List<WorkspaceWriteField>)

/** The write cards' names and words. The server writes only on a card a person answered, so there is no standing yes to offer. */
object WorkspaceWriteCards {
    const val createTool = "orbit_agent_create"
    const val updateTool = "orbit_agent_update"
    const val variables = "Environment variables"
    const val noVariables = "No variables"
    const val removed = "Variables removed"
    const val note = "Every later session in this workspace starts with this, in any permission mode. A variable can run code as soon as the engine starts."

    fun title(tool: String) = if (tool == createTool) "Create this workspace?" else "Change this workspace?"

    fun read(tool: String, input: JsonObject): WorkspaceWriteCard {
        val creating = tool == createTool
        fun JsonObject.filled(key: String) = text(key)?.takeIf { it.isNotEmpty() }
        fun runner(row: JsonObject?) = row?.let { it.filled("displayName") ?: it.filled("name") }
        val changes = input.obj("changes") ?: emptyObject
        val fields = buildList {
            // An empty string is a field being cleared, which a blank row on a card would not say.
            fun written(key: String, caption: String) = changes.text(key)?.let { add(WorkspaceWriteField(caption, it.ifEmpty { "Cleared" })) }
            written("workDir", "Working directory")
            written("systemPrompt", "Base instructions")
            written("appendSystemPrompt", "Runtime instructions")
            runner(changes.obj("runner"))?.let { add(WorkspaceWriteField("Runner", it)) }
            (changes["enableWorktree"] as? JsonPrimitive)?.booleanOrNull?.let {
                add(WorkspaceWriteField("Worktree", if (it) "Each session gets its own git worktree" else "Sessions run in the shared folder"))
            }
            if (!creating) written("name", "Name")
            written("description", "Description")
            written("defaultMergeTarget", "Merge target")
        }
        return WorkspaceWriteCard(creating, input.filled("name").orEmpty(), runner(input.obj("runner")), input.filled("workDir"),
            changes.obj("env")?.map { (name, value) -> WorkspaceWriteVariable(name, (value as? JsonPrimitive)?.content.orEmpty()) }?.sortedBy { it.name },
            input.strings("envRemoved"), fields)
    }
}
