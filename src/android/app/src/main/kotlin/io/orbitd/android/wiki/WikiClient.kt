package io.orbitd.android.wiki

import io.orbitd.android.core.auth.OrbitApi
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.*

/** OrbitKit `APIClient`'s Wiki door (`/api/wiki`, the owner's JWT, never a session header), on A03's handle. */
internal class WikiClient(private val api: OrbitApi, private val handle: SessionHandle) {
    private suspend fun raw(path: List<String>, query: List<Pair<String, String>> = emptyList(),
        method: HttpMethod = HttpMethod.GET, body: JsonElement? = null): ByteArray =
        api.request(handle, ApiRequest(path, method, query, body?.toString()?.encodeToByteArray())).body
    private suspend fun json(path: List<String>, query: List<Pair<String, String>> = emptyList(),
        method: HttpMethod = HttpMethod.GET, body: JsonElement? = null): JsonElement =
        raw(path, query, method, body).let { if (it.isEmpty()) JsonNull else Wire.decode(it, JsonElement.serializer()) }
    private suspend fun <T> get(path: List<String>, serializer: KSerializer<T>, query: List<Pair<String, String>> = emptyList()): T =
        Wire.decode(raw(path, query), serializer)
    private fun spacePath(id: String, vararg rest: String) = listOf("wiki", "spaces", id) + rest

    suspend fun spaces(): List<WikiSpace> = get(listOf("wiki", "spaces"), ListSerializer(WikiSpace.serializer()))
    suspend fun space(id: String): WikiSpace = get(spacePath(id), WikiSpace.serializer(), listOf("include" to "usage"))
    /** A space's entries of every status, newest recorded first — of one kind when [kind] is given. The server answers
     * 200 at most. */
    suspend fun entries(spaceId: String, kind: String? = null, limit: Int = 200): List<WikiEntry> =
        get(spacePath(spaceId, "entries"), ListSerializer(WikiEntry.serializer()),
            listOfNotNull(kind?.let { "kind" to it }, "limit" to limit.toString()))
    suspend fun timeline(spaceId: String): WikiTimeline = get(spacePath(spaceId, "timeline"), WikiTimeline.serializer())
    suspend fun health(spaceId: String): WikiSpaceHealth = WikiSpaceHealth.decode(json(spacePath(spaceId, "health")))
    suspend fun articleDirectory(spaceId: String) = get(spacePath(spaceId, "articles"), WikiArticleDirectory.serializer())
    suspend fun article(spaceId: String, slug: String, part: Int): WikiArticle =
        get(if (part > 0) spacePath(spaceId, "articles", slug, part.toString()) else spacePath(spaceId, "articles", slug), WikiArticle.serializer())
    suspend fun articleIndex(spaceId: String) = get(spacePath(spaceId, "article-index"), WikiArticleIndex.serializer())
    suspend fun topic(spaceId: String, slug: String) = get(spacePath(spaceId, "topics", slug), WikiTopicView.serializer())
    suspend fun review(spaceId: String? = null): List<WikiChangeset> =
        get(listOf("wiki", "review"), ListSerializer(WikiChangeset.serializer()), spaceId?.let { listOf("space" to it) }.orEmpty())
    suspend fun changeset(id: String): WikiChangesetView = WikiChangesetView.decode(json(listOf("wiki", "changesets", id)))
    suspend fun entry(id: String): WikiEntryDetail =
        WikiEntryDetail.decode(json(listOf("wiki", "entries", id), listOf("include" to "sources,history,exposure")))
    suspend fun search(query: String, spaceId: String?): WikiSearchResponse = get(listOf("wiki", "search"), WikiSearchResponse.serializer(),
        listOf("q" to query, "include" to "topics") + spaceId?.let { listOf("space" to it) }.orEmpty())

    /** `POST /wiki/changesets/:id/decide`: one owner answer to one pending op. */
    suspend fun decide(changesetId: String, opId: String, action: String, edited: JsonObject? = null,
        reason: String? = null, note: String? = null): JsonElement = json(listOf("wiki", "changesets", changesetId, "decide"),
        method = HttpMethod.POST, body = buildJsonObject {
            putJsonArray("decisions") { add(buildJsonObject {
                put("opId", opId); put("action", action)
                edited?.let { put("edited", it) }; reason?.let { put("reason", it) }; note?.let { put("note", it) }
            }) }
        })
    /** `POST /wiki/spaces/:id/changesets`: the owner's own write, which applies at once. */
    suspend fun submit(spaceId: String, op: JsonObject, rationale: String, idempotencyKey: String): WikiChangeResult =
        Wire.json.decodeFromJsonElement(WikiChangeResult.serializer(), json(spacePath(spaceId, "changesets"), method = HttpMethod.POST,
            body = buildJsonObject { putJsonArray("ops") { add(op) }; put("rationale", rationale); put("idempotencyKey", idempotencyKey) }))
    /** `PATCH /wiki/spaces/:id`: a key left out is left as it is. */
    suspend fun updateSpace(id: String, update: JsonObject): JsonElement = json(spacePath(id), method = HttpMethod.PATCH, body = update)
    suspend fun confirmEntry(id: String) { raw(listOf("wiki", "entries", id, "confirm"), method = HttpMethod.POST) }
    suspend fun rejectEntry(id: String, reason: String) {
        raw(listOf("wiki", "entries", id, "reject"), method = HttpMethod.POST, body = buildJsonObject { put("reason", reason) })
    }
    suspend fun revert(id: String): JsonElement = json(listOf("wiki", "changesets", id, "revert"), method = HttpMethod.POST)

    suspend fun docs(spaceId: String) = get(spacePath(spaceId, "docs"), WikiDocsDirectory.serializer())
    suspend fun doc(spaceId: String, slug: String) = get(spacePath(spaceId, "docs", slug), WikiDoc.serializer())
    suspend fun docIndex(spaceId: String) = get(spacePath(spaceId, "doc-index"), WikiDocsIndex.serializer())
    suspend fun plan(spaceId: String): WikiPlanState = WikiPlanState.decode(json(spacePath(spaceId, "plan")))
    suspend fun planVersions(spaceId: String) = get(spacePath(spaceId, "plan", "versions"), WikiPlanVersions.serializer())
    suspend fun planVersion(spaceId: String, version: Int) = get(spacePath(spaceId, "plan", "versions", version.toString()), WikiPlanVersion.serializer())
    /** With instructions a revision of the newest version; blank instructions are not sent. */
    suspend fun redraftPlan(spaceId: String, instructions: String?): Boolean {
        val words = instructions?.trim().orEmpty()
        val answer = json(spacePath(spaceId, "plan", "redraft"), method = HttpMethod.POST,
            body = buildJsonObject { if (words.isNotEmpty()) put("instructions", words) })
        return answer["created"].bool() ?: false
    }
    suspend fun confirmPlan(spaceId: String, version: Int): WikiPlanVersion = Wire.json.decodeFromJsonElement(WikiPlanVersion.serializer(),
        json(spacePath(spaceId, "plan", "versions", version.toString(), "confirm"), method = HttpMethod.POST, body = buildJsonObject {}))
    suspend fun editPlan(spaceId: String, request: JsonObject): WikiPlanVersion = Wire.json.decodeFromJsonElement(WikiPlanVersion.serializer(),
        json(spacePath(spaceId, "plan", "edits"), method = HttpMethod.POST, body = request))
    /** Its answer: the proposal as decided, and the draft an acceptance made. */
    suspend fun decidePlanProposal(id: String, accept: Boolean): WikiPlanVersion? {
        val answer = json(listOf("wiki", "plan-proposals", id, "decide"), method = HttpMethod.POST,
            body = buildJsonObject { put("action", if (accept) "accept" else "reject") })
        return answer["draft"]?.takeIf { it !is JsonNull }?.let { Wire.json.decodeFromJsonElement(WikiPlanVersion.serializer(), it) }
    }

    /** `POST /link-previews`: the cards for the objects a page names, at most 50 refs a request. Each answer is
     * `ok` with the object's fields, or `unavailable` — the same for another account's, a deleted or no object. */
    suspend fun linkPreviews(refs: List<Pair<String, String>>): JsonArray =
        json(listOf("link-previews"), method = HttpMethod.POST, body = buildJsonObject {
            putJsonArray("refs") { refs.forEach { (kind, id) -> add(buildJsonObject { put("kind", kind); put("id", id) }) } }
        })["previews"] as? JsonArray ?: JsonArray(emptyList())

    /** The options a maintenance form offers: the account's workspaces and runners, and its providers. */
    suspend fun workspaces(): JsonArray = json(listOf("workspaces")) as? JsonArray ?: JsonArray(emptyList())
    suspend fun runners(): JsonArray = json(listOf("runners")) as? JsonArray ?: JsonArray(emptyList())
    suspend fun providers(): JsonArray = json(listOf("providers")) as? JsonArray ?: JsonArray(emptyList())
}

/** What the server said when it refused a write — its own sentence — or the web's fallback (`WikiModel.refusal`). */
internal fun wikiRefusal(error: Throwable): String =
    (error as? ApiError)?.let { (it.body as? JsonObject)?.get("message").text()?.takeIf { m -> m.isNotEmpty() } } ?: WikiCopy.refused

/** A plan write the gate refused (`WIKI_PLAN_GATE`), with every error it found (`WikiPlanLogic.gateErrors`). */
internal fun wikiGateErrors(error: Throwable): List<WikiPlanGateError>? {
    val api = error as? ApiError ?: return null
    if (api.code != "WIKI_PLAN_GATE") return null
    return (api.body as? JsonObject)?.get("errors").lenient(ListSerializer(WikiPlanGateError.serializer())) ?: emptyList()
}
