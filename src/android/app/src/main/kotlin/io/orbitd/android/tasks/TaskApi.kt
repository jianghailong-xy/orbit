package io.orbitd.android.tasks

import io.orbitd.android.core.auth.AuthSession
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.taskprojects.FeatureWrites
import io.orbitd.android.taskprojects.FeatureWriteUncertain
import kotlinx.serialization.json.*

/** Uses the account epoch and relative paths supplied by A03; the server owns all task transitions. */
class TaskApi(private val api: AuthSession, private val handle: SessionHandle) {
    val server = handle.account.server
    private val writes = FeatureWrites(api, handle)
    var authorityRevision: String = ""
    suspend fun read(path: List<String>, query: List<Pair<String, String>> = emptyList()): JsonElement =
        Wire.decode(api.request(handle, ApiRequest(path, query = query)).body, JsonElement.serializer())
    suspend fun write(path: List<String>, method: HttpMethod = HttpMethod.POST, body: JsonObject? = null): JsonElement? {
        // A new UUID must not turn an uncertain Run press into a second request on the same row.
        val identity = body?.let { JsonObject(it.filterKeys { key -> key != "triggerId" }) }
        return writes.execute("tasks:$authorityRevision:$method:${path.joinToString("/")}:$identity",
            ApiRequest(path, method, body = body?.toString()?.encodeToByteArray()))
    }
    suspend fun page(filter: TaskQuery, cursor: String? = null): JsonObject =
        read(listOf("tasks", "page"), filter.parameters(cursor)) as JsonObject
    suspend fun detail(id: String) = read(listOf("tasks", id)) as JsonObject
    suspend fun row(id: String) = read(listOf("tasks", id, "row")) as JsonObject
    suspend fun update(id: String, fields: JsonObject) = write(listOf("tasks", id), HttpMethod.PATCH, fields)
    suspend fun execute(id: String, triggerId: String) = write(listOf("tasks", id, "execute"), body = buildJsonObject { put("triggerId", triggerId) })
    suspend fun reopen(id: String) = update(id, reopenRequest())
    suspend fun batch(action: String, ids: List<String>, triggerId: String? = null, concurrent: Int = 1, assignee: String? = null): JsonElement? {
        require(action in setOf("execute", "stop", "delete", "assign"))
        return write(listOf("tasks", "batch-$action"), body = buildJsonObject {
            putJsonArray("taskIds") { ids.forEach { add(it) } }
            if (action == "execute") { put("triggerId", requireNotNull(triggerId)); put("maxConcurrent", concurrent) }
            if (action == "assign") put("assigneeId", assignee?.let(::JsonPrimitive) ?: JsonNull)
        })
    }
    suspend fun ownerConfirmation(id: String) = read(listOf("tasks", id, "owner-confirmation")) as JsonObject
    suspend fun confirmWithoutRun(id: String) {
        // A run may have requested review after the panel was drawn. Never answer that card here.
        val current = ownerConfirmation(id)
        check(canConfirmWithoutRun(current)) { "A run is waiting for review. Refresh and open its review card." }
        write(listOf("tasks", id, "owner-confirmation"), body = buildJsonObject { put("decision", "CONFIRM"); put("requestId", JsonNull) })
    }
    suspend fun addComment(id: String, body: String) = write(listOf("tasks", id, "comments"), body = buildJsonObject { put("body", body.trim()) })
    suspend fun addDependency(id: String, prerequisite: String) = write(listOf("tasks", id, "dependencies"), body = buildJsonObject { put("dependsOnTaskId", prerequisite) })
    suspend fun removeDependency(id: String, prerequisite: String) = write(listOf("tasks", id, "dependencies", prerequisite), HttpMethod.DELETE)
    suspend fun console(id: String): String {
        val response = write(listOf("task-lists", id, "console"))
        return (response as? JsonObject)?.text("sessionId") ?: error("Orbit didn't return the list conversation.")
    }
    companion object {
        fun reopenRequest() = buildJsonObject { put("status", "OPEN"); put("supersededByTaskId", JsonNull); put("terminalReason", JsonNull) }
        fun canConfirmWithoutRun(view: JsonObject): Boolean = view.text("completionCriterion") == "OWNER_CONFIRMED" &&
            view.text("status") in setOf("OPEN", "IN_PROGRESS", "FAILED") && view.containsKey("waiting") && view["waiting"] == JsonNull
    }
}

data class TaskQuery(val listId: String? = null, val status: String = "", val query: String = "", val labels: List<String> = emptyList(),
    val assignee: String? = null, val creatorSession: String? = null) {
    fun scope(): List<Pair<String, String>> = buildList {
        listId?.let { add("listId" to it) }
        if ((listId == null || listId == "none") && creatorSession == null) add("projectId" to "none")
        assignee?.let { add("assigneeId" to it) }
        creatorSession?.let { add("creatorSessionId" to it) }
        labels.forEach { add("labels" to it) }
    }
    fun parameters(cursor: String? = null): List<Pair<String, String>> = scope() + buildList {
        add("limit" to "100")
        if (status.isNotBlank()) add("status" to status)
        if (query.isNotBlank()) add("q" to query.trim())
        if (cursor != null) { add("cursor" to cursor); add("counts" to "none") }
    }
}

fun taskStatus(row: JsonObject): String = when {
    row.flag("running") -> "Running"
    row.flag("queued") -> "Queued"
    else -> row.text("status")?.lowercase()?.replace('_', ' ')?.replaceFirstChar { it.uppercase() } ?: "Unknown"
}
fun taskPhrase(row: JsonObject): String? = when {
    row.flag("awaitingOwnerConfirmation") -> "Waiting for your confirmation"
    row.flag("confirmationUnderReview") -> "Under review"
    row.text("dependencyState") == "BLOCKED_FAILED" -> "Prerequisite failed or cancelled"
    row.flag("blocked") || row.text("dependencyState") == "BLOCKED" -> "Waiting for prerequisites"
    row.text("runAt") != null -> "Starts ${row.text("runAt")}" 
    else -> row.obj("assignee")?.text("name")
}
fun taskError(error: Throwable): String = when {
    error is ApiError && error.status == 403 -> "You don't have permission to access this task."
    error is ApiError && error.status == 404 -> "This task is no longer available."
    error is ApiError -> listOfNotNull(error.messages.firstOrNull() ?: "Orbit refused the request.", error.code,
        (error.body as? JsonObject)?.text("requiredAction")).joinToString("\n")
    error is FeatureWriteUncertain -> error.message ?: "Check the server record before trying again."
    error is NetworkException -> "Can't reach Orbit. Check your connection and refresh."
    error is IllegalStateException -> error.message ?: "This task changed. Refresh to continue."
    else -> "Couldn't load this task. Refresh to try again."
}

internal fun batchResultText(result: JsonObject?, titles: Map<String, String>): String = buildList {
    if (result == null) { add("Request accepted. Refresh to check the selected tasks."); return@buildList }
    listOf("dispatched" to "started", "stopped" to "stopped", "deleted" to "deleted", "updated" to "updated").forEach { (field, label) ->
        result.number(field)?.let { add("$it tasks $label") }
    }
    result.objects("skipped").forEach { item -> add("${item.text("title") ?: titles[item.text("id")] ?: "Task"}: ${item.text("reason") ?: "Skipped"}") }
    result.objects("failed").forEach { item -> add("${titles[item.text("id")] ?: "Task"}: ${item.text("error") ?: "Failed"}") }
    if (isEmpty()) add("Request accepted. Refresh to check the selected tasks.")
}.joinToString("\n")

/** Adapt the task graph's wire names to the shared native project graph renderer. */
internal fun taskGraphForDisplay(graph: JsonObject): JsonObject = buildJsonObject {
    graph.forEach { (key, value) -> put(key, value) }
    putJsonArray("marks") { graph.objects("nodes").forEach { node -> add(buildJsonObject {
        node.forEach { (key, value) -> put(key, value) }
        put("kind", "TASK"); node.text("id")?.let { put("taskId", it) }
    }) } }
    putJsonArray("edges") { graph.objects("edges").forEach { edge -> add(buildJsonObject {
        edge.forEach { (key, value) -> put(key, value) }
        edge.text("sourceTaskId")?.let { put("sourceMarkId", it) }
        edge.text("targetTaskId")?.let { put("targetMarkId", it) }
    }) } }
    put("taskCount", graph.objects("nodes").size)
    putJsonObject("limits") { graph.obj("limits")?.number("maxNodes")?.let { put("maxTasks", it) } }
}
