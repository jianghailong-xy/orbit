package io.orbitd.android.projects

import io.orbitd.android.core.auth.AuthSession
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.taskprojects.FeatureWriteRefused
import io.orbitd.android.taskprojects.FeatureWriteUncertain
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

    private suspend fun send(key: String, path: List<String>, method: HttpMethod = HttpMethod.POST, body: JsonObject? = null, resends: Int = 0): JsonElement? =
        writes.execute("project:$key:$method:${path.joinToString("/")}:$body", ApiRequest(path, method, body = body?.toString()?.encodeToByteArray()), resends)

    suspend fun setStatus(id: String, status: String, revision: String) = send(revision, listOf("projects", id), HttpMethod.PATCH, buildJsonObject { put("status", status) })
    suspend fun authorize(id: String, body: JsonObject) = send(body.text("expectedConfigRevision").orEmpty(), listOf("projects", id), HttpMethod.PATCH, body)
    suspend fun updateIntegration(id: String, body: JsonObject, revision: String) = send(revision, listOf("projects", id, "integration"), HttpMethod.PATCH, body)
    suspend fun pause(id: String, paused: Boolean, revision: String) = send(revision, listOf("projects", id, if (paused) "pause" else "resume"))
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

/** `APIClient.failureReason`: the server's own sentence when it wrote one. */
fun failureReason(error: Throwable): String = when {
    error is ApiError && error.messages.isNotEmpty() -> error.messages.first()
    error is ApiError && error.status == 403 -> "You don't have permission to do that"
    error is ApiError && error.status == 404 -> "It no longer exists"
    error is ApiError -> "the server answered ${error.status}"
    error is FeatureWriteUncertain || error is FeatureWriteRefused -> error.message.orEmpty().trimEnd('.')
    else -> "check your connection"
}
