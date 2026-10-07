package io.orbitd.android.tasks

import io.orbitd.android.core.auth.AuthSession
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.taskprojects.FeatureWrites
import kotlinx.serialization.json.*

/** The Tasks reads and writes OrbitKit's APIClient makes, over A03's handle. The server owns every
 * transition; `writable` is A04's live account state, read at the moment a write is sent. */
class TaskApi(private val api: AuthSession, private val handle: SessionHandle, writable: () -> Boolean = { true }) {
    val server = handle.account.server
    private val writes = FeatureWrites(api, handle, writable)

    suspend fun read(path: List<String>, query: List<Pair<String, String>> = emptyList()): JsonElement =
        Wire.decode(api.request(handle, ApiRequest(path, query = query)).body, JsonElement.serializer())
    private suspend fun readObject(path: List<String>, query: List<Pair<String, String>> = emptyList()) = read(path, query) as JsonObject

    /** `revision` names what the press was made over: an uncertain answer fences that revision only. */
    suspend fun write(path: List<String>, method: HttpMethod = HttpMethod.POST, body: JsonObject? = null, revision: String = "",
        resends: Int = 0): JsonElement? {
        // A new trigger must not turn an uncertain Run press into a second request on the same row.
        val identity = body?.let { JsonObject(it.filterKeys { key -> key != "triggerId" }) }
        return writes.execute("tasks:$revision:$method:${path.joinToString("/")}:$identity",
            ApiRequest(path, method, body = body?.toString()?.encodeToByteArray()), resends)
    }

    // Lists
    suspend fun page(query: TaskQuery, cursor: String? = null) = readObject(listOf("tasks", "page"), query.page(cursor))
    suspend fun counts(query: TaskQuery) = readObject(listOf("tasks", "counts"), query.scope())
    suspend fun active(query: TaskQuery) = readObject(listOf("tasks", "active"), query.listScope())
    suspend fun labels(query: TaskQuery) = readObject(listOf("tasks", "labels"), query.listScope())
    suspend fun lists(): List<JsonObject> = (read(listOf("task-lists")) as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
    suspend fun listHeader(id: String) = readObject(listOf("task-lists", id), listOf("tasks" to "none"))
    /** The No list count: one row of the outside-projects scope, its total only. */
    suspend fun unlistedCount(): Int = readObject(listOf("tasks", "page"),
        listOf("limit" to "1", "listId" to "none", "projectId" to "none", "counts" to "total")).number("total") ?: 0
    /** A list's steering session, resolved or created by the server: the same conversation every time. */
    suspend fun console(listId: String): String {
        val response = Wire.decode(api.request(handle, ApiRequest(listOf("task-lists", listId, "console"), HttpMethod.POST,
            body = "{}".encodeToByteArray())).body, JsonObject.serializer())
        return response.text("sessionId") ?: error("Orbit didn't return the list's steering session.")
    }

    // One task
    suspend fun detail(id: String) = readObject(listOf("tasks", id))
    suspend fun attribution(id: String) = readObject(listOf("tasks", id, "attribution"))
    /** Asked the way the browser's panel asks: both directions, up to 500 tasks, unary chains paired. */
    suspend fun dependencyGraph(id: String) = readObject(listOf("tasks", id, "dependency-graph"),
        listOf("direction" to "both", "maxNodes" to "500", "pairUnary" to "true"))
    suspend fun ownerConfirmation(id: String) = readObject(listOf("tasks", id, "owner-confirmation"))
    /** Server-searched prerequisite candidates: the browser's bounded 50-row picker, every scope. */
    suspend fun candidates(query: String) = readObject(listOf("tasks", "page"),
        listOfNotNull("limit" to "50", query.trim().takeIf { it.isNotEmpty() }?.let { "q" to it }, "counts" to "none")).objects("items")
    suspend fun watches(): List<JsonObject> = (read(listOf("watches")) as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
    suspend fun share(id: String) = readObject(listOf("tasks", id, "share"))

    suspend fun update(id: String, fields: JsonObject, revision: String) = write(listOf("tasks", id), HttpMethod.PATCH, fields, revision)
    /** One press, one name: the same `triggerId` rides every resend of it. */
    suspend fun execute(id: String, triggerId: String, revision: String) =
        write(listOf("tasks", id, "execute"), body = buildJsonObject { put("triggerId", triggerId) }, revision = revision, resends = 3)
    suspend fun reopen(id: String, revision: String) = update(id, TaskReopen.request(), revision)
    suspend fun delete(id: String, revision: String) = write(listOf("tasks", id), HttpMethod.DELETE, revision = revision)
    suspend fun addComment(id: String, body: String, mentions: List<String>, revision: String) = write(listOf("tasks", id, "comments"),
        body = buildJsonObject { put("body", body.trim()); if (mentions.isNotEmpty()) putJsonArray("mentions") { mentions.forEach { add(it) } } },
        revision = revision)
    suspend fun addDependency(id: String, prerequisite: String, revision: String) = write(listOf("tasks", id, "dependencies"),
        body = buildJsonObject { put("dependsOnTaskId", prerequisite) }, revision = revision)
    suspend fun removeDependency(id: String, prerequisite: String, revision: String) =
        write(listOf("tasks", id, "dependencies", prerequisite), HttpMethod.DELETE, revision = revision)
    suspend fun removeInput(attachment: String, revision: String) = write(listOf("attachments", attachment), HttpMethod.DELETE, revision = revision)

    /** The panel's own Confirm done answers no run. Re-read first: a run that started waiting after
     * the panel was drawn is answered on its card, never here. */
    suspend fun confirmOwner(id: String, revision: String) {
        val current = ownerConfirmation(id)
        check(OwnerConfirmations.panelAction(current, buildJsonObject {}) == OwnerPanelAction.Confirm) {
            "A run of this task is waiting for your confirmation. Open its card to answer it."
        }
        write(listOf("tasks", id, "owner-confirmation"), body = OwnerConfirmations.panelRequest(), revision = revision)
    }

    suspend fun follow(id: String, predicate: JsonObject, ttlSeconds: Int, idempotencyKey: String): JsonObject? =
        write(listOf("watches"), body = buildJsonObject {
            put("predicateVersion", 1); put("predicate", predicate)
            putJsonArray("targets") { add(buildJsonObject { put("kind", "TASK"); put("id", id) }) }
            put("action", "NOTIFY_USER"); put("ttlSeconds", ttlSeconds); put("idempotencyKey", idempotencyKey)
        }, revision = idempotencyKey) as? JsonObject

    // Several at once (Select Tasks). The bulk endpoints check each task again and answer per item.
    suspend fun batch(action: TaskBatchAction, ids: List<String>, triggerId: String, assignee: String? = null, revision: String): JsonElement? {
        val path = when (action) {
            TaskBatchAction.RUN -> "batch-execute"; TaskBatchAction.STOP -> "batch-stop"
            TaskBatchAction.ASSIGN -> "batch-assign"; TaskBatchAction.DELETE -> "batch-delete"
        }
        return write(listOf("tasks", path), body = buildJsonObject {
            putJsonArray("taskIds") { ids.forEach { add(it) } }
            if (action == TaskBatchAction.RUN) { put("maxConcurrent", TaskListCopy.batchConcurrency(ids.size)); put("triggerId", triggerId) }
            if (action == TaskBatchAction.ASSIGN) put("assigneeId", assignee?.let(::JsonPrimitive) ?: JsonNull)
        }, revision = revision, resends = if (action == TaskBatchAction.RUN) 3 else 0)
    }

    companion object {
        /** The server takes at most this many ids in one bulk request (`BatchExecuteDto`). */
        const val BATCH_LIMIT = 200
    }
}

/** One Tasks scope and its query, as `TasksModel.queryKey` names it. */
data class TaskQuery(val listId: String? = null, val filter: TaskFilter = TaskFilter.ALL, val search: String = "",
    val labels: List<String> = emptyList(), val creatorSessionId: String? = null) {
    val projectId get() = TaskListLogic.projectScope(listId, creatorSessionId)
    /** `/tasks/counts`: the scope, creator and labels — never the tab or the search. */
    fun scope(): List<Pair<String, String>> = buildList {
        listId?.let { add("listId" to it) }
        creatorSessionId?.let { add("creatorSessionId" to it) }
        projectId?.let { add("projectId" to it) }
        labels.forEach { add("labels" to it) }
    }
    /** `/tasks/active` and `/tasks/labels`: the list and project scope only. */
    fun listScope(): List<Pair<String, String>> = listOfNotNull(listId?.let { "listId" to it }, projectId?.let { "projectId" to it })
    /** A bounded page; its counts come from `/tasks/counts`, so the page asks for none. */
    fun page(cursor: String? = null): List<Pair<String, String>> = buildList {
        add("limit" to "200")
        cursor?.let { add("cursor" to it) }
        filter.wire?.let { add("status" to it) }
        listId?.let { add("listId" to it) }
        creatorSessionId?.let { add("creatorSessionId" to it) }
        projectId?.let { add("projectId" to it) }
        labels.forEach { add("labels" to it) }
        search.trim().takeIf { it.isNotEmpty() }?.let { add("q" to it) }
        add("counts" to "none")
    }
}
