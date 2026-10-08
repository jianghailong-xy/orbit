package io.orbitd.android.directory

import io.orbitd.android.core.auth.OrbitApi
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.net.NetworkException
import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.json.*

/** All operations retain A03's handle; no bearer, absolute URL or mock directory enters the UI. */
class DirectoryApi(private val api: OrbitApi, private val handle: SessionHandle) {
    suspend fun <T> read(path: List<String>, serializer: DeserializationStrategy<T>, query: List<Pair<String, String>> = emptyList()): T =
        Wire.decode(api.request(handle, ApiRequest(path, query = query)).body, serializer)

    suspend fun search(query: String): SearchResults = read(listOf("sessions", "search"), SearchResults.serializer(),
        listOf("q" to query, "limit" to "100"))
    suspend fun moveTargets(id: String): MoveTargets = read(listOf("sessions", id, "move-targets"), MoveTargets.serializer())
    suspend fun objectRead(path: List<String>): JsonObject = read(path, JsonObject.serializer())

    suspend fun mutate(path: List<String>, method: HttpMethod = HttpMethod.POST, body: JsonObject? = null): ByteArray =
        api.request(handle, ApiRequest(path, method, body = body?.toString()?.encodeToByteArray())).body
    suspend fun rename(id: String, name: String) { mutate(listOf("sessions", id), HttpMethod.PATCH, buildJsonObject { put("title", name.trim()) }) }
    suspend fun pin(id: String, pinned: Boolean) { mutate(listOf("sessions", id, "pin"), if (pinned) HttpMethod.POST else HttpMethod.DELETE) }
    suspend fun complete(id: String) { mutate(listOf("sessions", id, "complete")) }
    suspend fun restore(id: String) { mutate(listOf("sessions", id, "restore")) }
    suspend fun delete(id: String, permanent: Boolean) { mutate(listOf("sessions", id) + if (permanent) listOf("purge") else emptyList(), HttpMethod.DELETE) }
    suspend fun end(id: String) { mutate(listOf("sessions", id, "end")) }
    suspend fun move(id: String, workspace: String?, folder: String?) {
        mutate(listOf("sessions", id, "move"), body = buildJsonObject {
            put("folderId", folder?.let(::JsonPrimitive) ?: JsonNull)
            workspace?.let { put("workspaceId", it) }
        })
    }
    suspend fun createFolder(workspace: String, name: String) {
        mutate(listOf("session-folders"), body = buildJsonObject { put("workspaceId", workspace); put("name", name.trim()) })
    }
    suspend fun renameFolder(id: String, name: String) {
        mutate(listOf("session-folders", id), HttpMethod.PATCH, buildJsonObject { put("name", name.trim()) })
    }
    suspend fun deleteFolder(id: String) { mutate(listOf("session-folders", id), HttpMethod.DELETE) }
    suspend fun setTags(id: String, tags: Set<String>) {
        mutate(listOf("sessions", id, "tags"), HttpMethod.PUT, buildJsonObject { putJsonArray("tagIds") { tags.forEach { add(it) } } })
    }
    suspend fun createTag(name: String) {
        mutate(listOf("session-tags"), body = buildJsonObject { put("name", name.trim()); put("color", "#3B82F6") })
    }
}

fun directoryError(error: Throwable): String = when {
    error is ApiError && error.status == 403 -> "You don't have permission to access this item."
    error is ApiError && error.status == 404 -> "This item is no longer available."
    error is ApiError && error.status == 409 -> "This item changed. Refresh and try again."
    error is ApiError && error.status == 401 -> "Your access changed. Please try again."
    error is NetworkException -> "Can't reach Orbit. Check your connection and try again."
    else -> "Couldn't load this from Orbit. Please try again."
}

data class DirectoryData(
    val workspaces: List<DirectoryWorkspace> = emptyList(), val runners: List<DirectoryRunner> = emptyList(),
    val sessions: Map<String, List<DirectorySession>> = emptyMap(), val folders: List<Folder> = emptyList(),
    val tags: List<Tag> = emptyList(), val ready: Boolean = false, val fresh: Boolean = false, val refreshing: Boolean = false,
    val error: String? = null, val waitingForConnection: Boolean = false,
)
