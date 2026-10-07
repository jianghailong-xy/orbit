package io.orbitd.android.projects

import io.orbitd.android.core.cards.*
import io.orbitd.android.directory.DirectoryApi
import io.orbitd.android.directory.directoryError
import io.orbitd.android.core.net.ApiError
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.json.*
import java.time.Duration
import java.time.Instant

/** Optional sections fail independently; permission loss on the document clears the page. */
data class ProjectPageData(val document: JsonObject, val sections: Map<String, JsonObject>, val errors: Map<String, String>) {
    val tasks get() = sections["tasks"]?.objects("items").orEmpty()
    val nextCursor get() = sections["tasks"]?.text("nextCursor")
}

class ProjectsApi(private val api: DirectoryApi) {
    suspend fun index(): List<JsonObject> = (api.read(listOf("projects"), JsonArray.serializer())).filterIsInstance<JsonObject>()
    suspend fun page(id: String, taskLimit: Int = 100): ProjectPageData {
        val document = api.objectRead(listOf("projects", id))
        return coroutineScope {
            val paths = mapOf("panorama" to listOf("panorama"), "integration" to listOf("integration"),
                "openItems" to listOf("open-items"), "coordinator" to listOf("coordinator", "status"),
                "graph" to listOf("dependency-graph"), "ready" to listOf("panorama", "ready"),
                "confirmation" to listOf("acceptance", "confirmation"), "tasks" to listOf("tasks", "page"))
            val replies = paths.map { (name, path) -> async {
                try { Triple(name, if (name == "tasks") taskWindow(id, taskLimit) else api.objectRead(listOf("projects", id) + path), null) }
                catch (cancel: CancellationException) { throw cancel }
                catch (failure: Exception) {
                    if (failure is ApiError && failure.status in setOf(401, 403)) throw failure
                    Triple(name, null, directoryError(failure))
                }
            } }.map { it.await() }
            ProjectPageData(document, replies.mapNotNull { (key, body, _) -> body?.let { key to it } }.toMap(),
                replies.mapNotNull { (key, _, error) -> error?.let { key to it } }.toMap())
        }
    }
    suspend fun taskPage(id: String, cursor: String? = null): JsonObject = api.read(listOf("projects", id, "tasks", "page"),
        JsonObject.serializer(), listOf("limit" to "100") + listOfNotNull(cursor?.let { "cursor" to it }))
    private suspend fun taskWindow(id: String, count: Int): JsonObject {
        val rows = mutableListOf<JsonObject>()
        var cursor: String? = null
        do {
            val page = taskPage(id, cursor)
            rows += page.objects("items")
            val next = page.text("nextCursor")
            check(next == null || next != cursor) { "Task cursor did not advance" }
            cursor = next
        } while (rows.size < count && cursor != null)
        return buildJsonObject { put("items", JsonArray(rows)); put("nextCursor", cursor?.let(::JsonPrimitive) ?: JsonNull) }
    }
}

fun projectStatus(document: JsonObject): String = when {
    document.text("status") == "OPEN" && document.containsKey("startedAt") && document["startedAt"] == JsonNull -> "Not started"
    document.text("status") == "DONE" -> "Completed"
    else -> document.text("status")?.lowercase()?.replaceFirstChar(Char::uppercase) ?: "Unknown"
}

val projectBuckets = linkedMapOf("running" to "Running", "ready" to "Ready", "blocked" to "Blocked",
    "awaitingVerification" to "Awaiting verification", "failed" to "Failed", "done" to "Done", "cancelled" to "Cancelled")

fun projectAuthorization(document: JsonObject, automatic: Boolean? = null, concurrency: Int? = null): JsonObject {
    require(automatic != null || concurrency != null)
    require(concurrency == null || concurrency in 1..100)
    val revision = requireNotNull(document.text("configRevision")) { "Reload the project to check its settings revision." }
    return buildJsonObject {
        put("expectedConfigRevision", revision)
        automatic?.let { put("automatic", it) }
        concurrency?.let { put("maxConcurrentTasks", it) }
    }
}

fun projectStartSettings(page: ProjectPageData): ProjectStartSettings {
    val integration = page.sections["integration"]
    val graph = page.sections["graph"]
    val live = graph?.objects("marks").orEmpty().filter { it.text("status") != "CANCELLED" }.mapNotNull { it.text("id") }.toSet()
    val dependencies = graph?.objects("marks").orEmpty().any { it.text("kind") == "RUN" } || graph?.objects("edges").orEmpty().any { it.text("sourceMarkId") in live && it.text("targetMarkId") in live }
    val line = integration?.text("line")?.takeIf { it in setOf("MAIN", "PROJECT_BRANCH") } ?: if (dependencies) "PROJECT_BRANCH" else "MAIN"
    return ProjectStartSettings(line, true, page.document.number("maxConcurrentTasks") ?: 1,
        integration?.text("mergeCheckCommand"), if (integration?.text("line") == "PROJECT_BRANCH") integration.text("ref")?.let { "refs/heads/$it" } else null)
}
