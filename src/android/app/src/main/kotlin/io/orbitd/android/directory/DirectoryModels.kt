package io.orbitd.android.directory

import io.orbitd.android.core.cards.CoordinatorDelivery
import io.orbitd.android.core.cards.CoordinatorDeliveryLine
import io.orbitd.android.core.protocol.SessionCapabilities
import io.orbitd.android.navigation.ObjectId
import java.time.Instant
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

/** [position] is null until the workspace is first dragged into place (schema.prisma Workspace.position Int?). [repoUrl] is the
 * remote the workspace records, null with none and from a server that does not send it: what makes a wiki of it (mock 41). */
@Serializable
data class DirectoryWorkspace(val id: String, val name: String, val runnerId: String? = null,
    val enabled: Boolean = true, val position: Int? = null, val createdAt: String? = null, val repoUrl: String? = null)
@Serializable
data class DirectoryRunner(val id: String, val name: String, val status: String? = null, val online: Boolean? = null,
    val displayName: String? = null, val lastHeartbeatAt: String? = null)
@Serializable
data class Folder(val id: String, val workspaceId: String, val name: String)
@Serializable
data class Tag(val id: String, val name: String, val color: String? = null,
    val isSystem: Boolean = false, val position: Int = 0)
@Serializable
data class WorkspaceRef(val id: String, val name: String = "")
/** What one recap pass did (apiserver sessions/recap.ts `RecapOutcome`): the line it wrote, or why it wrote none ([RecapCard.notice]). */
@Serializable
data class RecapOutcome(val written: Boolean, val recapText: String? = null, val reason: String? = null)
@Serializable
data class DirectorySession(
    val id: String, val title: String? = null, val status: String = "UNKNOWN",
    val runState: String? = null, val lifecycleState: String? = null,
    val agent: WorkspaceRef? = null, val agentId: String? = null, val workspaceId: String? = null,
    val folderId: String? = null, val pinnedAt: String? = null,
    val createdAt: String? = null, val lastTurnAt: String? = null,
    /** When the turn now running began, which a working row counts from; null with none running and from an older server. */
    val currentTurnStartedAt: String? = null,
    val pendingApprovals: Int = 0, val runningBgJobCount: Int = 0,
    val confirmationUnderReview: JsonObject? = null,
    val lastAssistantText: String? = null, val lastUserText: String? = null,
    /** Who sent [lastUserText], when another Orbit session did: the row names that session instead of saying "You"
     *  ([SessionLine.sender]). Null for the owner's own words, and from an older server, which does not send it. */
    val lastUserFrom: SessionMessageFrom? = null,
    /** That [lastUserText] is Orbit's own message (a coordinator's notification, a watch's wake, the owner's answer handed on…), with
     *  the notification card its line is written from: the row says "Orbit: …" ([SessionLine.orbitLine], read by [OrbitMessageFrom.of]).
     *  Null for anybody else's words, and from an older server. Kept as the JSON it came as, so a shape this build cannot read is no
     *  mark rather than a list that fails to decode. */
    val lastUserFromOrbit: JsonElement? = null,
    /** The rolling recap the server wrote about this session and when it wrote it (0418), clipped like the previews beside it; the
     *  line the list prefers to [lastAssistantText]. Both null on a session no pass has recapped yet, and from a server that writes
     *  no recaps (`ORBIT_RECAP_ENABLED=0`) — exactly what the row falls back from. The account's Session recaps switch can also hold
     *  it back (`LocalSessionRecaps`). */
    val recapText: String? = null, val recapAt: String? = null,
    val tags: List<Tag> = emptyList(), val capabilities: SessionCapabilities? = null,
    // What SessionLine reads beyond the above (OrbitKit `Session`): null from a server that does not send it.
    val runStatus: String? = null, val endReason: String? = null, val error: String? = null, val retryAt: String? = null,
    val completedAt: String? = null, val deletedAt: String? = null, val lastToolUse: String? = null,
    val runningBgCount: Int? = null, val runningSubagentCount: Int? = null, val engineTurnActive: Boolean? = null,
    val waitingKind: String? = null, val ownerItems: JsonArray? = null,
    /** The project this session belongs to in any role; null for an ordinary conversation and from an older server. */
    val projectMembership: SessionProjectMembership? = null,
    /** `LANDING` for platform work with no engine (contract §2.9 LS6), `CONVERSATION` otherwise; absent from an older server. */
    val sessionKind: String? = null,
    /** What a LANDING row says about its subject, on `GET /sessions?projectId=&includeLanding=1` only; absent everywhere else. */
    val landing: SessionLandingSummary? = null,
) {
    /** Whether this row is a landing session (platform work), not a conversation. */
    val isLanding get() = sessionKind == "LANDING"
    val workspace get() = workspaceId ?: agentId ?: agent?.id
    val name get() = title?.takeIf(String::isNotBlank) ?: "Untitled session"
}
/** Who sent the message a session row previews, when another Orbit session did (`@orbit/shared` and OrbitKit `SessionMessageFrom`,
 * design §3.5): the sending session and its title as they stood when the message was written. Both slots optional, so a value read
 * only in part still says that someone other than the owner sent it. */
@Serializable
data class SessionMessageFrom(val sessionId: String? = null, val title: String? = null)
/** That the message a session row previews is Orbit's own: a turn the control plane wrote itself (`@orbit/shared` and OrbitKit
 * `OrbitMessageFrom`, design §3.5, owner 2026-11-07). [coordinatorDelivery] is the card the conversation draws a coordinator's
 * notification as, read by the conversation's own rule ([CoordinatorDeliveryLine.parse]): the row says that line's sentence. Null for
 * every other message of Orbit's — and for a card this build cannot read — whose row says its first line. */
data class OrbitMessageFrom(val coordinatorDelivery: CoordinatorDelivery? = null) {
    companion object {
        /** A row's `lastUserFromOrbit`, read as OrbitKit reads it: an object is Orbit's mark, anything else none. */
        fun of(value: JsonElement?): OrbitMessageFrom? = (value as? JsonObject)?.let { mark ->
            OrbitMessageFrom((mark["coordinatorDelivery"] as? JsonObject)?.let { CoordinatorDeliveryLine.parse(it) })
        }
    }
}
/** What a LANDING session row says about its subject (`SessionLandingSummary`, contract §2.9 LS6): the subject it represents and where
 * it stands, so the project's Landings window can put a landing still in hand under `Now` and a settled one in the day it settled, and
 * the page's Landings row can count them. Every slot optional, so a server that sends less still decodes. */
@Serializable
data class SessionLandingSummary(val subject: String? = null, val state: String? = null,
    val settledAs: String? = null, val settledAt: String? = null)

/** A session's project membership (OrbitKit `SessionProjectMembership`): derived from its coordinator, task, context, judgment or
 * root relation. A role or status this build does not know is kept as the server spelled it, and matches none of the known ones. */
@Serializable
data class SessionProjectMembership(val projectId: String, val projectTitle: String = "", val projectStatus: String = "UNKNOWN",
    val role: String = "UNKNOWN") {
    val isCoordinator get() = role == "COORDINATOR"
    /** A landing session's membership (`LANDING`, contract §2.9 LS6): no engine, and never a member of the page's timeline. */
    val isLanding get() = role == "LANDING"
}
@Serializable
data class SearchHit(val id: String, val title: String, val status: String = "UNKNOWN",
    val runState: String? = null, val lifecycleState: String? = null,
    val agent: WorkspaceRef? = null, val snippet: String? = null, val matchField: String = "message")
@Serializable
data class SearchResults(val q: String = "", val contentSearched: Boolean = false,
    val hits: List<SearchHit> = emptyList(), val total: Int? = null)
@Serializable
data class MoveFolder(val id: String, val name: String, val sessionCount: Int = 0)
@Serializable
data class MoveTarget(val workspaceId: String, val name: String, val reason: String? = null,
    val conversation: String? = null, val runnerOnline: Boolean = true, val folders: List<MoveFolder> = emptyList())
@Serializable
data class MoveTargets(val workspaceId: String? = null, val folderId: String? = null,
    val folders: List<MoveFolder> = emptyList(), val reason: String? = null,
    val needsEnd: Boolean = false, val branch: String? = null, val changedFiles: Int = 0,
    val unmergedFiles: Int = 0, val mergeTarget: String? = null, val targets: List<MoveTarget> = emptyList())

/** iOS's order (AgentListLogic.ordered): the server's — placed workspaces by position, then never-placed ones
 * (position null) oldest first — with the workspaces that have no runner moved to the bottom. */
fun orderedWorkspaces(workspaces: List<DirectoryWorkspace>): List<DirectoryWorkspace> =
    workspaces.sortedWith(workspaceOrder({ it.runnerId }, { it.position }, { it.createdAt }))

/** The same order for the realtime directory's raw rows: Tasks' Set assignee and a task's Assignee picker (iOS `orderedAgents`). */
fun orderedWorkspaceRows(rows: List<JsonObject>): List<JsonObject> = rows.sortedWith(workspaceOrder(
    { (it["runnerId"] as? JsonPrimitive)?.contentOrNull }, { (it["position"] as? JsonPrimitive)?.intOrNull },
    { (it["createdAt"] as? JsonPrimitive)?.contentOrNull }))

private fun <T> workspaceOrder(runnerId: (T) -> String?, position: (T) -> Int?, createdAt: (T) -> String?) =
    compareBy<T> { runnerId(it) == null }.thenBy(nullsLast()) { position(it) }.thenBy { createdAt(it) }

enum class SessionView(val query: String, val label: String) { OPEN("open", "Open"), COMPLETED("completed", "Completed"), TRASH("trash", "Trash") }
enum class Grouping { RECENCY, TAG }
data class SessionGroup(val id: String, val title: String, val sessions: List<DirectorySession>)

fun directoryGroups(sessions: List<DirectorySession>, view: SessionView, grouping: Grouping,
    now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): List<SessionGroup> {
    fun date(s: DirectorySession) = runCatching { Instant.parse(s.lastTurnAt ?: s.createdAt) }.getOrNull()
    val sorted = if (view == SessionView.COMPLETED) sessions else sessions.sortedWith(compareByDescending<DirectorySession> { view == SessionView.OPEN && it.pinnedAt != null }
        .thenByDescending { date(it) ?: Instant.MIN }.thenBy { it.id })
    if (grouping == Grouping.TAG) {
        val tags = sorted.mapNotNull { it.tags.firstOrNull() }.distinctBy { it.id }
            .sortedWith(compareByDescending<Tag> { it.isSystem }.thenBy { it.position }.thenBy { it.name })
        return tags.map { tag -> SessionGroup("tag:${ObjectId.canonical(tag.id) ?: tag.id}", tag.name, sorted.filter { it.tags.firstOrNull()?.id == tag.id }) } +
            listOfNotNull(sorted.filter { it.tags.isEmpty() }.takeIf { it.isNotEmpty() }?.let { SessionGroup("bucket:untagged", "Untagged", it) })
    }
    val today = now.atZone(zone).toLocalDate()
    val buckets = sorted.groupBy { s -> if (view == SessionView.OPEN && s.pinnedAt != null) 0 else recencyBucket(date(s), today, zone) }
    return recencyTitles.mapIndexedNotNull { i, title -> buckets[i]?.let { SessionGroup("time:$i", title, it) } }
}

/** The list's sections in order, Pinned first; [recencyBucket] indexes into them. */
internal val recencyTitles = listOf("Pinned", "Today", "Yesterday", "2–7 days ago", "8–30 days ago", "Older")

/** 1 Today · 2 Yesterday · 3 2–7 days ago · 4 8–30 days ago · 5 Older, for any instant — so a row that is not a session (a merge on a
 * project's timeline) lands in the section its time says. A future instant reads as Today; none at all falls to Older. */
internal fun recencyBucket(at: Instant?, today: java.time.LocalDate, zone: ZoneId): Int {
    val days = at?.atZone(zone)?.toLocalDate()?.let { ChronoUnit.DAYS.between(it, today) }
    return when {
        days == null -> 5
        days <= 0 -> 1
        days == 1L -> 2
        days <= 7 -> 3
        days <= 30 -> 4
        else -> 5
    }
}

/** A missing folder never hides a session. Trash is flat. A folder page contains its own rows once. */
fun visibleSessions(sessions: List<DirectorySession>, folders: List<Folder>, workspace: String,
    folder: String?, view: SessionView, tag: String?, byTag: Boolean = false): List<DirectorySession> = sessions.filter { s ->
    ObjectId.same(s.workspace, workspace) && (tag == null || s.tags.any { ObjectId.same(it.id, tag) }) &&
        (if (folder != null) ObjectId.same(s.folderId, folder)
        else view == SessionView.TRASH || byTag || tag != null || s.folderId == null || folders.none { ObjectId.same(it.id, s.folderId) && ObjectId.same(it.workspaceId, workspace) })
}
