package io.orbitd.android.core.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull

/**
 * One change of the mode a session's engine actually runs in (shared `SessionPermissionModeChange`, migration 1437). [cause] is
 * what made it: CLAIM (a claim handed the runner this mode), OWNER_PICK (the owner's config change reached the engine; [client] is
 * the app it came from when the request said), ENGINE_REPORT (Claude Code's init frame said another mode), RUNNER_CORRECTION (the
 * runner switched the engine itself), RESPAWN (the engine came back from a re-spawn in this mode) or ORBIT_CHANGE (a config change
 * Orbit made, not the owner). [fromMode] is null for the session's first recorded mode. [seq] is the order it was recorded in
 * (migration 1810): two changes can share [at], never a seq. Null from a server older than that, which pages none.
 */
data class PermissionModeChange(val fromMode: String?, val toMode: String, val cause: String, val client: String?, val at: String,
    val seq: Long? = null) {
    /** Its line in the transcript: by its seq where the server numbers it, so repeated transitions at one moment are lines apart. */
    val key: String get() = seq?.let { "permission-mode:seq-$it" } ?: "permission-mode:$at:$cause:$toMode"
}

/**
 * The session's word on its permission mode (shared `SessionPermissionModeFacts`): `permissionMode` is the owner's intent, which
 * only the owner's pick rewrites; `actualPermissionMode` is the mode the engine runs in, null until a claim records one and absent
 * from a server older than migration 1437, which [reported] tells apart. The detail carries the changes that led there; a list row
 * carries none. A field that is absent or not a string reads as null, and a mode word this build does not know is still the
 * server's word: it is shown as spelled, never dropped.
 */
object PermissionModes {
    const val AUTO = "auto"
    const val DEFAULT = "default"
    const val BYPASS = "bypassPermissions"

    /** AgentDefaults.permissionModes and their names. */
    private val LABELS = mapOf("default" to "Default", "acceptEdits" to "Accept Edits", "plan" to "Plan", "auto" to "Auto",
        "dontAsk" to "Don't Ask", "bypassPermissions" to "Bypass")

    fun label(mode: String): String = LABELS[mode] ?: mode

    fun intent(o: JsonObject): String? = word(o, "permissionMode")
    fun actual(o: JsonObject): String? = word(o, "actualPermissionMode")
    fun actualAt(o: JsonObject): String? = word(o, "actualPermissionModeAt")

    /** Whether the payload speaks of the mode running at all: a server older than migration 1437 sends no `actualPermissionMode`. */
    fun reported(o: JsonObject): Boolean = "actualPermissionMode" in o

    /** The detail's changes, oldest first, as the server orders them. An entry with no mode, cause or time is left out. */
    fun changes(o: JsonObject): List<PermissionModeChange> = changesIn(o["permissionModeChanges"])

    /** Whether the detail says older changes than its own are recorded (GET /sessions/:id/permission-mode-changes?before=<seq>). */
    fun changesHasMore(o: JsonObject): Boolean = (o["permissionModeChangesHasMore"] as? JsonPrimitive)?.booleanOrNull == true

    /** A page of older changes as that route answers it, `{ changes, hasMore }`: its changes, oldest first, and whether older remain. */
    fun page(o: JsonObject): ModeChangePage = ModeChangePage(changesIn(o["changes"]), (o["hasMore"] as? JsonPrimitive)?.booleanOrNull == true)

    private fun changesIn(array: JsonElement?): List<PermissionModeChange> = (array as? JsonArray).orEmpty().mapNotNull { element ->
        val change = element as? JsonObject ?: return@mapNotNull null
        PermissionModeChange(
            fromMode = word(change, "fromMode"),
            toMode = word(change, "toMode") ?: return@mapNotNull null,
            cause = word(change, "cause") ?: return@mapNotNull null,
            client = word(change, "client"),
            at = word(change, "at") ?: return@mapNotNull null,
            seq = (change["seq"] as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull,
        )
    }

    private fun word(o: JsonObject, key: String): String? =
        (o[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.takeIf { it.isNotEmpty() }
}
