package io.orbitd.android.core.realtime

import io.orbitd.android.core.auth.OrbitApi
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.protocol.ProtocolException
import io.orbitd.android.core.protocol.Wire
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.EmptyCoroutineContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

/** [background] is where lists are decoded: the application's store runs on the main thread and passes another. */
internal class RealtimeRest(private val api: OrbitApi, private val background: CoroutineContext = EmptyCoroutineContext) {
    /** A read the server answers with null ("asking nothing", e.g. `promotions/current`) arrives as a 200 with no body. */
    private suspend fun get(handle: SessionHandle, path: List<String>, query: List<Pair<String, String>> = emptyList()): JsonElement {
        val body = api.request(handle, ApiRequest(path, query = query)).body
        return if (body.isEmpty()) JsonNull else Wire.decode(body, JsonElement.serializer())
    }

    /**
     * A list read row by row from the body, never as one string. A row equal to the row of [previous] with its id is that
     * row, so reading an unchanged directory again holds one copy of it, not two; new rows are compacted (Wire.objects).
     * A04c: an owner's thousands of sessions, read again on every account event, ran a release build out of heap once the
     * cache write no longer did.
     */
    private suspend fun objects(handle: SessionHandle, path: List<String>, query: List<Pair<String, String>> = emptyList(),
        previous: List<JsonObject>? = null): List<JsonObject> {
        val body = api.request(handle, ApiRequest(path, query = query)).body
        return withContext(background) {
            val known = previous.orEmpty().associateBy { it.text("id") }
            Wire.objects(body) { row -> known[row.text("id")]?.takeIf { it == row } }
        }
    }

    suspend fun directory(handle: SessionHandle, previous: DirectorySnapshot? = null): DirectorySnapshot = coroutineScope {
        val workspaces = async { objects(handle, listOf("workspaces"), previous = previous?.workspaces) }
        val folders = async { objects(handle, listOf("session-folders"), previous = previous?.folders) }
        val tags = async { objects(handle, listOf("session-tags"), previous = previous?.tags) }
        val runners = async { objects(handle, listOf("runners"), previous = previous?.runners) }
        val views = listOf("open", "completed", "trash").map { view ->
            async { view to objects(handle, listOf("sessions"), listOf("view" to view), previous?.sessions?.get(view)) }
        }
        DirectorySnapshot(workspaces.await(), views.awaitAll().toMap(), folders.await(), tags.await(), runners.await())
    }

    /** `after=` pages are 200 events, as on iOS and web: five of them are the server's SSE_GAP_CAP. */
    suspend fun page(handle: SessionHandle, id: String, after: Long? = null): EventPage {
        val query = listOf("maxPayload" to "2048") + if (after == null) listOf("tail" to "200")
            else listOf("after" to "$after", "limit" to "200")
        return Wire.decode(api.request(handle, ApiRequest(listOf("sessions", id, "events", "page"), query = query)).body,
            EventPage.serializer())
    }

    suspend fun session(handle: SessionHandle, id: String): SessionSnapshot = coroutineScope {
        val base = listOf("sessions", id)
        val approvals = async { objects(handle, base + "approvals", listOf("status" to "PENDING")) }
        // The active view (A07-14; iOS 0588fe262, web `listQueuedTurns`): the bare one is the queue alone and leaves out the head a
        // runner has taken but not echoed yet, so that turn vanished from the reader until its echo.
        val queue = async { objects(handle, base + "turns", listOf("view" to "active")) }
        val background = async { objects(handle, base + "background") }
        val evidence = async { get(handle, listOf("tasks", "evidence-decisions", "pending"), listOf("decidingSessionId" to id)) }
        val detail = get(handle, base) as? JsonObject ?: throw ProtocolException()
        val standing = mutableMapOf("evidenceDecisions" to evidence.await())
        detail.text("taskId")?.let { task ->
            standing["ownerConfirmation"] = get(handle, listOf("tasks", task, "owner-confirmation"))
        }
        val project = detail.text("projectId") ?: (detail["project"] as? JsonObject)?.text("id")
        if (project != null) {
            val paths = mapOf(
                "criteriaDecisions" to listOf("acceptance", "criteria-decisions", "pending"),
                "acceptanceConfirmation" to listOf("acceptance", "confirmation"),
                "project" to emptyList(), "openItems" to listOf("open-items"),
                "promotion" to listOf("promotions", "current"),
            )
            paths.map { (key, path) -> async { key to get(handle, listOf("projects", project) + path) } }
                .awaitAll().forEach { (key, value) -> standing[key] = value }
            // The start card's Main branch row: the project's repository, the branches it can be chosen from and this account's last
            // choice there. Read only while nobody has started the project — the one time a start card can ask — so the card is
            // drawn with it rather than drawn on main and moved. A read that fails draws no row, and the start keeps the main
            // branch the project stands on.
            val document = standing["project"] as? JsonObject
            // And for a candidate a check BLOCKED, what the line is doing about its branch (iOS befc9694c): one of the project's current
            // landings may be holding the merge, and the review names it — "Blocked by". The same read, failing the same way.
            val blocked = (standing["promotion"] as? JsonObject)?.text("state") == "BLOCKED"
            if ((document != null && document["startedAt"] is JsonNull) || blocked) try {
                standing["integration"] = get(handle, listOf("projects", project, "integration"))
            } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { }
        }
        SessionSnapshot(detail, approvals.await(), queue.await(), background.await(), standing)
    }
}
