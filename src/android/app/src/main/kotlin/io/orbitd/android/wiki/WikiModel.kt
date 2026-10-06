package io.orbitd.android.wiki

import io.orbitd.android.core.cards.*
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.navigation.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.json.*

internal data class WikiPage(val spaces: List<JsonObject>, val space: JsonObject?, val content: JsonObject = buildJsonObject {},
    val rows: List<JsonObject> = emptyList(), val extras: Map<String, JsonObject> = emptyMap(), val warnings: List<String> = emptyList())

internal suspend fun WikiApi.page(route: OrbitRoute, selectedSpace: String?): WikiPage = coroutineScope {
    val spaces = spaces()
    val wanted = if (route.destination == Destination.WIKI) selectedSpace ?: route.wikiSpaceId ?: route.id else route.wikiSpaceId ?: selectedSpace
    val selected = spaces.firstOrNull { ObjectId.same(it.text("id"), wanted) } ?: if (wanted == null) spaces.firstOrNull() else null
    val spaceId = selected?.text("id")
    val extras = mutableMapOf<String, JsonObject>()
    val warnings = mutableListOf<String>()
    suspend fun supplementary(key: String, vararg path: String) {
        try { optional(*path)?.let { extras[key] = it } }
        catch (cancel: CancellationException) { throw cancel }
        catch (error: Exception) { warnings += wikiError(error) }
    }
    if (route.destination == Destination.WIKI_ENTRY || route.destination == Destination.WIKI_RUN) {
        val content = if (route.destination == Destination.WIKI_ENTRY) entry(requireNotNull(route.id)) else changeset(requireNotNull(route.id))
        val ownSpace = spaces.firstOrNull { ObjectId.same(it.text("id"), content.text("spaceId")) }
        return@coroutineScope WikiPage(spaces, ownSpace, content)
    }
    if (wanted != null && selected == null) throw ApiError.parse(404, "{}".encodeToByteArray())
    if (route.destination == Destination.WIKI_REVIEW) {
        val queue = get("wiki", "review").rows()
        val full = queue.map { async { changeset(requireNotNull(it.text("id"))) } }.map { it.await() }
        return@coroutineScope WikiPage(spaces, selected, rows = full)
    }
    if (spaceId == null) return@coroutineScope WikiPage(spaces, null)
    when (route.destination) {
        Destination.WIKI -> {
            val entries = async { get("wiki", "spaces", spaceId, "entries", query = listOf("limit" to "200")).rows() }
            val space = objectAt("wiki", "spaces", spaceId, query = listOf("include" to "usage"))
            supplementary("timeline", "wiki", "spaces", spaceId, "timeline")
            supplementary("health", "wiki", "spaces", spaceId, "health")
            supplementary("plan", "wiki", "spaces", spaceId, "plan")
            supplementary("docs", "wiki", "spaces", spaceId, "docs")
            WikiPage(spaces, space, rows = entries.await(), extras = extras, warnings = warnings)
        }
        Destination.WIKI_BROWSE, Destination.WIKI_INDEX -> {
            val index = route.destination == Destination.WIKI_INDEX
            val docs = optional("wiki", "spaces", spaceId, "docs")
            val content = if (docs?.obj("plan") != null) {
                if (index) JsonObject(objectAt("wiki", "spaces", spaceId, "doc-index") + ("plan" to docs.getValue("plan"))) else docs
            } else objectAt("wiki", "spaces", spaceId, if (index) "article-index" else "articles")
            WikiPage(spaces, selected, content)
        }
        Destination.WIKI_ARTICLE -> {
            val topic = objectAt("wiki", "spaces", spaceId, "topics", requireNotNull(route.id))
            val path = listOf("wiki", "spaces", spaceId, "articles", route.id) + if (route.wikiPart > 0) listOf(route.wikiPart.toString()) else emptyList()
            val article = optional(*path.toTypedArray())
            WikiPage(spaces, selected, article ?: topic, rows = article?.objects("entries")?.takeIf { it.isNotEmpty() } ?: topic.objects("entries"), extras = mapOf("topic" to topic))
        }
        Destination.WIKI_DOC -> WikiPage(spaces, selected, objectAt("wiki", "spaces", spaceId, "docs", requireNotNull(route.id)))
        Destination.WIKI_SETTINGS -> {
            val workspaces = get("workspaces").rows()
            val providers = get("providers").rows()
            WikiPage(spaces, selected, objectAt("wiki", "spaces", spaceId), extras = mapOf("options" to buildJsonObject {
                put("workspaces", JsonArray(workspaces)); put("providers", JsonArray(providers))
            }))
        }
        Destination.WIKI_PLAN, Destination.WIKI_PLAN_DOC, Destination.WIKI_PLAN_SECTION -> {
            val state = objectAt("wiki", "spaces", spaceId, "plan")
            extras["versions"] = objectAt("wiki", "spaces", spaceId, "plan", "versions")
            supplementary("docs", "wiki", "spaces", spaceId, "docs")
            val shown = route.wikiVersion?.let { number ->
                listOfNotNull(state.obj("draft"), state.obj("confirmed")).firstOrNull { it.number("version") == number }
                    ?: objectAt("wiki", "spaces", spaceId, "plan", "versions", number.toString())
            } ?: state.obj("draft") ?: state.obj("confirmed")
            shown?.let { extras["shown"] = it }
            WikiPage(spaces, selected, state, extras = extras, warnings = warnings)
        }
        else -> error("Not a Wiki destination")
    }
}
