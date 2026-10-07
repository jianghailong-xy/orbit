package io.orbitd.android.navigation

import java.math.BigInteger
import java.net.URI
import java.net.URLDecoder
import kotlinx.serialization.Serializable

enum class Destination { WORKSPACES, WORKSPACE, FOLDER, SEARCH, SESSION, DRAFT, PROJECTS, PROJECT, TASKS, TASK, LIST, WIKI, WIKI_ENTRY, WATCH, RUNNER, SETTINGS, BUILD,
    WIKI_BROWSE, WIKI_INDEX, WIKI_ARTICLE, WIKI_DOC, WIKI_REVIEW, WIKI_SETTINGS, WIKI_RUN, WIKI_PLAN, WIKI_PLAN_DOC, WIKI_PLAN_SECTION }
enum class Origin { DRAWER, LIST, SEARCH, LINK, EXTERNAL }

/** Object and source travel together; the preceding frame is the actual return destination. */
@Serializable
data class OrbitRoute(
    val destination: Destination,
    val id: String? = null,
    val workspaceId: String? = null,
    val folderId: String? = null,
    val recordId: String? = null,
    val origin: Origin = Origin.LIST,
    val sessionView: String = "open",
    val wikiPart: Int = 0,
    val wikiSection: String? = null,
    val wikiVersion: Int? = null,
)

@Serializable
data class OrbitNavigation(
    val account: String? = null,
    val section: String = "workspaces",
    val stacks: Map<String, List<OrbitRoute>> = mapOf("workspaces" to listOf(OrbitRoute(Destination.WORKSPACES))),
    val pending: OrbitRoute? = null,
) {
    val frames get() = stacks.getValue(section)
    val current get() = frames.last()
    val canGoBack get() = frames.size > 1

    fun push(route: OrbitRoute): OrbitNavigation = if (current == route) this
        else copy(stacks = stacks + (section to (frames + route)))
    fun back(): OrbitNavigation = if (!canGoBack) this else copy(stacks = stacks + (section to frames.dropLast(1)))
    fun select(key: String, root: OrbitRoute): OrbitNavigation = copy(section = key,
        stacks = stacks + (key to (stacks[key] ?: listOf(root))))
    fun receive(route: OrbitRoute): OrbitNavigation = if (account == null) copy(pending = route) else push(route)

    /** No previous account's paths survive logout/switch. Cold-start links survive the login screen. */
    fun bindAccount(key: String?): OrbitNavigation {
        if (key == account) return this
        val next = OrbitNavigation(account = key, pending = if (account == null) pending else null)
        return if (key != null && next.pending != null) next.copy(pending = null).push(next.pending) else next
    }
}

object ObjectId {
    private const val alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    fun canonical(value: String): String? {
        if (value.matches(Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"))) return value.lowercase()
        if (value.isEmpty() || value.length > 22 || value.any { it !in alphabet }) return null
        var number = BigInteger.ZERO
        value.forEach { number = number * BigInteger.valueOf(62) + BigInteger.valueOf(alphabet.indexOf(it).toLong()) }
        if (number.bitLength() > 128) return null
        val hex = number.toString(16).padStart(32, '0')
        return "${hex.take(8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}"
    }
    fun same(a: String?, b: String?): Boolean = a == b || (a != null && b != null && canonical(a) != null && canonical(a) == canonical(b))
}

object OrbitLinks {
    private val references = mapOf("session" to Destination.SESSION, "task" to Destination.TASK,
        "project" to Destination.PROJECT, "wiki" to Destination.WIKI_ENTRY, "list" to Destination.LIST)
    private val deepLinks = references.filterKeys { it !in setOf("project", "wiki") } +
        mapOf("watch" to Destination.WATCH, "runner" to Destination.RUNNER, "wiki" to Destination.WIKI)

    fun parse(raw: String, server: String? = null, origin: Origin = Origin.LINK): OrbitRoute? { return try {
        val uri = URI(raw)
        val scheme = uri.scheme?.lowercase().orEmpty()
        var kind: Destination? = null
        var id: String? = null
        if (scheme.startsWith("orbit-")) {
            kind = references[scheme.removePrefix("orbit-")]
            id = if (kind == Destination.SESSION) uri.schemeSpecificPart.substringBefore('?') else uri.schemeSpecificPart
        } else if (scheme == "orbit") {
            if (uri.host in listOf(null, "", "active") && uri.path.orEmpty().trim('/').isEmpty()) return OrbitRoute(Destination.WORKSPACES, origin = origin)
            kind = deepLinks[uri.host?.lowercase()]
            val parts = uri.path.orEmpty().trim('/').split('/')
            if (parts.size == 1) id = parts.first()
        } else if (scheme in setOf("https", "http") && server != null && uri.userInfo == null) {
            val base = URI(server)
            fun port(u: URI) = if (u.port != -1) u.port else if (u.scheme == "https") 443 else 80
            if (!uri.host.equals(base.host, ignoreCase = true) || port(uri) != port(base)) return null
            // Instance path is part of A03's scope, including reverse-proxy deployments.
            val prefix = base.path.orEmpty().trimEnd('/') + "/"
            if (!uri.path.startsWith(prefix)) return null
            val parts = uri.path.removePrefix(prefix).trimEnd('/').split('/')
            if (parts.size == 2) {
                kind = mapOf("sessions" to Destination.SESSION, "tasks" to Destination.TASK,
                    "projects" to Destination.PROJECT, "lists" to Destination.LIST)[parts[0]]
                id = parts[1].takeUnless { parts[0] == "lists" && it == "none" }
            } else if (parts.size == 4 && parts[0] in setOf("agents", "workspaces") && parts[2] == "sessions") {
                kind = Destination.SESSION; id = parts[3]
            }
        }
        val canonical = id?.let(ObjectId::canonical)
        if (kind == null || canonical == null) null else {
            val query = uri.rawQuery ?: if (uri.isOpaque) uri.rawSchemeSpecificPart.substringAfter('?', "") else null
            val record = if (kind == Destination.SESSION) query?.split('&')?.firstOrNull { it.startsWith("at=") }
                ?.substringAfter('=')?.let { URLDecoder.decode(it, "UTF-8") }?.let(ObjectId::canonical) else null
            OrbitRoute(kind, canonical, recordId = record, origin = origin)
        }
    } catch (_: Exception) { null } }
}
