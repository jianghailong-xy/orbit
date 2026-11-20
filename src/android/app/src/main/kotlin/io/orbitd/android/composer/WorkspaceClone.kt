package io.orbitd.android.composer

import io.orbitd.android.navigation.ObjectId
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlin.math.roundToInt

/**
 * A GitHub workspace's clone (docs/github-workspace-design.md §5.4, §8): the port of web's `lib/workspaceClone.ts` and OrbitKit's
 * `WorkspaceClone.swift`. The state is the workspace's own column, read with the session detail; git's percentage is relayed by the
 * realtime stream (`agent.changed` with `clone`) and stored nowhere, so it lives in [CloneLedger], for as long as the app runs.
 */
enum class CloneState(val wire: String) {
    PENDING("PENDING"), CLONING("CLONING"), READY("READY"), FAILED("FAILED");

    companion object {
        fun of(raw: String?): CloneState? = entries.firstOrNull { it.wire == raw }
    }
}

/** A clone as the app last heard it. [atMs] is when it was heard, to weigh it against a detail read since. */
data class CloneHeard(val state: CloneState, val progress: Int? = null, val atMs: Long? = null)

/** Why a clone failed, said as the person can act on it (board 01, P5 frames). */
enum class CloneFailure { FOLDER_TAKEN, APP_REMOVED, SIGN_IN_EXPIRED, OTHER }

object WorkspaceClone {
    /** The workspace a session detail's conversation runs in: the one it made, when it made one. */
    fun workspaceOf(detail: JsonObject?): String? {
        detail ?: return null
        fun text(o: JsonObject?, key: String) = (o?.get(key) as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotEmpty() }
        return text(detail["agent"] as? JsonObject, "id") ?: text(detail["workspace"] as? JsonObject, "id")
            ?: text(detail, "agentId") ?: text(detail, "workspaceId")
    }

    /** A relay's `clone` payload, or null for anything else. The percentage is held to 0…100, whole. */
    fun cloneOf(value: JsonElement?): CloneHeard? {
        val fields = value as? JsonObject ?: return null
        val state = CloneState.of((fields["state"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull) ?: return null
        val number = (fields["progress"] as? JsonPrimitive)?.takeUnless { it.isString }?.doubleOrNull
        val progress = number?.takeIf { it.isFinite() }?.roundToInt()?.coerceIn(0, 100)
        return CloneHeard(state, progress)
    }

    /**
     * The workspace and clone a realtime frame reports, or null for any other frame. The server's `agent.changed` names the workspace
     * as `agentId` (its older name); `id` is read for a frame that says so, and the envelope's own `agentId` last.
     */
    fun event(type: String, data: JsonObject?, envelopeAgentId: String? = null): Pair<String, CloneHeard>? {
        if (type != "agent.changed" && !type.startsWith("workspace.")) return null
        val fields = data ?: return null
        fun string(key: String) = (fields[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.takeIf { it.isNotEmpty() }
        val id = string("agentId") ?: string("id") ?: envelopeAgentId?.takeIf { it.isNotEmpty() } ?: return null
        val clone = cloneOf(fields["clone"]) ?: return null
        return id to clone
    }

    /** One spelling for a workspace id, whichever the frame or the payload used (a UUID or its public Base62). */
    fun keyOf(workspaceId: String): String = ObjectId.canonical(workspaceId) ?: workspaceId

    /** Whether two spellings of a workspace id name the same workspace. */
    fun sameWorkspace(a: String?, b: String?): Boolean =
        !a.isNullOrEmpty() && !b.isNullOrEmpty() && keyOf(a) == keyOf(b)

    /**
     * Where a clone stands, from what the server stored (the detail's `cloneState`, read at [storedAtMs]) and what the stream said.
     * Agreeing, the stream adds git's percentage. Disagreeing, the newer one wins: the stream is ahead of a detail read before it (a
     * Retry's PENDING, a clone that just ended), and a detail read after it is ahead of the stream (a frame the app missed). A stored
     * READY is an end nothing walks back.
     */
    fun now(stored: String?, live: CloneHeard?, storedAtMs: Long? = null): CloneHeard? {
        val state = CloneState.of(stored) ?: return live
        val fromStore = CloneHeard(state)
        if (live == null || state == CloneState.READY) return fromStore
        if (live.state == state) return live
        if (storedAtMs != null && (live.atMs ?: Long.MIN_VALUE) <= storedAtMs) return fromStore
        return live
    }

    private val githubRepo = Regex("""^https://github\.com/([^/]+/[^/]+?)(?:\.git)?/?$""")

    /** `https://github.com/<owner>/<name>.git` → `owner/name`; null for anything else. */
    fun repositoryOf(repoUrl: String?): String? = repoUrl?.let { githubRepo.find(it)?.groupValues?.get(1) }

    /**
     * The three failures v1 names (board 01 note 14), read by pattern from the runner's or the server's English words; anything else is
     * git's own words, shown as they are.
     */
    fun failureOf(error: String?): CloneFailure {
        val said = error.orEmpty().lowercase()
        return when {
            "already exists on " in said -> CloneFailure.FOLDER_TAKEN
            "github app is no longer installed" in said -> CloneFailure.APP_REMOVED
            "connect github in settings" in said -> CloneFailure.SIGN_IN_EXPIRED
            else -> CloneFailure.OTHER
        }
    }

    /** A failure's reason as the line ends it: trimmed, with one full stop. Empty while the reason hasn't been read. */
    fun reason(error: String?): String {
        val said = error.orEmpty().trim()
        if (said.isEmpty()) return ""
        return if (said.endsWith(".")) said else "$said."
    }
}

/** What the stream said about each workspace's clone, keyed in one spelling of its id. */
class CloneLedger {
    private val heard = MutableStateFlow<Map<String, CloneHeard>>(emptyMap())
    /** Everything heard, for a view to draw from as it changes. */
    val all: StateFlow<Map<String, CloneHeard>> = heard.asStateFlow()

    /**
     * Record what the stream said. Answers whether its STATE moved (as opposed to its percentage alone), which is when what the server
     * stores — the detail's cloneState — has to be read again. A percentage with no state change keeps the last one heard when it names
     * none.
     */
    fun hear(workspaceId: String, clone: CloneHeard, atMs: Long = System.currentTimeMillis()): Boolean {
        val key = WorkspaceClone.keyOf(workspaceId)
        var before: CloneHeard? = null
        heard.update { map ->
            before = map[key]
            val progress = clone.progress ?: before?.takeIf { it.state == clone.state }?.progress
            map + (key to CloneHeard(clone.state, progress, atMs))
        }
        return before?.state != clone.state
    }

    /**
     * An account event off the control stream: a clone frame is recorded, and the answer is whether the open conversation's detail has
     * to be read again — its clone's STATE moved and that conversation made the workspace ([openWorkspaceId]). A percentage alone reads
     * nothing again.
     */
    fun hearFrame(type: String, data: JsonObject?, envelopeAgentId: String?, openWorkspaceId: String?,
                  atMs: Long = System.currentTimeMillis()): Boolean {
        val (workspaceId, clone) = WorkspaceClone.event(type, data, envelopeAgentId) ?: return false
        return hear(workspaceId, clone, atMs) && WorkspaceClone.sameWorkspace(openWorkspaceId, workspaceId)
    }

    fun heard(workspaceId: String?): CloneHeard? =
        workspaceId?.takeIf { it.isNotEmpty() }?.let { heard.value[WorkspaceClone.keyOf(it)] }

    /** Forget everything heard: a sign-out, or a test. */
    fun clear() { heard.value = emptyMap() }
}
