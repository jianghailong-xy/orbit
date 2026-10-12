package io.orbitd.android.core.realtime

import io.orbitd.android.core.auth.OrbitApi
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.protocol.ProtocolException
import io.orbitd.android.core.protocol.Wire
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

internal class RealtimeRest(private val api: OrbitApi) {
    /** A read the server answers with null ("asking nothing", e.g. `promotions/current`) arrives as a 200 with no body. */
    private suspend fun get(handle: SessionHandle, path: List<String>, query: List<Pair<String, String>> = emptyList()): JsonElement {
        val body = api.request(handle, ApiRequest(path, query = query)).body
        return if (body.isEmpty()) JsonNull else Wire.decode(body, JsonElement.serializer())
    }

    private suspend fun objects(handle: SessionHandle, path: List<String>, query: List<Pair<String, String>> = emptyList()): List<JsonObject> =
        (get(handle, path, query) as? JsonArray)?.map { it as? JsonObject ?: throw ProtocolException() }
            ?: throw ProtocolException()

    suspend fun directory(handle: SessionHandle): DirectorySnapshot = coroutineScope {
        val workspaces = async { objects(handle, listOf("workspaces")) }
        val folders = async { objects(handle, listOf("session-folders")) }
        val tags = async { objects(handle, listOf("session-tags")) }
        val runners = async { objects(handle, listOf("runners")) }
        val views = listOf("open", "completed", "trash").map { view ->
            async { view to objects(handle, listOf("sessions"), listOf("view" to view)) }
        }
        DirectorySnapshot(workspaces.await(), views.awaitAll().toMap(), folders.await(), tags.await(), runners.await())
    }

    suspend fun page(handle: SessionHandle, id: String, after: Long? = null): EventPage {
        val query = listOf("maxPayload" to "2048") + if (after == null) listOf("tail" to "200")
            else listOf("after" to "$after", "limit" to "500")
        return Wire.decode(api.request(handle, ApiRequest(listOf("sessions", id, "events", "page"), query = query)).body,
            EventPage.serializer())
    }

    suspend fun session(handle: SessionHandle, id: String): SessionSnapshot = coroutineScope {
        val base = listOf("sessions", id)
        val approvals = async { objects(handle, base + "approvals", listOf("status" to "PENDING")) }
        val queue = async { objects(handle, base + "turns") }
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
            if (document != null && document["startedAt"] is JsonNull) try {
                standing["integration"] = get(handle, listOf("projects", project, "integration"))
            } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { }
        }
        SessionSnapshot(detail, approvals.await(), queue.await(), background.await(), standing)
    }
}
