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
    val enabled: Boolean = true, val position: Int? = null, val createdAt: String? = null, val repoUrl: String? = null,
    /** `PULL_REQUEST` or `PUSH_AS_ME`; null with none chosen and from a server that does not send it. */
    val landingMode: String? = null)
@Serializable
data class DirectoryRunner(val id: String, val name: String, val status: String? = null, val online: Boolean? = null,
    val displayName: String? = null, val lastHeartbeatAt: String? = null,
    /** True on the account's managed runner (Orbit Cloud); null from an older server (RunnerPage.isManaged). */
    val managed: Boolean? = null,
    /** The runner's Max Concurrent and the sessions it runs now; null from an older server. */
    val maxConcurrent: Int? = null, val activeSessions: Int? = null)
@Serializable
data class Folder(val id: String, val workspaceId: String, val name: String)
@Serializable
data class Tag(val id: String, val name: String, val color: String? = null,
    val isSystem: Boolean = false, val position: Int = 0)
@Serializable
data class WorkspaceRef(val id: String, val name: String = "")
@Serializable
data class DirectorySession(
    val id: String, val title: String? = null, val status: String = "UNKNOWN",
    val runState: String? = null, val lifecycleState: String? = null,
    /** The session facts (contracts/session-state.contract.json), as words so a new one decodes; null from an older server. */
    val phase: String? = null, val released: Boolean? = null, val lastTurnOutcome: String? = null, val waitingOn: String? = null,
    val workFinished: Boolean? = null,
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
    /** Who sent [lastUserText] when somebody other than the owner did — a connected Feishu group's member (docs/feishu-bot-design.md
     *  §8.2) or a guest the owner invited (docs/session-guests-design.md §3): the row says `From Feishu · <name>` or `From <name>` instead
     *  of "You" ([SessionLine.externalLine], read by [ExternalSender.parse]). Null for anybody
     *  else, and from an older server. Kept as the JSON it came as, so a source this build does not know is no sender. */
    val lastUserFromExternal: JsonElement? = null,
    /** The session's permission mode (`default`, `auto`, `bypassPermissions`…), which Share's People who can reply says a guest's
     *  message runs in. Null from an older server. */
    val permissionMode: String? = null,
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
    /** What the newest running sub-agent is doing, as its launch call described it; null when none is or it said nothing. */
    val runningSubagentTitle: String? = null,
    /** What a parked session is still doing (`TURN`, `BACKGROUND_JOB`, `WAITING`), as the server decides it; null when none and
     *  from an older server. See [resumesOnItsOwn]. */
    val activity: String? = null,
    val waitingKind: String? = null, val ownerItems: JsonArray? = null,
    /** `OWNER_REQUEST`'s and `MOVE_REQUEST`'s lists (`@orbit/shared` `SessionOwnerRequest`, `SessionTaskMoveGroup`): the open
     *  requests this session asked, and the waiting task-move groups it draws — what the row's word names ([SessionHeader.waitingWord]).
     *  Kept as the JSON they came as; absent from an older server. */
    val ownerRequests: JsonArray? = null, val taskMoves: JsonArray? = null,
    /** The project this session belongs to in any role; null for an ordinary conversation and from an older server. */
    val projectMembership: SessionProjectMembership? = null,
    /** `LANDING` for platform work with no engine (contract §2.9 LS6), `CONVERSATION` otherwise; absent from an older server. */
    val sessionKind: String? = null,
    /** What a LANDING row says about its subject, on `GET /sessions?projectId=&includeLanding=1` only; absent everywhere else. */
    val landing: SessionLandingSummary? = null,
    /** Which gate the server found holding a queued row (web `QueuedGate`): `runner_updating` is the one this build words for itself
     *  ([RunnerUpdating]). [queuedActive] is the turns in flight that gate judged on. All absent from an older server. */
    val queuedReason: String? = null, val queuedActive: Int? = null, val queuedLimit: Int? = null,
    /** Of [queuedActive], the slots background jobs hold; beside `runner_at_capacity` only ([QueuedCapacity]). */
    val queuedHeldByJobs: Int? = null,
    /** Beside queuedReason `runner_updating` only, kept as the JSON it came as and read by [QueuedRunnerUpdate.of]. */
    val queuedRunnerUpdate: JsonElement? = null,
    /** Beside a capacity gate: whether Run now can start this queued message over the limit, and the server's sentence where it
     *  cannot. False and null on any other row, and from an older server. */
    val runNowAvailable: Boolean? = null, val runNowRefusal: String? = null,
    /** On a turn started over its runner's limit, while it runs: `{active, limit, runnerName}`, kept as the JSON it came as and
     *  read by [RunningOverLimit.of]. */
    val runningOverLimit: JsonElement? = null,
    val runSource: String? = null,
    /** When the session last changed for its owner: what every list view but Completed orders by, and the time its row shows
     *  (contracts/session-list-order.fixtures.json). Unlike [lastTurnAt] it does not move with streamed text or background output.
     *  Null from an older server: the row reads as [createdAt]. */
    val listedAt: String? = null,
) {
    /** Whether this row is a landing session (platform work), not a conversation. */
    val isLanding get() = sessionKind == "LANDING"
    val isScheduledRun get() = runSource == "SCHEDULE"
    /** A schedule's change conversation (§8.2): not a run, and kept out of the same lists a run is. */
    val isScheduleChange get() = runSource == "SCHEDULE_CHANGE"
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
    val agent: WorkspaceRef? = null, val snippet: String? = null, val matchField: String = "message",
    /** The session facts and the Background mark's inputs, as [DirectorySession] reads them; all null from an older server. */
    val phase: String? = null, val released: Boolean? = null, val lastTurnOutcome: String? = null, val waitingOn: String? = null,
    val endReason: String? = null, val workFinished: Boolean? = null, val activity: String? = null, val runningBgCount: Int? = null)
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

internal fun listShowsFolders(isFolder: Boolean, view: SessionView, tag: String?, grouping: Grouping) =
    !isFolder && view != SessionView.TRASH && tag == null && grouping != Grouping.TAG

internal fun List<DirectorySession>.withoutScheduledRuns() = filterNot { it.isScheduledRun || it.isScheduleChange }

internal data class FolderRowSummary(val count: Int, val needsYou: Int, val running: Boolean, val jobs: Boolean = false)

internal fun List<DirectorySession>.folderNeedsYouCount() = count { it.pendingApprovals > 0 && it.waitingKind != "START_REQUEST" }

internal object ScheduledRunsFolder {
    const val ID = "scheduled"
    const val POLL_INTERVAL_MS = 30_000L

    fun sessions(rows: List<DirectorySession>, workspace: String) =
        rows.filter { it.isScheduledRun && ObjectId.same(it.workspace, workspace) }

    fun row(sessions: List<DirectorySession>, showFolders: Boolean): FolderRowSummary? =
        if (showFolders && sessions.isNotEmpty())
            FolderRowSummary(sessions.size, sessions.folderNeedsYouCount(), sessions.any { it.status == "RUNNING" })
        else null
}

/** Where the list places a row: its `listedAt`, or `createdAt` from an older server. */
internal fun DirectorySession.listedInstant(): Instant? = runCatching { Instant.parse(listedAt ?: createdAt) }.getOrNull()

/** Open's first three sections, ahead of the day sections (contracts/session-list-order.fixtures.json). */
internal const val NEEDS_YOU_GROUP = "section:needs-you"
internal const val WORKING_GROUP = "section:working"

/** Pending approvals, or a failure the server is not retrying. */
internal fun DirectorySession.needsOwner() = pendingApprovals > 0 || (failedForList() && retryAt == null)

/** With the session facts, the state word's own reading ([displayRunState]); from an older server, the legacy status. */
private fun DirectorySession.failedForList() = if (phase != null && released != null) displayRunState == RunState.FAILED else status == "FAILED"


/** At work: the phase where the row carries one (RUNNING covers a background job or a SubAgent running between turns), otherwise the
 * legacy status; or a failure the server is retrying (web `sessionIsWorking`). */
internal fun DirectorySession.isWorkingForList() = when (phase) {
    "RUNNING", "PENDING" -> true
    "IDLE" -> false
    else -> status == "RUNNING" || status == "PENDING"
} || (status == "FAILED" && retryAt != null)

/** [tagFiltered]: the list is narrowed to one tag, so Open draws no Pinned section. */
fun directoryGroups(sessions: List<DirectorySession>, view: SessionView, grouping: Grouping,
    now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault(), tagFiltered: Boolean = false): List<SessionGroup> {
    val open = view == SessionView.OPEN
    // A pin counts only in Open with no tag filter: it draws the Pinned section, and under Group by tag it leads its tag's section, as
    // web and Apple keep it.
    val pins = open && !tagFiltered
    // Every view buckets by listedAt, which only moves when the session changes for its owner; all but Completed, which keeps the
    // server's order, are ordered by it too.
    fun date(s: DirectorySession) = s.listedInstant()
    fun created(s: DirectorySession) = runCatching { Instant.parse(s.createdAt) }.getOrNull() ?: Instant.MIN
    val sorted = if (view == SessionView.COMPLETED) sessions else sessions.sortedWith(compareByDescending<DirectorySession> { pins && it.pinnedAt != null }
        .thenByDescending { date(it) ?: Instant.MIN }.thenByDescending { created(it) }.thenBy { it.id })
    if (grouping == Grouping.TAG) {
        val tags = sorted.mapNotNull { it.tags.firstOrNull() }.distinctBy { it.id }
            .sortedWith(compareByDescending<Tag> { it.isSystem }.thenBy { it.position }.thenBy { it.name })
        return tags.map { tag -> SessionGroup("tag:${ObjectId.canonical(tag.id) ?: tag.id}", tag.name, sorted.filter { it.tags.firstOrNull()?.id == tag.id }) } +
            listOfNotNull(sorted.filter { it.tags.isEmpty() }.takeIf { it.isNotEmpty() }?.let { SessionGroup("bucket:untagged", "Untagged", it) })
    }
    val today = now.atZone(zone).toLocalDate()
    // 0 Pinned, then (Open only) Needs you and Working, then the day sections by [recencyBucket].
    fun bucket(s: DirectorySession) = when {
        pins && grouping == Grouping.RECENCY && s.pinnedAt != null -> 0
        open && s.needsOwner() -> NEEDS_YOU_BUCKET
        open && s.isWorkingForList() -> WORKING_BUCKET
        else -> recencyBucket(date(s), today, zone)
    }
    val buckets = sorted.groupBy(::bucket)
    return listOfNotNull(buckets[0]?.let { SessionGroup("time:0", recencyTitles[0], it) },
        buckets[NEEDS_YOU_BUCKET]?.let { SessionGroup(NEEDS_YOU_GROUP, "Needs you", it) },
        buckets[WORKING_BUCKET]?.let { SessionGroup(WORKING_GROUP, "Working", it) }) +
        (1 until recencyTitles.size).mapNotNull { i -> buckets[i]?.let { SessionGroup("time:$i", recencyTitles[i], it) } }
}

private const val NEEDS_YOU_BUCKET = -1
private const val WORKING_BUCKET = -2

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
