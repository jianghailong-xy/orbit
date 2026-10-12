package io.orbitd.android.push

import io.orbitd.android.core.auth.OrbitApi
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.protocol.ProtocolException
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.navigation.ObjectId
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.*

enum class PushCheck { ACTIVE, STALE, MISSING, FORBIDDEN, UNKNOWN }

/** Push supplies identities only. Every decision here is read with the current authenticated handle. */
class PushAuthority(private val api: OrbitApi, private val handle: SessionHandle) {
    /** An unsuccessful/invalid read throws: an offline snapshot must never look like an empty set. */
    suspend fun needsYou(): Set<String> = array(get(listOf("sessions"), listOf("view" to "open")))
        .mapNotNull { row ->
            val id = canonical(row.text("id"))
            val pending = row.number("pendingApprovals")
            val ownerItems = row.optionalArray("ownerItems")
            if (open(row) && ((!row.present("cancelRequestedAt") && pending > 0 && row.text("waitingKind") != "START_REQUEST") ||
                ownerItems.isNotEmpty())) id else null
        }.toSet()

    suspend fun check(message: PushMessage): PushCheck = try {
        val payload = message.payload
        when {
            message.type == PushType.SYNC -> PushCheck.UNKNOWN
            payload.isOwnerItem -> ownerItem(payload)
            payload.kind == "approval" -> approval(payload)
            payload.kind == "watch-matched" -> {
                val row = objectRead(listOf("watches", payload.watchId!!))
                if (!ObjectId.same(row.text("id"), payload.watchId) || row.text("action") == null) throw ProtocolException()
                val matched = row.text("action") == "NOTIFY_USER" && array(row["matches"]).any {
                    it.number("generation") == payload.generation
                }
                if (matched) PushCheck.ACTIVE else PushCheck.STALE
            }
            payload.kind == "confirmation-problems" -> {
                val session = sessionRead(payload.sessionId!!)
                val row = objectRead(listOf("tasks", payload.taskId!!, "owner-confirmation"))
                val exists = array(row["decisions"]).any { decision ->
                    ObjectId.same(decision.text("sessionId"), payload.sessionId) &&
                        ObjectId.same(decision.obj("review")?.obj("problems")?.text("recordId"), payload.recordId)
                }
                if (session.present("deletedAt") || session.text("lifecycleState") == "TRASH") PushCheck.MISSING
                else if (exists) PushCheck.ACTIVE else PushCheck.STALE
            }
            payload.sessionId != null -> {
                val row = sessionRead(payload.sessionId)
                if (row.present("deletedAt")) PushCheck.MISSING
                else if (payload.kind in setOf("finished", "failed") &&
                    (row.text("status") != (if (payload.kind == "finished") "SUCCEEDED" else "FAILED") || row.present("retryAt") ||
                        (payload.kind == "failed" && row.present("completedAt")))) PushCheck.STALE
                else PushCheck.ACTIVE
            }
            payload.runnerId != null -> {
                val runner = array(get(listOf("runners"))).firstOrNull { ObjectId.same(it.text("id"), payload.runnerId) }
                if (runner == null) PushCheck.MISSING else {
                    val engine = runner.optionalArray("engines").firstOrNull { it.text("engine") == payload.engine }
                    when (engine?.text("auth")) { "no" -> PushCheck.ACTIVE; "yes" -> PushCheck.STALE; else -> PushCheck.UNKNOWN }
                }
            }
            payload.wikiSpaceId != null -> {
                val space = objectRead(listOf("wiki", "spaces", payload.wikiSpaceId))
                if (!ObjectId.same(space.text("id"), payload.wikiSpaceId)) throw ProtocolException()
                PushCheck.ACTIVE
            }
            payload.kind == "agent-message" -> {
                val user = objectRead(listOf("users", "me"))
                if (!ObjectId.same(user.text("id"), handle.account.userId)) throw ProtocolException()
                if (user.obj("preferences")?.get("notifyAgentMessage") == JsonPrimitive(false)) PushCheck.STALE else PushCheck.ACTIVE
            }
            else -> PushCheck.UNKNOWN
        }
    } catch (cancel: CancellationException) {
        throw cancel
    } catch (error: ApiError) {
        when (error.status) { 403 -> PushCheck.FORBIDDEN; 404, 410 -> PushCheck.MISSING; else -> PushCheck.UNKNOWN }
    } catch (_: Exception) {
        PushCheck.UNKNOWN
    }

    private suspend fun approval(payload: PushPayload): PushCheck {
        val row = sessionRead(payload.sessionId!!)
        if (!open(row) || row.present("cancelRequestedAt")) return PushCheck.STALE
        // This endpoint removes abandoned turn prompts and settled background-job prompts itself.
        val pending = array(get(listOf("sessions", payload.sessionId, "approvals"), listOf("status" to "PENDING")))
        if (pending.any { it.text("status") == null }) throw ProtocolException()
        return if (pending.any { it.text("status") == "PENDING" }) PushCheck.ACTIVE else PushCheck.STALE
    }

    private suspend fun ownerItem(payload: PushPayload): PushCheck {
        val project = objectRead(listOf("projects", payload.projectId!!))
        if (payload.sessionId != null) {
            if (!ObjectId.same(project.text("coordinatorSessionId"), payload.sessionId)) return PushCheck.STALE
            if (!open(sessionRead(payload.sessionId))) return PushCheck.STALE
        }
        val rows = objectRead(listOf("projects", payload.projectId, "open-items"))
        val needsYou = array(rows["needsYou"]).onEach {
            canonical(it.text("itemId"))
            if (it.text("assignee") == null) throw ProtocolException()
        }
        val item = needsYou.firstOrNull { ObjectId.same(it.text("itemId"), payload.openItemId) }
            ?: return PushCheck.STALE
        // needsYou is the server's owed/assignee derivation. Do not reconstruct it from push text.
        return if (item.text("assignee") == "OWNER") PushCheck.ACTIVE else PushCheck.STALE
    }

    private suspend fun get(path: List<String>, query: List<Pair<String, String>> = emptyList()): JsonElement =
        Wire.decode(api.request(handle, ApiRequest(path, query = query)).requireSuccess().body, JsonElement.serializer())
    private suspend fun objectRead(path: List<String>): JsonObject = get(path) as? JsonObject ?: throw ProtocolException()
    private suspend fun sessionRead(id: String): JsonObject = objectRead(listOf("sessions", id)).also {
        if (!ObjectId.same(it.text("id"), id) || it.text("status") == null) throw ProtocolException()
    }

    private fun canonical(value: String?): String = value?.let(ObjectId::canonical) ?: throw ProtocolException()
    private fun array(value: JsonElement?): List<JsonObject> = (value as? JsonArray ?: throw ProtocolException())
        .map { it as? JsonObject ?: throw ProtocolException() }
    private fun JsonObject.text(key: String): String? = (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content
    private fun JsonObject.obj(key: String): JsonObject? = get(key) as? JsonObject
    private fun JsonObject.number(key: String): Int {
        val value = get(key) ?: throw ProtocolException()
        return (value as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull?.takeIf { it >= 0 } ?: throw ProtocolException()
    }
    private fun JsonObject.optionalArray(key: String): List<JsonObject> = if (get(key) == null || get(key) == JsonNull) emptyList() else array(get(key))
    private fun JsonObject.present(key: String): Boolean = get(key) != null && get(key) != JsonNull
    private fun open(row: JsonObject): Boolean {
        canonical(row.text("id"))
        val lifecycle = row.text("lifecycleState") ?: throw ProtocolException()
        if (lifecycle !in setOf("OPEN", "COMPLETED", "TRASH")) throw ProtocolException()
        return lifecycle == "OPEN" && listOf("completedAt", "archivedAt", "deletedAt").none { row.present(it) }
    }
}
