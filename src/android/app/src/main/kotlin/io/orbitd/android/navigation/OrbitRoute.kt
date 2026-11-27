package io.orbitd.android.navigation

import java.math.BigInteger
import java.net.URI
import java.net.URLDecoder
import kotlinx.serialization.Serializable

enum class Destination { WORKSPACES, WORKSPACE, FOLDER, SEARCH, SESSION, DRAFT, PROJECTS, PROJECT, TASKS, TASK, LIST, WIKI, WIKI_ENTRY, WATCH, RUNNER, SETTINGS, BUILD,
    /** A project's sessions page (A05-7): `id` the project, `workspaceId` the workspace it was entered over. */
    PROJECT_SESSIONS,
    /** A project's Landings window (owner 2026-10-27, contract §2.9 LS6 revision 28): `id` the project, `recordId` the landing session it
     *  is focused on, if any. The sessions page's Landings row opens it at its bottom; a landing session id opens it focused, through
     *  `SESSION` (reader/LandingSessionPage.kt's `SessionDestination`). */
    LANDINGS,
    WIKI_BROWSE, WIKI_INDEX, WIKI_ARTICLE, WIKI_DOC, WIKI_REVIEW, WIKI_SETTINGS, WIKI_RUN, WIKI_JOB, WIKI_PLAN, WIKI_PLAN_DOC, WIKI_PLAN_SECTION,
    WIKI_ACTIVITY, WIKI_TRASH,
    /** Scheduled tasks (docs/scheduled-tasks-design.md §9.2): account-wide, in the drawer only. `id` the schedule whose detail sheet
     * opens over the timeline, from a push or a card's Open. There is no Waiting on you page (docs/mocks/waiting-on-you-removal). */
    SCHEDULED,
    /** A schedule's draft change conversation (§8.2, board 03-change ③): `id` the schedule. The page reads
     * `GET /schedules/:id/change`; a conversation already open — or opened by the first words sent here — takes its
     * place. */
    SCHEDULE_CHANGE,
    /** A session someone shared with this account (docs/session-guests-design.md §4): `id` the session, drawn as the guest view. A
     *  Shared with me row opens it; a session link the owner's read answers 404 for draws the same view through `SESSION`. */
    GUEST_SESSION,
    /** Drive, the account's drive (board docs/mocks/drive/04-android): `id` the folder (null: the drive's root), `recordId` its
     * name for the bar until the folder is read — or `uploads`, the upload notification's Show, which opens the uploads sheet. */
    DRIVE,
    /** A Drive file's preview: `id` the file, `folderId` the folder it is in, `recordId` its name. */
    DRIVE_FILE, DRIVE_TRASH, DRIVE_STORAGE }
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
    /** Which arrival of a link this frame is, for the Wiki and Watch pages a link opens: each arrival is a page of its
     * own, whose state starts afresh even where an equal page is on the stack already. 0 for every other route. */
    val entry: Long = 0,
)

@Serializable
data class OrbitNavigation(
    val account: String? = null,
    val section: String = "workspaces",
    val stacks: Map<String, List<OrbitRoute>> = mapOf("workspaces" to listOf(OrbitRoute(Destination.WORKSPACES))),
    val pending: OrbitRoute? = null,
    /** The folder page each workspace's list was on when the reader left it, by the workspace's destination key: what
     * its drawer row opens again (iOS `NavState.foldersLeftOpen`). */
    val foldersLeftOpen: Map<String, OrbitRoute> = emptyMap(),
) {
    val frames get() = stacks.getValue(section)
    val current get() = frames.last()
    val canGoBack get() = frames.size > 1

    fun push(route: OrbitRoute): OrbitNavigation = if (current == route) this
        else copy(stacks = stacks + (section to (frames + route)))
    fun back(): OrbitNavigation = if (!canGoBack) this else copy(stacks = stacks + (section to frames.dropLast(1)))
    /** The page on top gives way to [route] in its place (iOS `NavState.replaceTop`): a draft becomes the session it created,
     * so Back goes where the draft would have, never to the draft again. */
    fun replaceTop(route: OrbitRoute): OrbitNavigation = copy(stacks = stacks + (section to (frames.dropLast(1) + route)))
    /** A drawer row's tap (iOS `openDrawerDestination`, 3d50935b4): the row of the destination already showing leaves
     * its page as it is — the tap only closes the drawer — and any other lands on its destination's root page, the
     * stack being left going with it. A workspace's lands on the folder page its list was left on, while [hasFolder]
     * still has that folder (owner, 2026-10-27; iOS `NavState.switchWorkspace`). */
    fun select(key: String, root: OrbitRoute, hasFolder: (String) -> Boolean = { true }): OrbitNavigation {
        if (key == section) return this
        val landed = land(key, root)
        val folder = landed.foldersLeftOpen[key]?.takeIf { hasFolder(it.id.orEmpty()) } ?: return landed
        return landed.copy(stacks = mapOf(key to listOf(root, folder)))
    }
    /** A session completed or moved to Trash from its page leaves the stack it showed on (iOS `NavState.removeConsole`). */
    fun dropSession(id: String): OrbitNavigation {
        val kept = frames.filterNot { it.destination == Destination.SESSION && ObjectId.same(it.id, id) }
        return if (kept.isEmpty() || kept.size == frames.size) this else copy(stacks = stacks + (section to kept))
    }
    /** [key]'s root page whatever was showing: where a page that sends the reader to a destination lands. A workspace's
     * stack it leaves notes the folder page its list is on, or that it is on none ([foldersLeftOpen]). */
    fun land(key: String, root: OrbitRoute): OrbitNavigation {
        val folder = frames.takeIf { it.first().destination == Destination.WORKSPACE }?.firstOrNull { it.destination == Destination.FOLDER }
        val left = if (folder != null) foldersLeftOpen + (section to folder) else foldersLeftOpen - section
        return copy(section = key, stacks = mapOf(key to listOf(root)), foldersLeftOpen = left)
    }
    /** The session on top, filed in [folder], gets its folder's page under it: [workspace]'s list, then the folder's page in [view],
     * so Back reaches the session's row (web WorkspaceView's "A filed session opened from anywhere but its folder's page"). */
    fun underFolder(workspace: String, folder: String, view: String): OrbitNavigation {
        val session = current
        return land(workspace, OrbitRoute(Destination.WORKSPACE, workspace, workspace))
            .push(OrbitRoute(Destination.FOLDER, folder, workspace, sessionView = view)).push(session)
    }
    /** A link opens over the page showing. One that [waitsForDirectory] stays [pending], signed in or not, and a later link
     * replaces it. A link to the app itself (`orbit://active`) only opens it (iOS `route(to: .active)`): a workspace's stack stays as
     * it is, and from anywhere else it goes home. */
    fun receive(route: OrbitRoute): OrbitNavigation {
        val arrived = route.arrived()
        return when {
            account == null || arrived.waitsForDirectory -> copy(pending = arrived)
            arrived.destination != Destination.WORKSPACES -> copy(pending = null).push(arrived)
            frames.first().destination.let { it == Destination.WORKSPACE || it == Destination.WORKSPACES } -> copy(pending = null)
            else -> copy(pending = null).land("workspaces", arrived)
        }
    }
    /** Where the launch default gives way to a workspace's list (iOS `resolveDefaultLanding`): [opened] if the page on top belongs to a
     * workspace, else [last] if it is still there, else the first of [workspaces], in the drawer's order. Whatever has been opened
     * over the default keeps its place, with Back now reaching that list. A landing the saved list made is [provisional]: until
     * something is opened over it the first read from the server decides afresh, and a workspace deleted since isn't kept. */
    fun landHome(workspaces: List<String>, last: String?, opened: String? = null, provisional: String? = null): OrbitNavigation {
        val root = frames.first()
        val undecided = root.destination == Destination.WORKSPACES ||
            (provisional != null && !canGoBack && root.destination == Destination.WORKSPACE && ObjectId.same(root.id, provisional))
        if (!undecided || pending != null) return this
        val target = workspaces.firstOrNull { ObjectId.same(it, opened) } ?: workspaces.firstOrNull { ObjectId.same(it, last) } ?: workspaces.firstOrNull() ?: return this
        if (root.destination == Destination.WORKSPACE && ObjectId.same(root.id, target)) return this
        return copy(section = target, stacks = mapOf(target to (listOf(OrbitRoute(Destination.WORKSPACE, target, target, origin = root.origin)) + frames.drop(1))))
    }
    /** The [pending] project's sessions page lands at [root], the shell's pick once the directory is read: its project's own
     * destination, whatever was showing, as the drawer's row lands it. */
    fun landPending(root: OrbitRoute): OrbitNavigation = copy(pending = null).land(projectDestination(root.id!!), root)

    /** No previous account's paths survive logout/switch. Cold-start links survive the login screen. */
    fun bindAccount(key: String?): OrbitNavigation {
        if (key == account) return this
        val next = OrbitNavigation(account = key, pending = if (account == null) pending else null)
        return when {
            key == null || next.pending == null || next.pending.waitsForDirectory -> next
            // A link to the app itself has nothing to open over the home it starts on.
            next.pending.destination == Destination.WORKSPACES -> next.copy(pending = null)
            else -> next.copy(pending = null).push(next.pending)
        }
    }
}

/** A project's sessions page from a link (`orbit://project/<id>`, a merge's push) names no workspace to open over: it waits for
 * the directory, which says which one ([OrbitNavigation.landPending]). */
val OrbitRoute.waitsForDirectory get() = destination == Destination.PROJECT_SESSIONS && workspaceId == null

/** The destination of a drawer project row: the project's own page (iOS `DrawerDestination.project`). The two
 * spellings of its id are one destination. */
fun projectDestination(id: String) = "project:${ObjectId.canonical(id) ?: id}"

/** The destination of a drawer Shared with me row (OrbitKit `SidebarSelection.guestSession`). */
fun guestDestination(id: String) = "guest:${ObjectId.canonical(id) ?: id}"

/** The destination of a drawer Set up <machine> row (iOS `DrawerDestination.machineDraft`). */
fun machineDraftDestination(id: String) = "setup:${ObjectId.canonical(id) ?: id}"

/** A machine's new session page opened as New workspace while the machine has one (docs/mocks/new-workspace-form/02-apple-entry, owner
 *  A 2026-11-20; iOS `AppModel.openNewWorkspace`): the setup card makes one more instead of moving on to the first. */
const val NEW_WORKSPACE_RECORD = "new-workspace"

/** New workspace on a machine, from the drawer's + or the machine page's row: its new session page with the setup card. One with no
 *  workspace yet gets the page its Set up row opens. */
fun newWorkspaceRoute(runnerId: String, hasWorkspace: Boolean, origin: Origin) =
    OrbitRoute(Destination.DRAFT, id = runnerId, recordId = NEW_WORKSPACE_RECORD.takeIf { hasWorkspace }, origin = origin)

/** The page [newWorkspaceRoute] opens on a machine that has a workspace. */
val OrbitRoute.addsWorkspace get() = destination == Destination.DRAFT && workspaceId == null && recordId == NEW_WORKSPACE_RECORD

/** The Wiki and Watch pages, whose state is the frame's own (MainActivity drops it once the frame left every stack). */
val OrbitRoute.isWikiOrWatch get() = destination == Destination.WATCH || destination.name.startsWith("WIKI")

/** A link to a Wiki or Watch page arrives as a page of its own ([OrbitRoute.entry]); any other route as it is. */
internal fun OrbitRoute.arrived(): OrbitRoute = if (isWikiOrWatch) copy(entry = OrbitArrivals.next()) else this

internal object OrbitArrivals {
    /** Distinct across process restarts too: a restored stack's entries are never handed out again. */
    @Volatile var next: () -> Long = { kotlin.random.Random.nextLong(1, Long.MAX_VALUE) }
}

object ObjectId {
    private const val alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    private val uuid = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
    private const val CACHED = 4096
    /** The list and the drawer compare every row's ids on each directory change: a page of the answers, so each spelling is
     * parsed once. Oldest first out; [NONE] stands for an id with no canonical form. */
    private val cache = object : LinkedHashMap<String, String>(CACHED, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?) = size > CACHED
    }
    private const val NONE = ""

    fun canonical(value: String): String? {
        synchronized(cache) { cache[value] }?.let { return it.ifEmpty { null } }
        val result = parse(value)
        synchronized(cache) { cache[value] = result ?: NONE }
        return result
    }
    private fun parse(value: String): String? {
        if (value.matches(uuid)) return value.lowercase()
        if (value.isEmpty() || value.length > 22 || value.any { it !in alphabet }) return null
        var number = BigInteger.ZERO
        value.forEach { number = number * BigInteger.valueOf(62) + BigInteger.valueOf(alphabet.indexOf(it).toLong()) }
        if (number.bitLength() > 128) return null
        val hex = number.toString(16).padStart(32, '0')
        return "${hex.take(8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}"
    }
    fun same(a: String?, b: String?): Boolean = a == b || (a != null && b != null && canonical(a)?.let { it == canonical(b) } == true)
    /** OrbitKit `PublicID.toPublic`: a UUID's 16 bytes as Base62, the spelling the deployment's own routes use. */
    fun toPublic(id: String): String {
        val uuid = canonical(id) ?: return id
        var number = BigInteger(uuid.replace("-", ""), 16)
        if (number.signum() == 0) return "0"
        val out = StringBuilder(); val base = BigInteger.valueOf(62)
        while (number.signum() > 0) { val (q, r) = number.divideAndRemainder(base); out.append(alphabet[r.toInt()]); number = q }
        return out.reverse().toString()
    }
}

object OrbitLinks {
    private val references = mapOf("session" to Destination.SESSION, "task" to Destination.TASK,
        "project" to Destination.PROJECT, "wiki" to Destination.WIKI_ENTRY, "list" to Destination.LIST)
    // `orbit://project/<id>` is a merge push's (A11-9): the project's sessions page. Like `orbit://wiki/<space>`, no iOS DeepLink host.
    private val deepLinks = references.filterKeys { it !in setOf("project", "wiki") } +
        mapOf("watch" to Destination.WATCH, "runner" to Destination.RUNNER, "wiki" to Destination.WIKI, "project" to Destination.PROJECT_SESSIONS,
            // `orbit://schedule/<id>`: a scheduled task's push that names no run session opens the Scheduled page, its detail sheet open.
            "schedule" to Destination.SCHEDULED)

    /** `orbit://owner-request/<id>`, an owner request push's action: the request, by its canonical id. It names no page of its own:
     * the request's read says which conversation asked, and that conversation opens on its card ([io.orbitd.android.cards.OwnerRequestLinks]). */
    fun ownerRequest(raw: String): String? = try {
        URI(raw).takeIf { it.scheme.equals("orbit", ignoreCase = true) && it.host.equals("owner-request", ignoreCase = true) }
            ?.path.orEmpty().trim('/').takeIf { it.isNotEmpty() && '/' !in it }?.let(ObjectId::canonical)
    } catch (_: Exception) { null }
    /** iOS DeepLink's `case "active", ""` (A05h, DL-1): an `orbit:` link with no host, an empty one or `active` (percent-decoded,
     * in any case) opens the workspaces home, whatever path, query or fragment follows — iOS's URL percent-encodes a blank there
     * and DeepLink never reads it — while a blank in the host is no URL there, so nothing opens. Read off the link itself:
     * java.net.URI refuses `orbit://` and `orbit:`, and reads no host in `orbit://%20`. Group 1 is the host. */
    private val home = Regex("""orbit:(?:(?!//).*|//(?:[^/?#@\s]*@)?([^/?#:@\s]*)(?::\d*)?(?:[/?#].*)?)""",
        setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))

    fun parse(raw: String, server: String? = null, origin: Origin = Origin.LINK): OrbitRoute? { return try {
        home.matchEntire(raw)?.let {
            if (URLDecoder.decode(it.groupValues[1], "UTF-8").lowercase() in setOf("", "active")) return OrbitRoute(Destination.WORKSPACES, origin = origin)
        }
        val uri = URI(raw)
        val scheme = uri.scheme?.lowercase().orEmpty()
        var kind: Destination? = null
        var id: String? = null
        // `orbit-settings:<key>` opens Settings at that row (design §6): its page, the row asked for in recordId. Theme has no page.
        if (scheme == "orbit-settings") {
            val place = io.orbitd.android.core.cards.SettingsFromConversation.place(uri.schemeSpecificPart) ?: return null
            return OrbitRoute(Destination.SETTINGS, place.page, recordId = place.key, origin = origin)
        }
        if (scheme.startsWith("orbit-")) {
            kind = references[scheme.removePrefix("orbit-")]
            id = if (kind == Destination.SESSION) uri.schemeSpecificPart.substringBefore('?') else uri.schemeSpecificPart
        } else if (scheme == "orbit" && uri.host.equals("settings", ignoreCase = true)) {
            // `orbit://settings/<page>`: a Settings page itself, as the Providers screen a key's alert opens.
            val page = uri.path.orEmpty().trim('/')
            return if (page in setOf("providers", "machines", "machines-and-models")) OrbitRoute(Destination.SETTINGS, page, origin = origin) else null
        } else if (scheme == "orbit" && (uri.host.equals("drive", ignoreCase = true) || uri.host.equals("documents", ignoreCase = true))) {
            // `orbit://drive/uploads` (`orbit://documents/uploads` from an older build), the upload notification's Show: Drive with its uploads sheet open.
            return OrbitRoute(Destination.DRIVE, recordId = uri.path.orEmpty().trim('/').takeIf { it == "uploads" }, origin = origin)
        } else if (scheme == "orbit") {
            val parts = uri.path.orEmpty().trim('/').split('/')
            // `orbit://terminal-login/<id>`, a terminal asking to be approved: Settings › Machines & models, on its Needs you section,
            // that request's card lit (docs/mocks/waiting-on-you-removal/02 ④). One answered or expired opens the page all the same.
            if (uri.host.equals("terminal-login", ignoreCase = true)) {
                val request = parts.singleOrNull()?.takeIf { it.isNotEmpty() }?.let(ObjectId::canonical) ?: return null
                return OrbitRoute(Destination.RUNNER, recordId = "terminal:$request", origin = origin)
            }
            kind = deepLinks[uri.host?.lowercase()]
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
