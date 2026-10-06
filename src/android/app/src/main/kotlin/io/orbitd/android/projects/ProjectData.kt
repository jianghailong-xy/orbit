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

enum class ProjectLane(val title: String) { ATTENTION("Needs attention"), RUNNING("Running"), READY("Ready"), WAITING("Waiting"), DEFINITION("Needs definition"), COMPLETED("Completed"), OTHER("Other") }

/** Presentation rules from OrbitKit ProjectAttention; none of these grant an action. */
fun projectLane(project: JsonObject, now: Instant = Instant.now()): ProjectLane {
    if (project.text("status") != "OPEN") return if (project.text("status") in setOf("DONE", "CANCELLED")) ProjectLane.COMPLETED else ProjectLane.OTHER
    val buckets = project.obj("buckets") ?: JsonObject(emptyMap())
    val attention = project.obj("attention")
    val hasOwner = attention?.objects("ownerItems").orEmpty().any { (it.number("count") ?: 0) > 0 }
        || attention?.obj("startRequest") != null
    val automaticBlockers = (attention?.number("coordinatorBlockers") ?: 0) + (attention?.number("systemBlockers") ?: 0)
    if (hasOwner || automaticBlockers > 0 || (attention?.number("userBlockers") ?: 0) > 0) return ProjectLane.ATTENTION
    val active = (project.obj("integration")?.number("activeJobCount") ?: 0) > 0 || project.obj("coordinatorActivity")?.flag("working") == true
    val quiet = project.text("lastActivityAt")?.let { runCatching { Duration.between(Instant.parse(it), now).seconds >= 86400 }.getOrDefault(false) } == true
    val running = buckets.number("running") ?: 0
    val ready = buckets.number("ready") ?: 0
    if (active || running > 0 && !quiet) return ProjectLane.RUNNING
    if (quiet && (running > 0 || ready > 0)) return ProjectLane.ATTENTION
    val failed = buckets.number("failed") ?: ((project.obj("_count")?.number("tasks") ?: 0) - listOf("running", "ready", "blocked", "awaitingVerification", "done", "cancelled").sumOf { buckets.number(it) ?: 0 }).coerceAtLeast(0)
    val coordinatorHandling = attention?.obj("coordinatorItems") != null
    val unsettled = running + ready + (buckets.number("blocked") ?: 0) + (buckets.number("awaitingVerification") ?: 0) + failed
    if (!coordinatorHandling && unsettled == 0 && (buckets.number("done") ?: 0) + (buckets.number("cancelled") ?: 0) > 0) return ProjectLane.ATTENTION
    if (coordinatorHandling && ready == 0) return ProjectLane.WAITING
    if ((project.obj("_count")?.number("tasks") ?: 0) == 0) return ProjectLane.DEFINITION
    if (ready > 0) return ProjectLane.READY
    if ((buckets.number("blocked") ?: 0) + (buckets.number("awaitingVerification") ?: 0) + failed > 0) return ProjectLane.WAITING
    return ProjectLane.DEFINITION
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

/** OrbitKit attention ordering: owner wait, reason/severity, oldest signal; ids break ties. */
fun orderedProjects(rows: List<JsonObject>, lane: ProjectLane, now: Instant = Instant.now()): List<JsonObject> {
    fun instant(raw: String?) = raw?.let { runCatching { Instant.parse(it) }.getOrNull() }
    fun oldest(a: String?, b: String?) = compareValues(instant(a) ?: Instant.MAX, instant(b) ?: Instant.MAX)
    fun ownerSince(row: JsonObject): String? {
        val attention = row.obj("attention") ?: return null
        return (attention.objects("ownerItems").mapNotNull { it.text("oldestWaitingSince") } + listOfNotNull(attention.obj("startRequest")?.text("waitingSince")))
            .minByOrNull { instant(it) ?: Instant.MAX }
    }
    fun reason(row: JsonObject): Int {
        val attention = row.obj("attention")
        if (attention?.objects("ownerItems").orEmpty().any { (it.number("count") ?: 0) > 0 } || attention?.obj("startRequest") != null) return 1
        if ((attention?.number("coordinatorBlockers") ?: 0) + (attention?.number("systemBlockers") ?: 0) > 0) return 3
        if ((attention?.number("userBlockers") ?: 0) > 0) return 2
        val quiet = instant(row.text("lastActivityAt"))?.let { Duration.between(it, now).seconds >= 86400 } == true
        if (quiet && (row.obj("buckets")?.number("running") ?: 0) > 0) return 4
        if (quiet && (row.obj("buckets")?.number("ready") ?: 0) > 0) return 5
        return if (attention?.obj("coordinatorItems") != null) 7 else 6
    }
    fun severity(row: JsonObject) = when (row.obj("attention")?.text("maxSeverity")) { "CRITICAL" -> 0; "WARNING" -> 1; "INFO" -> 2; else -> 3 }
    return rows.sortedWith { a, b ->
        val comparison = when (lane) {
            ProjectLane.ATTENTION -> {
                val left = reason(a); val right = reason(b)
                val rank = left.compareTo(right)
                val wait = if (left == 1 && right == 1) oldest(ownerSince(a), ownerSince(b)) else 0
                val severity = if (left == right && left in setOf(2, 3)) severity(a).compareTo(severity(b)) else 0
                val age = if (left == right && left in setOf(2, 3)) oldest(a.obj("attention")?.text("attentionSinceAt"), b.obj("attention")?.text("attentionSinceAt")) else 0
                listOf(rank, wait, severity, age, oldest(a.text("lastActivityAt"), b.text("lastActivityAt"))).firstOrNull { it != 0 } ?: 0
            }
            ProjectLane.RUNNING, ProjectLane.COMPLETED -> compareValues(instant(b.text("lastActivityAt")) ?: Instant.MIN, instant(a.text("lastActivityAt")) ?: Instant.MIN)
            ProjectLane.DEFINITION -> a.text("title").orEmpty().compareTo(b.text("title").orEmpty(), ignoreCase = true)
            else -> oldest(a.text("lastActivityAt"), b.text("lastActivityAt"))
        }
        if (comparison == 0) a.text("id").orEmpty().compareTo(b.text("id").orEmpty()) else comparison
    }
}
