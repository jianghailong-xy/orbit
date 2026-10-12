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
    /** The candidate this project is asking its owner to merge into main, or null while it asks nothing — which the server answers
     * with no body. Its latest candidate, whatever state it is in. */
    suspend fun currentPromotion(id: String): JsonObject? {
        val body = auth.request(handle, ApiRequest(listOf("projects", id, "promotions", "current"))).body
        return if (body.isEmpty()) null else Wire.decode(body, JsonElement.serializer()) as? JsonObject
    }
    /** The merges this project has already made, newest first: the records a merge leaves. */
    suspend fun mergedPromotions(id: String) = (read(listOf("projects", id, "promotions", "merged")) as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
    /** M-T4: merge it. The candidate's own source SHA travels with the press, so a card drawn before a newer candidate superseded it
     * is refused rather than merging whatever is on the branch now. Each door answers the candidate's new state. */
    suspend fun confirmPromotion(id: String, promotionId: String, sourceSha: String) = send("promotion:confirm:$promotionId",
        listOf("projects", id, "promotions", promotionId, "confirm"), body = buildJsonObject { put("sourceSha", sourceSha) }) as? JsonObject
    /** M-T5: not now. The branch stays where it is, and the next landing offers it again. */
    suspend fun declinePromotion(id: String, promotionId: String) = send("promotion:decline:$promotionId",
        listOf("projects", id, "promotions", promotionId, "decline")) as? JsonObject
    /** M-T10: call a confirmed merge back, while its job has not reached the push. */
    suspend fun cancelPromotion(id: String, promotionId: String) = send("promotion:cancel:$promotionId",
        listOf("projects", id, "promotions", promotionId, "cancel")) as? JsonObject
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

/** What `GET /projects/:id/integration` says about the project's main branch (`ProjectIntegrationView`, contract L6): the
 * repository, the branches it can be chosen from, this account's last choice for that repository, and when this project's own
 * was chosen. A server that predates them sends none of the four, and that reads as none. */
object ProjectMainBranch {
    /** The branches the runner last reported for the coordination workspace's checkout, without Orbit's own session branches — the
     * Merge menu's list. */
    data class Branches(val names: List<String>, val workspaceName: String, val reportedAt: String?)
    /** This account's last choice of main branch for the repository, both short. */
    data class LastChoice(val branch: String, val repository: String, val chosenAt: String?)

    /** The repository, short ("acme/payments-api"); null for a project with none, which has no main branch to choose. */
    fun repository(view: JsonObject?): String? = view?.text("repository")?.takeIf { it.isNotEmpty() }
    fun branches(view: JsonObject?): Branches? {
        val read = view?.obj("branches") ?: return null
        return Branches(read.strings("names"), read.text("workspaceName") ?: return null, read.text("reportedAt"))
    }
    fun lastChoice(view: JsonObject?): LastChoice? {
        val read = view?.obj("lastMainBranch") ?: return null
        val branch = read.text("branch")?.takeIf { it.isNotEmpty() } ?: return null
        return LastChoice(branch, read.text("repository").orEmpty(), read.text("chosenAt"))
    }
    /** When the owner chose this project's own main branch; null while it is still the default or one carried over. */
    fun chosenAt(view: JsonObject?): String? = view?.text("upstreamChosenAt")
    /** The main branch the project stands on, by name — before it is bound to its repository, the one binding gives it: the owner's
     * last choice there, else main — and null for a project with no repository (web's `storedUpstream`). */
    fun stored(view: JsonObject?): String? =
        if (repository(view) == null) null else RunSettings.mainBranchName(view?.text("upstreamRef") ?: lastChoice(view)?.branch)
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
