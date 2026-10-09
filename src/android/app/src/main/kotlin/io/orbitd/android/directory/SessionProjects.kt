package io.orbitd.android.directory

import androidx.compose.runtime.*
import io.orbitd.android.core.cards.*
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.projects.ProjectAttention
import io.orbitd.android.projects.ProjectPage
import io.orbitd.android.projects.ProjectTime
import io.orbitd.android.watch.WatchSessionSummary
import io.orbitd.android.watch.watchKey
import java.text.Collator
import java.time.Instant
import java.util.Locale
import kotlin.math.max
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

// A05-6: one row per project in a workspace's session list, in place of its member sessions — OrbitKit's SessionProjectGrouping,
// SessionProjectCopy and SessionProjectMembers (the web's sessionProjects.ts), over the directory's sessions and
// `GET /projects/sidebar`. SessionProjectsTest holds them to the Swift cases, SessionProjectCopyParityTest to the Swift words.

/** A project's progress as `GET /projects/sidebar` stores it, CANCELLED left out of the total (`ProjectSidebarTaskCounts`). */
data class ProjectTaskCounts(val done: Int, val failed: Int, val total: Int)

/** One project in place of its member sessions (OrbitKit `SessionProjectRow`), at its coordinator's place and in its words. Its
 * activity, folder and indicator are this workspace's and this view's; sessions elsewhere only supply what its line says. */
data class SessionProjectRow(
    val projectId: String, val title: String, val status: String, val members: List<DirectorySession>, val sessionCount: Int,
    val coordinator: DirectorySession?, val folderId: String?, val pinnedAt: String?, val lastTurnAt: String?, val createdAt: String?,
    val needsYou: Boolean, val running: Boolean, val jobs: Boolean, val indicator: Indicator?, val line: SessionLine, val target: Target,
    val taskCounts: ProjectTaskCounts?, val runningCount: Int,
) {
    enum class Indicator { NEEDS_YOU, RUNNING, JOBS }
    /** What the line speaks for, which Open Session opens: a session, or — with none — the project. */
    sealed interface Target {
        data class Session(val id: String) : Target
        data class Project(val id: String) : Target
    }
}

/** A row of the list: an ordinary session, or a project in place of its members. */
sealed interface SessionProjectEntry {
    val id: String
    val pinnedAt: String?
    val lastTurnAt: String?
    val createdAt: String?
    data class Session(val session: DirectorySession) : SessionProjectEntry {
        override val id get() = session.id
        override val pinnedAt get() = session.pinnedAt
        override val lastTurnAt get() = session.lastTurnAt
        override val createdAt get() = session.createdAt
    }
    data class Project(val row: SessionProjectRow) : SessionProjectEntry {
        override val id get() = row.projectId
        override val pinnedAt get() = row.pinnedAt
        override val lastTurnAt get() = row.lastTurnAt
        override val createdAt get() = row.createdAt
    }
    /** The entry as the time sections file it (`timeGroupingSession`): a project under its own id, at its coordinator's pin and its
     * members' latest activity. */
    val groupingSession: DirectorySession get() = when (this) {
        is Session -> session
        is Project -> DirectorySession(id, row.title, pinnedAt = pinnedAt, lastTurnAt = lastTurnAt, createdAt = createdAt)
    }
}

/** [assigned]: the sessions as their folders count them — a member in its coordinator's folder, wherever it is filed itself. */
data class SessionProjectListing(val assigned: List<DirectorySession>, val projects: List<SessionProjectRow>,
    val sessions: List<DirectorySession>, val entries: List<SessionProjectEntry>)

/** OrbitKit `SessionProjectGrouping`, a port of the web's `sessionProjects.ts` (design §4, §6, §7), after folder grouping. */
object SessionProjectGrouping {
    /** Open and Completed group; Trash, a tag (narrowed to or grouped by) and a search stay flat. */
    fun listShowsProjects(view: SessionView, byTag: Boolean, searching: Boolean = false) = view != SessionView.TRASH && !byTag && !searching

    /**
     * [sessions]: this workspace's for [view]; [folders]: its folders. [coordinators] and [contentSessions] are every workspace's: a
     * coordinator elsewhere still places and words the row, and a member elsewhere still supplies its line. [folderId] lists a
     * folder's page. [line] is the session line, by default [SessionLine.make] with the watch a session is parked on.
     */
    internal fun listing(sessions: List<DirectorySession>, folders: List<Folder>, projects: List<JsonObject>, view: SessionView,
        byTag: Boolean, searching: Boolean = false, folderId: String? = null, runnerOffline: Boolean = false, now: Instant = Instant.now(),
        coordinators: List<DirectorySession> = emptyList(), contentSessions: List<DirectorySession>? = null,
        watching: Map<String, WatchSessionSummary> = emptyMap(), line: ((DirectorySession) -> SessionLine)? = null): SessionProjectListing {
        if (!listShowsProjects(view, byTag, searching)) return SessionProjectListing(sessions, emptyList(), sessions, sessions.map { SessionProjectEntry.Session(it) })
        fun watch(session: DirectorySession) = watching[watchKey(session.id)]
        val sessionLine = line ?: { session -> SessionLine.make(session, live = true, watching = watch(session), now = now) }
        val coordinatorByProject = mutableMapOf<String, DirectorySession>()
        for (session in coordinators + sessions) session.projectMembership?.takeIf { it.isCoordinator }?.let { coordinatorByProject[key(it.projectId)] = session }
        val groups = linkedMapOf<String, MutableList<DirectorySession>>()
        for (session in sessions) session.projectMembership?.let { groups.getOrPut(key(it.projectId)) { mutableListOf() } += session }
        // Folder rows count every local member under its coordinator's folder, whatever folder the member itself is in.
        val assigned = sessions.map { session -> session.projectMembership?.let { session.copy(folderId = coordinatorByProject[key(it.projectId)]?.folderId) } ?: session }
        fun inScope(id: String?): Boolean = if (folderId != null) ObjectId.same(id, folderId) else id == null || folders.none { ObjectId.same(it.id, id) }
        val loose = sessions.filter { it.projectMembership == null && inScope(it.folderId) }
        if (groups.isEmpty()) return SessionProjectListing(assigned, emptyList(), loose, loose.map { SessionProjectEntry.Session(it) })
        // Each project's share of the content list, split once.
        val contentByProject = contentSessions?.filter { it.projectMembership != null }?.groupBy { key(it.projectMembership!!.projectId) }
        val rows = mutableListOf<SessionProjectRow>()
        for ((project, members) in groups) {
            val coordinator = coordinatorByProject[project]
            val rowFolder = coordinator?.folderId
            if (!inScope(rowFolder)) continue
            val summary = projects.firstOrNull { it.text("id")?.let(::key) == project }
            val membership = members[0].projectMembership!!
            // A later copy of a session replaces an earlier one in its place: this workspace's rows over the content list's.
            val content = if (contentByProject == null) members else LinkedHashMap<String, DirectorySession>().apply {
                (contentByProject[project].orEmpty() + members).forEach { put(it.id, it) }
            }.values.toList()
            val lines = content.associate { it.id to sessionLine(it) }
            val coordinatorLine = coordinator?.let { lines[it.id] ?: sessionLine(it) }
            val waiting = content.filter { lines[it.id]?.tone == SessionLine.Tone.APPROVAL }.sortedWith { a, b ->
                val left = waitingInstant(a); val right = waitingInstant(b)
                when {
                    left != right -> if (!left.isFinite()) 1 else if (!right.isFinite()) -1 else left.compareTo(right)
                    // The web's `localeCompare`, which puts "a" before "Z".
                    else -> collator.compare(a.id, b.id)
                }
            }
            val landing = SessionProjectCopy.landingLine(summary?.obj("integration"), now)
            val held = summary?.obj("attention")?.obj("coordinatorItems")
            val (selected, target) = when {
                coordinator != null && coordinatorLine?.tone == SessionLine.Tone.APPROVAL -> coordinatorLine to SessionProjectRow.Target.Session(coordinator.id)
                waiting.isNotEmpty() -> waiting.first().let { lead ->
                    SessionLine(SessionProjectCopy.waitingSession(lines.getValue(lead.id).text, lead.title.orEmpty()), SessionLine.Tone.APPROVAL) to
                        SessionProjectRow.Target.Session(lead.id)
                }
                coordinator != null && held != null -> SessionLine(listOfNotNull(SessionProjectCopy.coordinatorLead(held.text("leadKind")),
                    ProjectAttention.elapsedLabel(held.text("oldestWaitingSince"), now)).joinToString(" · "), SessionLine.Tone.RUNNING) to
                    SessionProjectRow.Target.Session(coordinator.id)
                coordinator != null && coordinatorLine != null && !runnerOffline && coordinator.isRunning() -> coordinatorLine to SessionProjectRow.Target.Session(coordinator.id)
                landing != null -> landing to (coordinator?.let { SessionProjectRow.Target.Session(it.id) } ?: SessionProjectRow.Target.Project(membership.projectId))
                coordinator != null && coordinatorLine != null -> coordinatorLine to SessionProjectRow.Target.Session(coordinator.id)
                else -> SessionLine(SessionProjectCopy.noCoordinator, SessionLine.Tone.PREVIEW) to SessionProjectRow.Target.Project(membership.projectId)
            }
            val latest = members.drop(1).fold(members[0]) { newest, session -> if (instant(session.lastTurnAt ?: session.createdAt) > instant(newest.lastTurnAt ?: newest.createdAt)) session else newest }
            // Unlike the counted badges, the row shows a start request as amber too.
            val needsYou = members.any { lines[it.id]?.tone == SessionLine.Tone.APPROVAL }
            val runningCount = if (runnerOffline) 0 else members.count { it.isRunning() }
            val jobs = !runnerOffline && members.any { it.isRunningJob(watch(it)) }
            val counts = summary?.obj("taskCounts")?.let { ProjectTaskCounts(it.number("done") ?: 0, it.number("failed") ?: 0, it.number("total") ?: 0) }
            rows += SessionProjectRow(membership.projectId, summary?.text("title") ?: membership.projectTitle, summary?.text("status") ?: membership.projectStatus,
                members, content.size, coordinator, rowFolder, coordinator?.pinnedAt, latest.lastTurnAt ?: latest.createdAt, coordinator?.createdAt ?: latest.createdAt,
                needsYou, runningCount > 0, jobs, when { needsYou -> SessionProjectRow.Indicator.NEEDS_YOU; runningCount > 0 -> SessionProjectRow.Indicator.RUNNING
                    jobs -> SessionProjectRow.Indicator.JOBS; else -> null }, selected, target, counts,
                if (summary != null) summary.obj("buckets")?.number("running") ?: 0 else runningCount)
        }
        val entries = (loose.map { SessionProjectEntry.Session(it) } + rows.map { SessionProjectEntry.Project(it) })
            .map { it to instant(it.lastTurnAt ?: it.createdAt) }
            .sortedWith { a, b ->
                if (view == SessionView.OPEN && (a.first.pinnedAt != null) != (b.first.pinnedAt != null)) (if (a.first.pinnedAt != null) -1 else 1)
                else b.second.compareTo(a.second)
            }.map { it.first }
        return SessionProjectListing(assigned, rows, loose, entries)
    }

    /** Either spelling of an id is one key. */
    internal fun key(id: String) = ObjectId.canonical(id) ?: id
    private val collator: Collator = Collator.getInstance(Locale.ROOT)
    private fun instant(iso: String?): Double = ProjectTime.parse(iso)?.let { it.toEpochMilli() / 1000.0 } ?: Double.NEGATIVE_INFINITY
    /** How long a member has waited on you: its oldest owner item's `since`, else its latest activity. */
    private fun waitingInstant(session: DirectorySession): Double {
        val times = io.orbitd.android.cards.NeedsYouLogic.ownerItems(session.ownerItems.orEmpty().filterIsInstance<JsonObject>())
            .map { instant(it.since) }.filter { it.isFinite() }
        return times.minOrNull() ?: instant(session.lastTurnAt ?: session.createdAt)
    }
}

/** Project rows and pages say the web's `SESSION_PROJECT_COPY` words, through OrbitKit's `SessionProjectCopy`
 * (docs/session-list-projects-design.md §6). */
object SessionProjectCopy {
    fun progress(done: Int, total: Int) = "$done/$total"
    fun waitingSession(text: String, title: String) = "$text · $title"
    const val noCoordinator = "No coordinator"
    const val openSession = "Open Session"
    const val sessions = "Sessions"
    const val openProject = "Open Project"
    const val pin = "Pin"
    const val unpin = "Unpin"
    const val move = "Move…"

    fun pageSubtitle(sessions: Int) = "Project · $sessions sessions"
    /** Before the members have been read: no count it cannot vouch for yet. */
    const val pageSubtitleLoading = "Project"
    const val coordinatorSection = "Coordinator"
    fun pageProgress(done: Int, total: Int, running: Int) = "$done/$total done · $running running"
    /** A project nobody has started says so, rather than reading like one that runs nothing. */
    fun pageNotStarted(tasks: Int) = "Not started · $tasks ${if (tasks == 1) "task" else "tasks"}"
    /** The start row when the coordinator has asked: since when, what it suggests, and the press that opens the start card. */
    fun startAsked(ago: String) = "asked $ago"
    fun startSuggestion(settings: JsonObject) = "${if (settings.text("line") == "MAIN") "Directly into main" else "Project branch"} · " +
        "Automatic ${if (settings.flag("automatic")) "on" else "off"} · ${settings.number("maxConcurrentTasks") ?: 1} at a time"
    const val startReview = "Review and start"
    /** …and when nobody has, beside the owner's own Start…. */
    const val startNotAsked = "The coordinator hasn’t asked yet"
    /** What either press opens, for a reader who cannot see the card it will put up. */
    const val startHint = "Opens the start card: the criteria, the plan and how it runs."

    /** A runner that stopped reporting, in the row's own scale: "no report for 11m", or "no report yet". */
    fun landingSilentWord(minutes: Int?) = minutes?.let { "no report for ${it}m" } ?: "no report yet"

    /** The project page's landing line, shortened for a row: "Merge to main · queued · 13m", "Landing · checking · 4m · <task>";
     * null when nothing is in flight, and "Landing · N jobs" from a server that sends only the count. A silent runner is said in
     * the state slot, never as a timeout: that is the job's own verdict, the server's to give. */
    fun landingLine(integration: JsonObject?, now: Instant): SessionLine? {
        val count = integration?.number("activeJobCount") ?: 0
        val job = integration?.obj("inFlight")
            ?: return if (count > 0) SessionLine("Landing · $count ${if (count == 1) "job" else "jobs"}", SessionLine.Tone.QUEUED) else null
        val running = job.text("state") == "RUNNING"
        val heartbeat = ProjectTime.parse(job.text("heartbeatAt"))
        val silent = running && (heartbeat?.let { ProjectTime.between(it, now) > 600 } ?: true)
        val word = ProjectPage.integrationJobWords[job.text("kind").orEmpty()] ?: "Integration"
        val state = if (!running) "queued" else if (silent) landingSilentWord(heartbeat?.let { (max(0.0, ProjectTime.between(it, now)) / 60).toInt() })
            else ProjectPage.integrationPhaseWords[job.text("phase").orEmpty()] ?: "running"
        val text = listOfNotNull(if (count > 1) "$word $count jobs" else word, state, ProjectAttention.elapsedLabel(job.text("startedAt"), now),
            if (count > 1) null else job.text("taskTitle")).filter { it.isNotEmpty() }.joinToString(" · ")
        return SessionLine(text, if (running && !silent) SessionLine.Tone.RUNNING else SessionLine.Tone.QUEUED)
    }

    /** The project page's coordinator chip without its prefix, capitalised for the row; null for a kind this build does not know. */
    fun coordinatorLead(kind: String?): String? = when (kind) {
        "INTEGRATION_CONFLICT" -> "Resolving a merge conflict"
        "INTEGRATION_CHECK_FAILED" -> "Checks failed"
        "INTEGRATION_ERROR" -> "Handling an integration error"
        "TASK_FAILED" -> "Handling a failed task"
        "DELIVERY_REVIEW" -> "Reviewing a delivery"
        else -> null
    }

    /** What a project row's state says to a reader who cannot see its dot, spinner or breathing mark. */
    fun statusWords(row: SessionProjectRow) = when (row.indicator) {
        SessionProjectRow.Indicator.NEEDS_YOU -> "Waiting for you"
        SessionProjectRow.Indicator.RUNNING -> "Session running"
        SessionProjectRow.Indicator.JOBS -> "Background job running"
        null -> statusLabel(row.status)
    }
    /** `ProjectStatus.label`: a status this build does not know reads Unknown. */
    fun statusLabel(status: String) = when (status) { "OPEN" -> "Open"; "DONE" -> "Done"; "CANCELLED" -> "Cancelled"; else -> "Unknown" }
}

/** A project sessions page's members (OrbitKit `SessionProjectMembers`, design §5). */
object SessionProjectMembers {
    /** How long a poll leaves the Completed members as last read while nothing says they moved (the web's `PROJECT_SESSION_REFRESH_MS`). */
    const val completedRefreshMs = 60_000L

    /** [projectId]'s members out of [sessions], in either spelling of the id, never Trash. The first copy of a session wins, so the
     * freshest list goes first; newest activity first. */
    fun members(projectId: String, sessions: List<DirectorySession>): List<DirectorySession> {
        val key = SessionProjectGrouping.key(projectId)
        val seen = mutableSetOf<String>()
        return sessions.filter { session ->
            val membership = session.projectMembership ?: return@filter false
            session.effectiveLifecycleState != "TRASH" && SessionProjectGrouping.key(membership.projectId) == key && seen.add(session.id)
        }.sortedByDescending { it.lastTurnAt ?: it.createdAt ?: "" }
    }

    /** One poll of the page without asking for either list again: the Open members are the app's Open list's, the Completed ones
     * [completed] as last read. A member [shown] as Open that the Open list no longer has has moved — completed, trashed or taken out
     * of the project — and only a read of the Completed list can say which: it stays as shown, and `moved` asks for that read. */
    fun poll(shown: List<DirectorySession>, projectId: String, openList: List<DirectorySession>, completed: List<DirectorySession>):
        Pair<List<DirectorySession>, Boolean> {
        val open = members(projectId, openList)
        val openIds = open.map { it.id }.toSet()
        val moved = shown.filter { it.effectiveLifecycleState == "OPEN" && it.id !in openIds }
        return members(projectId, open + completed + moved) to moved.isNotEmpty()
    }
}

/** The project rows' `GET /projects/sidebar` (OrbitKit `ProjectsModel.sidebarProjects`): read when a list that draws them appears,
 * every 15 s while it shows and after every control event ([revision]). A read that fails keeps the last answer; a server without
 * the read leaves it empty, and the rows say what the sessions' memberships say. */
@Composable
internal fun rememberProjectSidebar(api: DirectoryApi, revision: Long): State<List<JsonObject>> {
    val rows = remember(api) { mutableStateOf<List<JsonObject>>(emptyList()) }
    LaunchedEffect(api, revision) {
        while (true) {
            try { rows.value = api.read(listOf("projects", "sidebar"), JsonArray.serializer()).filterIsInstance<JsonObject>() }
            catch (cancel: CancellationException) { throw cancel }
            catch (_: Exception) { }
            delay(15_000)
        }
    }
    return rows
}
