package io.orbitd.android.projects

import io.orbitd.android.core.auth.AuthSession
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.ProtocolException
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.taskprojects.FeatureWriteRefused
import io.orbitd.android.taskprojects.FeatureWrites
import kotlinx.serialization.json.*

/** The project reads and writes OrbitKit's APIClient makes (`ProjectsModel`), over A03's handle.
 * Each section is its own read, so one that fails keeps what it last showed. */
class ProjectApi(private val auth: AuthSession, private val handle: SessionHandle, private val writable: () -> Boolean = { true }) {
    private val writes = FeatureWrites(auth, handle, writable)

    private suspend fun read(path: List<String>, query: List<Pair<String, String>> = emptyList()): JsonElement =
        Wire.decode(auth.request(handle, ApiRequest(path, query = query)).body, JsonElement.serializer())
    private suspend fun readObject(path: List<String>, query: List<Pair<String, String>> = emptyList()) = read(path, query) as JsonObject

    suspend fun index(): List<JsonObject> = (read(listOf("projects")) as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
    suspend fun document(id: String) = readObject(listOf("projects", id))
    suspend fun panorama(id: String) = readObject(listOf("projects", id, "panorama"))
    suspend fun integration(id: String) = readObject(listOf("projects", id, "integration"))
    suspend fun openItems(id: String) = readObject(listOf("projects", id, "open-items"))
    suspend fun coordinator(id: String) = readObject(listOf("projects", id, "coordinator", "status"))
    suspend fun graph(id: String) = readObject(listOf("projects", id, "dependency-graph"))
    suspend fun ready(id: String) = readObject(listOf("projects", id, "panorama", "ready"), listOf("limit" to "5"))
    suspend fun confirmation(id: String) = readObject(listOf("projects", id, "acceptance", "confirmation"))
    suspend fun share(id: String) = readObject(listOf("projects", id, "share"))
    /** Every crossing this project is an end of, in either direction (`GET /projects/:id/handoffs`). */
    suspend fun crossings(id: String) = ProjectCrossings.rows(read(listOf("projects", id, "handoffs"))) ?: throw ProtocolException()
    suspend fun tasks(id: String, cursor: String? = null, limit: Int = 200) = readObject(listOf("projects", id, "tasks", "page"),
        listOfNotNull("limit" to "$limit", cursor?.let { "cursor" to it }))
    /** The window a page already showed, read again from the top (`refreshedTaskWindow`). */
    suspend fun taskWindow(id: String, count: Int): Pair<List<JsonObject>, String?> {
        val items = mutableListOf<JsonObject>()
        var cursor: String? = null
        do {
            val page = tasks(id, cursor, minOf(200, count - items.size))
            items += page.objects("items")
            val next = page.text("nextCursor")
            if (next != null && next == cursor) break
            cursor = next
        } while (items.size < count && cursor != null)
        return items to cursor
    }

    private suspend fun send(key: String, path: List<String>, method: HttpMethod = HttpMethod.POST, body: JsonObject? = null, resends: Int = 0): JsonElement? {
        // A new trigger must not turn an uncertain Run press into a second request on the same row (as `TaskApi.write`).
        val identity = body?.let { JsonObject(it.filterKeys { field -> field != "triggerId" }) }
        return writes.execute("project:$key:$method:${path.joinToString("/")}:$identity", ApiRequest(path, method, body = body?.toString()?.encodeToByteArray()), resends)
    }

    /** The owner's done door: the seal read, the gaps accepted, the DONE_REQUEST answered or null. */
    suspend fun done(id: String, body: JsonObject) = send("done:${body.text("criteriaDigest")}:${body.text("requestId")}", listOf("projects", id, "done"), body = body) as? JsonObject
    /** "Not yet…" on the coordinator's request: the request ends, and the owner's note goes to the coordinator with the card's facts. */
    suspend fun declineDone(id: String, itemId: String, note: String) = send("decline:$itemId", listOf("projects", id, "done-requests", itemId, "decline"),
        body = buildJsonObject { put("note", note) })
    suspend fun setStatus(id: String, status: String, revision: String) = send(revision, listOf("projects", id), HttpMethod.PATCH, buildJsonObject { put("status", status) })
    suspend fun authorize(id: String, body: JsonObject) = send(body.text("expectedConfigRevision").orEmpty(), listOf("projects", id), HttpMethod.PATCH, body)
    suspend fun updateIntegration(id: String, body: JsonObject, revision: String) = send(revision, listOf("projects", id, "integration"), HttpMethod.PATCH, body)
    suspend fun pause(id: String, paused: Boolean, revision: String) = send(revision, listOf("projects", id, if (paused) "pause" else "resume"))
    /** One answer to a crossing, from its row's second press: the crossing key travels with it, so an answer given on a list that
     * changed since it was read is refused rather than recorded against another crossing. A yes to a move IS the move. The answer is
     * not read here: the list the page reads again says what it left. */
    suspend fun decideCrossing(id: String, row: JsonObject, approve: Boolean) = send("crossing:${row.text("crossingKey")}",
        listOf("projects", id, "handoffs", ProjectCrossings.doorId(row), "decision"), body = ProjectCrossings.request(row, approve))
    /** The owner's Retry on a landing job the integration read says can be retried: its silent generation ends and the next one is
     * queued. Answers the integration view read again. */
    suspend fun retryJob(id: String, jobId: String) = send("retry:$jobId", listOf("projects", id, "integration", "jobs", jobId, "retry")) as? JsonObject
    suspend fun start(id: String, body: JsonObject) = send(body.text("criteriaDigest").orEmpty(), listOf("projects", id, "start"), body = body)
    suspend fun delete(id: String) = send("delete", listOf("projects", id), HttpMethod.DELETE)
    suspend fun resumeFuse(id: String, episode: String) = send(episode, listOf("projects", id, "fuse", episode, "resume"))
    suspend fun resolveBlocker(id: String, blocker: String, reason: String) = send(blocker, listOf("projects", id, "blockers", blocker, "resolve"),
        body = buildJsonObject { put("reason", reason) })
    /** One press, one name: the same `triggerId` rides every resend. */
    suspend fun run(taskId: String, triggerId: String, revision: String) = send(revision, listOf("tasks", taskId, "execute"),
        body = buildJsonObject { put("triggerId", triggerId) }, resends = 3)
    suspend fun resumeList(listId: String) = send("resume", listOf("task-lists", listId), HttpMethod.PATCH,
        buildJsonObject { put("paused", false); put("note", ProjectPage.resumeListNote) })
    /** Resolve-or-create: the same conversation every time, so it is asked directly. */
    suspend fun openCoordinator(id: String): JsonObject {
        if (!writable()) throw FeatureWriteRefused()
        return Wire.decode(auth.request(handle, ApiRequest(listOf("projects", id, "coordinator"), HttpMethod.POST)).body, JsonObject.serializer())
    }
    suspend fun replaceCoordinator(id: String, revision: String) = send(revision, listOf("projects", id, "coordinator", "replace")) as? JsonObject
}

/** `APIClient.failureReason`: the server's own sentence when it wrote one (`ComposerLogic.serverMessage`). */
fun failureReason(error: Throwable): String = when (error) {
    is ApiError -> when {
        error.status == 401 -> "you're signed out"
        error.messages.isNotEmpty() -> error.messages.joinToString("\n")
        else -> (error.body as? JsonObject)?.text("error")?.takeIf { it.isNotEmpty() } ?: "the server returned ${error.status}"
    }
    // Android's own fences (FeatureWrites) and other refusals made on this device say so in their own words.
    is IllegalStateException -> error.message?.takeIf { it.isNotBlank() }?.trimEnd('.') ?: "the connection dropped"
    else -> "the connection dropped"
}
