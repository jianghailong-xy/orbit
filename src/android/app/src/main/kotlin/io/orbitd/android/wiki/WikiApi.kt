package io.orbitd.android.wiki

import io.orbitd.android.core.auth.OrbitApi
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.navigation.*
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.*
import java.net.URLEncoder
import java.util.UUID

/** The owner JWT door, retaining A03's account fence. Reads deliberately preserve unknown wire fields. */
class WikiApi(private val api: OrbitApi, private val handle: SessionHandle, private val canMutate: () -> Boolean = { true }) {
    suspend fun get(vararg path: String, query: List<Pair<String, String>> = emptyList()): JsonElement =
        Wire.decode(api.request(handle, ApiRequest(path.toList(), query = query)).body, JsonElement.serializer())
    suspend fun objectAt(vararg path: String, query: List<Pair<String, String>> = emptyList()): JsonObject = get(*path, query = query).jsonObject
    suspend fun optional(vararg path: String): JsonObject? = try { objectAt(*path) }
        catch (cancel: CancellationException) { throw cancel }
        catch (error: ApiError) { if (error.status == 404) null else throw error }
    suspend fun spaces() = get("wiki", "spaces").rows()
    suspend fun search(space: String, query: String) = objectAt("wiki", "search", query = listOf("q" to query.trim(), "space" to space)).objects("hits")
    suspend fun entry(id: String) = objectAt("wiki", "entries", id, query = listOf("include" to "sources,history,exposure"))
    suspend fun changeset(id: String): JsonObject {
        val value = objectAt("wiki", "changesets", id)
        val entries = value.objects("entries").toMutableList()
        value.objects("ops").mapNotNull { it.text("entryId") }.distinct().filter { id -> entries.none { ObjectId.same(it.text("id"), id) } }.forEach { entryId ->
            optional("wiki", "entries", entryId)?.let(entries::add)
        }
        return JsonObject(value + ("entries" to JsonArray(entries)))
    }
    suspend fun write(path: List<String>, body: JsonObject = buildJsonObject {}, method: HttpMethod = HttpMethod.POST): JsonObject {
        check(canMutate()) { "Reconnect and refresh before making changes." }
        val result = api.request(handle, ApiRequest(path, method, body = body.toString().encodeToByteArray())).body
        return if (result.isEmpty()) buildJsonObject {} else Wire.decode(result, JsonObject.serializer())
    }
    suspend fun updateSpace(id: String, settings: JsonObject) = write(listOf("wiki", "spaces", id), buildJsonObject { put("settings", settings) }, HttpMethod.PATCH)
    suspend fun ownerWrite(entry: JsonObject, operation: String, title: String, summary: String, reason: String = "", key: String = UUID.randomUUID().toString()): JsonObject {
        val result = write(listOf("wiki", "spaces", requireNotNull(entry.text("spaceId")), "changesets"), ownerRequest(entry, operation, title, summary, reason, key))
        val outcomes = result.objects("ops")
        val refused = outcomes.flatMap { it.objects("reasons") }.mapNotNull { it.text("message") }
        check(outcomes.isNotEmpty() && outcomes.all { it.text("status") == "applied" } && refused.isEmpty()) {
            refused.joinToString("\n").ifBlank { "This change was not applied. Refresh and review its current state." }
        }
        return result
    }
    /** A08's cards and request builder; this host checks the same owner resource instead of a session rail. */
    suspend fun cardAction(shown: InteractionCard, verb: CardVerb, input: CardInput): JsonObject {
        val current = when (shown.context.text("resource")) {
            "wikiEntry" -> wikiEntryCards(entry(shown.objectId))
            "wikiChangeset" -> wikiChangesetCards(changeset(requireNotNull(shown.source.text("changesetId"))))
            "wikiPlan" -> wikiPlanCards(objectAt("wiki", "spaces", requireNotNull(shown.source.text("spaceId")), "plan"))
            else -> emptyList()
        }.firstOrNull { it.key == shown.key }
        check(current != null && current.binding == shown.binding && verb in current.actions) { "This item changed. Refresh and review it again." }
        val request = CardRequests.build(current, verb, input)
        check(canMutate()) { "Reconnect and refresh before making changes." }
        val bytes = api.request(handle, request).body
        return if (bytes.isEmpty()) buildJsonObject {} else Wire.decode(bytes, JsonObject.serializer())
    }
}

internal fun JsonElement.rows(): List<JsonObject> = (this as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
internal fun JsonObject.label(): String = text("title")?.takeIf(String::isNotBlank) ?: text("slug") ?: text("id") ?: "—"
internal fun JsonObject.ended() = text("status") in setOf("retired", "superseded", "rejected")

internal fun wikiEntryCards(entry: JsonObject) = listOfNotNull(AuxiliaryCards.wikiEntry("", entry)?.copy(binding = "${entry.text("currentRevision")}:${entry.text("status")}:${entry.text("trust")}"))
internal fun wikiChangesetCards(value: JsonObject) = AuxiliaryCards.wikiChangeset("", value).map { card ->
    card.copy(binding = card.binding + ":" + card.source.obj("entry")?.text("currentRevision"))
}
internal fun wikiPlanCards(state: JsonObject) = AuxiliaryCards.wikiPlan("", state).map { card ->
    card.copy(source = JsonObject(card.source + ("spaceId" to (state["spaceId"] ?: JsonNull))))
}

internal fun ownerRequest(entry: JsonObject, operation: String, title: String, summary: String, reason: String, key: String): JsonObject {
    require(operation in setOf("amend", "supersede", "retire"))
    require(if (operation == "retire") reason.isNotBlank() else title.isNotBlank() && summary.isNotBlank())
    return buildJsonObject {
        put("idempotencyKey", "wiki-$operation:$key")
        put("rationale", "${operation.replaceFirstChar(Char::uppercase)} “${entry.label()}”")
        putJsonArray("ops") { add(buildJsonObject {
            put("op", operation); put("entryId", requireNotNull(entry.text("id"))); put("baseRevision", entry.number("currentRevision") ?: 1)
            when (operation) {
                "retire" -> put("reason", reason.trim())
                "amend" -> putJsonObject("changes") { put("title", title.trim()); put("summary", summary.trim()) }
                "supersede" -> putJsonObject("entry") {
                    listOf("kind", "fields", "topics", "aliases").forEach { key -> entry[key]?.let { put(key, it) } }
                    put("title", title.trim()); put("summary", summary.trim()); put("anchors", cleanAnchors(entry.objects("anchors")))
                }
            }
        }) }
    }
}

internal fun cleanAnchors(anchors: List<JsonObject>) = JsonArray(anchors.map { anchor -> JsonObject(anchor.filterKeys { it in setOf(
    "type", "path", "symbol", "regionSha256", "sha", "criterionId", "semanticHash", "contentHash", "command", "expectedExit", "ref") }) })

/** Sources keep record IDs verbatim: turn/event/tool_call all use the reader's around= record. */
fun wikiSourceRoute(source: JsonObject, footnote: Boolean = false): OrbitRoute? {
    if (source.text("state") in setOf("deleted", "trashed")) return null
    val kind = source.text("kind")
    val locator = source.obj("locator")
    val session = source.text("sessionId") ?: locator?.text("sessionId") ?: if (!footnote && kind == "turn" && locator?.text("turnId") != null) source.text("ref") else null
    val record = source.text("recordId") ?: locator?.text("recordId") ?: locator?.text("turnId") ?: locator?.text("eventId") ?: locator?.text("toolCallId")
    if (kind in setOf("turn", "event", "tool_call") && session != null && record != null) return OrbitRoute(Destination.SESSION, session, recordId = record, origin = Origin.LINK)
    return when (kind) {
        "task", "task_comment" -> (source.text("taskId") ?: locator?.text("taskId") ?: if (kind == "task") source.text("ref") else null)?.let { OrbitRoute(Destination.TASK, it, origin = Origin.LINK) }
        "approval", "merge_receipt" -> session?.let { OrbitRoute(Destination.SESSION, it, origin = Origin.LINK) }
        "owner_decision" -> source.text("projectId")?.let { OrbitRoute(Destination.PROJECT, it, origin = Origin.LINK) }
        else -> null
    }
}

internal fun wikiRepositoryLink(note: JsonObject, repository: String?): String? {
    if (note.text("kind") !in setOf("design_doc", "code", "contract")) return null
    val repo = repository?.removePrefix("https://")?.removeSuffix(".git")?.takeIf { Regex("github\\.com/[^/]+/[^/]+").matches(it) } ?: return null
    val sha = note.text("sha")?.takeIf { Regex("[0-9a-fA-F]{7,64}").matches(it) } ?: return null
    val path = note.text("path") ?: return null
    val encoded = path.split('/').joinToString("/") { URLEncoder.encode(it, "UTF-8").replace("+", "%20") }
    val lines = note.number("lineStart")?.let { start -> "#L$start" + (note.number("lineEnd")?.takeIf { it != start }?.let { "-L$it" } ?: "") }.orEmpty()
    return "https://$repo/blob/$sha/$encoded$lines"
}

internal fun planSectionInput(section: JsonObject): JsonObject = buildJsonObject {
    section.filterKeys { it in setOf("key", "title", "kind", "covers", "length", "extra") }.forEach { (k, v) -> put(k, v) }
    put("sources", buildJsonObject {
        section.obj("sources")?.forEach { (key, value) ->
            if (key == "sessions" && value is JsonObject) put(key, JsonObject(value.mapValues { (name, content) ->
                if (name == "projects") JsonArray((content as? JsonArray).orEmpty().mapNotNull { item -> if (item is JsonObject) item["id"] else item }) else content
            })) else put(key, value)
        }
    })
}
internal fun planDocInput(doc: JsonObject): JsonObject = JsonObject(doc.filterKeys { it in setOf("category", "slug", "title", "question", "audience", "scopeIn", "scopeOut", "length", "protected", "extra") } +
    ("sections" to JsonArray(doc.objects("sections").map(::planSectionInput))))

internal fun wikiError(error: Throwable): String = when {
    error is ApiError && error.status == 403 -> "You don’t have permission to access this Wiki item."
    error is ApiError && error.status == 404 -> "This Wiki item is no longer available."
    error is ApiError && error.status == 409 -> "This item changed. Refresh and review it again."
    error is ApiError -> error.messages.joinToString("\n").ifBlank { "Orbit refused this request." } +
        ((error.body as? JsonObject)?.objects("errors")?.joinToString("\n", prefix = "\n") { listOfNotNull(it.text("path"), it.text("message")).joinToString(": ") } ?: "")
    error is IllegalStateException || error is IllegalArgumentException -> error.message ?: "Refresh and try again."
    else -> "The wiki couldn’t be loaded. Check the connection, then try again."
}
