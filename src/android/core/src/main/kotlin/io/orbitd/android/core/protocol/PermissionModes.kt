package io.orbitd.android.core.protocol

import io.orbitd.android.core.realtime.RunEvent
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
 * (migration 1810): two changes can share [at], never a seq. Null from a server older than that, which pages none. A CLAIM that
 * handed another mode than the session asked for carries the mode asked for, [requestedMode], and why, [reason] (ROOT_RUNNER,
 * SCHEDULED_RUN; migration 1807).
 */
data class PermissionModeChange(val fromMode: String?, val toMode: String, val cause: String, val client: String?, val at: String,
    val seq: Long? = null, val requestedMode: String? = null, val reason: String? = null) {
    /** Its line in the transcript: by its seq where the server numbers it, so repeated transitions at one moment are lines apart. */
    val key: String get() = seq?.let { "permission-mode:seq-$it" } ?: "permission-mode:$at:$cause:$toMode"
}

/**
 * The runner's report that Claude would not take the Auto it asked for (`permission_mode_correction_failed`, runner-go
 * claude_mode_correction.go): [mode] is the mode it stays in, [requested] the one asked for, [reason] the CLI's own words. A system
 * event of the conversation, not a mode change, so it is read off the events loaded; [at] is the runner's stamp. The session detail
 * carries the one that still stands (`PermissionModes.detailRefusal`, seq [PermissionModes.DETAIL_SEQ]), whether or not its event is
 * loaded.
 */
data class PermissionModeRefusal(val seq: Long, val at: String, val mode: String, val requested: String, val reason: String) {
    /** Its line in the transcript. */
    val key: String get() = "permission-mode-refused:$seq"
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
            requestedMode = word(change, "requestedMode"),
            reason = word(change, "reason"),
        )
    }

    const val CORRECTION_FAILED = "permission_mode_correction_failed"

    /** Every refused correction among [events], oldest first. */
    fun refusals(events: List<RunEvent>): List<PermissionModeRefusal> = events.mapNotNull { event ->
        if (event.type != "system" || word(event.fields, "subtype") != CORRECTION_FAILED) return@mapNotNull null
        PermissionModeRefusal(event.seq, event.ts.orEmpty(), word(event.fields, "mode") ?: return@mapNotNull null,
            word(event.fields, "requested") ?: AUTO, word(event.fields, "reason")?.trim().orEmpty())
    }

    /** The seq of a refusal read off the session detail, which names no event: it is never a transcript line of its own. */
    const val DETAIL_SEQ = -1L

    /** The detail's newest refused correction while it still answers the newest change (`permissionModeCorrectionRefusal`, migration
     * 1821); null once a later change supersedes it, and from an older server. */
    fun detailRefusal(o: JsonObject): PermissionModeRefusal? {
        val r = o["permissionModeCorrectionRefusal"] as? JsonObject ?: return null
        return PermissionModeRefusal(DETAIL_SEQ, word(r, "at") ?: return null, word(r, "mode") ?: return null,
            word(r, "requestedMode") ?: AUTO, (r["reason"] as? JsonPrimitive)?.contentOrNull?.trim().orEmpty())
    }

    private fun word(o: JsonObject, key: String): String? =
        (o[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.takeIf { it.isNotEmpty() }
}
